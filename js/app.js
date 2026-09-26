/**
 * Main Application Controller (app.js)
 * จัดการ UI, การสลับแท็บ, การเปิดกล้อง, การบันทึกเฉลยหลายวิชา และการโชว์คะแนน
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. สร้าง Instance ของโมดูลต่างๆ
  const sheetGen = new SheetGenerator();
  const omrEngine = new OMREngine();
  const dataManager = new ExamDataManager();

  // 2. ตัวแปรสถานะของแอป (App State)
  let currentTab = 'sheet'; // 'sheet' | 'key' | 'scan' | 'settings'
  let activeExam = null; // ชุดเฉลยที่กำลังเลือกตรวจ
  let allExams = []; // รายการชุดเฉลยทั้งหมด
  let cameraStream = null;
  let isScanning = false;
  let scanAnimationId = null;
  let currentCameraFacing = 'environment'; // 'environment' (กล้องหลัง) หรือ 'user' (กล้องหน้า)
  let lastGradedTime = 0; // หน่วงเวลาการตรวจซ้ำ
  let stableFrameCount = 0; // นับเฟรมที่ตรวจจับจุดมาร์คได้นิ่งและเสถียร
  let generatedLayoutMeta = null;

  // Web Audio Context สำหรับเสียง Beep ตรวจเสร็จ
  let audioCtx = null;
  function playBeep(success = true) {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (success) {
        // เสียงแจ้งเตือนตรวจสำเร็จ (Ting!)
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.08); // A5
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.35);
      } else {
        // เสียงผิดพลาด
        osc.frequency.setValueAtTime(300, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.2);
      }
    } catch (e) {
      console.warn('Audio beep error', e);
    }
  }

  // Toast แจ้งเตือนข้อความ
  function showToast(message, type = 'info') {
    const toast = document.getElementById('toastNotification');
    if (!toast) return;

    const bgColors = {
      info: 'bg-indigo-600',
      success: 'bg-emerald-600',
      warning: 'bg-amber-600',
      error: 'bg-rose-600'
    };

    toast.className = `fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl text-white shadow-xl flex items-center space-x-3 transition-all duration-300 transform translate-y-0 ${bgColors[type] || bgColors.info}`;
    toast.innerHTML = `<span>${message}</span>`;
    toast.classList.remove('hidden');

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3200);
  }

  // --- 3. การจัดการแท็บและเมนู ---
  const navTabs = document.querySelectorAll('.nav-tab-btn');
  const tabContents = {
    sheet: document.getElementById('tab-sheet'),
    key: document.getElementById('tab-key'),
    scan: document.getElementById('tab-scan'),
    settings: document.getElementById('tab-settings')
  };

  function switchTab(targetTab) {
    currentTab = targetTab;
    navTabs.forEach(btn => {
      const tab = btn.dataset.tab;
      if (tab === targetTab) {
        btn.classList.add('border-indigo-600', 'text-indigo-600', 'font-semibold');
        btn.classList.remove('border-transparent', 'text-gray-500');
      } else {
        btn.classList.remove('border-indigo-600', 'text-indigo-600', 'font-semibold');
        btn.classList.add('border-transparent', 'text-gray-500');
      }
    });

    Object.keys(tabContents).forEach(tab => {
      if (tabContents[tab]) {
        if (tab === targetTab) {
          tabContents[tab].classList.remove('hidden');
        } else {
          tabContents[tab].classList.add('hidden');
        }
      }
    });

    // ถ้าออกจากแท็บตรวจ ให้หยุดกล้องเพื่อประหยัดแบตเตอรี่
    if (targetTab !== 'scan' && isScanning) {
      stopCamera();
    }

    if (targetTab === 'sheet') {
      renderAnswerSheetPreview();
    } else if (targetTab === 'key') {
      renderExamsList();
      renderKeyEditor();
    } else if (targetTab === 'scan') {
      updateActiveExamBadgeInScan();
    }
  }

  navTabs.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // --- 4. โหลดและจัดการข้อมูลชุดเฉลย (Exams Management) ---
  async function loadExamsData() {
    try {
      allExams = await dataManager.getAllExams();
      const activeId = dataManager.getActiveExamId();
      if (activeId) {
        activeExam = allExams.find(e => e.id === activeId) || allExams[0];
      } else if (allExams.length > 0) {
        activeExam = allExams[0];
      }

      updateGlobalExamSelector();
      updateFirebaseStatusBadge();
      renderExamsList();
      renderKeyEditor();
      updateActiveExamBadgeInScan();
    } catch (err) {
      console.warn('Error loading exams data:', err);
    }
  }

  function updateGlobalExamSelector() {
    const selector = document.getElementById('globalActiveExamSelect');
    if (!selector) return;

    selector.innerHTML = '';
    if (allExams.length === 0) {
      selector.innerHTML = '<option value="">ไม่มีชุดเฉลย</option>';
      return;
    }

    allExams.forEach(exam => {
      const opt = document.createElement('option');
      opt.value = exam.id;
      opt.textContent = `${exam.subjectName || 'ไม่ระบุชื่อวิชา'} (${exam.roomName || 'ทุกห้อง'}) - ${exam.totalQuestions} ข้อ`;
      if (activeExam && activeExam.id === exam.id) {
        opt.selected = true;
      }
      selector.appendChild(opt);
    });

    selector.onchange = (e) => {
      const selectedId = e.target.value;
      const found = allExams.find(x => x.id === selectedId);
      if (found) {
        activeExam = found;
        dataManager.setActiveExamId(found.id);
        renderKeyEditor();
        renderAnswerSheetPreview();
        updateActiveExamBadgeInScan();
        showToast(`เลือกตรวจวิชา: ${found.subjectName}`, 'info');
      }
    };
  }

  function updateFirebaseStatusBadge() {
    const badge = document.getElementById('firebaseStatusBadge');
    if (!badge) return;
    const status = dataManager.getStatus();
    if (status.isFirebase) {
      badge.className = 'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800';
      badge.innerHTML = '<span class="w-2 h-2 mr-1.5 bg-emerald-500 rounded-full animate-pulse"></span> Firebase Online';
    } else {
      badge.className = 'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800';
      badge.innerHTML = '<span class="w-2 h-2 mr-1.5 bg-amber-500 rounded-full"></span> Local Storage';
    }
  }

  // --- 5. แท็บที่ 1: สร้างกระดาษคำตอบ (Answer Sheet Generator) ---
  const sheetQuestionsInput = document.getElementById('sheetQuestions');
  const sheetColumnsInput = document.getElementById('sheetColumns');
  const sheetChoiceTypeInput = document.getElementById('sheetChoiceType');
  const sheetPreviewCanvas = document.getElementById('sheetPreviewCanvas');

  function renderAnswerSheetPreview() {
    if (!sheetPreviewCanvas) return;
    try {
      const qVal = sheetQuestionsInput ? sheetQuestionsInput.value : '10';
      const totalQuestions = parseInt(qVal, 10) || 10;
      const choiceType = sheetChoiceTypeInput ? sheetChoiceTypeInput.value : 'thai';
      const columns = sheetColumnsInput ? sheetColumnsInput.value : 'auto';

      const { canvas, layoutMeta } = sheetGen.generateSheet({
        totalQuestions,
        choiceType,
        columns
      });

      generatedLayoutMeta = layoutMeta;

      // แสดงผลบนพรีวิวแคนวาส
      sheetPreviewCanvas.width = canvas.width;
      sheetPreviewCanvas.height = canvas.height;
      const pCtx = sheetPreviewCanvas.getContext('2d');
      pCtx.drawImage(canvas, 0, 0);

      // เก็บอ้างอิง canvas สำหรับดาวน์โหลด
      sheetPreviewCanvas._fullCanvas = canvas;
    } catch (err) {
      console.error('Error rendering sheet preview:', err);
    }
  }

  // Event Listeners สำหรับการเปลี่ยนแปลงในฟอร์มกระดาษคำตอบ
  [sheetQuestionsInput, sheetColumnsInput, sheetChoiceTypeInput].forEach(elem => {
    if (elem) elem.addEventListener('input', renderAnswerSheetPreview);
  });

  // ปุ่มดึงข้อมูลจากวิชาที่เลือก
  const btnSyncWithExam = document.getElementById('btnSyncWithExam');
  if (btnSyncWithExam) {
    btnSyncWithExam.addEventListener('click', () => {
      if (activeExam) {
        sheetQuestionsInput.value = activeExam.totalQuestions;
        if (activeExam.choiceType) sheetChoiceTypeInput.value = activeExam.choiceType;
        renderAnswerSheetPreview();
        showToast(`ดึงข้อมูล ${activeExam.totalQuestions} ข้อ จากชุดเฉลยปัจจุบันแล้ว`, 'success');
      }
    });
  }

  // ปุ่มคัดลอกรูปภาพลงคลิปบอร์ด (เพื่อนำไปกด Ctrl+V ใน Microsoft Word ทันที)
  const btnCopySheet = document.getElementById('btnCopySheet');
  if (btnCopySheet) {
    btnCopySheet.addEventListener('click', async () => {
      if (!sheetPreviewCanvas || !sheetPreviewCanvas._fullCanvas) return;
      try {
        btnCopySheet.disabled = true;
        btnCopySheet.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> กำลังคัดลอก...`;
        
        await sheetGen.copyImageToClipboard(sheetPreviewCanvas._fullCanvas);
        showToast('คัดลอกรูปภาพแล้ว! คุณสามารถเปิด Microsoft Word แล้วกด Ctrl+V ได้เลย', 'success');
      } catch (err) {
        console.error(err);
        showToast('ไม่สามารถคัดลอกได้อัตโนมัติ กรุณากดดาวน์โหลดไฟล์ PNG แทน', 'warning');
      } finally {
        btnCopySheet.disabled = false;
        btnCopySheet.innerHTML = `<span>📋 คัดลอกภาพไปใส่ Word (Ctrl+V)</span>`;
      }
    });
  }

  // ปุ่มดาวน์โหลดไฟล์รูปภาพ PNG
  const btnDownloadSheet = document.getElementById('btnDownloadSheet');
  if (btnDownloadSheet) {
    btnDownloadSheet.addEventListener('click', () => {
      if (!sheetPreviewCanvas || !sheetPreviewCanvas._fullCanvas) return;
      const q = sheetQuestionsInput.value || '20';
      sheetGen.downloadPNG(sheetPreviewCanvas._fullCanvas, `กระดาษคำตอบ_${q}ข้อ_แบบกระชับ.png`);
      showToast('ดาวน์โหลดไฟล์กระดาษคำตอบ PNG เรียบร้อย', 'success');
    });
  }

  // ปุ่มสั่งพิมพ์กระดาษคำตอบ / บันทึกเป็น PDF
  const btnPrintSheet = document.getElementById('btnPrintSheet');
  if (btnPrintSheet) {
    btnPrintSheet.addEventListener('click', () => {
      if (!sheetPreviewCanvas || !sheetPreviewCanvas._fullCanvas) return;
      const dataUrl = sheetPreviewCanvas._fullCanvas.toDataURL('image/png');
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>พิมพ์กระดาษคำตอบ</title>
          <style>
            @page { size: A4 portrait; margin: 0; }
            body { margin: 0; padding: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
            img { width: 95%; max-height: 98vh; object-fit: contain; }
          </style>
        </head>
        <body>
          <img src="${dataUrl}" onload="window.print(); window.close();" />
        </body>
        </html>
      `);
      printWindow.document.close();
    });
  }

  // --- 6. แท็บที่ 2: จัดการเฉลยหลายวิชา (Answer Key Manager) ---
  const examsListContainer = document.getElementById('examsListContainer');
  const keyEditorForm = document.getElementById('keyEditorForm');
  const keyExamSubjectInput = document.getElementById('keyExamSubject');
  const keyExamRoomInput = document.getElementById('keyExamRoom');
  const keyExamQuestionsInput = document.getElementById('keyExamQuestions');
  const keyExamChoiceTypeInput = document.getElementById('keyExamChoiceType');
  const keyBubblesGrid = document.getElementById('keyBubblesGrid');
  const btnAddNewExam = document.getElementById('btnAddNewExam');
  const btnSaveKey = document.getElementById('btnSaveKey');
  const btnDeleteExam = document.getElementById('btnDeleteExam');
  const btnRandomKey = document.getElementById('btnRandomKey');
  const btnClearKey = document.getElementById('btnClearKey');

  // แสดงรายการวิชาทั้งหมดใน Sidebar/List
  function renderExamsList() {
    if (!examsListContainer) return;
    examsListContainer.innerHTML = '';

    if (allExams.length === 0) {
      examsListContainer.innerHTML = `<div class="p-4 text-center text-sm text-gray-500">ยังไม่มีชุดข้อสอบ คลิก "เพิ่มวิชาใหม่" เพื่อเริ่มต้น</div>`;
      return;
    }

    allExams.forEach(exam => {
      const isActive = activeExam && activeExam.id === exam.id;
      const card = document.createElement('div');
      card.className = `p-3 rounded-xl cursor-pointer border transition-all ${
        isActive 
          ? 'bg-indigo-50 border-indigo-400 ring-2 ring-indigo-200' 
          : 'bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50'
      }`;

      card.innerHTML = `
        <div class="flex items-center justify-between">
          <h4 class="font-medium text-gray-900 text-sm truncate">${exam.subjectName || 'ไม่ระบุวิชา'}</h4>
          <span class="text-xs px-2 py-0.5 rounded-full ${isActive ? 'bg-indigo-200 text-indigo-800' : 'bg-gray-100 text-gray-600'}">
            ${exam.totalQuestions} ข้อ
          </span>
        </div>
        <div class="mt-1 flex items-center justify-between text-xs text-gray-500">
          <span>ห้อง: ${exam.roomName || 'ทั้งหมด'}</span>
          <span>${exam.updatedAt ? new Date(exam.updatedAt).toLocaleDateString('th-TH') : ''}</span>
        </div>
      `;

      card.onclick = () => {
        activeExam = exam;
        dataManager.setActiveExamId(exam.id);
        updateGlobalExamSelector();
        renderExamsList();
        renderKeyEditor();
        updateActiveExamBadgeInScan();
      };

      examsListContainer.appendChild(card);
    });
  }

  // วาดหน้าจอแก้ไขเฉลย (Key Editor)
  function renderKeyEditor() {
    if (!keyEditorForm || !activeExam) return;

    keyExamSubjectInput.value = activeExam.subjectName || '';
    keyExamRoomInput.value = activeExam.roomName || '';
    keyExamQuestionsInput.value = activeExam.totalQuestions || 20;
    keyExamChoiceTypeInput.value = activeExam.choiceType || 'thai';

    renderKeyBubbles();
  }

  function renderKeyBubbles() {
    if (!keyBubblesGrid || !activeExam) return;
    keyBubblesGrid.innerHTML = '';

    const total = parseInt(keyExamQuestionsInput.value, 10) || 20;
    const choiceType = keyExamChoiceTypeInput.value || 'thai';
    let labels = ['ก', 'ข', 'ค', 'ง'];
    if (choiceType === 'num') labels = ['1', '2', '3', '4'];
    if (choiceType === 'eng') labels = ['A', 'B', 'C', 'D'];

    if (!activeExam.answers) activeExam.answers = {};

    for (let q = 1; q <= total; q++) {
      const selectedChoice = activeExam.answers[q] !== undefined ? activeExam.answers[q] : null;

      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-2.5 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors';

      const qLabel = document.createElement('span');
      qLabel.className = 'w-12 font-semibold text-gray-700 text-sm';
      qLabel.textContent = `ข้อ ${q}.`;
      row.appendChild(qLabel);

      const choicesContainer = document.createElement('div');
      choicesContainer.className = 'flex space-x-2 flex-1 justify-end';

      for (let ch = 0; ch < 4; ch++) {
        const isChecked = selectedChoice === ch;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `w-9 h-9 rounded-full font-medium text-sm flex items-center justify-center transition-all ${
          isChecked
            ? 'bg-indigo-600 text-white shadow-md scale-105 ring-2 ring-indigo-300'
            : 'bg-white text-gray-700 border border-gray-300 hover:border-indigo-400 hover:bg-indigo-50'
        }`;
        btn.textContent = labels[ch];

        btn.onclick = () => {
          activeExam.answers[q] = ch;
          renderKeyBubbles();
        };

        choicesContainer.appendChild(btn);
      }

      row.appendChild(choicesContainer);
      keyBubblesGrid.appendChild(row);
    }
  }

  if (keyExamQuestionsInput) {
    keyExamQuestionsInput.addEventListener('change', () => {
      if (activeExam) {
        activeExam.totalQuestions = parseInt(keyExamQuestionsInput.value, 10) || 20;
        renderKeyBubbles();
      }
    });
  }

  if (keyExamChoiceTypeInput) {
    keyExamChoiceTypeInput.addEventListener('change', () => {
      if (activeExam) {
        activeExam.choiceType = keyExamChoiceTypeInput.value;
        renderKeyBubbles();
      }
    });
  }

  // ปุ่มสร้างชุดเฉลยใหม่
  if (btnAddNewExam) {
    btnAddNewExam.addEventListener('click', () => {
      const newExam = {
        id: 'exam_' + Date.now(),
        subjectName: 'วิชาใหม่',
        roomName: 'ห้อง 1',
        totalQuestions: 20,
        choiceType: 'thai',
        answers: {},
        updatedAt: new Date().toISOString()
      };
      // กำหนดค่าเริ่มต้นข้อ 1-20
      for (let i = 1; i <= 20; i++) {
        newExam.answers[i] = (i - 1) % 4;
      }
      allExams.unshift(newExam);
      activeExam = newExam;
      dataManager.setActiveExamId(newExam.id);
      renderExamsList();
      renderKeyEditor();
      updateGlobalExamSelector();
      showToast('สร้างชุดเฉลยใหม่แล้ว สามารถแก้ไขและกดบันทึกได้', 'success');
    });
  }

  // ปุ่มบันทึกเฉลย
  if (btnSaveKey) {
    btnSaveKey.addEventListener('click', async () => {
      if (!activeExam) return;

      activeExam.subjectName = keyExamSubjectInput.value.trim() || 'ไม่ระบุวิชา';
      activeExam.roomName = keyExamRoomInput.value.trim() || '';
      activeExam.totalQuestions = parseInt(keyExamQuestionsInput.value, 10) || 20;
      activeExam.choiceType = keyExamChoiceTypeInput.value || 'thai';

      btnSaveKey.disabled = true;
      btnSaveKey.innerHTML = 'กำลังบันทึก...';

      try {
        await dataManager.saveExam(activeExam);
        await loadExamsData();
        showToast(`บันทึกชุดเฉลย "${activeExam.subjectName}" เรียบร้อยแล้ว`, 'success');
      } catch (err) {
        console.error(err);
        showToast('เกิดข้อผิดพลาดในการบันทึก', 'error');
      } finally {
        btnSaveKey.disabled = false;
        btnSaveKey.innerHTML = '💾 บันทึกชุดเฉลย';
      }
    });
  }

  // ปุ่มลบชุดเฉลย
  if (btnDeleteExam) {
    btnDeleteExam.addEventListener('click', async () => {
      if (!activeExam) return;
      if (allExams.length <= 1) {
        showToast('ต้องมีชุดเฉลยอย่างน้อย 1 ชุด ไม่สามารถลบทั้งหมดได้', 'warning');
        return;
      }

      if (confirm(`คุณต้องการลบชุดเฉลย "${activeExam.subjectName}" หรือไม่?`)) {
        await dataManager.deleteExam(activeExam.id);
        showToast('ลบชุดเฉลยเรียบร้อย', 'info');
        await loadExamsData();
      }
    });
  }

  // สุ่มคำตอบสำหรับทดสอบ
  if (btnRandomKey) {
    btnRandomKey.addEventListener('click', () => {
      if (!activeExam) return;
      const total = parseInt(keyExamQuestionsInput.value, 10) || 20;
      activeExam.answers = {};
      for (let i = 1; i <= total; i++) {
        activeExam.answers[i] = Math.floor(Math.random() * 4);
      }
      renderKeyBubbles();
      showToast('สุ่มคำตอบเฉลยเรียบร้อย', 'info');
    });
  }

  // ล้างคำตอบทั้งหมด
  if (btnClearKey) {
    btnClearKey.addEventListener('click', () => {
      if (!activeExam) return;
      activeExam.answers = {};
      renderKeyBubbles();
      showToast('ล้างคำตอบเฉลยทั้งหมดแล้ว', 'info');
    });
  }

  // --- 7. แท็บที่ 3: กล้องตรวจข้อสอบ & แสดงคะแนนทันที (Real-time OMR Scanner) ---
  const videoElem = document.getElementById('cameraVideo');
  const overlayCanvas = document.getElementById('cameraOverlay');
  const btnCaptureScan = document.getElementById('btnCaptureScan');
  const btnToggleCamera = document.getElementById('btnToggleCamera');
  const btnSwitchCamera = document.getElementById('btnSwitchCamera');
  const btnSimulateScan = document.getElementById('btnSimulateScan');
  const fileUploadInput = document.getElementById('fileUploadInput');
  const scanStatusText = document.getElementById('scanStatusText');
  const scanStatusIndicator = document.getElementById('scanStatusIndicator');
  const scanExamBadge = document.getElementById('scanActiveExamBadge');

  // Score HUD Elements (Non-blocking & No answer key disclosure)
  const scoreResultCard = document.getElementById('scoreResultCard');
  const scoreBigNumber = document.getElementById('scoreBigNumber');
  const scoreTotalQuestions = document.getElementById('scoreTotalQuestions');
  const scorePercentBadge = document.getElementById('scorePercentBadge');
  const scoreCorrectCount = document.getElementById('scoreCorrectCount');
  const scoreWrongCount = document.getElementById('scoreWrongCount');
  const scoreBlankBadge = document.getElementById('scoreBlankBadge');
  const scoreBlankCount = document.getElementById('scoreBlankCount');
  const scoreWrongQuestionsSection = document.getElementById('scoreWrongQuestionsSection');
  const scoreWrongQuestionsList = document.getElementById('scoreWrongQuestionsList');
  const cameraScoreBadge = document.getElementById('cameraScoreBadge');
  const miniScoreValue = document.getElementById('miniScoreValue');
  const snapshotCanvas = document.getElementById('snapshotCanvas');
  const snapshotPlaceholder = document.getElementById('snapshotPlaceholder');
  const freezeStatusBadge = document.getElementById('freezeStatusBadge');
  const btnNextSheet = document.getElementById('btnNextSheet');
  const btnNextSheetSide = document.getElementById('btnNextSheetSide');
  const scanGuideBox = document.getElementById('scanGuideBox');

  // สถานะการตรึงผลคะแนนและภาพนิ่ง (Freeze-Frame & Latch State)
  let isLatched = false;
  let emptyFramesCount = 0;
  let smoothedCorners = null;
  let cornerLossFrames = 0;

  function updateActiveExamBadgeInScan() {
    if (!scanExamBadge) return;
    if (activeExam) {
      scanExamBadge.textContent = `${activeExam.subjectName || 'วิชา'} (${activeExam.roomName || 'ห้อง'}) - ${activeExam.totalQuestions} ข้อ`;
    } else {
      scanExamBadge.textContent = 'ยังไม่ได้เลือกวิชา';
    }
  }

  async function startCamera() {
    try {
      if (cameraStream) {
        stopCamera();
      }

      scanStatusText.innerHTML = '<span class="text-amber-500">กำลังขอสิทธิ์เปิดกล้อง...</span>';

      const constraints = {
        video: {
          facingMode: currentCameraFacing,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElem.srcObject = cameraStream;
      await videoElem.play();

      isScanning = true;
      btnToggleCamera.innerHTML = `<span>⏹️ ปิดกล้อง</span>`;
      btnToggleCamera.classList.replace('bg-indigo-600', 'bg-rose-600');
      btnToggleCamera.classList.replace('hover:bg-indigo-700', 'hover:bg-rose-700');
      scanStatusText.innerHTML = '<span class="text-emerald-500 animate-pulse">● กำลังตรวจจับจุดมาร์ค 4 มุม... ส่องให้เห็นกระดาษชัดเจน</span>';

      runCameraScanLoop();
    } catch (err) {
      console.error('Camera access error:', err);
      scanStatusText.innerHTML = `<span class="text-rose-500">ไม่สามารถเปิดกล้องได้: ${err.message || 'กรุณาอนุญาตให้เข้าถึงกล้อง'}</span>`;
      showToast('ไม่สามารถเปิดกล้องได้ หรืออุปกรณ์ไม่รองรับ', 'error');
    }
  }

  function stopCamera() {
    isScanning = false;
    if (scanAnimationId) {
      cancelAnimationFrame(scanAnimationId);
      scanAnimationId = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
    }
    if (videoElem) {
      videoElem.srcObject = null;
    }
    btnToggleCamera.innerHTML = `<span>📷 เปิดกล้องตรวจ</span>`;
    btnToggleCamera.classList.replace('bg-rose-600', 'bg-indigo-600');
    btnToggleCamera.classList.replace('hover:bg-rose-700', 'hover:bg-indigo-700');
    scanStatusText.innerHTML = '<span class="text-gray-400">กล้องปิดอยู่ กดปุ่มเปิดกล้องเพื่อเริ่มสแกน</span>';

    // ล้างเส้น Overlay และ Badge บนกล้อง
    smoothedCorners = null;
    cornerLossFrames = 0;
    if (scanGuideBox) {
      scanGuideBox.style.opacity = '1.0';
    }
    if (overlayCanvas) {
      const ctx = overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
    if (cameraScoreBadge) {
      cameraScoreBadge.classList.add('hidden');
    }
  }

  if (btnToggleCamera) {
    btnToggleCamera.addEventListener('click', () => {
      if (isScanning) {
        stopCamera();
      } else {
        startCamera();
      }
    });
  }

  if (btnSwitchCamera) {
    btnSwitchCamera.addEventListener('click', () => {
      currentCameraFacing = (currentCameraFacing === 'environment' ? 'user' : 'environment');
      if (isScanning) {
        startCamera();
      }
    });
  }

  // ฟังก์ชันบันทึกภาพนิ่งและตรึงผลคะแนน (Freeze-Frame Snapshot & Score Latch)
  function handleGradeSuccess(result, sourceElement) {
    isLatched = true;
    lastGradedTime = Date.now();
    emptyFramesCount = 0;

    playBeep(true);
    displayScoreResult(result, false);

    // วาดภาพนิ่งลงใน Snapshot Canvas ด้านขวา (ตรึงภาพไว้ข้างๆ ไม่เด้งหาย)
    if (snapshotCanvas) {
      if (result.warpedCanvas) {
        snapshotCanvas.width = result.warpedCanvas.width;
        snapshotCanvas.height = result.warpedCanvas.height;
        const sCtx = snapshotCanvas.getContext('2d');
        sCtx.drawImage(result.warpedCanvas, 0, 0);
      } else if (sourceElement) {
        const sw = sourceElement.videoWidth || sourceElement.naturalWidth || sourceElement.width || 600;
        const sh = sourceElement.videoHeight || sourceElement.naturalHeight || sourceElement.height || 800;
        snapshotCanvas.width = sw;
        snapshotCanvas.height = sh;
        const sCtx = snapshotCanvas.getContext('2d');
        sCtx.drawImage(sourceElement, 0, 0, sw, sh);
      }

      snapshotCanvas.classList.remove('hidden');
      if (snapshotPlaceholder) snapshotPlaceholder.classList.add('hidden');
    }

    if (freezeStatusBadge) {
      freezeStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 animate-pulse';
      freezeStatusBadge.innerHTML = '🔒 ตรึงคะแนนแล้ว (จดคะแนนได้เลย)';
    }

    if (scanStatusIndicator) {
      scanStatusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
    }

    scanStatusText.innerHTML = `<span class="text-emerald-400 font-bold">✓ ตรวจสำเร็จ ${result.score}/${result.total} คะแนน (ภาพและคะแนนถูกตรึงไว้ข้างๆ แล้ว)</span>`;
    showToast(`ตรวจสำเร็จ! ได้ ${result.score}/${result.total} คะแนน`, 'success');
  }

  // ฟังก์ชันปลดล็อกพร้อมตรวจแผ่นถัดไป
  function unlockNextSheet(showMessage = true) {
    isLatched = false;
    emptyFramesCount = 0;
    stableFrameCount = 0;
    smoothedCorners = null;
    cornerLossFrames = 0;

    if (scanGuideBox) {
      scanGuideBox.style.opacity = '1.0';
    }

    if (overlayCanvas) {
      const ctx = overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    if (freezeStatusBadge) {
      freezeStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800';
      freezeStatusBadge.innerHTML = 'พร้อมตรวจแผ่นใหม่...';
    }

    if (scanStatusIndicator) {
      scanStatusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
    }

    scanStatusText.innerHTML = '<span class="text-emerald-400 font-medium animate-pulse">🟢 พร้อมตรวจแผ่นถัดไป ส่องกระดาษแผ่นใหม่ให้อยู่ในกรอบ</span>';
    if (showMessage) {
      showToast('พร้อมตรวจแผ่นถัดไปแล้ว', 'info');
    }
  }

  // ปุ่มตรวจแผ่นถัดไป
  if (btnNextSheet) {
    btnNextSheet.addEventListener('click', () => unlockNextSheet(true));
  }
  if (btnNextSheetSide) {
    btnNextSheetSide.addEventListener('click', () => unlockNextSheet(true));
  }

  // ปุ่มกดถ่ายรูปเพื่อตรวจคะแนนทันที (Manual Snapshot & Instant Grading)
  if (btnCaptureScan) {
    btnCaptureScan.addEventListener('click', () => {
      if (!isScanning || !videoElem || videoElem.readyState < 2) {
        showToast('กรุณากดเปิดกล้องก่อนถ่ายตรวจ', 'warning');
        return;
      }

      if (!activeExam) {
        showToast('กรุณาเลือกวิชาที่ต้องการตรวจก่อน', 'warning');
        return;
      }

      if (!generatedLayoutMeta || generatedLayoutMeta.totalQuestions !== activeExam.totalQuestions) {
        const { layoutMeta } = sheetGen.generateSheet({
          totalQuestions: activeExam.totalQuestions,
          choiceType: activeExam.choiceType || 'thai'
        });
        generatedLayoutMeta = layoutMeta;
      }

      scanStatusText.innerHTML = '<span class="text-emerald-400 font-bold animate-pulse">📸 กำลังถ่ายภาพและประมวลผลคำตอบ...</span>';

      // สร้าง Canvas จับภาพนิ่งจากกล้องทันที
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = videoElem.videoWidth;
      snapCanvas.height = videoElem.videoHeight;
      const snapCtx = snapCanvas.getContext('2d');
      snapCtx.drawImage(videoElem, 0, 0, snapCanvas.width, snapCanvas.height);

      const result = omrEngine.processFrame(snapCanvas, activeExam, generatedLayoutMeta);

      if (result.success) {
        if (overlayCanvas && result.corners) {
          const ctx = overlayCanvas.getContext('2d');
          ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
          drawDetectedCorners(ctx, result.corners);
          flashSuccessOverlay(ctx, result.corners);
        }
        handleGradeSuccess(result, snapCanvas);
      } else {
        playBeep(false);
        scanStatusText.innerHTML = `<span class="text-rose-400 font-medium">❌ ${result.error || 'ไม่พบกระดาษคำตอบ กรุณาส่องให้เห็นจุดมาร์คสี่เหลี่ยมดำ 4 มุมครบ'}</span>`;
        showToast(result.error || 'ไม่พบกระดาษคำตอบ กรุณาส่องให้เห็นครบ 4 มุม', 'error');
      }
    });
  }

  // ซิงค์ตำแหน่งและขนาด Canvas ให้ทับบนพื้นที่แสดงผลของ Video แบบ 1:1 พิกเซล ไม่เหลื่อม ไม่บวม
  function updateOverlayPosition() {
    if (!videoElem || !overlayCanvas) return;
    const vw = videoElem.clientWidth;
    const vh = videoElem.clientHeight;
    const vx = videoElem.offsetLeft;
    const vy = videoElem.offsetTop;

    if (vw > 0 && vh > 0) {
      overlayCanvas.style.width = vw + 'px';
      overlayCanvas.style.height = vh + 'px';
      overlayCanvas.style.left = vx + 'px';
      overlayCanvas.style.top = vy + 'px';
    }

    if (videoElem.videoWidth > 0 && (overlayCanvas.width !== videoElem.videoWidth || overlayCanvas.height !== videoElem.videoHeight)) {
      overlayCanvas.width = videoElem.videoWidth;
      overlayCanvas.height = videoElem.videoHeight;
    }
  }

  // ลูปประมวลผลกล้องแบบเรียลไทม์
  function runCameraScanLoop() {
    if (!isScanning || !videoElem || videoElem.readyState < 2) {
      if (isScanning) {
        scanAnimationId = requestAnimationFrame(runCameraScanLoop);
      }
      return;
    }

    // ซิงค์ตำแหน่ง Canvas กับ Video ให้ตรงกันเป๊ะแบบ 1:1 พิกเซล
    updateOverlayPosition();

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // ตรวจสอบโครงร่างกระดาษคำตอบ layout
    if (!generatedLayoutMeta || generatedLayoutMeta.totalQuestions !== activeExam.totalQuestions) {
      const { layoutMeta } = sheetGen.generateSheet({
        totalQuestions: activeExam.totalQuestions,
        choiceType: activeExam.choiceType || 'thai'
      });
      generatedLayoutMeta = layoutMeta;
    }

    const now = Date.now();

    // 0. ถ้าผลคะแนนและภาพนิ่งกำลังถูกตรึงอยู่ (isLatched === true)
    if (isLatched) {
      // ตรวจจับว่ายกกระดาษแผ่นเก่าออกไปแล้วหรือยัง
      const detection = omrEngine.detectCorners(videoElem);
      const corners = detection ? detection.corners : null;

      if (!corners) {
        emptyFramesCount++;
        // ถ้าไม่พบกระดาษติดต่อกันเกิน 16 เฟรม (~0.5 วินาที) แปลว่าครูยกกระดาษแผ่นเดิมออกแล้ว
        if (emptyFramesCount > 16) {
          isLatched = false;
          emptyFramesCount = 0;
          stableFrameCount = 0;
          smoothedCorners = null;

          if (scanGuideBox) scanGuideBox.style.opacity = '1.0';

          if (freezeStatusBadge) {
            freezeStatusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800';
            freezeStatusBadge.innerHTML = 'พร้อมตรวจแผ่นใหม่...';
          }
          scanStatusText.innerHTML = '<span class="text-amber-300 font-medium">🟡 นำแผ่นเก่าออกแล้ว วางกระดาษแผ่นใหม่เพื่อตรวจต่อได้เลย</span>';
        }
      } else {
        emptyFramesCount = 0;
        // ยังเป็นกระดาษแผ่นเดิม ให้วาดกรอบเขียวนิ่งๆ ไว้ ไม่คำนวณคะแนนซ้ำ ไม่กระพริบ
        if (smoothedCorners) {
          drawDetectedCorners(ctx, smoothedCorners);
        } else {
          drawDetectedCorners(ctx, corners);
        }
      }

      scanAnimationId = requestAnimationFrame(runCameraScanLoop);
      return;
    }

    // 1. ตรวจจับจุดมาร์คและรูปทรงกระดาษแบบเรียลไทม์
    const detection = omrEngine.detectCorners(videoElem);
    const rawCorners = detection ? detection.corners : null;
    const candidates = detection ? detection.candidates : [];

    let activeCorners = null;

    if (rawCorners && omrEngine.isValidQuadGeometry(rawCorners, overlayCanvas.width, overlayCanvas.height)) {
      cornerLossFrames = 0;

      // กรองการสั่นไหวของมือด้วย Deadband + Exponential Moving Average (EMA)
      // ช่วยให้เส้นกรอบสีเขียวนิ่งสนิท ไม่สั่น ไม่กระตุก และไม่หมุนวน
      if (!smoothedCorners) {
        smoothedCorners = rawCorners.map(p => ({ x: p.x, y: p.y }));
      } else {
        for (let i = 0; i < 4; i++) {
          const dx = rawCorners[i].x - smoothedCorners[i].x;
          const dy = rawCorners[i].y - smoothedCorners[i].y;
          const dist = Math.hypot(dx, dy);

          // Deadband Filter: ถือกล้องนิ่งหรือสั่นน้อยกว่า 4px ให้ตรึงนิ่ง 100% ไม่สั่นไหว
          if (dist >= 4) {
            const alpha = dist > 60 ? 0.70 : 0.35;
            smoothedCorners[i].x += dx * alpha;
            smoothedCorners[i].y += dy * alpha;
          }
        }
      }

      activeCorners = smoothedCorners;

      // หรี่ไกด์กรอบเล็งด้านหลัง เพื่อให้เห็นเส้นสีเขียวที่ลากเชื่อมจุดมาร์คจริงชัดเจน
      if (scanGuideBox) scanGuideBox.style.opacity = '0.15';

      // วาดกรอบสีเขียวลากเชื่อมจุดมาร์คทั้ง 4 แบบนิ่งสนิท
      drawDetectedCorners(ctx, activeCorners);
      stableFrameCount++;

      if (scanStatusIndicator) {
        scanStatusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
      }

      if (stableFrameCount < 3) {
        scanStatusText.innerHTML = '<span class="text-amber-300 font-medium">🟡 ล็อกจุดมาร์คได้แล้ว... ถือกล้องให้นิ่ง</span>';
      } else {
        // เมื่อตรวจจับได้นิ่งต่อเนื่องอย่างน้อย 3 เฟรม และพ้นระยะหน่วงเวลาตรวจซ้ำ (1.5 วินาที)
        if (now - lastGradedTime > 1500) {
          scanStatusText.innerHTML = '<span class="text-emerald-400 font-bold animate-pulse">🟢 ล็อกจุดมาร์คครบ 4 มุมแล้ว กำลังตรวจ...</span>';
          const result = omrEngine.processFrame(videoElem, activeExam, generatedLayoutMeta);

          if (result.success) {
            flashSuccessOverlay(ctx, activeCorners);
            handleGradeSuccess(result, videoElem);
            stableFrameCount = 0;
          } else {
            scanStatusText.innerHTML = `<span class="text-amber-300">${result.error || 'กรุณาถือกล้องให้นิ่งและขยับให้พอดีกรอบ'}</span>`;
          }
        } else {
          scanStatusText.innerHTML = '<span class="text-emerald-400 font-bold">🟢 ตรวจเรียบร้อย (ส่องแผ่นต่อไปเพื่อตรวจได้ทันที)</span>';
        }
      }
    } else {
      cornerLossFrames++;
      // คงกรอบเขียวเดิมไว้สั้นๆ 5 เฟรม (~80ms) ป้องกันการกระพริบหายวูบวาบจาก Auto Focus
      if (cornerLossFrames <= 5 && smoothedCorners) {
        drawDetectedCorners(ctx, smoothedCorners);
      } else {
        smoothedCorners = null;
        if (scanGuideBox) scanGuideBox.style.opacity = '1.0';

        if (candidates && candidates.length > 0) {
          stableFrameCount = 0;
          drawPartialCorners(ctx, candidates);

          if (scanStatusIndicator) {
            scanStatusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse';
          }
          scanStatusText.innerHTML = `<span class="text-amber-300 font-medium">🟡 พบจุดมาร์ค ${candidates.length}/4 จุด (กรุณาถอยกล้องออกเล็กน้อยให้เห็นครบ 4 มุม)</span>`;
        } else {
          stableFrameCount = 0;

          if (scanStatusIndicator) {
            scanStatusIndicator.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
          }
          if (now - lastGradedTime > 2500) {
            scanStatusText.innerHTML = '<span class="text-slate-300">📷 ส่องกล้องให้เห็นจุดมาร์คสี่เหลี่ยมดำ 4 มุมของกระดาษคำตอบ</span>';
          }
        }
      }
    }

    scanAnimationId = requestAnimationFrame(runCameraScanLoop);
  }

  function flashSuccessOverlay(ctx, corners) {
    ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.fill();
  }

  // วาดเส้นสีเขียวลากเชื่อมจากจุดมาร์คหนึ่งไปจุดมาร์คหนึ่งอย่างนิ่งสนิทและแม่นยำ
  function drawDetectedCorners(ctx, corners) {
    if (!corners || corners.length !== 4) return;

    // 1. ไฮไลท์พื้นที่แผ่นกระดาษด้วยสีเขียวมรกตโปร่งแสง
    ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.fill();

    // 2. ลากเส้นตรงเชื่อมระหว่างจุดมาร์คทั้ง 4 มุมแบบนิ่งสนิท:
    // จุด 1 (บนซ้าย) ➔ จุด 2 (บนขวา) ➔ จุด 3 (ล่างขวา) ➔ จุด 4 (ล่างซ้าย) ➔ จุด 1
    ctx.strokeStyle = '#10B981'; // เขียวสดใส
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.stroke();

    // 3. วาดเป้าเล็งและตัวเลขประจำแต่ละมุม (1, 2, 3, 4) วางทับจุดมาร์คจริงตรงเป๊ะ
    corners.forEach((c, idx) => {
      // วงแหวนสีขาวรอบนอก
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
      ctx.stroke();

      // วงกลมสีเขียวสด
      ctx.fillStyle = '#10B981';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
      ctx.fill();

      // หมายเลขมุม (1: บนซ้าย, 2: บนขวา, 3: ล่างขวา, 4: ล่างซ้าย)
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${idx + 1}`, c.x, c.y + 0.5);
    });
  }

  function drawPartialCorners(ctx, candidates) {
    candidates.forEach(c => {
      // วงแหวนแจ้งเตือนรอบจุดมาร์คที่พบ
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // แสดงผลคะแนนทันที (ไม่บังกล้อง 100% และบอกแค่ ถูก/ผิด ไม่บอกเฉลย ก ข ค ง)
  function displayScoreResult(result, isSimulation = false) {
    if (scoreBigNumber) scoreBigNumber.textContent = result.score;
    if (scoreTotalQuestions) scoreTotalQuestions.textContent = `/ ${result.total}`;

    if (scorePercentBadge) {
      const modeText = isSimulation ? ' • กระดาษจำลอง' : '';
      scorePercentBadge.textContent = `${result.percentage}%${modeText}`;
      if (isSimulation) {
        scorePercentBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-violet-100 text-violet-800';
      } else if (result.percentage >= 80) {
        scorePercentBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
      } else if (result.percentage >= 50) {
        scorePercentBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800';
      } else {
        scorePercentBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-800';
      }
    }

    const correctCount = result.answers.filter(a => a.isCorrect).length;
    const wrongAnswers = result.answers.filter(a => !a.isCorrect && !a.isBlank);
    const wrongCount = wrongAnswers.length;
    const blankAnswers = result.answers.filter(a => a.isBlank);
    const blankCount = blankAnswers.length;

    if (scoreCorrectCount) scoreCorrectCount.textContent = correctCount;
    if (scoreWrongCount) scoreWrongCount.textContent = wrongCount;

    if (scoreBlankBadge && scoreBlankCount) {
      if (blankCount > 0) {
        scoreBlankBadge.classList.remove('hidden');
        scoreBlankBadge.classList.add('inline-flex');
        scoreBlankCount.textContent = blankCount;
      } else {
        scoreBlankBadge.classList.add('hidden');
        scoreBlankBadge.classList.remove('inline-flex');
      }
    }

    // สรุปเฉพาะข้อที่ผิด โดย "ไม่บอกเฉลยคำตอบ ก ข ค ง" ตามที่ผู้ใช้ต้องการ
    if (scoreWrongQuestionsSection) {
      const allWrongNumbers = result.answers
        .filter(a => !a.isCorrect)
        .map(a => a.questionNumber);

      if (allWrongNumbers.length === 0) {
        scoreWrongQuestionsSection.innerHTML = '<span class="text-emerald-600 font-bold">🎉 ยอดเยี่ยม! ตอบถูกทุกข้อ</span>';
      } else {
        scoreWrongQuestionsSection.innerHTML = `
          <span class="text-slate-500 font-medium">ข้อที่ผิด:</span>
          <span class="font-bold text-rose-600">${allWrongNumbers.map(n => `ข้อ ${n}`).join(', ')}</span>
        `;
      }
    }

    // อัปเดต Mini Badge ที่มุมกล้อง (ขนาดกะทัดรัด ไม่บังกระดาษ)
    if (cameraScoreBadge && miniScoreValue) {
      miniScoreValue.textContent = `${result.score}/${result.total}`;
      cameraScoreBadge.classList.remove('hidden');
      clearTimeout(cameraScoreBadge.timer);
      cameraScoreBadge.timer = setTimeout(() => {
        cameraScoreBadge.classList.add('hidden');
      }, 3000);
    }

    // แสดงการ์ดผลคะแนนด้านล่างกล้อง
    if (scoreResultCard) {
      scoreResultCard.classList.remove('hidden');
    }
  }

  // ฟังก์ชันตรวจผ่านรูปภาพที่อัปโหลด (Upload Photo Option)
  if (fileUploadInput) {
    fileUploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          if (!generatedLayoutMeta || generatedLayoutMeta.totalQuestions !== activeExam.totalQuestions) {
            const { layoutMeta } = sheetGen.generateSheet({
              totalQuestions: activeExam.totalQuestions,
              choiceType: activeExam.choiceType || 'thai'
            });
            generatedLayoutMeta = layoutMeta;
          }

          const result = omrEngine.processFrame(img, activeExam, generatedLayoutMeta);
          if (result.success) {
            playBeep(true);
            displayScoreResult(result);
            showToast('ตรวจรูปภาพสำเร็จ!', 'success');
          } else {
            playBeep(false);
            showToast(result.error || 'ไม่พบจุดมาร์คทั้ง 4 มุมในภาพ กรุณาถ่ายให้เห็นมุมทั้ง 4 ชัดเจน', 'error');
          }
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ปุ่มทดสอบตรวจกระดาษจำลอง (Simulator Instant Test)
  if (btnSimulateScan) {
    btnSimulateScan.addEventListener('click', () => {
      if (!activeExam) return;

      if (!generatedLayoutMeta || generatedLayoutMeta.totalQuestions !== activeExam.totalQuestions) {
        const { layoutMeta } = sheetGen.generateSheet({
          totalQuestions: activeExam.totalQuestions,
          choiceType: activeExam.choiceType || 'thai'
        });
        generatedLayoutMeta = layoutMeta;
      }

      // สร้างภาพกระดาษจำลองที่มีรอยฝน
      const simCanvas = omrEngine.generateSimulatedFilledSheet(generatedLayoutMeta, activeExam, 85);

      // นำไปประมวลผลผ่าน OMR Engine
      const result = omrEngine.processFrame(simCanvas, activeExam, generatedLayoutMeta);
      if (result.success) {
        playBeep(true);
        displayScoreResult(result, true);
        showToast('ทดสอบตรวจกระดาษจำลองสำเร็จ (โหมดจำลอง)', 'info');
      } else {
        showToast('การจำลองล้มเหลว: ' + result.error, 'error');
      }
    });
  }

  // --- 8. แท็บที่ 4: ตั้งค่า Firebase (Firebase Settings) ---
  const fbApiKey = document.getElementById('fbApiKey');
  const fbProjectId = document.getElementById('fbProjectId');
  const fbAuthDomain = document.getElementById('fbAuthDomain');
  const fbStorageBucket = document.getElementById('fbStorageBucket');
  const fbAppId = document.getElementById('fbAppId');
  const btnSaveFirebaseConfig = document.getElementById('btnSaveFirebaseConfig');
  const btnResetFirebaseConfig = document.getElementById('btnResetFirebaseConfig');

  function loadFirebaseConfigForm() {
    const config = dataManager.getFirebaseConfig();
    if (fbApiKey) fbApiKey.value = config.apiKey || '';
    if (fbProjectId) fbProjectId.value = config.projectId || '';
    if (fbAuthDomain) fbAuthDomain.value = config.authDomain || '';
    if (fbStorageBucket) fbStorageBucket.value = config.storageBucket || '';
    if (fbAppId) fbAppId.value = config.appId || '';
  }

  if (btnSaveFirebaseConfig) {
    btnSaveFirebaseConfig.addEventListener('click', () => {
      const config = {
        apiKey: fbApiKey.value.trim(),
        projectId: fbProjectId.value.trim(),
        authDomain: fbAuthDomain.value.trim() || `${fbProjectId.value.trim()}.firebaseapp.com`,
        storageBucket: fbStorageBucket.value.trim() || `${fbProjectId.value.trim()}.appspot.com`,
        appId: fbAppId.value.trim()
      };

      const success = dataManager.saveFirebaseConfig(config);
      updateFirebaseStatusBadge();

      if (success) {
        showToast('บันทึกและเชื่อมต่อ Firebase Firestore สำเร็จ!', 'success');
      } else {
        showToast('บันทึกการตั้งค่าแล้ว (จะเชื่อมต่อเมื่อใส่ข้อมูล Firebase ครบถ้วน)', 'info');
      }
      loadExamsData();
    });
  }

  if (btnResetFirebaseConfig) {
    btnResetFirebaseConfig.addEventListener('click', () => {
      if (confirm('คุณต้องการรีเซ็ตการตั้งค่า Firebase กลับเป็นค่าเริ่มต้นหรือไม่?')) {
        localStorage.removeItem(dataManager.configKey);
        loadFirebaseConfigForm();
        updateFirebaseStatusBadge();
        showToast('รีเซ็ตการตั้งค่าเรียบร้อย (ทำงานในโหมด Local Storage)', 'info');
      }
    });
  }

  // 9. เริ่มต้นทำงาน (Initialize App ทันทีแบบ Synchronous ไม่ต้องรอ Firebase)
  try {
    loadFirebaseConfigForm();
    // โหลดข้อมูลเฉลยจาก LocalStorage ทันที
    allExams = dataManager.getFromLocal() || [];
    const savedActiveId = dataManager.getActiveExamId();
    activeExam = allExams.find(e => e.id === savedActiveId) || allExams[0] || null;

    updateGlobalExamSelector();
    updateFirebaseStatusBadge();
    renderExamsList();
    renderKeyEditor();
    renderAnswerSheetPreview(); // <-- วาดกระดาษคำตอบทันที ไม่มีทางค้างแน่นอน!
  } catch (err) {
    console.error('Initial synchronous setup error:', err);
    try { renderAnswerSheetPreview(); } catch (e) {}
  }

  // ซิงค์ Firebase ใน Background (Non-blocking)
  loadExamsData().catch(err => console.warn('Background sync error:', err));
});

