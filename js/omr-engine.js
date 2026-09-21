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
        error: 'ยังไม่พบกระดาษคำตอบ กรุณาส่องให้เห็นจุดมาร์คสี่เหลี่ยมดำ 4 มุมครบถ้วน',
        foundCornersCount: corners ? corners.length : 0
      };
    }

    // 2. ตรวจสอบความสมบูรณ์ทางเรขาคณิต (Convexity, Area, Aspect Ratio)
    if (!this.isValidQuadGeometry(corners, sw, sh)) {
      return {
        success: false,
        error: 'มุมมองกระดาษเอียงเกินไปหรือไม่ใช่รูปทรงกระดาษคำตอบ',
        corners
      };
    }

    // 3. ปรับมุมมองภาพ (Perspective Warp) ให้ระนาบตรง
    const warpedCanvas = this.warpPerspective(srcCanvas, corners);
    if (!warpedCanvas) {
      return { success: false, error: 'ไม่สามารถปรับระนาบภาพได้' };
    }

    // 4. ตรวจสอบยืนยันจุดมาร์ค 4 มุมและพื้นหลังกระดาษจริง (ป้องกันการตรวจจับสิ่งของในห้องเป็นกระดาษ)
    const markerCheck = this.verifyWarpedMarkers(warpedCanvas);
    if (!markerCheck.valid) {
      return {
        success: false,
        error: markerCheck.reason || 'ไม่พบจุดมาร์คของกระดาษคำตอบ',
        corners
      };
    }

    // 5. วิเคราะห์ความเข้มของวงกลมแต่ละข้อ (Bubble Density Analysis)
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
   * รองรับทั้ง HTMLCanvasElement, HTMLVideoElement, และ HTMLImageElement
   */
  detectCorners(source) {
    let canvas = source;
    if (!(source instanceof HTMLCanvasElement)) {
      if (!this._detectCanvas) {
        this._detectCanvas = document.createElement('canvas');
      }
      const sw = source.videoWidth || source.naturalWidth || source.width || 640;
      const sh = source.videoHeight || source.naturalHeight || source.height || 480;
      if (this._detectCanvas.width !== sw || this._detectCanvas.height !== sh) {
        this._detectCanvas.width = sw;
        this._detectCanvas.height = sh;
      }
      const ctx = this._detectCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, sw, sh);
      canvas = this._detectCanvas;
    }

    if (this.isCvReady && window.cv) {
      const cvCorners = this.detectCornersWithOpenCV(canvas);
      if (cvCorners) return cvCorners;
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

        // คัดกรองขนาดจุดมาร์ค: ต้องไม่เล็กหรือใหญ่เกินไป (~0.03% ถึง 6% ของพื้นที่ภาพ)
        if (area < imgArea * 0.0003 || area > imgArea * 0.06) {
          cnt.delete();
          continue;
        }

        const rect = cv.boundingRect(cnt);
        const aspectRatio = rect.width / rect.height;

        // จุดมาร์คต้องเป็นรูปสี่เหลี่ยมจัตุรัสค่อนข้างสมบูรณ์
        if (aspectRatio >= 0.72 && aspectRatio <= 1.38) {
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

      // คัดเลือก 4 จุดที่ประกอบเป็นสี่เหลี่ยมกระดาษคำตอบที่ถูกต้องและพื้นที่เหมาะสมที่สุด
      return this.findBestQuadFromCandidates(merged, canvas.width, canvas.height);
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
    // ถ้าภาพมืดเกินไป (เช่น ปิดกล้องหรือห้องมืดมาก) ไม่ต้องประมวลผล
    if (avgBrightness < 50) return null;

    const threshold = Math.max(45, avgBrightness * 0.65);

    // ค้นหาจุดมาร์คเฉพาะจุดที่มีแกนกลางสีดำล้อมรอบด้วยกระดาษสีขาวใน 4 จตุภาค
    const corners = [
      this.findCornerInQuadrant(data, w, h, Math.floor(w * 0.02), Math.floor(w * 0.45), Math.floor(h * 0.02), Math.floor(h * 0.45), threshold, 'TL'),
      this.findCornerInQuadrant(data, w, h, Math.floor(w * 0.55), Math.floor(w * 0.98), Math.floor(h * 0.02), Math.floor(h * 0.45), threshold, 'TR'),
      this.findCornerInQuadrant(data, w, h, Math.floor(w * 0.55), Math.floor(w * 0.98), Math.floor(h * 0.55), Math.floor(h * 0.98), threshold, 'BR'),
      this.findCornerInQuadrant(data, w, h, Math.floor(w * 0.02), Math.floor(w * 0.45), Math.floor(h * 0.55), Math.floor(h * 0.98), threshold, 'BL')
    ];

    if (corners.every(c => c !== null)) {
      const ordered = this.orderQuadCorners(corners);
      if (this.isValidQuadGeometry(ordered, w, h)) {
        return ordered;
      }
    }
    return null;
  }

  /**
   * ค้นหาจุดมาร์คสี่เหลี่ยมดำในจตุภาค โดยตรวจสอบความดำภายในและขอบขาวรอบนอก (Annular Ring Filter)
   */
  findCornerInQuadrant(data, w, h, minX, maxX, minY, maxY, threshold, quad) {
    const scanStep = 4;
    let bestPoint = null;
    let bestScore = -1;

    const cornerTarget = {
      TL: { x: minX, y: minY },
      TR: { x: maxX, y: minY },
      BR: { x: maxX, y: maxY },
      BL: { x: minX, y: maxY }
    }[quad];

    for (let y = minY + 12; y < maxY - 12; y += scanStep) {
      for (let x = minX + 12; x < maxX - 12; x += scanStep) {
        const idx = (y * w + x) * 4;
        const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;

        // แกนกลางต้องมีความเข้มมากกว่า threshold
        if (b < threshold) {
          let darkCount = 0;
          let lightCount = 0;
          const rInner = 6;
          const rOuter = 16;

          // ตรวจสอบพื้นที่สี่เหลี่ยมด้านใน
          for (let dy = -rInner; dy <= rInner; dy += 3) {
            for (let dx = -rInner; dx <= rInner; dx += 3) {
              const nIdx = ((y + dy) * w + (x + dx)) * 4;
              const nb = (data[nIdx] + data[nIdx + 1] + data[nIdx + 2]) / 3;
              if (nb < threshold) darkCount++;
            }
          }

          // ตรวจสอบวงแหวนรอบนอก (ต้องเป็นกระดาษขาวสว่าง)
          const angles = [0, 0.78, 1.57, 2.35, 3.14, 3.92, 4.71, 5.49];
          for (const a of angles) {
            const ox = Math.round(x + Math.cos(a) * rOuter);
            const oy = Math.round(y + Math.sin(a) * rOuter);
            if (ox >= 0 && ox < w && oy >= 0 && oy < h) {
              const oIdx = (oy * w + ox) * 4;
              const ob = (data[oIdx] + data[oIdx + 1] + data[oIdx + 2]) / 3;
              if (ob > threshold * 1.3) lightCount++;
            }
          }

          // จุดมาร์คที่ถูกต้อง: ด้านในดำทึบ และด้านนอกขาวสว่างรอบทิศ
          if (darkCount >= 14 && lightCount >= 5) {
            const dist = Math.hypot(x - cornerTarget.x, y - cornerTarget.y);
            const score = 1000 - dist;
            if (score > bestScore) {
              bestScore = score;
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
   * ค้นหาชุด 4 จุดจากตัวเลือกทั้งหมดที่สร้างเป็นสี่เหลี่ยมกระดาษที่สมบูรณ์ที่สุด
   */
  findBestQuadFromCandidates(points, imgW, imgH) {
    if (points.length < 4) return null;

    if (points.length === 4) {
      const ordered = this.orderQuadCorners(points);
      if (this.isValidQuadGeometry(ordered, imgW, imgH)) {
        return ordered;
      }
      return null;
    }

    let bestQuad = null;
    let maxArea = 0;
    const n = Math.min(points.length, 12);

    for (let i = 0; i < n - 3; i++) {
      for (let j = i + 1; j < n - 2; j++) {
        for (let k = j + 1; k < n - 1; k++) {
          for (let l = k + 1; l < n; l++) {
            const candidateSubset = [points[i], points[j], points[k], points[l]];
            const ordered = this.orderQuadCorners(candidateSubset);
            if (this.isValidQuadGeometry(ordered, imgW, imgH)) {
              const area = this.calculateQuadArea(ordered);
              if (area > maxArea) {
                maxArea = area;
                bestQuad = ordered;
              }
            }
          }
        }
      }
    }

    return bestQuad;
  }

  /**
   * จัดเรียงจุด 4 จุดให้เป็นลำดับตามเข็มนาฬิกา: [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
   */
  orderQuadCorners(points) {
    if (!points || points.length !== 4) return points;

    // 1. หาจุด Centroid
    const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
    const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;

    // 2. เรียงตามมุมองศา
    const sorted = [...points].sort((a, b) => {
      const angleA = Math.atan2(a.y - cy, a.x - cx);
      const angleB = Math.atan2(b.y - cy, b.x - cx);
      return angleA - angleB;
    });

    // 3. หาจุดที่ใกล้ (0,0) ที่สุดเป็น TL
    let minD = Infinity;
    let tlIdx = 0;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(sorted[i].x, sorted[i].y);
      if (d < minD) {
        minD = d;
        tlIdx = i;
      }
    }

    const ordered = [];
    for (let i = 0; i < 4; i++) {
      ordered.push(sorted[(tlIdx + i) % 4]);
    }

    // ตรวจสอบทิศตามเข็มนาฬิกา
    const v1x = ordered[1].x - ordered[0].x;
    const v1y = ordered[1].y - ordered[0].y;
    const v2x = ordered[2].x - ordered[1].x;
    const v2y = ordered[2].y - ordered[1].y;
    const cp = v1x * v2y - v1y * v2x;
    if (cp < 0) {
      return [ordered[0], ordered[3], ordered[2], ordered[1]];
    }

    return ordered;
  }

  /**
   * คำนวณพื้นที่รูปสี่เหลี่ยม
   */
  calculateQuadArea([tl, tr, br, bl]) {
    return 0.5 * Math.abs((tl.x*tr.y - tl.y*tr.x) + (tr.x*br.y - tr.y*br.x) + (br.x*bl.y - br.y*bl.x) + (bl.x*tl.y - bl.y*tl.x));
  }

  /**
   * ตรวจสอบความสมบูรณ์ทางเรขาคณิตของรูปสี่เหลี่ยมกระดาษคำตอบ
   */
  isValidQuadGeometry(corners, imgW, imgH) {
    if (!corners || corners.length !== 4) return false;
    const [tl, tr, br, bl] = corners;

    // 1. ตรวจสอบพิกัดไม่หลุดขอบภาพ
    for (const p of corners) {
      if (p.x < -15 || p.x > imgW + 15 || p.y < -15 || p.y > imgH + 15) return false;
    }

    // 2. ตรวจสอบความนูน (Convexity) โดยใช้ Cross Product ของทุกด้านตามเข็มนาฬิกา
    const v1x = tr.x - tl.x, v1y = tr.y - tl.y;
    const v2x = br.x - tr.x, v2y = br.y - tr.y;
    const v3x = bl.x - br.x, v3y = bl.y - br.y;
    const v4x = tl.x - bl.x, v4y = tl.y - bl.y;

    const cp1 = v1x * v2y - v1y * v2x;
    const cp2 = v2x * v3y - v2y * v3x;
    const cp3 = v3x * v4y - v3y * v4x;
    const cp4 = v4x * v1y - v4y * v1x;

    if (!(cp1 > 0 && cp2 > 0 && cp3 > 0 && cp4 > 0)) {
      return false;
    }

    // 3. ตรวจสอบพื้นที่ (ต้องไม่เล็กกว่า 5% ของจอภาพ และไม่ล้นจอเกินไป)
    const area = this.calculateQuadArea(corners);
    const imgArea = imgW * imgH;
    if (area < imgArea * 0.05 || area > imgArea * 0.98) {
      return false;
    }

    // 4. ความยาวของแต่ละด้าน
    const dTop = Math.hypot(v1x, v1y);
    const dRight = Math.hypot(v2x, v2y);
    const dBottom = Math.hypot(v3x, v3y);
    const dLeft = Math.hypot(v4x, v4y);

    const minSide = Math.min(dTop, dRight, dBottom, dLeft);
    if (minSide < Math.min(imgW, imgH) * 0.12) {
      return false;
    }

    // 5. สัดส่วน กว้าง : ยาว (Aspect Ratio)
    const avgW = (dTop + dBottom) / 2;
    const avgH = (dLeft + dRight) / 2;
    const aspect = avgW / avgH;
    if (aspect < 0.35 || aspect > 2.2) {
      return false;
    }

    // 6. ด้านตรงข้ามต้องไม่ต่างกันเกิน 60%
    if (Math.abs(dTop - dBottom) / Math.max(dTop, dBottom) > 0.60) return false;
    if (Math.abs(dLeft - dRight) / Math.max(dLeft, dRight) > 0.60) return false;

    return true;
  }

  /**
   * ตรวจสอบยืนยันจุดมาร์คสี่เหลี่ยมสีดำ 4 มุมบนภาพที่ Warp แล้ว (ป้องกันการสับสนกับโต๊ะ/ผนัง/สิ่งของ)
   */
  verifyWarpedMarkers(warpedCanvas) {
    const w = warpedCanvas.width;
    const h = warpedCanvas.height;
    const ctx = warpedCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // 1. ตรวจสอบความสว่างของกระดาษโดยรวม
    let paperBrightnessSum = 0;
    let samples = 0;
    for (let i = 0; i < 40; i++) {
      const rx = Math.floor(w * 0.2 + (i % 8) * w * 0.08);
      const ry = Math.floor(h * 0.2 + Math.floor(i / 8) * h * 0.12);
      paperBrightnessSum += this.samplePixelBrightness(data, w, rx, ry);
      samples++;
    }
    const paperBrightness = paperBrightnessSum / samples;

    // หากพื้นหลังมืดเกินไป (ส่องโต๊ะไม้สีเข้ม, เสื้อผ้า, ผนังห้อง)
    if (paperBrightness < 80) {
      return { valid: false, reason: 'แสงน้อยหรือพื้นหลังมืดเกินไป ไม่ใช่กระดาษสีขาว' };
    }

    // 2. ตรวจสอบความดำเข้มที่ 4 มุมของภาพที่ Warp
    const markerCheckPoints = [
      { x: Math.round(w * 0.035), y: Math.round(h * 0.035) }, // TL
      { x: Math.round(w * 0.965), y: Math.round(h * 0.035) }, // TR
      { x: Math.round(w * 0.965), y: Math.round(h * 0.965) }, // BR
      { x: Math.round(w * 0.035), y: Math.round(h * 0.965) }  // BL
    ];

    let validMarkerCount = 0;
    for (const pt of markerCheckPoints) {
      let darkCount = 0;
      let total = 0;
      const radius = 12;
      for (let dy = -radius; dy <= radius; dy += 3) {
        for (let dx = -radius; dx <= radius; dx += 3) {
          const px = Math.min(w - 1, Math.max(0, pt.x + dx));
          const py = Math.min(h - 1, Math.max(0, pt.y + dy));
          const b = this.samplePixelBrightness(data, w, px, py);
          if (b < paperBrightness * 0.65) {
            darkCount++;
          }
          total++;
        }
      }

      if (total > 0 && (darkCount / total) >= 0.20) {
        validMarkerCount++;
      }
    }

    // ต้องผ่านการตรวจสอบจุดมาร์คอย่างน้อย 3 ใน 4 จุด
    if (validMarkerCount < 3) {
      return { valid: false, reason: `ไม่พบจุดมาร์คดำ 4 มุมของกระดาษคำตอบ (ตรวจพบ ${validMarkerCount}/4 จุด)` };
    }

    return { valid: true, paperBrightness, validMarkerCount };
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

