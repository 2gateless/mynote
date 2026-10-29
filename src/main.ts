import { Timestamp } from 'firebase/firestore';
import { appState } from './state';
import { 
  initAuthListener, 
  loginWithGoogle, 
  logout 
} from './services/auth';
import { 
  CATEGORIES, 
  getNoteCategories,
  getNoteTags,
  SUB_TAGS, 
  subscribeUserMeta, 
  subscribeAllNotes, 
  subscribeCategoryIndex,
  rebuildCategoryIndex,
  getSingleNote, 
  createNoteWithIndex, 
  updateNoteWithIndex,
  deleteNoteWithIndex 
} from './services/database';
import { 
  escHtml, 
  fmtDate, 
  toMillis,
  parseMarkdownBody 
} from './utils/formatter';
import { 
  getShareText, 
  shareViaEmail, 
  shareViaKakao, 
  shareViaTelegram, 
  shareViaNative 
} from './utils/share';
import { 
  compressImage, 
  imageFileName,
  uploadImageToStorage, 
  deleteImagesFromStorage, 
  collectImagePaths 
} from './utils/image';
import { showToast } from './utils/toast';
import { initImageViewer } from './ui/imageViewer';
import {
  initPinModal,
  verifyLockPinForNote,
  scheduleInitialPinSetupCheck,
  getStoredLockPin,
  openPinModal,
  closePinModalByBack
} from './ui/pinModal';
import { 
  showAppScreen, 
  showRootScreen, 
  initPwaNavigation,
  currentScreen 
} from './pwa';
import { NoteIndexItem } from './types';
import {
  tryGenerateNoteEmbedding,
  semanticSearchNotes,
  generateRagAnswer,
  hasAiCredentials,
  getGeminiApiKey,
  getAiProxyUrl,
  saveAiConfig,
  syncAiConfigFromUserMeta,
  backfillMissingEmbeddings,
  upsertVectorNoteCache,
  removeVectorNoteCache
} from './services/ai';

let recognition: any = null;
let isRecording = false;
let metaUnsubscribe: (() => void) | null = null;
let listUnsubscribe: (() => void) | null = null;
let notesUnsubscribe: (() => void) | null = null;
let searchTimeout: any = null;
let lastSearchedQuery = '';
let isAiSearchActive = false;
let lastRenderedSearchSignature = '';
let isSelectingSearchResult = false;
let isPointerDownOnSearchResults = false;
let detailFrom = 'list'; // 'list' or 'search'
let detailRenderToken = 0;

// 모달에서 새로 업로드한 인라인 이미지 경로 추적 (취소/수정 시 미사용 파일 정리용)
let sessionUploadedInlineImages: { url: string; path: string }[] = [];

// 목록 화면 캐시 (같은 카테고리에서 태그만 바꿀 때 재구독하지 않기 위함)
let listCatId: string | null = null;
let listNotesCache: NoteIndexItem[] = [];
let pendingListCat: string | null = null; // 인증 완료 전 목록 요청 대기용
let listLoadTimer: any = null; // 목록 로딩 타임아웃 타이머
// 구버전 인덱스 자동 보정을 세션당 카테고리별 1회만 수행
const rebuiltCats = new Set<string>();
// 최근 카테고리 카운트 (인덱스 누락 감지용)
let lastCounts: Record<string, number> = {};

const koCollator = new Intl.Collator('ko');

// ─────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id);

function setDisplay(id: string, value: string) {
  const el = $(id);
  if (el) el.style.display = value;
}

function clearAuthCache() {
  if (persistCacheTimer) {
    clearTimeout(persistCacheTimer);
    persistCacheTimer = null;
  }
  try {
    localStorage.removeItem('mynote_user_cache');
    localStorage.removeItem('mynote_counts_cache');
    localStorage.removeItem('mynote_search_cache');
  } catch (e) {}
  document.documentElement.classList.remove('has-cached-auth');
}

// 카테고리별/전체 카운트 표시
function applyCounts(counts: Record<string, number>) {
  let total = 0;
  Object.keys(CATEGORIES).forEach(catId => {
    const n = Math.max(0, counts[catId] || 0);
    total += n;
    const cnt = $('cnt-' + catId);
    if (cnt) cnt.textContent = String(n);
  });
  const totalCnt = $('cnt-total-notes');
  if (totalCnt) totalCnt.textContent = String(total);
}

// 태그 칩 HTML (클릭은 이벤트 위임으로 처리 — 인라인 onclick 미사용)
function tagChipHtml(category: string, tag: string, className: string, style = '') {
  return `<span class="${className}" data-tag-link data-cat="${escHtml(category)}" data-tag="${escHtml(tag)}"${style ? ` style="${style}"` : ''}>#${escHtml(tag)}</span>`;
}

// 위임된 클릭 이벤트에서 태그 칩을 처리. 처리했으면 true
function handleTagLink(e: Event): boolean {
  const el = (e.target as HTMLElement).closest('[data-tag-link]') as HTMLElement | null;
  if (!el) return false;
  e.preventDefault();
  e.stopPropagation();
  if (el.dataset.cat) openList(el.dataset.cat, el.dataset.tag || null);
  return true;
}

function insertAtCursor(ta: HTMLTextAreaElement, text: string) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + text.length;
  ta.focus();
}

function renderUserBar(user: any) {
  const av = $('user-bar-avatar');
  const nameEl = $('user-bar-name');
  if (nameEl) nameEl.textContent = user.displayName || user.email;
  if (av) {
    av.textContent = '';
    if (user.photoURL) {
      av.className = 'user-bar-avatar';
      // innerHTML 대신 DOM API로 생성 (URL 이스케이프 문제 방지)
      const img = document.createElement('img');
      img.src = user.photoURL;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.className = 'user-bar-avatar-default';
      av.textContent = (user.displayName || 'U')[0].toUpperCase();
    }
  }
}

// ─────────────────────────────────────────────
// 로컬 스토리지 조기 캐시 복원 & 지능형 검색 인덱스 준비
// ─────────────────────────────────────────────
let isSearchIndexReady = false;
let persistCacheTimer: any = null;

// 검색 캐시 localStorage 직렬화를 유휴 시간으로 지연하여 메인 스레드 블로킹 방지
function schedulePersistSearchCache(notes: NoteIndexItem[]) {
  if (persistCacheTimer) clearTimeout(persistCacheTimer);
  persistCacheTimer = setTimeout(() => {
    persistCacheTimer = null;
    const writeCache = () => {
      try {
        localStorage.setItem('mynote_search_cache', JSON.stringify(notes));
      } catch (e) {
        console.warn('검색 캐시 로컬 저장 실패:', e);
      }
    };
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(writeCache, { timeout: 2000 });
    } else {
      writeCache();
    }
  }, 400);
}

// 로컬 스토리지의 검색 캐시를 복원하는 함수 (필요 시 즉시 동기 실행 가능)
function ensureSearchIndexReady(): boolean {
  if (isSearchIndexReady) return true;
  try {
    const rawSearch = localStorage.getItem('mynote_search_cache');
    if (rawSearch) {
      const cachedNotes = JSON.parse(rawSearch);
      if (Array.isArray(cachedNotes) && cachedNotes.length > 0) {
        updateNotesCache(cachedNotes, false);
        isSearchIndexReady = true;
        const totalCnt = $('cnt-total-notes');
        if (totalCnt && (!totalCnt.textContent || totalCnt.textContent === '0')) {
          totalCnt.textContent = String(cachedNotes.length);
        }
        return true;
      }
    }
  } catch (e) {
    console.warn('검색 캐시 복원 실패:', e);
  }
  return false;
}

// 1단계: 첫 화면(홈 화면)을 0.001초 만에 즉시 띄우기 위해 유저 프로필과 카운트만 동기 복원
function applyEarlyCache() {
  try {
    const rawUser = localStorage.getItem('mynote_user_cache');
    if (rawUser) {
      renderUserBar(JSON.parse(rawUser));
      scheduleInitialPinSetupCheck();
    syncAiConfigFromUserMeta().catch(() => {});
      showRootScreen('app');
    }
    const rawCounts = localStorage.getItem('mynote_counts_cache');
    if (rawCounts) {
      lastCounts = JSON.parse(rawCounts);
      applyCounts(lastCounts);
    }

    // 2단계: 무거운 전체 검색 캐시 파싱 및 소문자 맵 구축은
    // 첫 프레임 페인팅을 막지 않도록 브라우저가 화면을 그린 직후 백그라운드에서 실행
    const scheduleWarmup = () => {
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(() => ensureSearchIndexReady(), { timeout: 1500 });
      } else {
        setTimeout(ensureSearchIndexReady, 50);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => scheduleWarmup());
    } else {
      setTimeout(scheduleWarmup, 0);
    }
  } catch (e) {
    console.warn('초기 캐시 복원 실패:', e);
  }
}

// 스크립트 실행 즉시 1단계 캐시 적용 -> 첫 화면 0.001초 초고속 노출
applyEarlyCache();

// ─────────────────────────────────────────────
// 전체 메모 인덱스 캐시 (검색·메모 링크용)
// ─────────────────────────────────────────────
let pendingAllNotesSubscription = false;
let hasNotesLoaded = false;

function ensureAllNotesCache() {
  if (notesUnsubscribe) return; // 이미 구독 중이면 중복 방지
  if (!appState.currentUser) {
    // Auth 인증 완료 전이면 플래그만 세워두고 인증 완료 시 즉시 구독
    pendingAllNotesSubscription = true;
    return;
  }
  pendingAllNotesSubscription = false;
  subscribeAllNotesCache();
}

// 캐시 갱신 시 검색용 텍스트/제목 Map을 한 번만 계산해 둔다
function updateNotesCache(notes: NoteIndexItem[], persist = true) {
  hasNotesLoaded = true;
  isSearchIndexReady = true;
  appState.allNotesCache = notes;
  appState.searchIndex = notes.map(n => ({
    note: n,
    text: `${n.title || ''}\n${n.snippet || ''}\n${n.keywords || ''}\n${getNoteTags(n).join(' ')}`.toLowerCase()
  }));
  const map = new Map<string, NoteIndexItem>();
  for (const n of notes) {
    if (n.title && !map.has(n.title)) map.set(n.title, n);
  }
  appState.notesByTitle = map;
  appState.sortedNotesByTitle = null; // 메모 링크 모달을 열 때 지연 계산

  if (persist) {
    schedulePersistSearchCache(notes);
  }

  // 사용자가 이미 검색어를 입력해 둔 상태이고 터치/클릭 중이 아니라면 변경 시에만 검색 결과 갱신
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
    doSearch(searchInput.value.trim(), true);
  }
}

function subscribeAllNotesCache() {
  if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
  notesUnsubscribe = subscribeAllNotes((notes) => {
    updateNotesCache(notes, true);
    const totalCnt = $('cnt-total-notes');
    if (totalCnt) totalCnt.textContent = String(notes.length);
  });
}

function stopAllSubscriptions() {
  if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
  if (metaUnsubscribe) { metaUnsubscribe(); metaUnsubscribe = null; }
  stopListSubscription();
  pendingAllNotesSubscription = false;
}

// ─────────────────────────────────────────────
// AUTH & 초기화
// ─────────────────────────────────────────────
initAuthListener(
  async (user) => {
    try {
      localStorage.setItem('mynote_user_cache', JSON.stringify({
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        uid: user.uid
      }));
    } catch (e) {}
    renderUserBar(user);
    showRootScreen('app');
    loadAllCounts();
    scheduleInitialPinSetupCheck();
    syncAiConfigFromUserMeta().catch(() => {});

    // 사용자가 인증 완료 전에 이미 카테고리 목록을 열었거나 대기 중인 경우 즉시 실시간 동기화 시작
    const targetCat = pendingListCat || (currentScreen() === 'list' ? appState.currentCat : null);
    if (targetCat) {
      pendingListCat = null;
      loadList(targetCat, true);
    }

    // 사용자가 이미 검색창을 열었거나 인덱스 요청이 대기 중이면 즉시 동기화,
    // 그렇지 않다면 첫 화면 부팅 속도와 반응성을 최우선으로 보장하기 위해
    // 첫 렌더링이 완전히 안정화된 후(1.2초) 백그라운드에서 부드럽게 동기화
    if (pendingAllNotesSubscription || (searchWrap && searchWrap.style.display !== 'none')) {
      ensureAllNotesCache();
    } else {
      setTimeout(ensureAllNotesCache, 1200);
    }
  },
  (email) => {
    clearAuthCache();
    stopAllSubscriptions();
    const el = $('denied-email');
    if (el) el.textContent = email || '';
    showRootScreen('denied-screen');
  },
  () => {
    clearAuthCache();
    stopAllSubscriptions();
    showRootScreen('auth-screen');
  }
);

// 로딩 안전 타임아웃
// 1) 캐시가 있는 기존 사용자의 경우: 만에 하나 로딩 화면이 남아있다면 1초 후 강제 해제하고 홈 화면 표시
setTimeout(() => {
  const ls = $('loading-screen');
  if (ls && ls.style.display !== 'none' && localStorage.getItem('mynote_user_cache')) {
    showRootScreen('app');
  }
}, 1000);

// 2) 캐시가 없는 신규/로그아웃 사용자의 경우: 4초 후 로그인 화면 유도
setTimeout(() => {
  const ls = $('loading-screen');
  if (ls && ls.style.display !== 'none' && !localStorage.getItem('mynote_user_cache')) {
    showRootScreen('auth-screen');
  }
}, 4000);

const btnLogin = $('btn-google-login');
if (btnLogin) {
  btnLogin.onclick = async () => {
    try { await loginWithGoogle(); }
    catch(e: any) { showToast('로그인 실패: ' + e.message); }
  };
}

const handleSignOut = () => {
  clearAuthCache();
  logout();
};
const btnLogout = $('btn-logout');
if (btnLogout) btnLogout.onclick = handleSignOut;
const btnDeniedSignout = $('btn-denied-signout');
if (btnDeniedSignout) btnDeniedSignout.onclick = handleSignOut;

// ── COUNTS
function loadAllCounts() {
  if (metaUnsubscribe) metaUnsubscribe();
  metaUnsubscribe = subscribeUserMeta((categoryCount) => {
    lastCounts = categoryCount;
    try {
      localStorage.setItem('mynote_counts_cache', JSON.stringify(categoryCount));
    } catch (e) {}
    applyCounts(categoryCount);
  });
}

// ── 메모 ID로 전체 메모를 불러와 상세 화면 열기 (목록·검색·메모 링크 공통)
// 캐시된 인덱스에서 잠금 여부를 즉시 확인하는 헬퍼
function isNoteLockedInCache(noteId: string): boolean {
  const inList = listNotesCache.find(n => n.id === noteId);
  if (inList && inList.locked !== undefined) return !!inList.locked;
  const inAll = (appState.allNotesCache as NoteIndexItem[] || []).find(n => n.id === noteId);
  if (inAll && inAll.locked !== undefined) return !!inAll.locked;
  return false;
}

// ── 메모 ID로 전체 메모를 불러와 상세 화면 열기 (목록·검색·메모 링크 공통)
async function openNoteById(noteId: string, from: string) {
  let verified = false;
  if (isNoteLockedInCache(noteId)) {
    const ok = await verifyLockPinForNote();
    if (!ok) return;
    verified = true;
  }
  const reqToken = ++detailRenderToken;
  try {
    const note = await getSingleNote(noteId);
    // 네트워크 응답 대기 중 다른 메모 요청이 들어왔다면 이전 결과는 무시
    if (reqToken !== detailRenderToken) return;
    if (!note) { showToast('해당 메모를 찾을 수 없어요'); return; }
    if (note.locked && !verified) {
      const ok = await verifyLockPinForNote();
      if (!ok || reqToken !== detailRenderToken) return;
    }
    const noteCats = getNoteCategories(note);
    if (!appState.currentCat || !noteCats.includes(appState.currentCat)) {
      appState.currentCat = noteCats[0] || note.category;
    }
    const listTitle = $('list-title');
    if (listTitle) {
      listTitle.textContent = (CATEGORIES[appState.currentCat]?.icon || '') + ' ' + (CATEGORIES[appState.currentCat]?.name || '');
    }
    await openDetail(note, from, reqToken);
  } catch (e) {
    if (reqToken === detailRenderToken) {
      showToast('메모를 불러오는 중 오류가 발생했어요');
    }
  }
}

// 메모 링크 클릭 핸들러
appState.handleNoteLinkClick = function(el: HTMLElement) {
  const noteId = el.dataset.noteId;
  if (noteId) openNoteById(noteId, detailFrom || 'list');
};

// ─────────────────────────────────────────────
// HOME (폴더 목록 / 검색 토글)
// ─────────────────────────────────────────────
const foldersList = $('folders-list');
if (foldersList) {
  foldersList.addEventListener('click', e => {
    const row = (e.target as HTMLElement).closest('.folder-row') as HTMLElement;
    if (!row) return;
    const catId = row.dataset.cat;
    if (catId) openList(catId);
  });
}

const searchInput = $('search-input') as HTMLInputElement;
const searchClear = $('search-clear') as HTMLElement;
const searchResults = $('search-results') as HTMLElement;

function setHomeListVisible(visible: boolean) {
  setDisplay('folders-list', visible ? '' : 'none');
  setDisplay('folders-meta-header', visible ? '' : 'none');
}

// 검색 상태 초기화 + 폴더 목록 복원 (여러 곳에서 공통 사용)
function resetSearchUI() {
  clearTimeout(searchTimeout);
  lastSearchedQuery = '';
  isAiSearchActive = false;
  lastRenderedSearchSignature = '';
  isSelectingSearchResult = false;
  isPointerDownOnSearchResults = false;
  if (searchInput) searchInput.value = '';
  if (searchClear) searchClear.style.display = 'none';
  const ragEl = $('ai-rag-container');
  if (ragEl) {
    ragEl.style.display = 'none';
    ragEl.innerHTML = '';
  }
  if (searchResults) {
    searchResults.style.display = 'none';
    searchResults.innerHTML = '';
  }
  setHomeListVisible(true);
}

const btnToggleSearch = $('btn-toggle-search');
const searchWrap = $('search-wrap');
if (btnToggleSearch && searchWrap) {
  btnToggleSearch.onclick = () => {
    ensureSearchIndexReady(); // 검색창을 여는 즉시 캐시 인덱스 준비 (0ms 즉시 검색)
    ensureAllNotesCache();
    const isHidden = searchWrap.style.display === 'none';
    searchWrap.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      searchInput?.focus();
    } else {
      // 닫을 때 검색 초기화
      resetSearchUI();
    }
  };
}

// ─────────────────────────────────────────────
// LIST (카테고리 인덱스만 구독 — 본문 문서를 읽지 않음)
// ─────────────────────────────────────────────
appState.openList = openList;
function openList(catId: string, tag: string | null = null) {
  const cat = CATEGORIES[catId];
  if (!cat) return;
  appState.currentCat = catId;
  appState.currentTag = tag;
  const listTitle = $('list-title');
  if (listTitle) listTitle.textContent = cat.icon + ' ' + cat.name;
  
  renderListTagFilter(catId, tag);
  showAppScreen('list');
  loadList(catId);
}

function renderListTagFilter(catId: string, activeTag: string | null) {
  const filterBar = $('list-tag-filter');
  if (!filterBar) return;
  const tags = SUB_TAGS[catId];
  if (!tags || tags.length === 0) {
    filterBar.style.display = 'none';
    filterBar.innerHTML = '';
    return;
  }
  filterBar.style.display = 'flex';
  filterBar.innerHTML =
    `<div class="tag-filter-btn ${!activeTag ? 'active' : ''}" data-filter-tag="">전체</div>` +
    tags.map(t =>
      `<div class="tag-filter-btn ${t === activeTag ? 'active' : ''}" data-filter-tag="${escHtml(t)}">#${escHtml(t)}</div>`
    ).join('');
}

const listTagFilter = $('list-tag-filter');
if (listTagFilter) {
  listTagFilter.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('[data-filter-tag]') as HTMLElement | null;
    if (!btn || !appState.currentCat) return;
    openList(appState.currentCat, btn.dataset.filterTag || null);
  });
}

function stopListSubscription() {
  if (listLoadTimer) { clearTimeout(listLoadTimer); listLoadTimer = null; }
  if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
  listCatId = null;
  listNotesCache = [];
}

function loadList(catId: string, force = false) {
  // 같은 카테고리를 이미 정상 구독 중이고 강제 갱신이 아니면 캐시만 필터링 렌더링
  if (!force && listUnsubscribe && listCatId === catId) {
    renderList();
    return;
  }
  stopListSubscription();
  listCatId = catId;

  // 1단계: 로컬 캐시에서 해당 카테고리 메모가 있는지 즉시 확인하여 0ms 렌더링
  ensureSearchIndexReady();
  const cachedForCat = (appState.allNotesCache as NoteIndexItem[] || []).filter(n => getNoteCategories(n).includes(catId));
  const content = $('list-content');

  if (cachedForCat.length > 0) {
    // 캐시가 있으면 즉시 목록을 보여주어 "불러오는 중..." 지연을 완전히 제거
    listNotesCache = cachedForCat;
    renderList();
  } else if ((lastCounts[catId] || 0) === 0) {
    // 등록된 메모가 0개임이 확실한 경우 빈 화면 즉시 표시
    listNotesCache = [];
    renderList();
  } else {
    // 캐시가 전혀 없거나 아직 로드되지 않은 경우에만 로딩 표시
    if (content) {
      content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text-light);font-size:14px;padding:24px 0">
        <div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>
        <span>불러오는 중...</span>
      </div>`;
    }
  }

  // 2단계: 인증 정보가 아직 준비되지 않은 경우 대기 상태로 등록
  if (!appState.currentUser) {
    pendingListCat = catId;
    if (listLoadTimer) clearTimeout(listLoadTimer);
    listLoadTimer = setTimeout(() => {
      if (listCatId === catId && listNotesCache.length === 0 && content) {
        content.innerHTML = `
          <div style="padding:32px 16px;text-align:center">
            <div style="font-size:28px;margin-bottom:8px">⏳</div>
            <div style="font-size:14px;color:var(--text-light);margin-bottom:14px;line-height:1.5">
              로그인 상태를 확인하는 중입니다.<br>잠시만 기다리시거나 다시 시도해주세요.
            </div>
            <button id="btn-retry-list" style="padding:9px 18px;border-radius:10px;border:1.5px solid var(--sky-dark);background:white;color:var(--sky-dark);font-weight:600;font-size:13px;cursor:pointer">🔄 다시 불러오기</button>
          </div>`;
        const retryBtn = $('btn-retry-list');
        if (retryBtn) retryBtn.onclick = () => loadList(catId, true);
      }
    }, 4000);
    return;
  }

  // 3단계: 로딩 타임아웃 안전 타이머 (4.5초)
  if (listLoadTimer) clearTimeout(listLoadTimer);
  listLoadTimer = setTimeout(() => {
    if (listCatId === catId && listNotesCache.length === 0 && content && content.innerHTML.includes('불러오는 중')) {
      content.innerHTML = `
        <div style="padding:32px 16px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">📡</div>
          <div style="font-size:14px;color:var(--text-light);margin-bottom:14px;line-height:1.5">
            메모를 불러오는 데 지연되고 있어요.<br>네트워크 연결을 확인하거나 다시 시도해주세요.
          </div>
          <button id="btn-retry-list" style="padding:9px 18px;border-radius:10px;border:1.5px solid var(--sky-dark);background:white;color:var(--sky-dark);font-weight:600;font-size:13px;cursor:pointer">🔄 다시 불러오기</button>
        </div>`;
      const retryBtn = $('btn-retry-list');
      if (retryBtn) retryBtn.onclick = () => loadList(catId, true);
    }
  }, 4500);

  // 4단계: 실시간 Firestore 인덱스 구독
  listUnsubscribe = subscribeCategoryIndex(catId, (notes) => {
    if (listLoadTimer) { clearTimeout(listLoadTimer); listLoadTimer = null; }
    listNotesCache = notes;
    renderList();

    // 구버전 인덱스(목록용 필드 누락) 또는 인덱스 누락 감지 시 1회 자동 보정
    const needsRebuild =
      notes.some(n => n.createdAt === undefined || n.pinned === undefined) ||
      (notes.length === 0 && (lastCounts[catId] || 0) > 0);
    if (needsRebuild && !rebuiltCats.has(catId)) {
      rebuiltCats.add(catId);
      rebuildCategoryIndex(catId).catch(err => console.error('인덱스 보정 오류:', err));
    }
  }, (err) => {
    if (listLoadTimer) { clearTimeout(listLoadTimer); listLoadTimer = null; }
    if (content) {
      content.innerHTML = `
        <div style="padding:24px 16px;text-align:center">
          <div style="color:var(--danger);font-size:13px;margin-bottom:12px">${escHtml(err.message)}</div>
          <button id="btn-retry-list" style="padding:8px 16px;border-radius:8px;border:1px solid var(--sky-dark);background:white;color:var(--sky-dark);font-weight:600;font-size:12px;cursor:pointer">🔄 다시 시도</button>
        </div>`;
      const retryBtn = $('btn-retry-list');
      if (retryBtn) retryBtn.onclick = () => loadList(catId, true);
    }
  });
}

function resolveCategoryForTag(note: any, tag: string, fallbackCat: string): string {
  for (const cid of getNoteCategories(note)) {
    if (SUB_TAGS[cid]?.includes(tag)) return cid;
  }
  return fallbackCat;
}

function renderList() {
  if (listLoadTimer) { clearTimeout(listLoadTimer); listLoadTimer = null; }
  const content = $('list-content');
  if (!content) return;
  const notes = appState.currentTag
    ? listNotesCache.filter(n => getNoteTags(n).includes(appState.currentTag))
    : listNotesCache;

  if (notes.length === 0) {
    content.innerHTML = `<div class="empty-list">
      <div class="ei">${CATEGORIES[appState.currentCat]?.icon || '📝'}</div>
      <p>아직 메모가 없어요.<br>첫 번째 메모를 추가해보세요!</p>
    </div>`;
    return;
  }
  // 핀 고정 메모(최근 고정순) → 일반 메모(최신 작성순)
  const pinned = notes.filter(n => n.pinned).sort((a, b) => toMillis(b.pinnedAt) - toMillis(a.pinnedAt));
  const unpinned = notes.filter(n => !n.pinned).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  // 한 번의 innerHTML 대입으로 렌더링 (항목별 appendChild/리스너 등록 제거)
  content.innerHTML = [...pinned, ...unpinned].map(note => `
    <div class="note-list-item${note.pinned ? ' pinned' : ''}" data-id="${escHtml(note.id)}">
      <div class="note-list-bullet"></div>
      <div class="note-list-info">
        <div class="note-list-title">${note.locked ? '🔒 ' : ''}${escHtml(note.title || '제목 없음')}</div>
        <div class="note-list-date">${getNoteTags(note).map(t => tagChipHtml(resolveCategoryForTag(note, t, note.category), t, 'note-list-tag', 'color:var(--sky-dark);font-weight:600;margin-right:6px;cursor:pointer')).join('')}${fmtDate(note.createdAt)}</div>
      </div>
      ${note.pinned ? '<span class="pin-badge" title="핀 고정">📌</span>' : (note.locked ? '<span class="pin-badge" title="잠금">🔒</span>' : '<span class="note-list-arrow">›</span>')}
    </div>`).join('');
}

const listContent = $('list-content');
if (listContent) {
  listContent.addEventListener('click', e => {
    if (handleTagLink(e)) return;
    const item = (e.target as HTMLElement).closest('.note-list-item') as HTMLElement | null;
    if (item?.dataset.id) openNoteById(item.dataset.id, 'list');
  });
}

// 목록으로 돌아가기 (현재 메모의 카테고리 목록이 구독 중이 아니면 다시 연다)
function goBackToList() {
  if (appState.currentCat && listCatId !== appState.currentCat) {
    openList(appState.currentCat, null);
  } else {
    showAppScreen('list');
  }
}

const listBack = $('list-back');
if (listBack) {
  listBack.onclick = () => {
    stopListSubscription();
    showAppScreen('home');
  };
}

// ─────────────────────────────────────────────
// DETAIL
// ─────────────────────────────────────────────
async function openDetail(note: any, from?: string, existingToken?: number) {
  ensureAllNotesCache();
  const token = existingToken !== undefined ? existingToken : ++detailRenderToken;
  appState.currentNote = note;
  detailFrom = from || 'list';
  const detailHeaderTitle = $('detail-header-title');
  if (detailHeaderTitle) detailHeaderTitle.textContent = note.title || '제목 없음';

  const backBtn = $('detail-back');
  if (backBtn) {
    backBtn.textContent = detailFrom === 'search' ? '🏠' : '←';
    backBtn.title = detailFrom === 'search' ? '홈으로' : '목록으로';
  }

  const content = $('detail-content');
  if (!content) return;
  const imgs = note.images || [];
  // 이미지 클릭은 imageViewer 모듈의 이벤트 위임에서 처리
  const imgHtml = imgs.length > 0
    ? `<div class="detail-images">${imgs.map((i: any) => `<img class="detail-img" src="${escHtml(i.url)}" alt="이미지">`).join('')}</div>`
    : '';

  const parsedBody = await parseMarkdownBody(note.body || '');
  // 파싱 도중 다른 메모가 열렸다면 이전 결과는 버림 (경쟁 상태 방지)
  if (token !== detailRenderToken) return;

  const noteCats = getNoteCategories(note);
  const catBadgesHtml = noteCats.map(cid => {
    const c = CATEGORIES[cid];
    return c ? `<span class="detail-cat-badge">${c.icon} ${escHtml(c.name)}</span>` : '';
  }).join('');
  const tagTargetCat = appState.currentCat && noteCats.includes(appState.currentCat) ? appState.currentCat : (noteCats[0] || note.category);
  content.innerHTML = `
    <div class="detail-meta">
      ${catBadgesHtml}
      ${getNoteTags(note).map(t => tagChipHtml(resolveCategoryForTag(note, t, tagTargetCat), t, 'detail-tag-badge')).join('')}
      ${note.locked ? '<span class="detail-lock-badge">🔒 잠금</span>' : ''}
      <span class="detail-date">${fmtDate(note.createdAt)}</span>
    </div>
    <div class="detail-body" style="background: ${note.pinned ? '#F2EFE6' : 'var(--white)'}">${parsedBody}</div>
    ${imgHtml}`;
  showAppScreen('detail');
}

// 상세 본문의 태그 칩 / 메모 링크 클릭 (이벤트 위임)
const detailContentEl = $('detail-content');
if (detailContentEl) {
  detailContentEl.addEventListener('click', e => {
    if (handleTagLink(e)) return;
    const link = (e.target as HTMLElement).closest('.note-link[data-note-id]') as HTMLElement | null;
    if (link) appState.handleNoteLinkClick(link);
  });
}

const detailBack = $('detail-back');
if (detailBack) {
  detailBack.onclick = () => {
    if (detailFrom === 'search') {
      // (버그 수정) 존재하지 않는 'cat-grid' 대신 폴더 목록·메타 헤더를 올바르게 복원
      resetSearchUI();
      showAppScreen('home');
    } else {
      goBackToList();
    }
  };
}

const btnEditDetail = $('btn-edit-detail');
if (btnEditDetail) {
  btnEditDetail.onclick = () => openEditModal(appState.currentNote);
}

const btnDelDetail = $('btn-del-detail');
if (btnDelDetail) {
  btnDelDetail.onclick = () => openDelModal(appState.currentNote.id);
}

// ─────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────
if (searchInput) {
  searchInput.addEventListener('input', () => {
    const v = searchInput.value.trim();
    searchClear.style.display = v ? 'block' : 'none';
    clearTimeout(searchTimeout);
    if (!v) {
      lastSearchedQuery = '';
  isAiSearchActive = false;
      lastRenderedSearchSignature = '';
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
      setHomeListVisible(true);
      return;
    }
    // 한글 IME 조합 완료/blur 등으로 동일한 검색어의 input 이벤트가 중복 발생할 때 재렌더링 차단
    if (v === lastSearchedQuery && searchResults.style.display !== 'none') {
      return;
    }
    ensureSearchIndexReady();
    ensureAllNotesCache();
    // 지연(setTimeout) 없이 즉시 검색하여 클릭/터치 직전에 목록이 뒤늦게 바뀌는 현상 원천 차단
    doSearch(v);
  });

  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = searchInput.value.trim();
      if (v && v !== lastSearchedQuery) {
        doSearch(v);
      }
      searchInput.blur();
    }
  });
}

if (searchClear) {
  searchClear.onclick = () => resetSearchUI();
}

// ─────────────────────────────────────────────
// AI 시맨틱 검색 & 종합·추론 (RAG)
// ─────────────────────────────────────────────
const aiRagContainer = $('ai-rag-container') as HTMLElement | null;
const btnAiSearch = $('btn-ai-search') as HTMLButtonElement | null;
const btnOpenAiConfig = $('btn-open-ai-config') as HTMLButtonElement | null;
const aiConfigModal = $('ai-config-modal') as HTMLElement | null;
const aiApiKeyInput = $('ai-api-key-input') as HTMLInputElement | null;
const aiProxyUrlInput = $('ai-proxy-url-input') as HTMLInputElement | null;
const aiSyncCloudCb = $('ai-sync-cloud-cb') as HTMLInputElement | null;
const btnBackfillEmbeddings = $('btn-backfill-embeddings') as HTMLButtonElement | null;
const aiBackfillStatus = $('ai-backfill-status') as HTMLElement | null;
let aiSearchSessionToken = 0;

function openAiConfigModal() {
  if (!aiConfigModal) return;
  if (aiApiKeyInput) aiApiKeyInput.value = getGeminiApiKey();
  if (aiProxyUrlInput) aiProxyUrlInput.value = getAiProxyUrl();
  aiConfigModal.style.display = 'flex';
}

function closeAiConfigModal() {
  if (aiConfigModal) aiConfigModal.style.display = 'none';
}

if (btnOpenAiConfig) {
  btnOpenAiConfig.onclick = () => openAiConfigModal();
}

const aiConfigCancel = $('ai-config-cancel');
if (aiConfigCancel) {
  aiConfigCancel.onclick = () => closeAiConfigModal();
}

const aiConfigSave = $('ai-config-save') as HTMLButtonElement | null;
if (aiConfigSave) {
  aiConfigSave.onclick = async () => {
    const key = aiApiKeyInput ? aiApiKeyInput.value.trim() : '';
    const proxy = aiProxyUrlInput ? aiProxyUrlInput.value.trim() : '';
    const syncCloud = aiSyncCloudCb ? aiSyncCloudCb.checked : true;
    aiConfigSave.disabled = true;
    try {
      await saveAiConfig(key, proxy, syncCloud);
      showToast(key || proxy ? 'AI 설정이 저장되었어요 ✨' : 'AI 설정이 초기화되었어요');
      closeAiConfigModal();
    } catch (e: any) {
      showToast('설정 저장 실패: ' + (e?.message || '오류'));
    } finally {
      aiConfigSave.disabled = false;
    }
  };
}

if (aiConfigModal) {
  aiConfigModal.addEventListener('click', e => {
    if ((e.target as HTMLElement).id === 'ai-config-modal') closeAiConfigModal();
  });
}

if (btnBackfillEmbeddings) {
  btnBackfillEmbeddings.onclick = async () => {
    if (!hasAiCredentials()) {
      const tempKey = aiApiKeyInput?.value.trim() || '';
      const tempProxy = aiProxyUrlInput?.value.trim() || '';
      if (!tempKey && !tempProxy) {
        showToast('먼저 Gemini API 키를 입력하고 저장해주세요');
        return;
      }
      await saveAiConfig(tempKey, tempProxy, aiSyncCloudCb ? aiSyncCloudCb.checked : true);
    }
    btnBackfillEmbeddings.disabled = true;
    btnBackfillEmbeddings.textContent = '⏳ 변환 중...';
    try {
      const res = await backfillMissingEmbeddings((done, total, title) => {
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
  };
}

// RAG 답변 카드 내 [[메모 제목]] 링크 클릭 위임 처리
if (aiRagContainer) {
  aiRagContainer.addEventListener('click', (e: MouseEvent) => {
    const linkEl = (e.target as HTMLElement).closest('.note-link') as HTMLElement | null;
    if (linkEl && linkEl.dataset.noteId) {
      e.preventDefault();
      e.stopPropagation();
      detailFrom = 'search';
      openNoteById(linkEl.dataset.noteId, 'search');
    }
  });
}

async function runAiSemanticSearch(rawQuery: string) {
  const queryText = rawQuery.trim();
  if (!queryText) {
    showToast('검색어나 질문을 입력해주세요');
    searchInput?.focus();
    return;
  }
  if (!hasAiCredentials()) {
    showToast('AI 검색을 위해 먼저 Gemini API 키를 설정해주세요 ✨');
    openAiConfigModal();
    return;
  }

  const token = ++aiSearchSessionToken;
  isAiSearchActive = true;
  clearTimeout(searchTimeout);
  setHomeListVisible(false);
  ensureAllNotesCache();

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
          🧠 질문을 임베딩(<code>text-embedding-004</code>)하여 연관 메모를 탐색하고 있습니다...
        </div>
      </div>
    `;
  }

  if (searchResults) {
    searchResults.style.display = 'block';
    searchResults.innerHTML = `<div class="search-no-result" style="color:var(--text-light);font-size:13.5px;padding:20px 0">🔍 코사인 유사도 기반으로 연관 메모를 추출하는 중...</div>`;
  }

  try {
    // 1단계: 코사인 유사도 상위 5개 메모 고속 추출
    const { results, embeddedNotesCount } = await semanticSearchNotes(queryText, 5);
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

    // 상위 메모 목록 렌더링 (유사도 % 배지 표시)
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
      const snippet = (note.body || '').substring(0, 200);
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

    // 2단계: 상위 메모 본문 컨텍스트를 묶어 Gemini Flash RAG 종합·추론 호출
    if (aiRagContainer) {
      aiRagContainer.innerHTML = `
        <div class="ai-rag-card">
          <div class="ai-rag-header">
            <div class="ai-rag-title"><span>🤖</span><span>AI 종합 및 추론 답변</span></div>
            <span class="ai-rag-badge">상위 ${results.length}개 메모 참조 중...</span>
          </div>
          <div class="ai-rag-body" style="color:var(--text-light)">
            ✍️ 추출된 상위 ${results.length}개 메모의 본문을 바탕으로 요약·비교·추론 답변을 작성하고 있습니다...
          </div>
        </div>
      `;
    }

    const answerMarkdown = await generateRagAnswer(queryText, results);
    if (token !== aiSearchSessionToken) return;

    const renderedHtml = await parseMarkdownBody(answerMarkdown);
    if (token !== aiSearchSessionToken) return;

    if (aiRagContainer) {
      aiRagContainer.innerHTML = `
        <div class="ai-rag-card">
          <div class="ai-rag-header">
            <div class="ai-rag-title"><span>✨</span><span>AI 종합 및 추론 답변</span></div>
            <span class="ai-rag-badge">참조 메모 ${results.length}건 · Gemini Flash</span>
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

if (btnAiSearch) {
  btnAiSearch.onclick = () => {
    const q = searchInput ? searchInput.value.trim() : '';
    runAiSemanticSearch(q);
  };
}

function doSearch(keyword: string, fromCacheSync = false) {
  if (!fromCacheSync) {
    isAiSearchActive = false;
    if (aiRagContainer) {
      aiRagContainer.style.display = 'none';
      aiRagContainer.innerHTML = '';
    }
  }
  setHomeListVisible(false);
  searchResults.style.display = 'block';
  ensureSearchIndexReady();
  try {
    lastSearchedQuery = keyword;
    const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    const searchIdx = (appState.searchIndex as { note: NoteIndexItem; text: string }[]) || [];

    // 아직 인덱스 로딩 전이고 로컬 캐시도 없는 극초기 상태인 경우
    if (searchIdx.length === 0 && !hasNotesLoaded) {
      lastRenderedSearchSignature = '';
      searchResults.innerHTML = `<div class="search-no-result" style="color:var(--text-light);font-size:14px;padding:24px 0">🔍 메모 색인을 불러오는 중입니다...</div>`;
      ensureAllNotesCache();
      return;
    }

    // 미리 소문자화해 둔 검색 텍스트 사용 (매 검색마다 toLowerCase 반복 제거)
    const results = searchIdx
      .filter(entry => keywords.every(kw => entry.text.includes(kw)))
      .map(entry => entry.note);

    // 백그라운드 캐시 동기화로 호출되었을 때 현재 화면에 표시된 결과 목록과 동일하면 DOM 재생성 생략 (클릭 위치 어긋남 방지)
    const signature = `${keyword}::${results.map(n => `${n.id}|${n.title || ''}|${getNoteCategories(n).join(',')}|${getNoteTags(n).join(',')}|${n.locked ? 1 : 0}|${n.snippet || ''}`).join(';;')}`;
    if (fromCacheSync && signature === lastRenderedSearchSignature) {
      return;
    }
    lastRenderedSearchSignature = signature;

    if (results.length === 0) {
      searchResults.innerHTML = `<div class="search-no-result">🔍 "<b>${escHtml(keyword)}</b>" 검색 결과가 없어요</div>`;
      return;
    }
    const prevScrollY = window.scrollY;
    const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
      <span style="font-size:12px;color:var(--text-light)">${results.length}개 검색됨</span>
      <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--border-color);background:transparent;color:var(--text);cursor:pointer;font-weight:600">🏠 홈으로</button>
    </div>`;
    // 검색 결과 카드 내부의 카테고리/태그 배지는 클릭을 가로채지 않도록 순수 표시용으로 렌더링
    const items = results.map(note => {
      const noteCats = getNoteCategories(note);
  const catBadgesHtml = noteCats.map(cid => {
    const c = CATEGORIES[cid];
    return c ? `<span class="detail-cat-badge">${c.icon} ${escHtml(c.name)}</span>` : '';
  }).join('');
  const tagTargetCat = appState.currentCat && noteCats.includes(appState.currentCat) ? appState.currentCat : (noteCats[0] || note.category);
      return `<div class="search-result-item" data-id="${escHtml(note.id)}" data-cat="${escHtml(note.category)}">
        <div class="search-result-title">${note.locked ? '🔒 ' : ''}${escHtml(note.title || '제목 없음')}</div>
        ${catBadgesHtml}
        ${getNoteTags(note).map(t => `<span class="search-result-cat" style="background:var(--sky-dark);color:white;margin-left:4px">#${escHtml(t)}</span>`).join('')}
        <div class="search-result-body">${note.locked ? '🔒 잠긴 메모입니다' : escHtml(note.snippet || '')}</div>
      </div>`;
    }).join('');
    // 한 번의 innerHTML 대입 + 컨테이너 이벤트 위임
    searchResults.innerHTML = header + items;
    if (fromCacheSync && prevScrollY > 0) {
      window.scrollTo(0, prevScrollY);
    }
  } catch(e: any) {
    searchResults.innerHTML = `<div style="color:var(--danger);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

async function goToSearchDetailById(id: string, itemEl?: HTMLElement | null) {
  if (!id || isSelectingSearchResult) return;
  isSelectingSearchResult = true;
  clearTimeout(searchTimeout);

  if (itemEl) {
    searchResults?.querySelectorAll('.search-result-item.selected').forEach(el => el.classList.remove('selected'));
    itemEl.classList.add('selected');
  }

  // blur 호출 시 한글 IME 조합 완료로 인한 input 이벤트가 재검색을 유발하지 않도록 사전 차단
  if (searchInput) {
    lastSearchedQuery = searchInput.value.trim();
    searchInput.blur();
  }
  clearTimeout(searchTimeout);

  try {
    await openNoteById(id, 'search');
  } finally {
    isSelectingSearchResult = false;
  }
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
    // 뷰포트 크기 변화(가상 키보드 닫힘 등)에 영향받지 않는 물리 화면 좌표(screenX/Y)와 시작 시점의 항목 ID를 즉시 고정
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
    // 터치 직후 브라우저가 발생시키는 합성 mousedown/click 이벤트를 차단하기 위해 타임스탬프 기록
    lastTouchEndTime = Date.now();

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
    // 터치 이벤트 직후 발생하는 합성 mousedown 무시
    if (Date.now() - lastTouchEndTime < 700) return;
    if (e.button !== 0) return;
    const item = itemOf(e);
    if (!item || !item.dataset.id) {
      mouseDownId = null;
      mouseDownItem = null;
      return;
    }
    // mousedown 시점에 searchInput 포커스 해제 및 한글 IME 조합 완료로 인해
    // 브라우저가 화면 상단(searchInput 위치)으로 강제 스크롤하는 현상을 원천 방지
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
    // 터치 이벤트에서 이미 처리된 경우 합성 click 무시
    if (Date.now() - lastTouchEndTime < 700) return;

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

// ─────────────────────────────────────────────
// MODAL ACTIONS
// ─────────────────────────────────────────────
const btnAddNote = $('btn-add-note');
if (btnAddNote) btnAddNote.onclick = openAddModal;

const btnCancel = $('btn-cancel');
if (btnCancel) btnCancel.onclick = () => closeModal(false);

const btnSave = $('btn-save');
if (btnSave) btnSave.onclick = saveNote;

// ── 메모 링크 삽입 모달
const noteLinkModal = $('note-link-modal') as HTMLElement;
const noteLinkSearchInput = $('note-link-search-input') as HTMLInputElement;
const noteLinkList = $('note-link-list') as HTMLElement;
let noteLinkSearchTimer: any = null;

const noteLinkBtn = $('note-link-btn');
if (noteLinkBtn) noteLinkBtn.onclick = () => openNoteLinkModal();

const noteLinkCancel = $('note-link-cancel');
if (noteLinkCancel) noteLinkCancel.onclick = () => closeNoteLinkModal();

if (noteLinkModal) {
  noteLinkModal.addEventListener('click', e => { 
    if ((e.target as HTMLElement).id === 'note-link-modal') closeNoteLinkModal(); 
  });
}

function openNoteLinkModal() {
  ensureAllNotesCache();
  noteLinkSearchInput.value = '';
  renderNoteLinkList('');
  noteLinkModal.style.display = 'flex';
  setTimeout(() => noteLinkSearchInput.focus(), 80);
}
function closeNoteLinkModal() {
  clearTimeout(noteLinkSearchTimer);
  noteLinkModal.style.display = 'none';
}

// 제목순 정렬본은 캐시가 바뀐 뒤 처음 필요할 때 1회만 계산
function getSortedNotesByTitle(): NoteIndexItem[] {
  if (!appState.sortedNotesByTitle) {
    appState.sortedNotesByTitle = (appState.allNotesCache as NoteIndexItem[])
      .slice()
      .sort((a, b) => koCollator.compare(a.title || '', b.title || ''));
  }
  return appState.sortedNotesByTitle;
}

function renderNoteLinkList(keyword: string) {
  const kw = keyword.toLowerCase().trim();
  const filtered = getSortedNotesByTitle().filter(n =>
    n.id !== appState.editingNoteId &&
    (!kw || (n.title || '').toLowerCase().includes(kw))
  );

  if (filtered.length === 0) {
    noteLinkList.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-light);font-size:13px">`
      + (kw ? `🔍 "${escHtml(kw)}" 결과 없음` : '📝 메모가 없어요') + `</div>`;
    return;
  }
  noteLinkList.innerHTML = filtered.map(note => {
    const noteCats = getNoteCategories(note);
  const catBadgesHtml = noteCats.map(cid => {
    const c = CATEGORIES[cid];
    return c ? `<span class="detail-cat-badge">${c.icon} ${escHtml(c.name)}</span>` : '';
  }).join('');
  const tagTargetCat = appState.currentCat && noteCats.includes(appState.currentCat) ? appState.currentCat : (noteCats[0] || note.category);
    return `<div class="note-link-item" data-title="${escHtml(note.title)}">`
      + `<span class="note-link-item-cat">${CATEGORIES[noteCats[0] || note.category]?.icon || '📝'}</span>`
      + `<span class="note-link-item-title">${escHtml(note.title)}</span>`
      + getNoteTags(note).map(t => `<span class="note-link-item-tag">#${escHtml(t)}</span>`).join('')
      + `</div>`;
  }).join('');
}

if (noteLinkList) {
  noteLinkList.addEventListener('click', e => {
    const item = (e.target as HTMLElement).closest('.note-link-item') as HTMLElement | null;
    if (item && item.dataset.title !== undefined) insertNoteLink(item.dataset.title);
  });
}

function insertNoteLink(title: string) {
  const ta = $('note-body') as HTMLTextAreaElement;
  if (ta) insertAtCursor(ta, `[[${title}]]`);
  closeNoteLinkModal();
  showToast(`"${title}" 메모 링크를 삽입했어요 📝`);
}

if (noteLinkSearchInput) {
  // 키 입력마다가 아니라 입력이 잠시 멈췄을 때 렌더링 (디바운스)
  noteLinkSearchInput.addEventListener('input', () => {
    clearTimeout(noteLinkSearchTimer);
    noteLinkSearchTimer = setTimeout(() => renderNoteLinkList(noteLinkSearchInput.value), 120);
  });
}

const noteCategoryOptionsEl = $('note-category-options') as HTMLElement | null;
const catMultiselectTrigger = $('cat-multiselect-trigger') as HTMLButtonElement | null;
const catMultiselectLabel = $('cat-multiselect-label') as HTMLElement | null;
const catMultiselectArrow = $('cat-multiselect-arrow') as HTMLElement | null;
const catMultiselectPanel = $('cat-multiselect-panel') as HTMLElement | null;

function getSelectedCategoriesFromUI(): string[] {
  if (!noteCategoryOptionsEl) return appState.currentCat ? [appState.currentCat] : [Object.keys(CATEGORIES)[0]];
  const checked = Array.from(noteCategoryOptionsEl.querySelectorAll<HTMLInputElement>('input.cat-option-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v in CATEGORIES);
  return checked;
}

function setCategoryPanelOpen(open: boolean) {
  if (!catMultiselectPanel || !catMultiselectTrigger || !catMultiselectArrow) return;
  catMultiselectPanel.style.display = open ? 'block' : 'none';
  catMultiselectTrigger.classList.toggle('open', open);
  catMultiselectArrow.textContent = open ? '▲ 닫기' : '▾ 선택';
}

function updateCategoryMultiselectLabel(selectedCats: string[]) {
  const names = selectedCats
    .map(id => CATEGORIES[id] ? `${CATEGORIES[id].icon} ${CATEGORIES[id].name}` : '')
    .filter(Boolean);
  if (catMultiselectLabel) {
    catMultiselectLabel.textContent = names.length > 0
      ? (names.length > 1 ? `${names.join(' · ')} (${names.length}개)` : names[0])
      : '카테고리를 선택하세요';
  }
  if (!appState.editingNoteId && selectedCats.length > 0) {
    const modalTitle = $('modal-title');
    const titleSuffix = selectedCats.map(id => CATEGORIES[id]?.name || '').filter(Boolean).join(', ');
    if (modalTitle) modalTitle.textContent = `새 메모 — ${titleSuffix}`;
  }
}

function renderCategorySelect(selectedCatIds: string | string[]) {
  const arr = Array.isArray(selectedCatIds) ? selectedCatIds : [selectedCatIds];
  const valid = arr.filter(id => id && id in CATEGORIES);
  const selectedSet = new Set(valid.length > 0 ? valid : [Object.keys(CATEGORIES)[0]]);
  setCategoryPanelOpen(false);
  if (noteCategoryOptionsEl) {
    noteCategoryOptionsEl.innerHTML = Object.entries(CATEGORIES)
      .map(([id, info]) => {
        const isSel = selectedSet.has(id);
        return `<label class="cat-option-chip${isSel ? ' selected' : ''}" data-cat-id="${escHtml(id)}">
          <input type="checkbox" class="cat-option-cb" value="${escHtml(id)}"${isSel ? ' checked' : ''}>
          <span>${info.icon} ${escHtml(info.name)}</span>
          <span class="cat-option-check">${isSel ? '✓' : ''}</span>
        </label>`;
      })
      .join('');
  }
  updateCategoryMultiselectLabel(Array.from(selectedSet));
}

if (catMultiselectTrigger) {
  catMultiselectTrigger.onclick = () => {
    const isHidden = !catMultiselectPanel || catMultiselectPanel.style.display === 'none';
    setCategoryPanelOpen(isHidden);
  };
}

if (noteCategoryOptionsEl) {
  noteCategoryOptionsEl.addEventListener('change', (e) => {
    const cb = (e.target as HTMLElement).closest('input.cat-option-cb') as HTMLInputElement | null;
    if (!cb) return;
    let selected = getSelectedCategoriesFromUI();
    if (selected.length === 0) {
      // 최소 1개 카테고리는 유지
      cb.checked = true;
      showToast('최소 1개 이상의 카테고리를 선택해주세요');
      selected = getSelectedCategoriesFromUI();
    }
    const chip = cb.closest('.cat-option-chip');
    const checkMark = chip?.querySelector('.cat-option-check');
    if (chip) chip.classList.toggle('selected', cb.checked);
    if (checkMark) checkMark.textContent = cb.checked ? '✓' : '';

    updateCategoryMultiselectLabel(selected);
    const currentSelectedTags = getSelectedTagsFromUI();
    renderTagOptions(selected, currentSelectedTags);
  });
}

function getSelectedTagsFromUI(): string[] {
  const to = $('tag-options');
  if (!to) return [];
  return Array.from(to.querySelectorAll<HTMLInputElement>('input[name="note-tag"]:checked'))
    .map(el => el.value)
    .filter(Boolean);
}

function renderTagOptions(catIds: string | string[], selectedTagsInput: string | string[] | null) {
  const tg = $('tag-group');
  const to = $('tag-options');
  if (!tg || !to) return;
  const cats = Array.isArray(catIds) ? catIds : [catIds];
  const mergedTags = Array.from(new Set(cats.flatMap(cid => SUB_TAGS[cid] || [])));
  const selectedSet = new Set(
    Array.isArray(selectedTagsInput)
      ? selectedTagsInput.filter(Boolean)
      : (selectedTagsInput ? [selectedTagsInput] : [])
  );
  if (mergedTags.length > 0) {
    tg.style.display = 'block';
    to.innerHTML = mergedTags.map((tag) => `
      <label style="display:inline-flex">
        <input type="checkbox" name="note-tag" value="${escHtml(tag)}" class="tag-radio" ${selectedSet.has(tag) ? 'checked' : ''}>
        <span class="tag-label">${escHtml(tag)}</span>
      </label>
    `).join('');
  } else {
    tg.style.display = 'none';
    to.innerHTML = '';
  }
}

/*

function renderCategorySelect(selectedCatId: string) {
  if (!noteCategoryEl) return;
  noteCategoryEl.innerHTML = Object.entries(CATEGORIES)
    .map(([id, info]) => `<option value="${escHtml(id)}"${id === selectedCatId ? ' selected' : ''}>${info.icon} ${escHtml(info.name)}</option>`)
    .join('');
  noteCategoryEl.value = selectedCatId;
}

if (noteCategoryEl) {
  noteCategoryEl.addEventListener('change', () => {
    const newCat = noteCategoryEl.value;
    renderTagOptions(newCat, null);
    if (!appState.editingNoteId) {
      const modalTitle = $('modal-title');
      if (modalTitle) modalTitle.textContent = `새 메모 — ${CATEGORIES[newCat]?.name || ''}`;
    }
  });
}

function renderTagOptions(catId: string, selectedTag: string | null) {
  const tg = $('tag-group');
  const to = $('tag-options');
  if (!tg || !to) return;
  if (SUB_TAGS[catId]) {
    tg.style.display = 'block';
    to.innerHTML = SUB_TAGS[catId].map((tag) => `
      <label style="display:inline-flex">
        <input type="radio" name="note-tag" value="${escHtml(tag)}" class="tag-radio" ${tag === selectedTag ? 'checked data-was-checked="true"' : ''}>
        <span class="tag-label">${escHtml(tag)}</span>
      </label>
    `).join('');
  } else {
    tg.style.display = 'none';
    to.innerHTML = '';
  }
}

// (체크박스 복수 선택으로 전환되어 기존 라디오 단일 토글 리스너는 비활성화)
const tagOptionsEl = $('tag-options');
if (tagOptionsEl) {
  tagOptionsEl.addEventListener('click', (e) => {
    const radio = (e.target as HTMLElement).closest('label')?.querySelector('input.tag-radio') as HTMLInputElement | null;
    if (!radio) return;
    // label 클릭으로 인해 radio에 도달한 click 이벤트에서 토글 처리
    if ((e.target as HTMLElement) !== radio) return;
    if (radio.dataset.wasChecked === 'true') {
      radio.checked = false;
      radio.dataset.wasChecked = 'false';
    } else {
      tagOptionsEl.querySelectorAll<HTMLInputElement>('input.tag-radio').forEach(r => {
        r.dataset.wasChecked = r === radio ? 'true' : 'false';
      });
    }
  });
}

*/
function setLockToggleUI(isLocked: boolean) {
  const cb = $('note-locked') as HTMLInputElement;
  const wrap = $('lock-toggle-wrap');
  const icon = $('lock-toggle-icon');
  const status = $('lock-toggle-status');
  if (cb) cb.checked = isLocked;
  if (icon) icon.textContent = isLocked ? '🔒' : '🔓';
  if (wrap && status) {
    wrap.classList.toggle('active', isLocked);
    status.textContent = isLocked ? '🔒 잠금됨' : '해제';
  }
}

function setPinToggleUI(isPinned: boolean) {
  const cb = $('note-pinned') as HTMLInputElement;
  const wrap = $('pin-toggle-wrap');
  const status = $('pin-toggle-status');
  if (cb) cb.checked = isPinned;
  if (wrap && status) {
    wrap.classList.toggle('active', isPinned);
    status.textContent = isPinned ? '📌 고정됨' : '해제';
  }
}

function fillNoteForm(title: string, body: string, keywords: string, modalTitleText: string) {
  const titleEl = $('note-title') as HTMLInputElement;
  const bodyEl = $('note-body') as HTMLTextAreaElement;
  const keywordsEl = $('note-keywords') as HTMLInputElement;
  const modalTitle = $('modal-title');
  if (titleEl) titleEl.value = title;
  if (bodyEl) bodyEl.value = body;
  if (keywordsEl) keywordsEl.value = keywords;
  if (modalTitle) modalTitle.textContent = modalTitleText;
}

// 모달 세션 토큰 (모달을 닫거나 새로 열 때 이전 업로드 작업 무효화용)
let modalSessionToken = 0;

const inlineImgBtn = $('inline-img-btn') as HTMLButtonElement;
const inlineImgInput = $('inline-img-input') as HTMLInputElement;

function resetInlineImgBtn() {
  if (!inlineImgBtn) return;
  inlineImgBtn.textContent = '🖼️ 이미지 삽입';
  inlineImgBtn.classList.remove('uploading');
  inlineImgBtn.disabled = false;
}

function setInlineImgBtnUploading() {
  if (!inlineImgBtn) return;
  inlineImgBtn.textContent = '⏳ 업로드 중...';
  inlineImgBtn.classList.add('uploading');
  inlineImgBtn.disabled = true;
}

function openAddModal() {
  modalSessionToken++;
  appState.editingNoteId = null; 
  appState.pendingImages = []; 
  appState.existingImages = [];
  sessionUploadedInlineImages = [];
  resetInlineImgBtn();
  const catId = appState.currentCat || Object.keys(CATEGORIES)[0];
  fillNoteForm('', '', '', `새 메모 — ${CATEGORIES[catId]?.name || ''}`);
  renderCategorySelect(catId);
  renderTagOptions(catId, appState.currentTag || null);
  setPinToggleUI(false);
  setLockToggleUI(false);
  setDisplay('note-modal', 'flex');
}

function openEditModal(note: any) {
  modalSessionToken++;
  appState.editingNoteId = note.id; 
  appState.pendingImages = [];
  appState.existingImages = (note.images || []).map((i: any) => ({...i}));
  sessionUploadedInlineImages = [];
  resetInlineImgBtn();
  fillNoteForm(note.title || '', note.body || '', note.keywords || '', '메모 수정');
  const editCats = getNoteCategories(note);
  renderCategorySelect(editCats);
  renderTagOptions(editCats, getNoteTags(note));

  setPinToggleUI(!!note.pinned);
  setLockToggleUI(!!note.locked);
  setDisplay('note-modal', 'flex');
}

function closeModal(saved = false) {
  modalSessionToken++;
  setDisplay('note-modal', 'none');
  stopRecording();
  resetInlineImgBtn();
  // 저장하지 않고 닫은(취소) 경우 이번 세션에서 업로드한 인라인 이미지를 Storage에서 삭제
  if (!saved && sessionUploadedInlineImages.length > 0) {
    const pathsToDelete = sessionUploadedInlineImages.map(i => i.path || i.url);
    sessionUploadedInlineImages = [];
    deleteImagesFromStorage(pathsToDelete).catch(console.error);
  }
}

// ─────────────────────────────────────────────
// IMAGE UPLOADS (본문 인라인 이미지)
// ─────────────────────────────────────────────
const noteBodyEl = $('note-body') as HTMLTextAreaElement;

// 이미지 압축(Blob) → Storage 업로드 → 본문 커서 위치에 마크다운 삽입
async function uploadAndInsertImage(file: File, prefix: string, token: number): Promise<boolean> {
  const blob = await compressImage(file, 2560, 2560, 0.88);
  const { url, path } = await uploadImageToStorage(blob, imageFileName(prefix, blob));
  // 업로드 도중 모달이 닫혔거나 다른 메모 모달이 열렸다면 방금 올린 파일을 정리하고 중단
  if (token !== modalSessionToken) {
    deleteImagesFromStorage([path || url]).catch(console.error);
    return false;
  }
  sessionUploadedInlineImages.push({ url, path });
  if (noteBodyEl) insertAtCursor(noteBodyEl, `\n![이미지](${url})\n`);
  return true;
}

if (inlineImgBtn) {
  inlineImgBtn.onclick = () => inlineImgInput?.click();
}

if (inlineImgInput) {
  inlineImgInput.onchange = async e => {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const token = modalSessionToken;

    setInlineImgBtnUploading();
    try {
      const inserted = await uploadAndInsertImage(file, 'inline', token);
      if (inserted) showToast('이미지가 본문에 삽입되었어요 🖼️');
    } catch(e: any) {
      if (token === modalSessionToken) {
        showToast('업로드 실패: ' + (e?.message || '알 수 없는 오류'));
      }
    } finally {
      // 파일 읽기 완료 후 input 초기화 (먼저 비우면 모바일 웹뷰에서 파일 핸들이 무효화될 수 있음)
      inlineImgInput.value = '';
      if (token === modalSessionToken) {
        resetInlineImgBtn();
      }
    }
  };
}

// 클립보드 이미지 직접 붙여넣기 (Ctrl+V) 지원
if (noteBodyEl) {
  noteBodyEl.addEventListener('paste', async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') === -1) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const token = modalSessionToken;
      setInlineImgBtnUploading();
      showToast('붙여넣은 이미지 업로드 중... ⏳');
      try {
        const inserted = await uploadAndInsertImage(file, 'pasted', token);
        if (inserted) showToast('이미지가 본문에 붙여넣어졌어요 🖼️');
      } catch(err: any) {
        if (token === modalSessionToken) {
          showToast('이미지 붙여넣기 실패: ' + (err?.message || '알 수 없는 오류'));
        }
      } finally {
        if (token === modalSessionToken) {
          resetInlineImgBtn();
        }
      }
      break;
    }
  });
}

// ─────────────────────────────────────────────
// SAVE NOTE
// ─────────────────────────────────────────────
let isSaving = false;
async function saveNote() {
  if (isSaving) return;
  const titleEl = $('note-title') as HTMLInputElement;
  const bodyEl = $('note-body') as HTMLTextAreaElement;
  const tagRadio = document.querySelector('input[name="note-tag"]:checked') as HTMLInputElement;
  const pinnedEl = $('note-pinned') as HTMLInputElement;
  const lockedEl = $('note-locked') as HTMLInputElement;
  const keywordsEl = $('note-keywords') as HTMLInputElement;
  
  const title = titleEl ? titleEl.value.trim() : '';
  const body = bodyEl ? bodyEl.value.trim() : '';
  const categories = getSelectedCategoriesFromUI();
  const category = categories[0] || appState.currentCat || Object.keys(CATEGORIES)[0];
  const tags = getSelectedTagsFromUI();
  const tag = tags[0] || null;
  const pinned = pinnedEl ? pinnedEl.checked : false;
  const locked = lockedEl ? lockedEl.checked : false;
  const keywords = keywordsEl ? keywordsEl.value.trim() : '';
  
  if (!title) { showToast('제목을 입력해주세요'); return; }
  isSaving = true;
  const btn = $('btn-save') as HTMLButtonElement;
  if (btn) {
    btn.textContent = '저장 중...'; 
    btn.disabled = true;
  }
  try {
    // 첨부 이미지 병렬 업로드 (실패한 것만 건너뜀)
    const uploadResults = await Promise.allSettled(
      (appState.pendingImages || []).map((img: any) =>
        uploadImageToStorage(img.blob || img.dataUrl, img.name))
    );
    const uploadedImgs = uploadResults
      .filter((r): r is PromiseFulfilledResult<{ url: string; path: string }> => r.status === 'fulfilled')
      .map(r => ({ url: r.value.url, path: r.value.path }));
    if (uploadedImgs.length < uploadResults.length) {
      uploadResults.forEach(r => { if (r.status === 'rejected') console.error('이미지 업로드 오류:', r.reason); });
      showToast('일부 이미지 업로드 실패 — 나머지만 저장돼요');
    }
    const allImages = [...appState.existingImages, ...uploadedImgs];

    const isEdit = !!appState.editingNoteId;
    const prevPinned = isEdit ? !!appState.currentNote?.pinned : false;
    // pinnedAt: 이미 고정돼 있던 메모면 기존 시각 유지, 새로 고정하면 현재 시각
    const pinnedAt = pinned
      ? (prevPinned && appState.currentNote?.pinnedAt ? appState.currentNote.pinnedAt : Timestamp.now())
      : null;
    
    // 이번 세션에서 업로드했지만 저장 시점의 본문에는 남아있지 않은 인라인 이미지 추출
    const unusedSessionInlinePaths = sessionUploadedInlineImages
      .filter(img => !body.includes(img.url))
      .map(img => img.path || img.url);

    // 요구사항 1: 메모 본문/제목/태그를 Google Gemini text-embedding-004로 임베딩 변환
    const embedding = await tryGenerateNoteEmbedding({
      title,
      body,
      category,
      categories,
      tag: tag || '',
      tags,
      keywords
    });
    const embeddingFields = embedding
      ? { embedding, embeddingUpdatedAt: Timestamp.now() }
      : {};

    if (isEdit) {
      const oldNote = { ...appState.currentNote };
      const updateData = { category, categories, title, body, tag, tags, images: allImages, pinned, pinnedAt, locked, keywords, ...embeddingFields };
      // 메모 문서 + 인덱스를 단일 트랜잭션으로 저장 (카테고리 변경 시 양쪽 인덱스·카운트 원자적 갱신)
      await updateNoteWithIndex(appState.editingNoteId, updateData, oldNote);

      // 기존 메모(첨부 + 본문 인라인)에 있었지만 수정 후 사라진 이미지 + 미사용 세션 이미지를 병렬 삭제
      const oldPaths = collectImagePaths(oldNote);
      const newPathsSet = new Set(collectImagePaths({ images: allImages, body }));
      const removed = [
        ...oldPaths.filter(p => !newPathsSet.has(p)),
        ...unusedSessionInlinePaths
      ];
      if (removed.length) deleteImagesFromStorage(removed).catch(console.error);

      if (!appState.currentCat || !categories.includes(appState.currentCat)) {
        appState.currentCat = category;
        appState.currentTag = null;
        const listTitle = $('list-title');
        if (listTitle) {
          listTitle.textContent = (CATEGORIES[category]?.icon || '') + ' ' + (CATEGORIES[category]?.name || '');
        }
      }

      showToast(pinned ? '메모가 수정되었어요 📌' : '메모가 수정되었어요 ✅');
      appState.currentNote = { ...appState.currentNote, ...updateData };
      upsertVectorNoteCache(appState.currentNote);
      openDetail(appState.currentNote, detailFrom);
    } else {
      // 신규 메모 생성 및 임베딩 저장
      const newNotePayload = { category, categories, tag, tags, title, body, images: allImages, pinned, pinnedAt, locked, keywords, ...embeddingFields };
      const newNoteId = await createNoteWithIndex(newNotePayload);
      upsertVectorNoteCache({ id: newNoteId, uid: appState.currentUser?.uid || '', ...newNotePayload } as any);
      /*
        category, categories,
        tag, tags, title, body, images: allImages,
        pinned, pinnedAt, locked, keywords
      });
      */
      if (unusedSessionInlinePaths.length) {
        deleteImagesFromStorage(unusedSessionInlinePaths).catch(console.error);
      }
      if (!appState.currentCat || !categories.includes(appState.currentCat)) {
        openList(category, tag);
      }
      showToast(pinned ? '메모가 저장되었어요 📌' : '메모가 저장되었어요 ✅');
    }
    sessionUploadedInlineImages = [];
    closeModal(true);
  } catch(e: any) { 
    showToast('저장 실패: ' + e.message); 
  } finally { 
    isSaving = false;
    if (btn) {
      btn.textContent = '💾 저장'; 
      btn.disabled = false; 
    }
  }
}

// ─────────────────────────────────────────────
// DELETE NOTE
// ─────────────────────────────────────────────
function openDelModal(id: string) {
  appState.deleteTargetId = id;
  setDisplay('del-modal', 'flex');
}

const delCancel = $('del-cancel');
if (delCancel) delCancel.onclick = () => setDisplay('del-modal', 'none');

const delConfirm = $('del-confirm') as HTMLButtonElement;
if (delConfirm) {
  delConfirm.onclick = async () => {
    const id = appState.deleteTargetId;
    if (!id || delConfirm.disabled) return;
    delConfirm.disabled = true;
    try {
      // 상세 화면에 이미 전체 메모가 있으므로 재조회하지 않음 (없을 때만 조회)
      const target = appState.currentNote?.id === id ? appState.currentNote : await getSingleNote(id);
      if (!target) {
        showToast('이미 삭제된 메모예요');
      } else {
        // 메모 문서 + 인덱스 + 카운트를 단일 트랜잭션으로 삭제
        await deleteNoteWithIndex(id, target);
        removeVectorNoteCache(id);
        // 메모 삭제가 확정된 뒤 Storage 이미지를 병렬로 정리 (UI는 기다리지 않음)
        const paths = collectImagePaths(target);
        if (paths.length) deleteImagesFromStorage(paths).catch(console.error);
        showToast('메모가 삭제되었어요 🗑️');
      }
      setDisplay('del-modal', 'none');
      appState.deleteTargetId = null;
      goBackToList();
    } catch(e: any) {
      showToast('삭제 실패: ' + e.message);
    } finally {
      delConfirm.disabled = false;
    }
  };
}

// ─────────────────────────────────────────────
// SHARE ACTIONS
// ─────────────────────────────────────────────
const btnShareDetail = $('btn-share-detail');
if (btnShareDetail) {
  btnShareDetail.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    if (navigator.share) {
      navigator.share({ title, text: body }).catch(err => {
        if (err.name !== 'AbortError') setDisplay('share-modal', 'flex');
      });
    } else {
      setDisplay('share-modal', 'flex');
    }
  };
}

const shareCancel = $('share-cancel');
if (shareCancel) shareCancel.onclick = () => setDisplay('share-modal', 'none');

// 공유 버튼 공통 바인딩: 모달을 닫고 해당 공유 함수 실행
function bindShare(id: string, fn: (title: string, body: string) => void) {
  const el = $(id);
  if (!el) return;
  el.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    setDisplay('share-modal', 'none');
    fn(title, body);
  };
}
bindShare('share-gmail', (t, b) => shareViaEmail(t, b));
bindShare('share-kakao', (t, b) => shareViaKakao(t, b, showToast));
bindShare('share-telegram', (t, b) => shareViaTelegram(t, b));
bindShare('share-native', (t, b) => shareViaNative(t, b, showToast));

// ─────────────────────────────────────────────
// VOICE SPEECH INPUT
// ─────────────────────────────────────────────
const voiceBtn = $('voice-btn');
if (voiceBtn) {
  voiceBtn.onclick = () => {
    if (isRecording) { stopRecording(); return; }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast('이 브라우저는 음성 입력을 지원하지 않아요'); return; }
    const bodyTa = $('note-body') as HTMLTextAreaElement;
    // (버그 수정) 녹음 시작 시점의 본문을 기준으로, 확정 텍스트 + 현재 중간 텍스트만 덧붙인다.
    // 이전에는 중간(interim) 결과가 올 때마다 누적되어 같은 말이 반복 입력되었음.
    const baseText = bodyTa ? bodyTa.value : '';
    let finalText = '';

    recognition = new SR();
    recognition.lang = 'ko-KR'; 
    recognition.continuous = true; 
    recognition.interimResults = true;
    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (bodyTa) bodyTa.value = baseText + finalText + interim;
    };
    recognition.onerror = () => { stopRecording(); showToast('음성 인식 오류'); };
    recognition.onend = () => { if (isRecording) stopRecording(); };
    recognition.start();
    isRecording = true;
    voiceBtn.textContent = '🔴 녹음 중... (클릭하여 종료)';
    voiceBtn.classList.add('recording');
  };
}

function stopRecording() {
  if (recognition) { try { recognition.stop(); } catch(e){} recognition = null; }
  isRecording = false;
  const vb = $('voice-btn');
  if (vb) {
    vb.textContent = '🎤 음성 입력';
    vb.classList.remove('recording');
  }
}

// Lock 토글 UI 바인딩 (암호가 아직 미설정된 경우 설정 모달 먼저 호출)
const noteLockedCb = $('note-locked') as HTMLInputElement | null;
if (noteLockedCb) {
  noteLockedCb.addEventListener('change', async () => {
    if (noteLockedCb.checked && !getStoredLockPin()) {
      const ok = await openPinModal('setup', true);
      if (!ok) {
        setLockToggleUI(false);
        return;
      }
    }
    setLockToggleUI(noteLockedCb.checked);
  });
}

// Pin 토글 UI 바인딩 (<label for="note-pinned">의 기본 동작과 중복 반전되지 않도록 change 이벤트 사용)
const notePinnedCb = $('note-pinned') as HTMLInputElement | null;
if (notePinnedCb) {
  notePinnedCb.addEventListener('change', () => {
    setPinToggleUI(notePinnedCb.checked);
  });
}

// 모달 바깥 배경 클릭 시 닫기
const noteModal = $('note-modal');
if (noteModal) {
  noteModal.addEventListener('click', e => { 
    if ((e.target as HTMLElement).id === 'note-modal') closeModal(); 
  });
}
['del-modal', 'share-modal'].forEach(id => {
  const modal = $(id);
  if (modal) {
    modal.addEventListener('click', e => {
      if ((e.target as HTMLElement).id === id) modal.style.display = 'none';
    });
  }
});

// ── 이미지 뷰어 / 컨텍스트 메뉴 초기화 (src/ui/imageViewer.ts)
initImageViewer();
initPinModal();

// ─────────────────────────────────────────────
// PWA HISTORY & BACK BUTTON
// ─────────────────────────────────────────────
initPwaNavigation((screen) => {
  if (screen === 'ai-config-modal') {
    closeAiConfigModal();
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'pin-modal') {
    closePinModalByBack();
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'img-viewer') {
    appState.closeImageViewer?.();
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'note-link-modal') {
    closeNoteLinkModal();
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'modal') { 
    closeModal(); 
    history.pushState(null, '', location.href); 
    return; 
  }
  if (screen === 'del-modal' || screen === 'share-modal') { 
    setDisplay(screen, 'none');
    history.pushState(null, '', location.href); 
    return; 
  }
  if (screen === 'detail') {
    if (detailFrom === 'search') {
      resetSearchUI();
      showAppScreen('home');
    } else {
      goBackToList();
    }
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'list') {
    stopListSubscription();
    resetSearchUI();
    showAppScreen('home');
    history.pushState(null, '', location.href);
    return;
  }
});

// ─────────────────────────────────────────────
// 모바일 백그라운드 복귀 & 네트워크 재연결 리스너
// ─────────────────────────────────────────────
const handleForegroundResume = () => {
  if (document.visibilityState === 'visible' && appState.currentUser) {
    if (currentScreen() === 'list' && appState.currentCat) {
      if (listNotesCache.length === 0 || !listUnsubscribe) {
        loadList(appState.currentCat, true);
      }
    }
  }
};
document.addEventListener('visibilitychange', handleForegroundResume);
window.addEventListener('pageshow', handleForegroundResume);
window.addEventListener('online', () => {
  if (appState.currentUser && currentScreen() === 'list' && appState.currentCat) {
    loadList(appState.currentCat, true);
  }
});
