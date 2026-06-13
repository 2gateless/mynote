import { appState } from './state';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot, getDocs, Timestamp, writeBatch, increment, getDoc, setDoc, runTransaction } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Note {
  id: string;
  title?: string;
  category: string;
  tag?: string;
  body?: string;
  images?: any[];
  pinned?: boolean;
  pinnedAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}
const firebaseConfig = {
  apiKey: "AIzaSyAh3LSEaukyJewUHYCd5EH4-IaDefv2Iio",
  authDomain: "mynote-53a33.firebaseapp.com",
  projectId: "mynote-53a33",
  storageBucket: "mynote-53a33.firebasestorage.app",
  messagingSenderId: "380405953405",
  appId: "1:380405953405:web:fd8b0f47c043ba2b9d5214"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const ALLOWED_EMAILS = ['2gateless@gmail.com'];

const CATEGORIES = {
  memory:         { name: '기억',       icon: '💭' },
  ref_science:    { name: '과학',       icon: '🔬' },
  ref_art:        { name: '예술/종교',       icon: '🎨' },
  nature:         { name: '식물/새/곤충',  icon: '🌿' },
  it_history:     { name: 'IT/역사/문화', icon: '💻' },
  ref_others:     { name: '좋은글/건강/기타',       icon: '📋' },
  finance_realty: { name: '금융/부동산', icon: '💰' },
  office:         { name: '사무실',     icon: '💼' },
  family:         { name: '가족/private', icon: '👨‍👩‍👧‍👦' },
};

const SUB_TAGS = {
  ref_science: ['물리', '수학', '화학', '생명', '지구/지질', '기타'],
  ref_art: ['문학', '미술', '음악', '종교', '기타'],
  nature: ['나무', '풀/꽃', '양치/선태', '지의류', '새', '곤충', '기타'],
  it_history: ['IT', '역사/문화'],
  finance_realty: ['금융', '부동산'],
  ref_others: ['좋은글', '건강', '레시피', '여행', '영화', '기타'],
  family: ['가족', 'private']
};

let currentUser = null;
let currentCat = null;
let currentTag = null;
let currentNote = null;
let editingNoteId = null;
let deleteTargetId = null;
let pendingImages = [];
let existingImages = [];
let recognition = null;
let isRecording = false;
let catUnsubscribes = {};
let listUnsubscribe = null;
let searchTimeout = null;

// 앱 내 메모 링크 기능용 전역 캐시
let allNotesCache = []; // { id, title, category, tag } 목록
let notesUnsubscribe = null;

// ── UTILS
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
  return String(text).split(urlRegex).map((part, i) => {
    if (i % 2 === 1) {
      const escaped = escHtml(part);
      return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" style="color:var(--sky-deep);word-break:break-all;text-decoration:underline;">${escaped}</a>`;
    }
    return escHtml(part);
  }).join('');
}
function fmtDate(ts) {
  if (!ts?.toDate) return '';
  return ts.toDate().toLocaleDateString('ko-KR', {year:'numeric',month:'long',day:'numeric'});
}
function stopAllVideos() {
  const container = document.getElementById('detail-content');
  if (container) {
    const iframes = container.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      iframe.src = '';
    });
  }
}

function showAppScreen(name) {
  if (name !== 'detail') {
    stopAllVideos();
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  window.scrollTo(0, 0);
}
function showRootScreen(name) {
  ['loading-screen','auth-screen','denied-screen','app'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  const el = document.getElementById(name);
  el.style.display = name === 'app' ? 'block' : 'flex';
  if (name !== 'app') el.style.flexDirection = 'column';
}

// ── AUTH
onAuthStateChanged(auth, user => {
  if (user) {
    if (ALLOWED_EMAILS.includes(user.email)) {
      currentUser = user;
      renderUserBar();
      showRootScreen('app');
      migrateCategories().then(() => {
        return migrateNotesToMeta();
      }).then(() => {
        loadAllCounts();
        subscribeAllNotes(); // 앱 내 메모 링크용 전체 메모 구독
      });
    } else {
      document.getElementById('denied-email').textContent = user.email;
      showRootScreen('denied-screen');
    }
  } else {
    currentUser = null;
    if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
    showRootScreen('auth-screen');
  }
});

// 로딩 타임아웃 — 5초 후에도 auth 상태 미확인 시 로그인 화면으로
setTimeout(() => {
  const ls = document.getElementById('loading-screen');
  if (ls && ls.style.display !== 'none') {
    showRootScreen('auth-screen');
  }
}, 5000);

document.getElementById('btn-google-login').onclick = async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch(e) { showToast('로그인 실패: ' + e.message); }
};
document.getElementById('btn-logout').onclick = () => signOut(auth);
document.getElementById('btn-denied-signout').onclick = () => signOut(auth);

function renderUserBar() {
  const av = document.getElementById('user-bar-avatar');
  document.getElementById('user-bar-name').textContent = currentUser.displayName || currentUser.email;
  if (currentUser.photoURL) {
    av.className = 'user-bar-avatar';
    av.innerHTML = `<img src="${currentUser.photoURL}" alt="">`;
  } else {
    av.className = 'user-bar-avatar-default';
    av.textContent = (currentUser.displayName || 'U')[0].toUpperCase();
  }
}

// ── 전체 메모 구독 (앱 내 메모 링크 캐시용)
function subscribeAllNotes() {
  if (notesUnsubscribe) { notesUnsubscribe(); notesUnsubscribe = null; }
  notesUnsubscribe = onSnapshot(doc(db, 'note_index', currentUser.uid), snap => {
    if (snap.exists()) {
      allNotesCache = snap.data().notes || [];
    } else {
      allNotesCache = [];
    }
  });
}

// ── [[메모 제목]] 문법을 앱 내 링크로 변환
function resolveNoteLinks(html) {
  // [[제목]] 패턴을 찾아서 메모 링크 span으로 변환
  return html.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const found = allNotesCache.find(n => n.title === title.trim());
    if (found) {
      const cat = CATEGORIES[found.category];
      const icon = cat ? cat.icon : '📝';
      return `<span class="note-link" data-note-id="${found.id}" data-note-title="${escHtml(title.trim())}" onclick="appState.handleNoteLinkClick(this)" title="메모로 이동: ${escHtml(title.trim())}">`
        + `<span class="note-link-icon">${icon}</span>${escHtml(title.trim())}</span>`;
    } else {
      return `<span class="note-link broken" title="연결된 메모 없음: ${escHtml(title.trim())}">`
        + `<span class="note-link-icon">📝</span>${escHtml(title.trim())} <span style="font-size:0.8em;opacity:0.6">(?)</span></span>`;
    }
  });
}

// 앱 내 메모 링크 클릭 핸들러
appState.handleNoteLinkClick = function(el: any) {
  const noteId = el.dataset.noteId;
  if (!noteId) return;
  // Firestore에서 해당 메모 조회 후 detail 화면으로 이동
  getDoc(doc(db, 'notes', noteId))
    .then(snap => {
      if (snap.exists()) {
        const note = { id: snap.id, ...snap.data() };
        currentCat = note.category;
        document.getElementById('list-title').textContent =
          (CATEGORIES[note.category]?.icon || '') + ' ' + (CATEGORIES[note.category]?.name || '');
        openDetail(note, detailFrom || 'list');
      } else {
        showToast('해당 메모를 찾을 수 없어요');
      }
    })
    .catch(() => showToast('메모를 불러오는 중 오류가 발생했어요'));
};

// ── 데이터 마이그레이션 (reference → ref_science, others → ref_others, ref_others의 IT, 역사/문화 → it_history)
async function migrateCategories() {
  try {
    const migrations = [
      { from: 'reference', to: 'ref_science' },
      { from: 'others',    to: 'ref_others'  },
      { from: 'finance',   to: 'finance_realty' },
      { from: 'realty',    to: 'finance_realty' },
    ];
    for (const { from, to } of migrations) {
      const q = query(collection(db, 'notes'),
        where('uid', '==', currentUser.uid),
        where('category', '==', from));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        await updateDoc(doc(db, 'notes', d.id), { category: to });
      }
      if (snap.size > 0) console.log(`마이그레이션: ${from} → ${to} (${snap.size}건)`);
    }

    // ref_others 카테고리 중 'IT' 혹은 '역사/문화' 태그가 붙은 것들을 'it_history' 카테고리로 변경
    const qMigrateTags = query(collection(db, 'notes'),
      where('uid', '==', currentUser.uid),
      where('category', '==', 'ref_others'),
      where('tag', 'in', ['IT', '역사/문화']));
    const snapTags = await getDocs(qMigrateTags);
    for (const d of snapTags.docs) {
      await updateDoc(doc(db, 'notes', d.id), { category: 'it_history' });
    }
    if (snapTags.size > 0) {
      console.log(`태그 마이그레이션: ref_others(IT, 역사/문화) → it_history (${snapTags.size}건)`);
    }

    // nature 카테고리 중 '꽃' 태그가 붙은 것들을 '풀/꽃' 태그로 변경
    const qMigrateNature = query(collection(db, 'notes'),
      where('uid', '==', currentUser.uid),
      where('category', '==', 'nature'),
      where('tag', '==', '꽃'));
    const snapNature = await getDocs(qMigrateNature);
    for (const d of snapNature.docs) {
      await updateDoc(doc(db, 'notes', d.id), { tag: '풀/꽃' });
    }
    if (snapNature.size > 0) {
      console.log(`태그 마이그레이션: nature(꽃) → 풀/꽃 (${snapNature.size}건)`);
    }
  } catch(e) { console.error('마이그레이션 오류:', e); }
}

async function migrateNotesToMeta() {
  try {
    const metaRef = doc(db, 'user_meta', currentUser.uid);
    const metaSnap = await getDoc(metaRef);
    if (metaSnap.exists()) return;
    console.log('초기 메타데이터 마이그레이션 시작...');
    const q = query(collection(db, 'notes'), where('uid', '==', currentUser.uid));
    const snap = await getDocs(q);
    const categoryCount = {};
    Object.keys(CATEGORIES).forEach(k => categoryCount[k] = 0);
    const notesIndex = [];
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.category && categoryCount[data.category] !== undefined) categoryCount[data.category]++;
      notesIndex.push({
        id: d.id,
        title: data.title || '',
        category: data.category || '',
        tag: data.tag || '',
        snippet: (data.body || '').substring(0, 200)
      });
    });
    const batch = writeBatch(db);
    batch.set(metaRef, { categoryCount });
    batch.set(doc(db, 'note_index', currentUser.uid), { notes: notesIndex });
    await batch.commit();
    console.log('마이그레이션 완료!');
  } catch(e) { console.error('메타 마이그레이션 오류:', e); }
}

async function syncNoteMeta(action, noteId, newData, oldData) {
  await runTransaction(db, async (t) => {
    const metaRef = doc(db, 'user_meta', currentUser.uid);
    const indexRef = doc(db, 'note_index', currentUser.uid);
    const metaSnap = await t.get(metaRef);
    const indexSnap = await t.get(indexRef);
    let categoryCount = metaSnap.exists() ? metaSnap.data().categoryCount || {} : {};
    let notesIndex = indexSnap.exists() ? indexSnap.data().notes || [] : [];
    if (action === 'add') {
      const cat = newData.category;
      if (cat) categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      notesIndex.push({
        id: noteId,
        title: newData.title || '',
        category: cat || '',
        tag: newData.tag || '',
        snippet: (newData.body || '').substring(0, 200)
      });
    } else if (action === 'update') {
      const idx = notesIndex.findIndex(n => n.id === noteId);
      if (idx !== -1) {
        notesIndex[idx] = {
          ...notesIndex[idx],
          title: newData.title !== undefined ? newData.title : notesIndex[idx].title,
          category: newData.category !== undefined ? newData.category : notesIndex[idx].category,
          tag: newData.tag !== undefined ? newData.tag : notesIndex[idx].tag,
          snippet: newData.body !== undefined ? newData.body.substring(0, 200) : notesIndex[idx].snippet
        };
      }
    } else if (action === 'delete') {
      const cat = oldData.category;
      if (cat && categoryCount[cat]) categoryCount[cat] = Math.max(0, categoryCount[cat] - 1);
      notesIndex = notesIndex.filter(n => n.id !== noteId);
    }
    t.set(metaRef, { categoryCount }, { merge: true });
    t.set(indexRef, { notes: notesIndex }, { merge: true });
  });
}

// ── COUNTS
function loadAllCounts() {
  // Listen to the single user_meta doc
  if (catUnsubscribes['meta']) catUnsubscribes['meta']();
  catUnsubscribes['meta'] = onSnapshot(doc(db, 'user_meta', currentUser.uid), snap => {
    const categoryCount = snap.exists() ? (snap.data().categoryCount || {}) : {};
    Object.keys(CATEGORIES).forEach(catId => {
      const n = categoryCount[catId] || 0;
      const cnt = document.getElementById('cnt-' + catId);
      const badge = document.getElementById('badge-' + catId);
      if (cnt) cnt.textContent = `메모 ${n}개`;
      if (badge) {
        badge.textContent = n;
        badge.style.display = n > 0 ? 'inline-block' : 'none';
      }
    });
  });
}

// ── CATEGORY CARDS
document.getElementById('cat-grid').addEventListener('click', e => {
  const card = e.target.closest('.cat-card');
  if (!card) return;
  const catId = card.dataset.cat;
  openList(catId);
});

// ── LIST
appState.openList = openList; // HTML 인라인 이벤트에서 접근할 수 있도록 전역 객체에 할당
function openList(catId: string, tag: string | null = null) {
  currentCat = catId;
  currentTag = tag;
  const cat = CATEGORIES[catId];
  let titleText = cat.icon + ' ' + cat.name;
  document.getElementById('list-title').textContent = titleText;
  
  renderListTagFilter(catId, tag);
  
  showAppScreen('list');
  loadList(catId);
}

function renderListTagFilter(catId, activeTag) {
  const filterBar = document.getElementById('list-tag-filter');
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

function loadList(catId) {
  if (listUnsubscribe) listUnsubscribe();
  const content = document.getElementById('list-content');
  content.innerHTML = `<div style="color:var(--text-light);font-size:14px;padding:8px">불러오는 중...</div>`;
  const q = query(collection(db, 'notes'),
    where('uid', '==', currentUser.uid),
    where('category', '==', catId),
    orderBy('createdAt', 'desc'));
  listUnsubscribe = onSnapshot(q, snap => {
    let notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentTag) {
      notes = notes.filter(n => n.tag === currentTag);
    }
    renderList(notes);
  }, err => {
    content.innerHTML = `<div style="color:var(--danger);font-size:13px">${err.message}</div>`;
  });
}

function renderList(notes) {
  const content = document.getElementById('list-content');
  if (notes.length === 0) {
    content.innerHTML = `<div class="empty-list">
      <div class="ei">${CATEGORIES[currentCat].icon}</div>
      <p>아직 메모가 없어요.<br>첫 번째 메모를 추가해보세요!</p>
    </div>`;
    return;
  }
  // 핀 고정된 메모를 최상단에, 핀된 것끼리는 pinnedAt 내림차순(최신 핀이 위)
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
        <div class="note-list-date">${note.tag ? `<span onclick="event.stopPropagation(); event.preventDefault(); openList('${note.category}', '${note.tag}')" style="color:var(--sky-dark);font-weight:600;margin-right:6px;cursor:pointer">#${escHtml(note.tag)}</span>` : ''}${fmtDate(note.createdAt)}</div>
      </div>
      ${note.pinned ? '<span class="pin-badge" title="핀 고정">📌</span>' : '<span class="note-list-arrow">›</span>'}`;
    item.onclick = () => openDetail(note);
    content.appendChild(item);
  });
}

document.getElementById('list-back').onclick = () => {
  if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
  showAppScreen('home');
};

// ── DETAIL
let detailFrom = 'list'; // 'list' or 'search'

let katexModule: any = null;
async function loadKatex() {
  if (katexModule) return;
  await import('katex/dist/katex.min.css');
  const mod = await import('katex');
  katexModule = mod.default || mod;
}

async function openDetail(note, from) {
  currentNote = note;
  detailFrom = from || 'list';
  document.getElementById('detail-header-title').textContent = note.title || '제목 없음';

  // 뒤로가기 버튼 텍스트 변경
  const backBtn = document.getElementById('detail-back');
  backBtn.textContent = detailFrom === 'search' ? '🏠' : '←';
  backBtn.title = detailFrom === 'search' ? '홈으로' : '목록으로';

  const content = document.getElementById('detail-content');
  const imgs = note.images || [];
  const imgHtml = imgs.length > 0
    ? `<div class="detail-images">${imgs.map(i => `<img class="detail-img" src="${i.url}" alt="이미지" onclick="appState.openImageViewer('${i.url}')">`).join('')}</div>`
    : '';

  const rawBody = note.body || '';
  let parsedBody = '';
  if (marked && DOMPurify) {
    // ⓪ [[메모 제목]] 패턴을 임시 플레이스홀더로 치환 (marked 파싱 전)
    const noteLinkRefs = [];
    let rawBodyProcessed = rawBody.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
      const idx = noteLinkRefs.length;
      noteLinkRefs.push(title);
      return `NOTELINK_${idx}_END`;
    });
    // ① 동영상 URL을 임시 플레이스홀더로 치환 (marked 파싱 및 DOMPurify 이전)
    const videoEmbeds = [];
    let processed = rawBodyProcessed.replace(
      /(^|\s)(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^\s<>"&]*&)*v=[A-Za-z0-9_-]{11}|youtu\.be\/[A-Za-z0-9_-]{11}|youtube\.com\/shorts\/[A-Za-z0-9_-]{11}|vimeo\.com\/\d+|tv\.naver\.com\/v\/\d+|tv\.kakao\.com\/channel\/\d+\/cliplink\/\d+|www\.dailymotion\.com\/video\/[a-zA-Z0-9]+|drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/(?:view|preview))[^\s<>"]*)/g,
      (_, prefix, url) => {
        const idx = videoEmbeds.length;
        videoEmbeds.push(url.trim());
        return `${prefix}VIDEO_EMBED_${idx}_END`;
      }
    );

    // ② 수식 블록($$...$$)과 인라인($...$)을 임시 플레이스홀더로 치환 (marked가 파싱하기 전)
    const mathBlocks = [];
    processed = processed
      // 블록 수식 $$...$$ (줄바꿈 포함)
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
        const idx = mathBlocks.length;
        mathBlocks.push({ type: 'block', expr: expr.trim() });
        return `MATH_BLOCK_${idx}_END`;
      })
      // 인라인 수식 $...$
      .replace(/\$([^$\n]+?)\$/g, (_, expr) => {
        const idx = mathBlocks.length;
        mathBlocks.push({ type: 'inline', expr: expr.trim() });
        return `MATH_INLINE_${idx}_END`;
      });

    // ③ marked로 마크다운 파싱
    let html = marked.parse(processed, { breaks: true });

    // ④ 플레이스홀더를 KaTeX 렌더링 결과로 복원
    if (mathBlocks.length > 0) {
      try { await loadKatex(); } catch(e) { console.error('KaTeX load error', e); }
    }
    if (katexModule) {
      html = html.replace(/MATH_BLOCK_(\d+)_END/g, (_, i) => {
        try {
          return katexModule.renderToString(mathBlocks[i].expr, { displayMode: true, throwOnError: false });
        } catch(e) { return `<code>$$${mathBlocks[i].expr}$$</code>`; }
      });
      html = html.replace(/MATH_INLINE_(\d+)_END/g, (_, i) => {
        try {
          return katexModule.renderToString(mathBlocks[i].expr, { displayMode: false, throwOnError: false });
        } catch(e) { return `<code>$${mathBlocks[i].expr}$</code>`; }
      });
    }

    // ⑤ DOMPurify — KaTeX가 생성하는 태그/속성 허용 + 이미지 src/alt 허용
    parsedBody = DOMPurify.sanitize(html, {
      ADD_TAGS: ['math', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'mfrac',
                 'msubsup', 'mover', 'munder', 'moverunder', 'menclose',
                 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mtext',
                 'mspace', 'mphantom', 'semantics', 'annotation'],
      ADD_ATTR: ['xmlns', 'display', 'class', 'style', 'aria-hidden',
                 'focusable', 'role', 'viewBox', 'width', 'height',
                 'preserveAspectRatio', 'fill', 'stroke', 'stroke-width',
                 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r',
                 'rx', 'ry', 'transform', 'points', 'encoding',
                 'src', 'alt', 'loading', 'decoding']  // 마크다운 이미지 렌더링을 위해 추가
    });

    // ⑥ 동영상 플레이스홀더를 iframe embed로 복원 (DOMPurify 이후 안전하게 삽입)
    parsedBody = parsedBody.replace(/VIDEO_EMBED_(\d+)_END/g, (_, i) => {
      return buildVideoEmbed(videoEmbeds[parseInt(i)], parseInt(i));
    });

    // ⑦ [[메모 제목]] 플레이스홀더를 앱 내 링크로 복원 (DOMPurify 이후 안전하게 삽입)
    parsedBody = parsedBody.replace(/NOTELINK_(\d+)_END/g, (_, i) => {
      const title = noteLinkRefs[parseInt(i)];
      const found = allNotesCache.find(n => n.title === title.trim());
      if (found) {
        const cat = CATEGORIES[found.category];
        const icon = cat ? cat.icon : '📝';
        return `<span class="note-link" data-note-id="${found.id}" data-note-title="${escHtml(title.trim())}" onclick="appState.handleNoteLinkClick(this)" title="메모로 이동: ${escHtml(title.trim())}">`
          + `<span class="note-link-icon">${icon}</span>${escHtml(title.trim())}</span>`;
      } else {
        return `<span class="note-link broken" title="연결된 메모 없음: ${escHtml(title.trim())}">`
          + `<span class="note-link-icon">📝</span>${escHtml(title.trim())} <span style="font-size:0.8em;opacity:0.6">(?)</span></span>`;
      }
    });
  } else {
    parsedBody = linkify(rawBody);
  }

  // 동영상 URL → iframe embed HTML 생성
  function buildVideoEmbed(url, index = 0) {
    let embedUrl = null;
    let label = '';
    const shouldAutoplay = index === 0;

    // YouTube: watch?v=, youtu.be/, shorts/
    const ytWatch = url.match(/youtube\.com\/watch\?(?:[^\s<>"&]*&)*v=([A-Za-z0-9_-]{11})/);
    const ytShort = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    const ytShortsPage = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/);
    const vimeo    = url.match(/vimeo\.com\/(\d+)/);
    const naverTv  = url.match(/tv\.naver\.com\/v\/(\d+)/);
    const kakaoTv  = url.match(/tv\.kakao\.com\/channel\/\d+\/cliplink\/(\d+)/);
    const daily    = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
    // Google Drive: drive.google.com/file/d/{ID}/view 또는 /preview
    const gDrive   = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/(?:view|preview)/);

    if (ytWatch)      { embedUrl = `https://www.youtube.com/embed/${ytWatch[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'YouTube'; }
    else if (ytShort) { embedUrl = `https://www.youtube.com/embed/${ytShort[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'YouTube'; }
    else if (ytShortsPage) { embedUrl = `https://www.youtube.com/embed/${ytShortsPage[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'YouTube Shorts'; }
    else if (vimeo)   { embedUrl = `https://player.vimeo.com/video/${vimeo[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'Vimeo'; }
    else if (naverTv) { embedUrl = `https://tv.naver.com/embed/${naverTv[1]}` + (shouldAutoplay ? `?autoPlay=true` : ``); label = 'Naver TV'; }
    else if (kakaoTv) { embedUrl = `https://tv.kakao.com/embed/player/cliplink/${kakaoTv[1]}?service=player_share` + (shouldAutoplay ? `&autoplay=1` : ``); label = 'Kakao TV'; }
    else if (daily)   { embedUrl = `https://www.dailymotion.com/embed/video/${daily[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'Dailymotion'; }
    // Google Drive는 iframe 컨트롤 UI 문제로 카드 방식으로 처리
    if (gDrive) {
      const fileId = gDrive[1];
      const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w640`;
      const openUrl = url.replace(/"/g, '&quot;');
      return `<a class="video-drive-card" href="${openUrl}" target="_blank" rel="noopener noreferrer">
  <div class="video-drive-thumb">
    <img src="${thumbUrl}" alt="Google Drive 동영상" loading="lazy" onerror="this.style.display='none'">
    <div class="video-drive-play">
      <div class="video-drive-play-btn">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>
      </div>
    </div>
  </div>
  <div class="video-drive-meta">
    <span class="video-drive-meta-icon">☁️</span>
    <span class="video-drive-meta-text">Google Drive 동영상 — 탭하여 재생</span>
    <span class="video-drive-meta-arrow">›</span>
  </div>
</a>`;
    }

    if (!embedUrl) {
      // 지원되지 않는 동영상 URL은 일반 링크로 표시
      const esc = url.replace(/"/g, '&quot;');
      return `<a href="${esc}" target="_blank" rel="noopener noreferrer" style="color:var(--sky-deep);word-break:break-all;text-decoration:underline;">${esc}</a>`;
    }

    return `<div class="video-embed-wrap">
  <div class="video-embed-label">${label}</div>
  <div class="video-embed-container">
    <iframe src="${embedUrl}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
  </div>
  <a class="video-embed-link" href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">🔗 원본 링크로 열기</a>
</div>`;
  }

  content.innerHTML = `
    <div class="detail-meta">
      <span class="detail-cat-badge">${CATEGORIES[note.category]?.icon} ${CATEGORIES[note.category]?.name}</span>
      ${note.tag ? `<span class="detail-tag-badge" onclick="event.stopPropagation(); event.preventDefault(); openList('${note.category}', '${note.tag}')">#${note.tag}</span>` : ''}
      <span class="detail-date">${fmtDate(note.createdAt)}</span>
    </div>
    <div class="detail-body">${parsedBody}</div>
    ${imgHtml}`;
  showAppScreen('detail');
}

document.getElementById('detail-back').onclick = () => {
  if (detailFrom === 'search') {
    // 검색 결과로 진입했으면 홈으로
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchResults.style.display = 'none';
    document.getElementById('cat-grid').style.display = '';
    showAppScreen('home');
  } else {
    showAppScreen('list');
  }
};
document.getElementById('btn-edit-detail').onclick = () => openEditModal(currentNote);
document.getElementById('btn-del-detail').onclick = () => openDelModal(currentNote.id);

// ── SEARCH
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchResults = document.getElementById('search-results');

searchInput.addEventListener('input', () => {
  const v = searchInput.value.trim();
  searchClear.style.display = v ? 'block' : 'none';
  clearTimeout(searchTimeout);
  if (!v) { searchResults.style.display = 'none'; document.getElementById('cat-grid').style.display = ''; return; }
  searchTimeout = setTimeout(() => doSearch(v), 350);
});

searchClear.onclick = () => {
  searchInput.value = '';
  searchClear.style.display = 'none';
  searchResults.style.display = 'none';
  document.getElementById('cat-grid').style.display = '';
};

async function doSearch(keyword) {
  document.getElementById('cat-grid').style.display = 'none';
  searchResults.style.display = 'block';
  searchResults.innerHTML = `<div style="color:var(--text-light);font-size:13px;padding:8px 4px">검색 중...</div>`;
  try {
    const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    const results = allNotesCache.filter(n => {
        const title = (n.title || '').toLowerCase();
        const body = (n.snippet || '').toLowerCase();
        // Option B: Search in title and snippet (200 chars)
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
    document.getElementById('search-home-btn').onclick = () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      searchResults.style.display = 'none';
      document.getElementById('cat-grid').style.display = '';
      showAppScreen('home');
    };
    results.forEach(note => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const cat = CATEGORIES[note.category];
      item.innerHTML = `
        <div class="search-result-title">${escHtml(note.title || '제목 없음')}</div>
        <span class="search-result-cat">${cat?.icon} ${cat?.name}</span>
        ${note.tag ? `<span class="search-result-cat" onclick="event.stopPropagation(); event.preventDefault(); openList('${note.category}', '${note.tag}')" style="background:var(--sky-dark);color:white;margin-left:4px;cursor:pointer">#${escHtml(note.tag)}</span>` : ''}
        <div class="search-result-body">${escHtml(note.snippet || '')}</div>`;
      
      const goToDetail = async () => {
        clearTimeout(searchTimeout);
        searchInput.blur();
        currentCat = note.category;
        document.getElementById('list-title').textContent = (cat?.icon || '') + ' ' + (cat?.name || '');
        const fullDoc = await getDoc(doc(db, 'notes', note.id));
        if (fullDoc.exists()) {
          openDetail({ id: fullDoc.id, ...fullDoc.data() }, 'search');
        } else {
          showToast('삭제된 메모입니다.');
        }
      };
      
      // 모바일에서 스크롤 드래그와 단순 탭을 구분하기 위한 좌표 변수
      let startX = 0, startY = 0;
      let isMoving = false;

      const handleTouchStart = (e) => {
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        isMoving = false;
      };

      const handleTouchMove = (e) => {
        if (isMoving) return;
        const touch = e.touches[0];
        const diffX = Math.abs(touch.clientX - startX);
        const diffY = Math.abs(touch.clientY - startY);
        // 터치 시작 후 손가락이 8px 이상 움직이면 스크롤 중인 것으로 판단
        if (diffX > 8 || diffY > 8) {
          isMoving = true;
        }
      };

      const handleTouchEnd = (e) => {
        if (e.target.closest('.search-result-cat')) return; // 태그 클릭은 개별 처리
        
        // 스크롤 드래그인 경우 상세 화면으로 가지 않음
        if (isMoving) return;
        
        // 단순 탭(클릭)인 경우 즉시 반응하여 키보드 닫힘에 따른 씹힘과 딜레이 방지
        e.preventDefault();
        goToDetail();
      };
      
      const handleMouseDown = (e) => {
        if (e.button !== 0) return; // 좌클릭만 허용
        if (e.target.closest('.search-result-cat')) return;
        goToDetail();
      };
      
      item.addEventListener('touchstart', handleTouchStart, { passive: true });
      item.addEventListener('touchmove', handleTouchMove, { passive: true });
      item.addEventListener('touchend', handleTouchEnd, { passive: false });
      item.addEventListener('mousedown', handleMouseDown);
      
      searchResults.appendChild(item);
    });
  } catch(e) {
    searchResults.innerHTML = `<div style="color:var(--danger);font-size:13px">${e.message}</div>`;
  }
}

// ── MODAL
document.getElementById('btn-add-note').onclick = openAddModal;
document.getElementById('btn-cancel').onclick = closeModal;
document.getElementById('btn-save').onclick = saveNote;

// ── 메모 링크 삽입 모달
const noteLinkModal = document.getElementById('note-link-modal');
const noteLinkSearchInput = document.getElementById('note-link-search-input');
const noteLinkList = document.getElementById('note-link-list');

document.getElementById('note-link-btn').onclick = () => openNoteLinkModal();
document.getElementById('note-link-cancel').onclick = () => closeNoteLinkModal();
noteLinkModal.addEventListener('click', e => { if (e.target.id === 'note-link-modal') closeNoteLinkModal(); });

function openNoteLinkModal() {
  noteLinkSearchInput.value = '';
  renderNoteLinkList('');
  noteLinkModal.style.display = 'flex';
  setTimeout(() => noteLinkSearchInput.focus(), 80);
}
function closeNoteLinkModal() {
  noteLinkModal.style.display = 'none';
}

function renderNoteLinkList(keyword) {
  const kw = keyword.toLowerCase().trim();
  const items = kw
    ? allNotesCache.filter(n => n.title.toLowerCase().includes(kw))
    : allNotesCache.slice();
  // 현재 편집 중인 메모 자신은 제외
  const filtered = editingNoteId ? items.filter(n => n.id !== editingNoteId) : items;
  // 카테고리명으로 정렬
  filtered.sort((a, b) => a.title.localeCompare(b.title, 'ko'));

  if (filtered.length === 0) {
    noteLinkList.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-light);font-size:13px">`
      + (kw ? `🔍 "${escHtml(kw)}" 결과 없음` : '📝 메모가 없어요') + `</div>`;
    return;
  }
  noteLinkList.innerHTML = '';
  filtered.forEach(note => {
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

function insertNoteLink(title) {
  const ta = document.getElementById('note-body');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const linkText = `[[${title}]]`;
  ta.value = ta.value.slice(0, start) + linkText + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + linkText.length;
  ta.focus();
  closeNoteLinkModal();
  showToast(`"${title}" 메모 링크를 삽입했어요 📝`);
}

noteLinkSearchInput.addEventListener('input', () => {
  renderNoteLinkList(noteLinkSearchInput.value);
});

function renderTagOptions(catId, selectedTag) {
  const tg = document.getElementById('tag-group');
  const to = document.getElementById('tag-options');
  if (SUB_TAGS[catId]) {
    tg.style.display = 'block';
    to.innerHTML = SUB_TAGS[catId].map((tag, i) => `
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

function setPinToggleUI(isPinned) {
  const cb = document.getElementById('note-pinned');
  const wrap = document.getElementById('pin-toggle-wrap');
  const status = document.getElementById('pin-toggle-status');
  cb.checked = isPinned;
  if (isPinned) {
    wrap.classList.add('active');
    status.textContent = '📌 고정됨';
  } else {
    wrap.classList.remove('active');
    status.textContent = '고정 안 됨';
  }
}
function openAddModal() {
  editingNoteId = null; pendingImages = []; existingImages = [];
  document.getElementById('note-title').value = '';
  document.getElementById('note-body').value = '';
  document.getElementById('img-preview-list').innerHTML = '';
  document.getElementById('modal-title').textContent = `새 메모 — ${CATEGORIES[currentCat]?.name}`;
  renderTagOptions(currentCat, currentTag || null);
  setPinToggleUI(false);
  document.getElementById('note-modal').style.display = 'flex';
}
function openEditModal(note) {
  editingNoteId = note.id; pendingImages = [];
  existingImages = (note.images || []).map(i => ({...i}));
  document.getElementById('note-title').value = note.title || '';
  document.getElementById('note-body').value = note.body || '';
  document.getElementById('modal-title').textContent = '메모 수정';
  renderTagOptions(note.category, note.tag || null);
  setPinToggleUI(!!note.pinned);
  renderImgPreviews();
  document.getElementById('note-modal').style.display = 'flex';
}
function closeModal() {
  document.getElementById('note-modal').style.display = 'none';
  stopRecording();
}

document.getElementById('img-upload-area').onclick = () => document.getElementById('img-input').click();
document.getElementById('img-input').onchange = e => {
  Array.from(e.target.files).forEach(f => compressAndAdd(f));
  e.target.value = '';
};

// ── 본문 안에 이미지 마크다운으로 삽입
document.getElementById('inline-img-btn').onclick = () => document.getElementById('inline-img-input').click();
document.getElementById('inline-img-input').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const btn = document.getElementById('inline-img-btn');
  btn.textContent = '⏳ 업로드 중...';
  btn.classList.add('uploading');
  btn.disabled = true;
  try {
    // 압축: 최대 800px, 품질 0.6 (폰 화면에 충분한 해상도, 용량 최소화)
    const MAX = 800, QUALITY = 0.6;
    const dataUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = ev => res(ev.target.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    let { width: w, height: h } = img;
    if (w > MAX || h > MAX) {
      const ratio = Math.min(MAX / w, MAX / h);
      w = Math.round(w * ratio); h = Math.round(h * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const compressed = canvas.toDataURL('image/jpeg', QUALITY);

    // Firebase Storage 업로드
    const path = `notes/${currentUser.uid}/inline_${Date.now()}.jpg`;
    const sRef = ref(storage, path);
    await uploadString(sRef, compressed.split(',')[1], 'base64');
    const url = await getDownloadURL(sRef);

    // 커서 위치에 마크다운 이미지 문법 삽입
    const ta = document.getElementById('note-body');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const mdImg = `\n![이미지](${url})\n`;
    ta.value = ta.value.slice(0, start) + mdImg + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + mdImg.length;
    ta.focus();
    showToast('이미지가 본문에 삽입되었어요 🖼️');
  } catch(e) {
    showToast('업로드 실패: ' + e.message);
  } finally {
    btn.textContent = '🖼️ 본문에 이미지';
    btn.classList.remove('uploading');
    btn.disabled = false;
  }
};

async function compressAndAdd(file) {
  const MAX_W = 800, MAX_H = 800, QUALITY = 0.6;
  try {
    const dataUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = ev => res(ev.target.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    let { width: w, height: h } = img;
    if (w > MAX_W || h > MAX_H) {
      const ratio = Math.min(MAX_W / w, MAX_H / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const compressed = canvas.toDataURL('image/jpeg', QUALITY);
    const origKB = Math.round(file.size / 1024);
    const compKB = Math.round(compressed.length * 0.75 / 1024);
    console.log(`압축: ${origKB}KB → ${compKB}KB`);
    pendingImages.push({ dataUrl: compressed, name: file.name.replace(/\.[^.]+$/, '.jpg') });
    renderImgPreviews();
  } catch(e) {
    showToast('이미지 처리 실패: ' + e.message);
  }
}

function renderImgPreviews() {
  const list = document.getElementById('img-preview-list');
  list.innerHTML = '';
  existingImages.forEach((img, i) => {
    const item = document.createElement('div');
    item.className = 'img-preview-item';
    item.innerHTML = `<img src="${img.url}"><button class="img-remove-btn">×</button>`;
    item.querySelector('button').onclick = () => { existingImages.splice(i,1); renderImgPreviews(); };
    list.appendChild(item);
  });
  pendingImages.forEach((img, i) => {
    const item = document.createElement('div');
    item.className = 'img-preview-item';
    item.innerHTML = `<img src="${img.dataUrl}"><button class="img-remove-btn">×</button>`;
    item.querySelector('button').onclick = () => { pendingImages.splice(i,1); renderImgPreviews(); };
    list.appendChild(item);
  });
}

async function saveNote() {
  const title = document.getElementById('note-title').value.trim();
  const body = document.getElementById('note-body').value.trim();
  const tagRadio = document.querySelector('input[name="note-tag"]:checked');
  const tag = tagRadio ? tagRadio.value : null;
  const pinned = document.getElementById('note-pinned').checked;
  if (!title) { showToast('제목을 입력해주세요'); return; }
  const btn = document.getElementById('btn-save');
  btn.textContent = '저장 중...'; btn.disabled = true;
  try {
    const uploadedImgs = [];
    for (const img of pendingImages) {
      try {
        const path = `notes/${currentUser.uid}/${Date.now()}_${img.name}`;
        const sRef = ref(storage, path);
        // base64 데이터에서 헤더 제거 후 업로드
        const base64Data = img.dataUrl.split(',')[1];
        await uploadString(sRef, base64Data, 'base64');
        const url = await getDownloadURL(sRef);
        uploadedImgs.push({ url, path });
      } catch(imgErr) {
        console.error('이미지 업로드 오류:', imgErr);
        showToast('이미지 업로드 실패 — 텍스트만 저장돼요');
      }
    }
    const allImages = [...existingImages, ...uploadedImgs];
    // 핀 고정 상태에 따라 pinnedAt 처리
    const prevPinned = editingNoteId ? !!currentNote?.pinned : false;
    const pinnedAt = pinned
      ? (prevPinned && currentNote?.pinnedAt ? currentNote.pinnedAt : Timestamp.now())
      : null;
    if (editingNoteId) {
      const oldNote = { ...currentNote };
      await updateDoc(doc(db, 'notes', editingNoteId), {
        title, body, tag, images: allImages,
        pinned, pinnedAt,
        updatedAt: Timestamp.now()
      });
      await syncNoteMeta('update', editingNoteId, { title, body, tag, category: currentNote.category }, oldNote);
      showToast(pinned ? '메모가 수정되었어요 📌' : '메모가 수정되었어요 ✅');
      // 상세화면 갱신
      currentNote = { ...currentNote, title, body, tag, images: allImages, pinned, pinnedAt };
      openDetail(currentNote);
    } else {
      const noteRef = doc(collection(db, 'notes'));
      await setDoc(noteRef, {
        uid: currentUser.uid, category: currentCat, tag,
        title, body, images: allImages,
        pinned, pinnedAt,
        createdAt: Timestamp.now()
      });
      await syncNoteMeta('add', noteRef.id, { title, body, tag, category: currentCat }, null);
      showToast(pinned ? '메모가 저장되었어요 📌' : '메모가 저장되었어요 ✅');
    }
    closeModal();
  } catch(e) { showToast('저장 실패: ' + e.message); }
  finally { btn.textContent = '💾 저장'; btn.disabled = false; }
}

// ── DELETE
function openDelModal(id) {
  deleteTargetId = id;
  document.getElementById('del-modal').style.display = 'flex';
}
document.getElementById('del-cancel').onclick = () => { document.getElementById('del-modal').style.display = 'none'; };
document.getElementById('del-confirm').onclick = async () => {
  if (!deleteTargetId) return;
  try {
    await deleteDoc(doc(db, 'notes', deleteTargetId));
    await syncNoteMeta('delete', deleteTargetId, null, currentNote);
    showToast('메모가 삭제되었어요 🗑️');
    document.getElementById('del-modal').style.display = 'none';
    deleteTargetId = null;
    showAppScreen('list');
  } catch(e) { showToast('삭제 실패: ' + e.message); }
};

// ── SHARE
document.getElementById('btn-share-detail').onclick = () => {
  const { title, body } = getShareText();
  if (navigator.share) {
    navigator.share({ title, text: body }).catch(err => {
      if (err.name !== 'AbortError') {
        document.getElementById('share-modal').style.display = 'flex';
      }
    });
  } else {
    document.getElementById('share-modal').style.display = 'flex';
  }
};
document.getElementById('share-cancel').onclick = () => {
  document.getElementById('share-modal').style.display = 'none';
};

function getShareText() {
  if (!currentNote) return { title: '', body: '' };
  return {
    title: currentNote.title || '제목 없음',
    body: currentNote.body || ''
  };
}

// Gmail / 이메일 공유
document.getElementById('share-gmail').onclick = () => {
  const { title, body } = getShareText();
  document.getElementById('share-modal').style.display = 'none';
  location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
};

// 카카오톡 공유
document.getElementById('share-kakao').onclick = () => {
  const { title, body } = getShareText();
  const text = `${title}\n\n${body}`;
  document.getElementById('share-modal').style.display = 'none';

  const isAndroid = /android/i.test(navigator.userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isAndroid) {
    const intentUrl = `intent://send#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=${encodeURIComponent(text)};package=com.kakao.talk;end`;
    const timer = setTimeout(() => {
      showToast('카카오톡이 설치되어 있지 않아요');
    }, 1500);
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
    window.addEventListener('blur', () => clearTimeout(timer), { once: true });
    location.href = intentUrl;
  } else if (isIOS) {
    const kakaoUrl = `kakaolink://send?text=${encodeURIComponent(text)}`;
    const timer = setTimeout(() => {
      showToast('카카오톡이 설치되어 있지 않아요');
    }, 1500);
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
    window.addEventListener('blur', () => clearTimeout(timer), { once: true });
    location.href = kakaoUrl;
  } else {
    showToast('카카오톡 공유는 모바일에서 지원됩니다.');
  }
};

// Telegram 공유
document.getElementById('share-telegram').onclick = () => {
  const { title, body } = getShareText();
  const text = `${title}\n\n${body}`;
  document.getElementById('share-modal').style.display = 'none';
  window.open(`https://t.me/share/url?url=${encodeURIComponent(window.location.href)}&text=${encodeURIComponent(text)}`, '_blank');
};

// 다른 앱으로 공유 (네이티브 공유 시트 강제 호출)
document.getElementById('share-native').onclick = () => {
  const { title, body } = getShareText();
  document.getElementById('share-modal').style.display = 'none';
  if (navigator.share) {
    navigator.share({ title, text: body }).catch(console.error);
  } else {
    showToast('이 브라우저에서는 공유 기능을 지원하지 않아요');
  }
};

// ── VOICE
document.getElementById('voice-btn').onclick = () => {
  if (isRecording) { stopRecording(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('이 브라우저는 음성 입력을 지원하지 않아요'); return; }
  recognition = new SR();
  recognition.lang = 'ko-KR'; recognition.continuous = true; recognition.interimResults = true;
  let final = '';
  recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    document.getElementById('note-body').value += final + interim;
    final = '';
  };
  recognition.onerror = () => { stopRecording(); showToast('음성 인식 오류'); };
  recognition.onend = () => { if (isRecording) stopRecording(); };
  recognition.start();
  isRecording = true;
  const vb = document.getElementById('voice-btn');
  vb.textContent = '🔴 녹음 중... (클릭하여 종료)';
  vb.classList.add('recording');
};
function stopRecording() {
  if (recognition) { try { recognition.stop(); } catch(e){} recognition = null; }
  isRecording = false;
  const vb = document.getElementById('voice-btn');
  vb.textContent = '🎤 음성 입력';
  vb.classList.remove('recording');
}

// 핀 토글 인터랙션
document.getElementById('pin-toggle-wrap').addEventListener('click', () => {
  const cb = document.getElementById('note-pinned');
  cb.checked = !cb.checked;
  setPinToggleUI(cb.checked);
});

// overlay 클릭 닫기
document.getElementById('note-modal').addEventListener('click', e => { if(e.target.id==='note-modal') closeModal(); });
document.getElementById('del-modal').addEventListener('click', e => { if(e.target.id==='del-modal') document.getElementById('del-modal').style.display='none'; });
document.getElementById('share-modal').addEventListener('click', e => { if(e.target.id==='share-modal') document.getElementById('share-modal').style.display='none'; });

// ── 이미지 다운로드
async function downloadImage(url) {
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
    // fetch 실패 시 새 탭으로 열기 (폴백)
    window.open(url, '_blank');
    showToast('새 탭에서 이미지를 길게 눌러 저장하세요');
  }
}

appState.openImageViewer = function(url) {
  const viewer = document.getElementById('img-viewer');
  document.getElementById('img-viewer-img').src = url;
  document.getElementById('img-viewer-download').dataset.url = url;
  viewer.style.display = 'flex';
};
document.getElementById('img-viewer-close').onclick = () => {
  document.getElementById('img-viewer').style.display = 'none';
};
document.getElementById('img-viewer-download').onclick = () => {
  const url = document.getElementById('img-viewer-download').dataset.url;
  if (url) downloadImage(url);
};
document.getElementById('img-viewer').addEventListener('click', e => {
  if(e.target.id === 'img-viewer') document.getElementById('img-viewer').style.display = 'none';
});

// ── 이미지 컨텍스트 메뉴 (우클릭 / 롱프레스)
let ctxMenuUrl = null;
let longPressTimer = null;
const ctxMenu = document.getElementById('img-ctx-menu');

function showImgCtxMenu(x, y, url) {
  ctxMenuUrl = url;
  // 화면 밖으로 나가지 않도록 위치 조정
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

document.getElementById('img-ctx-view').onclick = () => {
  if (ctxMenuUrl) openImageViewer(ctxMenuUrl);
  hideImgCtxMenu();
};
document.getElementById('img-ctx-download').onclick = () => {
  if (ctxMenuUrl) downloadImage(ctxMenuUrl);
  hideImgCtxMenu();
};

// 바깥 클릭 시 메뉴 닫기
document.addEventListener('click', e => {
  if (!ctxMenu.contains(e.target)) hideImgCtxMenu();
});
document.addEventListener('contextmenu', e => {
  if (!ctxMenu.contains(e.target)) hideImgCtxMenu();
});

// detail-content 이미지 이벤트 위임
const detailContent = document.getElementById('detail-content');

// PC: 우클릭 → 커스텀 컨텍스트 메뉴
detailContent.addEventListener('contextmenu', e => {
  const img = e.target.closest('img');
  if (!img) return;
  e.preventDefault();
  showImgCtxMenu(e.clientX, e.clientY, img.src);
});

// 모바일: 롱프레스 → 커스텀 컨텍스트 메뉴
detailContent.addEventListener('touchstart', e => {
  const img = e.target.closest('img');
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

// 이미지 뷰어 내 롱프레스도 지원
const viewerImg = document.getElementById('img-viewer-img');
viewerImg.addEventListener('contextmenu', e => {
  e.preventDefault();
  const url = document.getElementById('img-viewer-download').dataset.url;
  if (url) showImgCtxMenu(e.clientX, e.clientY, url);
});
viewerImg.addEventListener('touchstart', e => {
  const touch = e.touches[0];
  const url = document.getElementById('img-viewer-download').dataset.url;
  longPressTimer = setTimeout(() => {
    if (url) showImgCtxMenu(touch.clientX, touch.clientY, url);
  }, 600);
}, { passive: true });
viewerImg.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
viewerImg.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });

// ── 뒤로가기 (Android/PWA)
function currentScreen() {
  if (document.getElementById('note-modal').style.display !== 'none') return 'modal';
  if (document.getElementById('del-modal').style.display !== 'none') return 'del-modal';
  if (document.getElementById('share-modal').style.display !== 'none') return 'share-modal';
  const active = document.querySelector('.screen.active');
  return active ? active.id.replace('screen-', '') : 'home';
}

window.addEventListener('popstate', e => {
  const screen = currentScreen();
  if (screen === 'modal') { closeModal(); history.pushState(null, '', location.href); return; }
  if (screen === 'del-modal') { document.getElementById('del-modal').style.display = 'none'; history.pushState(null, '', location.href); return; }
  if (screen === 'share-modal') { document.getElementById('share-modal').style.display = 'none'; history.pushState(null, '', location.href); return; }
  if (screen === 'detail') {
    if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
    // 검색 관련 상태 초기화 (깨끗한 홈화면 복원)
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchResults.style.display = 'none';
    document.getElementById('cat-grid').style.display = '';
    
    showAppScreen('home');
    history.pushState(null, '', location.href);
    return;
  }
  if (screen === 'list') {
    if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
    // 검색 관련 상태 초기화
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchResults.style.display = 'none';
    document.getElementById('cat-grid').style.display = '';
    
    showAppScreen('home'); history.pushState(null, '', location.href); return;
  }
  // 홈화면에서 뒤로가기 → 앱 종료 (기본 동작)
});

// 앱 시작 시 history state 설정
history.pushState(null, '', location.href);