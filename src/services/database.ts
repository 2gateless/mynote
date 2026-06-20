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
  finance_realty: { name: '금융/부동산', icon: '💰' },
  office:         { name: '법률/사무실', icon: '💼' },
  family:         { name: '가족/private', icon: '👨‍👩‍👧‍👦' },
};

export const SUB_TAGS: Record<string, string[]> = {
  ref_science: ['물리', '수학', '화학', '생명', '지구/지질', '돌/암석', '기타'],
  ref_art: ['문학', '미술', '음악', '종교', '기타'],
  nature: ['나무', '풀/꽃', '양치/선태', '균류/지의류', '새', '절지/곤충', '기타'],
  it_history: ['IT', '역사/문화'],
  finance_realty: ['금융', '부동산'],
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

    // ref_others 카테고리 중 'IT' 혹은 '역사/문화' 태그가 붙은 것들을 'it_history' 카테고리로 변경
    const qMigrateTags = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'ref_others'),
      where('tag', 'in', ['IT', '역사/문화']));
    const snapTags = await getDocs(qMigrateTags);
    for (const d of snapTags.docs) {
      await updateDoc(doc(db, 'notes', d.id), { category: 'it_history' });
    }
    if (snapTags.size > 0) {
      console.log(`태그 마이그레이션: ref_others(IT, 역사/문화) → it_history (${snapTags.size}건)`);
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

export async function syncNoteMeta(action: 'add' | 'update' | 'delete', noteId: string, newData: Partial<Note>, oldData: Partial<Note>) {
  if (!appState.currentUser) return;
  await runTransaction(db, async (t) => {
    const metaRef = doc(db, 'user_meta', appState.currentUser.uid);
    const indexRef = doc(db, 'note_index', appState.currentUser.uid);
    const metaSnap = await t.get(metaRef);
    const indexSnap = await t.get(indexRef);
    let categoryCount = metaSnap.exists() ? metaSnap.data().categoryCount || {} : {};
    let notesIndex = indexSnap.exists() ? indexSnap.data().notes || [] : [];
    
    if (action === 'add') {
      const cat = newData.category;
      if (cat) categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      notesIndex.push({
        id: noteId,
        title: newData.title || '',
        category: cat || '',
        tag: newData.tag || '',
        snippet: (newData.body || '').substring(0, 200),
        keywords: newData.keywords || ''
      });
    } else if (action === 'update') {
      const idx = notesIndex.findIndex((n: NoteIndexItem) => n.id === noteId);
      if (idx !== -1) {
        notesIndex[idx] = {
          ...notesIndex[idx],
          title: newData.title !== undefined ? newData.title : notesIndex[idx].title,
          category: newData.category !== undefined ? newData.category : notesIndex[idx].category,
          tag: newData.tag !== undefined ? newData.tag : notesIndex[idx].tag,
          snippet: newData.body !== undefined ? newData.body.substring(0, 200) : notesIndex[idx].snippet,
          keywords: newData.keywords !== undefined ? newData.keywords : notesIndex[idx].keywords
        };
      }
    } else if (action === 'delete') {
      const cat = oldData.category;
      if (cat && categoryCount[cat]) categoryCount[cat] = Math.max(0, categoryCount[cat] - 1);
      notesIndex = notesIndex.filter((n: NoteIndexItem) => n.id !== noteId);
    }
    t.set(metaRef, { categoryCount }, { merge: true });
    t.set(indexRef, { notes: notesIndex }, { merge: true });
  });
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
  return onSnapshot(doc(db, 'note_index', appState.currentUser.uid), snap => {
    const notes = snap.exists() ? snap.data().notes || [] : [];
    appState.allNotesCache = notes;
    onIndexChange(notes);
  });
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
