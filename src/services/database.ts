import { 
  collection, 
  doc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  getDocs, 
  updateDoc, 
  deleteDoc, 
  getDoc, 
  setDoc,
  runTransaction,
  Timestamp 
} from 'firebase/firestore';
import { db } from './firebase';
import { appState } from '../state';
import { Note, NoteIndexItem } from '../types';

export const CATEGORIES: Record<string, { name: string; icon: string }> = {
  memory:         { name: '기억',       icon: '💭' },
  ref_science:    { name: '과학',       icon: '🔬' },
  ref_art:        { name: '예술/종교',       icon: '🎨' },
  nature:         { name: '식물/새/곤충',  icon: '🌿' },
  it_history:     { name: 'IT/역사/문화', icon: '💻' },
  ref_others:     { name: '좋은글/건강/기타',       icon: '📋' },
  finance_realty: { name: '경제/금융/부동산', icon: '💰' },
  office:         { name: '법률/사무실', icon: '💼' },
  family:         { name: '가족/private', icon: '👨‍👩‍👧‍👦' },
};

export const SUB_TAGS: Record<string, string[]> = {
  ref_science: ['물리', '수학', '화학', '생명', '지구/지질', '돌/암석', '기타'],
  ref_art: ['문학', '미술', '음악', '종교', '기타'],
  nature: ['나무', '풀/꽃', '양치/선태', '균류/지의류', '새', '절지/곤충', '기타'],
  it_history: ['IT', '국가/역사/문화', '생활'],
  finance_realty: ['경제', '금융/crypto', '부동산'],
  ref_others: ['좋은글', '건강', '레시피', '여행', '영화', '기타'],
  office: ['법률', '사무실'],
  family: ['가족', 'private']
};

export async function migrateCategories() {
  if (!appState.currentUser) return;
  try {
    const migrations = [
      { from: 'reference', to: 'ref_science' },
      { from: 'others',    to: 'ref_others'  },
      { from: 'finance',   to: 'finance_realty' },
      { from: 'realty',    to: 'finance_realty' },
    ];
    for (const { from, to } of migrations) {
      const q = query(collection(db, 'notes'),
        where('uid', '==', appState.currentUser.uid),
        where('category', '==', from));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        await updateDoc(doc(db, 'notes', d.id), { category: to });
      }
      if (snap.size > 0) console.log(`마이그레이션: ${from} → ${to} (${snap.size}건)`);
    }

    // ref_others 카테고리 중 'IT' 혹은 '역사/문화', '국가/역사/문화', '생활' 태그가 붙은 것들을 'it_history' 카테고리로 변경
    const qMigrateTags = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'ref_others'),
      where('tag', 'in', ['IT', '역사/문화', '국가/역사/문화', '생활']));
    const snapTags = await getDocs(qMigrateTags);
    for (const d of snapTags.docs) {
      await updateDoc(doc(db, 'notes', d.id), { category: 'it_history' });
    }
    if (snapTags.size > 0) {
      console.log(`태그 마이그레이션: ref_others → it_history (${snapTags.size}건)`);
    }

    // it_history 카테고리 중 '역사/문화' 태그가 붙은 것들을 '국가/역사/문화' 태그로 변경
    const qMigrateHistory = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'it_history'),
      where('tag', '==', '역사/문화'));
    const snapHistory = await getDocs(qMigrateHistory);
    for (const d of snapHistory.docs) {
      await updateDoc(doc(db, 'notes', d.id), { tag: '국가/역사/문화' });
    }
    if (snapHistory.size > 0) {
      console.log(`태그 마이그레이션: it_history(역사/문화) → 국가/역사/문화 (${snapHistory.size}건)`);
    }

    // nature 카테고리 중 '꽃' 태그가 붙은 것들을 '풀/꽃' 태그로 변경
    const qMigrateNature = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'nature'),
      where('tag', '==', '꽃'));
    const snapNature = await getDocs(qMigrateNature);
    for (const d of snapNature.docs) {
      await updateDoc(doc(db, 'notes', d.id), { tag: '풀/꽃' });
    }
    if (snapNature.size > 0) {
      console.log(`태그 마이그레이션: nature(꽃) → 풀/꽃 (${snapNature.size}건)`);
    }

    // nature 카테고리 중 '지의류' 태그가 붙은 것들을 '균류/지의류' 태그로 변경
    const qMigrateLichen = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'nature'),
      where('tag', '==', '지의류'));
    const snapLichen = await getDocs(qMigrateLichen);
    for (const d of snapLichen.docs) {
      await updateDoc(doc(db, 'notes', d.id), { tag: '균류/지의류' });
    }
    if (snapLichen.size > 0) {
      console.log(`태그 마이그레이션: nature(지의류) → 균류/지의류 (${snapLichen.size}건)`);
    }

    // nature 카테고리 중 '곤충' 태그가 붙은 것들을 '절지/곤충' 태그로 변경
    const qMigrateInsect = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'nature'),
      where('tag', '==', '곤충'));
    const snapInsect = await getDocs(qMigrateInsect);
    for (const d of snapInsect.docs) {
      await updateDoc(doc(db, 'notes', d.id), { tag: '절지/곤충' });
    }
    if (snapInsect.size > 0) {
      console.log(`태그 마이그레이션: nature(곤충) → 절지/곤충 (${snapInsect.size}건)`);
    }

    // office 카테고리 중 태그가 없는 메모들을 '사무실' 태그로 마이그레이션
    const qMigrateOffice = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'office'));
    const snapOffice = await getDocs(qMigrateOffice);
    let officeMigrated = 0;
    for (const d of snapOffice.docs) {
      const tag = d.data().tag;
      if (!tag || tag === '') {
        await updateDoc(doc(db, 'notes', d.id), { tag: '사무실' });
        officeMigrated++;
      }
    }
    if (officeMigrated > 0) {
      console.log(`태그 마이그레이션: office(태그없음) → 사무실 (${officeMigrated}건)`);
    }
  } catch(e) { console.error('마이그레이션 오류:', e); }
}

export async function migrateNotesToMeta() {
  if (!appState.currentUser) return;
  try {
    const metaRef = doc(db, 'user_meta', appState.currentUser.uid);
    const metaSnap = await getDoc(metaRef);
    if (metaSnap.exists()) return;
    console.log('초기 메타데이터 마이그레이션 시작...');
    const q = query(collection(db, 'notes'), where('uid', '==', appState.currentUser.uid));
    const snap = await getDocs(q);
    const categoryCount: Record<string, number> = {};
    Object.keys(CATEGORIES).forEach(k => categoryCount[k] = 0);
    const notesIndex: NoteIndexItem[] = [];
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.category && categoryCount[data.category] !== undefined) categoryCount[data.category]++;
      notesIndex.push({
        id: d.id,
        title: data.title || '',
        category: data.category || '',
        tag: data.tag || '',
        snippet: (data.body || '').substring(0, 200),
        keywords: data.keywords || ''
      });
    });
    
    await runTransaction(db, async (t) => {
      t.set(metaRef, { categoryCount });
      t.set(doc(db, 'note_index', appState.currentUser.uid), { notes: notesIndex });
    });
    console.log('마이그레이션 완료!');
  } catch(e) { console.error('메타 마이그레이션 오류:', e); }
}

// 카테고리별 note_index 문서 참조 헬퍼 (note_index/{uid}_{category})
function catIndexRef(uid: string, category: string) {
  return doc(db, 'note_index', `${uid}_${category}`);
}

// 1회성 마이그레이션: note_index/{uid} 단일 문서 → note_index/{uid}_{category} 9개 문서로 분할
// 실행 후 콘솔에 "분할 마이그레이션 완료!"가 뜨면 성공. main.ts에서 이 함수 호출을 다시 주석 처리할 것.
export async function migrateNoteIndexToShards() {
  if (!appState.currentUser) return;
  try {
    const uid = appState.currentUser.uid;
    const oldRef = doc(db, 'note_index', uid);
    const oldSnap = await getDoc(oldRef);
    if (!oldSnap.exists()) {
      console.log('기존 note_index 문서가 없어 분할 마이그레이션을 건너뜁니다.');
      return;
    }
    const allNotes: NoteIndexItem[] = oldSnap.data().notes || [];
    if (allNotes.length === 0) {
      console.log('기존 note_index에 메모가 없어 분할 마이그레이션을 건너뜁니다.');
      return;
    }

    const grouped: Record<string, NoteIndexItem[]> = {};
    allNotes.forEach(n => {
      const cat = n.category || '_미분류';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(n);
    });

    for (const cat of Object.keys(grouped)) {
      await setDoc(catIndexRef(uid, cat), { notes: grouped[cat] });
      console.log(`  → ${cat}: ${grouped[cat].length}건 이전 완료`);
    }

    console.log(`분할 마이그레이션 완료! (총 ${allNotes.length}건, ${Object.keys(grouped).length}개 카테고리)`);
    console.log('※ 정상 동작(검색·목록 표시) 확인 후, Firebase 콘솔에서 기존 note_index/' + uid + ' 문서를 수동으로 삭제하세요.');
  } catch (e) {
    console.error('분할 마이그레이션 오류:', e);
  }
}

export async function syncNoteMeta(action: 'add' | 'update' | 'delete', noteId: string, newData: Partial<Note>, oldData: Partial<Note>) {
  if (!appState.currentUser) return;
  const uid = appState.currentUser.uid;
  const metaRef = doc(db, 'user_meta', uid);

  if (action === 'add') {
    const cat = newData.category || '';
    const indexRef = catIndexRef(uid, cat);
    await runTransaction(db, async (t) => {
      const metaSnap = await t.get(metaRef);
      const indexSnap = await t.get(indexRef);
      let categoryCount = metaSnap.exists() ? metaSnap.data().categoryCount || {} : {};
      let notesIndex = indexSnap.exists() ? indexSnap.data().notes || [] : [];
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      notesIndex.push({
        id: noteId,
        title: newData.title || '',
        category: cat,
        tag: newData.tag || '',
        snippet: (newData.body || '').substring(0, 200),
        keywords: newData.keywords || ''
      });
      t.set(metaRef, { categoryCount }, { merge: true });
      t.set(indexRef, { notes: notesIndex }, { merge: true });
    });
    return;
  }

  if (action === 'delete') {
    const cat = oldData.category || '';
    const indexRef = catIndexRef(uid, cat);
    await runTransaction(db, async (t) => {
      const metaSnap = await t.get(metaRef);
      const indexSnap = await t.get(indexRef);
      let categoryCount = metaSnap.exists() ? metaSnap.data().categoryCount || {} : {};
      let notesIndex = indexSnap.exists() ? indexSnap.data().notes || [] : [];
      if (cat && categoryCount[cat]) categoryCount[cat] = Math.max(0, categoryCount[cat] - 1);
      notesIndex = notesIndex.filter((n: NoteIndexItem) => n.id !== noteId);
      t.set(metaRef, { categoryCount }, { merge: true });
      t.set(indexRef, { notes: notesIndex }, { merge: true });
    });
    return;
  }

  // action === 'update'
  const oldCat = oldData.category || '';
  const newCat = newData.category !== undefined ? newData.category : oldCat;

  if (newCat === oldCat) {
    // 카테고리가 안 바뀌면 그 카테고리 문서 하나만 갱신 (제일 흔한 경우)
    const indexRef = catIndexRef(uid, oldCat);
    await runTransaction(db, async (t) => {
      const indexSnap = await t.get(indexRef);
      let notesIndex = indexSnap.exists() ? indexSnap.data().notes || [] : [];
      const idx = notesIndex.findIndex((n: NoteIndexItem) => n.id === noteId);
      if (idx !== -1) {
        notesIndex[idx] = {
          ...notesIndex[idx],
          title: newData.title !== undefined ? newData.title : notesIndex[idx].title,
          tag: newData.tag !== undefined ? newData.tag : notesIndex[idx].tag,
          snippet: newData.body !== undefined ? newData.body.substring(0, 200) : notesIndex[idx].snippet,
          keywords: newData.keywords !== undefined ? newData.keywords : notesIndex[idx].keywords
        };
      }
      t.set(indexRef, { notes: notesIndex }, { merge: true });
    });
  } else {
    // 카테고리가 바뀌면 이전 문서에서 빼고 새 문서에 넣는다
    const oldIndexRef = catIndexRef(uid, oldCat);
    const newIndexRef = catIndexRef(uid, newCat);
    await runTransaction(db, async (t) => {
      const metaSnap = await t.get(metaRef);
      const oldIndexSnap = await t.get(oldIndexRef);
      const newIndexSnap = await t.get(newIndexRef);
      let categoryCount = metaSnap.exists() ? metaSnap.data().categoryCount || {} : {};
      let oldNotesIndex = oldIndexSnap.exists() ? oldIndexSnap.data().notes || [] : [];
      let newNotesIndex = newIndexSnap.exists() ? newIndexSnap.data().notes || [] : [];

      const existingIdx = oldNotesIndex.findIndex((n: NoteIndexItem) => n.id === noteId);
      const base = existingIdx !== -1 ? oldNotesIndex[existingIdx] : { id: noteId, title: '', tag: '', snippet: '', keywords: '' };
      oldNotesIndex = oldNotesIndex.filter((n: NoteIndexItem) => n.id !== noteId);

      newNotesIndex.push({
        id: noteId,
        title: newData.title !== undefined ? newData.title : base.title,
        category: newCat,
        tag: newData.tag !== undefined ? newData.tag : base.tag,
        snippet: newData.body !== undefined ? newData.body.substring(0, 200) : base.snippet,
        keywords: newData.keywords !== undefined ? newData.keywords : base.keywords
      });

      if (oldCat && categoryCount[oldCat]) categoryCount[oldCat] = Math.max(0, categoryCount[oldCat] - 1);
      categoryCount[newCat] = (categoryCount[newCat] || 0) + 1;

      t.set(metaRef, { categoryCount }, { merge: true });
      t.set(oldIndexRef, { notes: oldNotesIndex }, { merge: true });
      t.set(newIndexRef, { notes: newNotesIndex }, { merge: true });
    });
  }
}

export function subscribeUserMeta(onMetaChange: (categoryCount: Record<string, number>) => void) {
  if (!appState.currentUser) return () => {};
  return onSnapshot(doc(db, 'user_meta', appState.currentUser.uid), snap => {
    const categoryCount = snap.exists() ? (snap.data().categoryCount || {}) : {};
    onMetaChange(categoryCount);
  });
}

export function subscribeAllNotes(onIndexChange: (notes: NoteIndexItem[]) => void) {
  if (!appState.currentUser) return () => {};
  const uid = appState.currentUser.uid;
  const categoryKeys = Object.keys(CATEGORIES);
  const perCategory: Record<string, NoteIndexItem[]> = {};

  const unsubs = categoryKeys.map(cat =>
    onSnapshot(catIndexRef(uid, cat), snap => {
      perCategory[cat] = snap.exists() ? (snap.data().notes || []) : [];
      // 카테고리 9개 중 하나만 바뀌어도 전체를 다시 합쳐서 캐시 갱신
      const merged = categoryKeys.flatMap(c => perCategory[c] || []);
      appState.allNotesCache = merged;
      onIndexChange(merged);
    })
  );

  // 구독 해제 시 9개 리스너 전부 해제
  return () => unsubs.forEach(u => u());
}

export function subscribeNotesList(catId: string, onListChange: (notes: Note[]) => void, onError: (err: Error) => void) {
  if (!appState.currentUser) return () => {};
  const q = query(collection(db, 'notes'),
    where('uid', '==', appState.currentUser.uid),
    where('category', '==', catId),
    orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    const notes = snap.docs.map(d => ({ id: d.id, ...d.data() } as Note));
    onListChange(notes);
  }, onError);
}

export async function getSingleNote(noteId: string) {
  const docSnap = await getDoc(doc(db, 'notes', noteId));
  if (docSnap.exists()) {
    return { id: docSnap.id, ...docSnap.data() } as Note;
  }
  return null;
}

export async function deleteSingleNote(noteId: string) {
  return deleteDoc(doc(db, 'notes', noteId));
}

export async function createNote(noteData: Partial<Note>) {
  const noteRef = doc(collection(db, 'notes'));
  await setDoc(noteRef, {
    uid: appState.currentUser.uid,
    createdAt: Timestamp.now(),
    ...noteData
  });
  return noteRef.id;
}

export async function updateSingleNote(noteId: string, noteData: Partial<Note>) {
  return updateDoc(doc(db, 'notes', noteId), {
    updatedAt: Timestamp.now(),
    ...noteData
  });
}
