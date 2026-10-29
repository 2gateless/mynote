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
import { CATEGORIES, getNoteCategories, getNoteTags } from './database';
import { Note } from '../types';

// ─────────────────────────────────────────────
// 상수 및 스토리지 키 정의
// ─────────────────────────────────────────────
const STORAGE_KEY_API = 'mynote_gemini_api_key';
const STORAGE_KEY_PROXY = 'mynote_ai_proxy_url';

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

// 세션 내 고속 벡터 검색을 위한 인메모리 캐시 (Firestore 중복 읽기 방지)
let vectorNotesCache: Map<string, Note> | null = null;
let vectorCacheUid: string | null = null;

// ─────────────────────────────────────────────
// 1. 안전한 API 키 / 프록시 설정 관리
// ─────────────────────────────────────────────

/**
 * 현재 기기 또는 로컬 환경변수(.env.local)에 설정된 Gemini API 키를 반환합니다.
 * 공개 GitHub 저장소 노출을 막기 위해 코드에는 절대 키를 하드코딩하지 않습니다.
 */
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

/**
 * Cloud Functions / Cloudflare Worker 등 백엔드 프록시 URL이 설정된 경우 반환합니다.
 */
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

/**
 * API 키 및 프록시 URL을 기기(localStorage)에 저장하고,
 * 선택 시 본인 전용 Firestore(user_meta/{uid})에도 동기화합니다.
 */
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

/**
 * 로그인 직후 로컬에 API 키가 없으면 본인 user_meta 문서에서 복원합니다.
 */
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

/**
 * 마크다운 이미지 링크 등 임베딩 품질을 떨어뜨리는 긴 URL을 정리하고
 * 핵심 텍스트만 추출합니다.
 */
export function cleanTextForEmbedding(raw: string, maxChars = 6000): string {
  if (!raw) return '';
  return raw
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // 마크다운 이미지 URL 제거
    .replace(/https?:\/\/\S+/g, '')            // 일반 긴 URL 제거
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/**
 * 메모의 제목, 카테고리, 태그, 키워드, 본문을 결합하여 임베딩용 문서를 구성합니다.
 */
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

/**
 * Gemini API (또는 보안 프록시)를 호출하여 텍스트를 임베딩 벡터(number[])로 변환합니다.
 * 기본 모델: text-embedding-004
 */
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
  // 만약 text-embedding-004 엔드포인트가 지원 중단/404인 경우 gemini-embedding-001로 자동 폴백
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

/**
 * 메모 저장/수정 시 호출되어 안전하게 임베딩 벡터를 생성합니다.
 * API 키 미설정이나 네트워크 오류 시에도 기존 메모 저장(CRUD)이 절대 중단되지 않도록 null을 반환합니다.
 */
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
// 3. 코사인 유사도 계산 및 고속 시맨틱 검색
// ─────────────────────────────────────────────

/**
 * 두 벡터 간의 코사인 유사도(Cosine Similarity)를 계산합니다. (-1.0 ~ 1.0)
 * 길이가 다른 벡터(모델 버전 차이 등)인 경우 0을 반환합니다.
 */
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
 * 메모 생성/수정 시 인메모리 벡터 캐시를 즉시 갱신합니다.
 */
export function upsertVectorNoteCache(note: Note) {
  if (!note.id) return;
  if (vectorNotesCache && vectorCacheUid === appState.currentUser?.uid) {
    vectorNotesCache.set(note.id, note);
  }
}

/**
 * 메모 삭제 시 인메모리 벡터 캐시에서 제거합니다.
 */
export function removeVectorNoteCache(noteId: string) {
  if (vectorNotesCache) {
    vectorNotesCache.delete(noteId);
  }
}

/**
 * 사용자의 전체 메모(embedding 포함)를 로드하여 인메모리 캐시에 보관합니다.
 */
export async function ensureVectorNotesLoaded(forceRefresh = false): Promise<Note[]> {
  const uid = appState.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');

  if (!forceRefresh && vectorNotesCache && vectorCacheUid === uid) {
    return Array.from(vectorNotesCache.values());
  }

  const q = query(collection(db, 'notes'), where('uid', '==', uid));
  const snap = await getDocs(q);
  const map = new Map<string, Note>();
  snap.docs.forEach(d => {
    map.set(d.id, { id: d.id, ...(d.data() as any) } as Note);
  });

  vectorNotesCache = map;
  vectorCacheUid = uid;
  return Array.from(map.values());
}

/**
 * 요구사항 2: 자연어 질문을 임베딩하여 Firestore 내 메모 벡터들과 코사인 유사도를 비교하고
 * 연관도가 높은 상위 3~5개(기본 5개) 메모를 고속 추출합니다.
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

  // 1) 질문 임베딩(RETRIEVAL_QUERY)과 메모 로드를 병렬 수행하여 응답 속도 극대화
  const [queryVector, allNotes] = await Promise.all([
    generateTextEmbedding(cleanQuery, 'RETRIEVAL_QUERY'),
    ensureVectorNotesLoaded(false)
  ]);

  const queryTerms = cleanQuery
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);

  let embeddedNotesCount = 0;

  const scored: SemanticSearchResult[] = allNotes.map(note => {
    const hasEmb = Array.isArray(note.embedding) && note.embedding.length === queryVector.length;
    if (hasEmb) embeddedNotesCount++;

    let score = hasEmb ? cosineSimilarity(queryVector, note.embedding) : 0;

    // 보조 가중치: 제목·태그·키워드에 질문 핵심 어절이 직접 포함되면 소폭 가산 (하이브리드 정밀도 향상)
    if (queryTerms.length > 0) {
      const hayTitle = `${note.title || ''} ${getNoteTags(note).join(' ')} ${note.keywords || ''}`.toLowerCase();
      const hayBody = (note.body || '').toLowerCase();
      let matchedTerms = 0;
      for (const term of queryTerms) {
        if (hayTitle.includes(term)) matchedTerms += 1.0;
        else if (hayBody.includes(term)) matchedTerms += 0.4;
      }
      const lexicalBoost = Math.min(0.08, (matchedTerms / queryTerms.length) * 0.08);
      if (hasEmb) {
        score = Math.min(0.999, score + lexicalBoost);
      } else if (matchedTerms > 0) {
        // 아직 임베딩이 생성되지 않은 구버전 메모도 키워드 일치 시 후보로 노출 가능하도록 보정
        score = Math.min(0.55, 0.35 + (matchedTerms / queryTerms.length) * 0.2);
      }
    }

    return {
      note,
      score,
      hasEmbedding: hasEmb
    };
  });

  // 연관도 높은 순으로 정렬 후 상위 topK(3~5개) 추출 (최소 유사도 임계값 0.25 이상)
  scored.sort((a, b) => b.score - a.score);
  const filtered = scored.filter(item => item.score >= 0.25).slice(0, topK);

  return {
    results: filtered,
    totalNotesCount: allNotes.length,
    embeddedNotesCount
  };
}

// ─────────────────────────────────────────────
// 4. 요구사항 3: AI 종합 및 추론 모드 (RAG — Gemini Flash)
// ─────────────────────────────────────────────

/**
 * 상위 검색된 메모들의 본문을 컨텍스트로 묶어 Gemini Flash 모델에 전달하고,
 * 질문에 맞춰 요약·비교·추론한 답변을 생성합니다.
 */
export async function generateRagAnswer(
  userQuery: string,
  topResults: SemanticSearchResult[]
): Promise<string> {
  if (topResults.length === 0) {
    return '연관된 메모를 찾지 못해 종합 답변을 생성할 수 없습니다.';
  }

  // 잠금(locked) 메모는 사생활 보호를 위해 본문 대신 잠금 상태임을 표시하고, 열린 메모들의 본문을 컨텍스트로 구성
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
// 5. 기존 메모 일괄 임베딩 생성 (백필 유틸리티)
// ─────────────────────────────────────────────

/**
 * 아직 embedding 필드가 없는 기존 메모들을 찾아 순차적으로 임베딩을 생성하고
 * Firestore notes/{noteId} 문서에 저장합니다.
 */
export async function backfillMissingEmbeddings(
  onProgress?: (done: number, total: number, currentTitle: string) => void
): Promise<{ updated: number; skipped: number; failed: number }> {
  const allNotes = await ensureVectorNotesLoaded(true);
  const targets = allNotes.filter(
    n => !Array.isArray(n.embedding) || n.embedding.length === 0
  );

  let updated = 0;
  let failed = 0;
  const skipped = allNotes.length - targets.length;

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
      updated++;
      // 무료 등급 API Rate Limit(분당 요청 제한) 방지를 위한 짧은 간격 대기
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.warn(`메모 임베딩 생성 실패 (${note.id}):`, e);
      failed++;
    }
  }

  return { updated, skipped, failed };
}
