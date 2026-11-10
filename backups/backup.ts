import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 서비스 계정 키 파일 경로 (반드시 같은 폴더에 serviceAccountKey.json 파일이 있어야 합니다)
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error("❌ 오류: serviceAccountKey.json 파일이 존재하지 않습니다.");
  console.error("Firebase Console > 프로젝트 설정 > 서비스 계정에서 새 비공개 키를 생성하여 이 폴더(backups)에 저장해주세요.");
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

admin.initializeApp({
  credential: admin.cert(serviceAccount)
});

const db = getFirestore();

async function backup() {
  const includeEmbedding = process.argv.includes('--with-embedding');
  console.log(
    includeEmbedding
      ? "🔄 Firestore 데이터 백업 시작 (임베딩 포함 전체 백업)..."
      : "🔄 Firestore 데이터 백업 시작 (임베딩 필드 제외 경량 백업)..."
  );
  
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + 
    String(now.getMonth() + 1).padStart(2, '0') + '-' + 
    String(now.getDate()).padStart(2, '0'); // YYYY-MM-DD 형식
    
  const backupData: {
    backupDate: string;
    excludedFields: string[];
    notes: Record<string, any>;
    user_meta: Record<string, any>;
    note_index: Record<string, any>;
  } = {
    backupDate: now.toISOString(),
    excludedFields: includeEmbedding ? [] : ['notes.*.embedding'],
    notes: {},
    user_meta: {},
    note_index: {}
  };

  try {
    // 1. notes 컬렉션 백업 (기본적으로 용량이 큰 768차원 embedding 벡터 필드는 제외)
    console.log("  - notes 컬렉션 다운로드 중...");
    const notesSnap = await db.collection('notes').get();
    let excludedEmbeddingCount = 0;
    notesSnap.forEach(doc => {
      const data = doc.data();
      if (!includeEmbedding && 'embedding' in data) {
        const { embedding: _omitted, ...rest } = data;
        backupData.notes[doc.id] = rest;
        excludedEmbeddingCount++;
      } else {
        backupData.notes[doc.id] = data;
      }
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
    const jsonStr = JSON.stringify(backupData, null, 2);
    fs.writeFileSync(filePath, jsonStr, 'utf-8');
    const sizeKB = (Buffer.byteLength(jsonStr, 'utf-8') / 1024).toFixed(1);
    
    console.log(`✅ 백업 완료! 저장된 파일: ${fileName} (${sizeKB} KB${!includeEmbedding ? `, 임베딩 제외 ${excludedEmbeddingCount}건` : ''})`);
    process.exit(0);
  } catch (error) {
    console.error("❌ 백업 중 오류 발생:", error);
    process.exit(1);
  }
}

backup();
