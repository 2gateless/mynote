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

const koDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
});

export function fmtDate(ts: any) {
  const ms = toMillis(ts);
  if (!ms) return '';
  return koDateFormatter.format(ms);
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
    const thumbUrl = escHtml(`https://drive.google.com/thumbnail?id=${fileId}&sz=w640`);
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
<div class="video-embed-label">${escHtml(label)}</div>
<div class="video-embed-container">
  <iframe src="${escHtml(embedUrl)}" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>
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
  // 마크다운 강조(_, *) 등과 충돌하지 않도록 영숫자 전용 플레이스홀더 사용
  const codeBlocks: string[] = [];
  let processed = rawBody.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `MYNOTEPHCODE${idx}END`;
  });

  // ① [[메모 제목]] 패턴을 임시 플레이스홀더로 치환 (제목 내부에 대괄호 [말머리]가 포함된 경우도 안전하게 매칭)
  const noteLinkRefs: string[] = [];
  processed = processed.replace(/\[\[([^\n]+?)\]\]/g, (_, title) => {
    const idx = noteLinkRefs.length;
    noteLinkRefs.push(title);
    return `MYNOTEPHLINK${idx}END`;
  });

  // ② 동영상 URL 임시 플레이스홀더 치환
  const videoEmbeds: string[] = [];
  processed = processed.replace(
    /(^|\s)(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^\s<>"&]*&)*v=[A-Za-z0-9_-]{11}|youtu\.be\/[A-Za-z0-9_-]{11}|youtube\.com\/shorts\/[A-Za-z0-9_-]{11}|vimeo\.com\/\d+|tv\.naver\.com\/v\/\d+|tv\.kakao\.com\/channel\/\d+\/cliplink\/\d+|www\.dailymotion\.com\/video\/[a-zA-Z0-9]+|drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/(?:view|preview))[^\s<>"]*)/g,
    (_, prefix, url) => {
      const idx = videoEmbeds.length;
      videoEmbeds.push(url.trim());
      return `${prefix}MYNOTEPHVIDEO${idx}END`;
    }
  );

  // ③ 수식 블록 및 인라인 치환
  const mathBlocks: { type: 'block' | 'inline'; expr: string }[] = [];
  processed = processed
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ type: 'block', expr: expr.trim() });
      return `MYNOTEPHMATHB${idx}END`;
    })
    .replace(/\$([^$\n]+?)\$/g, (_, expr) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ type: 'inline', expr: expr.trim() });
      return `MYNOTEPHMATHI${idx}END`;
    });

  // ④ 보호했던 코드 블록 복원 후 marked 파싱
  if (codeBlocks.length > 0) {
    processed = processed.replace(/MYNOTEPHCODE(\d+)END/g, (_, i) => codeBlocks[parseInt(i, 10)]);
  }
  const rawHtml: string = markedModule.parse(processed, { breaks: true });

  // ⑤ DOMPurify 살균을 먼저 수행 (사용자 마크다운에서 악성 스크립트/style 속성 원천 제거)
  let parsedBody: string = purifyModule.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'loading', 'decoding']
  });

  // 마크다운 본문 내 외부 링크(<a>) 클릭 시 PWA 단독 창이 이탈하지 않도록 새 탭 열기 속성 보장
  parsedBody = parsedBody.replace(/<a\s+(?![^>]*\btarget=)([^>]*\bhref=["']https?:\/\/[^>]*)>/gi, '<a target="_blank" rel="noopener noreferrer" $1>');

  // 마크다운 본문 이미지에 지연 로딩 및 비동기 디코딩 속성 보장
  parsedBody = parsedBody.replace(/<img\s+(?![^>]*\bloading=)/gi, '<img loading="lazy" decoding="async" ');

  // ⑥ KaTeX 수식 복원
  if (mathBlocks.length > 0) {
    try { await loadKatex(); } catch(e) { console.error('KaTeX load error', e); }
  }
  if (katexModule) {
    parsedBody = parsedBody.replace(/MYNOTEPHMATHB(\d+)END/g, (_: string, i: string) => {
      const expr = mathBlocks[parseInt(i, 10)]?.expr || '';
      try {
        return katexModule.renderToString(expr, { displayMode: true, throwOnError: false });
      } catch(e) { return `<code>$$${escHtml(expr)}$$</code>`; }
    });
    parsedBody = parsedBody.replace(/MYNOTEPHMATHI(\d+)END/g, (_: string, i: string) => {
      const expr = mathBlocks[parseInt(i, 10)]?.expr || '';
      try {
        return katexModule.renderToString(expr, { displayMode: false, throwOnError: false });
      } catch(e) { return `<code>$${escHtml(expr)}$</code>`; }
    });
  } else if (mathBlocks.length > 0) {
    parsedBody = parsedBody.replace(/MYNOTEPHMATHB(\d+)END/g, (_: string, i: string) => `<code>$$${escHtml(mathBlocks[parseInt(i, 10)]?.expr || '')}$$</code>`);
    parsedBody = parsedBody.replace(/MYNOTEPHMATHI(\d+)END/g, (_: string, i: string) => `<code>$${escHtml(mathBlocks[parseInt(i, 10)]?.expr || '')}$</code>`);
  }

  // ⑦ 동영상 iframe 복원
  parsedBody = parsedBody.replace(/MYNOTEPHVIDEO(\d+)END/g, (_: string, i: string) => {
    const idx = parseInt(i, 10);
    return buildVideoEmbed(videoEmbeds[idx], idx);
  });

  // ⑧ [[메모 제목]] 복원 (제목→메모 Map으로 O(1) 조회, 실제로 메모 링크가 있을 때만 지연 생성)
  if (noteLinkRefs.length > 0) {
    const titleMap: Map<string, any> | undefined =
      typeof appState.getNotesByTitle === 'function' ? appState.getNotesByTitle() : appState.notesByTitle;
    parsedBody = parsedBody.replace(/MYNOTEPHLINK(\d+)END/g, (_: string, i: string) => {
      const title = (noteLinkRefs[parseInt(i, 10)] || '').trim();
      const safeTitle = escHtml(title);
      const normTitle = title.replace(/\s+/g, ' ').toLowerCase();
      let found = titleMap
        ? (titleMap.get(title) || titleMap.get(normTitle))
        : undefined;
      if (!found && Array.isArray(appState.allNotesCache)) {
        found = appState.allNotesCache.find(
          (n: any) => (n.title || '').trim().replace(/\s+/g, ' ').toLowerCase() === normTitle
        );
      }
      if (found) {
        const cat = CATEGORIES[found.category];
        const icon = cat ? cat.icon : '📝';
        return `<button type="button" class="note-link" data-note-id="${escHtml(found.id)}" data-note-title="${safeTitle}" title="메모로 이동: ${safeTitle}">`
          + `<span class="note-link-icon" aria-hidden="true">${icon}</span>${safeTitle}</button>`;
      } else {
        return `<span class="note-link broken" title="연결된 메모 없음: ${safeTitle}">`
          + `<span class="note-link-icon" aria-hidden="true">📝</span>${safeTitle} <span style="font-size:0.8em;opacity:0.6">(?)</span></span>`;
      }
    });
  }

  return parsedBody;
}

// ─────────────────────────────────────────────
// 검색 텍스트 정제 및 영문·숫자 단어 경계 매칭 유틸리티
// ─────────────────────────────────────────────

const tokenBoundaryRegexCache = new Map<string, RegExp>();

/**
 * 마크다운 이미지(data URI 포함), 링크 URL, HTML 태그를 제거하여 순수 텍스트만 추출합니다.
 * (HTML 속성이나 URL/base64 문자열 내부의 영문·숫자가 우연히 검색되는 현상 방지)
 */
export function stripMarkupForSearch(raw: string): string {
  if (!raw) return '';
  return String(raw)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, ' $1 ')
    .replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExpStr(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────
// 한글 IME 조합 중간 상태(초성·연음 직전 받침) 호환 메모 제목 검색 유틸리티
// ─────────────────────────────────────────────
const HANGUL_CHO = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ',
  'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
];

// 종성 인덱스(1~27)가 다음 음절 초성으로 분리(연음)될 때: [앞 음절에 남는 종성 인덱스, 뒤 음절로 넘어가는 초성 문자]
const HANGUL_JONG_SPLIT: Record<number, [number, string]> = {
  1: [0, 'ㄱ'], 2: [0, 'ㄲ'], 3: [1, 'ㅅ'], 4: [0, 'ㄴ'], 5: [4, 'ㅈ'], 6: [4, 'ㅎ'],
  7: [0, 'ㄷ'], 8: [0, 'ㄹ'], 9: [8, 'ㄱ'], 10: [8, 'ㅁ'], 11: [8, 'ㅂ'], 12: [8, 'ㅅ'],
  13: [8, 'ㅌ'], 14: [8, 'ㅍ'], 15: [8, 'ㅎ'], 16: [0, 'ㅁ'], 17: [0, 'ㅂ'], 18: [17, 'ㅅ'],
  19: [0, 'ㅅ'], 20: [0, 'ㅆ'], 21: [0, 'ㅇ'], 22: [0, 'ㅈ'], 23: [0, 'ㅊ'], 24: [0, 'ㅋ'],
  25: [0, 'ㅌ'], 26: [0, 'ㅍ'], 27: [0, 'ㅎ']
};

const koreanImeRegexCache = new Map<string, RegExp>();

function choRangePattern(choChar: string): string {
  const choIdx = HANGUL_CHO.indexOf(choChar);
  if (choIdx === -1) return escapeRegExpStr(choChar);
  const start = String.fromCharCode(0xac00 + choIdx * 588);
  const end = String.fromCharCode(0xac00 + choIdx * 588 + 587);
  return `(?:${escapeRegExpStr(choChar)}|[${start}-${end}])`;
}

/**
 * 한글 타이핑 도중의 토큰(초성 단독, 받침 입력 전, 다음 글자 초성이 앞 받침에 임시 결합된 상태 등)을
 * 끊김 없이 매칭하는 정규식을 생성합니다.
 */
export function buildKoreanImeTokenRegex(token: string): RegExp {
  const cached = koreanImeRegexCache.get(token);
  if (cached) return cached;

  const chars = Array.from(token);
  let pattern = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isLast = i === chars.length - 1;
    const code = ch.charCodeAt(0);

    // 1) 호환 초성 자모(ㄱ~ㅎ): 어느 위치에 있든 해당 초성 음절 전체 매칭
    if (HANGUL_CHO.includes(ch)) {
      pattern += choRangePattern(ch);
      continue;
    }

    // 2) 마지막 글자가 완성형 한글 음절(가~힣)인 경우: IME 조합 중간 상태까지 포괄
    if (isLast && code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      const cho = Math.floor(offset / 588);
      const jung = Math.floor((offset % 588) / 28);
      const jong = offset % 28;

      if (jong === 0) {
        // 받침 없는 음절(예: '가' -> '가'~'갛' 모두 매칭하여 '강', '간' 등 타이핑 중 유지)
        const base = String.fromCharCode(0xac00 + cho * 588 + jung * 28);
        const endJong = String.fromCharCode(0xac00 + cho * 588 + jung * 28 + 27);
        pattern += `[${base}-${endJong}]`;
      } else {
        // 받침 있는 음절(예: '간' -> '간' 자체 또는 '가' + 초성 'ㄴ'[나-닣] 연음 대기 상태 매칭)
        const split = HANGUL_JONG_SPLIT[jong];
        if (split) {
          const [remainJong, nextCho] = split;
          const prevSyllable = String.fromCharCode(0xac00 + cho * 588 + jung * 28 + remainJong);
          pattern += `(?:${escapeRegExpStr(ch)}|${escapeRegExpStr(prevSyllable)}${choRangePattern(nextCho)})`;
        } else {
          pattern += escapeRegExpStr(ch);
        }
      }
      continue;
    }

    pattern += escapeRegExpStr(ch);
  }

  const re = new RegExp(pattern, 'i');
  if (koreanImeRegexCache.size > 250) {
    koreanImeRegexCache.clear();
  }
  koreanImeRegexCache.set(token, re);
  return re;
}

/**
 * 메모 링크 검색 시 한글 조합 중(초성·연음 중간 단계 포함)에도 엔터 없이 즉시 제목 매칭 점수 산출.
 * 매칭되지 않으면 0, 매칭되면 우선순위 점수(> 0)를 반환합니다.
 */
export function scoreKoreanTitleMatch(title: string, rawQuery: string): number {
  if (!title) return 0;
  const q = rawQuery.trim();
  if (!q) return 1;

  const titleTrimmed = title.trim();
  const titleLower = titleTrimmed.toLowerCase();
  const qLower = q.toLowerCase();

  if (titleLower === qLower) return 1000;
  if (titleLower.startsWith(qLower)) return 600;

  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 100;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const tokLower = tok.toLowerCase();
    const directIdx = titleLower.indexOf(tokLower);
    if (directIdx !== -1) {
      if (i === 0 && directIdx === 0) score += 400;
      else if (directIdx === 0 || /[\s[\]()/_-]/.test(titleLower[directIdx - 1])) score += 120;
      else score += 60;
      continue;
    }
    const imeRe = buildKoreanImeTokenRegex(tok);
    const m = imeRe.exec(titleTrimmed);
    if (!m) return 0;
    if (i === 0 && m.index === 0) score += 320;
    else if (m.index === 0 || /[\s[\]()/_-]/.test(titleTrimmed[m.index - 1])) score += 90;
    else score += 40;
  }
  return score;
}

/**
 * 메모 제목에서 검색어(한글 조합 중간 상태 포함)와 일치하는 구간을 <mark class="search-hl">로 안전하게 강조합니다.
 */
export function highlightKoreanTitleMatch(title: string, rawQuery: string): string {
  if (!title) return '';
  const q = rawQuery.trim();
  if (!q) return escHtml(title);

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return escHtml(title);

  // 첫 번째 매칭 토큰 기준으로 깔끔하게 하이라이트 (다중 토큰은 순차 범위 마킹)
  const ranges: [number, number][] = [];
  for (const tok of tokens) {
    const re = new RegExp(buildKoreanImeTokenRegex(tok).source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(title)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (ranges.length === 0) return escHtml(title);

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = ranges[i];
    if (cur[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }

  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out += escHtml(title.slice(cursor, s));
    out += `<mark class="search-hl">${escHtml(title.slice(s, e))}</mark>`;
    cursor = e;
  }
  if (cursor < title.length) out += escHtml(title.slice(cursor));
  return out;
}

/** 영문·숫자(기호 ._ - 포함)로만 이루어진 토큰인지 판별 */
export function isAlnumSearchToken(token: string): boolean {
  const t = token.trim();
  return t.length > 0 && /^[a-z0-9][a-z0-9._-]*$/i.test(t);
}

/**
 * 정제된 소문자 텍스트에서 검색 토큰이 매칭되는지 판별합니다.
 * - 영문/숫자 2글자 이하(예: a4, ai): 앞뒤 모두 영문/숫자가 붙지 않은 완전 단어 경계만 허용
 * - 영문/숫자 3글자 이상(예: cal, obs): 앞쪽 단어 경계만 적용하여 3글자만 쳐도 접두어 매칭으로 즉시 검색 가능
 *   (exactBoundary=true 전달 시 길이에 관계없이 완전 단어 일치 여부를 판별하여 순위 정렬에 활용)
 */
export function matchesSearchToken(
  plainTextLower: string,
  tokenLower: string,
  exactBoundary = false
): boolean {
  if (!plainTextLower || !tokenLower) return false;
  if (!isAlnumSearchToken(tokenLower)) {
    return plainTextLower.includes(tokenLower);
  }
  const useExact = exactBoundary || tokenLower.length < 3;
  const cacheKey = `${useExact ? 'E:' : 'P:'}${tokenLower}`;
  let re = tokenBoundaryRegexCache.get(cacheKey);
  if (!re) {
    const escaped = escapeRegExpStr(tokenLower);
    re = useExact
      ? new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`)
      : new RegExp(`(?<![a-z0-9])${escaped}`);
    if (tokenBoundaryRegexCache.size > 200) {
      tokenBoundaryRegexCache.clear();
    }
    tokenBoundaryRegexCache.set(cacheKey, re);
  }
  return re.test(plainTextLower);
}

/**
 * 정제된 소문자 텍스트에서 검색 토큰이 등장한 횟수(TF)를 반환합니다.
 * - 영문/숫자 토큰은 matchesSearchToken과 동일한 단어 경계 규칙을 적용합니다.
 * - 한글 등 비영문 토큰은 겹치지 않는 부분 문자열 출현 횟수를 고속 집계합니다.
 */
export function countSearchTokenOccurrences(
  plainTextLower: string,
  tokenLower: string,
  maxCount = 20
): number {
  if (!plainTextLower || !tokenLower) return 0;
  if (!isAlnumSearchToken(tokenLower)) {
    let count = 0;
    let pos = 0;
    while (count < maxCount) {
      const idx = plainTextLower.indexOf(tokenLower, pos);
      if (idx === -1) break;
      count++;
      pos = idx + tokenLower.length;
    }
    return count;
  }
  const useExact = tokenLower.length < 3;
  const cacheKey = `${useExact ? 'EG:' : 'PG:'}${tokenLower}`;
  let re = tokenBoundaryRegexCache.get(cacheKey);
  if (!re) {
    const escaped = escapeRegExpStr(tokenLower);
    re = useExact
      ? new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g')
      : new RegExp(`(?<![a-z0-9])${escaped}`, 'g');
    if (tokenBoundaryRegexCache.size > 200) {
      tokenBoundaryRegexCache.clear();
    }
    tokenBoundaryRegexCache.set(cacheKey, re);
  }
  re.lastIndex = 0;
  let count = 0;
  while (count < maxCount && re.exec(plainTextLower) !== null) {
    count++;
  }
  return count;
}
