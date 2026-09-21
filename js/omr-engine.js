/**
 * OMREngine - Optical Mark Recognition Computer Vision Engine
 * ตรวจจับจุดมาร์ค 4 มุม, ปรับองศาภาพ (Perspective Warp) และวิเคราะห์วงกลมคำตอบ
 */
class OMREngine {
  constructor() {
    this.warpedWidth = 800;
    this.warpedHeight = 1100;
    this.isCvReady = false;
    this.initOpenCV();
  }

  initOpenCV() {
    if (window.cv && window.cv.Mat) {
      this.isCvReady = true;
      console.log('OpenCV.js is loaded and ready');
    } else {
      window.addEventListener('opencv-ready', () => {
        this.isCvReady = true;
        console.log('OpenCV.js loaded via event');
      });
    }
  }

  /**
   * ประมวลผลเฟรมภาพหรือรูปภาพ
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} sourceElement
   * @param {object} examKey - ชุดเฉลย { totalQuestions, answers: { 1: 0, 2: 1, ... } }
   * @param {object} layoutMeta - ข้อมูลตำแหน่งพิกัดของกระดาษคำตอบจาก SheetGenerator
   * @returns {object} ผลการตรวจ { success, score, total, percentage, answers, corners, warpedCanvas }
   */
  processFrame(sourceElement, examKey, layoutMeta) {
    if (!sourceElement || !examKey || !layoutMeta) {
      return { success: false, error: 'ข้อมูลไม่ครบถ้วน' };
    }

    // สร้าง canvas ชั่วคราวสำหรับดึง pixel data จาก source
    const srcCanvas = document.createElement('canvas');
    const sw = sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width;
    const sh = sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height;

    if (!sw || !sh) {
      return { success: false, error: 'ไม่พบขนาดของภาพ' };
    }

    srcCanvas.width = sw;
    srcCanvas.height = sh;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(sourceElement, 0, 0, sw, sh);

    // 1. ตรวจหาจุดมาร์ค 4 มุม (TL, TR, BR, BL)
    const corners = this.detectCorners(srcCanvas);
    if (!corners || corners.length !== 4) {
      return {
        success: false,
        error: 'ยังไม่พบจุดมาร์คทั้ง 4 มุม กรุณาส่องให้เห็นจุดมาร์คสี่เหลี่ยมดำ 4 มุมครบถ้วน',
        foundCornersCount: corners ? corners.length : 0
      };
    }

    // 2. ปรับมุมมองภาพ (Perspective Warp) ให้ระนาบตรง
    const warpedCanvas = this.warpPerspective(srcCanvas, corners);
    if (!warpedCanvas) {
      return { success: false, error: 'ไม่สามารถปรับระนาบภาพได้' };
    }

    // 3. วิเคราะห์ความเข้มของวงกลมแต่ละข้อ (Bubble Density Analysis)
    const gradingResult = this.readBubblesAndGrade(warpedCanvas, examKey, layoutMeta);

    return {
      success: true,
      corners,
      warpedCanvas,
      ...gradingResult
    };
  }

  /**
   * ค้นหาจุดศูนย์กลางของจุดมาร์ค 4 มุม (Marker Centers)
   * @param {HTMLCanvasElement} canvas
   * @returns {Array<{x, y}>|null} [TL, TR, BR, BL]
   */
  detectCorners(canvas) {
    if (this.isCvReady && window.cv) {
      return this.detectCornersWithOpenCV(canvas);
    }
    // Fallback: ตรวจสอบด้วย Pure JavaScript Adaptive Scan
    return this.detectCornersPureJS(canvas);
  }

  /**
   * ตรวจหาจุดมาร์คโดยใช้ OpenCV.js
   */
  detectCornersWithOpenCV(canvas) {
    try {
      const cv = window.cv;
      const src = cv.imread(canvas);
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      // เบลอเล็กน้อยเพื่อลดสัญญาณรบกวน
      const blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      // Adaptive Threshold ให้เป็นภาพขาวดำ
      const thresh = new cv.Mat();
      cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 12);

      // หา Contours
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

      const candidates = [];
      const imgArea = canvas.width * canvas.height;

      for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);

        // คัดกรองขนาดจุดมาร์ค: ต้องไม่เล็กหรือใหญ่เกินไป (~0.04% ถึง 5% ของพื้นที่ภาพ)
        if (area < imgArea * 0.0004 || area > imgArea * 0.08) {
          cnt.delete();
          continue;
        }

        const rect = cv.boundingRect(cnt);
        const aspectRatio = rect.width / rect.height;

        // จุดมาร์คต้องเป็นรูปสี่เหลี่ยมจัตุรัสค่อนข้างสมบูรณ์
        if (aspectRatio >= 0.75 && aspectRatio <= 1.33) {
          const moments = cv.moments(cnt);
          if (moments.m00 !== 0) {
            const cx = moments.m10 / moments.m00;
            const cy = moments.m01 / moments.m00;
            candidates.push({ x: cx, y: cy, area, rect });
          }
        }
        cnt.delete();
      }

      // Cleanup OpenCV matrices
      src.delete();
      gray.delete();
      blur.delete();
      thresh.delete();
      contours.delete();
      hierarchy.delete();

      if (candidates.length < 4) {
        return null;
      }

      // กรองและรวมกลุ่มจุดที่ใกล้กันเกินไป
      const merged = this.clusterNearbyPoints(candidates, canvas.width * 0.03);
      if (merged.length < 4) {
        return null;
      }

      // คัดเลือก 4 จุดที่ครอบคลุมพื้นที่กว้างที่สุด 4 มุม
      return this.selectFourOuterCorners(merged, canvas.width, canvas.height);
    } catch (err) {
      console.warn('OpenCV detection error, using fallback:', err);
      return this.detectCornersPureJS(canvas);
    }
  }

  /**
   * Fallback ตรวจจับจุดมาร์ค 4 มุมด้วย Pure JavaScript
   */
  detectCornersPureJS(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // คำนวณความสว่างเฉลี่ยเพื่อทำ threshold
    let sumBrightness = 0;
    const step = 8;
    let sampleCount = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const idx = (y * w + x) * 4;
        sumBrightness += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        sampleCount++;
      }
    }
    const avgBrightness = sumBrightness / sampleCount;
    const threshold = Math.max(50, avgBrightness * 0.65);

    // แบ่งค้นหาใน 4 จตุภาค (Quadrant)
    // TL: (0..w/2, 0..h/2), TR: (w/2..w, 0..h/2), BL: (0..w/2, h/2..h), BR: (w/2..w, h/2..h)
    const corners = [
      this.findCornerInQuadrant(data, w, h, 0, Math.floor(w * 0.45), 0, Math.floor(h * 0.45), threshold, 'TL'),
      this.findCornerInQuadrant(data, w, h, Math.floor(w * 0.55), w, 0, Math.floor(h * 0.45), threshold, 'TR'),
      this.findCornerInQuadrant(data, w, h, Math.floor(w * 0.55), w, Math.floor(h * 0.55), h, threshold, 'BR'),
      this.findCornerInQuadrant(data, w, h, 0, Math.floor(w * 0.45), Math.floor(h * 0.55), h, threshold, 'BL')
    ];

    if (corners.every(c => c !== null)) {
      return corners;
    }
    return null;
  }

  /**
   * ค้นหากลุ่มพิกเซลดำเข้มที่เป็นจุดมาร์คในแต่ละจตุภาค
   */
  findCornerInQuadrant(data, w, h, minX, maxX, minY, maxY, threshold, quad) {
    const scanStep = 4;
    let bestPoint = null;
    let minDistanceToCorner = Infinity;

    const cornerTarget = {
      TL: { x: minX, y: minY },
      TR: { x: maxX, y: minY },
      BR: { x: maxX, y: maxY },
      BL: { x: minX, y: maxY }
    }[quad];

    for (let y = minY + 10; y < maxY - 10; y += scanStep) {
      for (let x = minX + 10; x < maxX - 10; x += scanStep) {
        const idx = (y * w + x) * 4;
        const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;

        if (b < threshold) {
          // ตรวจสอบว่ารอบๆ เป็นกลุ่มก้อนดำหนาหรือไม่
          let darkNeighbors = 0;
          const radius = 8;
          for (let dy = -radius; dy <= radius; dy += 4) {
            for (let dx = -radius; dx <= radius; dx += 4) {
              const nIdx = ((y + dy) * w + (x + dx)) * 4;
              const nb = (data[nIdx] + data[nIdx + 1] + data[nIdx + 2]) / 3;
              if (nb < threshold * 1.1) darkNeighbors++;
            }
          }

          if (darkNeighbors >= 16) {
            const dist = Math.hypot(x - cornerTarget.x, y - cornerTarget.y);
            if (dist < minDistanceToCorner) {
              minDistanceToCorner = dist;
              bestPoint = { x, y };
            }
          }
        }
      }
    }

    return bestPoint;
  }

  /**
   * รวมจุดที่อยู่ชิดกัน
   */
  clusterNearbyPoints(points, maxDist) {
    const clusters = [];
    for (const p of points) {
      let matched = false;
      for (const c of clusters) {
        if (Math.hypot(p.x - c.x, p.y - c.y) < maxDist) {
          c.x = (c.x + p.x) / 2;
          c.y = (c.y + p.y) / 2;
          matched = true;
          break;
        }
      }
      if (!matched) {
        clusters.push({ x: p.x, y: p.y });
      }
    }
    return clusters;
  }

  /**
   * จัดเรียงจุดมาร์ค 4 มุม: [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
   */
  selectFourOuterCorners(points, imgW, imgH) {
    if (points.length < 4) return null;

    // หาจุดที่ใกล้ 4 มุมของภาพมากที่สุด
    const corners = {
      TL: null,
      TR: null,
      BR: null,
      BL: null
    };

    let minDistTL = Infinity;
    let minDistTR = Infinity;
    let minDistBR = Infinity;
    let minDistBL = Infinity;

    for (const p of points) {
      const dTL = Math.hypot(p.x, p.y);
      const dTR = Math.hypot(p.x - imgW, p.y);
      const dBR = Math.hypot(p.x - imgW, p.y - imgH);
      const dBL = Math.hypot(p.x, p.y - imgH);

      if (dTL < minDistTL) { minDistTL = dTL; corners.TL = p; }
      if (dTR < minDistTR) { minDistTR = dTR; corners.TR = p; }
      if (dBR < minDistBR) { minDistBR = dBR; corners.BR = p; }
      if (dBL < minDistBL) { minDistBL = dBL; corners.BL = p; }
    }

    // ตรวจสอบว่าทั้ง 4 จุดไม่ซ้ำกัน
    const unique = new Set([corners.TL, corners.TR, corners.BR, corners.BL]);
    if (unique.size === 4) {
      return [corners.TL, corners.TR, corners.BR, corners.BL];
    }

    // ทางเลือกสำรอง: ใช้ผลบวกและผลต่างของพิกัด
    // TL: x+y ต่ำสุด, BR: x+y สูงสุด, TR: x-y สูงสุด, BL: y-x สูงสุด
    let tl = points[0], tr = points[0], br = points[0], bl = points[0];
    let minSum = Infinity, maxSum = -Infinity, maxDiffTR = -Infinity, maxDiffBL = -Infinity;

    for (const p of points) {
      const sum = p.x + p.y;
      const diffTR = p.x - p.y;
      const diffBL = p.y - p.x;

      if (sum < minSum) { minSum = sum; tl = p; }
      if (sum > maxSum) { maxSum = sum; br = p; }
      if (diffTR > maxDiffTR) { maxDiffTR = diffTR; tr = p; }
      if (diffBL > maxDiffBL) { maxDiffBL = diffBL; bl = p; }
    }

    return [tl, tr, br, bl];
  }

  /**
   * ดึงภาพมุมมองระนาบตรง (Warp Perspective)
   * แปลงจาก 4 เหลี่ยมเบี้ยว (Quad) -> สี่เหลี่ยมขนาด 800x1100 px
   */
  warpPerspective(sourceCanvas, corners) {
    const [tl, tr, br, bl] = corners;
    const destW = this.warpedWidth;
    const destH = this.warpedHeight;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = destW;
    outCanvas.height = destH;
    const outCtx = outCanvas.getContext('2d');

    if (this.isCvReady && window.cv) {
      try {
        const cv = window.cv;
        const srcMat = cv.imread(sourceCanvas);
        const dstMat = new cv.Mat();

        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          tl.x, tl.y,
          tr.x, tr.y,
          br.x, br.y,
          bl.x, bl.y
        ]);

        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0,
          destW, 0,
          destW, destH,
          0, destH
        ]);

        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const dsize = new cv.Size(destW, destH);
        cv.warpPerspective(srcMat, dstMat, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

        cv.imshow(outCanvas, dstMat);

        srcMat.delete();
        dstMat.delete();
        srcTri.delete();
        dstTri.delete();
        M.delete();

        return outCanvas;
      } catch (err) {
        console.warn('OpenCV warp failed, using bilinear fallback:', err);
      }
    }

    // Bilinear Homography Fallback ใน Pure JS
    this.warpPerspectiveJS(sourceCanvas, corners, outCanvas);
    return outCanvas;
  }

  /**
   * Perspective Warp บริสุทธิ์ใน JavaScript
   */
  warpPerspectiveJS(sourceCanvas, [tl, tr, br, bl], outCanvas) {
    const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;
    const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

    const dstW = outCanvas.width;
    const dstH = outCanvas.height;
    const dstCtx = outCanvas.getContext('2d');
    const dstImg = dstCtx.createImageData(dstW, dstH);
    const dstData = dstImg.data;

    for (let y = 0; y < dstH; y++) {
      const v = y / dstH;
      for (let x = 0; x < dstW; x++) {
        const u = x / dstW;

        // Bilinear interpolation mapping
        const topX = tl.x + u * (tr.x - tl.x);
        const topY = tl.y + u * (tr.y - tl.y);
        const botX = bl.x + u * (br.x - bl.x);
        const botY = bl.y + u * (br.y - bl.y);

        const srcX = Math.round(topX + v * (botX - topX));
        const srcY = Math.round(topY + v * (botY - topY));

        if (srcX >= 0 && srcX < srcW && srcY >= 0 && srcY < srcH) {
          const srcIdx = (srcY * srcW + srcX) * 4;
          const dstIdx = (y * dstW + x) * 4;
          dstData[dstIdx] = srcData[srcIdx];
          dstData[dstIdx + 1] = srcData[srcIdx + 1];
          dstData[dstIdx + 2] = srcData[srcIdx + 2];
          dstData[dstIdx + 3] = 255;
        }
      }
    }

    dstCtx.putImageData(dstImg, 0, 0);
  }

  /**
   * อ่านวงกลมและตรวจคำตอบเทียบกับชุดเฉลย
   */
  readBubblesAndGrade(warpedCanvas, examKey, layoutMeta) {
    const ctx = warpedCanvas.getContext('2d', { willReadFrequently: true });
    const w = warpedCanvas.width;
    const h = warpedCanvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // หาค่าความสว่างเฉลี่ยของพื้นหลังกระดาษขาวเพื่อใช้อ้างอิง
    let bgSamples = 0;
    let bgBrightnessSum = 0;
    for (let i = 0; i < 200; i++) {
      const rx = Math.floor(w * 0.1 + Math.random() * w * 0.8);
      const ry = Math.floor(h * 0.1 + Math.random() * h * 0.8);
      const b = this.samplePixelBrightness(data, w, rx, ry);
      bgBrightnessSum += b;
      bgSamples++;
    }
    const bgBrightness = bgBrightnessSum / bgSamples;

    // ตรวจหาจำนวนข้อสอบอัตโนมัติจากสัญลักษณ์ระบุจำนวนข้อ (Count Indicators)
    let detectedQuestionCount = null;
    if (layoutMeta.countIndicators && layoutMeta.countIndicators.length > 0) {
      let highestFill = -1;
      for (const ind of layoutMeta.countIndicators) {
        const tx = Math.round(ind.normX * w);
        const ty = Math.round(ind.normY * h);
        const rad = Math.max(6, Math.round((ind.normRadius || 0.015) * w));
        const metric = this.calculateBubbleFill(data, w, h, tx, ty, rad, bgBrightness);
        if (metric.fillRatio > 0.40 && metric.fillRatio > highestFill) {
          highestFill = metric.fillRatio;
          detectedQuestionCount = ind.count;
        }
      }
    }

    const totalQuestions = detectedQuestionCount || parseInt(examKey.totalQuestions, 10) || layoutMeta.totalQuestions || 20;
    const bubbleLayout = layoutMeta.bubbleLayout;

    let score = 0;
    const questionResults = [];

    // ตรวจสอบแต่ละข้อสอบ
    for (let q = 1; q <= totalQuestions; q++) {
      const qMeta = bubbleLayout.find(item => item.questionNumber === q);
      if (!qMeta) continue;

      const choiceScores = [];


      for (let ch = 0; ch < 4; ch++) {
        const choiceInfo = qMeta.choices[ch];

        // พิกัดวงกลมบนภาพ Warped Canvas (ตาม normalized coordinates [0..1])
        const targetX = Math.round(choiceInfo.normX * w);
        const targetY = Math.round(choiceInfo.normY * h);
        const radius = Math.max(8, Math.round(choiceInfo.normRadius * w));

        // วิเคราะห์ความเข้มของการฝน (Darkness Fill Ratio)
        const fillMetric = this.calculateBubbleFill(data, w, h, targetX, targetY, radius, bgBrightness);

        choiceScores.push({
          choiceIndex: ch,
          label: choiceInfo.label,
          targetX,
          targetY,
          radius,
          fillRatio: fillMetric.fillRatio,
          avgDarkness: fillMetric.avgDarkness
        });
      }

      // เรียงลำดับตัวเลือกที่มีความเข้มมากที่สุด
      choiceScores.sort((a, b) => b.fillRatio - a.fillRatio);

      const topChoice = choiceScores[0];
      const secondChoice = choiceScores[1];

      // คำนวณค่าเฉลี่ยของตัวเลือกอื่นเพื่อใช้เป็น Baseline ของวงกลมที่ยังไม่ได้เขียน
      const baselineFill = (choiceScores[1].fillRatio + choiceScores[2].fillRatio + choiceScores[3].fillRatio) / 3;
      const topDelta = topChoice.fillRatio - baselineFill;

      // เกณฑ์การตัดสินอัจฉริยะ (ตรวจจับได้ทั้ง: กากบาท X, ขีดถูก ✓, ขีดเส้นทับ, และการฝนทึบ ●)
      // 1. ถ้านักเรียนฝนทึบ: fillRatio >= 0.25
      // 2. ถ้านักเรียนกากบาท (X) หรือขีดถูก (✓) หรือใช้ปากกาขีดทับ: มีความเข้มเด่นกว่าข้ออื่น (topDelta >= 0.05 และ fillRatio >= 0.08)
      let detectedChoice = null;
      let isMultiple = false;
      let isBlank = false;

      const isMarked = (topChoice.fillRatio >= 0.25) || (topDelta >= 0.05 && topChoice.fillRatio >= 0.08);

      if (isMarked) {
        // ตรวจสอบว่ามีการกาซ้ำเกิน 1 ข้อหรือไม่
        const secondDelta = secondChoice.fillRatio - ((choiceScores[2].fillRatio + choiceScores[3].fillRatio) / 2);
        const isSecondAlsoMarked = (secondChoice.fillRatio >= 0.22) || (secondDelta >= 0.045 && secondChoice.fillRatio >= 0.075 && secondChoice.fillRatio > topChoice.fillRatio * 0.70);

        if (isSecondAlsoMarked) {
          // กาซ้ำเกิน 1 ข้อ
          isMultiple = true;
          detectedChoice = -1;
        } else {
          detectedChoice = topChoice.choiceIndex;
        }
      } else {
        // ไม่ได้ทำเครื่องหมายในข้อนี้ (ว่าง)
        isBlank = true;
        detectedChoice = null;
      }

      // ตรวจเทียบกับเฉลย
      const correctChoiceIndex = examKey.answers && examKey.answers[q] !== undefined ? examKey.answers[q] : null;
      const isCorrect = (detectedChoice !== null && detectedChoice === correctChoiceIndex);

      if (isCorrect) {
        score++;
      }

      questionResults.push({
        questionNumber: q,
        detectedChoice,
        detectedLabel: detectedChoice !== null && detectedChoice >= 0 ? layoutMeta.labels[detectedChoice] : (isBlank ? '-' : 'ซ้ำ'),
        correctChoiceIndex,
        correctLabel: correctChoiceIndex !== null ? layoutMeta.labels[correctChoiceIndex] : '-',
        isCorrect,
        isBlank,
        isMultiple,
        choices: choiceScores.sort((a, b) => a.choiceIndex - b.choiceIndex)
      });
    }

    const percentage = totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0;

    return {
      score,
      total: totalQuestions,
      percentage,
      detectedQuestionCount,
      answers: questionResults
    };
  }

  /**
   * คำนวณความเข้มของการทำเครื่องหมายในพื้นที่วงกลม (ตรวจจับได้ทั้งฝน, กากบาท X, ขีดถูก ✓, ปากกา/ดินสอ)
   */
  calculateBubbleFill(data, w, h, cx, cy, radius, bgBrightness) {
    let darkPixels = 0;
    let totalPixels = 0;
    let sumBrightness = 0;

    // ตรวจสอบพิกเซลภายในวงกลม (ขอบใน 80% เพื่อไม่ให้ติดเส้นขอบวงกลม)
    const innerRadius = Math.round(radius * 0.80);

    for (let dy = -innerRadius; dy <= innerRadius; dy++) {
      for (let dx = -innerRadius; dx <= innerRadius; dx++) {
        if (dx * dx + dy * dy <= innerRadius * innerRadius) {
          const px = cx + dx;
          const py = cy + dy;

          if (px >= 0 && px < w && py >= 0 && py < h) {
            const b = this.samplePixelBrightness(data, w, px, py);
            sumBrightness += b;
            totalPixels++;

            // ถ้าค่าความสว่างมืดกว่าพื้นหลังกระดาษอย่างน้อย 26% (ครอบคลุมทั้งปากกาน้ำเงิน ปากกาดำ และดินสอ)
            if (b < bgBrightness * 0.74) {
              darkPixels++;
            }
          }
        }
      }
    }

    const fillRatio = totalPixels > 0 ? darkPixels / totalPixels : 0;
    const avgDarkness = totalPixels > 0 ? 255 - (sumBrightness / totalPixels) : 0;

    return { fillRatio, avgDarkness };
  }

  samplePixelBrightness(data, w, x, y) {
    const idx = (y * w + x) * 4;
    return (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
  }

  /**
   * ฟังก์ชันทดสอบจำลอง (Simulator): สร้างกระดาษคำตอบที่ฝนแล้วเพื่อทดสอบตรวจ OMR ทันทีในเครื่อง
   */
  generateSimulatedFilledSheet(layoutMeta, examKey, accuracyPercent = 85) {
    const generator = new SheetGenerator();
    const { canvas } = generator.generateSheet({
      totalQuestions: examKey.totalQuestions,
      choiceType: examKey.choiceType || 'thai',
      columns: layoutMeta.numCols || 'auto'
    });

    const ctx = canvas.getContext('2d');
    const bubbleLayout = layoutMeta.bubbleLayout;

    // เติมรอยทำเครื่องหมายจำลองในแต่ละข้อ (จำลองทั้ง กากบาท X, ขีดถูก ✓, ขีดทับ, และฝนทึบ ด้วยปากกาน้ำเงิน/ดำ)
    const penColors = ['#1E3A8A', '#0F172A', '#2563EB', '#1F2937']; // ปากกาน้ำเงิน, ดำ, น้ำเงินสด, ดินสอ
    const markStyles = ['cross', 'check', 'slash', 'bubble']; // หลากหลายรูปแบบเพื่อทดสอบการขีดเขียน

    for (const q of bubbleLayout) {
      const qNum = q.questionNumber;
      if (qNum > examKey.totalQuestions) continue;
      const correctChoice = examKey.answers[qNum] !== undefined ? examKey.answers[qNum] : 0;

      // สุ่มว่าจะตอบถูกหรือผิดตาม accuracyPercent
      let chosenChoice = correctChoice;
      if (Math.random() * 100 > accuracyPercent) {
        // ตอบผิด สุ่มตัวเลือกอื่น
        const wrongChoices = [0, 1, 2, 3].filter(c => c !== correctChoice);
        chosenChoice = wrongChoices[Math.floor(Math.random() * wrongChoices.length)];
      }

      const bubble = q.choices[chosenChoice];
      const r = bubble.radius || 11;
      const color = penColors[Math.floor(Math.random() * penColors.length)];
      const style = markStyles[Math.floor(Math.random() * markStyles.length)];

      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      if (style === 'cross') {
        // กากบาท ❌ (Pen Cross Mark)
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bubble.x - r * 0.6, bubble.y - r * 0.6);
        ctx.lineTo(bubble.x + r * 0.6, bubble.y + r * 0.6);
        ctx.moveTo(bubble.x + r * 0.6, bubble.y - r * 0.6);
        ctx.lineTo(bubble.x - r * 0.6, bubble.y + r * 0.6);
        ctx.stroke();
      } else if (style === 'check') {
        // ขีดถูก ✓ (Checkmark)
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bubble.x - r * 0.55, bubble.y);
        ctx.lineTo(bubble.x - r * 0.1, bubble.y + r * 0.5);
        ctx.lineTo(bubble.x + r * 0.65, bubble.y - r * 0.6);
        ctx.stroke();
      } else if (style === 'slash') {
        // ขีดเส้นทับ / (Pen Slash)
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bubble.x - r * 0.65, bubble.y + r * 0.65);
        ctx.lineTo(bubble.x + r * 0.65, bubble.y - r * 0.65);
        ctx.stroke();
      } else {
        // ฝนดำ ● (Full Shading)
        ctx.beginPath();
        ctx.arc(bubble.x, bubble.y, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    return canvas;
  }
}

window.OMREngine = OMREngine;

