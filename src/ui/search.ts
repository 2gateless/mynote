import { appState, SearchIndexEntry } from '../state';
import { CATEGORIES, getNoteCategories, getNoteTags } from '../services/database';
import { escHtml, parseMarkdownBody } from '../utils/formatter';
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
  closeSearchWrap: () => void;
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

  function setHomeListVisible(visible: boolean) {
    const fl = $('folders-list');
    const mh = $('folders-meta-header');
    if (fl) fl.style.display = visible ? '' : 'none';
    if (mh) mh.style.display = visible ? '' : 'none';
  }

  function resetSearchUI() {
    deps.setSavedSearchScrollY(0);
    deps.clearDetailHistory();
    if (searchTimeout) clearTimeout(searchTimeout);
    lastSearchedQuery = '';
    lastValidSearchInputRaw = '';
    imeEnterLockedRaw = null;
    imeEnterLockUntil = 0;
    isAiSearchActive = false;
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

    const token = ++aiSearchSessionToken;
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
      btnAiSearch.innerHTML = '<span>⏳</span><span>의미 분석 중...</span>';
    }

    if (aiRagContainer) {
      aiRagContainer.style.display = 'block';
      aiRagContainer.innerHTML = `
        <div class="ai-rag-card">
          <div class="ai-rag-header">
            <div class="ai-rag-title"><span>✨</span><span>AI 시맨틱 검색 & 종합·추론</span></div>
            <span class="ai-rag-badge">Gemini Flash</span>
          </div>
          <div class="ai-rag-body" style="color:var(--text-light)">
            🧠 질문을 임베딩(<code>gemini-embedding-001</code>)하여 연관 메모를 탐색하고 있습니다...
          </div>
        </div>
      `;
    }

    if (searchResults) {
      searchResults.style.display = 'block';
      searchResults.innerHTML = `<div class="search-no-result" style="color:var(--text-light);font-size:13.5px;padding:20px 0">🔍 코사인 유사도 기반으로 연관 메모를 추출하는 중...</div>`;
    }

    try {
      const { results, embeddedNotesCount } = await ai.semanticSearchNotes(queryText, 5);
      if (token !== aiSearchSessionToken) return;

      if (results.length === 0) {
        if (aiRagContainer) {
          aiRagContainer.innerHTML = `
            <div class="ai-rag-card">
              <div class="ai-rag-header">
                <div class="ai-rag-title"><span>✨</span><span>AI 검색 결과 안내</span></div>
              </div>
              <div class="ai-rag-body">
                ${embeddedNotesCount === 0
                  ? '아직 임베딩 벡터가 저장된 메모가 없습니다. <b>⚙️ AI 설정 → 기존 메모 일괄 임베딩 생성</b>을 먼저 실행하시거나 새 메모를 저장해 주세요.'
                  : `"<b>${escHtml(queryText)}</b>"와(과) 의미적으로 연관도가 높은 메모를 찾지 못했습니다.`}
              </div>
            </div>
          `;
        }
        if (searchResults) {
          searchResults.innerHTML = `<div class="search-no-result">🔍 연관된 메모가 없어요</div>`;
        }
        return;
      }

      const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
        <span style="font-size:12px;color:#4338CA;font-weight:700">✨ 시맨틱 연관 상위 ${results.length}개 메모 (코사인 유사도순)</span>
        <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--border-color);background:transparent;color:var(--text);cursor:pointer;font-weight:600">🏠 홈으로</button>
      </div>`;

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
        return `<div class="search-result-item" data-id="${escHtml(note.id || '')}" data-cat="${escHtml(note.category)}">
          <div class="search-result-title">${note.locked ? '🔒 ' : ''}${escHtml(note.title || '제목 없음')}${simBadge}</div>
          ${catBadgesHtml}
          ${getNoteTags(note).map(t => `<span class="search-result-cat" style="background:var(--sky-dark);color:white;margin-left:4px">#${escHtml(t)}</span>`).join('')}
          <div class="search-result-body">${note.locked ? '🔒 잠긴 메모입니다' : escHtml(snippet)}</div>
        </div>`;
      }).join('');

      if (searchResults) {
        searchResults.innerHTML = header + items;
      }

      const unlockedRefCount = Math.min(5, results.filter(r => !r.note.locked).length);
      if (aiRagContainer) {
        aiRagContainer.innerHTML = `
          <div class="ai-rag-card">
            <div class="ai-rag-header">
              <div class="ai-rag-title"><span>🤖</span><span>AI 종합 및 추론 답변</span></div>
              <span class="ai-rag-badge">상위 ${unlockedRefCount}개 메모 참조 중...</span>
            </div>
            <div class="ai-rag-body" id="ai-rag-stream-body" style="color:var(--text-light)">
              ✍️ 추출된 상위 ${unlockedRefCount}개 메모를 바탕으로 답변을 실시간 작성 중입니다...
            </div>
          </div>
        `;
      }

      let lastStreamRenderAt = 0;
      let streamRenderPending = false;
      let latestStreamText = '';

      const renderStreamBody = async (markdownText: string) => {
        if (token !== aiSearchSessionToken) return;
        const cleanPartial = markdownText.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
        if (!cleanPartial) return;
        const html = await parseMarkdownBody(cleanPartial);
        if (token !== aiSearchSessionToken) return;
        const streamBodyEl = $('ai-rag-stream-body');
        if (streamBodyEl) {
          streamBodyEl.style.color = '';
          streamBodyEl.innerHTML = html;
        }
      };

      const answerMarkdown = await ai.generateRagAnswerStream(queryText, results, (accumulated) => {
        if (token !== aiSearchSessionToken) return;
        latestStreamText = accumulated;
        const now = Date.now();
        if (!streamRenderPending && now - lastStreamRenderAt >= 80) {
          lastStreamRenderAt = now;
          renderStreamBody(accumulated).catch(() => {});
        } else if (!streamRenderPending) {
          streamRenderPending = true;
          setTimeout(() => {
            streamRenderPending = false;
            lastStreamRenderAt = Date.now();
            if (latestStreamText) renderStreamBody(latestStreamText).catch(() => {});
          }, 80);
        }
      });
      if (token !== aiSearchSessionToken) return;

      const cleanAnswer = answerMarkdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
      const renderedHtml = await parseMarkdownBody(cleanAnswer);
      if (token !== aiSearchSessionToken) return;

      if (aiRagContainer) {
        aiRagContainer.innerHTML = `
          <div class="ai-rag-card">
            <div class="ai-rag-header">
              <div class="ai-rag-title"><span>✨</span><span>AI 종합 및 추론 답변</span></div>
              <span class="ai-rag-badge">참조 메모 ${unlockedRefCount}건 · Gemini Flash</span>
            </div>
            <div class="ai-rag-body">${renderedHtml}</div>
          </div>
        `;
      }
    } catch (e: any) {
      if (token !== aiSearchSessionToken) return;
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
      if (token === aiSearchSessionToken && btnAiSearch) {
        btnAiSearch.disabled = false;
        btnAiSearch.innerHTML = '<span>✨</span><span>AI 의미 검색 · 추론</span>';
      }
    }
  }

  function doSearch(keyword: string, fromCacheSync = false) {
    if (!searchResults) return;
    if (!fromCacheSync) {
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

      const results = searchIdx
        .filter(entry => keywords.every(kw => entry.text.includes(kw)))
        .map(entry => entry.note);

      const signature = `${keyword}::${results.map(n => `${n.id}|${n.title || ''}|${getNoteCategories(n).join(',')}|${getNoteTags(n).join(',')}|${n.locked ? 1 : 0}|${n.snippet || ''}`).join(';;')}`;
      if (fromCacheSync && signature === lastRenderedSearchSignature) {
        return;
      }
      lastRenderedSearchSignature = signature;

      if (results.length === 0) {
        searchResults.innerHTML = `<div class="search-no-result">
          <div>🔍 "<b>${escHtml(keyword)}</b>" 키워드 일치 결과가 없어요</div>
          <div style="margin-top:12px">
            <button type="button" data-run-ai-search="1" style="padding:8px 14px;border-radius:10px;border:1.5px solid #6366F1;background:#EEF2FF;color:#4338CA;font-weight:700;font-size:13px;cursor:pointer">✨ 이 내용으로 AI 의미 검색 · 추론 실행</button>
          </div>
        </div>`;
        return;
      }

      const prevScrollY = window.scrollY;
      const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
        <span style="font-size:12px;color:var(--text-light)">${results.length}개 검색됨</span>
        <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--border-color);background:transparent;color:var(--text);cursor:pointer;font-weight:600">🏠 홈으로</button>
      </div>`;
      const items = results.map(note => {
        const noteCats = getNoteCategories(note);
        const catBadgesHtml = noteCats.map(cid => {
          const c = CATEGORIES[cid];
          return c ? `<span class="detail-cat-badge">${c.icon} ${escHtml(c.name)}</span>` : '';
        }).join('');
        return `<div class="search-result-item" data-id="${escHtml(note.id)}" data-cat="${escHtml(note.category)}">
          <div class="search-result-title">${note.locked ? '🔒 ' : ''}${escHtml(note.title || '제목 없음')}</div>
          ${catBadgesHtml}
          ${getNoteTags(note).map(t => `<span class="search-result-cat" style="background:var(--sky-dark);color:white;margin-left:4px">#${escHtml(t)}</span>`).join('')}
          <div class="search-result-body">${note.locked ? '🔒 잠긴 메모입니다' : escHtml((note.snippet || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼️ ').replace(/\s+/g, ' ').trim())}</div>
        </div>`;
      }).join('');
      searchResults.innerHTML = header + items;
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
      searchWrap.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        searchInput?.focus();
        // 검색창을 열 때 로컬 IndexedDB 벡터 맵을 백그라운드로 미리 메모리에 올려두어
        // 이후 AI 시맨틱 검색 실행 시 대기 시간을 줄임 (Firestore 읽기 0회)
        deps.getAi().then(ai => ai.preloadVectorCache()).catch(() => {});
      } else {
        resetSearchUI();
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
        lastSearchedQuery = '';
        isAiSearchActive = false;
        lastRenderedSearchSignature = '';
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
      }, 300);
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
      const linkEl = (e.target as HTMLElement).closest('.note-link') as HTMLElement | null;
      if (linkEl && linkEl.dataset.noteId) {
        e.preventDefault();
        e.stopPropagation();
        deps.setSavedSearchScrollY(window.scrollY);
        deps.clearDetailHistory();
        deps.setDetailFrom('search');
        deps.openNoteById(linkEl.dataset.noteId, 'search');
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

      if (!isMoving && (e.target as HTMLElement).closest('#search-home-btn')) {
        if (e.cancelable) e.preventDefault();
        touchStartId = null;
        touchStartItem = null;
        resetSearchUI();
        showAppScreen('home');
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

      if ((e.target as HTMLElement).closest('#search-home-btn')) {
        mouseDownId = null;
        mouseDownItem = null;
        resetSearchUI();
        showAppScreen('home');
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
      if (searchWrap) searchWrap.style.display = 'block';
      if (searchResults && searchResults.innerHTML.trim() !== '') {
        searchResults.style.display = 'block';
      }
      if (aiRagContainer && aiRagContainer.innerHTML.trim() !== '') {
        aiRagContainer.style.display = 'block';
      }
      setHomeListVisible(false);
      showAppScreen('home');
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
    closeSearchWrap: () => {
      if (searchWrap) searchWrap.style.display = 'none';
      resetSearchUI();
    },
    shouldSyncSearchOnCacheUpdate: () => {
      if (
        searchInput &&
        searchInput.value.trim() &&
        searchWrap &&
        searchWrap.style.display !== 'none' &&
        !isSelectingSearchResult &&
        !isPointerDownOnSearchResults &&
        !isAiSearchActive &&
        currentScreen() === 'home'
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
