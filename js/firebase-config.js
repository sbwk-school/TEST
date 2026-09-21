/**
 * FirebaseConfig & ExamDataManager
 * จัดการเชื่อมต่อ Firebase Firestore สำหรับบันทึก/โหลด/ลบชุดเฉลยหลายวิชา
 * พร้อมระบบสำรองใน LocalStorage เพื่อให้ทำงานได้ทั้ง Online และ Offline
 */
class ExamDataManager {
  constructor() {
    this.storageKey = 'omr_exam_keys_db';
    this.configKey = 'omr_firebase_config';
    this.activeExamKey = 'omr_active_exam_id';
    this.db = null;
    this.isFirebaseReady = false;
    this.initFirebase();
  }

  /**
   * โหลดการตั้งค่า Firebase จาก LocalStorage หรือค่าเริ่มต้นของโปรเจกต์
   */
  getFirebaseConfig() {
    const saved = localStorage.getItem(this.configKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.projectId && parsed.apiKey) return parsed;
      } catch (e) {
        console.error('Error parsing firebase config', e);
      }
    }
    // ฝังการตั้งค่า Firebase ของโปรเจกต์ test-t2569
    return {
      apiKey: "AIzaSyA2ldVVHqTN6GhBxHBTwUP0t_49VGV7v2I",
      authDomain: "test-t2569.firebaseapp.com",
      projectId: "test-t2569",
      storageBucket: "test-t2569.firebasestorage.app",
      messagingSenderId: "835050745072",
      appId: "1:835050745072:web:3064276957ea0dd615a635",
      measurementId: "G-Q5YEVFQDPJ"
    };
  }

  /**
   * บันทึกการตั้งค่า Firebase ใหม่
   */
  saveFirebaseConfig(config) {
    localStorage.setItem(this.configKey, JSON.stringify(config));
    return this.initFirebase(config);
  }

  /**
   * เริ่มต้นเชื่อมต่อ Firebase
   */
  initFirebase(customConfig = null) {
    const config = customConfig || this.getFirebaseConfig();
    if (config && config.projectId && config.apiKey && window.firebase) {
      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(config);
        }
        this.db = firebase.firestore();
        this.isFirebaseReady = true;
        console.log('Firebase Firestore Initialized Successfully');
        return true;
      } catch (err) {
        console.warn('Firebase initialization failed, falling back to LocalStorage:', err);
        this.isFirebaseReady = false;
        return false;
      }
    } else {
      this.isFirebaseReady = false;
      return false;
    }
  }

  /**
   * ตรวจสอบสถานะการเชื่อมต่อ
   */
  getStatus() {
    return {
      isFirebase: this.isFirebaseReady,
      mode: this.isFirebaseReady ? 'Firebase Firestore (Online)' : 'Local Storage (ออฟไลน์ในเครื่อง)'
    };
  }

  /**
   * ดึงรายการชุดข้อสอบทั้งหมด
   */
  async getAllExams() {
    // 1. ถ้ามี Firebase ให้ลองดึงจาก Firestore โดยมี Timeout 2 วินาทีป้องกันค้าง
    if (this.isFirebaseReady && this.db) {
      try {
        const fetchPromise = this.db.collection('exam_keys').get();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase timeout')), 2000));
        const snapshot = await Promise.race([fetchPromise, timeoutPromise]);
        
        const exams = [];
        snapshot.forEach(doc => {
          exams.push({ id: doc.id, ...doc.data() });
        });
        if (exams.length > 0) {
          exams.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
          this.saveToLocal(exams);
          return exams;
        }
      } catch (err) {
        console.warn('Firestore fetch failed or timed out, reading local storage:', err);
      }
    }

    // 2. ดึงจาก LocalStorage ทันที
    return this.getFromLocal();
  }

  /**
   * บันทึกหรืออัปเดตชุดเฉลยวิชา
   * @param {object} examData { id, subjectName, roomName, totalQuestions, answers: {}, notes }
   */
  async saveExam(examData) {
    if (!examData.id) {
      examData.id = 'exam_' + Date.now();
    }
    examData.updatedAt = new Date().toISOString();

    // บันทึกลง LocalStorage ทันที
    const localExams = this.getFromLocal();
    const index = localExams.findIndex(e => e.id === examData.id);
    if (index >= 0) {
      localExams[index] = examData;
    } else {
      localExams.unshift(examData);
    }
    this.saveToLocal(localExams);

    // บันทึกลง Firebase ถ้าพร้อม
    if (this.isFirebaseReady && this.db) {
      try {
        await this.db.collection('exam_keys').doc(examData.id).set(examData, { merge: true });
        console.log('Saved to Firestore:', examData.id);
      } catch (err) {
        console.error('Failed to save to Firestore:', err);
      }
    }

    return examData;
  }

  /**
   * ลบชุดเฉลย
   */
  async deleteExam(examId) {
    // ลบจาก Local
    const localExams = this.getFromLocal().filter(e => e.id !== examId);
    this.saveToLocal(localExams);

    // ลบจาก Firebase
    if (this.isFirebaseReady && this.db) {
      try {
        await this.db.collection('exam_keys').doc(examId).delete();
        console.log('Deleted from Firestore:', examId);
      } catch (err) {
        console.error('Failed to delete from Firestore:', err);
      }
    }

    return true;
  }

  /**
   * ดึงชุดเฉลยที่กำลังใช้งานอยู่ (Active Exam)
   */
  getActiveExamId() {
    return localStorage.getItem(this.activeExamKey);
  }

  setActiveExamId(id) {
    localStorage.setItem(this.activeExamKey, id);
  }

  // --- Local Storage Helpers ---
  getFromLocal() {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : this.getDefaultSampleExams();
    } catch (e) {
      return this.getDefaultSampleExams();
    }
  }

  saveToLocal(exams) {
    localStorage.setItem(this.storageKey, JSON.stringify(exams));
  }

  /**
   * ตัวอย่างชุดข้อสอบเริ่มต้นถ้ายังไม่มีข้อมูล
   */
  getDefaultSampleExams() {
    const defaultExam = {
      id: 'exam_sample_1',
      subjectName: 'วิทยาศาสตร์ ม.1 (ตัวอย่าง)',
      roomName: 'ม.1/1',
      totalQuestions: 20,
      choiceType: 'thai', // thai (ก-ง), num (1-4)
      answers: {
        1: 0, // ก (index 0)
        2: 1, // ข (index 1)
        3: 2, // ค (index 2)
        4: 3, // ง (index 3)
        5: 0,
        6: 1,
        7: 2,
        8: 3,
        9: 0,
        10: 1,
        11: 2,
        12: 3,
        13: 0,
        14: 1,
        15: 2,
        16: 3,
        17: 0,
        18: 1,
        19: 2,
        20: 3
      },
      updatedAt: new Date().toISOString()
    };
    this.saveToLocal([defaultExam]);
    return [defaultExam];
  }
}

window.ExamDataManager = ExamDataManager;
