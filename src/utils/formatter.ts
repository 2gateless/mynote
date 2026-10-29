import { CATEGORIES } from '../services/database';
import { appState } from '../state';

// Lazy loading marked & DOMPurify module
let markedModule: any = null;
let purifyModule: any = null;

async function loadMarkdownModules() {
  if (markedModule && purifyModule) return;
  const [m, p] = await Promise.all([
    import('marked'),
    import('dompurify')
  ]);
  markedModule = m.marked || (m as any).default || m;
  purifyModule = p.default || p;
}

// Lazy loading KaTeX module
let katexModule: any = null;
async function loadKatex() {
  if (katexModule) return;
  // @ts-ignore - Vite handles CSS imports at bundle time
  await import('katex/dist/katex.min.css');
  const mod = await import('katex');
  katexModule = (mod as any).default || mod;
}

// HTML 텍스트·속성값 모두에 안전하도록 따옴표까지 이스케이프
export function escHtml(s: string) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
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

export function toMillis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  if (typeof ts === 'number') return ts;
  return 0;
}

export function fmtDate(ts: any) {
  const ms = toMillis(ts);
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
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
    const openUrl = escHtml(url);
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

  const safeUrl = escHtml(url);
  if (!embedUrl) {
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--sky-deep);word-break:break-all;text-decoration:underline;">${safeUrl}</a>`;
  }

  return `<div class="video-embed-wrap">
<div class="video-embed-label">${label}</div>
<div class="video-embed-container">
  <iframe src="${escHtml(embedUrl)}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>
<a class="video-embed-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">🔗 원본 링크로 열기</a>
</div>`;
}

export async function parseMarkdownBody(rawBody: string): Promise<string> {
  try {
    await loadMarkdownModules();
  } catch (e) {
    console.error('Markdown modules load error', e);
  }

  if (!markedModule || !purifyModule) {
    return linkify(rawBody);
  }

  // ⓪ 코드 블록(```...```) 및 인라인 코드(`...`) 보호
  // 코드 내부의 [[...]], $...$, URL이 수식이나 링크로 변환되지 않도록 먼저 분리
  const codeBlocks: string[] = [];
  let processed = rawBody.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `@@CODEBLOCK${idx}@@`;
  });

  // ① [[메모 제목]] 패턴을 임시 플레이스홀더로 치환 (밑줄 없는 토큰으로 마크다운 이탤릭 충돌 방지)
  const noteLinkRefs: string[] = [];
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const idx = noteLinkRefs.length;
    noteLinkRefs.push(title);
    return `@@NOTELINK${idx}@@`;
  });

  // ② 동영상 URL 임시 플레이스홀더 치환
  const videoEmbeds: string[] = [];
  processed = processed.replace(
    /(^|\s)(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^\s<>"&]*&)*v=[A-Za-z0-9_-]{11}|youtu\.be\/[A-Za-z0-9_-]{11}|youtube\.com\/shorts\/[A-Za-z0-9_-]{11}|vimeo\.com\/\d+|tv\.naver\.com\/v\/\d+|tv\.kakao\.com\/channel\/\d+\/cliplink\/\d+|www\.dailymotion\.com\/video\/[a-zA-Z0-9]+|drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/(?:view|preview))[^\s<>"]*)/g,
    (_, prefix, url) => {
      const idx = videoEmbeds.length;
      videoEmbeds.push(url.trim());
      return `${prefix}@@VIDEOEMBED${idx}@@`;
    }
  );

  // ③ 수식 블록 및 인라인 치환
  const mathBlocks: { type: 'block' | 'inline'; expr: string }[] = [];
  processed = processed
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ type: 'block', expr: expr.trim() });
      return `@@MATHBLOCK${idx}@@`;
    })
    .replace(/\$([^$\n]+?)\$/g, (_, expr) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ type: 'inline', expr: expr.trim() });
      return `@@MATHINLINE${idx}@@`;
    });

  // ④ 보호했던 코드 블록 복원 후 marked 파싱
  if (codeBlocks.length > 0) {
    processed = processed.replace(/@@CODEBLOCK(\d+)@@/g, (_, i) => codeBlocks[parseInt(i, 10)]);
  }
  const rawHtml: string = markedModule.parse(processed, { breaks: true });

  // ⑤ DOMPurify 살균을 먼저 수행 (사용자 마크다운에서 악성 스크립트/style 속성 원천 제거)
  let parsedBody: string = purifyModule.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'loading', 'decoding']
  });

  // ⑥ KaTeX 수식 복원
  if (mathBlocks.length > 0) {
    try { await loadKatex(); } catch(e) { console.error('KaTeX load error', e); }
  }
  if (katexModule) {
    parsedBody = parsedBody.replace(/@@MATHBLOCK(\d+)@@/g, (_: string, i: string) => {
      const expr = mathBlocks[parseInt(i, 10)]?.expr || '';
      try {
        return katexModule.renderToString(expr, { displayMode: true, throwOnError: false });
      } catch(e) { return `<code>$$${escHtml(expr)}$$</code>`; }
    });
    parsedBody = parsedBody.replace(/@@MATHINLINE(\d+)@@/g, (_: string, i: string) => {
      const expr = mathBlocks[parseInt(i, 10)]?.expr || '';
      try {
        return katexModule.renderToString(expr, { displayMode: false, throwOnError: false });
      } catch(e) { return `<code>$${escHtml(expr)}$</code>`; }
    });
  } else if (mathBlocks.length > 0) {
    parsedBody = parsedBody.replace(/@@MATHBLOCK(\d+)@@/g, (_: string, i: string) => `<code>$$${escHtml(mathBlocks[parseInt(i, 10)]?.expr || '')}$$</code>`);
    parsedBody = parsedBody.replace(/@@MATHINLINE(\d+)@@/g, (_: string, i: string) => `<code>$${escHtml(mathBlocks[parseInt(i, 10)]?.expr || '')}$</code>`);
  }

  // ⑦ 동영상 iframe 복원
  parsedBody = parsedBody.replace(/@@VIDEOEMBED(\d+)@@/g, (_: string, i: string) => {
    const idx = parseInt(i, 10);
    return buildVideoEmbed(videoEmbeds[idx], idx);
  });

  // ⑧ [[메모 제목]] 복원 (제목→메모 Map으로 O(1) 조회, 클릭은 detail-content 이벤트 위임에서 처리)
  const titleMap: Map<string, any> | undefined = appState.notesByTitle;
  parsedBody = parsedBody.replace(/@@NOTELINK(\d+)@@/g, (_: string, i: string) => {
    const title = (noteLinkRefs[parseInt(i, 10)] || '').trim();
    const safeTitle = escHtml(title);
    const found = titleMap
      ? titleMap.get(title)
      : appState.allNotesCache.find((n: any) => n.title === title);
    if (found) {
      const cat = CATEGORIES[found.category];
      const icon = cat ? cat.icon : '📝';
      return `<span class="note-link" data-note-id="${escHtml(found.id)}" data-note-title="${safeTitle}" title="메모로 이동: ${safeTitle}">`
        + `<span class="note-link-icon">${icon}</span>${safeTitle}</span>`;
    } else {
      return `<span class="note-link broken" title="연결된 메모 없음: ${safeTitle}">`
        + `<span class="note-link-icon">📝</span>${safeTitle} <span style="font-size:0.8em;opacity:0.6">(?)</span></span>`;
    }
  });

  return parsedBody;
}
