const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 서비스 계정 키 파일 경로 (반드시 같은 폴더에 serviceAccountKey.json 파일이 있어야 합니다)
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error("❌ 오류: serviceAccountKey.json 파일이 존재하지 않습니다.");
  console.error("Firebase Console > 프로젝트 설정 > 서비스 계정에서 새 비공개 키를 생성하여 이 폴더(backups)에 저장해주세요.");
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function backup() {
  console.log("🔄 Firestore 데이터 백업 시작...");
  
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + 
    String(now.getMonth() + 1).padStart(2, '0') + '-' + 
    String(now.getDate()).padStart(2, '0'); // YYYY-MM-DD 형식
    
  const backupData = {
    backupDate: now.toISOString(),
    notes: {},
    user_meta: {},
    note_index: {}
  };

  try {
    // 1. notes 컬렉션 백업
    console.log("  - notes 컬렉션 다운로드 중...");
    const notesSnap = await db.collection('notes').get();
    notesSnap.forEach(doc => {
      backupData.notes[doc.id] = doc.data();
    });

    // 2. user_meta 컬렉션 백업
    console.log("  - user_meta 컬렉션 다운로드 중...");
    const metaSnap = await db.collection('user_meta').get();
    metaSnap.forEach(doc => {
      backupData.user_meta[doc.id] = doc.data();
    });

    // 3. note_index 컬렉션 백업
    console.log("  - note_index 컬렉션 다운로드 중...");
    const indexSnap = await db.collection('note_index').get();
    indexSnap.forEach(doc => {
      backupData.note_index[doc.id] = doc.data();
    });

    // 4. 파일로 저장
    const fileName = `backup_${dateStr}.json`;
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf-8');
    
    console.log(`✅ 백업 완료! 저장된 파일: ${fileName}`);
    process.exit(0);
  } catch (error) {
    console.error("❌ 백업 중 오류 발생:", error);
    process.exit(1);
  }
}

backup();
