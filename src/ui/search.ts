import { appState, SearchIndexEntry } from '../state';
import { CATEGORIES, getNoteCategories, getNoteTags } from '../services/database';
import { escHtml, matchesSearchToken, parseMarkdownBody } from '../utils/formatter';
import { showToast } from '../utils/toast';
import { currentScreen, showAppScreen } from '../pwa';
import { NoteIndexItem } from '../types';
import { $ } from './dom';

export interface SearchModuleDeps {
  getAi: () => Promise<typeof import('../services/ai')>;
  ensureSearchIndexReady: () => boolean;
  ensureAllNotesCache: () => void;
  getSearchIndex: () => SearchIndexEntry[];
  isNotesLoaded: () => boolean;
  openNoteById: (noteId: string, from: string, pushCurrentToHistory?: boolean) => Promise<void>;
  setDetailFrom: (from: string) => void;
  clearDetailHistory: () => void;
  setSavedSearchScrollY: (y: number) => void;
  getSavedSearchScrollY: () => number;
}

export interface SearchModuleApi {
  resetSearchUI: () => void;
  closeAiConfigModal: () => void;
  doSearch: (keyword: string, fromCacheSync?: boolean) => void;
  restoreSearchScreenIfHasContent: () => boolean;
  isSearchVisibleOnHome: () => boolean;
  isSearchWrapOpen: () => boolean;
  openSearchWrapAndFocus: (mode?: 'home' | 'list') => void;
  closeSearchWrap: () => void;
  exitSearchAndReturn: () => void;
  shouldSyncSearchOnCacheUpdate: () => string | null;
  syncSearchResultOnNoteUpdated: (
    noteId: string,
    updated: Partial<NoteIndexItem> & { body?: string; locked?: boolean; title?: string },
    detailFrom: string
  ) => void;
  syncSearchResultOnNoteDeleted: (noteId: string, detailFrom: string) => void;
}

/**
 * 모바일(Android/iOS) 가상 키보드에서 한글 조합 중 Enter 또는 blur가 발생할 때
 * 마지막 완성형 음절(예: '나무' -> '나무무')이 한 번에 중복 삽입되는 현상인지 판별.
 */
function isMobileImeTrailingDuplicate(newRaw: string, prevRaw: string, inputType?: string): boolean {
  if (!prevRaw || inputType === 'insertFromPaste') return false;
  if (newRaw.length !== prevRaw.length + 1) return false;
  const lastChar = prevRaw.slice(-1);
  if (!/[가-힣]/.test(lastChar)) return false;
  return newRaw === prevRaw + lastChar;
}

/**
 * 검색 결과의 제목 또는 미리보기 텍스트에서 검색 키워드를 <mark class="search-hl">로 하이라이트
 * XSS 및 HTML 태그 깨짐 방지를 위해 원본 텍스트를 정규식으로 분할 후 안전하게 이스케이프 결합
 */
function highlightKeywords(rawText: string, keywords: string[]): string {
  if (!rawText) return '';
  const validTokens = Array.from(new Set(keywords.map(k => k.trim()).filter(k => k.length > 0)));
  if (validTokens.length === 0) return escHtml(rawText);

  const escapedTokens = validTokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  escapedTokens.sort((a, b) => b.length - a.length);

  const regex = new RegExp(`(${escapedTokens.join('|')})`, 'gi');
  const parts = rawText.split(regex);

  return parts
    .map(part => {
      if (!part) return '';
      if (validTokens.some(t => t.toLowerCase() === part.toLowerCase())) {
        return `<mark class="search-hl">${escHtml(part)}</mark>`;
      }
      return escHtml(part);
    })
    .join('');
}

export function initSearchModule(deps: SearchModuleDeps): SearchModuleApi {
  const searchInput = $('search-input') as HTMLInputElement | null;
  const searchClear = $('search-clear') as HTMLElement | null;
  const searchResults = $('search-results') as HTMLElement | null;
  const searchWrap = $('search-wrap') as HTMLElement | null;
  const btnToggleSearch = $('btn-toggle-search');
  const aiRagContainer = $('ai-rag-container') as HTMLElement | null;
  const btnAiSearch = $('btn-ai-search') as HTMLButtonElement | null;
  const btnOpenAiConfig = $('btn-open-ai-config') as HTMLButtonElement | null;
  const aiConfigModal = $('ai-config-modal') as HTMLElement | null;
  const aiApiKeyInput = $('ai-api-key-input') as HTMLInputElement | null;
  const aiProxyUrlInput = $('ai-proxy-url-input') as HTMLInputElement | null;
  const aiSyncCloudCb = $('ai-sync-cloud-cb') as HTMLInputElement | null;
  const btnBackfillEmbeddings = $('btn-backfill-embeddings') as HTMLButtonElement | null;
  const aiBackfillStatus = $('ai-backfill-status') as HTMLElement | null;

  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastSearchedQuery = '';
  let isAiSearchActive = false;
  let lastRenderedSearchSignature = '';
  let isSelectingSearchResult = false;
  let isPointerDownOnSearchResults = false;
  let lastValidSearchInputRaw = '';
  let imeEnterLockedRaw: string | null = null;
  let imeEnterLockUntil = 0;
  let lastEnterHandledAt = 0;
  let aiSearchSessionToken = 0;
  let activeAiAbortController: AbortController | null = null;

  function resetAiSearchButton() {
    if (btnAiSearch) {
      btnAiSearch.disabled = false;
      btnAiSearch.innerHTML = '<span>✨</span><span>AI 의미 검색 · 추론</span>';
    }
  }

  function abortActiveAiSearch() {
    aiSearchSessionToken++;
    if (activeAiAbortController) {
      activeAiAbortController.abort();
      activeAiAbortController = null;
    }
  }

  function mountSearchPanelTo(target: 'home' | 'list') {
    const parent = target === 'list' ? $('screen-list') : $('screen-home');
    const anchor = target === 'list' ? $('list-content') : $('folders-meta-header');
    if (parent && anchor && anchor.parentNode === parent) {
      if (searchWrap && searchWrap.parentNode !== parent) {
        parent.insertBefore(searchWrap, anchor);
      }
      if (aiRagContainer && aiRagContainer.parentNode !== parent) {
        parent.insertBefore(aiRagContainer, anchor);
      }
      if (searchResults && searchResults.parentNode !== parent) {
        parent.insertBefore(searchResults, anchor);
      }
    }
    const listSearchBtn = $('btn-list-search');
    if (listSearchBtn) {
      const isOpenInList = target === 'list' && Boolean(searchWrap && searchWrap.style.display !== 'none');
      listSearchBtn.classList.toggle('active', isOpenInList);
    }
  }

  function setHomeListVisible(visible: boolean) {
    const fl = $('folders-list');
    const mh = $('folders-meta-header');
    const lc = $('list-content');
    if (appState.searchReturnTarget) {
      if (lc) lc.style.display = visible ? '' : 'none';
      if (fl) fl.style.display = '';
      if (mh) mh.style.display = '';
    } else {
      if (lc) lc.style.display = '';
      if (fl) fl.style.display = visible ? '' : 'none';
      if (mh) mh.style.display = visible ? '' : 'none';
    }
  }

  function resetSearchUI() {
    abortActiveAiSearch();
    resetAiSearchButton();
    deps.setSavedSearchScrollY(0);
    deps.clearDetailHistory();
    if (searchTimeout) clearTimeout(searchTimeout);
    lastSearchedQuery = '';
    lastValidSearchInputRaw = '';
    imeEnterLockedRaw = null;
    imeEnterLockUntil = 0;
    isAiSearchActive = false;
    pendingRagContext = null;
    lastKeywordResults = [];
    lastKeywordTerms = [];
    lastKeywordShownCount = 0;
    lastRenderedSearchSignature = '';
    isSelectingSearchResult = false;
    isPointerDownOnSearchResults = false;
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.style.display = 'none';
    if (aiRagContainer) {
      aiRagContainer.style.display = 'none';
      aiRagContainer.innerHTML = '';
    }
    if (searchResults) {
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
    }
    setHomeListVisible(true);
  }

  function syncSearchInputPlaceholder() {
    if (!searchInput) return;
    const catId = appState.searchReturnTarget?.catId;
    const cat = catId ? CATEGORIES[catId] : null;
    searchInput.placeholder = cat
      ? `${cat.icon} ${cat.name} 내 키워드 검색 또는 AI 질문`
      : '키워드 검색 또는 AI에게 자연어로 질문하세요';
  }

  function getSearchExitLabel(): string {
    return appState.searchReturnTarget ? '← 돌아가기' : '🏠 홈으로';
  }

  function exitSearchAndReturn() {
    const ret = appState.searchReturnTarget;
    appState.searchReturnTarget = null;
    if (searchWrap) searchWrap.style.display = 'none';
    resetSearchUI();
    syncSearchInputPlaceholder();
    mountSearchPanelTo('home');
    if (ret && ret.catId) {
      const lc = $('list-content');
      if (lc) lc.style.display = '';
      if (currentScreen() === 'list' && appState.currentCat === ret.catId && appState.currentTag === ret.tag) {
        showAppScreen('list');
      } else if (appState.openList) {
        appState.openList(ret.catId, ret.tag);
      }
    } else {
      showAppScreen('home');
    }
  }

  function lockAndBlurSearchInput(lockedRaw: string) {
    imeEnterLockedRaw = lockedRaw;
    imeEnterLockUntil = Date.now() + 500;
    if (searchInput && searchInput.value !== lockedRaw) {
      searchInput.value = lockedRaw;
    }
    setTimeout(() => {
      if (!searchInput) return;
      if (imeEnterLockedRaw !== null && searchInput.value !== imeEnterLockedRaw) {
        searchInput.value = imeEnterLockedRaw;
      }
      searchInput.blur();
      if (imeEnterLockedRaw !== null && searchInput.value !== imeEnterLockedRaw) {
        searchInput.value = imeEnterLockedRaw;
      }
    }, 25);
  }

  async function openAiConfigModal() {
    if (!aiConfigModal) return;
    const ai = await deps.getAi();
    if (aiApiKeyInput) aiApiKeyInput.value = ai.getGeminiApiKey();
    if (aiProxyUrlInput) aiProxyUrlInput.value = ai.getAiProxyUrl();
    if (aiSyncCloudCb) aiSyncCloudCb.checked = false;
    aiConfigModal.style.display = 'flex';
  }

  function closeAiConfigModal() {
    if (aiConfigModal) aiConfigModal.style.display = 'none';
  }

  const AI_AUTO_RAG_KEY = 'mynote_ai_auto_rag_v1';
  let pendingRagContext: { queryText: string; results: any[]; token: number } | null = null;

  function getAutoRagEnabled(): boolean {
    try {
      return localStorage.getItem(AI_AUTO_RAG_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setAutoRagEnabled(enabled: boolean) {
    try {
      localStorage.setItem(AI_AUTO_RAG_KEY, enabled ? '1' : '0');
    } catch {}
  }

  async function runRagAnswerForContext(
    queryText: string,
    results: any[],
    token: number,
    existingSignal?: AbortSignal
  ) {
    const ai = await deps.getAi();
    let localAbortController: AbortController | null = null;
    let signal = existingSignal;
    if (!signal) {
      localAbortController = new AbortController();
      activeAiAbortController = localAbortController;
      signal = localAbortController.signal;
    }

    const initialUnlockedCount = Math.min(4, results.filter(r => !r.note.locked).length);
    if (aiRagContainer) {
      aiRagContainer.style.display = 'block';
      aiRagContainer.innerHTML = `
        <div class="ai-rag-card">
          <div class="ai-rag-header">
            <div class="ai-rag-title"><span>🤖</span><span>AI 종합 및 추론 답변</span></div>
            <label class="ai-auto-rag-toggle" title="체크 시 검색마다 AI 종합 답변을 자동으로 바로 생성합니다">
              <input type="checkbox" id="cb-ai-auto-rag"${getAutoRagEnabled() ? ' checked' : ''}>
              <span>자동 요약</span>
            </label>
          </div>
          <div class="ai-rag-body" id="ai-rag-stream-body" style="color:var(--text-light)">
            ✍️ 상위 ${initialUnlockedCount}개 메모를 바탕으로 핵심 답변을 작성 중입니다...
          </div>
        </div>
      `;
    }

    try {
      // 최대 500ms까지만 긴 메모 본문을 보충 조회하여 AI 스트리밍 시작 지연 최소화
      await ai.hydrateTopSearchResults(results, signal, 500);
      if (token !== aiSearchSessionToken || signal.aborted) return;

      const unlockedRefCount = Math.min(4, results.filter(r => !r.note.locked).length);

      let lastStreamRenderAt = 0;
      let streamRenderPending = false;
      let latestStreamText = '';

      const renderStreamBody = async (markdownText: string) => {
        if (token !== aiSearchSessionToken || signal.aborted) return;
        const cleanPartial = markdownText.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
        if (!cleanPartial) return;
        const html = await parseMarkdownBody(cleanPartial);
        if (token !== aiSearchSessionToken || signal.aborted) return;
        const streamBodyEl = $('ai-rag-stream-body');
        if (streamBodyEl) {
          streamBodyEl.style.color = '';
          streamBodyEl.innerHTML = html;
        }
      };

      const answerMarkdown = await ai.generateRagAnswerStream(
        queryText,
        results,
        (accumulated) => {
          if (token !== aiSearchSessionToken || signal.aborted) return;
          latestStreamText = accumulated;
          const now = Date.now();
          if (!streamRenderPending && now - lastStreamRenderAt >= 110) {
            lastStreamRenderAt = now;
            renderStreamBody(accumulated).catch(() => {});
          } else if (!streamRenderPending) {
            streamRenderPending = true;
            setTimeout(() => {
              streamRenderPending = false;
              lastStreamRenderAt = Date.now();
              if (latestStreamText) renderStreamBody(latestStreamText).catch(() => {});
            }, 110);
          }
        },
        signal
      );
      if (token !== aiSearchSessionToken || signal.aborted) return;

      const cleanAnswer = answerMarkdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
      const renderedHtml = await parseMarkdownBody(cleanAnswer);
      if (token !== aiSearchSessionToken || signal.aborted) return;

      if (aiRagContainer) {
        aiRagContainer.innerHTML = `
          <div class="ai-rag-card">
            <div class="ai-rag-header">
              <div class="ai-rag-title"><span>✨</span><span>AI 종합 및 추론 답변</span></div>
              <div style="display:flex;align-items:center;gap:8px">
                <span class="ai-rag-badge">참조 ${unlockedRefCount}건</span>
                <label class="ai-auto-rag-toggle" title="체크 시 검색마다 AI 종합 답변을 자동으로 바로 생성합니다">
                  <input type="checkbox" id="cb-ai-auto-rag"${getAutoRagEnabled() ? ' checked' : ''}>
                  <span>자동 요약</span>
                </label>
              </div>
            </div>
            <div class="ai-rag-body">${renderedHtml}</div>
          </div>
        `;
      }
    } catch (e: any) {
      if (ai.isAbortError(e, signal) || token !== aiSearchSessionToken) return;
      if (aiRagContainer) {
        aiRagContainer.innerHTML = `
          <div class="ai-rag-card" style="border-color:var(--danger)">
            <div class="ai-rag-header">
              <div class="ai-rag-title" style="color:var(--danger)"><span>⚠️</span><span>AI 답변 생성 오류</span></div>
            </div>
            <div class="ai-rag-body" style="color:var(--danger)">${escHtml(e?.message || '알 수 없는 오류가 발생했습니다.')}</div>
          </div>
        `;
      }
    } finally {
      if (localAbortController && activeAiAbortController === localAbortController) {
        activeAiAbortController = null;
      }
    }
  }

  async function runAiSemanticSearch(rawQuery: string) {
    const queryText = rawQuery.trim();
    if (!queryText) {
      showToast('검색어나 질문을 입력해주세요');
      searchInput?.focus();
      return;
    }
    const ai = await deps.getAi();
    if (!ai.hasAiCredentials()) {
      showToast('AI 검색을 위해 먼저 Gemini API 키를 설정해주세요 ✨');
      openAiConfigModal();
      return;
    }

    abortActiveAiSearch();
    const token = aiSearchSessionToken;
    const abortController = new AbortController();
    activeAiAbortController = abortController;
    const { signal } = abortController;
    const startedAt = performance.now();

    pendingRagContext = null;
    isAiSearchActive = true;
    lastSearchedQuery = queryText;
    imeEnterLockedRaw = queryText;
    imeEnterLockUntil = Date.now() + 600;
    if (searchTimeout) clearTimeout(searchTimeout);
    setHomeListVisible(false);
    deps.ensureSearchIndexReady();
    deps.ensureAllNotesCache();

    if (btnAiSearch) {
      btnAiSearch.disabled = true;
      btnAiSearch.innerHTML = '<span>⚡</span><span>의미 검색 중...</span>';
    }

    // 0ms 점진적 렌더링: 화면을 비우지 않고 즉시 로컬 키워드 결과를 선(先) 표시한 뒤 시맨틱 점수로 재정렬
    if (searchResults && (searchResults.style.display === 'none' || !searchResults.querySelector('.search-result-item'))) {
      doSearch(queryText, true);
    }

    if (aiRagContainer) {
      aiRagContainer.style.display = 'block';
      aiRagContainer.innerHTML = `
        <div class="ai-rag-compact-status">
          <span>⚡</span>
          <span>의미 기반 하이브리드 정밀 분석 중...</span>
        </div>
      `;
    }

    try {
      const scopeCatId = appState.searchReturnTarget?.catId || null;
      const scopeCat = scopeCatId ? CATEGORIES[scopeCatId] : null;
      const scopeLabel = scopeCat ? `${scopeCat.icon} ${scopeCat.name} ` : '';

      // 1단계: 로컬 벡터(0ms 비블로킹) + 질문 임베딩으로 초고속 하이브리드 상위 메모 추출
      const { results, embeddedNotesCount } = await ai.semanticSearchNotes(queryText, 5, {
        skipHydration: true,
        categoryId: scopeCatId,
        signal
      });
      if (token !== aiSearchSessionToken || signal.aborted) return;

      const elapsedSec = Math.max(0.1, (performance.now() - startedAt) / 1000).toFixed(1);

      if (results.length === 0) {
        if (aiRagContainer) {
          aiRagContainer.innerHTML = `
            <div class="ai-rag-card">
              <div class="ai-rag-header">
                <div class="ai-rag-title"><span>✨</span><span>AI 검색 결과 안내</span></div>
              </div>
              <div class="ai-rag-body">
                ${embeddedNotesCount === 0
                  ? `${scopeLabel ? `<b>${escHtml(scopeLabel.trim())}</b> 메뉴에 ` : '아직 '}임베딩 벡터가 저장된 메모가 없습니다. <b>⚙️ AI 설정 → 기존 메모 일괄 임베딩 생성</b>을 먼저 실행하시거나 새 메모를 저장해 주세요.`
                  : `${scopeLabel ? `<b>${escHtml(scopeLabel.trim())}</b> 내에서 ` : ''}"<b>${escHtml(queryText)}</b>"와(과) 의미적으로 연관도가 높은 메모를 찾지 못했습니다.`}
              </div>
            </div>
          `;
        }
        if (searchResults) {
          searchResults.innerHTML = `<div class="search-no-result">🔍 ${scopeLabel ? `${escHtml(scopeLabel.trim())} 내 ` : ''}연관된 메모가 없어요</div>`;
        }
        return;
      }

      // 2단계: 하이브리드 검색 결과 카드를 즉시 렌더링
      const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
        <span style="font-size:12px;color:#4338CA;font-weight:700">✨ ${scopeLabel ? `${escHtml(scopeLabel.trim())} · ` : ''}하이브리드 연관 상위 ${results.length}개 메모 · ${elapsedSec}초</span>
        <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--border-color);background:transparent;color:var(--text);cursor:pointer;font-weight:600">${getSearchExitLabel()}</button>
      </div>`;

      const searchTokens = queryText.toLowerCase().split(/\s+/).filter(Boolean);
      const items = results.map(({ note, score, hasEmbedding }) => {
        const noteCats = getNoteCategories(note);
        const catBadgesHtml = noteCats.map(cid => {
          const c = CATEGORIES[cid];
          return c ? `<span class="detail-cat-badge">${c.icon} ${escHtml(c.name)}</span>` : '';
        }).join('');
        const simPct = Math.round(score * 100);
        const simBadge = `<span class="ai-sim-badge">${hasEmbedding ? `🎯 유사도 ${simPct}%` : `키워드 매칭`}</span>`;
        const snippet = (note.body || '')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼️ ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 120);
        const titleHtml = note.locked
          ? '🔒 ' + escHtml(note.title || '제목 없음')
          : highlightKeywords(note.title || '제목 없음', searchTokens);
        const snippetHtml = note.locked
          ? '🔒 잠긴 메모입니다'
          : highlightKeywords(snippet, searchTokens);

        return `<div class="search-result-item" data-id="${escHtml(note.id || '')}" data-cat="${escHtml(note.category)}">
          <div class="search-result-title">${titleHtml}${simBadge}</div>
          ${catBadgesHtml}
          ${getNoteTags(note).map(t => `<span class="search-result-cat" style="background:var(--sky-dark);color:white;margin-left:4px">#${escHtml(t)}</span>`).join('')}
          <div class="search-result-body">${snippetHtml}</div>
        </div>`;
      }).join('');

      if (searchResults) {
        searchResults.style.display = 'block';
        searchResults.innerHTML = header + items;
      }

      // 하이브리드 메모 목록 추출이 끝났으므로 검색 버튼을 즉시 활성화
      if (token === aiSearchSessionToken) {
        resetAiSearchButton();
      }

      pendingRagContext = { queryText, results, token };
      const unlockedCount = Math.min(4, results.filter(r => !r.note.locked).length);

      // 3단계: '항상 자동 요약'이 켜져 있으면 즉시 RAG 답변 생성, 꺼져 있으면 초고속 1줄 요약 버튼 표시
      if (getAutoRagEnabled()) {
        await runRagAnswerForContext(queryText, results, token, signal);
      } else if (aiRagContainer) {
        aiRagContainer.innerHTML = `
          <div class="ai-rag-prompt-bar">
            <button type="button" class="btn-ai-rag-trigger" id="btn-run-rag-answer">
              <span>✨</span><span>AI 종합 답변 보기${unlockedCount > 0 ? ` (${unlockedCount}건)` : ''}</span>
            </button>
            <label class="ai-auto-rag-toggle" title="체크 시 검색마다 AI 종합 답변을 자동으로 바로 생성합니다">
              <input type="checkbox" id="cb-ai-auto-rag">
              <span>항상 자동 요약</span>
            </label>
          </div>
        `;
      }
    } catch (e: any) {
      if (ai.isAbortError(e, signal) || token !== aiSearchSessionToken) return;
      if (aiRagContainer) {
        aiRagContainer.innerHTML = `
          <div class="ai-rag-card" style="border-color:var(--danger)">
            <div class="ai-rag-header">
              <div class="ai-rag-title" style="color:var(--danger)"><span>⚠️</span><span>AI 검색 오류</span></div>
            </div>
            <div class="ai-rag-body" style="color:var(--danger)">${escHtml(e?.message || '알 수 없는 오류가 발생했습니다.')}</div>
          </div>
        `;
      }
    } finally {
      if (activeAiAbortController === abortController) {
        activeAiAbortController = null;
      }
      if (token === aiSearchSessionToken) {
        resetAiSearchButton();
      }
    }
  }

  const SEARCH_RENDER_LIMIT = 40;
  let lastKeywordResults: NoteIndexItem[] = [];
  let lastKeywordTerms: string[] = [];
  let lastKeywordShownCount = 0;

  function renderKeywordCardHtml(note: NoteIndexItem, keywords: string[]): string {
    const noteCats = getNoteCategories(note);
    const catBadgesHtml = noteCats.map(cid => {
      const c = CATEGORIES[cid];
      return c ? `<span class="detail-cat-badge">${c.icon} ${escHtml(c.name)}</span>` : '';
    }).join('');
    const titleHtml = note.locked
      ? '🔒 ' + escHtml(note.title || '제목 없음')
      : highlightKeywords(note.title || '제목 없음', keywords);
    const rawSnippet = (note.snippet || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼️ ')
      .replace(/\s+/g, ' ')
      .trim();
    const snippetHtml = note.locked
      ? '🔒 잠긴 메모입니다'
      : highlightKeywords(rawSnippet, keywords);

    return `<div class="search-result-item" data-id="${escHtml(note.id)}" data-cat="${escHtml(note.category)}">
      <div class="search-result-title">${titleHtml}</div>
      ${catBadgesHtml}
      ${getNoteTags(note).map(t => `<span class="search-result-cat" style="background:var(--sky-dark);color:white;margin-left:4px">#${escHtml(t)}</span>`).join('')}
      <div class="search-result-body">${snippetHtml}</div>
    </div>`;
  }

  function appendMoreKeywordResults() {
    if (!searchResults || lastKeywordShownCount >= lastKeywordResults.length) return;
    const moreBtn = searchResults.querySelector('#btn-search-more');
    const nextEnd = Math.min(lastKeywordShownCount + SEARCH_RENDER_LIMIT, lastKeywordResults.length);
    const chunkHtml = lastKeywordResults
      .slice(lastKeywordShownCount, nextEnd)
      .map(n => renderKeywordCardHtml(n, lastKeywordTerms))
      .join('');
    lastKeywordShownCount = nextEnd;
    if (moreBtn) {
      moreBtn.insertAdjacentHTML('beforebegin', chunkHtml);
      const remaining = lastKeywordResults.length - lastKeywordShownCount;
      if (remaining > 0) {
        moreBtn.textContent = `더 보기 (남은 ${remaining}건)`;
      } else {
        moreBtn.remove();
      }
    }
  }

  function doSearch(keyword: string, fromCacheSync = false) {
    if (!searchResults) return;
    if (!fromCacheSync) {
      abortActiveAiSearch();
      resetAiSearchButton();
      isAiSearchActive = false;
      if (aiRagContainer) {
        aiRagContainer.style.display = 'none';
        aiRagContainer.innerHTML = '';
      }
    }
    setHomeListVisible(false);
    searchResults.style.display = 'block';
    deps.ensureSearchIndexReady();
    try {
      lastSearchedQuery = keyword;
      const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      const searchIdx = deps.getSearchIndex();

      if (searchIdx.length === 0 && !deps.isNotesLoaded()) {
        lastRenderedSearchSignature = '';
        searchResults.innerHTML = `<div class="search-no-result" style="color:var(--text-light);font-size:14px;padding:24px 0">🔍 메모 색인을 불러오는 중입니다...</div>`;
        deps.ensureAllNotesCache();
        return;
      }

      const scopeCatId = appState.searchReturnTarget?.catId || null;
      const scopeCat = scopeCatId ? CATEGORIES[scopeCatId] : null;
      const scopeLabel = scopeCat ? `${scopeCat.icon} ${scopeCat.name}` : '';
      const scopedIdx = scopeCatId
        ? searchIdx.filter(entry => getNoteCategories(entry.note).includes(scopeCatId))
        : searchIdx;

      const cleanQueryLower = keyword.trim().toLowerCase();
      const matchedScored = scopedIdx
        .filter(entry => keywords.every(kw => matchesSearchToken(entry.text, kw)))
        .map(entry => {
          const n = entry.note;
          const titleLower = (n.title || '').toLowerCase();
          const metaLower = `${n.keywords || ''} ${getNoteTags(n).join(' ')}`.toLowerCase();
          let rank = 0;
          if (titleLower.trim() === cleanQueryLower) {
            rank += 200;
          }
          for (const kw of keywords) {
            if (matchesSearchToken(titleLower, kw, true)) rank += 120;
            else if (matchesSearchToken(titleLower, kw)) rank += 90;
            else if (matchesSearchToken(metaLower, kw, true)) rank += 60;
            else if (matchesSearchToken(metaLower, kw)) rank += 45;
            else if (matchesSearchToken(entry.text, kw, true)) rank += 20;
            else rank += 10;
          }
          return { note: n, rank };
        });

      matchedScored.sort((a, b) => b.rank - a.rank);
      const results = matchedScored.map(item => item.note);

      // DOM 과부하 방지: 상위 SEARCH_RENDER_LIMIT(40건)만 우선 시그니처 비교 및 렌더링
      const visibleSlice = results.slice(0, SEARCH_RENDER_LIMIT);
      const signature = `${scopeCatId || 'ALL'}::${keyword}::${results.length}::${visibleSlice.map(n => `${n.id}|${n.title || ''}|${n.locked ? 1 : 0}`).join(';;')}`;
      if (fromCacheSync && signature === lastRenderedSearchSignature) {
        return;
      }
      lastRenderedSearchSignature = signature;
      lastKeywordResults = results;
      lastKeywordTerms = keywords;
      lastKeywordShownCount = visibleSlice.length;

      if (results.length === 0) {
        searchResults.innerHTML = `<div class="search-no-result">
          <div>🔍 ${scopeLabel ? `<b>${escHtml(scopeLabel)}</b> 내에서 ` : ''}"<b>${escHtml(keyword)}</b>" 키워드 일치 결과가 없어요</div>
          <div style="margin-top:12px">
            <button type="button" data-run-ai-search="1" style="padding:8px 14px;border-radius:10px;border:1.5px solid #6366F1;background:#EEF2FF;color:#4338CA;font-weight:700;font-size:13px;cursor:pointer">✨ 이 내용으로 AI 의미 검색 · 추론 실행</button>
          </div>
        </div>`;
        return;
      }

      const prevScrollY = window.scrollY;
      const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
        <span style="font-size:12px;color:var(--text-light)">${scopeLabel ? `${escHtml(scopeLabel)} 내 ` : ''}${results.length}개 검색됨</span>
        <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--border-color);background:transparent;color:var(--text);cursor:pointer;font-weight:600">${getSearchExitLabel()}</button>
      </div>`;
      const items = visibleSlice.map(note => renderKeywordCardHtml(note, keywords)).join('');
      const remaining = results.length - visibleSlice.length;
      const moreBtnHtml = remaining > 0
        ? `<button type="button" id="btn-search-more" style="width:100%;margin-top:6px;padding:10px;border-radius:10px;border:1.5px solid var(--border-color);background:var(--white);color:var(--text);font-size:13px;font-weight:600;cursor:pointer">더 보기 (남은 ${remaining}건)</button>`
        : '';
      searchResults.innerHTML = header + items + moreBtnHtml;
      if (fromCacheSync && prevScrollY > 0) {
        window.scrollTo(0, prevScrollY);
      }
    } catch (e: any) {
      searchResults.innerHTML = `<div style="color:var(--danger);font-size:13px">${escHtml(e.message)}</div>`;
    }
  }

  async function goToSearchDetailById(id: string, itemEl?: HTMLElement | null) {
    if (!id || isSelectingSearchResult) return;
    isSelectingSearchResult = true;
    if (searchTimeout) clearTimeout(searchTimeout);

    if (itemEl && searchResults) {
      searchResults.querySelectorAll('.search-result-item.selected').forEach(el => el.classList.remove('selected'));
      itemEl.classList.add('selected');
    }

    if (searchInput) {
      const raw = isMobileImeTrailingDuplicate(searchInput.value, lastValidSearchInputRaw)
        ? lastValidSearchInputRaw
        : searchInput.value;
      lastSearchedQuery = raw.trim();
      lockAndBlurSearchInput(raw);
    }
    if (searchTimeout) clearTimeout(searchTimeout);

    try {
      deps.setSavedSearchScrollY(window.scrollY);
      deps.clearDetailHistory();
      await deps.openNoteById(id, 'search');
    } finally {
      isSelectingSearchResult = false;
    }
  }

  function handleSearchEnterAction() {
    if (!searchInput) return;
    const now = Date.now();
    if (now - lastEnterHandledAt < 250) return;
    lastEnterHandledAt = now;

    let raw = searchInput.value;
    if (isMobileImeTrailingDuplicate(raw, lastValidSearchInputRaw)) {
      raw = lastValidSearchInputRaw;
      searchInput.value = raw;
    } else {
      lastValidSearchInputRaw = raw;
    }

    const v = raw.trim();
    lockAndBlurSearchInput(raw);
    if (!v) return;
    runAiSemanticSearch(v);
  }

  // 이벤트 바인딩
  if (btnToggleSearch && searchWrap) {
    btnToggleSearch.addEventListener('click', () => {
      deps.ensureSearchIndexReady();
      deps.ensureAllNotesCache();
      const isHidden = searchWrap.style.display === 'none';
      if (isHidden) {
        appState.searchReturnTarget = null;
        mountSearchPanelTo('home');
        syncSearchInputPlaceholder();
        searchWrap.style.display = 'block';
        searchInput?.focus();
      } else {
        exitSearchAndReturn();
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('beforeinput', (e: InputEvent) => {
      if (e.inputType === 'insertLineBreak') {
        e.preventDefault();
        handleSearchEnterAction();
      }
    });

    searchInput.addEventListener('input', (e: Event) => {
      const ie = e as InputEvent;
      if (imeEnterLockedRaw !== null && Date.now() < imeEnterLockUntil) {
        if (searchInput.value !== imeEnterLockedRaw) {
          searchInput.value = imeEnterLockedRaw;
        }
        return;
      }

      let rawVal = searchInput.value;
      if (isMobileImeTrailingDuplicate(rawVal, lastValidSearchInputRaw, ie.inputType)) {
        rawVal = lastValidSearchInputRaw;
        searchInput.value = rawVal;
      } else {
        lastValidSearchInputRaw = rawVal;
      }

      const v = rawVal.trim();
      if (searchClear) searchClear.style.display = v ? 'block' : 'none';
      if (searchTimeout) clearTimeout(searchTimeout);
      if (!v) {
        abortActiveAiSearch();
        resetAiSearchButton();
        lastSearchedQuery = '';
        isAiSearchActive = false;
        lastRenderedSearchSignature = '';
        if (aiRagContainer) {
          aiRagContainer.style.display = 'none';
          aiRagContainer.innerHTML = '';
        }
        if (searchResults) {
          searchResults.style.display = 'none';
          searchResults.innerHTML = '';
        }
        setHomeListVisible(true);
        return;
      }
      if (v === lastSearchedQuery && ((searchResults && searchResults.style.display !== 'none') || isAiSearchActive)) {
        return;
      }
      searchTimeout = setTimeout(() => {
        deps.ensureSearchIndexReady();
        deps.ensureAllNotesCache();
        doSearch(v);
      }, 220);
    });

    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        handleSearchEnterAction();
      }
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => resetSearchUI());
  }

  if (btnOpenAiConfig) {
    btnOpenAiConfig.addEventListener('click', () => openAiConfigModal());
  }
  const aiConfigCancel = $('ai-config-cancel');
  if (aiConfigCancel) {
    aiConfigCancel.addEventListener('click', () => closeAiConfigModal());
  }
  const aiConfigSave = $('ai-config-save') as HTMLButtonElement | null;
  if (aiConfigSave) {
    aiConfigSave.addEventListener('click', async () => {
      const key = aiApiKeyInput ? aiApiKeyInput.value.trim() : '';
      const proxy = aiProxyUrlInput ? aiProxyUrlInput.value.trim() : '';
      const syncCloud = aiSyncCloudCb ? aiSyncCloudCb.checked : false;
      aiConfigSave.disabled = true;
      try {
        const ai = await deps.getAi();
        await ai.saveAiConfig(key, proxy, syncCloud);
        showToast(key || proxy ? 'AI 설정이 저장되었어요 ✨' : 'AI 설정이 초기화되었어요');
        closeAiConfigModal();
      } catch (e: any) {
        showToast('설정 저장 실패: ' + (e?.message || '오류'));
      } finally {
        aiConfigSave.disabled = false;
      }
    });
  }
  if (aiConfigModal) {
    aiConfigModal.addEventListener('click', e => {
      if ((e.target as HTMLElement).id === 'ai-config-modal') closeAiConfigModal();
    });
  }

  if (btnBackfillEmbeddings) {
    btnBackfillEmbeddings.addEventListener('click', async () => {
      const ai = await deps.getAi();
      if (!ai.hasAiCredentials()) {
        const tempKey = aiApiKeyInput?.value.trim() || '';
        const tempProxy = aiProxyUrlInput?.value.trim() || '';
        if (!tempKey && !tempProxy) {
          showToast('먼저 Gemini API 키를 입력하고 저장해주세요');
          return;
        }
        await ai.saveAiConfig(tempKey, tempProxy, aiSyncCloudCb ? aiSyncCloudCb.checked : false);
      }
      btnBackfillEmbeddings.disabled = true;
      btnBackfillEmbeddings.textContent = '⏳ 변환 중...';
      try {
        const res = await ai.backfillMissingEmbeddings((done, total, title) => {
          if (aiBackfillStatus) {
            aiBackfillStatus.textContent = `진행 중 (${done}/${total}): "${title}" 임베딩 생성 중...`;
          }
        });
        if (aiBackfillStatus) {
          aiBackfillStatus.textContent = `완료! 신규 변환 ${res.updated}건 · 기존 보유 ${res.skipped}건${res.failed ? ` · 실패 ${res.failed}건` : ''}`;
        }
        showToast(`임베딩 일괄 생성 완료 (${res.updated}건 변환) ✨`);
      } catch (e: any) {
        if (aiBackfillStatus) {
          aiBackfillStatus.textContent = '오류: ' + (e?.message || '일괄 변환 실패');
        }
        showToast('임베딩 변환 실패: ' + (e?.message || '오류'));
      } finally {
        btnBackfillEmbeddings.disabled = false;
        btnBackfillEmbeddings.textContent = '일괄 변환 실행';
      }
    });
  }

  if (aiRagContainer) {
    aiRagContainer.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const ragTrigger = target.closest('#btn-run-rag-answer') as HTMLButtonElement | null;
      if (ragTrigger && pendingRagContext) {
        e.preventDefault();
        const { queryText, results, token } = pendingRagContext;
        runRagAnswerForContext(queryText, results, token).catch(() => {});
        return;
      }
      const linkEl = target.closest('.note-link') as HTMLElement | null;
      if (linkEl && linkEl.dataset.noteId) {
        e.preventDefault();
        e.stopPropagation();
        deps.setSavedSearchScrollY(window.scrollY);
        deps.clearDetailHistory();
        deps.setDetailFrom('search');
        deps.openNoteById(linkEl.dataset.noteId, 'search');
      }
    });

    aiRagContainer.addEventListener('change', (e: Event) => {
      const target = e.target as HTMLInputElement | null;
      if (target && target.id === 'cb-ai-auto-rag') {
        setAutoRagEnabled(target.checked);
        showToast(target.checked ? '앞으로 AI 종합 답변을 자동으로 표시해요 ✨' : '빠른 하이브리드 검색 모드로 전환했어요 ⚡');
        // 사용자가 체크를 켰는데 아직 요약 버튼만 떠 있다면 즉시 요약 실행
        if (target.checked && pendingRagContext && aiRagContainer.querySelector('#btn-run-rag-answer')) {
          const { queryText, results, token } = pendingRagContext;
          runRagAnswerForContext(queryText, results, token).catch(() => {});
        }
      }
    });
  }

  if (btnAiSearch) {
    const lockBeforeAiBtn = () => {
      if (!searchInput) return;
      const raw = isMobileImeTrailingDuplicate(searchInput.value, lastValidSearchInputRaw)
        ? lastValidSearchInputRaw
        : searchInput.value;
      lastValidSearchInputRaw = raw;
      imeEnterLockedRaw = raw;
      imeEnterLockUntil = Date.now() + 600;
    };
    btnAiSearch.addEventListener('touchstart', lockBeforeAiBtn, { passive: true });
    btnAiSearch.addEventListener('mousedown', lockBeforeAiBtn);
    btnAiSearch.addEventListener('click', () => {
      const raw = searchInput
        ? (isMobileImeTrailingDuplicate(searchInput.value, lastValidSearchInputRaw)
            ? lastValidSearchInputRaw
            : searchInput.value)
        : '';
      if (searchInput && raw) lockAndBlurSearchInput(raw);
      runAiSemanticSearch(raw.trim());
    });
  }

  if (searchResults) {
    let startScreenX = 0, startScreenY = 0;
    let startScrollY = 0;
    let isMoving = false;
    let touchStartId: string | null = null;
    let touchStartItem: HTMLElement | null = null;
    let lastTouchEndTime = 0;

    let mouseDownId: string | null = null;
    let mouseDownItem: HTMLElement | null = null;
    let mouseDownX = 0, mouseDownY = 0;
    let mouseDownScrollY = 0;

    const itemOf = (e: Event) => (e.target as HTMLElement).closest('.search-result-item') as HTMLElement | null;

    searchResults.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        isMoving = true;
        touchStartId = null;
        touchStartItem = null;
        return;
      }
      isPointerDownOnSearchResults = true;
      const touch = e.touches[0];
      startScreenX = touch.screenX;
      startScreenY = touch.screenY;
      startScrollY = window.scrollY;
      isMoving = false;
      touchStartItem = itemOf(e);
      touchStartId = touchStartItem?.dataset.id || null;
    }, { passive: true });

    searchResults.addEventListener('touchmove', (e: TouchEvent) => {
      if (isMoving || !e.touches[0]) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.screenX - startScreenX);
      const dy = Math.abs(touch.screenY - startScreenY);
      const scrollDiff = Math.abs(window.scrollY - startScrollY);
      if (dx > 12 || dy > 12 || scrollDiff > 8) {
        isMoving = true;
        touchStartId = null;
        touchStartItem = null;
      }
    }, { passive: true });

    searchResults.addEventListener('touchend', (e: TouchEvent) => {
      isPointerDownOnSearchResults = false;
      lastTouchEndTime = Date.now();

      if (!isMoving && (e.target as HTMLElement).closest('[data-run-ai-search]')) {
        if (e.cancelable) e.preventDefault();
        touchStartId = null;
        touchStartItem = null;
        const q = searchInput ? searchInput.value.trim() : '';
        searchInput?.blur();
        runAiSemanticSearch(q);
        return;
      }

      if (!isMoving && (e.target as HTMLElement).closest('#btn-search-more')) {
        if (e.cancelable) e.preventDefault();
        touchStartId = null;
        touchStartItem = null;
        appendMoreKeywordResults();
        return;
      }

      if (!isMoving && (e.target as HTMLElement).closest('#search-home-btn')) {
        if (e.cancelable) e.preventDefault();
        touchStartId = null;
        touchStartItem = null;
        exitSearchAndReturn();
        return;
      }

      const targetId = touchStartId;
      const targetItem = touchStartItem;
      touchStartId = null;
      touchStartItem = null;

      if (!targetId || isMoving) return;
      if (e.cancelable) e.preventDefault();
      goToSearchDetailById(targetId, targetItem);
    }, { passive: false });

    searchResults.addEventListener('touchcancel', () => {
      isPointerDownOnSearchResults = false;
      lastTouchEndTime = Date.now();
      isMoving = true;
      touchStartId = null;
      touchStartItem = null;
    }, { passive: true });

    searchResults.addEventListener('mousedown', (e: MouseEvent) => {
      if (Date.now() - lastTouchEndTime < 700) return;
      if (e.button !== 0) return;
      const item = itemOf(e);
      if (!item || !item.dataset.id) {
        mouseDownId = null;
        mouseDownItem = null;
        return;
      }
      e.preventDefault();
      isPointerDownOnSearchResults = true;
      mouseDownItem = item;
      mouseDownId = item.dataset.id;
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
      mouseDownScrollY = window.scrollY;
    });

    searchResults.addEventListener('mouseup', () => {
      isPointerDownOnSearchResults = false;
    });

    searchResults.addEventListener('click', (e: MouseEvent) => {
      isPointerDownOnSearchResults = false;
      if (Date.now() - lastTouchEndTime < 700) return;

      if ((e.target as HTMLElement).closest('[data-run-ai-search]')) {
        mouseDownId = null;
        mouseDownItem = null;
        const q = searchInput ? searchInput.value.trim() : '';
        searchInput?.blur();
        runAiSemanticSearch(q);
        return;
      }

      if ((e.target as HTMLElement).closest('#btn-search-more')) {
        mouseDownId = null;
        mouseDownItem = null;
        appendMoreKeywordResults();
        return;
      }

      if ((e.target as HTMLElement).closest('#search-home-btn')) {
        mouseDownId = null;
        mouseDownItem = null;
        exitSearchAndReturn();
        return;
      }

      const targetId = mouseDownId;
      const targetItem = mouseDownItem;
      mouseDownId = null;
      mouseDownItem = null;

      if (targetId) {
        const moved = Math.abs(e.clientX - mouseDownX) > 20 || Math.abs(e.clientY - mouseDownY) > 20;
        const scrolled = Math.abs(window.scrollY - mouseDownScrollY) > 10;
        if (!moved && !scrolled) {
          goToSearchDetailById(targetId, targetItem);
        }
        return;
      }

      const clickedItem = itemOf(e);
      if (clickedItem?.dataset.id) {
        goToSearchDetailById(clickedItem.dataset.id, clickedItem);
      }
    });
  }

  return {
    resetSearchUI,
    closeAiConfigModal,
    doSearch,
    restoreSearchScreenIfHasContent: () => {
      const hasSearchContent =
        (searchResults && searchResults.innerHTML.trim() !== '') ||
        (aiRagContainer && aiRagContainer.innerHTML.trim() !== '');
      if (!hasSearchContent) return false;
      const targetScreen = appState.searchReturnTarget ? 'list' : 'home';
      mountSearchPanelTo(targetScreen);
      if (searchWrap) searchWrap.style.display = 'block';
      if (searchResults && searchResults.innerHTML.trim() !== '') {
        searchResults.style.display = 'block';
      }
      if (aiRagContainer && aiRagContainer.innerHTML.trim() !== '') {
        aiRagContainer.style.display = 'block';
      }
      setHomeListVisible(false);
      showAppScreen(targetScreen);
      const scrollY = deps.getSavedSearchScrollY();
      if (scrollY > 0) {
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
      }
      return true;
    },
    isSearchVisibleOnHome: () => Boolean(
      (searchResults && searchResults.style.display !== 'none' && searchResults.innerHTML.trim() !== '') ||
      (aiRagContainer && aiRagContainer.style.display !== 'none' && aiRagContainer.innerHTML.trim() !== '')
    ),
    isSearchWrapOpen: () => Boolean(searchWrap && searchWrap.style.display !== 'none'),
    openSearchWrapAndFocus: (mode: 'home' | 'list' = 'home') => {
      deps.ensureSearchIndexReady();
      deps.ensureAllNotesCache();
      mountSearchPanelTo(mode);
      syncSearchInputPlaceholder();
      if (searchWrap) searchWrap.style.display = 'block';
      const listSearchBtn = $('btn-list-search');
      if (listSearchBtn) listSearchBtn.classList.toggle('active', mode === 'list');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    },
    closeSearchWrap: () => {
      appState.searchReturnTarget = null;
      if (searchWrap) searchWrap.style.display = 'none';
      resetSearchUI();
      syncSearchInputPlaceholder();
      mountSearchPanelTo('home');
    },
    exitSearchAndReturn,
    shouldSyncSearchOnCacheUpdate: () => {
      if (
        searchInput &&
        searchInput.value.trim() &&
        searchWrap &&
        searchWrap.style.display !== 'none' &&
        !isSelectingSearchResult &&
        !isPointerDownOnSearchResults &&
        !isAiSearchActive &&
        (currentScreen() === 'home' || currentScreen() === 'list')
      ) {
        return searchInput.value.trim();
      }
      return null;
    },
    syncSearchResultOnNoteUpdated: (noteId, updated, detailFrom) => {
      if (detailFrom !== 'search' || !searchResults) return;
      if (!isAiSearchActive && lastSearchedQuery) {
        doSearch(lastSearchedQuery, true);
        return;
      }
      const card = searchResults.querySelector(`.search-result-item[data-id="${CSS.escape(noteId)}"]`) as HTMLElement | null;
      if (card) {
        const titleEl = card.querySelector('.search-result-title');
        if (titleEl) {
          const badge = titleEl.querySelector('.ai-sim-badge')?.outerHTML || '';
          titleEl.innerHTML = `${updated.locked ? '🔒 ' : ''}${escHtml(updated.title || '제목 없음')}${badge}`;
        }
        const bodyEl = card.querySelector('.search-result-body');
        if (bodyEl) {
          const snip = (updated.body || '')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼️ ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 120);
          bodyEl.textContent = updated.locked ? '🔒 잠긴 메모입니다' : snip;
        }
      }
    },
    syncSearchResultOnNoteDeleted: (noteId, detailFrom) => {
      if (!searchResults) return;
      if (!isAiSearchActive && lastSearchedQuery && detailFrom === 'search') {
        doSearch(lastSearchedQuery, true);
        return;
      }
      const card = searchResults.querySelector(`.search-result-item[data-id="${CSS.escape(noteId)}"]`);
      if (card) card.remove();
      const remaining = searchResults.querySelectorAll('.search-result-item').length;
      if (remaining === 0 && searchResults.style.display !== 'none') {
        searchResults.innerHTML = `<div class="search-no-result">🔍 남은 검색 결과가 없어요</div>`;
      }
    },
  };
}
