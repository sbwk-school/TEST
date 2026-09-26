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
    const checkCv = () => {
      if (window.cv && window.cv.Mat) {
        this.isCvReady = true;
      } else if (window.cv) {
        window.cv.onRuntimeInitialized = () => {
          this.isCvReady = true;
        };
      }
    };
    checkCv();
    window.addEventListener('opencv-ready', () => {
      checkCv();
    });
  }

  /**
   * ประมวลผลเฟรมภาพหรือรูปภาพ
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} sourceElement
   * @param {object} examKey - ชุดเฉลย { totalQuestions, answers: { 1: 0, 2: 1, ... } }
   * @param {object} layoutMeta - ข้อมูลตำแหน่งพิกัดของกระดาษคำตอบจาก SheetGenerator
   * @returns {object} ผลการตรวจ { success, score, total, percentage, answers, corners, warpedCanvas }
   */
  processFrame(sourceElement, examKey, layoutMeta, targetCorners = null) {
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
    const detection = this.detectCorners(srcCanvas, targetCorners);
    const corners = detection ? detection.corners : null;
    const candidates = detection ? detection.candidates : [];

    if (!corners || corners.length !== 4) {
      const count = candidates.length;
      return {
        success: false,
        error: count > 0 
          ? `พบจุดมาร์คเพียง ${count}/4 จุด กรุณาถอยกล้องออกเล็กน้อยให้เห็นครบ 4 มุม`
          : 'ยังไม่พบกระดาษคำตอบ กรุณาส่องให้เห็นจุดมาร์คสี่เหลี่ยมดำ 4 มุมครบถ้วน',
        foundCornersCount: count,
        candidates
      };
    }

    // 2. ตรวจสอบความสมบูรณ์ทางเรขาคณิต (Convexity, Area, Aspect Ratio)
    if (!this.isValidQuadGeometry(corners, sw, sh)) {
      return {
        success: false,
        error: 'มุมมองกระดาษเอียงเกินไปหรือไม่ใช่รูปทรงกระดาษคำตอบ',
        corners,
        candidates
      };
    }

    // 3. ปรับมุมมองภาพ (Perspective Warp) ให้ระนาบตรง
    const warpedCanvas = this.warpPerspective(srcCanvas, corners);
    if (!warpedCanvas) {
      return { success: false, error: 'ไม่สามารถปรับระนาบภาพได้', corners, candidates };
    }

    // 4. ตรวจสอบยืนยันจุดมาร์ค 4 มุมและพื้นหลังกระดาษจริง (ป้องกันการตรวจจับสิ่งของในห้องเป็นกระดาษ)
    const markerCheck = this.verifyWarpedMarkers(warpedCanvas);
    if (!markerCheck.valid) {
      return {
        success: false,
        error: markerCheck.reason || 'ไม่พบจุดมาร์คของกระดาษคำตอบ',
        corners,
        candidates
      };
    }

    // 5. วิเคราะห์ความเข้มของวงกลมแต่ละข้อ (Bubble Density Analysis)
    const gradingResult = this.readBubblesAndGrade(warpedCanvas, examKey, layoutMeta);

    return {
      success: true,
      corners,
      candidates,
      warpedCanvas,
      ...gradingResult
    };
  }

  /**
   * ค้นหาจุดศูนย์กลางของจุดมาร์ค 4 มุม (Marker Centers)
   * รองรับทั้งโหมดล็อกเป้า 4 มุม (Target ROIs Mode) และโหมดค้นหาอัตโนมัติทั่วภาพ
   */
  detectCorners(source, targetCorners = null) {
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

    // 1. โหมดล็อกพิกัดเป้าหมาย 4 มุม (Target ROIs Alignment Mode)
    // ตรวจหาจุดมาร์คเฉพาะภายในกรอบเป้าหมาย 4 มุม รวดเร็ว แม่นยำ และไม่ถูกรบกวนจากขอบจอหรือโต๊ะ
    if (targetCorners && targetCorners.length === 4) {
      const roiRadius = Math.round(Math.min(canvas.width, canvas.height) * 0.12);
      const roiResult = this.detectCornersInTargetROIs(canvas, targetCorners, roiRadius);
      if (roiResult) {
        return roiResult;
      }
    }

    // 2. ถ้าไม่ได้ใช้เป้าหมาย ให้ค้นหาด้วย Pure JavaScript Robust Blob Tracker
    const globalResult = this.detectCornersPureJS(canvas);
    return {
      allMatched: !!(globalResult && globalResult.corners),
      matchedCount: globalResult && globalResult.corners ? 4 : (globalResult ? globalResult.candidates.length : 0),
      matchedCorners: globalResult && globalResult.corners ? globalResult.corners : [null, null, null, null],
      corners: globalResult ? globalResult.corners : null,
      candidates: globalResult ? globalResult.candidates : []
    };
  }

  /**
   * ตรวจจับจุดมาร์คสี่เหลี่ยมดำเฉพาะภายในกรอบเป้าหมาย 4 มุม (Target ROIs Alignment Mode)
   * ค้นหาเฉพาะในรัศมีที่กำหนดรอบแต่ละมุม ทำให้ไม่ถูกสิ่งของอื่นในห้องรบกวน 100%
   */
  detectCornersInTargetROIs(canvas, targetCorners, roiRadius = 75) {
    if (!targetCorners || targetCorners.length !== 4) return null;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;

    const matchedCorners = [];
    let matchedCount = 0;

    for (let i = 0; i < 4; i++) {
      const target = targetCorners[i];
      const minX = Math.max(2, Math.floor(target.x - roiRadius));
      const maxX = Math.min(w - 2, Math.ceil(target.x + roiRadius));
      const minY = Math.max(2, Math.floor(target.y - roiRadius));
      const maxY = Math.min(h - 2, Math.ceil(target.y + roiRadius));
      const roiW = maxX - minX;
      const roiH = maxY - minY;

      if (roiW <= 10 || roiH <= 10) {
        matchedCorners.push(null);
        continue;
      }

      const imgData = ctx.getImageData(minX, minY, roiW, roiH);
      const data = imgData.data;

      // คำนวณความสว่างเฉลี่ยใน ROI
      let sumB = 0;
      let samples = 0;
      for (let py = 4; py < roiH - 4; py += 5) {
        for (let px = 4; px < roiW - 4; px += 5) {
          const idx = (py * roiW + px) * 4;
          sumB += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
          samples++;
        }
      }
      const avgB = samples > 0 ? (sumB / samples) : 128;
      const darkThresh = Math.max(35, avgB * 0.68);

      let bestBlob = null;
      let minTargetDist = Infinity;

      for (let py = 6; py < roiH - 6; py += 3) {
        for (let px = 6; px < roiW - 6; px += 3) {
          const idx = (py * roiW + px) * 4;
          const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;

          if (b < darkThresh) {
            // วัดความกว้างแนวนอน
            let xL = px;
            while (xL > 1 && (data[(py * roiW + (xL - 1)) * 4] + data[(py * roiW + (xL - 1)) * 4 + 1] + data[(py * roiW + (xL - 1)) * 4 + 2]) / 3 < darkThresh * 1.15) {
              xL--;
            }
            let xR = px;
            while (xR < roiW - 2 && (data[(py * roiW + (xR + 1)) * 4] + data[(py * roiW + (xR + 1)) * 4 + 1] + data[(py * roiW + (xR + 1)) * 4 + 2]) / 3 < darkThresh * 1.15) {
              xR++;
            }
            const blobW = xR - xL + 1;

            if (blobW >= 12 && blobW <= 90) {
              const midX = Math.round((xL + xR) / 2);
              let yT = py;
              while (yT > 1 && (data[((yT - 1) * roiW + midX) * 4] + data[((yT - 1) * roiW + midX) * 4 + 1] + data[((yT - 1) * roiW + midX) * 4 + 2]) / 3 < darkThresh * 1.15) {
                yT--;
              }
              let yB = py;
              while (yB < roiH - 2 && (data[((yB + 1) * roiW + midX) * 4] + data[((yB + 1) * roiW + midX) * 4 + 1] + data[((yB + 1) * roiW + midX) * 4 + 2]) / 3 < darkThresh * 1.15) {
                yB++;
              }
              const blobH = yB - yT + 1;

              if (blobH >= 12 && blobH <= 90) {
                const aspect = blobW / blobH;
                if (aspect >= 0.50 && aspect <= 1.80) {
                  const globalCenterX = minX + midX;
                  const globalCenterY = minY + Math.round((yT + yB) / 2);
                  const dist = Math.hypot(globalCenterX - target.x, globalCenterY - target.y);

                  if (dist < minTargetDist && dist <= roiRadius) {
                    minTargetDist = dist;
                    bestBlob = { x: globalCenterX, y: globalCenterY, dist };
                  }
                }
              }
            }
          }
        }
      }

      if (bestBlob) {
        matchedCorners.push(bestBlob);
        matchedCount++;
      } else {
        matchedCorners.push(null);
      }
    }

    const allMatched = (matchedCount === 4);
    const corners = allMatched ? [matchedCorners[0], matchedCorners[1], matchedCorners[2], matchedCorners[3]] : null;

    return {
      allMatched,
      matchedCount,
      matchedCorners,
      corners,
      candidates: matchedCorners.filter(Boolean)
    };
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

      const blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      const thresh = new cv.Mat();
      cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 12);

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

      const candidates = [];
      const imgArea = canvas.width * canvas.height;
      const hData = hierarchy.data32S;

      for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);

        if (area >= imgArea * 0.0002 && area <= imgArea * 0.09) {
          const rect = cv.boundingRect(cnt);
          const aspectRatio = rect.width / rect.height;

          if (aspectRatio >= 0.60 && aspectRatio <= 1.65) {
            const extent = area / (rect.width * rect.height);
            const childIdx = hData ? hData[i * 4 + 2] : -1;
            const isNested = (childIdx >= 0);

            // ยอมรับทั้งมาร์คที่มีวงแหวนซ้อน และมาร์คสี่เหลี่ยมดำทึบ (ป้องกันกรณีย่อส่วนหรือเบลอจนมองไม่เห็นวงแหวน)
            if (isNested || (extent >= 0.35 && area >= imgArea * 0.0003)) {
              const moments = cv.moments(cnt);
              if (moments.m00 !== 0) {
                const cx = moments.m10 / moments.m00;
                const cy = moments.m01 / moments.m00;
                candidates.push({ x: cx, y: cy });
              }
            }
          }
        }
        cnt.delete();
      }

      src.delete();
      gray.delete();
      blur.delete();
      thresh.delete();
      contours.delete();
      hierarchy.delete();

      const merged = this.clusterNearbyPoints(candidates, canvas.width * 0.035);
      if (merged.length < 4) {
        return { corners: null, candidates: merged };
      }

      const corners = this.findBestQuadFromCandidates(merged, canvas.width, canvas.height);
      return { corners, candidates: merged };
    } catch (err) {
      console.warn('OpenCV detection error, using fallback:', err);
      return null;
    }
  }

  /**
   * ตรวจจับจุดมาร์คสี่เหลี่ยมดำทั่วทั้งภาพด้วย Pure JavaScript แบบทนทานต่อแสงและระยะกล้อง (Robust Blob Tracker)
   * ตรวจจับได้ทั้งสี่เหลี่ยมซ้อนและสี่เหลี่ยมดำทึบ 4 มุมบนพื้นหลังกระดาษขาว
   */
  detectCornersPureJS(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // 1. คำนวณความสว่างเฉลี่ยของภาพ
    let sumBrightness = 0;
    const stepSample = 14;
    let sampleCount = 0;
    for (let y = 10; y < h - 10; y += stepSample) {
      for (let x = 10; x < w - 10; x += stepSample) {
        const idx = (y * w + x) * 4;
        sumBrightness += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        sampleCount++;
      }
    }
    const avgBrightness = sampleCount > 0 ? (sumBrightness / sampleCount) : 128;
    if (avgBrightness < 35) return { corners: null, candidates: [] };

    const darkThreshold = Math.max(35, avgBrightness * 0.65);

    // 2. ค้นหาจุดมาร์คสี่เหลี่ยมสีดำบนพื้นกระดาษขาว
    const rawCandidates = [];
    const scanStep = 6;
    const visited = new Uint8Array(w * h);

    for (let y = 15; y < h - 15; y += scanStep) {
      for (let x = 15; x < w - 15; x += scanStep) {
        const idx = (y * w + x) * 4;
        if (visited[y * w + x]) continue;

        const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;

        if (b < darkThreshold) {
          // ตรวจสอบความกว้างแนวนอนของกลุ่มพิกเซลด่างมืด
          let xL = x;
          while (xL > 5 && (data[(y * w + (xL - 1)) * 4] + data[(y * w + (xL - 1)) * 4 + 1] + data[(y * w + (xL - 1)) * 4 + 2]) / 3 < darkThreshold * 1.15) {
            xL--;
          }
          let xR = x;
          while (xR < w - 5 && (data[(y * w + (xR + 1)) * 4] + data[(y * w + (xR + 1)) * 4 + 1] + data[(y * w + (xR + 1)) * 4 + 2]) / 3 < darkThreshold * 1.15) {
            xR++;
          }
          const wBlob = xR - xL + 1;

          // ขนาดจุดมาร์คในแนวนอนต้องอยู่ระหว่าง 12 ถึง 85 พิกเซล
          if (wBlob >= 12 && wBlob <= 85) {
            const midX = Math.round((xL + xR) / 2);

            // ตรวจสอบความสูงแนวตั้งที่จุดกึ่งกลางแนวนอน
            let yT = y;
            while (yT > 5 && (data[((yT - 1) * w + midX) * 4] + data[((yT - 1) * w + midX) * 4 + 1] + data[((yT - 1) * w + midX) * 4 + 2]) / 3 < darkThreshold * 1.15) {
              yT--;
            }
            let yB = y;
            while (yB < h - 5 && (data[((yB + 1) * w + midX) * 4] + data[((yB + 1) * w + midX) * 4 + 1] + data[((yB + 1) * w + midX) * 4 + 2]) / 3 < darkThreshold * 1.15) {
              yB++;
            }
            const hBlob = yB - yT + 1;

            // ขนาดแนวตั้งและสัดส่วน กว้าง:สูง ต้องใกล้เคียงรูปสี่เหลี่ยมจัตุรัส (0.55 - 1.70)
            if (hBlob >= 12 && hBlob <= 85) {
              const aspect = wBlob / hBlob;
              if (aspect >= 0.55 && aspect <= 1.70) {
                // ตรวจสอบว่ารอบนอกเป็นกระดาษขาว
                const borderPad = 4;
                const p1 = Math.max(0, xL - borderPad);
                const p2 = Math.min(w - 1, xR + borderPad);
                const p3 = Math.max(0, yT - borderPad);
                const p4 = Math.min(h - 1, yB + borderPad);

                const bLeft = this.samplePixelBrightness(data, w, p1, y);
                const bRight = this.samplePixelBrightness(data, w, p2, y);
                const bTop = this.samplePixelBrightness(data, w, midX, p3);
                const bBottom = this.samplePixelBrightness(data, w, midX, p4);

                let lightBorders = 0;
                if (bLeft > darkThreshold) lightBorders++;
                if (bRight > darkThreshold) lightBorders++;
                if (bTop > darkThreshold) lightBorders++;
                if (bBottom > darkThreshold) lightBorders++;

                // ต้องมีขอบสว่างล้อมรอบอย่างน้อย 3 ใน 4 ด้าน (เป็นวัตถุโดดเดี่ยวบนกระดาษ)
                if (lightBorders >= 3) {
                  const midY = Math.round((yT + yB) / 2);
                  rawCandidates.push({ x: midX, y: midY });

                  // ทำเครื่องหมาย visited เพื่อไม่ตรวจซ้ำในบล็อกเดิม
                  for (let vy = yT; vy <= yB; vy += 2) {
                    for (let vx = xL; vx <= xR; vx += 2) {
                      visited[vy * w + vx] = 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. รวมกลุ่มจุดซ้ำซ้อนให้เหลือศูนย์กลางมาร์คละ 1 จุด
    const candidates = this.clusterNearbyPoints(rawCandidates, 26);

    // 4. ถ้าพบไม่ถึง 4 จุด ให้ส่งกลับเฉพาะมาร์คที่พบ เพื่อแสดงจุดนำสายตาให้ผู้ใช้ทราบ
    if (candidates.length < 4) {
      return { corners: null, candidates };
    }

    // 5. ค้นหาชุด 4 จุดที่ประกอบเป็นสี่เหลี่ยมกระดาษคำตอบที่ดีที่สุด
    const corners = this.findBestQuadFromCandidates(candidates, w, h);
    return { corners, candidates };
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
  /**
   * ค้นหาชุด 4 จุดจากตัวเลือกทั้งหมดที่สร้างเป็นสี่เหลี่ยมกระดาษที่สมบูรณ์ที่สุด
   * คัดเลือกเฉพาะจุดมุมนอกสุด (Extreme Corner Markers) เพื่อป้องกันไม่ให้ไปจับจุดฝนคำตอบภายในกระดาษ
   */
  findBestQuadFromCandidates(points, imgW, imgH) {
    if (!points || points.length < 4) return null;

    if (points.length === 4) {
      const ordered = this.orderQuadCorners(points);
      if (this.isValidQuadGeometry(ordered, imgW, imgH)) {
        return ordered;
      }
      return null;
    }

    // คำนวณจุดศูนย์กลางของกลุ่มจุดตัวเลือกทั้งหมด
    let sumX = 0, sumY = 0;
    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
    }
    const meanX = sumX / points.length;
    const meanY = sumY / points.length;

    // หาจุดที่ไกลที่สุดในแต่ละ Quadrant (TL, TR, BR, BL) เทียบกับ Centroid
    // วิธีนี้รับประกัน 100% ว่าจะเลือกจุดมาร์ค 4 มุมกระดาษ และไม่เลือกจุดฝนคำตอบที่อยู่ข้างใน
    let bestTL = null, maxDistTL = -1;
    let bestTR = null, maxDistTR = -1;
    let bestBR = null, maxDistBR = -1;
    let bestBL = null, maxDistBL = -1;

    for (const p of points) {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      const distSq = dx * dx + dy * dy;

      if (dx <= 0 && dy <= 0) { // Top-Left
        if (distSq > maxDistTL) { maxDistTL = distSq; bestTL = p; }
      } else if (dx > 0 && dy <= 0) { // Top-Right
        if (distSq > maxDistTR) { maxDistTR = distSq; bestTR = p; }
      } else if (dx > 0 && dy > 0) { // Bottom-Right
        if (distSq > maxDistBR) { maxDistBR = distSq; bestBR = p; }
      } else if (dx <= 0 && dy > 0) { // Bottom-Left
        if (distSq > maxDistBL) { maxDistBL = distSq; bestBL = p; }
      }
    }

    if (bestTL && bestTR && bestBR && bestBL) {
      const unique = new Set([bestTL, bestTR, bestBR, bestBL]);
      if (unique.size === 4) {
        const quad = this.orderQuadCorners([bestTL, bestTR, bestBR, bestBL]);
        if (this.isValidQuadGeometry(quad, imgW, imgH)) {
          return quad;
        }
      }
    }

    // แผนสำรอง: จัดลำดับตัวเลือกให้อยู่จากขอบนอกเข้าใน (Extreme points first)
    const sortedPoints = [...points].sort((a, b) => {
      const distA = Math.hypot(a.x - meanX, a.y - meanY);
      const distB = Math.hypot(b.x - meanX, b.y - meanY);
      return distB - distA;
    });

    let bestQuad = null;
    let maxArea = 0;
    const n = Math.min(sortedPoints.length, 7);

    for (let i = 0; i < n - 3; i++) {
      for (let j = i + 1; j < n - 2; j++) {
        for (let k = j + 1; k < n - 1; k++) {
          for (let l = k + 1; l < n; l++) {
            const candidateSubset = [sortedPoints[i], sortedPoints[j], sortedPoints[k], sortedPoints[l]];
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
   * จัดเรียงจุด 4 จุดให้เป็นลำดับแน่นอนตามเข็มนาฬิกา: [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
   * ใช้วิธี Extreme Sum/Diff (Szeliski / Rosebrock 4-Point Transform)
   * ซึ่งเป็นวิธีมาตรฐานระดับโลก ไม่เกิดการหมุนวน (Zero Index Cycling) และเส้นไม่ไขว้สลับทิศ
   */
  orderQuadCorners(points) {
    if (!points || points.length !== 4) return points;

    // 1. TL: จุดที่มี (x + y) ต่ำสุด, BR: จุดที่มี (x + y) สูงสุด
    let minSum = Infinity, maxSum = -Infinity;
    let tl = points[0], br = points[0];

    for (const p of points) {
      const sum = p.x + p.y;
      if (sum < minSum) {
        minSum = sum;
        tl = p;
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = p;
      }
    }

    // 2. TR: จุดที่มี (x - y) สูงสุด, BL: จุดที่มี (x - y) ต่ำสุด
    let maxDiff = -Infinity, minDiff = Infinity;
    let tr = points[0], bl = points[0];

    for (const p of points) {
      const diff = p.x - p.y;
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = p;
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = p;
      }
    }

    return [
      { x: tl.x, y: tl.y }, // 0: Top-Left
      { x: tr.x, y: tr.y }, // 1: Top-Right
      { x: br.x, y: br.y }, // 2: Bottom-Right
      { x: bl.x, y: bl.y }  // 3: Bottom-Left
    ];
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

    const isClockwise = (cp1 > 0 && cp2 > 0 && cp3 > 0 && cp4 > 0);
    const isCounterClockwise = (cp1 < 0 && cp2 < 0 && cp3 < 0 && cp4 < 0);

    if (!isClockwise && !isCounterClockwise) {
      return false;
    }

    // 3. ตรวจสอบพื้นที่ (ต้องไม่เล็กกว่า 4% ของจอภาพ และไม่ล้นจอเกินไป)
    const area = this.calculateQuadArea(corners);
    const imgArea = imgW * imgH;
    if (area < imgArea * 0.04 || area > imgArea * 0.98) {
      return false;
    }

    // 4. ความยาวของแต่ละด้าน
    const dTop = Math.hypot(v1x, v1y);
    const dRight = Math.hypot(v2x, v2y);
    const dBottom = Math.hypot(v3x, v3y);
    const dLeft = Math.hypot(v4x, v4y);

    const minSide = Math.min(dTop, dRight, dBottom, dLeft);
    if (minSide < Math.min(imgW, imgH) * 0.10) {
      return false;
    }

    // 5. สัดส่วน กว้าง : ยาว (Aspect Ratio)
    const avgW = (dTop + dBottom) / 2;
    const avgH = (dLeft + dRight) / 2;
    const aspect = avgW / avgH;
    if (aspect < 0.30 || aspect > 2.5) {
      return false;
    }

    // 6. ด้านตรงข้ามต้องไม่ต่างกันเกิน 65%
    if (Math.abs(dTop - dBottom) / Math.max(dTop, dBottom) > 0.65) return false;
    if (Math.abs(dLeft - dRight) / Math.max(dLeft, dRight) > 0.65) return false;

    return true;
  }

  /**
   * ตรวจสอบยืนยันภาพกระดาษคำตอบที่ Warp แล้ว (ตรวจสอบความสว่างของกระดาษสีขาว)
   */
  verifyWarpedMarkers(warpedCanvas) {
    const w = warpedCanvas.width;
    const h = warpedCanvas.height;
    const ctx = warpedCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // ตรวจสอบความสว่างของกระดาษโดยรวม (สุ่ม 40 จุดกลางกระดาษ)
    let paperBrightnessSum = 0;
    let samples = 0;
    for (let i = 0; i < 40; i++) {
      const rx = Math.floor(w * 0.2 + (i % 8) * w * 0.08);
      const ry = Math.floor(h * 0.2 + Math.floor(i / 8) * h * 0.12);
      paperBrightnessSum += this.samplePixelBrightness(data, w, rx, ry);
      samples++;
    }
    const paperBrightness = samples > 0 ? (paperBrightnessSum / samples) : 128;

    // หากพื้นหลังมืดเกินไป (ส่องโต๊ะไม้สีเข้ม, เสื้อผ้า, ผนังห้อง)
    if (paperBrightness < 60) {
      return { valid: false, reason: 'แสงน้อยหรือพื้นหลังมืดเกินไป กรุณาเพิ่มแสงสว่าง' };
    }

    return { valid: true, paperBrightness };
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

