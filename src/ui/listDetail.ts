import { appState } from '../state';
import {
  CATEGORIES,
  SUB_TAGS,
  getNoteCategories,
  getNoteTags,
  subscribeCategoryIndex,
  rebuildCategoryIndex,
  getSingleNote,
  deleteNoteWithIndex
} from '../services/database';
import { escHtml, fmtDate, toMillis, parseMarkdownBody } from '../utils/formatter';
import { collectImagePaths } from '../utils/imagePaths';
import { showToast } from '../utils/toast';
import { verifyLockPinForNote } from './pinModal';
import { currentScreen, showAppScreen } from '../pwa';
import { Note, NoteIndexItem } from '../types';
import { $, setDisplay, tagChipHtml, handleTagLink } from './dom';

export interface ListDetailDeps {
  getAi: () => Promise<typeof import('../services/ai')>;
  getShare: () => Promise<typeof import('../utils/share')>;
  getImage: () => Promise<typeof import('../utils/image')>;
  ensureSearchIndexReady: () => boolean;
  ensureAllNotesCache: () => void;
  getLastCounts: () => Record<string, number>;
  openEditModal: (note: Note) => void;
  restoreSearchScreenIfHasContent: () => boolean;
  resetSearchUI: () => void;
  onCacheNoteDeleted: (noteId: string, detailFrom: string) => void;
  onInvalidateEmbeddingPipeline: (noteId: string) => void;
}

export interface ListDetailApi {
  openList: (catId: string, tag?: string | null) => void;
  loadList: (catId: string, force?: boolean) => void;
  renderList: () => void;
  stopListSubscription: () => void;
  openNoteById: (noteId: string, from: string, pushCurrentToHistory?: boolean) => Promise<void>;
  openDetail: (note: Note, from?: string, existingToken?: number) => Promise<void>;
  goBackFromDetail: () => Promise<void>;
  getListCatId: () => string | null;
  getListNotesCache: () => NoteIndexItem[];
  setListNotesCache: (notes: NoteIndexItem[]) => void;
  getPendingListCat: () => string | null;
  clearPendingListCat: () => void;
  getDetailFrom: () => string;
  setDetailFrom: (from: string) => void;
  clearDetailHistory: () => void;
  setSavedSearchScrollY: (y: number) => void;
  getSavedSearchScrollY: () => number;
  hasActiveListSubscription: () => boolean;
}

export function initListDetailModule(deps: ListDetailDeps): ListDetailApi {
  let listUnsubscribe: (() => void) | null = null;
  let listCatId: string | null = null;
  let listNotesCache: NoteIndexItem[] = [];
  let pendingListCat: string | null = null;
  let listLoadTimer: ReturnType<typeof setTimeout> | null = null;
  const rebuiltCats = new Set<string>();

  let detailFrom = 'list';
  let savedSearchScrollY = 0;
  let detailHistoryStack: { noteId: string; from: string }[] = [];
  let detailRenderToken = 0;

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

  function stopListSubscription() {
    if (listLoadTimer) { clearTimeout(listLoadTimer); listLoadTimer = null; }
    if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
    listCatId = null;
    listNotesCache = [];
  }

  function resolveCategoryForTag(note: Pick<NoteIndexItem, 'category' | 'categories'>, tag: string, fallbackCat: string): string {
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
      ? listNotesCache.filter(n => getNoteTags(n).includes(appState.currentTag!))
      : listNotesCache;

    if (notes.length === 0) {
      content.innerHTML = `<div class="empty-list">
        <div class="ei">${(appState.currentCat && CATEGORIES[appState.currentCat]?.icon) || '📝'}</div>
        <p>아직 메모가 없어요.<br>첫 번째 메모를 추가해보세요!</p>
      </div>`;
      return;
    }
    const pinned = notes.filter(n => n.pinned).sort((a, b) => toMillis(b.pinnedAt) - toMillis(a.pinnedAt));
    const unpinned = notes.filter(n => !n.pinned).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

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

  function loadList(catId: string, force = false) {
    if (!force && listUnsubscribe && listCatId === catId) {
      renderList();
      return;
    }
    stopListSubscription();
    listCatId = catId;

    deps.ensureSearchIndexReady();
    const cachedForCat = (appState.allNotesCache || []).filter(n => getNoteCategories(n).includes(catId));
    const content = $('list-content');
    const lastCounts = deps.getLastCounts();

    if (cachedForCat.length > 0) {
      listNotesCache = cachedForCat;
      renderList();
    } else if ((lastCounts[catId] || 0) === 0) {
      listNotesCache = [];
      renderList();
    } else if (content) {
      content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text-light);font-size:14px;padding:24px 0">
        <div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>
        <span>불러오는 중...</span>
      </div>`;
    }

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

    listUnsubscribe = subscribeCategoryIndex(catId, (notes) => {
      if (listLoadTimer) { clearTimeout(listLoadTimer); listLoadTimer = null; }
      listNotesCache = notes;
      renderList();

      const needsRebuild =
        notes.some(n => n.createdAt === undefined || n.pinned === undefined) ||
        (notes.length === 0 && (deps.getLastCounts()[catId] || 0) > 0);
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
  appState.openList = openList;

  function isNoteLockedInCache(noteId: string): boolean {
    const inList = listNotesCache.find(n => n.id === noteId);
    if (inList && inList.locked !== undefined) return !!inList.locked;
    const inAll = (appState.allNotesCache || []).find(n => n.id === noteId);
    if (inAll && inAll.locked !== undefined) return !!inAll.locked;
    return false;
  }

  async function openDetail(note: Note, from?: string, existingToken?: number) {
    deps.ensureAllNotesCache();
    const token = existingToken !== undefined ? existingToken : ++detailRenderToken;
    appState.currentNote = note;
    detailFrom = from || 'list';
    const detailHeaderTitle = $('detail-header-title');
    if (detailHeaderTitle) detailHeaderTitle.textContent = note.title || '제목 없음';

    const backBtn = $('detail-back');
    if (backBtn) {
      backBtn.textContent = '←';
      backBtn.title = detailFrom === 'search' ? '검색 결과로 돌아가기' : '목록으로';
    }

    const content = $('detail-content');
    if (!content) return;
    const rawBodyText = note.body || '';
    const imgs = (note.images || []).filter(i => i?.url && !rawBodyText.includes(i.url));
    const imgHtml = imgs.length > 0
      ? `<div class="detail-images">${imgs.map(i => `<img class="detail-img" src="${escHtml(i.url)}" alt="이미지">`).join('')}</div>`
      : '';

    const parsedBody = await parseMarkdownBody(note.body || '');
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

  async function openNoteById(noteId: string, from: string, pushCurrentToHistory = false) {
    const prevNoteId = currentScreen() === 'detail' && appState.currentNote?.id ? appState.currentNote.id : null;
    const prevFrom = detailFrom || 'list';
    let verified = false;
    if (isNoteLockedInCache(noteId)) {
      const ok = await verifyLockPinForNote();
      if (!ok) return;
      verified = true;
    }
    const reqToken = ++detailRenderToken;
    try {
      const note = await getSingleNote(noteId);
      if (reqToken !== detailRenderToken) return;
      if (!note) { showToast('해당 메모를 찾을 수 없어요'); return; }
      if (note.locked && !verified) {
        const ok = await verifyLockPinForNote();
        if (!ok || reqToken !== detailRenderToken) return;
      }
      if (pushCurrentToHistory && prevNoteId && prevNoteId !== noteId) {
        detailHistoryStack.push({ noteId: prevNoteId, from: prevFrom });
      }
      const noteCats = getNoteCategories(note);
      if (!appState.currentCat || !noteCats.includes(appState.currentCat)) {
        appState.currentCat = noteCats[0] || note.category;
      }
      const listTitle = $('list-title');
      if (listTitle && appState.currentCat) {
        listTitle.textContent = (CATEGORIES[appState.currentCat]?.icon || '') + ' ' + (CATEGORIES[appState.currentCat]?.name || '');
      }
      await openDetail(note, from, reqToken);
    } catch {
      if (reqToken === detailRenderToken) {
        showToast('메모를 불러오는 중 오류가 발생했어요');
      }
    }
  }

  appState.handleNoteLinkClick = function(el: HTMLElement) {
    const noteId = el.dataset.noteId;
    if (noteId) {
      const shouldPushHistory = Boolean(
        currentScreen() === 'detail' && appState.currentNote && appState.currentNote.id && appState.currentNote.id !== noteId
      );
      openNoteById(noteId, detailFrom || 'list', shouldPushHistory);
    }
  };

  function goBackToList() {
    if (appState.currentCat && listCatId !== appState.currentCat) {
      openList(appState.currentCat, null);
    } else {
      showAppScreen('list');
    }
  }

  async function goBackFromDetail() {
    if (detailHistoryStack.length > 0) {
      const prev = detailHistoryStack.pop()!;
      await openNoteById(prev.noteId, prev.from);
      return;
    }
    if (detailFrom === 'search') {
      if (deps.restoreSearchScreenIfHasContent()) return;
      deps.resetSearchUI();
      showAppScreen('home');
    } else {
      goBackToList();
    }
  }

  // 이벤트 바인딩
  const listTagFilter = $('list-tag-filter');
  if (listTagFilter) {
    listTagFilter.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest('[data-filter-tag]') as HTMLElement | null;
      if (!btn || !appState.currentCat) return;
      openList(appState.currentCat, btn.dataset.filterTag || null);
    });
  }

  const listContent = $('list-content');
  if (listContent) {
    listContent.addEventListener('click', e => {
      if (handleTagLink(e, openList)) return;
      const item = (e.target as HTMLElement).closest('.note-list-item') as HTMLElement | null;
      if (item?.dataset.id) openNoteById(item.dataset.id, 'list');
    });
  }

  const listBack = $('list-back');
  if (listBack) {
    listBack.onclick = () => {
      stopListSubscription();
      showAppScreen('home');
    };
  }

  const detailContentEl = $('detail-content');
  if (detailContentEl) {
    detailContentEl.addEventListener('click', e => {
      if (handleTagLink(e, openList)) return;
      const link = (e.target as HTMLElement).closest('.note-link[data-note-id]') as HTMLElement | null;
      if (link) appState.handleNoteLinkClick?.(link);
    });
  }

  const detailBack = $('detail-back');
  if (detailBack) detailBack.onclick = () => goBackFromDetail();

  const btnEditDetail = $('btn-edit-detail');
  if (btnEditDetail) {
    btnEditDetail.onclick = () => {
      if (appState.currentNote) deps.openEditModal(appState.currentNote);
    };
  }

  const btnDelDetail = $('btn-del-detail');
  if (btnDelDetail) {
    btnDelDetail.onclick = () => {
      if (appState.currentNote?.id) {
        appState.deleteTargetId = appState.currentNote.id;
        setDisplay('del-modal', 'flex');
      }
    };
  }

  const delCancel = $('del-cancel');
  if (delCancel) delCancel.onclick = () => setDisplay('del-modal', 'none');

  const delConfirm = $('del-confirm') as HTMLButtonElement | null;
  if (delConfirm) {
    delConfirm.onclick = async () => {
      const id = appState.deleteTargetId;
      if (!id || delConfirm.disabled) return;
      delConfirm.disabled = true;
      try {
        const target = appState.currentNote?.id === id ? appState.currentNote : await getSingleNote(id);
        if (!target) {
          showToast('이미 삭제된 메모예요');
        } else {
          deps.onInvalidateEmbeddingPipeline(id);
          await deleteNoteWithIndex(id, target);
          deps.getAi().then(ai => ai.removeVectorNoteCache(id)).catch(() => {});
          deps.onCacheNoteDeleted(id, detailFrom);
          detailHistoryStack = detailHistoryStack.filter(item => item.noteId !== id);
          const paths = collectImagePaths(target);
          if (paths.length) {
            deps.getImage().then(m => m.deleteImagesFromStorage(paths)).catch(console.error);
          }
          showToast('메모가 삭제되었어요 🗑️');
        }
        setDisplay('del-modal', 'none');
        appState.deleteTargetId = null;
        goBackFromDetail();
      } catch (e: any) {
        showToast('삭제 실패: ' + e.message);
      } finally {
        delConfirm.disabled = false;
      }
    };
  }

  // 공유 액션
  const btnShareDetail = $('btn-share-detail');
  if (btnShareDetail) {
    btnShareDetail.onclick = () => {
      const note = appState.currentNote;
      const title = note?.title || '제목 없음';
      const body = note?.body || '';
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

  const shareNativeBtn = $('share-native');
  if (shareNativeBtn) {
    shareNativeBtn.onclick = () => {
      const note = appState.currentNote;
      const title = note?.title || '제목 없음';
      const body = note?.body || '';
      setDisplay('share-modal', 'none');
      if (navigator.share) {
        navigator.share({ title, text: body }).catch(console.error);
      } else {
        showToast('이 브라우저에서는 공유 기능을 지원하지 않아요');
      }
    };
  }

  function bindShare(id: string, fn: (share: typeof import('../utils/share'), title: string, body: string) => void) {
    const el = $(id);
    if (!el) return;
    el.onclick = async () => {
      const share = await deps.getShare();
      const { title, body } = share.getShareText(appState.currentNote);
      setDisplay('share-modal', 'none');
      fn(share, title, body);
    };
  }
  bindShare('share-gmail', (share, t, b) => share.shareViaEmail(t, b));
  bindShare('share-kakao', (share, t, b) => share.shareViaKakao(t, b, showToast));
  bindShare('share-telegram', (share, t, b) => share.shareViaTelegram(t, b));

  ['del-modal', 'share-modal'].forEach(id => {
    const modal = $(id);
    if (modal) {
      modal.addEventListener('click', e => {
        if ((e.target as HTMLElement).id === id) modal.style.display = 'none';
      });
    }
  });

  return {
    openList,
    loadList,
    renderList,
    stopListSubscription,
    openNoteById,
    openDetail,
    goBackFromDetail,
    getListCatId: () => listCatId,
    getListNotesCache: () => listNotesCache,
    setListNotesCache: (notes) => { listNotesCache = notes; },
    getPendingListCat: () => pendingListCat,
    clearPendingListCat: () => { pendingListCat = null; },
    getDetailFrom: () => detailFrom,
    setDetailFrom: (from) => { detailFrom = from; },
    clearDetailHistory: () => { detailHistoryStack = []; },
    setSavedSearchScrollY: (y) => { savedSearchScrollY = y; },
    getSavedSearchScrollY: () => savedSearchScrollY,
    hasActiveListSubscription: () => Boolean(listUnsubscribe),
  };
}
