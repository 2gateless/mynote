import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CATEGORIES } from '../services/database';
import { appState } from '../state';

// Lazy loading KaTeX module
let katexModule: any = null;
async function loadKatex() {
  if (katexModule) return;
  await import('katex/dist/katex.min.css');
  const mod = await import('katex');
  katexModule = mod.default || mod;
}

export function escHtml(s: string) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function linkify(text: string) {
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
  return String(text).split(urlRegex).map((part, i) => {
    if (i % 2 === 1) {
      const escaped = escHtml(part);
      return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" style="color:var(--sky-deep);word-break:break-all;text-decoration:underline;">${escaped}</a>`;
    }
    return escHtml(part);
  }).join('');
}

export function fmtDate(ts: any) {
  if (!ts?.toDate) return '';
  return ts.toDate().toLocaleDateString('ko-KR', {year:'numeric',month:'long',day:'numeric'});
}

export function stopAllVideos() {
  const container = document.getElementById('detail-content');
  if (container) {
    const iframes = container.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      iframe.src = '';
    });
  }
}

// 동영상 URL → iframe embed HTML 생성
export function buildVideoEmbed(url: string, index = 0) {
  let embedUrl = null;
  let label = '';
  const shouldAutoplay = index === 0;

  const ytWatch = url.match(/youtube\.com\/watch\?(?:[^\s<>"&]*&)*v=([A-Za-z0-9_-]{11})/);
  const ytShort = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  const ytShortsPage = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/);
  const vimeo    = url.match(/vimeo\.com\/(\d+)/);
  const naverTv  = url.match(/tv\.naver\.com\/v\/(\d+)/);
  const kakaoTv  = url.match(/tv\.kakao\.com\/embed\/player\/cliplink\/(\d+)/) || url.match(/tv\.kakao\.com\/channel\/\d+\/cliplink\/(\d+)/);
  const daily    = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
  const gDrive   = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/(?:view|preview)/);

  if (ytWatch)      { embedUrl = `https://www.youtube.com/embed/${ytWatch[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'YouTube'; }
  else if (ytShort) { embedUrl = `https://www.youtube.com/embed/${ytShort[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'YouTube'; }
  else if (ytShortsPage) { embedUrl = `https://www.youtube.com/embed/${ytShortsPage[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'YouTube Shorts'; }
  else if (vimeo)   { embedUrl = `https://player.vimeo.com/video/${vimeo[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'Vimeo'; }
  else if (naverTv) { embedUrl = `https://tv.naver.com/embed/${naverTv[1]}` + (shouldAutoplay ? `?autoPlay=true` : ``); label = 'Naver TV'; }
  else if (kakaoTv) { embedUrl = `https://tv.kakao.com/embed/player/cliplink/${kakaoTv[1]}?service=player_share` + (shouldAutoplay ? `&autoplay=1` : ``); label = 'Kakao TV'; }
  else if (daily)   { embedUrl = `https://www.dailymotion.com/embed/video/${daily[1]}` + (shouldAutoplay ? `?autoplay=1` : ``); label = 'Dailymotion'; }

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

export async function parseMarkdownBody(rawBody: string): Promise<string> {
  if (!marked || !DOMPurify) {
    return linkify(rawBody);
  }

  // ⓪ [[메모 제목]] 패턴을 임시 플레이스홀더로 치환
  const noteLinkRefs: string[] = [];
  let rawBodyProcessed = rawBody.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const idx = noteLinkRefs.length;
    noteLinkRefs.push(title);
    return `NOTELINK_${idx}_END`;
  });

  // ① 동영상 URL 임시 플레이스홀더 치환
  const videoEmbeds: string[] = [];
  let processed = rawBodyProcessed.replace(
    /(^|\s)(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^\s<>"&]*&)*v=[A-Za-z0-9_-]{11}|youtu\.be\/[A-Za-z0-9_-]{11}|youtube\.com\/shorts\/[A-Za-z0-9_-]{11}|vimeo\.com\/\d+|tv\.naver\.com\/v\/\d+|tv\.kakao\.com\/channel\/\d+\/cliplink\/\d+|www\.dailymotion\.com\/video\/[a-zA-Z0-9]+|drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/(?:view|preview))[^\s<>"]*)/g,
    (_, prefix, url) => {
      const idx = videoEmbeds.length;
      videoEmbeds.push(url.trim());
      return `${prefix}VIDEO_EMBED_${idx}_END`;
    }
  );

  // ② 수식 블록 및 인라인 치환
  const mathBlocks: { type: 'block' | 'inline'; expr: string }[] = [];
  processed = processed
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ type: 'block', expr: expr.trim() });
      return `MATH_BLOCK_${idx}_END`;
    })
    .replace(/\$([^$\n]+?)\$/g, (_, expr) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ type: 'inline', expr: expr.trim() });
      return `MATH_INLINE_${idx}_END`;
    });

  // ③ marked 파싱
  let html: any = marked.parse(processed, { breaks: true });

  // ④ KaTeX 복원
  if (mathBlocks.length > 0) {
    try { await loadKatex(); } catch(e) { console.error('KaTeX load error', e); }
  }
  if (katexModule) {
    html = html.replace(/MATH_BLOCK_(\d+)_END/g, (_: string, i: string) => {
      try {
        return katexModule.renderToString(mathBlocks[parseInt(i)].expr, { displayMode: true, throwOnError: false });
      } catch(e) { return `<code>$$${mathBlocks[parseInt(i)].expr}$$</code>`; }
    });
    html = html.replace(/MATH_INLINE_(\d+)_END/g, (_: string, i: string) => {
      try {
        return katexModule.renderToString(mathBlocks[parseInt(i)].expr, { displayMode: false, throwOnError: false });
      } catch(e) { return `<code>$${mathBlocks[parseInt(i)].expr}$</code>`; }
    });
  }

  // ⑤ DOMPurify 살균
  let parsedBody = DOMPurify.sanitize(html, {
    ADD_TAGS: ['math', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'mfrac',
               'msubsup', 'mover', 'munder', 'moverunder', 'menclose',
               'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'mtext',
               'mspace', 'mphantom', 'semantics', 'annotation'],
    ADD_ATTR: ['xmlns', 'display', 'class', 'style', 'aria-hidden',
               'focusable', 'role', 'viewBox', 'width', 'height',
               'preserveAspectRatio', 'fill', 'stroke', 'stroke-width',
               'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r',
               'rx', 'ry', 'transform', 'points', 'encoding',
               'src', 'alt', 'loading', 'decoding']
  });

  // ⑥ 동영상 iframe 복원
  parsedBody = parsedBody.replace(/VIDEO_EMBED_(\d+)_END/g, (_: string, i: string) => {
    return buildVideoEmbed(videoEmbeds[parseInt(i)], parseInt(i));
  });

  // ⑦ [[메모 제목]] 복원
  parsedBody = parsedBody.replace(/NOTELINK_(\d+)_END/g, (_: string, i: string) => {
    const title = noteLinkRefs[parseInt(i)];
    const found = appState.allNotesCache.find((n: any) => n.title === title.trim());
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

  return parsedBody;
}
