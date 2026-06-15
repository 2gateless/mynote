import { appState } from './state';
import { 
  initAuthListener, 
  loginWithGoogle, 
  logout, 
  ALLOWED_EMAILS 
} from './services/auth';
import { 
  CATEGORIES, 
  SUB_TAGS, 
  migrateCategories, 
  migrateNotesToMeta, 
  syncNoteMeta, 
  subscribeUserMeta, 
  subscribeAllNotes, 
  subscribeNotesList, 
  getSingleNote, 
  deleteSingleNote, 
  createNote, 
  updateSingleNote 
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
  uploadImageToStorage 
} from './utils/image';
import { 
  showAppScreen, 
  showRootScreen, 
  initPwaNavigation, 
  currentScreen 
} from './pwa';

let recognition: any = null;
let isRecording = false;
let catUnsubscribes: Record<string, () => void> = {};
let listUnsubscribe: (() => void) | null = null;
let searchTimeout: any = null;
let notesUnsubscribe: (() => void) | null = null;
let detailFrom = 'list'; // 'list' or 'search'

// Toast 메시지 유틸리티
function showToast(msg: string) {
  const t = document.getElementById('toast');
  if (t) {
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }
}

// ── AUTH & 초기화
initAuthListener(
  async (user) => {
    renderUserBar(user);
    showRootScreen('app');
    await migrateCategories();
    await migrateNotesToMeta();
    loadAllCounts();
    subscribeAllNotesCache();
  },
  (email) => {
    const el = document.getElementById('denied-email');
    if (el) el.textContent = email || '';
    showRootScreen('denied-screen');
  },
  () => {
    if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
    showRootScreen('auth-screen');
  }
);

// 로딩 타임아웃
setTimeout(() => {
  const ls = document.getElementById('loading-screen');
  if (ls && ls.style.display !== 'none') {
    showRootScreen('auth-screen');
  }
}, 5000);

const btnLogin = document.getElementById('btn-google-login');
if (btnLogin) {
  btnLogin.onclick = async () => {
    try { await loginWithGoogle(); }
    catch(e: any) { showToast('로그인 실패: ' + e.message); }
  };
}

const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
  btnLogout.onclick = () => logout();
}

const btnDeniedSignout = document.getElementById('btn-denied-signout');
if (btnDeniedSignout) {
  btnDeniedSignout.onclick = () => logout();
}

function renderUserBar(user: any) {
  const av = document.getElementById('user-bar-avatar');
  const nameEl = document.getElementById('user-bar-name');
  if (nameEl) nameEl.textContent = user.displayName || user.email;
  if (av) {
    if (user.photoURL) {
      av.className = 'user-bar-avatar';
      av.innerHTML = `<img src="${user.photoURL}" alt="">`;
    } else {
      av.className = 'user-bar-avatar-default';
      av.textContent = (user.displayName || 'U')[0].toUpperCase();
    }
  }
}

// 전체 메모 구독 (메모 링크 및 캐시용)
function subscribeAllNotesCache() {
  if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
  notesUnsubscribe = subscribeAllNotes((notes) => {
    appState.allNotesCache = notes;
  });
}

// 메모 링크 클릭 핸들러
appState.handleNoteLinkClick = function(el: any) {
  const noteId = el.dataset.noteId;
  if (!noteId) return;
  getSingleNote(noteId)
    .then(note => {
      if (note) {
        appState.currentCat = note.category;
        const listTitle = document.getElementById('list-title');
        if (listTitle) {
          listTitle.textContent =
            (CATEGORIES[note.category]?.icon || '') + ' ' + (CATEGORIES[note.category]?.name || '');
        }
        openDetail(note, detailFrom || 'list');
      } else {
        showToast('해당 메모를 찾을 수 없어요');
      }
    })
    .catch(() => showToast('메모를 불러오는 중 오류가 발생했어요'));
};

// ── COUNTS
function loadAllCounts() {
  if (catUnsubscribes['meta']) catUnsubscribes['meta']();
  catUnsubscribes['meta'] = subscribeUserMeta((categoryCount) => {
    Object.keys(CATEGORIES).forEach(catId => {
      const n = categoryCount[catId] || 0;
      const cnt = document.getElementById('cnt-' + catId);
      const badge = document.getElementById('badge-' + catId);
      if (cnt) cnt.textContent = `메모 ${n}개`;
      if (badge) {
        badge.textContent = String(n);
        badge.style.display = n > 0 ? 'inline-block' : 'none';
      }
    });
  });
}

// ── CATEGORY CARDS CLICK
const catGrid = document.getElementById('cat-grid');
if (catGrid) {
  catGrid.addEventListener('click', e => {
    const card = (e.target as HTMLElement).closest('.cat-card') as HTMLElement;
    if (!card) return;
    const catId = card.dataset.cat;
    if (catId) openList(catId);
  });
}

// ── LIST
appState.openList = openList;
function openList(catId: string, tag: string | null = null) {
  appState.currentCat = catId;
  appState.currentTag = tag;
  const cat = CATEGORIES[catId];
  let titleText = cat.icon + ' ' + cat.name;
  const listTitle = document.getElementById('list-title');
  if (listTitle) listTitle.textContent = titleText;
  
  renderListTagFilter(catId, tag);
  showAppScreen('list');
  loadList(catId);
}

function renderListTagFilter(catId: string, activeTag: string | null) {
  const filterBar = document.getElementById('list-tag-filter');
  if (!filterBar) return;
  const tags = SUB_TAGS[catId];
  if (!tags || tags.length === 0) {
    filterBar.style.display = 'none';
    return;
  }
  filterBar.style.display = 'flex';
  let html = `<div class="tag-filter-btn ${!activeTag ? 'active' : ''}" onclick="appState.openList('${catId}', null)">전체</div>`;
  tags.forEach(t => {
    html += `<div class="tag-filter-btn ${t === activeTag ? 'active' : ''}" onclick="appState.openList('${catId}', '${t}')">#${t}</div>`;
  });
  filterBar.innerHTML = html;
}

function loadList(catId: string) {
  if (listUnsubscribe) listUnsubscribe();
  const content = document.getElementById('list-content');
  if (content) {
    content.innerHTML = `<div style="color:var(--text-light);font-size:14px;padding:8px">불러오는 중...</div>`;
  }
  listUnsubscribe = subscribeNotesList(catId, (notes) => {
    if (appState.currentTag) {
      notes = notes.filter(n => n.tag === appState.currentTag);
    }
    renderList(notes);
  }, (err) => {
    if (content) content.innerHTML = `<div style="color:var(--danger);font-size:13px">${err.message}</div>`;
  });
}

function renderList(notes: any[]) {
  const content = document.getElementById('list-content');
  if (!content) return;
  if (notes.length === 0) {
    content.innerHTML = `<div class="empty-list">
      <div class="ei">${CATEGORIES[appState.currentCat].icon}</div>
      <p>아직 메모가 없어요.<br>첫 번째 메모를 추가해보세요!</p>
    </div>`;
    return;
  }
  // 핀 고정된 메모를 최상단에
  const pinned = notes.filter(n => n.pinned).sort((a, b) => {
    const ta = a.pinnedAt?.toMillis ? a.pinnedAt.toMillis() : 0;
    const tb = b.pinnedAt?.toMillis ? b.pinnedAt.toMillis() : 0;
    return tb - ta;
  });
  const unpinned = notes.filter(n => !n.pinned);
  const sorted = [...pinned, ...unpinned];

  content.innerHTML = '';
  sorted.forEach(note => {
    const item = document.createElement('div');
    item.className = 'note-list-item' + (note.pinned ? ' pinned' : '');
    item.innerHTML = `
      <div class="note-list-bullet"></div>
      <div class="note-list-info">
        <div class="note-list-title">${escHtml(note.title || '제목 없음')}</div>
        <div class="note-list-date">${note.tag ? `<span onclick="event.stopPropagation(); event.preventDefault(); appState.openList('${note.category}', '${note.tag}')" style="color:var(--sky-dark);font-weight:600;margin-right:6px;cursor:pointer">#${escHtml(note.tag)}</span>` : ''}${fmtDate(note.createdAt)}</div>
      </div>
      ${note.pinned ? '<span class="pin-badge" title="핀 고정">📌</span>' : '<span class="note-list-arrow">›</span>'}`;
    item.onclick = () => openDetail(note);
    content.appendChild(item);
  });
}

const listBack = document.getElementById('list-back');
if (listBack) {
  listBack.onclick = () => {
    if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
    showAppScreen('home');
  };
}

// ── DETAIL
async function openDetail(note: any, from?: string) {
  appState.currentNote = note;
  detailFrom = from || 'list';
  const detailHeaderTitle = document.getElementById('detail-header-title');
  if (detailHeaderTitle) detailHeaderTitle.textContent = note.title || '제목 없음';

  const backBtn = document.getElementById('detail-back');
  if (backBtn) {
    backBtn.textContent = detailFrom === 'search' ? '🏠' : '←';
    backBtn.title = detailFrom === 'search' ? '홈으로' : '목록으로';
  }

  const content = document.getElementById('detail-content');
  if (!content) return;
  const imgs = note.images || [];
  const imgHtml = imgs.length > 0
    ? `<div class="detail-images">${imgs.map((i: any) => `<img class="detail-img" src="${i.url}" alt="이미지" onclick="appState.openImageViewer('${i.url}')">`).join('')}</div>`
    : '';

  const parsedBody = await parseMarkdownBody(note.body || '');

  content.innerHTML = `
    <div class="detail-meta">
      <span class="detail-cat-badge">${CATEGORIES[note.category]?.icon} ${CATEGORIES[note.category]?.name}</span>
      ${note.tag ? `<span class="detail-tag-badge" onclick="event.stopPropagation(); event.preventDefault(); appState.openList('${note.category}', '${note.tag}')">#${note.tag}</span>` : ''}
      <span class="detail-date">${fmtDate(note.createdAt)}</span>
    </div>
    <div class="detail-body">${parsedBody}</div>
    ${imgHtml}`;
  showAppScreen('detail');
}

const detailBack = document.getElementById('detail-back');
if (detailBack) {
  detailBack.onclick = () => {
    if (detailFrom === 'search') {
      searchInput.value = '';
      searchClear.style.display = 'none';
      searchResults.style.display = 'none';
      const grid = document.getElementById('cat-grid');
      if (grid) grid.style.display = '';
      showAppScreen('home');
    } else {
      showAppScreen('list');
    }
  };
}

const btnEditDetail = document.getElementById('btn-edit-detail');
if (btnEditDetail) {
  btnEditDetail.onclick = () => openEditModal(appState.currentNote);
}

const btnDelDetail = document.getElementById('btn-del-detail');
if (btnDelDetail) {
  btnDelDetail.onclick = () => openDelModal(appState.currentNote.id);
}

// ── SEARCH
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchClear = document.getElementById('search-clear') as HTMLElement;
const searchResults = document.getElementById('search-results') as HTMLElement;

if (searchInput) {
  searchInput.addEventListener('input', () => {
    const v = searchInput.value.trim();
    searchClear.style.display = v ? 'block' : 'none';
    clearTimeout(searchTimeout);
    if (!v) { 
      searchResults.style.display = 'none'; 
      const grid = document.getElementById('cat-grid');
      if (grid) grid.style.display = ''; 
      return; 
    }
    searchTimeout = setTimeout(() => doSearch(v), 350);
  });
}

if (searchClear) {
  searchClear.onclick = () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchResults.style.display = 'none';
    const grid = document.getElementById('cat-grid');
    if (grid) grid.style.display = '';
  };
}

async function doSearch(keyword: string) {
  const grid = document.getElementById('cat-grid');
  if (grid) grid.style.display = 'none';
  searchResults.style.display = 'block';
  searchResults.innerHTML = `<div style="color:var(--text-light);font-size:13px;padding:8px 4px">검색 중...</div>`;
  try {
    const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    const results = appState.allNotesCache.filter((n: any) => {
        const title = (n.title || '').toLowerCase();
        const body = (n.snippet || '').toLowerCase();
        return keywords.every(kw => title.includes(kw) || body.includes(kw));
    });
    if (results.length === 0) {
      searchResults.innerHTML = `<div class="search-no-result">🔍 "<b>${escHtml(keyword)}</b>" 검색 결과가 없어요</div>`;
      return;
    }
    searchResults.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px 10px">
      <span style="font-size:12px;color:var(--text-light)">${results.length}개 검색됨</span>
      <button id="search-home-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1.5px solid var(--sky-mid);background:transparent;color:var(--text-light);cursor:pointer">🏠 홈으로</button>
    </div>`;
    
    const homeBtn = document.getElementById('search-home-btn');
    if (homeBtn) {
      homeBtn.onclick = () => {
        searchInput.value = '';
        searchClear.style.display = 'none';
        searchResults.style.display = 'none';
        if (grid) grid.style.display = '';
        showAppScreen('home');
      };
    }
    
    results.forEach((note: any) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const cat = CATEGORIES[note.category];
      item.innerHTML = `
        <div class="search-result-title">${escHtml(note.title || '제목 없음')}</div>
        <span class="search-result-cat">${cat?.icon} ${cat?.name}</span>
        ${note.tag ? `<span class="search-result-cat" onclick="event.stopPropagation(); event.preventDefault(); appState.openList('${note.category}', '${note.tag}')" style="background:var(--sky-dark);color:white;margin-left:4px;cursor:pointer">#${escHtml(note.tag)}</span>` : ''}
        <div class="search-result-body">${escHtml(note.snippet || '')}</div>`;
      
      const goToDetail = async () => {
        clearTimeout(searchTimeout);
        searchInput.blur();
        appState.currentCat = note.category;
        const listTitle = document.getElementById('list-title');
        if (listTitle) listTitle.textContent = (cat?.icon || '') + ' ' + (cat?.name || '');
        const fullNote = await getSingleNote(note.id);
        if (fullNote) {
          openDetail(fullNote, 'search');
        } else {
          showToast('삭제된 메모입니다.');
        }
      };
      
      let startX = 0, startY = 0;
      let isMoving = false;

      const handleTouchStart = (e: any) => {
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        isMoving = false;
      };

      const handleTouchMove = (e: any) => {
        if (isMoving) return;
        const touch = e.touches[0];
        const diffX = Math.abs(touch.clientX - startX);
        const diffY = Math.abs(touch.clientY - startY);
        if (diffX > 8 || diffY > 8) {
          isMoving = true;
        }
      };

      const handleTouchEnd = (e: any) => {
        if (e.target.closest('.search-result-cat')) return;
        if (isMoving) return;
        e.preventDefault();
        goToDetail();
      };
      
      const handleMouseDown = (e: any) => {
        if (e.button !== 0) return;
        if (e.target.closest('.search-result-cat')) return;
        goToDetail();
      };
      
      item.addEventListener('touchstart', handleTouchStart, { passive: true });
      item.addEventListener('touchmove', handleTouchMove, { passive: true });
      item.addEventListener('touchend', handleTouchEnd, { passive: false });
      item.addEventListener('mousedown', handleMouseDown);
      
      searchResults.appendChild(item);
    });
  } catch(e: any) {
    searchResults.innerHTML = `<div style="color:var(--danger);font-size:13px">${e.message}</div>`;
  }
}

// ── MODAL ACTIONS
const btnAddNote = document.getElementById('btn-add-note');
if (btnAddNote) btnAddNote.onclick = openAddModal;

const btnCancel = document.getElementById('btn-cancel');
if (btnCancel) btnCancel.onclick = closeModal;

const btnSave = document.getElementById('btn-save');
if (btnSave) btnSave.onclick = saveNote;

// ── 메모 링크 삽입 모달
const noteLinkModal = document.getElementById('note-link-modal') as HTMLElement;
const noteLinkSearchInput = document.getElementById('note-link-search-input') as HTMLInputElement;
const noteLinkList = document.getElementById('note-link-list') as HTMLElement;

const noteLinkBtn = document.getElementById('note-link-btn');
if (noteLinkBtn) {
  noteLinkBtn.onclick = () => openNoteLinkModal();
}

const noteLinkCancel = document.getElementById('note-link-cancel');
if (noteLinkCancel) {
  noteLinkCancel.onclick = () => closeNoteLinkModal();
}

if (noteLinkModal) {
  noteLinkModal.addEventListener('click', e => { 
    if ((e.target as HTMLElement).id === 'note-link-modal') closeNoteLinkModal(); 
  });
}

function openNoteLinkModal() {
  noteLinkSearchInput.value = '';
  renderNoteLinkList('');
  noteLinkModal.style.display = 'flex';
  setTimeout(() => noteLinkSearchInput.focus(), 80);
}
function closeNoteLinkModal() {
  noteLinkModal.style.display = 'none';
}

function renderNoteLinkList(keyword: string) {
  const kw = keyword.toLowerCase().trim();
  const items = kw
    ? appState.allNotesCache.filter((n: any) => n.title.toLowerCase().includes(kw))
    : appState.allNotesCache.slice();
  
  const filtered = appState.editingNoteId ? items.filter((n: any) => n.id !== appState.editingNoteId) : items;
  filtered.sort((a: any, b: any) => a.title.localeCompare(b.title, 'ko'));

  if (filtered.length === 0) {
    noteLinkList.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-light);font-size:13px">`
      + (kw ? `🔍 "${escHtml(kw)}" 결과 없음` : '📝 메모가 없어요') + `</div>`;
    return;
  }
  noteLinkList.innerHTML = '';
  filtered.forEach((note: any) => {
    const cat = CATEGORIES[note.category];
    const item = document.createElement('div');
    item.className = 'note-link-item';
    item.innerHTML = `<span class="note-link-item-cat">${cat ? cat.icon : '📝'}</span>`
      + `<span class="note-link-item-title">${escHtml(note.title)}</span>`
      + (note.tag ? `<span class="note-link-item-tag">#${escHtml(note.tag)}</span>` : '');
    item.onclick = () => insertNoteLink(note.title);
    noteLinkList.appendChild(item);
  });
}

function insertNoteLink(title: string) {
  const ta = document.getElementById('note-body') as HTMLTextAreaElement;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const linkText = `[[${title}]]`;
  ta.value = ta.value.slice(0, start) + linkText + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + linkText.length;
  ta.focus();
  closeNoteLinkModal();
  showToast(`"${title}" 메모 링크를 삽입했어요 📝`);
}

if (noteLinkSearchInput) {
  noteLinkSearchInput.addEventListener('input', () => {
    renderNoteLinkList(noteLinkSearchInput.value);
  });
}

function renderTagOptions(catId: string, selectedTag: string | null) {
  const tg = document.getElementById('tag-group');
  const to = document.getElementById('tag-options');
  if (tg && to) {
    if (SUB_TAGS[catId]) {
      tg.style.display = 'block';
      to.innerHTML = SUB_TAGS[catId].map((tag) => `
        <label style="display:inline-flex">
          <input type="radio" name="note-tag" value="${tag}" class="tag-radio" ${tag === selectedTag ? 'checked' : ''}>
          <span class="tag-label">${tag}</span>
        </label>
      `).join('');
    } else {
      tg.style.display = 'none';
      to.innerHTML = '';
    }
  }
}

function setPinToggleUI(isPinned: boolean) {
  const cb = document.getElementById('note-pinned') as HTMLInputElement;
  const wrap = document.getElementById('pin-toggle-wrap');
  const status = document.getElementById('pin-toggle-status');
  if (cb) cb.checked = isPinned;
  if (wrap && status) {
    if (isPinned) {
      wrap.classList.add('active');
      status.textContent = '📌 고정됨';
    } else {
      wrap.classList.remove('active');
      status.textContent = '고정 안 됨';
    }
  }
}

function openAddModal() {
  appState.editingNoteId = null; 
  appState.pendingImages = []; 
  appState.existingImages = [];
  const title = document.getElementById('note-title') as HTMLInputElement;
  const body = document.getElementById('note-body') as HTMLTextAreaElement;
  const previewList = document.getElementById('img-preview-list');
  const modalTitle = document.getElementById('modal-title');
  if (title) title.value = '';
  if (body) body.value = '';
  if (previewList) previewList.innerHTML = '';
  if (modalTitle) modalTitle.textContent = `새 메모 — ${CATEGORIES[appState.currentCat]?.name}`;
  
  renderTagOptions(appState.currentCat, appState.currentTag || null);
  setPinToggleUI(false);
  const modal = document.getElementById('note-modal');
  if (modal) modal.style.display = 'flex';
}

function openEditModal(note: any) {
  appState.editingNoteId = note.id; 
  appState.pendingImages = [];
  appState.existingImages = (note.images || []).map((i: any) => ({...i}));
  
  const title = document.getElementById('note-title') as HTMLInputElement;
  const body = document.getElementById('note-body') as HTMLTextAreaElement;
  const modalTitle = document.getElementById('modal-title');
  if (title) title.value = note.title || '';
  if (body) body.value = note.body || '';
  if (modalTitle) modalTitle.textContent = '메모 수정';
  
  renderTagOptions(note.category, note.tag || null);
  setPinToggleUI(!!note.pinned);
  renderImgPreviews();
  const modal = document.getElementById('note-modal');
  if (modal) modal.style.display = 'flex';
}

function closeModal() {
  const modal = document.getElementById('note-modal');
  if (modal) modal.style.display = 'none';
  stopRecording();
}

// ── IMAGE UPLOADS
const imgUploadArea = document.getElementById('img-upload-area');
if (imgUploadArea) {
  imgUploadArea.onclick = () => {
    const imgInput = document.getElementById('img-input');
    if (imgInput) imgInput.click();
  };
}

const imgInput = document.getElementById('img-input') as HTMLInputElement;
if (imgInput) {
  imgInput.onchange = e => {
    const files = (e.target as HTMLInputElement).files;
    if (files) {
      Array.from(files).forEach(f => compressAndAdd(f));
    }
    imgInput.value = '';
  };
}

// 본문 인라인 이미지 업로드
const inlineImgBtn = document.getElementById('inline-img-btn') as HTMLButtonElement;
const inlineImgInput = document.getElementById('inline-img-input') as HTMLInputElement;

if (inlineImgBtn) {
  inlineImgBtn.onclick = () => {
    if (inlineImgInput) inlineImgInput.click();
  };
}

if (inlineImgInput) {
  inlineImgInput.onchange = async e => {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    const file = files[0];
    inlineImgInput.value = '';
    
    inlineImgBtn.textContent = '⏳ 업로드 중...';
    inlineImgBtn.classList.add('uploading');
    inlineImgBtn.disabled = true;
    try {
      const compressed = await compressImage(file, 800, 800, 0.6);
      const { url } = await uploadImageToStorage(compressed, `inline_${Date.now()}.jpg`);
      
      const ta = document.getElementById('note-body') as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const mdImg = `\n![이미지](${url})\n`;
      ta.value = ta.value.slice(0, start) + mdImg + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + mdImg.length;
      ta.focus();
      showToast('이미지가 본문에 삽입되었어요 🖼️');
    } catch(e: any) {
      showToast('업로드 실패: ' + e.message);
    } finally {
      inlineImgBtn.textContent = '🖼️ 본문에 이미지';
      inlineImgBtn.classList.remove('uploading');
      inlineImgBtn.disabled = false;
    }
  };
}

async function compressAndAdd(file: File) {
  try {
    const compressed = await compressImage(file, 800, 800, 0.6);
    const origKB = Math.round(file.size / 1024);
    const compKB = Math.round(compressed.length * 0.75 / 1024);
    console.log(`압축: ${origKB}KB → ${compKB}KB`);
    appState.pendingImages.push({ dataUrl: compressed, name: file.name.replace(/\.[^.]+$/, '.jpg') });
    renderImgPreviews();
  } catch(e: any) {
    showToast('이미지 처리 실패: ' + e.message);
  }
}

function renderImgPreviews() {
  const list = document.getElementById('img-preview-list');
  if (!list) return;
  list.innerHTML = '';
  appState.existingImages.forEach((img: any, i: number) => {
    const item = document.createElement('div');
    item.className = 'img-preview-item';
    item.innerHTML = `<img src="${img.url}"><button class="img-remove-btn">×</button>`;
    const btn = item.querySelector('button');
    if (btn) btn.onclick = () => { appState.existingImages.splice(i,1); renderImgPreviews(); };
    list.appendChild(item);
  });
  appState.pendingImages.forEach((img: any, i: number) => {
    const item = document.createElement('div');
    item.className = 'img-preview-item';
    item.innerHTML = `<img src="${img.dataUrl}"><button class="img-remove-btn">×</button>`;
    const btn = item.querySelector('button');
    if (btn) btn.onclick = () => { appState.pendingImages.splice(i,1); renderImgPreviews(); };
    list.appendChild(item);
  });
}

// ── SAVE NOTE
async function saveNote() {
  const titleEl = document.getElementById('note-title') as HTMLInputElement;
  const bodyEl = document.getElementById('note-body') as HTMLTextAreaElement;
  const tagRadio = document.querySelector('input[name="note-tag"]:checked') as HTMLInputElement;
  const pinnedEl = document.getElementById('note-pinned') as HTMLInputElement;
  
  const title = titleEl ? titleEl.value.trim() : '';
  const body = bodyEl ? bodyEl.value.trim() : '';
  const tag = tagRadio ? tagRadio.value : null;
  const pinned = pinnedEl ? pinnedEl.checked : false;
  
  if (!title) { showToast('제목을 입력해주세요'); return; }
  const btn = document.getElementById('btn-save') as HTMLButtonElement;
  if (btn) {
    btn.textContent = '저장 중...'; 
    btn.disabled = true;
  }
  try {
    const uploadedImgs: any[] = [];
    for (const img of appState.pendingImages) {
      try {
        const { url, path } = await uploadImageToStorage(img.dataUrl, img.name);
        uploadedImgs.push({ url, path });
      } catch(imgErr) {
        console.error('이미지 업로드 오류:', imgErr);
        showToast('이미지 업로드 실패 — 텍스트만 저장돼요');
      }
    }
    const allImages = [...appState.existingImages, ...uploadedImgs];
    const prevPinned = appState.editingNoteId ? !!appState.currentNote?.pinned : false;
    // pinnedAt 타임스탬프 계산
    let pinnedAt: any = null;
    if (pinned) {
      pinnedAt = prevPinned && appState.currentNote?.pinnedAt ? appState.currentNote.pinnedAt : new Date();
    }
    
    if (appState.editingNoteId) {
      const oldNote = { ...appState.currentNote };
      const updateData = {
        title, body, tag, images: allImages,
        pinned, pinnedAt
      };
      await updateSingleNote(appState.editingNoteId, updateData);
      await syncNoteMeta('update', appState.editingNoteId, { title, body, tag, category: appState.currentNote.category }, oldNote);
      showToast(pinned ? '메모가 수정되었어요 📌' : '메모가 수정되었어요 ✅');
      
      appState.currentNote = { ...appState.currentNote, ...updateData };
      openDetail(appState.currentNote);
    } else {
      const noteData = {
        category: appState.currentCat,
        tag, title, body, images: allImages,
        pinned, pinnedAt
      };
      const newId = await createNote(noteData);
      await syncNoteMeta('add', newId, { title, body, tag, category: appState.currentCat }, null);
      showToast(pinned ? '메모가 저장되었어요 📌' : '메모가 저장되었어요 ✅');
    }
    closeModal();
  } catch(e: any) { 
    showToast('저장 실패: ' + e.message); 
  } finally { 
    if (btn) {
      btn.textContent = '💾 저장'; 
      btn.disabled = false; 
    }
  }
}

// ── DELETE NOTE
function openDelModal(id: string) {
  appState.deleteTargetId = id;
  const modal = document.getElementById('del-modal');
  if (modal) modal.style.display = 'flex';
}

const delCancel = document.getElementById('del-cancel');
if (delCancel) {
  delCancel.onclick = () => {
    const modal = document.getElementById('del-modal');
    if (modal) modal.style.display = 'none';
  };
}

const delConfirm = document.getElementById('del-confirm');
if (delConfirm) {
  delConfirm.onclick = async () => {
    if (!appState.deleteTargetId) return;
    try {
      await deleteSingleNote(appState.deleteTargetId);
      await syncNoteMeta('delete', appState.deleteTargetId, null, appState.currentNote);
      showToast('메모가 삭제되었어요 🗑️');
      const modal = document.getElementById('del-modal');
      if (modal) modal.style.display = 'none';
      appState.deleteTargetId = null;
      showAppScreen('list');
    } catch(e: any) { showToast('삭제 실패: ' + e.message); }
  };
}

// ── SHARE ACTIONS
const btnShareDetail = document.getElementById('btn-share-detail');
if (btnShareDetail) {
  btnShareDetail.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    if (navigator.share) {
      navigator.share({ title, text: body }).catch(err => {
        if (err.name !== 'AbortError') {
          const modal = document.getElementById('share-modal');
          if (modal) modal.style.display = 'flex';
        }
      });
    } else {
      const modal = document.getElementById('share-modal');
      if (modal) modal.style.display = 'flex';
    }
  };
}

const shareCancel = document.getElementById('share-cancel');
if (shareCancel) {
  shareCancel.onclick = () => {
    const modal = document.getElementById('share-modal');
    if (modal) modal.style.display = 'none';
  };
}

const shareGmail = document.getElementById('share-gmail');
if (shareGmail) {
  shareGmail.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    const modal = document.getElementById('share-modal');
    if (modal) modal.style.display = 'none';
    shareViaEmail(title, body);
  };
}

const shareKakaoBtn = document.getElementById('share-kakao');
if (shareKakaoBtn) {
  shareKakaoBtn.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    const modal = document.getElementById('share-modal');
    if (modal) modal.style.display = 'none';
    shareViaKakao(title, body, showToast);
  };
}

const shareTelegramBtn = document.getElementById('share-telegram');
if (shareTelegramBtn) {
  shareTelegramBtn.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    const modal = document.getElementById('share-modal');
    if (modal) modal.style.display = 'none';
    shareViaTelegram(title, body);
  };
}

const shareNativeBtn = document.getElementById('share-native');
if (shareNativeBtn) {
  shareNativeBtn.onclick = () => {
    const { title, body } = getShareText(appState.currentNote);
    const modal = document.getElementById('share-modal');
    if (modal) modal.style.display = 'none';
    shareViaNative(title, body, showToast);
  };
}

// ── VOICE SPEECH INPUT
const voiceBtn = document.getElementById('voice-btn');
if (voiceBtn) {
  voiceBtn.onclick = () => {
    if (isRecording) { stopRecording(); return; }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast('이 브라우저는 음성 입력을 지원하지 않아요'); return; }
    recognition = new SR();
    recognition.lang = 'ko-KR'; 
    recognition.continuous = true; 
    recognition.interimResults = true;
    let final = '';
    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      const bodyTa = document.getElementById('note-body') as HTMLTextAreaElement;
      if (bodyTa) bodyTa.value += final + interim;
      final = '';
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
  const vb = document.getElementById('voice-btn');
  if (vb) {
    vb.textContent = '🎤 음성 입력';
    vb.classList.remove('recording');
  }
}

// Pin 토글 UI 바인딩
const pinToggleWrap = document.getElementById('pin-toggle-wrap');
if (pinToggleWrap) {
  pinToggleWrap.addEventListener('click', () => {
    const cb = document.getElementById('note-pinned') as HTMLInputElement;
    if (cb) {
      cb.checked = !cb.checked;
      setPinToggleUI(cb.checked);
    }
  });
}

// 모달 바깥 배경 클릭 시 닫기
const noteModal = document.getElementById('note-modal');
if (noteModal) {
  noteModal.addEventListener('click', e => { 
    if ((e.target as HTMLElement).id === 'note-modal') closeModal(); 
  });
}

const delModal = document.getElementById('del-modal');
if (delModal) {
  delModal.addEventListener('click', e => { 
    if ((e.target as HTMLElement).id === 'del-modal') delModal.style.display = 'none'; 
  });
}

const shareModal = document.getElementById('share-modal');
if (shareModal) {
  shareModal.addEventListener('click', e => { 
    if ((e.target as HTMLElement).id === 'share-modal') shareModal.style.display = 'none'; 
  });
}

// ── IMAGE VIEWER
async function downloadImage(url: string) {
  showToast('이미지 저장 중...');
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('gif') ? 'gif' : blob.type.includes('webp') ? 'webp' : 'jpg';
    a.href = blobUrl;
    a.download = `mynote_image_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    showToast('이미지가 저장되었어요 ✅');
  } catch(e) {
    window.open(url, '_blank');
    showToast('새 탭에서 이미지를 길게 눌러 저장하세요');
  }
}

appState.openImageViewer = function(url: string) {
  const viewer = document.getElementById('img-viewer');
  const viewerImg = document.getElementById('img-viewer-img') as HTMLImageElement;
  const downloadBtn = document.getElementById('img-viewer-download') as HTMLElement;
  if (viewerImg) viewerImg.src = url;
  if (downloadBtn) downloadBtn.dataset.url = url;
  if (viewer) viewer.style.display = 'flex';
};

const imgViewerClose = document.getElementById('img-viewer-close');
if (imgViewerClose) {
  imgViewerClose.onclick = () => {
    const viewer = document.getElementById('img-viewer');
    if (viewer) viewer.style.display = 'none';
  };
}

const imgViewerDownload = document.getElementById('img-viewer-download');
if (imgViewerDownload) {
  imgViewerDownload.onclick = () => {
    const url = imgViewerDownload.dataset.url;
    if (url) downloadImage(url);
  };
}

const imgViewer = document.getElementById('img-viewer');
if (imgViewer) {
  imgViewer.addEventListener('click', e => {
    if ((e.target as HTMLElement).id === 'img-viewer') imgViewer.style.display = 'none';
  });
}

// ── IMAGE CONTEXT MENU (ContextMenu & LongPress)
let ctxMenuUrl: string | null = null;
let longPressTimer: any = null;
const ctxMenu = document.getElementById('img-ctx-menu') as HTMLElement;

function showImgCtxMenu(x: number, y: number, url: string) {
  ctxMenuUrl = url;
  ctxMenu.style.display = 'block';
  const menuW = 200, menuH = 110;
  const vw = window.innerWidth, vh = window.innerHeight;
  ctxMenu.style.left = Math.min(x, vw - menuW - 8) + 'px';
  ctxMenu.style.top  = Math.min(y, vh - menuH - 8) + 'px';
}
function hideImgCtxMenu() {
  ctxMenu.style.display = 'none';
  ctxMenuUrl = null;
}

const ctxView = document.getElementById('img-ctx-view');
if (ctxView) {
  ctxView.onclick = () => {
    if (ctxMenuUrl) appState.openImageViewer(ctxMenuUrl);
    hideImgCtxMenu();
  };
}

const ctxDownload = document.getElementById('img-ctx-download');
if (ctxDownload) {
  ctxDownload.onclick = () => {
    if (ctxMenuUrl) downloadImage(ctxMenuUrl);
    hideImgCtxMenu();
  };
}

document.addEventListener('click', e => {
  if (ctxMenu && !ctxMenu.contains(e.target as Node)) hideImgCtxMenu();
});
document.addEventListener('contextmenu', e => {
  if (ctxMenu && !ctxMenu.contains(e.target as Node)) hideImgCtxMenu();
});

// 이미지 컨텍스트 메뉴 터치/클릭 감지 (DetailContent 위임)
const detailContent = document.getElementById('detail-content');
if (detailContent) {
  detailContent.addEventListener('contextmenu', e => {
    const img = (e.target as HTMLElement).closest('img');
    if (!img) return;
    e.preventDefault();
    showImgCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, img.src);
  });
  
  detailContent.addEventListener('touchstart', e => {
    const img = (e.target as HTMLElement).closest('img');
    if (!img) return;
    const touch = e.touches[0];
    longPressTimer = setTimeout(() => {
      showImgCtxMenu(touch.clientX, touch.clientY, img.src);
    }, 600);
  }, { passive: true });
  
  detailContent.addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });
  
  detailContent.addEventListener('touchmove', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });
}

// 이미지 뷰어 롱프레스
const viewerImg = document.getElementById('img-viewer-img');
if (viewerImg) {
  viewerImg.addEventListener('contextmenu', e => {
    e.preventDefault();
    const downloadBtn = document.getElementById('img-viewer-download') as HTMLElement;
    const url = downloadBtn ? downloadBtn.dataset.url : null;
    if (url) showImgCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, url);
  });
  viewerImg.addEventListener('touchstart', e => {
    const touch = e.touches[0];
    const downloadBtn = document.getElementById('img-viewer-download') as HTMLElement;
    const url = downloadBtn ? downloadBtn.dataset.url : null;
    longPressTimer = setTimeout(() => {
      if (url) showImgCtxMenu(touch.clientX, touch.clientY, url);
    }, 600);
  }, { passive: true });
  viewerImg.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
  viewerImg.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
}

// ── PWA HISTORY & BACK BUTTON
initPwaNavigation((screen) => {
  if (screen === 'modal') { 
    closeModal(); 
    history.pushState(null, '', location.href); 
    return; 
  }
  if (screen === 'del-modal') { 
    const modal = document.getElementById('del-modal');
    if (modal) modal.style.display = 'none'; 
    history.pushState(null, '', location.href); 
    return; 
  }
  if (screen === 'share-modal') { 
    const modal = document.getElementById('share-modal');
    if (modal) modal.style.display = 'none'; 
    history.pushState(null, '', location.href); 
    return; 
  }
  if (screen === 'detail') {
    if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchResults.style.display = 'none';
    const grid = document.getElementById('cat-grid');
    if (grid) grid.style.display = '';
    
    showAppScreen('home');
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'list') {
    if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchResults.style.display = 'none';
    const grid = document.getElementById('cat-grid');
    if (grid) grid.style.display = '';
    
    showAppScreen('home'); 
    history.pushState(null, '', location.href); 
    return;
  }
});