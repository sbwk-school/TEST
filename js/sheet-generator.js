/**
 * SheetGenerator - OMR Answer Sheet Generator (Compact & Pure Grid)
 * กระดาษคำตอบแบบกระชับ ตัดส่วนหัวออกทั้งหมด มีจุดมาร์ค 4 มุมชิดตาราง
 * พร้อมแถบสัญลักษณ์ระบุจำนวนข้อสอบอัตโนมัติ (Machine-Readable Count Indicator)
 */
class SheetGenerator {
  constructor() {
    this.markerSize = 52; // ขนาดจุดมาร์ค 4 มุม
    this.markerMargin = 16; // ขอบรอบนอกชิดพอดี
    this.supportedCounts = [10, 20, 30, 40, 50, 60, 80, 100];
  }

  /**
   * คำนวณโครงสร้างตารางและสร้างภาพกระดาษคำตอบแบบกระชับ
   * @param {number} totalQuestions - จำนวนข้อ (10, 20, 30, 40, 50, ...)
   * @param {string} choiceType - ชนิดตัวเลือก ('thai' | 'num' | 'eng')
   * @param {number|string} columns - จำนวนคอลัมน์ ('auto' หรือ 1, 2, 3, 4)
   * @returns {object} { canvas, layoutMeta }
   */
  generateSheet({
    totalQuestions = 20,
    choiceType = 'thai',
    columns = 'auto'
  } = {}) {
    totalQuestions = parseInt(totalQuestions, 10) || 10;

    // 1. คำนวณจำนวนคอลัมน์และแถว
    let numCols = 1;
    if (columns !== 'auto' && parseInt(columns, 10) > 0) {
      numCols = parseInt(columns, 10);
    } else {
      if (totalQuestions <= 15) numCols = 1;
      else if (totalQuestions <= 30) numCols = 2;
      else if (totalQuestions <= 60) numCols = 3;
      else numCols = 4;
    }

    const questionsPerCol = Math.ceil(totalQuestions / numCols);
    const colWidth = 260; // ความกว้างแต่ละคอลัมน์
    const rowHeight = 40; // ความสูงแต่ละแถวข้อสอบ
    const colGap = 16; // ระยะห่างระหว่างคอลัมน์
    const bubbleRadius = 13;

    // พื้นที่ตาราง
    const tableWidth = numCols * colWidth + (numCols - 1) * colGap;
    const indicatorBarHeight = 36;
    const tableHeaderHeight = 32;
    const gridRowsHeight = questionsPerCol * rowHeight;
    const tableTotalHeight = indicatorBarHeight + tableHeaderHeight + gridRowsHeight + 8;

    // ระยะขอบและช่องไฟ
    const markerMargin = this.markerMargin;
    const markerSize = this.markerSize;
    const padX = 16;

    // ขนาด Canvas สัดส่วนพอดีตาราง
    const canvasWidth = markerMargin * 2 + markerSize * 2 + padX * 2 + tableWidth;
    const canvasHeight = markerMargin * 2 + Math.max(markerSize * 2 + 40, tableTotalHeight + 20);

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    // เติมพื้นหลังสีขาวบริสุทธิ์
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // พิกัดศูนย์กลางของจุดมาร์ค 4 มุม (Marker Centers)
    const markerTL = { x: markerMargin + markerSize / 2, y: markerMargin + markerSize / 2 };
    const markerTR = { x: canvas.width - markerMargin - markerSize / 2, y: markerMargin + markerSize / 2 };
    const markerBL = { x: markerMargin + markerSize / 2, y: canvas.height - markerMargin - markerSize / 2 };
    const markerBR = { x: canvas.width - markerMargin - markerSize / 2, y: canvas.height - markerMargin - markerSize / 2 };

    // วาดจุดมาร์ค 4 มุม (High-contrast Nested Square Markers)
    this.drawFiducialMarker(ctx, markerMargin, markerMargin, markerSize);
    this.drawFiducialMarker(ctx, canvas.width - markerMargin - markerSize, markerMargin, markerSize);
    this.drawFiducialMarker(ctx, markerMargin, canvas.height - markerMargin - markerSize, markerSize);
    this.drawFiducialMarker(ctx, canvas.width - markerMargin - markerSize, canvas.height - markerMargin - markerSize, markerSize);

    // ขอบเขตตารางภายในจุดมาร์ค
    const contentLeft = markerMargin + markerSize + padX;
    const contentRight = contentLeft + tableWidth;
    const contentTop = markerMargin + 6;

    // ฉลากตัวเลือก
    let labels = ['ก', 'ข', 'ค', 'ง'];
    if (choiceType === 'num') labels = ['1', '2', '3', '4'];
    if (choiceType === 'eng') labels = ['A', 'B', 'C', 'D'];

    // 2. วาดแถบสัญลักษณ์ระบุจำนวนข้อสอบ (Question Count Indicator Bar)
    const countIndicators = [];
    const indStartX = contentLeft;
    const indWidth = tableWidth;
    const indCount = this.supportedCounts.length;
    const indStep = indWidth / indCount;

    ctx.font = 'bold 12px "Prompt", "Kanit", sans-serif';
    ctx.textAlign = 'center';

    for (let k = 0; k < indCount; k++) {
      const cNum = this.supportedCounts[k];
      const isCurrent = (cNum === totalQuestions);
      const indCenterX = indStartX + k * indStep + indStep / 2;
      const indCenterY = contentTop + 10;
      const boxSize = 13;

      // สี่เหลี่ยมระบุ (ถมดำทึบ ■ สำหรับจำนวนข้อของกระดาษแผ่นนี้)
      if (isCurrent) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(indCenterX - boxSize / 2, indCenterY - boxSize / 2, boxSize, boxSize);
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(indCenterX - boxSize / 2, indCenterY - boxSize / 2, boxSize, boxSize);
        ctx.strokeStyle = '#6B7280';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(indCenterX - boxSize / 2, indCenterY - boxSize / 2, boxSize, boxSize);
      }

      // ป้ายตัวเลขกำกับ
      ctx.fillStyle = isCurrent ? '#000000' : '#4B5563';
      ctx.fillText(`${cNum}ข`, indCenterX, indCenterY + 18);

      // บันทึกพิกัด Normalized เทียบกับจุดมาร์ค 4 มุม
      const normX = (indCenterX - markerTL.x) / (markerTR.x - markerTL.x);
      const normY = (indCenterY - markerTL.y) / (markerBL.y - markerTL.y);
      const normRadius = (boxSize / 2) / (markerTR.x - markerTL.x);

      countIndicators.push({
        count: cNum,
        isMarked: isCurrent,
        x: indCenterX,
        y: indCenterY,
        normX,
        normY,
        normRadius
      });
    }

    // เส้นคั่นระหว่างแถบระบุจำนวนข้อกับตาราง
    const sepY = contentTop + indicatorBarHeight;
    ctx.strokeStyle = '#9CA3AF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(contentLeft, sepY);
    ctx.lineTo(contentRight, sepY);
    ctx.stroke();

    // 3. วาดหัวตารางของแต่ละคอลัมน์ (ข้อ, ก, ข, ค, ง)
    const gridTop = sepY + 6;

    for (let c = 0; c < numCols; c++) {
      const colX = contentLeft + c * (colWidth + colGap);

      // พื้นหลังหัวคอลัมน์
      ctx.fillStyle = '#F3F4F6';
      ctx.fillRect(colX, gridTop, colWidth, tableHeaderHeight);
      ctx.strokeStyle = '#9CA3AF';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(colX, gridTop, colWidth, tableHeaderHeight);

      ctx.fillStyle = '#111827';
      ctx.font = 'bold 15px "Prompt", "Kanit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('ข้อ', colX + 32, gridTop + 21);

      // ตำแหน่งตัวเลือก 4 ตัว
      const choiceSpacing = (colWidth - 65) / 4;
      for (let ch = 0; ch < 4; ch++) {
        const choiceX = colX + 65 + ch * choiceSpacing + choiceSpacing / 2;
        ctx.fillText(labels[ch], choiceX, gridTop + 21);
      }
    }

    // 4. วาดแถวข้อสอบและวงกลมตัวเลือก (ไม่มีส่วนหัวอื่นใด เอาแต่เนื้อๆ)
    const activeGridTop = gridTop + tableHeaderHeight + 2;
    const bubbleLayout = [];

    for (let i = 1; i <= totalQuestions; i++) {
      const colIndex = Math.floor((i - 1) / questionsPerCol);
      const rowIndex = (i - 1) % questionsPerCol;

      const colX = contentLeft + colIndex * (colWidth + colGap);
      const rowY = activeGridTop + rowIndex * rowHeight + rowHeight / 2;

      // เส้นคั่นบรรทัดบางๆ
      ctx.strokeStyle = '#E5E7EB';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(colX, rowY + rowHeight / 2 - 1);
      ctx.lineTo(colX + colWidth, rowY + rowHeight / 2 - 1);
      ctx.stroke();

      // หมายเลขข้อ
      ctx.fillStyle = '#111827';
      ctx.font = 'bold 16px "Prompt", "Kanit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${i}.`, colX + 32, rowY + 5.5);

      const choiceSpacing = (colWidth - 65) / 4;
      const questionBubbles = [];

      for (let ch = 0; ch < 4; ch++) {
        const bubbleX = colX + 65 + ch * choiceSpacing + choiceSpacing / 2;
        const bubbleY = rowY;

        // วาดวงกลมกระดาษคำตอบ
        ctx.strokeStyle = '#1F2937';
        ctx.fillStyle = '#FFFFFF';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(bubbleX, bubbleY, bubbleRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // ตัวอักษรภายในวงกลม (สีเทาอ่อน เพื่อให้ตรวจจับรอยกากบาท/ขีดถูก/ขีดเส้นได้ชัดเจน)
        ctx.fillStyle = '#9CA3AF';
        ctx.font = '500 13px "Prompt", "Kanit", sans-serif';
        ctx.fillText(labels[ch], bubbleX, bubbleY + 4.5);

        // Normalized relative coordinates [0..1]
        const normX = (bubbleX - markerTL.x) / (markerTR.x - markerTL.x);
        const normY = (bubbleY - markerTL.y) / (markerBL.y - markerTL.y);
        const normRadius = bubbleRadius / (markerTR.x - markerTL.x);

        questionBubbles.push({
          choiceIndex: ch,
          label: labels[ch],
          x: bubbleX,
          y: bubbleY,
          normX,
          normY,
          normRadius
        });
      }

      bubbleLayout.push({
        questionNumber: i,
        choices: questionBubbles
      });
    }

    const layoutMeta = {
      totalQuestions,
      numCols,
      choiceType,
      labels,
      markerTL,
      markerTR,
      markerBL,
      markerBR,
      markerSize: this.markerSize,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      countIndicators,
      bubbleLayout
    };

    return { canvas, layoutMeta };
  }

  /**
   * วาดจุดมาร์คสี่เหลี่ยม 3 ชั้นคอนทราสต์สูง (Nested Square Fiducial)
   */
  drawFiducialMarker(ctx, x, y, size) {
    // 1. สี่เหลี่ยมดำชั้นนอก
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, size, size);

    // 2. ชั้นขาวคั่นกลาง
    const pad1 = Math.round(size * 0.18);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x + pad1, y + pad1, size - pad1 * 2, size - pad1 * 2);

    // 3. จุดดำทึบตรงกลาง
    const pad2 = Math.round(size * 0.36);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + pad2, y + pad2, size - pad2 * 2, size - pad2 * 2);
  }

  /**
   * แปลง Canvas เป็น Data URL
   */
  toDataURL(canvas) {
    return canvas.toDataURL('image/png');
  }

  /**
   * ดาวน์โหลดกระดาษคำตอบเป็นไฟล์ภาพ PNG
   */
  downloadPNG(canvas, filename = 'omr-compact-sheet.png') {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * คัดลอกภาพกระดาษคำตอบลงคลิปบอร์ด (เพื่อนำไปกด Ctrl+V ใน Microsoft Word ทันที)
   */
  async copyImageToClipboard(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error('ไม่สามารถแปลงรูปภาพได้'));
          return;
        }
        try {
          if (navigator.clipboard && navigator.clipboard.write) {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
            resolve(true);
          } else {
            reject(new Error('เบราว์เซอร์ไม่รองรับการคัดลอกรูปภาพอัตโนมัติ'));
          }
        } catch (err) {
          reject(err);
        }
      }, 'image/png');
    });
  }
}

window.SheetGenerator = SheetGenerator;
