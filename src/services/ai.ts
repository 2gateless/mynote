import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
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
import { fmtDate, toMillis } from '../utils/formatter';
import { Note, NoteIndexItem } from '../types';

// ─────────────────────────────────────────────
// 상수 및 스토리지 키 정의
// ─────────────────────────────────────────────
const STORAGE_KEY_API = 'mynote_gemini_api_key';
const STORAGE_KEY_PROXY = 'mynote_ai_proxy_url';
// v2: 임베딩 모델 교체(gemini-embedding-001@768)에 따라 기기별 초기 동기화를 1회 다시 수행
const BOOTSTRAP_FLAG_PREFIX = 'mynote_ai_vec_init_v2_';

// IndexedDB 설정 (영구 로컬 벡터 & 본문 캐시 — 새로고침/재실행 시에도 Firestore 재조회 0회 보장)
const IDB_NAME = 'mynote_ai_vector_cache_db';
const IDB_VERSION = 1;
const IDB_STORE = 'note_vectors';

// 임베딩 모델: text-embedding-004는 2026-01-14 서비스 종료되어 gemini-embedding-001로 교체.
// gemini-embedding-001의 기본 차원은 3072이므로 outputDimensionality로 768차원에 고정한다.
// ※ 모델이 다르면 차원이 같아도 벡터 공간이 달라 서로 비교할 수 없으므로,
//    메모마다 embeddingModel(= EMBEDDING_VERSION)을 저장하고 버전이 다른 벡터는 검색에서 제외한다.
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIM = 768;
export const EMBEDDING_VERSION = `${EMBEDDING_MODEL}@${EMBEDDING_DIM}`;

// 일괄 변환 시 한 번의 batchEmbedContents 요청에 담을 메모 수 (무료 등급 TPM 한도를 고려해 작게 유지)
const EMBED_BATCH_SIZE = 10;
// 429(할당량 초과) 응답 시 재시도 횟수
const EMBED_MAX_RETRIES = 4;

/** 현재 앱이 사용하는 모델·차원으로 생성된 벡터인지 확인 */
export function isCurrentEmbedding(model: unknown, embedding: unknown): embedding is number[] {
  return model === EMBEDDING_VERSION && Array.isArray(embedding) && embedding.length === EMBEDDING_DIM;
}

// 요구사항 3: Gemini Flash 모델 (최신 정식 식별자 및 -latest 별칭 우선 + 동적 ListModels 자동 탐색 지원)
const FLASH_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
];

// 성공한 생성 모델을 세션 내 캐시하여 다음 호출 시 지연 없이 즉시 사용
let cachedWorkingFlashModel: string | null = null;

// 동일 질문 재검색 시 API 호출 및 지연을 0ms로 줄이기 위한 LRU 캐시 (최대 30개)
const QUERY_EMBED_CACHE_MAX = 30;
const queryEmbeddingCache = new Map<string, number[]>();

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
  model?: string; // EMBEDDING_VERSION (구버전 레코드에는 없음 → 로드 시 폐기)
  body?: string; // 상위 매칭된 메모의 본문 캐시 (반복 조회 시 읽기 비용 0, 잠금 메모는 저장하지 않음)
}

// Firestore 메모 데이터 → 로컬 벡터 레코드 (현재 버전 임베딩이 아니면 null, 잠금 메모는 본문 미보관)
function toVectorRecord(id: string, uid: string, data: any): LocalVectorRecord | null {
  if (!isCurrentEmbedding(data?.embeddingModel, data?.embedding)) return null;
  return {
    id,
    uid,
    embedding: data.embedding,
    embeddingUpdatedMs: toMillis(data.embeddingUpdatedAt) || toMillis(data.updatedAt) || Date.now(),
    model: EMBEDDING_VERSION,
    body: !data.locked && typeof data.body === 'string' ? data.body : undefined
  };
}

// 세션 인메모리 캐시 (IndexedDB와 1:1 동기화)
let memoryVectorMap: Map<string, LocalVectorRecord> | null = null;
let memoryVectorUid: string | null = null;
let idbPromise: Promise<IDBDatabase | null> | null = null;
let syncPromise: Promise<Map<string, LocalVectorRecord>> | null = null;

/**
 * 로그아웃 시 메모리 및 IndexedDB에 저장된 벡터·본문 캐시를 정리합니다.
 */
export async function clearAiLocalCache(clearCredentials = false): Promise<void> {
  memoryVectorMap = null;
  memoryVectorUid = null;
  queryEmbeddingCache.clear();
  cachedWorkingFlashModel = null;
  syncPromise = null;

  try {
    const idb = await openVectorIdb();
    if (idb) {
      await new Promise<void>((resolve) => {
        try {
          const tx = idb.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
  } catch (e) {
    console.warn('IndexedDB 벡터 캐시 초기화 실패:', e);
  }

  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith(BOOTSTRAP_FLAG_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
    if (clearCredentials) {
      localStorage.removeItem(STORAGE_KEY_API);
      localStorage.removeItem(STORAGE_KEY_PROXY);
    }
  } catch (e) {}
}

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
        const staleIds: string[] = [];
        for (const r of rows) {
          if (!r) continue;
          if (r.uid === uid && isCurrentEmbedding(r.model, r.embedding)) {
            map.set(r.id, r);
          } else if (r.uid === uid) {
            // 구버전 모델(text-embedding-004 등) 벡터는 현재 질문 벡터와 비교할 수 없으므로 폐기
            staleIds.push(r.id);
          }
        }
        if (staleIds.length > 0) {
          deleteVectorsFromIdb(staleIds).catch(() => {});
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
  return deleteVectorsFromIdb([noteId]);
}

async function deleteVectorsFromIdb(noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  const idb = await openVectorIdb();
  if (!idb) return;

  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      for (const id of noteIds) store.delete(id);
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

export async function saveAiConfig(apiKey: string, proxyUrl = '', syncToCloud = false): Promise<void> {
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

  if (appState.currentUser) {
    try {
      if (syncToCloud) {
        await setDoc(
          doc(db, 'user_meta', appState.currentUser.uid),
          {
            geminiApiKey: cleanKey || null,
            aiProxyUrl: cleanProxy || null
          },
          { merge: true }
        );
      } else {
        // 보안: 클라우드 동기화를 끈 경우 user_meta에서 API 키 필드를 완전히 삭제(null 처리)
        await setDoc(
          doc(db, 'user_meta', appState.currentUser.uid),
          {
            geminiApiKey: null,
            aiProxyUrl: null
          },
          { merge: true }
        );
      }
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

// gemini-embedding-001의 입력 한도(2,048 토큰)를 고려하여 4,200자까지 수용하되,
// 긴 메모의 경우 앞부분(75%)과 뒷부분 결론/요약(25%)이 모두 반영되도록 축약
export function cleanTextForEmbedding(raw: string, maxChars = 4200): string {
  if (!raw) return '';
  const cleaned = raw
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const headLen = Math.floor(maxChars * 0.75);
  const tailLen = maxChars - headLen - 5;
  return `${cleaned.slice(0, headLen)} ... ${cleaned.slice(cleaned.length - tailLen)}`;
}

// 한국어 자연어 질문에서 문장부호를 제거하고 핵심 어근(조사/어미 제거본 포함) 그룹을 추출
const KO_SUFFIX_RE =
  /(?:이라서|이라고|이라는|이라도|이라며|인가요|할까요|일까요|였나요|였는지|인지요|에서부터|으로부터|에게서|한테서|에서는|으로는|에게는|한테는|이라도|이지만|이니까|이므로|이라|이란|이나|이며|이고|이야|이지|인가|인지|였지|였나|는데|은데|던데|나요|가요|까요|어요|아요|해요|세요|줘요|해줘|알려줘|찾아줘|정리해줘|비교해줘|요약해줘|에서|에게|한테|으로|부터|까지|처럼|같이|보다|마다|조차|마저|밖에|대로|만큼|은|는|이|가|을|를|의|에|로|와|과|도|만|란|나|며|고|야|지)$/;

export function extractQueryTermGroups(query: string): string[][] {
  const cleaned = query
    .toLowerCase()
    .replace(/[?!.,;:'"“”‘’()\[\]{}<>~`@#$%^&*+=|/\\]+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const rawWords = cleaned.split(/\s+/).filter(Boolean);
  const groups: string[][] = [];
  const seen = new Set<string>();

  // 불용어(의문사/일반 서술어 등 단독 매칭 가치가 낮은 단어) 제외
  const stopWords = new Set([
    '뭐야', '뭔가', '무엇', '어디', '언제', '어떻게', '얼마', '누구',
    '있나', '있어', '없는', '없어', '알려', '찾아', '정리', '메모', '내용', '관련', '대한', '대해'
  ]);

  for (const word of rawWords) {
    if (word.length < 2) continue;
    const stripped = word.replace(KO_SUFFIX_RE, '');
    const stem = stripped.length >= 2 ? stripped : word;
    if (stopWords.has(word) && stopWords.has(stem)) continue;

    const key = stem;
    if (seen.has(key)) continue;
    seen.add(key);

    const variants = stem !== word ? [stem, word] : [word];
    groups.push(variants);
  }
  return groups;
}

export function buildNoteEmbeddingInput(noteData: Partial<Note>): string {
  const title = (noteData.title || '').trim();
  const cats = getNoteCategories(noteData)
    .map(cid => CATEGORIES[cid]?.name || cid)
    .filter(Boolean)
    .join(', ');
  const tags = getNoteTags(noteData).join(', ');
  const keywords = (noteData.keywords || '').trim();
  // 잠금 메모(locked: true)는 외부 AI API에 본문을 전송하지 않고 제목/카테고리/태그/키워드로만 임베딩 생성 (보안 강화)
  const isLocked = Boolean(noteData.locked);
  const body = isLocked ? '' : cleanTextForEmbedding(noteData.body || '');

  const parts: string[] = [];
  if (title) parts.push(`제목: ${title}`);
  if (cats) parts.push(`카테고리: ${cats}`);
  if (tags) parts.push(`태그: ${tags}`);
  if (keywords) parts.push(`키워드: ${keywords}`);
  if (body) parts.push(`내용: ${body}`);

  return parts.join('\n').trim();
}

type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// 429 응답의 RetryInfo(예: "retryDelay": "23s")에서 대기 시간을 읽어옴 (없으면 null)
function parseRetryDelayMs(errJson: any): number | null {
  const details = errJson?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const raw = d?.retryDelay;
    if (typeof raw === 'string') {
      const sec = parseFloat(raw);
      if (!Number.isNaN(sec)) return Math.ceil(sec * 1000);
    }
  }
  return null;
}

// 429(할당량 초과)/503(일시 과부하)에 한해 지수 백오프로 재시도. 그 외 오류는 즉시 throw
async function postGeminiWithRetry(url: string, body: unknown, apiKey: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    });
    if (res.ok) return res.json();

    const errJson = await res.json().catch(() => ({}));
    const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
    const retryable = res.status === 429 || res.status === 503;
    if (!retryable || attempt >= EMBED_MAX_RETRIES) {
      const err: any = new Error(`Gemini 임베딩 오류 (${res.status}): ${errMsg}`);
      err.status = res.status;
      throw err;
    }
    const waitMs = parseRetryDelayMs(errJson) ?? Math.min(60000, 5000 * 2 ** attempt);
    console.warn(`임베딩 API ${res.status} — ${Math.round(waitMs / 1000)}초 후 재시도 (${attempt + 1}/${EMBED_MAX_RETRIES})`);
    await sleep(waitMs);
  }
}

function assertEmbeddingValues(values: unknown): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('임베딩 결과가 비어 있습니다.');
  }
  if (values.length !== EMBEDDING_DIM) {
    throw new Error(`임베딩 차원이 예상(${EMBEDDING_DIM})과 다릅니다: ${values.length}`);
  }
  return values as number[];
}

async function embedViaProxy(cleaned: string, taskType: EmbedTaskType, title?: string): Promise<number[]> {
  const proxyUrl = getAiProxyUrl();
  const idToken = await auth.currentUser?.getIdToken();
  const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      outputDimensionality: EMBEDDING_DIM,
      text: cleaned,
      taskType,
      ...(taskType === 'RETRIEVAL_DOCUMENT' && title ? { title } : {})
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`임베딩 프록시 오류 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return assertEmbeddingValues(data?.embedding?.values || data?.values);
}

function requireApiKey(): string {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('AI 기능을 사용하려면 먼저 Gemini API 키를 설정해주세요.');
  }
  return apiKey;
}

export async function generateTextEmbedding(
  text: string,
  taskType: EmbedTaskType = 'RETRIEVAL_DOCUMENT',
  title?: string
): Promise<number[]> {
  const cleaned = cleanTextForEmbedding(text);
  if (!cleaned) {
    throw new Error('임베딩할 텍스트가 비어 있습니다.');
  }

  // 질문(RETRIEVAL_QUERY) 임베딩은 LRU 캐시에서 먼저 확인하여 중복 호출 차단
  if (taskType === 'RETRIEVAL_QUERY') {
    const cached = queryEmbeddingCache.get(cleaned);
    if (cached) {
      // 최근 사용 순으로 갱신
      queryEmbeddingCache.delete(cleaned);
      queryEmbeddingCache.set(cleaned, cached);
      return cached;
    }
  }

  let values: number[];
  if (getAiProxyUrl()) {
    values = await embedViaProxy(cleaned, taskType, title);
  } else {
    const apiKey = requireApiKey();
    const cleanTitle = title?.trim();
    const json = await postGeminiWithRetry(
      `${GEMINI_API_BASE}/models/${EMBEDDING_MODEL}:embedContent`,
      {
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: cleaned }] },
        taskType,
        ...(taskType === 'RETRIEVAL_DOCUMENT' && cleanTitle ? { title: cleanTitle } : {}),
        outputDimensionality: EMBEDDING_DIM
      },
      apiKey
    );
    values = assertEmbeddingValues(json?.embedding?.values);
  }

  if (taskType === 'RETRIEVAL_QUERY') {
    if (queryEmbeddingCache.size >= QUERY_EMBED_CACHE_MAX) {
      const oldestKey = queryEmbeddingCache.keys().next().value;
      if (oldestKey !== undefined) queryEmbeddingCache.delete(oldestKey);
    }
    queryEmbeddingCache.set(cleaned, values);
  }

  return values;
}

/**
 * 여러 문서를 한 번의 batchEmbedContents 요청으로 임베딩 (일괄 변환용).
 * 프록시 사용 시에는 프록시가 배치를 지원하지 않을 수 있으므로 단건 호출을 순차 수행.
 */
export async function generateTextEmbeddingsBatch(
  texts: string[],
  titles?: (string | undefined)[]
): Promise<number[][]> {
  const cleanedList = texts.map(t => cleanTextForEmbedding(t));
  if (cleanedList.some(t => !t)) {
    throw new Error('임베딩할 텍스트가 비어 있는 항목이 있습니다.');
  }

  if (getAiProxyUrl()) {
    const out: number[][] = [];
    for (let i = 0; i < cleanedList.length; i++) {
      out.push(await embedViaProxy(cleanedList[i], 'RETRIEVAL_DOCUMENT', titles?.[i]));
    }
    return out;
  }

  const apiKey = requireApiKey();
  const json = await postGeminiWithRetry(
    `${GEMINI_API_BASE}/models/${EMBEDDING_MODEL}:batchEmbedContents`,
    {
      requests: cleanedList.map((t, idx) => {
        const cleanTitle = titles?.[idx]?.trim();
        return {
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: t }] },
          taskType: 'RETRIEVAL_DOCUMENT',
          ...(cleanTitle ? { title: cleanTitle } : {}),
          outputDimensionality: EMBEDDING_DIM
        };
      })
    },
    apiKey
  );
  const embeddings = json?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== cleanedList.length) {
    throw new Error('일괄 임베딩 응답 개수가 요청과 다릅니다.');
  }
  return embeddings.map((e: any) => assertEmbeddingValues(e?.values));
}


export async function tryGenerateNoteEmbedding(noteData: Partial<Note>): Promise<number[] | null> {
  if (!hasAiCredentials()) return null;
  try {
    const input = buildNoteEmbeddingInput(noteData);
    if (!input) return null;
    return await generateTextEmbedding(input, 'RETRIEVAL_DOCUMENT', noteData.title);
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
  const modelVer = note.embeddingModel || EMBEDDING_VERSION;
  if (!isCurrentEmbedding(modelVer, note.embedding)) return;

  const rec: LocalVectorRecord = {
    id: note.id,
    uid,
    embedding: note.embedding,
    embeddingUpdatedMs: toMillis(note.embeddingUpdatedAt) || Date.now(),
    model: EMBEDDING_VERSION,
    // 잠금 메모는 평문 본문이 IndexedDB에 남지 않도록 보관하지 않음
    body: !note.locked && typeof note.body === 'string' ? note.body : undefined
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
  if (syncPromise) return syncPromise;
  syncPromise = doEnsureLocalVectorsSynced().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

async function doEnsureLocalVectorsSynced(): Promise<Map<string, LocalVectorRecord>> {
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

  // 로컬 캐시가 완전히 비어 있는 경우(기기 최초 1회 또는 브라우저 캐시 삭제 후): 전체 1회 일괄 조회로 초기화
  if (memoryVectorMap.size === 0) {
    const q = query(collection(db, 'notes'), where('uid', '==', uid));
    const snap = await getDocs(q);
    const toSave: LocalVectorRecord[] = [];
    snap.docs.forEach(d => {
      const rec = toVectorRecord(d.id, uid, d.data());
      if (rec) {
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

  // 2) 증분 동기화(Delta Sync) 및 고아/잠금 레코드 정리:
  //    - 다른 기기에서 삭제된 메모의 로컬 벡터 캐시 제거 (단, 9개 카테고리 전체가 온전히 로드된 경우에만 고아 제거)
  //    - 다른 기기에서 잠금(locked) 처리된 메모의 로컬 평문 본문 즉시 파기
  //    - embeddingUpdatedAt이 갱신되었거나 모델 버전이 다른 문서만 선별하여 조회
  const staleNoteIds: string[] = [];
  const lockedSanitizedRecords: LocalVectorRecord[] = [];
  const isIndexFullyLoaded = Boolean(appState.isAllNotesComplete);

  if (indexItems.length > 0) {
    const validIds = new Set<string>();
    for (const item of indexItems) {
      validIds.add(item.id);
      const localRec = memoryVectorMap.get(item.id);

      // 잠금 메모에 평문 본문이 남아 있으면 즉시 제거 (보안 강화)
      if (localRec && item.locked && localRec.body !== undefined) {
        delete localRec.body;
        lockedSanitizedRecords.push(localRec);
      }

      const idxEmbMs = toMillis(item.embeddingUpdatedAt);
      if (!idxEmbMs) continue; // 인덱스에 임베딩 타임스탬프가 없으면 불필요한 조회 생략
      if (!localRec || localRec.embeddingUpdatedMs < idxEmbMs || localRec.model !== EMBEDDING_VERSION) {
        staleNoteIds.push(item.id);
      }
    }

    // 인덱스가 모든 카테고리에서 온전히 로드되었을 때만 고아 벡터 정리 (일부 카테고리 로딩 실패 시 정상 벡터 오삭제 방지)
    if (isIndexFullyLoaded) {
      const orphanIds: string[] = [];
      for (const cachedId of memoryVectorMap.keys()) {
        if (!validIds.has(cachedId)) {
          orphanIds.push(cachedId);
        }
      }
      if (orphanIds.length > 0) {
        for (const id of orphanIds) memoryVectorMap.delete(id);
        deleteVectorsFromIdb(orphanIds).catch(() => {});
      }
    }
  }

  if (lockedSanitizedRecords.length > 0) {
    putVectorsToIdb(lockedSanitizedRecords).catch(() => {});
  }

  if (staleNoteIds.length > 0) {
    const fetchedRecords: LocalVectorRecord[] = [];
    // 과도한 동시 요청 방지를 위해 10개 단위로 나누어 조회
    const FETCH_CONCURRENCY = 10;
    for (let i = 0; i < staleNoteIds.length; i += FETCH_CONCURRENCY) {
      const chunk = staleNoteIds.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(
        chunk.map(async (noteId) => {
          try {
            const snap = await getDoc(doc(db, 'notes', noteId));
            if (!snap.exists()) return;
            const rec = toVectorRecord(snap.id, uid, snap.data());
            if (rec) {
              memoryVectorMap!.set(snap.id, rec);
              fetchedRecords.push(rec);
            }
          } catch (e) {
            console.warn(`벡터 증분 동기화 실패 (${noteId}):`, e);
          }
        })
      );
    }
    if (fetchedRecords.length > 0) {
      await putVectorsToIdb(fetchedRecords);
    }
  }

  return memoryVectorMap;
}

/**
 * 요구사항 2 (읽기 비용 극대화 절감 + 한국어 하이브리드 보정 + 적응형 커트라인):
 * - 전체 문서를 Firestore에서 읽지 않고 로컬 캐시(allNotesCache + IndexedDB 벡터)만으로
 *   100% 로컬에서 코사인 유사도를 고속 계산하여 상위 topK 메모를 추출합니다.
 * - 잠금 메모가 상위권에 포함된 경우에도 RAG 추론에 사용할 일반(비잠금) 메모가 부족하지 않도록
 *   후보를 보충하고, 잠금 메모의 본문은 절대 로컬 캐시나 스니펫에 노출하지 않습니다.
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
  const queryTermGroups = extractQueryTermGroups(cleanQuery);

  let embeddedNotesCount = 0;
  const sanitizedLockedForIdb: LocalVectorRecord[] = [];

  // 2) 전체 메모 스코어링은 Firestore 조회 없이 100% 로컬 메모리에서 수행
  const scored: (SemanticSearchResult & { lexicalMatched: number })[] = indexItems.map(idxItem => {
    const vecRec = vectorMap.get(idxItem.id);
    const isLocked = !!idxItem.locked;

    // 보안: 잠금 메모에 혹시라도 로컬 본문 캐시가 남아 있다면 즉시 삭제
    if (isLocked && vecRec && vecRec.body !== undefined) {
      delete vecRec.body;
      sanitizedLockedForIdb.push(vecRec);
    }

    const hasEmb = Boolean(vecRec && vecRec.embedding.length === queryVector.length);
    if (hasEmb) embeddedNotesCount++;

    let score = hasEmb ? cosineSimilarity(queryVector, vecRec!.embedding) : 0;
    let matchedTerms = 0;

    if (queryTermGroups.length > 0) {
      const hayTitle = `${idxItem.title || ''} ${getNoteTags(idxItem).join(' ')} ${idxItem.keywords || ''}`.toLowerCase();
      // 잠금 메모는 본문/스니펫 텍스트를 키워드 매칭에 사용하지 않음
      const haySnippet = isLocked ? '' : (vecRec?.body || idxItem.snippet || '').toLowerCase();

      for (const variants of queryTermGroups) {
        if (variants.some(v => hayTitle.includes(v))) {
          matchedTerms += 1.0;
        } else if (haySnippet && variants.some(v => haySnippet.includes(v))) {
          matchedTerms += 0.45;
        }
      }

      const matchRatio = matchedTerms / queryTermGroups.length;
      const lexicalBoost = Math.min(0.10, matchRatio * 0.10);
      if (hasEmb) {
        score = Math.min(0.999, score + lexicalBoost);
      } else if (matchedTerms > 0) {
        score = Math.min(0.58, 0.38 + matchRatio * 0.20);
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
      // 잠금 메모는 본문을 비워 두고, 일반 메모는 로컬 캐시 본문 우선 → 없으면 인덱스 snippet(200자) 사용
      body: isLocked ? '' : (vecRec?.body ?? (idxItem.snippet || '')),
      keywords: idxItem.keywords || '',
      locked: isLocked,
      pinned: !!idxItem.pinned,
      createdAt: idxItem.createdAt || undefined
    };

    return {
      note: candidateNote,
      score,
      hasEmbedding: hasEmb,
      lexicalMatched: matchedTerms
    };
  });

  if (sanitizedLockedForIdb.length > 0) {
    putVectorsToIdb(sanitizedLockedForIdb).catch(() => {});
  }

  // 3) 적응형(Adaptive) 유사도 커트라인 적용 및 상위 메모 추출
  //    - 1순위 점수 대비 편차가 너무 크거나 무관한 하위 노이즈 메모가 섞이는 현상 방지
  //    - 상위권에 잠금 메모가 있더라도 비잠금 메모가 최소 topK개까지 확보될 수 있도록 여유 있게 추출(최대 topK + 3)
  scored.sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score || 0;
  // 최고점 대비 허용 낙폭(0.14)과 최소 하한선(0.45)을 결합하되, 키워드 직접 매칭이 있으면 0.38까지 허용
  const adaptiveMinScore = bestScore >= 0.52 ? Math.max(0.45, bestScore - 0.14) : 0.40;

  const filteredCandidates = scored.filter((item, idx) => {
    if (item.score < 0.35) return false;
    // 최상위 1~2개는 최소 기준(0.38)만 넘으면 우선 포함
    if (idx < 2 && item.score >= 0.38) return true;
    // 직접 키워드 매칭이 있는 경우 포함
    if (item.lexicalMatched > 0 && item.score >= 0.38) return true;
    return item.score >= adaptiveMinScore;
  });

  const topResults: SemanticSearchResult[] = [];
  let unlockedCount = 0;
  const maxTotalResults = topK + 3;

  for (const item of filteredCandidates) {
    if (topResults.length >= maxTotalResults) break;
    if (topResults.length >= topK && unlockedCount >= topK) break;
    topResults.push({
      note: item.note,
      score: item.score,
      hasEmbedding: item.hasEmbedding
    });
    if (!item.note.locked) unlockedCount++;
  }

  // 4) 상위 일치 문서만 본문 최소 조회 (On-Demand Top-K Hydration)
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
          if (fullNote.locked) {
            n.locked = true;
            n.body = '';
            return;
          }
          n.body = fullNote.body;
          if (vecRec) {
            vecRec.body = fullNote.body;
            updatedForIdb.push(vecRec);
          } else if (isCurrentEmbedding(fullNote.embeddingModel, fullNote.embedding)) {
            const newRec: LocalVectorRecord = {
              id: n.id,
              uid: fullNote.uid || appState.currentUser?.uid || '',
              embedding: fullNote.embedding,
              embeddingUpdatedMs: toMillis(fullNote.embeddingUpdatedAt) || Date.now(),
              model: EMBEDDING_VERSION,
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

// 긴 메모 본문에서 질문 키워드가 등장하는 구간을 놓치지 않도록 컨텍스트 발췌
function buildRagBodyExcerpt(rawBody: string, queryTermGroups: string[][], maxChars = 3200): string {
  const cleaned = (rawBody || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;

  const lower = cleaned.toLowerCase();
  const terms = queryTermGroups.flat();
  let matchIdx = -1;
  for (const t of terms) {
    const pos = lower.indexOf(t);
    if (pos >= Math.floor(maxChars * 0.6)) {
      matchIdx = pos;
      break;
    }
  }

  // 키워드가 본문 중·후반부에 등장하면 앞부분 요약 + 매칭 구간 주변을 결합
  if (matchIdx !== -1) {
    const headLen = Math.floor(maxChars * 0.45);
    const windowLen = maxChars - headLen - 15;
    const start = Math.max(headLen, matchIdx - Math.floor(windowLen * 0.35));
    const end = Math.min(cleaned.length, start + windowLen);
    return `${cleaned.slice(0, headLen)}\n\n...(중략)...\n\n${cleaned.slice(start, end)}`;
  }

  // 기본적으로 앞부분(75%) + 뒷부분 결론(25%) 결합
  const headLen = Math.floor(maxChars * 0.75);
  const tailLen = maxChars - headLen - 15;
  return `${cleaned.slice(0, headLen)}\n\n...(중략)...\n\n${cleaned.slice(cleaned.length - tailLen)}`;
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

  const allUnlocked = topResults.filter(r => !r.note.locked);
  const lockedCount = topResults.length - allUnlocked.length;
  const unlockedResults = allUnlocked.slice(0, 5);

  if (unlockedResults.length === 0 && lockedCount > 0) {
    return '검색된 상위 메모가 모두 🔒 잠금 상태입니다. 아래 검색 결과에서 메모를 눌러 잠금을 해제한 뒤 확인해 주세요.';
  }

  const queryTermGroups = extractQueryTermGroups(userQuery);
  const todayStr = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const contextBlocks = unlockedResults.map((item, idx) => {
    const n = item.note;
    const cats = getNoteCategories(n)
      .map(cid => CATEGORIES[cid]?.name || cid)
      .filter(Boolean)
      .join(', ');
    const tags = getNoteTags(n).map(t => `#${t}`).join(' ');
    const simPct = Math.round(item.score * 100);
    const dateStr = fmtDate(n.createdAt) || '날짜 정보 없음';
    const bodyText = buildRagBodyExcerpt(n.body || '', queryTermGroups, 3200);
    return [
      `[메모 ${idx + 1}] (유사도: ${simPct}%)`,
      `- 제목: ${n.title || '제목 없음'}`,
      `- 작성일: ${dateStr}`,
      `- 카테고리: ${cats || '미분류'}${tags ? ` | 태그: ${tags}` : ''}`,
      `- 키워드: ${n.keywords || '없음'}`,
      `- 본문:\n${bodyText}`
    ].join('\n');
  }).join('\n\n────────────────────────\n\n');

  const systemInstruction = [
    '당신은 사용자의 개인 메모장(MyNote)을 기반으로 핵심만 간명하게 요약·추론해 주는 AI 비서입니다.',
    '반드시 한국어로 한눈에 들어오도록 간결하게 작성하세요.',
    '규칙:',
    '1. 인사말이나 서론 없이 곧바로 핵심 결론과 요점(3~5개 이내의 짧은 글머리 기호 `-`)만 간명하게 제시하세요.',
    '2. 답변에서 참조한 메모는 반드시 원문 제목 그대로 문장 끝에 [[메모 제목]] 형식으로 표기하세요. (클릭 가능한 링크로 변환됩니다)',
    '3. 제공된 메모 중 질문과 직접적인 관련이 없는 메모는 억지로 답변에 포함하지 말고 무시하세요.',
    '4. 큰 제목(#, ##)이나 이미지 태그(![...](...)), 긴 URL은 절대 포함하지 마세요.',
    '5. 모바일 작은 화면에서도 스크롤 없이 한눈에 읽히도록 문장을 짧고 명확하게 다듬으세요.'
  ].join('\n');

  const promptText = [
    `[현재 기준일]\n${todayStr}`,
    `\n[사용자 질문 / 검색 의도]\n${userQuery}`,
    lockedCount > 0 ? `\n(참고: 검색된 상위 메모 중 ${lockedCount}건은 잠금 상태여서 컨텍스트에서 제외되었습니다.)` : '',
    `\n[참고 메모 컨텍스트 (상위 ${unlockedResults.length}개 메모)]\n${contextBlocks}`,
    '\n위 메모들 중 질문과 실제로 연관된 내용만을 바탕으로 요약·비교·추론한 답변을 작성해 주세요.'
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

  // 단일 모델로 generateContent 호출하는 내부 헬퍼 (일시적 429/503 시 1회 짧은 재시도 포함)
  const tryGenerateWithModel = async (
    modelName: string
  ): Promise<{ ok: boolean; status: number; answer?: string; errorMsg?: string; fatal?: boolean }> => {
    const cleanModel = modelName.replace(/^models\//, '');
    const url = `${GEMINI_API_BASE}/models/${cleanModel}:generateContent`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
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
            temperature: 0.25,
            maxOutputTokens: 8192
          }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const errorMsg = errJson?.error?.message || `HTTP ${res.status}`;
        if ((res.status === 429 || res.status === 503) && attempt === 0) {
          await sleep(1500);
          continue;
        }
        // 401(잘못된 키) 또는 403(권한 없음)은 다른 모델을 시도해도 해결되지 않으므로 치명적 오류로 즉시 중단
        const fatal = res.status === 401 || res.status === 403;
        return {
          ok: false,
          status: res.status,
          errorMsg,
          fatal
        };
      }

      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      // thought(내부 추론) 파트를 제외하고 실제 텍스트 파트만 결합
      const visibleText = parts
        .filter((p: any) => !p?.thought && typeof p?.text === 'string')
        .map((p: any) => p.text)
        .join('')
        .trim();
      const fallbackText = parts
        .map((p: any) => p?.text || '')
        .join('')
        .trim();
      const answer = visibleText || fallbackText;

      if (!answer) {
        return {
          ok: false,
          status: 200,
          errorMsg: `모델(${cleanModel})이 빈 응답을 반환했습니다.`
        };
      }

      return { ok: true, status: 200, answer };
    }

    return { ok: false, status: 503, errorMsg: `${cleanModel} 재시도 초과` };
  };

  // 이전에 성공했던 모델이 있으면 최우선으로 시도
  const candidateModels = cachedWorkingFlashModel
    ? [cachedWorkingFlashModel, ...FLASH_MODELS.filter(m => m !== cachedWorkingFlashModel)]
    : [...FLASH_MODELS];

  const errors: string[] = [];

  for (const model of candidateModels) {
    try {
      const result = await tryGenerateWithModel(model);
      if (result.ok && result.answer) {
        cachedWorkingFlashModel = model.replace(/^models\//, '');
        return result.answer;
      }
      if (result.errorMsg) {
        errors.push(`${model}: ${result.errorMsg}`);
      }
      if (result.fatal) {
        throw new Error(`Gemini API 인증 오류: ${result.errorMsg}`);
      }
    } catch (e: any) {
      if (e?.message?.includes('인증 오류')) throw e;
      errors.push(`${model}: ${e?.message || String(e)}`);
    }
  }

  // 정적 후보 모델들이 모두 실패한 경우: Google API의 ListModels를 직접 호출하여
  // 현재 API 키에서 사용 가능한 generateContent 지원 모델을 동적으로 찾아 재시도
  try {
    const listUrl = `${GEMINI_API_BASE}/models`;
    const listRes = await fetch(listUrl, {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (listRes.ok) {
      const listJson = await listRes.json();
      const availableModels: string[] = (listJson?.models || [])
        .filter((m: any) =>
          Array.isArray(m?.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          typeof m?.name === 'string' &&
          !m.name.includes('embedding') &&
          !m.name.includes('imagen') &&
          !m.name.includes('veo') &&
          !m.name.includes('tts') &&
          !m.name.includes('audio')
        )
        .map((m: any) => (m.name as string).replace(/^models\//, ''));

      // flash 모델을 우선 정렬
      availableModels.sort((a, b) => {
        const aFlash = a.includes('flash') ? 0 : 1;
        const bFlash = b.includes('flash') ? 0 : 1;
        return aFlash - bFlash;
      });

      for (const dynModel of availableModels) {
        if (candidateModels.includes(dynModel)) continue;
        const result = await tryGenerateWithModel(dynModel);
        if (result.ok && result.answer) {
          cachedWorkingFlashModel = dynModel;
          return result.answer;
        }
        if (result.fatal) {
          throw new Error(`Gemini API 인증 오류: ${result.errorMsg}`);
        }
      }
    }
  } catch (e: any) {
    if (e?.message?.includes('인증 오류')) throw e;
    console.warn('동적 모델 목록 조회(ListModels) 실패:', e);
  }

  throw new Error(`AI 종합 답변 생성 실패: ${errors[0] || '사용 가능한 Gemini 모델을 찾지 못했습니다.'}`);
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
  // 현재 모델·차원(gemini-embedding-001@768)과 일치하지 않는 모든 메모를 갱신 대상으로 선정
  const targets = allDocs.filter(n => !isCurrentEmbedding(n.embeddingModel, n.embedding));

  // 이미 현재 모델 임베딩을 보유한 문서는 로컬 IndexedDB에 채워 넣음
  const existingVecRecords: LocalVectorRecord[] = [];
  for (const n of allDocs) {
    if (n.id && isCurrentEmbedding(n.embeddingModel, n.embedding) && !vectorMap.has(n.id)) {
      const rec = toVectorRecord(n.id, uid, n);
      if (rec) {
        vectorMap.set(n.id, rec);
        existingVecRecords.push(rec);
      }
    }
  }
  if (existingVecRecords.length > 0) {
    await putVectorsToIdb(existingVecRecords);
  }

  let updated = 0;
  let failed = 0;
  const skipped = allDocs.length - targets.length;
  const touchedCategories = new Set<string>();

  // 배치 단위로 묶어서 일괄 임베딩 (API 왕복 횟수 및 소요 시간 1/10 절감)
  for (let i = 0; i < targets.length; i += EMBED_BATCH_SIZE) {
    const batch = targets.slice(i, i + EMBED_BATCH_SIZE);
    const prepared: { note: Note; text: string }[] = [];
    for (const note of batch) {
      const text = buildNoteEmbeddingInput(note);
      if (text) prepared.push({ note, text });
      else failed++;
    }
    if (prepared.length === 0) continue;

    onProgress?.(
      Math.min(i + prepared.length, targets.length),
      targets.length,
      prepared[0].note.title || '제목 없음'
    );

    try {
      const embeddings = await generateTextEmbeddingsBatch(
        prepared.map(p => p.text),
        prepared.map(p => p.note.title)
      );
      const now = Timestamp.now();
      const firestoreBatch = writeBatch(db);

      for (let j = 0; j < prepared.length; j++) {
        const { note } = prepared[j];
        const embedding = embeddings[j];
        if (!note.id || !embedding) continue;
        firestoreBatch.update(doc(db, 'notes', note.id), {
          embedding,
          embeddingModel: EMBEDDING_VERSION,
          embeddingUpdatedAt: now
        });
        note.embedding = embedding;
        note.embeddingModel = EMBEDDING_VERSION;
        note.embeddingUpdatedAt = now;
        getNoteCategories(note).forEach(c => touchedCategories.add(c));
      }

      await firestoreBatch.commit();

      for (let j = 0; j < prepared.length; j++) {
        const { note } = prepared[j];
        if (note.id && note.embedding) {
          upsertVectorNoteCache(note);
          updated++;
        }
      }

      // 할당량(TPM/RPM) 초과 방지를 위한 짧은 휴식
      await sleep(350);
    } catch (e) {
      console.warn('배치 임베딩 실패, 단건으로 폴백 시도:', e);
      // 배치가 실패하면 각 메모별로 단건 재시도
      for (const { note, text } of prepared) {
        if (!note.id) continue;
        try {
          const embedding = await generateTextEmbedding(text, 'RETRIEVAL_DOCUMENT', note.title);
          const now = Timestamp.now();
          await updateDoc(doc(db, 'notes', note.id), {
            embedding,
            embeddingModel: EMBEDDING_VERSION,
            embeddingUpdatedAt: now
          });
          note.embedding = embedding;
          note.embeddingModel = EMBEDDING_VERSION;
          note.embeddingUpdatedAt = now;
          upsertVectorNoteCache(note);
          getNoteCategories(note).forEach(c => touchedCategories.add(c));
          updated++;
          await sleep(250);
        } catch (singleErr) {
          console.warn(`메모 임베딩 생성 실패 (${note.id}):`, singleErr);
          failed++;
        }
      }
    }
  }

  // 변경된 카테고리의 인덱스를 갱신하여 embeddingModel 및 embeddingUpdatedAt을 인덱스에 반영
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