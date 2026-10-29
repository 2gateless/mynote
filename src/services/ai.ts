import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  Timestamp
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { appState } from '../state';
import {
  CATEGORIES,
  getNoteCategories,
  getNoteTags,
   getSingleNote,
  rebuildCategoryIndex
} from './database';
import { toMillis } from '../utils/formatter';
import { Note, NoteIndexItem } from '../types';

// ─────────────────────────────────────────────
// 상수 및 스토리지 키 정의
// ─────────────────────────────────────────────
const STORAGE_KEY_API = 'mynote_gemini_api_key';
const STORAGE_KEY_PROXY = 'mynote_ai_proxy_url';
const BOOTSTRAP_FLAG_PREFIX = 'mynote_ai_vec_init_v1_';

// IndexedDB 설정 (영구 로컬 벡터 & 본문 캐시 — 새로고침/재실행 시에도 Firestore 재조회 0회 보장)
const IDB_NAME = 'mynote_ai_vector_cache_db';
const IDB_VERSION = 1;
const IDB_STORE = 'note_vectors';

// 요구사항 1: Google Gemini text-embedding-004 기본 사용 (신규 키 호환용 폴백 포함)
const PRIMARY_EMBEDDING_MODEL = 'text-embedding-004';
const FALLBACK_EMBEDDING_MODEL = 'gemini-embedding-001';

// 요구사항 3: Gemini Flash 모델 (최신 Flash 모델 우선 + 자동 폴백)
const FLASH_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];

export interface SemanticSearchResult {
  note: Note;
  score: number; // 코사인 유사도 (0.0 ~ 1.0)
  hasEmbedding: boolean;
}

interface LocalVectorRecord {
  id: string;
  uid: string;
  embedding: number[];
  embeddingUpdatedMs: number;
  body?: string; // 상위 매칭된 메모의 본문 캐시 (반복 조회 시 읽기 비용 0)
}

// 세션 인메모리 캐시 (IndexedDB와 1:1 동기화)
let memoryVectorMap: Map<string, LocalVectorRecord> | null = null;
let memoryVectorUid: string | null = null;
let idbPromise: Promise<IDBDatabase | null> | null = null;

// ─────────────────────────────────────────────
// 0. IndexedDB 영구 로컬 벡터 캐시 레이어
// ─────────────────────────────────────────────

function openVectorIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (idbPromise) return idbPromise;

  idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const dbInst = req.result;
        if (!dbInst.objectStoreNames.contains(IDB_STORE)) {
          dbInst.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

async function loadVectorsFromIdb(uid: string): Promise<Map<string, LocalVectorRecord>> {
  const map = new Map<string, LocalVectorRecord>();
  const idb = await openVectorIdb();
  if (!idb) return map;

  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result || []) as LocalVectorRecord[];
        for (const r of rows) {
          if (r && r.uid === uid && Array.isArray(r.embedding) && r.embedding.length > 0) {
            map.set(r.id, r);
          }
        }
        resolve(map);
      };
      req.onerror = () => resolve(map);
    } catch {
      resolve(map);
    }
  });
}

async function putVectorsToIdb(records: LocalVectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const idb = await openVectorIdb();
  if (!idb) return;

  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      for (const r of records) {
        store.put(r);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function deleteVectorFromIdb(noteId: string): Promise<void> {
  const idb = await openVectorIdb();
  if (!idb) return;

  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(noteId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ─────────────────────────────────────────────
// 1. 안전한 API 키 / 프록시 설정 관리
// ─────────────────────────────────────────────

export function getGeminiApiKey(): string {
  try {
    const envKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (envKey && typeof envKey === 'string' && envKey.trim()) {
      return envKey.trim();
    }
    return (localStorage.getItem(STORAGE_KEY_API) || '').trim();
  } catch {
    return '';
  }
}

export function getAiProxyUrl(): string {
  try {
    const envProxy = (import.meta as any).env?.VITE_AI_PROXY_URL;
    if (envProxy && typeof envProxy === 'string' && envProxy.trim()) {
      return envProxy.trim();
    }
    return (localStorage.getItem(STORAGE_KEY_PROXY) || '').trim();
  } catch {
    return '';
  }
}

export function hasAiCredentials(): boolean {
  return Boolean(getAiProxyUrl() || getGeminiApiKey());
}

export async function saveAiConfig(apiKey: string, proxyUrl = '', syncToCloud = true): Promise<void> {
  const cleanKey = apiKey.trim();
  const cleanProxy = proxyUrl.trim();
  try {
    if (cleanKey) localStorage.setItem(STORAGE_KEY_API, cleanKey);
    else localStorage.removeItem(STORAGE_KEY_API);

    if (cleanProxy) localStorage.setItem(STORAGE_KEY_PROXY, cleanProxy);
    else localStorage.removeItem(STORAGE_KEY_PROXY);
  } catch (e) {
    console.warn('로컬 스토리지 AI 설정 저장 오류:', e);
  }

  if (syncToCloud && appState.currentUser) {
    try {
      await setDoc(
        doc(db, 'user_meta', appState.currentUser.uid),
        {
          geminiApiKey: cleanKey || null,
          aiProxyUrl: cleanProxy || null
        },
        { merge: true }
      );
    } catch (e) {
      console.warn('Firestore AI 설정 동기화 오류:', e);
    }
  }
}

export async function syncAiConfigFromUserMeta(): Promise<void> {
  if (!appState.currentUser) return;
  if (getGeminiApiKey() || getAiProxyUrl()) return;
  try {
    const snap = await getDoc(doc(db, 'user_meta', appState.currentUser.uid));
    if (!snap.exists()) return;
    const data = snap.data();
    if (typeof data.geminiApiKey === 'string' && data.geminiApiKey.trim()) {
      localStorage.setItem(STORAGE_KEY_API, data.geminiApiKey.trim());
    }
    if (typeof data.aiProxyUrl === 'string' && data.aiProxyUrl.trim()) {
      localStorage.setItem(STORAGE_KEY_PROXY, data.aiProxyUrl.trim());
    }
  } catch (e) {
    console.warn('AI 설정 복원 실패:', e);
  }
}

// ─────────────────────────────────────────────
// 2. 텍스트 전처리 및 Gemini 임베딩 API 호출
// ─────────────────────────────────────────────

export function cleanTextForEmbedding(raw: string, maxChars = 6000): string {
  if (!raw) return '';
  return raw
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function buildNoteEmbeddingInput(noteData: Partial<Note>): string {
  const title = (noteData.title || '').trim();
  const cats = getNoteCategories(noteData)
    .map(cid => CATEGORIES[cid]?.name || cid)
    .filter(Boolean)
    .join(', ');
  const tags = getNoteTags(noteData).join(', ');
  const keywords = (noteData.keywords || '').trim();
  const body = cleanTextForEmbedding(noteData.body || '');

  const parts: string[] = [];
  if (title) parts.push(`제목: ${title}`);
  if (cats) parts.push(`카테고리: ${cats}`);
  if (tags) parts.push(`태그: ${tags}`);
  if (keywords) parts.push(`키워드: ${keywords}`);
  if (body) parts.push(`내용: ${body}`);

  return parts.join('\n').trim();
}

export async function generateTextEmbedding(
  text: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'
): Promise<number[]> {
  const cleaned = cleanTextForEmbedding(text);
  if (!cleaned) {
    throw new Error('임베딩할 텍스트가 비어 있습니다.');
  }

  const proxyUrl = getAiProxyUrl();
  if (proxyUrl) {
    const idToken = await auth.currentUser?.getIdToken();
    const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
      },
      body: JSON.stringify({
        model: PRIMARY_EMBEDDING_MODEL,
        text: cleaned,
        taskType
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`임베딩 프록시 오류 (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const values = data?.embedding?.values || data?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('프록시에서 유효한 임베딩 벡터를 받지 못했습니다.');
    }
    return values;
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('AI 기능을 사용하려면 먼저 Gemini API 키를 설정해주세요.');
  }

  const callEmbedModel = async (modelName: string): Promise<Response> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${encodeURIComponent(apiKey)}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${modelName}`,
        content: {
          parts: [{ text: cleaned }]
        },
        taskType
      })
    });
  };

  let res = await callEmbedModel(PRIMARY_EMBEDDING_MODEL);
  if (res.status === 404) {
    res = await callEmbedModel(FALLBACK_EMBEDDING_MODEL);
  }

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      errMsg = errJson?.error?.message || errMsg;
    } catch {}
    throw new Error(`Gemini 임베딩 오류: ${errMsg}`);
  }

  const json = await res.json();
  const values = json?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('임베딩 결과가 비어 있습니다.');
  }
  return values as number[];
}

export async function tryGenerateNoteEmbedding(noteData: Partial<Note>): Promise<number[] | null> {
  if (!hasAiCredentials()) return null;
  try {
    const input = buildNoteEmbeddingInput(noteData);
    if (!input) return null;
    return await generateTextEmbedding(input, 'RETRIEVAL_DOCUMENT');
  } catch (e) {
    console.warn('메모 저장 중 임베딩 생성 건너뜀 (메모 본문은 정상 저장됩니다):', e);
    return null;
  }
}

// ─────────────────────────────────────────────
// 3. 코사인 유사도 & 최소 읽기(Delta Sync + 로컬 캐시) 벡터 검색
// ─────────────────────────────────────────────

export function cosineSimilarity(vecA?: number[] | null, vecB?: number[] | null): number {
  if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
  if (vecA.length === 0 || vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

/**
 * 메모 생성/수정 시 로컬 메모리 + IndexedDB 영구 캐시에 즉시 반영합니다.
 * (다음 검색 시 Firestore를 다시 읽지 않도록 비용 절감)
 */
export function upsertVectorNoteCache(note: Note) {
  const uid = appState.currentUser?.uid || note.uid;
  if (!note.id || !uid) return;
  if (!Array.isArray(note.embedding) || note.embedding.length === 0) return;

  const rec: LocalVectorRecord = {
    id: note.id,
    uid,
    embedding: note.embedding,
    embeddingUpdatedMs: toMillis(note.embeddingUpdatedAt) || Date.now(),
    body: typeof note.body === 'string' ? note.body : undefined
  };

  if (memoryVectorMap && memoryVectorUid === uid) {
    memoryVectorMap.set(note.id, rec);
  }
  putVectorsToIdb([rec]).catch(() => {});
}

/**
 * 메모 삭제 시 로컬 메모리 + IndexedDB 캐시에서 제거합니다.
 */
export function removeVectorNoteCache(noteId: string) {
  if (memoryVectorMap) {
    memoryVectorMap.delete(noteId);
  }
  deleteVectorFromIdb(noteId).catch(() => {});
}

/**
 * 전체 문서를 매번 Firestore에서 반복 조회하지 않도록:
 * 1) IndexedDB에 영구 저장된 로컬 벡터 맵을 먼저 불러오고 (Firestore 읽기 0건),
 * 2) 이미 메모리에 로드된 인덱스(appState.allNotesCache)의 embeddingUpdatedAt과 비교하여
 *    다른 기기에서 새로 추가/수정되어 로컬 캐시에 없거나 구버전인 메모 ID만 단건 조회(Delta Fetch)합니다.
 */
async function ensureLocalVectorsSynced(): Promise<Map<string, LocalVectorRecord>> {
  const uid = appState.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');

  // 1) 인메모리 맵이 비어 있으면 먼저 로컬 IndexedDB에서 복원 (네트워크 읽기 0건)
  if (!memoryVectorMap || memoryVectorUid !== uid) {
    memoryVectorMap = await loadVectorsFromIdb(uid);
    memoryVectorUid = uid;
  }

  const indexItems = (appState.allNotesCache as NoteIndexItem[]) || [];
  const bootstrapKey = `${BOOTSTRAP_FLAG_PREFIX}${uid}`;
  const isBootstrapped = localStorage.getItem(bootstrapKey) === '1';

  // 기기 최초 1회: 로컬 IndexedDB가 완전히 비어 있고 아직 초기 동기화 이력이 없을 때만 1회 초기화
  if (memoryVectorMap.size === 0 && !isBootstrapped) {
    const q = query(collection(db, 'notes'), where('uid', '==', uid));
    const snap = await getDocs(q);
    const toSave: LocalVectorRecord[] = [];
    snap.docs.forEach(d => {
      const data = d.data();
      if (Array.isArray(data.embedding) && data.embedding.length > 0) {
        const rec: LocalVectorRecord = {
          id: d.id,
          uid,
          embedding: data.embedding,
          embeddingUpdatedMs: toMillis(data.embeddingUpdatedAt) || toMillis(data.updatedAt) || Date.now(),
          body: typeof data.body === 'string' ? data.body : undefined
        };
        memoryVectorMap!.set(d.id, rec);
        toSave.push(rec);
      }
    });
    if (toSave.length > 0) {
      await putVectorsToIdb(toSave);
    }
    try {
      localStorage.setItem(bootstrapKey, '1');
    } catch {}
    return memoryVectorMap;
  }

  // 2) 증분 동기화(Delta Sync): 인덱스(allNotesCache)에서 embeddingUpdatedAt이 갱신된 문서만 선별하여 단건 조회
  //    변경된 메모가 없으면 Firestore 읽기 횟수 = 0건!
  const staleNoteIds: string[] = [];
  for (const item of indexItems) {
    const idxEmbMs = toMillis(item.embeddingUpdatedAt);
    if (!idxEmbMs) continue; // 인덱스에 임베딩 타임스탬프가 없으면 불필요한 조회 생략
    const localRec = memoryVectorMap.get(item.id);
    if (!localRec || localRec.embeddingUpdatedMs < idxEmbMs) {
      staleNoteIds.push(item.id);
    }
  }

  if (staleNoteIds.length > 0) {
    const fetchedRecords: LocalVectorRecord[] = [];
    // 변경된 소수의 메모만 개별 문서 조회
    await Promise.all(
      staleNoteIds.map(async (noteId) => {
        try {
          const snap = await getDoc(doc(db, 'notes', noteId));
          if (!snap.exists()) return;
          const data = snap.data();
          if (Array.isArray(data.embedding) && data.embedding.length > 0) {
            const rec: LocalVectorRecord = {
              id: snap.id,
              uid,
              embedding: data.embedding,
              embeddingUpdatedMs: toMillis(data.embeddingUpdatedAt) || Date.now(),
              body: typeof data.body === 'string' ? data.body : undefined
            };
            memoryVectorMap!.set(snap.id, rec);
            fetchedRecords.push(rec);
          }
        } catch (e) {
          console.warn(`벡터 증분 동기화 실패 (${noteId}):`, e);
        }
      })
    );
    if (fetchedRecords.length > 0) {
      await putVectorsToIdb(fetchedRecords);
    }
  }

  return memoryVectorMap;
}

/**
 * 요구사항 2 (읽기 비용 극대화 절감 버전):
 * - 전체 문서를 Firestore에서 읽지 않고 로컬 캐시(allNotesCache + IndexedDB 벡터)만으로
 *   100% 로컬에서 코사인 유사도를 고속 계산하여 상위 topK(3~5개)를 추출합니다.
 * - 추출된 상위 3~5개 메모에 한해서만(잠금 메모 제외, snippet이 짧은 메모 제외)
 *   로컬에 본문이 없을 때 최소한으로 단건 조회하여 캐싱합니다.
 */
export async function semanticSearchNotes(
  queryText: string,
  topK = 5
): Promise<{
  results: SemanticSearchResult[];
  totalNotesCount: number;
  embeddedNotesCount: number;
}> {
  const cleanQuery = queryText.trim();
  if (!cleanQuery) {
    return { results: [], totalNotesCount: 0, embeddedNotesCount: 0 };
  }

  // 1) 질문 임베딩 생성 + 로컬 벡터 캐시 증분 확인 (변경분 없으면 Firestore 읽기 0회)
  const [queryVector, vectorMap] = await Promise.all([
    generateTextEmbedding(cleanQuery, 'RETRIEVAL_QUERY'),
    ensureLocalVectorsSynced()
  ]);

  const indexItems = (appState.allNotesCache as NoteIndexItem[]) || [];
  const queryTerms = cleanQuery
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);

  let embeddedNotesCount = 0;

  // 2) 전체 메모 스코어링은 Firestore 조회 없이 100% 로컬 메모리에서 수행
  const scored: SemanticSearchResult[] = indexItems.map(idxItem => {
    const vecRec = vectorMap.get(idxItem.id);
    const hasEmb = Boolean(vecRec && vecRec.embedding.length === queryVector.length);
    if (hasEmb) embeddedNotesCount++;

    let score = hasEmb ? cosineSimilarity(queryVector, vecRec!.embedding) : 0;

    if (queryTerms.length > 0) {
      const hayTitle = `${idxItem.title || ''} ${getNoteTags(idxItem).join(' ')} ${idxItem.keywords || ''}`.toLowerCase();
      const haySnippet = (vecRec?.body || idxItem.snippet || '').toLowerCase();
      let matchedTerms = 0;
      for (const term of queryTerms) {
        if (hayTitle.includes(term)) matchedTerms += 1.0;
        else if (haySnippet.includes(term)) matchedTerms += 0.4;
      }
      const lexicalBoost = Math.min(0.08, (matchedTerms / queryTerms.length) * 0.08);
      if (hasEmb) {
        score = Math.min(0.999, score + lexicalBoost);
      } else if (matchedTerms > 0) {
        score = Math.min(0.55, 0.35 + (matchedTerms / queryTerms.length) * 0.2);
      }
    }

    const candidateNote: Note = {
      id: idxItem.id,
      uid: appState.currentUser?.uid || '',
      title: idxItem.title || '',
      category: idxItem.category || '',
      categories: getNoteCategories(idxItem),
      tag: idxItem.tag || '',
      tags: getNoteTags(idxItem),
      // 로컬 벡터 레코드에 이미 본문이 캐시되어 있으면 바로 사용, 없으면 우선 snippet(200자) 사용
      body: vecRec?.body ?? (idxItem.snippet || ''),
      keywords: idxItem.keywords || '',
      locked: !!idxItem.locked,
      pinned: !!idxItem.pinned,
      createdAt: idxItem.createdAt || undefined
    };

    return {
      note: candidateNote,
      score,
      hasEmbedding: hasEmb
    };
  });

  // 3) 상위 topK(3~5개) 메모만 고속 추출
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.filter(item => item.score >= 0.25).slice(0, topK);

  // 4) 상위 일치 문서(최대 3~5개)만 본문 최소 조회 (On-Demand Top-K Hydration)
  //    - 잠금 메모(locked)는 RAG에 본문을 보내지 않으므로 조회 생략 (0건)
  //    - 이미 로컬 캐시에 본문이 있거나, snippet 길이가 200자 미만(즉 snippet이 곧 전문)이면 조회 생략 (0건)
  const updatedForIdb: LocalVectorRecord[] = [];
  await Promise.all(
    topResults.map(async (resItem) => {
      const n = resItem.note;
      if (!n.id || n.locked) return;
      const vecRec = vectorMap.get(n.id);
      if (vecRec?.body !== undefined) {
        n.body = vecRec.body;
        return;
      }
      // 인덱스 스니펫이 200자 미만이면 잘린 부분이 없으므로 Firestore 조회 불필요
      if ((n.body || '').length < 200) {
        if (vecRec) {
          vecRec.body = n.body;
          updatedForIdb.push(vecRec);
        }
        return;
      }
      // 상위 매칭된 긴 메모만 단건 조회 (getSingleNote는 Firestore persistentLocalCache도 활용)
      try {
        const fullNote = await getSingleNote(n.id);
        if (fullNote && typeof fullNote.body === 'string') {
          n.body = fullNote.body;
          if (vecRec) {
            vecRec.body = fullNote.body;
            updatedForIdb.push(vecRec);
          } else if (Array.isArray(fullNote.embedding) && fullNote.embedding.length > 0) {
            const newRec: LocalVectorRecord = {
              id: n.id,
              uid: fullNote.uid || appState.currentUser?.uid || '',
              embedding: fullNote.embedding,
              embeddingUpdatedMs: toMillis(fullNote.embeddingUpdatedAt) || Date.now(),
              body: fullNote.body
            };
            vectorMap.set(n.id, newRec);
            updatedForIdb.push(newRec);
          }
        }
      } catch (e) {
        console.warn(`상위 메모 본문 단건 조회 실패 (${n.id}):`, e);
      }
    })
  );

  if (updatedForIdb.length > 0) {
    putVectorsToIdb(updatedForIdb).catch(() => {});
  }

  return {
    results: topResults,
    totalNotesCount: indexItems.length,
    embeddedNotesCount
  };
}

// ─────────────────────────────────────────────
// 4. 요구사항 3: AI 종합 및 추론 모드 (RAG — Gemini Flash)
// ─────────────────────────────────────────────

export async function generateRagAnswer(
  userQuery: string,
  topResults: SemanticSearchResult[]
): Promise<string> {
  if (topResults.length === 0) {
    return '연관된 메모를 찾지 못해 종합 답변을 생성할 수 없습니다.';
  }

  const unlockedResults = topResults.filter(r => !r.note.locked);
  const lockedCount = topResults.length - unlockedResults.length;

  if (unlockedResults.length === 0 && lockedCount > 0) {
    return '검색된 상위 메모가 모두 🔒 잠금 상태입니다. 아래 검색 결과에서 메모를 눌러 잠금을 해제한 뒤 확인해 주세요.';
  }

  const contextBlocks = unlockedResults.map((item, idx) => {
    const n = item.note;
    const cats = getNoteCategories(n)
      .map(cid => CATEGORIES[cid]?.name || cid)
      .filter(Boolean)
      .join(', ');
    const tags = getNoteTags(n).map(t => `#${t}`).join(' ');
    const simPct = Math.round(item.score * 100);
    const bodyText = (n.body || '').slice(0, 3500);
    return [
      `[메모 ${idx + 1}] (유사도: ${simPct}%)`,
      `- 제목: ${n.title || '제목 없음'}`,
      `- 카테고리: ${cats || '미분류'}${tags ? ` | 태그: ${tags}` : ''}`,
      `- 키워드: ${n.keywords || '없음'}`,
      `- 본문:\n${bodyText}`
    ].join('\n');
  }).join('\n\n────────────────────────\n\n');

  const systemInstruction = [
    '당신은 사용자의 개인 메모장(MyNote)을 기반으로 질문에 답변하고 내용을 요약·비교·추론해 주는 지능형 AI 비서입니다.',
    '반드시 한국어로 명확하고 읽기 쉽게 답변하세요.',
    '규칙:',
    '1. 제공된 [참고 메모 컨텍스트]의 내용을 최우선 근거로 삼아 사용자의 질문에 맞게 핵심 요약, 비교 분석, 또는 논리적 추론을 수행하세요.',
    '2. 답변에서 특정 메모를 인용하거나 언급할 때는 반드시 [[메모 제목]] 형식으로 표기하세요. (앱에서 클릭 가능한 링크로 변환됩니다)',
    '3. 메모에 직접 적혀 있지 않은 내용은 추측하지 말고, 메모들의 내용을 바탕으로 합리적으로 추론한 부분과 실제 기록된 사실을 구분해 설명하세요.',
    '4. 마크다운 글머리 기호(-), 굵은 글씨(**) 등을 활용해 모바일과 PC 화면 모두에서 한눈에 들어오도록 구조화하세요.'
  ].join('\n');

  const promptText = [
    `[사용자 질문 / 검색 의도]\n${userQuery}`,
    lockedCount > 0 ? `\n(참고: 검색된 상위 메모 중 ${lockedCount}건은 잠금 상태여서 컨텍스트에서 제외되었습니다.)` : '',
    `\n[참고 메모 컨텍스트 (상위 ${unlockedResults.length}개 메모)]\n${contextBlocks}`,
    '\n위 메모들을 종합하여 사용자의 질문에 대해 요약·비교·추론한 답변을 작성해 주세요.'
  ].join('\n');

  const proxyUrl = getAiProxyUrl();
  if (proxyUrl) {
    const idToken = await auth.currentUser?.getIdToken();
    const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
      },
      body: JSON.stringify({
        systemInstruction,
        prompt: promptText
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`AI 추론 프록시 오류 (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return data?.text || data?.answer || '답변을 생성하지 못했습니다.';
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Gemini API 키가 설정되지 않았습니다.');
  }

  let lastError = '';
  for (const model of FLASH_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: promptText }]
            }
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1500
          }
        })
      });

      if (res.status === 404 || res.status === 400) {
        const errJson = await res.json().catch(() => ({}));
        lastError = errJson?.error?.message || `HTTP ${res.status}`;
        continue;
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || `HTTP ${res.status}`);
      }

      const json = await res.json();
      const answer = json?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text || '')
        .join('')
        .trim();

      if (answer) return answer;
    } catch (e: any) {
      lastError = e?.message || String(e);
    }
  }

  throw new Error(`AI 종합 답변 생성 실패: ${lastError}`);
}

// ─────────────────────────────────────────────
// 5. 기존 메모 일괄 임베딩 생성 (로컬 캐시 활용으로 불필요한 조회 최소화)
// ─────────────────────────────────────────────

export async function backfillMissingEmbeddings(
  onProgress?: (done: number, total: number, currentTitle: string) => void
): Promise<{ updated: number; skipped: number; failed: number }> {
  const uid = appState.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');

  const vectorMap = await ensureLocalVectorsSynced();
  const q = query(collection(db, 'notes'), where('uid', '==', uid));
  const snap = await getDocs(q);

  const allDocs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as Note));
  const targets = allDocs.filter(n => !Array.isArray(n.embedding) || n.embedding.length === 0);

  // 이미 Firestore에 임베딩이 있던 문서들도 로컬 IndexedDB에 누락 없이 채워 넣음
  const existingVecRecords: LocalVectorRecord[] = [];
  for (const n of allDocs) {
    if (n.id && Array.isArray(n.embedding) && n.embedding.length > 0 && !vectorMap.has(n.id)) {
      const rec: LocalVectorRecord = {
        id: n.id,
        uid,
        embedding: n.embedding,
        embeddingUpdatedMs: toMillis(n.embeddingUpdatedAt) || Date.now(),
        body: typeof n.body === 'string' ? n.body : undefined
      };
      vectorMap.set(n.id, rec);
      existingVecRecords.push(rec);
    }
  }
  if (existingVecRecords.length > 0) {
    await putVectorsToIdb(existingVecRecords);
  }

  let updated = 0;
  let failed = 0;
  const skipped = allDocs.length - targets.length;
  const touchedCategories = new Set<string>();

  for (let i = 0; i < targets.length; i++) {
    const note = targets[i];
    if (!note.id) continue;
    onProgress?.(i + 1, targets.length, note.title || '제목 없음');
    try {
      const input = buildNoteEmbeddingInput(note);
      if (!input) continue;
      const embedding = await generateTextEmbedding(input, 'RETRIEVAL_DOCUMENT');
      const now = Timestamp.now();
      await updateDoc(doc(db, 'notes', note.id), {
        embedding,
        embeddingUpdatedAt: now
      });
      note.embedding = embedding;
      note.embeddingUpdatedAt = now;
      upsertVectorNoteCache(note);
      getNoteCategories(note).forEach(c => touchedCategories.add(c));
      updated++;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.warn(`메모 임베딩 생성 실패 (${note.id}):`, e);
      failed++;
    }
  }

  // 변경된 카테고리의 인덱스를 갱신하여 embeddingUpdatedAt 타임스탬프를 인덱스에 반영
  for (const catId of touchedCategories) {
    try {
      await rebuildCategoryIndex(catId);
    } catch (e) {
      console.warn(`카테고리 인덱스 갱신 실패 (${catId}):`, e);
    }
  }

  try {
    localStorage.setItem(`${BOOTSTRAP_FLAG_PREFIX}${uid}`, '1');
  } catch {}

  return { updated, skipped, failed };
}
