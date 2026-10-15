import { Timestamp } from 'firebase/firestore';
import { appState } from './state';
import { 
  initAuthListener, 
  loginWithGoogle, 
  logout 
} from './services/auth';
import { 
  CATEGORIES, 
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
  showAppScreen, 
  showRootScreen, 
  initPwaNavigation 
} from './pwa';
import { NoteIndexItem } from './types';

let recognition: any = null;
let isRecording = false;
let metaUnsubscribe: (() => void) | null = null;
let listUnsubscribe: (() => void) | null = null;
let notesUnsubscribe: (() => void) | null = null;
let searchTimeout: any = null;
let detailFrom = 'list'; // 'list' or 'search'
let detailRenderToken = 0;

// 목록 화면 캐시 (같은 카테고리에서 태그만 바꿀 때 재구독하지 않기 위함)
let listCatId: string | null = null;
let listNotesCache: NoteIndexItem[] = [];
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
  try {
    localStorage.removeItem('mynote_user_cache');
    localStorage.removeItem('mynote_counts_cache');
    localStorage.removeItem('mynote_search_cache');
  } catch (e) {}
  document.documentElement.classList.remove('has-cached-auth');
}

function toMillis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
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

// ── 로컬 스토리지 조기 캐시 복원 (낙관적 UI 및 즉시 검색 지원)
function applyEarlyCache() {
  try {
    const rawUser = localStorage.getItem('mynote_user_cache');
    if (rawUser) {
      renderUserBar(JSON.parse(rawUser));
      showRootScreen('app');
    }
    const rawCounts = localStorage.getItem('mynote_counts_cache');
    if (rawCounts) {
      lastCounts = JSON.parse(rawCounts);
      applyCounts(lastCounts);
    }
    // 앱 시작 즉시 이전 검색 인덱스 복원 -> 첫 화면에서 0.01초 만에 바로 검색 가능
    const rawSearch = localStorage.getItem('mynote_search_cache');
    if (rawSearch) {
      const cachedNotes = JSON.parse(rawSearch);
      if (Array.isArray(cachedNotes) && cachedNotes.length > 0) {
        updateNotesCache(cachedNotes, false);
        const totalCnt = $('cnt-total-notes');
        if (totalCnt) totalCnt.textContent = String(cachedNotes.length);
      }
    }
  } catch (e) {
    console.warn('초기 캐시 복원 실패:', e);
  }
}

// 스크립트 실행 즉시 캐시 적용
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
  appState.allNotesCache = notes;
  appState.searchIndex = notes.map(n => ({
    note: n,
    text: `${n.title || ''}\n${n.snippet || ''}\n${n.keywords || ''}`.toLowerCase()
  }));
  const map = new Map<string, NoteIndexItem>();
  for (const n of notes) {
    if (n.title && !map.has(n.title)) map.set(n.title, n);
  }
  appState.notesByTitle = map;
  appState.sortedNotesByTitle = null; // 메모 링크 모달을 열 때 지연 계산

  if (persist) {
    try {
      localStorage.setItem('mynote_search_cache', JSON.stringify(notes));
    } catch (e) {
      console.warn('검색 캐시 로컬 저장 실패:', e);
    }
  }

  // 사용자가 이미 검색어를 입력해 둔 상태라면 최신 인덱스로 자동 재검색
  if (searchInput && searchInput.value.trim() && searchWrap && searchWrap.style.display !== 'none') {
    doSearch(searchInput.value.trim());
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

    // 사용자가 이미 검색창을 열었거나 인덱스 요청이 대기 중이면 즉시 구독,
    // 그렇지 않더라도 초기 렌더링을 방해하지 않는 짧은 지연(300ms) 후 최신 인덱스 동기화 시작
    if (pendingAllNotesSubscription || (searchWrap && searchWrap.style.display !== 'none')) {
      ensureAllNotesCache();
    } else {
      setTimeout(ensureAllNotesCache, 300);
    }
  },
  (email) => {
    clearAuthCache();
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

// 로딩 타임아웃 (캐시가 없을 때만 5초 후 로그인 화면 유도)
setTimeout(() => {
  const ls = $('loading-screen');
  if (ls && ls.style.display !== 'none' && !localStorage.getItem('mynote_user_cache')) {
    showRootScreen('auth-screen');
  }
}, 5000);

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
async function openNoteById(noteId: string, from: string) {
  try {
    const note = await getSingleNote(noteId);
    if (!note) { showToast('해당 메모를 찾을 수 없어요'); return; }
    appState.currentCat = note.category;
    const listTitle = $('list-title');
    if (listTitle) {
      listTitle.textContent = (CATEGORIES[note.category]?.icon || '') + ' ' + (CATEGORIES[note.category]?.name || '');
    }
    openDetail(note, from);
  } catch (e) {
    showToast('메모를 불러오는 중 오류가 발생했어요');
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
  if (searchInput) searchInput.value = '';
  if (searchClear) searchClear.style.display = 'none';
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

const btnMoreOptions = $('btn-more-options');
if (btnMoreOptions) {
  btnMoreOptions.onclick = () => showToast('Folders 설정 메뉴 (준비 중입니다) ⚙️');
}

const btnAddFolder = $('btn-add-folder');
if (btnAddFolder) {
  btnAddFolder.onclick = () => showToast('새 폴더 추가 기능 (준비 중입니다) 📂');
}

const btnAddNoteHome = $('btn-add-note-home');
if (btnAddNoteHome) {
  btnAddNoteHome.onclick = () => {
    // 현재 선택된 카테고리가 없으므로 기본 'memory'를 타겟으로 모달 띄우기
    appState.currentCat = 'memory';
    appState.currentTag = null;
    openAddModal();
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
  if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
  listCatId = null;
  listNotesCache = [];
}

function loadList(catId: string) {
  // 같은 카테고리를 이미 구독 중이면 재구독 없이 캐시만 다시 필터링
  if (listUnsubscribe && listCatId === catId) {
    renderList();
    return;
  }
  stopListSubscription();
  listCatId = catId;
  const content = $('list-content');
  if (content) {
    content.innerHTML = `<div style="color:var(--text-light);font-size:14px;padding:8px">불러오는 중...</div>`;
  }
  listUnsubscribe = subscribeCategoryIndex(catId, (notes) => {
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
    if (content) content.innerHTML = `<div style="color:var(--danger);font-size:13px">${escHtml(err.message)}</div>`;
  });
}

function renderList() {
  const content = $('list-content');
  if (!content) return;
  const notes = appState.currentTag
    ? listNotesCache.filter(n => n.tag === appState.currentTag)
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
        <div class="note-list-title">${escHtml(note.title || '제목 없음')}</div>
        <div class="note-list-date">${note.tag ? tagChipHtml(note.category, note.tag, 'note-list-tag', 'color:var(--sky-dark);font-weight:600;margin-right:6px;cursor:pointer') : ''}${fmtDate(note.createdAt)}</div>
      </div>
      ${note.pinned ? '<span class="pin-badge" title="핀 고정">📌</span>' : '<span class="note-list-arrow">›</span>'}
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
async function openDetail(note: any, from?: string) {
  ensureAllNotesCache();
  const token = ++detailRenderToken;
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

  const cat = CATEGORIES[note.category];
  content.innerHTML = `
    <div class="detail-meta">
      <span class="detail-cat-badge">${cat?.icon || ''} ${cat?.name || ''}</span>
      ${note.tag ? tagChipHtml(note.category, note.tag, 'detail-tag-badge') : ''}
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
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
      setHomeListVisible(true);
      return;
    }
    ensureAllNotesCache();
    searchTimeout = setTimeout(() => doSearch(v), 250);
  });
}

if (searchClear) {
  searchClear.onclick = () => resetSearchUI();
}

function doSearch(keyword: string) {
  setHomeListVisible(false);
  searchResults.style.display = 'block';
  try {
    const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    const searchIdx = (appState.searchIndex as { note: NoteIndexItem; text: string }[]) || [];

    // 아직 인덱스 로딩 전이고 로컬 캐시도 없는 극초기 상태인 경우
    if (searchIdx.length === 0 && !hasNotesLoaded) {
      searchResults.innerHTML = `<div class="search-no-result" style="color:var(--text-light);font-size:14px;padding:24px 0">🔍 메모 색인을 불러오는 중입니다...</div>`;
      ensureAllNotesCache();
      return;
    }

    // 미리 소문자화해 둔 검색 텍스트 사용 (매 검색마다 toLowerCase 반복 제거)
    const results = searchIdx
      .filter(entry => keywords.every(kw => entry.text.includes(kw)))
      .map(entry => entry.note);

    if (results.length === 0) {
      searchResults.innerHTML = `<div class="search-no-result">🔍 "<b>${escHtml(keyword)}</b>" 검색 결과가 없어요</div>`;
      return;
    }
    const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
      <span style="font-size:12px;color:var(--text-light)">${results.length}개 검색됨</span>
      <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--border-color);background:transparent;color:var(--text);cursor:pointer;font-weight:600">🏠 홈으로</button>
    </div>`;
    const items = results.map(note => {
      const cat = CATEGORIES[note.category];
      return `<div class="search-result-item" data-id="${escHtml(note.id)}" data-cat="${escHtml(note.category)}">
        <div class="search-result-title">${escHtml(note.title || '제목 없음')}</div>
        <span class="search-result-cat">${cat?.icon || ''} ${cat?.name || ''}</span>
        ${note.tag ? tagChipHtml(note.category, note.tag, 'search-result-cat', 'background:var(--sky-dark);color:white;margin-left:4px;cursor:pointer') : ''}
        <div class="search-result-body">${escHtml(note.snippet || '')}</div>
      </div>`;
    }).join('');
    // 한 번의 innerHTML 대입 + 컨테이너 이벤트 위임 (항목당 리스너 4개 → 0개)
    searchResults.innerHTML = header + items;
  } catch(e: any) {
    searchResults.innerHTML = `<div style="color:var(--danger);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

function goToSearchDetail(item: HTMLElement) {
  const id = item.dataset.id;
  if (!id) return;
  clearTimeout(searchTimeout);
  searchInput?.blur();
  openNoteById(id, 'search');
}

if (searchResults) {
  let startX = 0, startY = 0;
  let isMoving = false;

  const itemOf = (e: Event) => (e.target as HTMLElement).closest('.search-result-item') as HTMLElement | null;
  const onCatChip = (e: Event) => !!(e.target as HTMLElement).closest('.search-result-cat');

  searchResults.addEventListener('touchstart', (e: TouchEvent) => {
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    isMoving = false;
  }, { passive: true });

  searchResults.addEventListener('touchmove', (e: TouchEvent) => {
    if (isMoving) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) {
      isMoving = true;
    }
  }, { passive: true });

  searchResults.addEventListener('touchend', (e: TouchEvent) => {
    const item = itemOf(e);
    if (!item || onCatChip(e) || isMoving) return;
    e.preventDefault();
    goToSearchDetail(item);
  }, { passive: false });

  searchResults.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const item = itemOf(e);
    if (!item || onCatChip(e)) return;
    goToSearchDetail(item);
  });

  searchResults.addEventListener('click', e => {
    if (handleTagLink(e)) return;
    if ((e.target as HTMLElement).closest('#search-home-btn')) {
      resetSearchUI();
      showAppScreen('home');
    }
  });
}

// ─────────────────────────────────────────────
// MODAL ACTIONS
// ─────────────────────────────────────────────
const btnAddNote = $('btn-add-note');
if (btnAddNote) btnAddNote.onclick = openAddModal;

const btnCancel = $('btn-cancel');
if (btnCancel) btnCancel.onclick = closeModal;

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
    const cat = CATEGORIES[note.category];
    return `<div class="note-link-item" data-title="${escHtml(note.title)}">`
      + `<span class="note-link-item-cat">${cat ? cat.icon : '📝'}</span>`
      + `<span class="note-link-item-title">${escHtml(note.title)}</span>`
      + (note.tag ? `<span class="note-link-item-tag">#${escHtml(note.tag)}</span>` : '')
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

function renderTagOptions(catId: string, selectedTag: string | null) {
  const tg = $('tag-group');
  const to = $('tag-options');
  if (!tg || !to) return;
  if (SUB_TAGS[catId]) {
    tg.style.display = 'block';
    to.innerHTML = SUB_TAGS[catId].map((tag) => `
      <label style="display:inline-flex">
        <input type="radio" name="note-tag" value="${escHtml(tag)}" class="tag-radio" ${tag === selectedTag ? 'checked' : ''}>
        <span class="tag-label">${escHtml(tag)}</span>
      </label>
    `).join('');
  } else {
    tg.style.display = 'none';
    to.innerHTML = '';
  }
}

function setPinToggleUI(isPinned: boolean) {
  const cb = $('note-pinned') as HTMLInputElement;
  const wrap = $('pin-toggle-wrap');
  const status = $('pin-toggle-status');
  if (cb) cb.checked = isPinned;
  if (wrap && status) {
    wrap.classList.toggle('active', isPinned);
    status.textContent = isPinned ? '📌 고정됨' : '고정 안 됨';
  }
}

function fillNoteForm(title: string, body: string, keywords: string, modalTitleText: string) {
  const titleEl = $('note-title') as HTMLInputElement;
  const bodyEl = $('note-body') as HTMLTextAreaElement;
  const keywordsEl = $('note-keywords') as HTMLInputElement;
  const modalTitle = $('modal-title');
  const previewList = $('img-preview-list');
  if (titleEl) titleEl.value = title;
  if (bodyEl) bodyEl.value = body;
  if (keywordsEl) keywordsEl.value = keywords;
  if (modalTitle) modalTitle.textContent = modalTitleText;
  if (previewList) previewList.innerHTML = '';
}

function openAddModal() {
  appState.editingNoteId = null; 
  appState.pendingImages = []; 
  appState.existingImages = [];
  fillNoteForm('', '', '', `새 메모 — ${CATEGORIES[appState.currentCat]?.name || ''}`);
  renderTagOptions(appState.currentCat, appState.currentTag || null);
  setPinToggleUI(false);
  setDisplay('note-modal', 'flex');
}

function openEditModal(note: any) {
  appState.editingNoteId = note.id; 
  appState.pendingImages = [];
  appState.existingImages = (note.images || []).map((i: any) => ({...i}));
  fillNoteForm(note.title || '', note.body || '', note.keywords || '', '메모 수정');
  renderTagOptions(note.category, note.tag || null);
  setPinToggleUI(!!note.pinned);
  setDisplay('note-modal', 'flex');
}

function closeModal() {
  setDisplay('note-modal', 'none');
  stopRecording();
}

// ─────────────────────────────────────────────
// IMAGE UPLOADS (본문 인라인 이미지)
// ─────────────────────────────────────────────
const noteBodyEl = $('note-body') as HTMLTextAreaElement;

// 이미지 압축(Blob) → Storage 업로드 → 본문 커서 위치에 마크다운 삽입
async function uploadAndInsertImage(file: File, prefix: string) {
  const blob = await compressImage(file, 2560, 2560, 0.88);
  const { url } = await uploadImageToStorage(blob, imageFileName(prefix, blob));
  if (noteBodyEl) insertAtCursor(noteBodyEl, `\n![이미지](${url})\n`);
}

const inlineImgBtn = $('inline-img-btn') as HTMLButtonElement;
const inlineImgInput = $('inline-img-input') as HTMLInputElement;

if (inlineImgBtn) {
  inlineImgBtn.onclick = () => inlineImgInput?.click();
}

if (inlineImgInput) {
  inlineImgInput.onchange = async e => {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    const file = files[0];
    inlineImgInput.value = '';
    
    const originalLabel = inlineImgBtn.textContent;
    inlineImgBtn.textContent = '⏳ 업로드 중...';
    inlineImgBtn.classList.add('uploading');
    inlineImgBtn.disabled = true;
    try {
      await uploadAndInsertImage(file, 'inline');
      showToast('이미지가 본문에 삽입되었어요 🖼️');
    } catch(e: any) {
      showToast('업로드 실패: ' + e.message);
    } finally {
      inlineImgBtn.textContent = originalLabel || '🖼️ 이미지 삽입';
      inlineImgBtn.classList.remove('uploading');
      inlineImgBtn.disabled = false;
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
      showToast('붙여넣은 이미지 업로드 중... ⏳');
      try {
        await uploadAndInsertImage(file, 'pasted');
        showToast('이미지가 본문에 붙여넣어졌어요 🖼️');
      } catch(err: any) {
        showToast('이미지 붙여넣기 실패: ' + err.message);
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
  const keywordsEl = $('note-keywords') as HTMLInputElement;
  
  const title = titleEl ? titleEl.value.trim() : '';
  const body = bodyEl ? bodyEl.value.trim() : '';
  const tag = tagRadio ? tagRadio.value : null;
  const pinned = pinnedEl ? pinnedEl.checked : false;
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
    
    if (isEdit) {
      const oldNote = { ...appState.currentNote };
      const updateData = { title, body, tag, images: allImages, pinned, pinnedAt, keywords };
      // 메모 문서 + 인덱스를 단일 트랜잭션으로 저장
      await updateNoteWithIndex(appState.editingNoteId, updateData, oldNote);

      // 수정 과정에서 빠진 첨부 이미지를 Storage에서 병렬 삭제 (UI는 기다리지 않음)
      const removed = (oldNote.images || [])
        .filter((old: any) => !allImages.some((cur: any) => cur.url === old.url))
        .map((img: any) => img.path || img.url);
      if (removed.length) deleteImagesFromStorage(removed).catch(console.error);

      showToast(pinned ? '메모가 수정되었어요 📌' : '메모가 수정되었어요 ✅');
      appState.currentNote = { ...appState.currentNote, ...updateData };
      openDetail(appState.currentNote, detailFrom);
    } else {
      await createNoteWithIndex({
        category: appState.currentCat,
        tag, title, body, images: allImages,
        pinned, pinnedAt, keywords
      });
      showToast(pinned ? '메모가 저장되었어요 📌' : '메모가 저장되었어요 ✅');
    }
    closeModal();
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

// Pin 토글 UI 바인딩
const pinToggleWrap = $('pin-toggle-wrap');
if (pinToggleWrap) {
  pinToggleWrap.addEventListener('click', () => {
    const cb = $('note-pinned') as HTMLInputElement;
    if (cb) {
      cb.checked = !cb.checked;
      setPinToggleUI(cb.checked);
    }
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

// ─────────────────────────────────────────────
// PWA HISTORY & BACK BUTTON
// ─────────────────────────────────────────────
initPwaNavigation((screen) => {
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
  if (screen === 'detail' || screen === 'list') {
    stopListSubscription();
    resetSearchUI();
    showAppScreen('home');
    history.pushState(null, '', location.href);
    return;
  }
});
