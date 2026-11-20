import { appState, SearchIndexEntry } from './state';
import { initAuthListener, loginWithGoogle, logout } from './services/auth';
import {
  CATEGORIES,
  getNoteCategories,
  getNoteTags,
  subscribeUserMeta,
  syncUserMetaCounts,
  subscribeAllNotes
} from './services/database';
import { showToast } from './utils/toast';
import { stripMarkupForSearch } from './utils/formatter';
import {
  initPinModal,
  scheduleInitialPinSetupCheck,
  clearPinMetaSyncState,
  closePinModalByBack,
  closePinModalSilently
} from './ui/pinModal';
import { showAppScreen, showRootScreen, initPwaNavigation, currentScreen, registerServiceWorker } from './pwa';
import { NoteIndexItem } from './types';
import { saveNotesToLocalDb, loadNotesFromLocalDb, clearNotesLocalDb } from './services/notesCache';
import { $, setDisplay, renderUserBar, renderFoldersList } from './ui/dom';
import { initSearchModule, SearchModuleApi } from './ui/search';
import { initListDetailModule, ListDetailApi } from './ui/listDetail';
import { initNoteModalModule, NoteModalApi, NOTE_DRAFT_KEY, NOTE_EDIT_DRAFT_PREFIX } from './ui/noteModal';

// 동적 임포트 지연 로더
let aiModulePromise: Promise<typeof import('./services/ai')> | null = null;
function getAi() {
  if (!aiModulePromise) aiModulePromise = import('./services/ai');
  return aiModulePromise;
}

let imageModulePromise: Promise<typeof import('./utils/image')> | null = null;
function getImage() {
  if (!imageModulePromise) imageModulePromise = import('./utils/image');
  return imageModulePromise;
}

let metaUnsubscribe: (() => void) | null = null;
let notesUnsubscribe: (() => void) | null = null;

let isSearchIndexReady = false;
let localDbLoadPromise: Promise<boolean> | null = null;
let isSearchIndexDirty = true;
let isNotesByTitleDirty = true;
let persistCacheTimer: ReturnType<typeof setTimeout> | null = null;
let bgAllNotesTimer: ReturnType<typeof setTimeout> | null = null;
let hasReconciledMetaOnce = false;
let pendingAllNotesSubscription = false;
let hasNotesLoaded = false;

let lastCounts: Record<string, number> = {};
let lastMetaCounts: Record<string, number> | null = null;

let searchApi!: SearchModuleApi;
let listDetailApi!: ListDetailApi;
let noteModalApi!: NoteModalApi;

function computeCountsFromNotes(notes: NoteIndexItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const perCatSeen: Record<string, Set<string>> = {};
  const allSeen = new Set<string>();
  Object.keys(CATEGORIES).forEach(catId => {
    counts[catId] = 0;
    perCatSeen[catId] = new Set<string>();
  });
  for (const n of notes) {
    if (!n?.id) continue;
    allSeen.add(n.id);
    for (const c of getNoteCategories(n)) {
      if (perCatSeen[c]) perCatSeen[c].add(n.id);
    }
  }
  Object.keys(CATEGORIES).forEach(catId => {
    counts[catId] = perCatSeen[catId].size;
  });
  counts._total = allSeen.size;
  return counts;
}

function applyCounts(counts: Record<string, number>) {
  let sumTotal = 0;
  Object.keys(CATEGORIES).forEach(catId => {
    const n = Math.max(0, counts[catId] || 0);
    sumTotal += n;
    const cnt = $('cnt-' + catId);
    if (cnt) cnt.textContent = String(n);
  });
  const resolvedTotal =
    typeof counts._total === 'number' && counts._total >= 0
      ? counts._total
      : typeof lastCounts._total === 'number' && lastCounts._total >= 0
        ? lastCounts._total
        : Array.isArray(appState.allNotesCache) && appState.allNotesCache.length > 0
          ? appState.allNotesCache.length
          : sumTotal;
  const totalCnt = $('cnt-total-notes');
  if (totalCnt) totalCnt.textContent = String(resolvedTotal);
}

function schedulePersistSearchCache(notes: NoteIndexItem[]) {
  if (persistCacheTimer) clearTimeout(persistCacheTimer);
  persistCacheTimer = setTimeout(() => {
    persistCacheTimer = null;
    saveNotesToLocalDb(notes).catch(e => console.warn('IndexedDB 메모 인덱스 캐시 저장 실패:', e));
  }, 400);
}

function getSearchIndex(): SearchIndexEntry[] {
  if (isSearchIndexDirty || !Array.isArray(appState.searchIndex)) {
    const notes = appState.allNotesCache || [];
    appState.searchIndex = notes.map(n => ({
      note: n,
      // HTML 태그·URL·이미지 마크업을 제거한 순수 텍스트 기준으로 키워드 색인 생성
      text: `${n.title || ''}\n${n.locked ? '' : stripMarkupForSearch(n.snippet || '')}\n${n.keywords || ''}\n${getNoteTags(n).join(' ')}`.toLowerCase()
    }));
    isSearchIndexDirty = false;
  }
  return appState.searchIndex;
}

function getNotesByTitle(): Map<string, NoteIndexItem> {
  if (isNotesByTitleDirty || !(appState.notesByTitle instanceof Map)) {
    const notes = appState.allNotesCache || [];
    const map = new Map<string, NoteIndexItem>();
    for (const n of notes) {
      if (!n.title) continue;
      const trimmed = n.title.trim();
      if (trimmed && !map.has(trimmed)) map.set(trimmed, n);
      const norm = trimmed.replace(/\s+/g, ' ').toLowerCase();
      if (norm && !map.has(norm)) map.set(norm, n);
    }
    appState.notesByTitle = map;
    isNotesByTitleDirty = false;
  }
  return appState.notesByTitle;
}
appState.getNotesByTitle = getNotesByTitle;

function updateNotesCache(notes: NoteIndexItem[], persist = true) {
  hasNotesLoaded = true;
  isSearchIndexReady = true;
  appState.allNotesCache = notes;
  isSearchIndexDirty = true;
  isNotesByTitleDirty = true;
  appState.searchIndex = null;
  appState.notesByTitle = null;
  appState.sortedNotesByTitle = null;

  if (persist) {
    schedulePersistSearchCache(notes);
  }

  noteModalApi?.refreshNoteLinkListIfOpen();

  const queryToSync = searchApi?.shouldSyncSearchOnCacheUpdate();
  if (queryToSync) {
    searchApi.doSearch(queryToSync, true);
  }
}

function ensureSearchIndexReady(): boolean {
  if (isSearchIndexReady) return true;
  if (localDbLoadPromise) return false;

  localDbLoadPromise = loadNotesFromLocalDb()
    .then(cachedNotes => {
      let notesToUse = cachedNotes;
      try {
        const rawLegacy = localStorage.getItem('mynote_search_cache');
        if (rawLegacy) {
          if (!notesToUse || notesToUse.length === 0) {
            const parsed = JSON.parse(rawLegacy);
            if (Array.isArray(parsed) && parsed.length > 0) {
              notesToUse = parsed;
              saveNotesToLocalDb(parsed).catch(() => {});
            }
          }
          localStorage.removeItem('mynote_search_cache');
        }
      } catch {}

      if (notesToUse && notesToUse.length > 0 && !hasNotesLoaded) {
        updateNotesCache(notesToUse, false);
        if (typeof lastCounts._total !== 'number') {
          lastCounts = computeCountsFromNotes(notesToUse);
          try {
            localStorage.setItem('mynote_counts_cache', JSON.stringify(lastCounts));
          } catch {}
          applyCounts(lastCounts);
        }
        const activeListCat = listDetailApi?.getListCatId();
        if (activeListCat && listDetailApi.getListNotesCache().length === 0) {
          const cachedForCat = notesToUse.filter(n => getNoteCategories(n).includes(activeListCat));
          if (cachedForCat.length > 0) {
            listDetailApi.setListNotesCache(cachedForCat);
            listDetailApi.renderList();
          }
        }
        return true;
      }
      return false;
    })
    .catch(() => false)
    .finally(() => {
      localDbLoadPromise = null;
    });

  return false;
}

function reconcileUserMetaIfNeeded(exactCounts: Record<string, number>, totalNotes: number) {
  if (!lastMetaCounts || hasReconciledMetaOnce) return;
  hasReconciledMetaOnce = true;
  const needsSync =
    lastMetaCounts._total !== totalNotes ||
    Object.keys(CATEGORIES).some(catId => (lastMetaCounts![catId] || 0) !== (exactCounts[catId] || 0));
  if (needsSync) {
    lastMetaCounts = { ...exactCounts, _total: totalNotes };
    syncUserMetaCounts(exactCounts, totalNotes).catch(err =>
      console.warn('user_meta 카운트 동기화 오류:', err)
    );
  }
}

function subscribeAllNotesCache() {
  if (bgAllNotesTimer) { clearTimeout(bgAllNotesTimer); bgAllNotesTimer = null; }
  if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
  notesUnsubscribe = subscribeAllNotes((notes, isComplete, actualCatCounts) => {
    appState.isAllNotesComplete = isComplete;
    updateNotesCache(notes, true);
    if (isComplete) {
      const exactCounts: Record<string, number> = {
        ...(actualCatCounts || computeCountsFromNotes(notes)),
        _total: notes.length
      };
      lastCounts = exactCounts;
      try {
        localStorage.setItem('mynote_counts_cache', JSON.stringify(exactCounts));
      } catch {}
      applyCounts(exactCounts);
      reconcileUserMetaIfNeeded(exactCounts, notes.length);
    } else if (typeof lastCounts._total !== 'number') {
      const totalCnt = $('cnt-total-notes');
      if (totalCnt) totalCnt.textContent = String(notes.length);
    }
  });
}

function ensureAllNotesCache() {
  if (notesUnsubscribe) return;
  if (!appState.currentUser) {
    pendingAllNotesSubscription = true;
    return;
  }
  pendingAllNotesSubscription = false;
  subscribeAllNotesCache();
}

function loadAllCounts() {
  if (metaUnsubscribe) metaUnsubscribe();
  metaUnsubscribe = subscribeUserMeta((categoryCount) => {
    lastMetaCounts = { ...categoryCount };

    if (appState.isAllNotesComplete && Array.isArray(appState.allNotesCache) && !hasReconciledMetaOnce) {
      reconcileUserMetaIfNeeded(lastCounts, appState.allNotesCache.length);
    }

    if (typeof categoryCount._total !== 'number') {
      if (typeof lastCounts._total === 'number') {
        categoryCount._total = lastCounts._total;
      }
      ensureAllNotesCache();
    } else if (
      Array.isArray(appState.allNotesCache) &&
      appState.allNotesCache.length !== categoryCount._total
    ) {
      // 다른 기기에서 메모가 추가되거나 삭제되어 총 개수가 달라진 경우 즉시 동기화
      ensureAllNotesCache();
    }

    lastCounts = categoryCount;
    try {
      localStorage.setItem('mynote_counts_cache', JSON.stringify(categoryCount));
    } catch {}
    applyCounts(categoryCount);
  });
}

function clearAuthCache() {
  if (persistCacheTimer) {
    clearTimeout(persistCacheTimer);
    persistCacheTimer = null;
  }
  noteModalApi?.clearDraftTimer();
  clearPinMetaSyncState();
  try {
    localStorage.removeItem('mynote_user_cache');
    localStorage.removeItem('mynote_counts_cache');
    localStorage.removeItem('mynote_search_cache');
    localStorage.removeItem(NOTE_DRAFT_KEY);
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith(NOTE_EDIT_DRAFT_PREFIX)) localStorage.removeItem(k);
    });
  } catch {}
  document.documentElement.classList.remove('has-cached-auth');
  clearNotesLocalDb().catch(() => {});
  getAi().then(ai => ai.clearAiLocalCache()).catch(() => {});
}

function stopAllSubscriptions() {
  if (bgAllNotesTimer) { clearTimeout(bgAllNotesTimer); bgAllNotesTimer = null; }
  if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
  if (metaUnsubscribe) { metaUnsubscribe(); metaUnsubscribe = null; }
  listDetailApi?.stopListSubscription();
  pendingAllNotesSubscription = false;
  hasReconciledMetaOnce = false;
  closePinModalSilently();
  noteModalApi?.closeModal(true);
  searchApi?.closeAiConfigModal();
  noteModalApi?.closeNoteLinkModal();
  setDisplay('del-modal', 'none');
  appState.closeImageViewer?.();
}

// ── UI 모듈 초기화 및 상호 연결
searchApi = initSearchModule({
  getAi,
  ensureSearchIndexReady,
  ensureAllNotesCache,
  getSearchIndex,
  isNotesLoaded: () => hasNotesLoaded,
  openNoteById: (id, from, push) => listDetailApi.openNoteById(id, from, push),
  setDetailFrom: (from) => listDetailApi.setDetailFrom(from),
  clearDetailHistory: () => listDetailApi.clearDetailHistory(),
  setSavedSearchScrollY: (y) => listDetailApi.setSavedSearchScrollY(y),
  getSavedSearchScrollY: () => listDetailApi.getSavedSearchScrollY(),
});

listDetailApi = initListDetailModule({
  getAi,
  getImage,
  ensureSearchIndexReady,
  ensureAllNotesCache,
  getLastCounts: () => lastCounts,
  openEditModal: (note) => noteModalApi.openEditModal(note),
  openSearchFromList: () => {
    if (searchApi.isSearchWrapOpen()) {
      searchApi.exitSearchAndReturn();
    } else {
      searchApi.openSearchWrapAndFocus('list');
    }
  },
  closeSearchWrapIfOpen: () => {
    if (searchApi.isSearchWrapOpen() || searchApi.isSearchVisibleOnHome()) {
      searchApi.closeSearchWrap();
    }
  },
  restoreSearchScreenIfHasContent: () => searchApi.restoreSearchScreenIfHasContent(),
  resetSearchUI: () => searchApi.resetSearchUI(),
  onCacheNoteDeleted: (noteId, detailFrom) => {
    if (Array.isArray(appState.allNotesCache)) {
      appState.allNotesCache = appState.allNotesCache.filter(n => n.id !== noteId);
      isSearchIndexDirty = true;
      isNotesByTitleDirty = true;
      appState.sortedNotesByTitle = null;
    }
    searchApi.syncSearchResultOnNoteDeleted(noteId, detailFrom);
  },
  onCacheNoteUpdated: (noteId, updated, detailFrom) => {
    handleCacheNoteUpdated(noteId, updated, detailFrom);
  },
  onInvalidateEmbeddingPipeline: (noteId) => noteModalApi.invalidateEmbeddingPipeline(noteId),
});

function handleCacheNoteUpdated(
  noteId: string,
  updated: Partial<NoteIndexItem> & { body?: string; locked?: boolean; title?: string },
  detailFrom: string
) {
  if (Array.isArray(appState.allNotesCache)) {
    const idx = appState.allNotesCache.findIndex(n => n.id === noteId);
    if (idx !== -1) {
      const prev = appState.allNotesCache[idx];
      appState.allNotesCache[idx] = {
        ...prev,
        title: updated.title ?? prev.title,
        category: updated.category ?? prev.category,
        categories: updated.categories ?? prev.categories,
        tag: updated.tag ?? prev.tag,
        tags: updated.tags ?? prev.tags,
        keywords: updated.keywords ?? prev.keywords,
        pinned: updated.pinned ?? prev.pinned,
        locked: updated.locked ?? prev.locked,
        snippet: updated.locked ? '' : (typeof updated.body === 'string' ? updated.body.substring(0, 200) : prev.snippet),
      };
      isSearchIndexDirty = true;
      isNotesByTitleDirty = true;
      appState.sortedNotesByTitle = null;
    }
  }
  searchApi.syncSearchResultOnNoteUpdated(noteId, updated, detailFrom);
}

noteModalApi = initNoteModalModule({
  getAi,
  getImage,
  ensureSearchIndexReady,
  ensureAllNotesCache,
  isNotesLoaded: () => hasNotesLoaded,
  openList: (catId, tag) => listDetailApi.openList(catId, tag),
  openDetail: (note, from) => listDetailApi.openDetail(note, from),
  getDetailFrom: () => listDetailApi.getDetailFrom(),
  onCacheNoteUpdated: (noteId, updated, detailFrom) => {
    handleCacheNoteUpdated(noteId, updated, detailFrom);
  },
});

// ── 홈 폴더 목록 동적 렌더링 및 이벤트 위임
const foldersList = $('folders-list');
if (foldersList) {
  foldersList.addEventListener('click', e => {
    const row = (e.target as HTMLElement).closest('.folder-row') as HTMLElement | null;
    if (!row) return;
    const catId = row.dataset.cat;
    if (catId) listDetailApi.openList(catId);
  });
}

// ── 초기 캐시 복원 (0.001초 즉시 렌더링)
function applyEarlyCache() {
  try {
    const rawCounts = localStorage.getItem('mynote_counts_cache');
    if (rawCounts) {
      lastCounts = JSON.parse(rawCounts);
    }
    renderFoldersList(lastCounts);
    applyCounts(lastCounts);

    const rawUser = localStorage.getItem('mynote_user_cache');
    if (rawUser) {
      renderUserBar(JSON.parse(rawUser));
      showRootScreen('app');
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { scheduleInitialPinSetupCheck().catch(() => {}); });
      } else {
        setTimeout(() => { scheduleInitialPinSetupCheck().catch(() => {}); }, 0);
      }
    }

    const scheduleWarmup = () => {
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(() => ensureSearchIndexReady(), { timeout: 2500 });
      } else {
        setTimeout(ensureSearchIndexReady, 300);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => scheduleWarmup());
    } else {
      setTimeout(scheduleWarmup, 50);
    }
  } catch (e) {
    console.warn('초기 캐시 복원 실패:', e);
    renderFoldersList({});
  }
}

applyEarlyCache();

// ── AUTH 리스너
initAuthListener(
  async (user) => {
    try {
      localStorage.setItem('mynote_user_cache', JSON.stringify({
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        uid: user.uid
      }));
    } catch {}
    renderUserBar(user);
    showRootScreen('app');
    loadAllCounts();
    scheduleInitialPinSetupCheck().catch(() => {});

    const syncAiDeferred = () => {
      getAi().then(ai => ai.syncAiConfigFromUserMeta()).catch(() => {});
    };
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(syncAiDeferred, { timeout: 3000 });
    } else {
      setTimeout(syncAiDeferred, 1500);
    }

    const targetCat = listDetailApi.getPendingListCat() || (currentScreen() === 'list' ? appState.currentCat : null);
    if (targetCat) {
      listDetailApi.clearPendingListCat();
      listDetailApi.loadList(targetCat, true);
    }

    if (pendingAllNotesSubscription || searchApi.isSearchWrapOpen()) {
      ensureAllNotesCache();
    } else {
      if (bgAllNotesTimer) clearTimeout(bgAllNotesTimer);
      bgAllNotesTimer = setTimeout(() => {
        bgAllNotesTimer = null;
        if ('requestIdleCallback' in window) {
          (window as any).requestIdleCallback(() => ensureAllNotesCache(), { timeout: 1500 });
        } else {
          ensureAllNotesCache();
        }
      }, 600);
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

setTimeout(() => {
  const ls = $('loading-screen');
  if (ls && ls.style.display !== 'none' && localStorage.getItem('mynote_user_cache')) {
    showRootScreen('app');
  }
}, 1000);

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
    catch (e: any) { showToast('로그인 실패: ' + e.message); }
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

// ── 이미지 뷰어 지연 로딩 & PIN 모달 초기화
const initViewerDeferred = () => {
  import('./ui/imageViewer').then(m => m.initImageViewer()).catch(console.warn);
};
if ('requestIdleCallback' in window) {
  (window as any).requestIdleCallback(initViewerDeferred, { timeout: 2000 });
} else {
  setTimeout(initViewerDeferred, 100);
}
initPinModal();

// ── PWA 뒤로가기 & 서비스 워커 등록
initPwaNavigation((screen) => {
  if (screen === 'ai-config-modal') {
    searchApi.closeAiConfigModal();
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
    noteModalApi.closeNoteLinkModal();
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'modal') {
    noteModalApi.requestCloseModal(false);
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'del-modal') {
    setDisplay(screen, 'none');
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'detail') {
    listDetailApi.goBackFromDetail();
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'home') {
    if (searchApi.isSearchVisibleOnHome() || searchApi.isSearchWrapOpen()) {
      searchApi.exitSearchAndReturn();
      history.pushState(null, '', location.href);
      return;
    }
  }
  if (screen === 'list') {
    if (searchApi.isSearchVisibleOnHome() || searchApi.isSearchWrapOpen()) {
      searchApi.exitSearchAndReturn();
      history.pushState(null, '', location.href);
      return;
    }
    appState.searchReturnTarget = null;
    listDetailApi.stopListSubscription();
    searchApi.resetSearchUI();
    showAppScreen('home');
    history.pushState(null, '', location.href);
    return;
  }
});

registerServiceWorker();

// ── 모바일 백그라운드 복귀 & 네트워크 재연결 리스너
const handleForegroundResume = () => {
  if (document.visibilityState === 'visible' && appState.currentUser) {
    // 폰 등 다른 기기에서 추가된 메모를 즉시 반영할 수 있도록 인덱스 동기화 상태 점검
    ensureAllNotesCache();
    if (currentScreen() === 'list' && appState.currentCat) {
      if (listDetailApi.getListNotesCache().length === 0 || !listDetailApi.hasActiveListSubscription()) {
        listDetailApi.loadList(appState.currentCat, true);
      }
    }
  }
};
document.addEventListener('visibilitychange', handleForegroundResume);
window.addEventListener('pageshow', handleForegroundResume);
window.addEventListener('online', () => {
  if (appState.currentUser && currentScreen() === 'list' && appState.currentCat) {
    listDetailApi.loadList(appState.currentCat, true);
  }
});

// ── PC 사용자를 위한 전역 키보드 단축키 (Ctrl+S 저장, Ctrl+K 또는 / 검색, Esc 닫기/뒤로가기)
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!appState.currentUser) return;
  const screen = currentScreen();
  const target = e.target as HTMLElement | null;
  const isTypingInInput = Boolean(
    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );

  // Ctrl+S / Cmd+S: 메모 작성·수정 모달에서 즉시 저장
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    if (screen === 'modal') {
      e.preventDefault();
      const saveBtn = $('btn-save') as HTMLButtonElement | null;
      if (saveBtn && !saveBtn.disabled) saveBtn.click();
    }
    return;
  }

  // Ctrl+K / Cmd+K: 검색창 즉시 열기 및 포커스
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    if (screen === 'home' || screen === 'list' || screen === 'detail') {
      e.preventDefault();
      if (screen === 'list' && appState.currentCat) {
        appState.searchReturnTarget = { catId: appState.currentCat, tag: appState.currentTag };
        searchApi.openSearchWrapAndFocus('list');
      } else {
        if (screen !== 'home') {
          listDetailApi.stopListSubscription();
          showAppScreen('home');
        }
        appState.searchReturnTarget = null;
        searchApi.openSearchWrapAndFocus('home');
      }
    }
    return;
  }

  // '/' 키: 입력 중이 아닐 때 홈·목록 화면에서 검색창 열기
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingInInput) {
    if (screen === 'home' || screen === 'list') {
      e.preventDefault();
      if (screen === 'list' && appState.currentCat) {
        appState.searchReturnTarget = { catId: appState.currentCat, tag: appState.currentTag };
        searchApi.openSearchWrapAndFocus('list');
      } else {
        appState.searchReturnTarget = null;
        searchApi.openSearchWrapAndFocus('home');
      }
    }
    return;
  }

  // Esc: 모달 닫기 또는 상세 화면 뒤로가기
  if (e.key === 'Escape') {
    if (screen === 'ai-config-modal') {
      e.preventDefault();
      searchApi.closeAiConfigModal();
    } else if (screen === 'pin-modal') {
      e.preventDefault();
      closePinModalByBack();
    } else if (screen === 'img-viewer') {
      e.preventDefault();
      appState.closeImageViewer?.();
    } else if (screen === 'note-link-modal') {
      e.preventDefault();
      noteModalApi.closeNoteLinkModal();
    } else if (screen === 'modal') {
      e.preventDefault();
      noteModalApi.requestCloseModal(false);
    } else if (screen === 'del-modal') {
      e.preventDefault();
      setDisplay('del-modal', 'none');
    } else if (screen === 'detail') {
      e.preventDefault();
      listDetailApi.goBackFromDetail();
    } else if ((screen === 'home' || screen === 'list') && (searchApi.isSearchWrapOpen() || searchApi.isSearchVisibleOnHome())) {
      e.preventDefault();
      searchApi.exitSearchAndReturn();
    }
  }
});
