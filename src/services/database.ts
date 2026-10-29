import { 
  collection, 
  doc, 
  query, 
  where, 
  onSnapshot, 
  getDocs, 
  updateDoc, 
  getDoc, 
  setDoc,
  runTransaction,
  increment,
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
  it_history: ['IT', '국가/역사/문화', '생활/화폐'],
  finance_realty: ['경제', '금융/crypto', '부동산'],
  ref_others: ['좋은글', '건강', '레시피', '여행', '영화', '기타'],
  office: ['법률', '사무실'],
  family: ['가족', 'private']
};

// ※ 아래 마이그레이션 함수들은 과거 1회성 작업용으로, 현재 앱에서는 호출하지 않습니다. (기록 보존용)
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
      where('tag', 'in', ['IT', '역사/문화', '국가/역사/문화', '생활', '생활/화폐']));
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

    // it_history 카테고리 중 '생활' 태그가 붙은 것들을 '생활/화폐' 태그로 변경
    const qMigrateLife = query(collection(db, 'notes'),
      where('uid', '==', appState.currentUser.uid),
      where('category', '==', 'it_history'),
      where('tag', '==', '생활'));
    const snapLife = await getDocs(qMigrateLife);
    for (const d of snapLife.docs) {
      await updateDoc(doc(db, 'notes', d.id), { tag: '생활/화폐' });
    }
    if (snapLife.size > 0) {
      console.log(`태그 마이그레이션: it_history(생활) → 생활/화폐 (${snapLife.size}건)`);
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

// ─────────────────────────────────────────────
// 인덱스 / 메모 CRUD
// ─────────────────────────────────────────────

const SNIPPET_LEN = 200;

function requireUid(): string {
  if (!appState.currentUser) throw new Error('인증 정보가 없습니다.');
  return appState.currentUser.uid;
}

function metaRefOf(uid: string) {
  return doc(db, 'user_meta', uid);
}

// 메모 데이터 → 인덱스 항목 변환 (목록 표시에 필요한 필드 포함)
function toIndexItem(id: string, data: any): NoteIndexItem {
  return {
    id,
    title: data.title || '',
    category: data.category || '',
    tag: data.tag || '',
    snippet: (data.body || '').substring(0, SNIPPET_LEN),
    keywords: data.keywords || '',
    createdAt: data.createdAt || null,
    pinned: !!data.pinned,
    pinnedAt: data.pinnedAt || null,
    locked: !!data.locked,
  };
}

// 새 메모 생성: 메모 문서 + 카테고리 인덱스 + 카운트를 하나의 트랜잭션으로 처리 (왕복 1회, 원자성 보장)
export async function createNoteWithIndex(noteData: Partial<Note>): Promise<string> {
  const uid = requireUid();
  const cat = noteData.category || '';
  const noteRef = doc(collection(db, 'notes'));
  const indexRef = catIndexRef(uid, cat);
  const fullData = { uid, createdAt: Timestamp.now(), ...noteData };

  await runTransaction(db, async (t) => {
    const indexSnap = await t.get(indexRef);
    const notesIndex: NoteIndexItem[] = indexSnap.exists() ? (indexSnap.data().notes || []) : [];
    notesIndex.push(toIndexItem(noteRef.id, fullData));
    t.set(noteRef, fullData);
    t.set(indexRef, { notes: notesIndex }, { merge: true });
    // 카운트는 읽지 않고 increment로 원자적 증가
    t.set(metaRefOf(uid), { categoryCount: { [cat]: increment(1) } }, { merge: true });
  });
  return noteRef.id;
}

// 메모 수정: 메모 문서 + 인덱스(카테고리 변경 시 양쪽) + 카운트를 하나의 트랜잭션으로 처리
export async function updateNoteWithIndex(noteId: string, updateData: Partial<Note>, oldNote: Partial<Note>) {
  const uid = requireUid();
  const oldCat = oldNote.category || '';
  const newCat = updateData.category !== undefined ? updateData.category : oldCat;
  const noteRef = doc(db, 'notes', noteId);
  const data = { ...updateData, updatedAt: Timestamp.now() };
  const merged = { ...oldNote, ...data, category: newCat };

  await runTransaction(db, async (t) => {
    if (newCat === oldCat) {
      // 카테고리가 그대로면 해당 인덱스 문서 하나만 갱신 (가장 흔한 경우)
      const indexRef = catIndexRef(uid, oldCat);
      const indexSnap = await t.get(indexRef);
      const notesIndex: NoteIndexItem[] = indexSnap.exists() ? (indexSnap.data().notes || []) : [];
      const item = toIndexItem(noteId, merged);
      const idx = notesIndex.findIndex(n => n.id === noteId);
      if (idx !== -1) notesIndex[idx] = item; else notesIndex.push(item);
      t.update(noteRef, data);
      t.set(indexRef, { notes: notesIndex }, { merge: true });
      return;
    }

    // 카테고리가 바뀌면 이전 인덱스에서 빼고 새 인덱스에 넣는다
    const oldIndexRef = catIndexRef(uid, oldCat);
    const newIndexRef = catIndexRef(uid, newCat);
    const oldIndexSnap = await t.get(oldIndexRef);
    const newIndexSnap = await t.get(newIndexRef);
    const oldNotesIndex: NoteIndexItem[] = (oldIndexSnap.exists() ? (oldIndexSnap.data().notes || []) : [])
      .filter((n: NoteIndexItem) => n.id !== noteId);
    const newNotesIndex: NoteIndexItem[] = (newIndexSnap.exists() ? (newIndexSnap.data().notes || []) : [])
      .filter((n: NoteIndexItem) => n.id !== noteId);
    newNotesIndex.push(toIndexItem(noteId, merged));

    t.update(noteRef, data);
    t.set(oldIndexRef, { notes: oldNotesIndex }, { merge: true });
    t.set(newIndexRef, { notes: newNotesIndex }, { merge: true });
    t.set(metaRefOf(uid), {
      categoryCount: { [oldCat]: increment(-1), [newCat]: increment(1) }
    }, { merge: true });
  });
}

// 메모 삭제: 메모 문서 + 인덱스 + 카운트를 하나의 트랜잭션으로 처리
export async function deleteNoteWithIndex(noteId: string, oldNote: Partial<Note>) {
  const uid = requireUid();
  const cat = oldNote.category || '';
  const indexRef = catIndexRef(uid, cat);

  await runTransaction(db, async (t) => {
    const indexSnap = await t.get(indexRef);
    const notesIndex: NoteIndexItem[] = indexSnap.exists() ? (indexSnap.data().notes || []) : [];
    const filtered = notesIndex.filter(n => n.id !== noteId);
    t.delete(doc(db, 'notes', noteId));
    t.set(indexRef, { notes: filtered }, { merge: true });
    // 인덱스에 실제로 있었던 경우에만 카운트 감소 (중복 감소 방지)
    if (filtered.length !== notesIndex.length) {
      t.set(metaRefOf(uid), { categoryCount: { [cat]: increment(-1) } }, { merge: true });
    }
  });
}

// 카테고리 인덱스를 notes 컬렉션 기준으로 재구성 (구버전 인덱스 자동 보정 / 카운트 정정)
// 카테고리당 최초 1회만 실행되며, 이후 목록 화면은 인덱스만 읽는다.
export async function rebuildCategoryIndex(catId: string) {
  const uid = requireUid();
  const q = query(collection(db, 'notes'),
    where('uid', '==', uid),
    where('category', '==', catId));
  const snap = await getDocs(q);
  const notesIndex = snap.docs.map(d => toIndexItem(d.id, d.data()));
  await setDoc(catIndexRef(uid, catId), { notes: notesIndex });
  await setDoc(metaRefOf(uid), { categoryCount: { [catId]: snap.size } }, { merge: true });
}

export function subscribeUserMeta(onMetaChange: (categoryCount: Record<string, number>) => void) {
  if (!appState.currentUser) return () => {};
  return onSnapshot(metaRefOf(appState.currentUser.uid), snap => {
    const categoryCount = snap.exists() ? (snap.data().categoryCount || {}) : {};
    onMetaChange(categoryCount);


  });
}



// 9개 카테고리 인덱스를 모두 구독하여 병합 (검색·메모 링크용)
export function subscribeAllNotes(onIndexChange: (notes: NoteIndexItem[]) => void) {
  if (!appState.currentUser) return () => {};
  const uid = appState.currentUser.uid;
  const categoryKeys = Object.keys(CATEGORIES);
  const perCategory: Record<string, NoteIndexItem[]> = {};
  const initialLoaded = new Set<string>();
  let updateTimer: any = null;

  // 기존 로컬 캐시가 있다면 카테고리별 초기값으로 채워 두어 일부 샤드만 먼저 도착했을 때 누락 방지
  for (const cat of categoryKeys) {
    perCategory[cat] = [];
  }
  if (Array.isArray(appState.allNotesCache) && appState.allNotesCache.length > 0) {
    for (const n of appState.allNotesCache as NoteIndexItem[]) {
      if (n.category && perCategory[n.category]) {
        perCategory[n.category].push(n);
      }
    }
  }

  const notifyMerged = () => {
    onIndexChange(categoryKeys.flatMap(c => perCategory[c] || []));
  };

  const scheduleNotifyIfReady = () => {
    // 9개 카테고리의 초기 스냅샷이 모두 도착한 뒤에만 병합 알림 (부분 도착으로 인한 검색 결과 위치 점프 방지)
    if (initialLoaded.size < categoryKeys.length) return;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(notifyMerged, 20);
  };

  const unsubs = categoryKeys.map(cat =>
    onSnapshot(
      catIndexRef(uid, cat),
      snap => {
        perCategory[cat] = snap.exists() ? (snap.data().notes || []) : [];
        initialLoaded.add(cat);
        scheduleNotifyIfReady();
      },
      err => {
        console.warn(`카테고리 인덱스 구독 오류 (${cat}):`, err);
        initialLoaded.add(cat);
        scheduleNotifyIfReady();
      }
    )
  );

  // 구독 해제 시 9개 리스너 전부 해제
  return () => {
    if (updateTimer) clearTimeout(updateTimer);
    unsubs.forEach(u => u());
  };
}

// 단일 카테고리 인덱스 구독 (목록 화면용 — 본문 전체 문서를 읽지 않음)
// 같은 문서를 subscribeAllNotes도 구독 중이면 SDK가 리스너를 공유하므로 추가 읽기 비용이 거의 없다.
export function subscribeCategoryIndex(catId: string, onChange: (notes: NoteIndexItem[]) => void, onError: (err: Error) => void) {
  if (!appState.currentUser) {
    console.warn(`subscribeCategoryIndex: 사용자 인증 완료 전 호출됨 (catId: ${catId})`);
    return () => {};
  }
  return onSnapshot(catIndexRef(appState.currentUser.uid, catId), snap => {
    onChange(snap.exists() ? (snap.data().notes || []) : []);
  }, onError);
}

export async function getSingleNote(noteId: string) {
  const docSnap = await getDoc(doc(db, 'notes', noteId));
  if (docSnap.exists()) {
    return { id: docSnap.id, ...docSnap.data() } as Note;
  }
  return null;
}
