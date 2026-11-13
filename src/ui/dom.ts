import { User } from 'firebase/auth';
import { CATEGORIES } from '../services/database';
import { escHtml } from '../utils/formatter';

export const $ = (id: string) => document.getElementById(id);

export function setDisplay(id: string, value: string) {
  const el = $(id);
  if (el) el.style.display = value;
}

// 태그 칩 HTML (클릭은 이벤트 위임으로 처리 — 인라인 onclick 미사용)
export function tagChipHtml(category: string, tag: string, className: string, style = '') {
  return `<span class="${className}" data-tag-link data-cat="${escHtml(category)}" data-tag="${escHtml(tag)}"${style ? ` style="${style}"` : ''}>#${escHtml(tag)}</span>`;
}

// 위임된 클릭 이벤트에서 태그 칩을 처리. 처리했으면 true
export function handleTagLink(
  e: Event,
  onOpenList: (catId: string, tag: string | null) => void
): boolean {
  const el = (e.target as HTMLElement).closest('[data-tag-link]') as HTMLElement | null;
  if (!el) return false;
  e.preventDefault();
  e.stopPropagation();
  if (el.dataset.cat) onOpenList(el.dataset.cat, el.dataset.tag || null);
  return true;
}

export function insertAtCursor(ta: HTMLTextAreaElement, text: string) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + text.length;
  ta.focus();
}

export function renderUserBar(user: Pick<User, 'displayName' | 'email' | 'photoURL'>) {
  const av = $('user-bar-avatar');
  const nameEl = $('user-bar-name');
  if (nameEl) nameEl.textContent = user.displayName || user.email || '';
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

/**
 * CATEGORIES 상수를 단일 진실 공급원(SSOT)으로 사용하여 홈 화면 폴더 목록을 렌더링합니다.
 * 기존 카운트 값이 있으면 함께 유지합니다.
 */
export function renderFoldersList(counts: Record<string, number> = {}) {
  const listEl = $('folders-list');
  if (!listEl) return;
  listEl.innerHTML = Object.entries(CATEGORIES)
    .map(([catId, info]) => {
      const count = Math.max(0, counts[catId] || 0);
      return `<div class="folder-row" data-cat="${escHtml(catId)}">
        <span class="folder-name">${escHtml(info.name)}</span>
        <span class="folder-meta"><span class="folder-count" id="cnt-${escHtml(catId)}">${count}</span> <span class="folder-arrow">›</span></span>
      </div>`;
    })
    .join('');
}
