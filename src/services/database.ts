import { 
  collection, 
  doc, 
  query, 
  where, 
  onSnapshot, 
  getDocs, 
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

// 메모 객체에서 복수 카테고리 배열을 안전하게 추출 (구버전 단일 category 호환)
export function getNoteCategories(data: any): string[] {
  if (!data) return [];
  if (Array.isArray(data.categories) && data.categories.length > 0) {
    const valid = Array.from(new Set(data.categories.filter((c: any) => typeof c === 'string' && c in CATEGORIES))) as string[];
    if (valid.length > 0) return valid;
  }
  if (typeof data.category === 'string' && data.category) {
    return [data.category];
  }
  return [];
}

// 메모 객체에서 복수 태그 배열을 안전하게 추출 (구버전 단일 tag 호환)
export function getNoteTags(data: any): string[] {
  if (!data) return [];
  if (Array.isArray(data.tags)) {
    return Array.from(new Set(data.tags.filter((t: any) => typeof t === 'string' && t.trim() !== ''))) as string[];
  }
  if (typeof data.tag === 'string' && data.tag.trim() !== '') {
    return [data.tag.trim()];
  }
  return [];
}

// 카테고리별 note_index 문서 참조 헬퍼 (note_index/{uid}_{category})
function catIndexRef(uid: string, category: string) {
  return doc(db, 'note_index', `${uid}_${category}`);
}

// ─────────────────────────────────────────────
// 인덱스 / 메모 CRUD (복수 카테고리 지원)
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
function toIndexItem(id: string, data: any, shardCategory?: string): NoteIndexItem {
  const cats = getNoteCategories(data);
  const primaryCat = shardCategory || data.category || cats[0] || '';
  const tags = getNoteTags(data);
  return {
    id,
    title: data.title || '',
    category: primaryCat,
    categories: cats.length > 0 ? cats : (primaryCat ? [primaryCat] : []),
    tag: tags[0] || '',
    tags,
    // 잠금 메모는 본문 미리보기를 인덱스(및 이를 캐싱하는 localStorage/검색 텍스트)에 남기지 않음
    snippet: data.locked ? '' : (data.body || '').substring(0, SNIPPET_LEN),
    keywords: data.keywords || '',
    createdAt: data.createdAt || null,
    pinned: !!data.pinned,
    pinnedAt: data.pinnedAt || null,
    locked: !!data.locked,
    embeddingUpdatedAt: data.embeddingUpdatedAt || null,
    embeddingModel: data.embeddingModel || null,
  };
}

// 새 메모 생성: 메모 문서 + 선택된 모든 카테고리 인덱스 + 카운트를 하나의 트랜잭션으로 처리
export async function createNoteWithIndex(noteData: Partial<Note>): Promise<string> {
  const uid = requireUid();
  const cats = getNoteCategories(noteData);
  const primaryCat = cats[0] || noteData.category || '';
  const targetCats = cats.length > 0 ? cats : (primaryCat ? [primaryCat] : []);
  const noteRef = doc(collection(db, 'notes'));
  const fullData = {
    uid,
    createdAt: Timestamp.now(),
    ...noteData,
    category: primaryCat,
    categories: targetCats,
    tag: getNoteTags(noteData)[0] || null,
    tags: getNoteTags(noteData),
  };

  await runTransaction(db, async (t) => {
    const snaps = await Promise.all(targetCats.map(c => t.get(catIndexRef(uid, c))));
    t.set(noteRef, fullData);
    const countUpdates: Record<string, any> = {};
    targetCats.forEach((c, idx) => {
      const snap = snaps[idx];
      const rawList: NoteIndexItem[] = snap.exists() ? (snap.data().notes || []) : [];
      const notesIndex = rawList.filter(n => n.id !== noteRef.id);
      notesIndex.push(toIndexItem(noteRef.id, fullData, c));
      t.set(catIndexRef(uid, c), { notes: notesIndex }, { merge: true });
      countUpdates[c] = notesIndex.length;
    });
    const metaPayload: Record<string, any> = { totalNotesCount: increment(1) };
    if (Object.keys(countUpdates).length > 0) {
      metaPayload.categoryCount = countUpdates;
    }
    t.set(metaRefOf(uid), metaPayload, { merge: true });
  });
  return noteRef.id;
}

// 메모 수정: 메모 문서 + 인덱스(복수 카테고리 추가·유지·제거 반영) + 카운트를 하나의 트랜잭션으로 처리
export async function updateNoteWithIndex(noteId: string, updateData: Partial<Note>, oldNote: Partial<Note>) {
  const uid = requireUid();
  const oldCats = getNoteCategories(oldNote);
  const newCatsRaw = getNoteCategories(updateData);
  const newCats = newCatsRaw.length > 0 ? newCatsRaw : oldCats;
  const primaryCat = newCats[0] || updateData.category || oldNote.category || '';
  const noteRef = doc(db, 'notes', noteId);
  const newTags = updateData.tags !== undefined || updateData.tag !== undefined
    ? getNoteTags(updateData)
    : getNoteTags(oldNote);
  const data = {
    ...updateData,
    category: primaryCat,
    categories: newCats,
    tag: newTags[0] || null,
    tags: newTags,
    updatedAt: Timestamp.now()
  };
  const merged = { ...oldNote, ...data };
  const allCats = Array.from(new Set([...oldCats, ...newCats]));

  await runTransaction(db, async (t) => {
    const snaps = await Promise.all(allCats.map(c => t.get(catIndexRef(uid, c))));
    t.update(noteRef, data);
    const countUpdates: Record<string, any> = {};

    allCats.forEach((c, idx) => {
      const snap = snaps[idx];
      const existingList: NoteIndexItem[] = snap.exists() ? (snap.data().notes || []) : [];
      const isInCat = newCats.includes(c);

      if (isInCat) {
        const item = toIndexItem(noteId, merged, c);
        const pos = existingList.findIndex(n => n.id === noteId);
        if (pos !== -1) existingList[pos] = item;
        else existingList.push(item);
        t.set(catIndexRef(uid, c), { notes: existingList }, { merge: true });
        countUpdates[c] = existingList.length;
      } else {
        const filtered = existingList.filter(n => n.id !== noteId);
        t.set(catIndexRef(uid, c), { notes: filtered }, { merge: true });
        countUpdates[c] = filtered.length;
      }
    });

    if (Object.keys(countUpdates).length > 0) {
      t.set(metaRefOf(uid), { categoryCount: countUpdates }, { merge: true });
    }
  });
}

// 백그라운드 임베딩 생성/무효화 완료 시 카테고리 인덱스 내 해당 메모의 임베딩 메타데이터 동기화
export async function updateNoteIndexEmbeddingMeta(
  noteId: string,
  categories: string[],
  embeddingModel: string | null,
  embeddingUpdatedAt: Timestamp | null
) {
  if (!appState.currentUser || !noteId) return;
  const uid = appState.currentUser.uid;
  const targetCats = Array.from(new Set(categories.filter(c => c && c in CATEGORIES)));
  if (targetCats.length === 0) return;

  await runTransaction(db, async (t) => {
    const snaps = await Promise.all(targetCats.map(c => t.get(catIndexRef(uid, c))));
    targetCats.forEach((c, idx) => {
      const snap = snaps[idx];
      if (!snap.exists()) return;
      const existingList: NoteIndexItem[] = snap.data().notes || [];
      let changed = false;
      const updatedList = existingList.map(item => {
        if (item.id !== noteId) return item;
        changed = true;
        return {
          ...item,
          embeddingModel,
          embeddingUpdatedAt
        };
      });
      if (changed) {
        t.set(catIndexRef(uid, c), { notes: updatedList }, { merge: true });
      }
    });
  });
}

// 메모 삭제: 메모 문서 + 속해 있던 모든 카테고리 인덱스 + 카운트를 하나의 트랜잭션으로 처리
export async function deleteNoteWithIndex(noteId: string, oldNote: Partial<Note>) {
  const uid = requireUid();
  const oldCats = getNoteCategories(oldNote);

  await runTransaction(db, async (t) => {
    const snaps = await Promise.all(oldCats.map(c => t.get(catIndexRef(uid, c))));
    t.delete(doc(db, 'notes', noteId));
    const countUpdates: Record<string, any> = {};
    let wasRemovedFromAny = false;

    oldCats.forEach((c, idx) => {
      const snap = snaps[idx];
      const notesIndex: NoteIndexItem[] = snap.exists() ? (snap.data().notes || []) : [];
      const filtered = notesIndex.filter(n => n.id !== noteId);
      t.set(catIndexRef(uid, c), { notes: filtered }, { merge: true });
      countUpdates[c] = filtered.length;
      if (filtered.length !== notesIndex.length) {
        wasRemovedFromAny = true;
      }
    });

    const metaPayload: Record<string, any> = {};
    if (Object.keys(countUpdates).length > 0) {
      metaPayload.categoryCount = countUpdates;
    }
    if (wasRemovedFromAny) {
      metaPayload.totalNotesCount = increment(-1);
    }
    if (Object.keys(metaPayload).length > 0) {
      t.set(metaRefOf(uid), metaPayload, { merge: true });
    }
  });
}

// 카테고리 인덱스를 notes 컬렉션 기준으로 재구성 (단일 category + 복수 categories 모두 포함)
export async function rebuildCategoryIndex(catId: string) {
  const uid = requireUid();
  const qSingle = query(collection(db, 'notes'),
    where('uid', '==', uid),
    where('category', '==', catId));
  const qMulti = query(collection(db, 'notes'),
    where('uid', '==', uid),
    where('categories', 'array-contains', catId));
  const [snapSingle, snapMulti] = await Promise.all([getDocs(qSingle), getDocs(qMulti)]);
  const map = new Map<string, NoteIndexItem>();
  snapSingle.docs.forEach(d => map.set(d.id, toIndexItem(d.id, d.data(), catId)));
  snapMulti.docs.forEach(d => map.set(d.id, toIndexItem(d.id, d.data(), catId)));
  const notesIndex = Array.from(map.values());
  await setDoc(catIndexRef(uid, catId), { notes: notesIndex });
  await setDoc(metaRefOf(uid), { categoryCount: { [catId]: notesIndex.length } }, { merge: true });
}

export function subscribeUserMeta(onMetaChange: (categoryCount: Record<string, number>) => void) {
  if (!appState.currentUser) return () => {};
  return onSnapshot(metaRefOf(appState.currentUser.uid), snap => {
    if (!snap.exists()) {
      onMetaChange({});
      return;
    }
    const data = snap.data();
    const categoryCount: Record<string, number> = { ...(data.categoryCount || {}) };
    if (typeof data.totalNotesCount === 'number' && data.totalNotesCount >= 0) {
      categoryCount._total = data.totalNotesCount;
    }
    onMetaChange(categoryCount);
  });
}

// 실제 전체 인덱스 기준의 카테고리별 카운트 및 전체 고유 메모 수를 user_meta에 동기화 (오차 자동 보정용)
export async function syncUserMetaCounts(categoryCount: Record<string, number>, totalNotesCount: number) {
  if (!appState.currentUser) return;
  const cleanCategoryCount: Record<string, number> = {};
  for (const catId of Object.keys(CATEGORIES)) {
    cleanCategoryCount[catId] = Math.max(0, categoryCount[catId] || 0);
  }
  await setDoc(
    metaRefOf(appState.currentUser.uid),
    { categoryCount: cleanCategoryCount, totalNotesCount: Math.max(0, totalNotesCount) },
    { merge: true }
  );
}

// 9개 카테고리 인덱스를 모두 구독하여 병합 (복수 카테고리 메모는 ID 기준으로 중복 제거 후 병합)
// isComplete: 9개 카테고리 모두 에러 없이 로드 완료되었는지 여부
export function subscribeAllNotes(
  onIndexChange: (notes: NoteIndexItem[], isComplete: boolean, actualCatCounts?: Record<string, number>) => void
) {
  if (!appState.currentUser) return () => {};
  const uid = appState.currentUser.uid;
  const categoryKeys = Object.keys(CATEGORIES);
  const perCategory: Record<string, NoteIndexItem[]> = {};
  const initialLoaded = new Set<string>();
  const erroredCats = new Set<string>();
  let updateTimer: any = null;

  for (const cat of categoryKeys) {
    perCategory[cat] = [];
  }
  if (Array.isArray(appState.allNotesCache) && appState.allNotesCache.length > 0) {
    for (const n of appState.allNotesCache as NoteIndexItem[]) {
      for (const cat of getNoteCategories(n)) {
        if (perCategory[cat]) {
          perCategory[cat].push(n);
        }
      }
    }
  }

  const notifyMerged = () => {
    const byId = new Map<string, NoteIndexItem>();
    const actualCatCounts: Record<string, number> = {};
    for (const c of categoryKeys) {
      const seenInCat = new Set<string>();
      for (const item of perCategory[c] || []) {
        if (!item?.id) continue;
        seenInCat.add(item.id);
        const existing = byId.get(item.id);
        if (!existing) {
          const cats = getNoteCategories(item);
          byId.set(item.id, {
            ...item,
            categories: cats.includes(c) ? cats : [...cats, c],
          });
        } else {
          existing.categories = Array.from(new Set([...getNoteCategories(existing), ...getNoteCategories(item), c]));
          if (!existing.embeddingUpdatedAt && item.embeddingUpdatedAt) {
            existing.embeddingUpdatedAt = item.embeddingUpdatedAt;
            existing.embeddingModel = item.embeddingModel || existing.embeddingModel;
          }
        }
      }
      actualCatCounts[c] = seenInCat.size;
    }
    const isComplete = initialLoaded.size === categoryKeys.length && erroredCats.size === 0;
    onIndexChange(Array.from(byId.values()), isComplete, actualCatCounts);
  };

  const scheduleNotifyIfReady = () => {
    if (initialLoaded.size < categoryKeys.length) return;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(notifyMerged, 20);
  };

  const unsubs = categoryKeys.map(cat =>
    onSnapshot(
      catIndexRef(uid, cat),
      snap => {
        perCategory[cat] = snap.exists() ? (snap.data().notes || []) : [];
        erroredCats.delete(cat);
        initialLoaded.add(cat);
        scheduleNotifyIfReady();
      },
      err => {
        console.warn(`카테고리 인덱스 구독 오류 (${cat}):`, err);
        erroredCats.add(cat);
        initialLoaded.add(cat);
        scheduleNotifyIfReady();
      }
    )
  );

  return () => {
    if (updateTimer) clearTimeout(updateTimer);
    unsubs.forEach(u => u());
  };
}

// 단일 카테고리 인덱스 구독 (목록 화면용 — 본문 전체 문서를 읽지 않음)
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
