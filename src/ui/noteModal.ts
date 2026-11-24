import { doc, Timestamp, updateDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { appState } from '../state';
import {
  CATEGORIES,
  SUB_TAGS,
  getNoteCategories,
  getNoteTags,
  createNoteWithIndex,
  updateNoteWithIndex,
  updateNoteIndexEmbeddingMeta
} from '../services/database';
import { escHtml, scoreKoreanTitleMatch, highlightKoreanTitleMatch } from '../utils/formatter';
import { collectImagePaths } from '../utils/imagePaths';
import { showToast } from '../utils/toast';
import { openPinModal, syncPinFromUserMeta, getStoredLockPin } from './pinModal';
import { Note, NoteIndexItem } from '../types';
import { $, insertAtCursor, openDialog, closeDialog, isDialogOpen } from './dom';

export const NOTE_DRAFT_KEY = 'mynote_new_note_draft_v1';
export const NOTE_EDIT_DRAFT_PREFIX = 'mynote_edit_draft_v1_';

export interface NoteModalDeps {
  getAi: () => Promise<typeof import('../services/ai')>;
  getImage: () => Promise<typeof import('../utils/image')>;
  ensureSearchIndexReady: () => boolean;
  ensureAllNotesCache: () => void;
  isNotesLoaded: () => boolean;
  openList: (catId: string, tag?: string | null) => void;
  openDetail: (note: Note, from?: string) => Promise<void>;
  getDetailFrom: () => string;
  onCacheNoteUpdated: (
    noteId: string,
    updated: Partial<NoteIndexItem> & { body?: string; locked?: boolean; title?: string },
    detailFrom: string
  ) => void;
}

export interface NoteModalApi {
  openAddModal: () => void;
  openEditModal: (note: Note) => void;
  closeModal: (saved?: boolean) => void;
  requestCloseModal: (saved?: boolean) => boolean;
  closeNoteLinkModal: () => void;
  isNoteLinkModalOpen: () => boolean;
  refreshNoteLinkListIfOpen: () => void;
  clearDraftTimer: () => void;
  invalidateEmbeddingPipeline: (noteId: string) => void;
}

interface NoteFormSnapshot {
  title: string;
  body: string;
  keywords: string;
  pinned: boolean;
  locked: boolean;
  categories: string[];
  tags: string[];
}

export function initNoteModalModule(deps: NoteModalDeps): NoteModalApi {
  const koCollator = new Intl.Collator('ko');
  const noteLinkModal = $('note-link-modal') as HTMLElement | null;
  const noteLinkSearchInput = $('note-link-search-input') as HTMLInputElement | null;
  const noteLinkSearchClear = $('note-link-search-clear') as HTMLButtonElement | null;
  const noteLinkList = $('note-link-list') as HTMLElement | null;
  const noteCategoryOptionsEl = $('note-category-options') as HTMLElement | null;
  const catMultiselectTrigger = $('cat-multiselect-trigger') as HTMLButtonElement | null;
  const catMultiselectLabel = $('cat-multiselect-label') as HTMLElement | null;
  const catMultiselectArrow = $('cat-multiselect-arrow') as HTMLElement | null;
  const catMultiselectPanel = $('cat-multiselect-panel') as HTMLElement | null;
  const inlineImgBtn = $('inline-img-btn') as HTMLButtonElement | null;
  const inlineImgInput = $('inline-img-input') as HTMLInputElement | null;
  const noteBodyEl = $('note-body') as HTMLTextAreaElement | null;

  let noteLinkRenderLimit = 80;
  let activeNoteLinkIndex = -1;
  let visibleNoteLinkTitles: string[] = [];
  let suppressFocusRestoreUntil = 0;
  let lastKnownBodySelection = { start: 0, end: 0, scrollTop: 0 };
  let hasKnownBodySelection = false;
  let savedNoteLinkPosition: {
    modalScrollTop: number;
    textareaScrollTop: number;
    selectionStart: number;
    selectionEnd: number;
  } | null = null;
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let modalSessionToken = 0;
  let initialNoteFormSnapshot: NoteFormSnapshot | null = null;
  let sessionUploadedInlineImages: { url: string; path: string }[] = [];
  let activeImageUploadCount = 0; // 연속 붙여넣기/업로드 시 버튼 상태 경합 방지 카운터
  let isSaving = false;
  let recognition: any = null;
  let isRecording = false;

  const embeddingPipelineSeqMap = new Map<string, number>();
  const deletedNoteIds = new Set<string>();

  function invalidateEmbeddingPipeline(noteId: string) {
    deletedNoteIds.add(noteId);
    embeddingPipelineSeqMap.set(noteId, (embeddingPipelineSeqMap.get(noteId) || 0) + 1);
  }

  function getSelectedCategoriesFromUI(): string[] {
    if (!noteCategoryOptionsEl) return appState.currentCat ? [appState.currentCat] : [Object.keys(CATEGORIES)[0]];
    return Array.from(noteCategoryOptionsEl.querySelectorAll<HTMLInputElement>('input.cat-option-cb:checked'))
      .map(cb => cb.value)
      .filter(v => v in CATEGORIES);
  }

  function setCategoryPanelOpen(open: boolean) {
    if (!catMultiselectPanel || !catMultiselectTrigger || !catMultiselectArrow) return;
    catMultiselectPanel.style.display = open ? 'block' : 'none';
    catMultiselectTrigger.classList.toggle('open', open);
    catMultiselectTrigger.setAttribute('aria-expanded', String(open));
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

  function setLockToggleUI(isLocked: boolean) {
    const cb = $('note-locked') as HTMLInputElement | null;
    const wrap = $('lock-toggle-wrap');
    if (cb) cb.checked = isLocked;
    if (wrap) {
      wrap.classList.toggle('active', isLocked);
      wrap.title = isLocked ? '잠금됨 (클릭 시 해제)' : '잠금 설정';
    }
  }

  function setPinToggleUI(isPinned: boolean) {
    const cb = $('note-pinned') as HTMLInputElement | null;
    const wrap = $('pin-toggle-wrap');
    if (cb) cb.checked = isPinned;
    if (wrap) {
      wrap.classList.toggle('active', isPinned);
      wrap.title = isPinned ? '핀 고정됨 (클릭 시 해제)' : '핀 고정';
    }
  }

  function fillNoteForm(title: string, body: string, keywords: string, modalTitleText: string) {
    const titleEl = $('note-title') as HTMLInputElement | null;
    const bodyEl = $('note-body') as HTMLTextAreaElement | null;
    const keywordsEl = $('note-keywords') as HTMLInputElement | null;
    const modalTitle = $('modal-title');
    if (titleEl) titleEl.value = title;
    if (bodyEl) bodyEl.value = body;
    if (keywordsEl) keywordsEl.value = keywords;
    if (modalTitle) modalTitle.textContent = modalTitleText;
  }

  function takeCurrentFormSnapshot(): NoteFormSnapshot {
    const titleEl = $('note-title') as HTMLInputElement | null;
    const bodyEl = $('note-body') as HTMLTextAreaElement | null;
    const keywordsEl = $('note-keywords') as HTMLInputElement | null;
    const pinnedEl = $('note-pinned') as HTMLInputElement | null;
    const lockedEl = $('note-locked') as HTMLInputElement | null;
    return {
      title: (titleEl?.value || '').trim(),
      body: (bodyEl?.value || '').trim(),
      keywords: (keywordsEl?.value || '').trim(),
      pinned: !!pinnedEl?.checked,
      locked: !!lockedEl?.checked,
      categories: getSelectedCategoriesFromUI(),
      tags: getSelectedTagsFromUI()
    };
  }

  function isSnapshotDirty(current: NoteFormSnapshot): boolean {
    const init = initialNoteFormSnapshot;
    if (!init) return false;
    if (sessionUploadedInlineImages.length > 0) return true;
    if (current.title !== init.title) return true;
    if (current.body !== init.body) return true;
    if (current.keywords !== init.keywords) return true;
    if (current.pinned !== init.pinned) return true;
    if (current.locked !== init.locked) return true;
    if (init.categories.slice().sort().join(',') !== current.categories.slice().sort().join(',')) return true;
    if (init.tags.slice().sort().join(',') !== current.tags.slice().sort().join(',')) return true;
    return false;
  }

  function isNoteFormDirty(): boolean {
    const modal = $('note-modal');
    if (!modal || !isDialogOpen(modal) || !initialNoteFormSnapshot) return false;
    if (sessionUploadedInlineImages.length > 0) return true;
    return isSnapshotDirty(takeCurrentFormSnapshot());
  }

  function getActiveDraftKey(noteId?: string | null): string {
    const targetId = noteId !== undefined ? noteId : appState.editingNoteId;
    return targetId ? `${NOTE_EDIT_DRAFT_PREFIX}${targetId}` : NOTE_DRAFT_KEY;
  }

  function pruneOldEditDrafts(keepKey?: string) {
    try {
      const editKeys = Object.keys(localStorage).filter(
        k => k.startsWith(NOTE_EDIT_DRAFT_PREFIX) && k !== keepKey
      );
      if (editKeys.length > 4) {
        for (const k of editKeys.slice(0, editKeys.length - 4)) {
          localStorage.removeItem(k);
        }
      }
    } catch {}
  }

  function clearDraft(noteId?: string | null) {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    try {
      localStorage.removeItem(getActiveDraftKey(noteId));
    } catch {}
  }

  function flushDraftNow() {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    const modal = $('note-modal');
    if (!modal || !isDialogOpen(modal)) return;
    try {
      const key = getActiveDraftKey();
      const snap = takeCurrentFormSnapshot();
      // 잠금 메모는 보안을 위해 로컬 임시저장에 남기지 않음
      if (snap.locked) {
        localStorage.removeItem(key);
        return;
      }
      if (appState.editingNoteId) {
        if (isSnapshotDirty(snap)) {
          pruneOldEditDrafts(key);
          localStorage.setItem(key, JSON.stringify(snap));
        } else {
          localStorage.removeItem(key);
        }
      } else {
        if (snap.title || snap.body || snap.keywords) {
          localStorage.setItem(key, JSON.stringify(snap));
        } else {
          localStorage.removeItem(key);
        }
      }
    } catch {}
  }

  function scheduleSaveDraft() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    // 타이핑 중 동기 localStorage 쓰기 빈도를 대폭 줄여 모바일 입력/스크롤 60fps 유지
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      flushDraftNow();
    }, 2500);
  }

  let lastFocusedFieldId: string | null = null;
  let savedEditCursor: {
    modalScrollTop: number;
    fieldId: string | null;
    selectionStart: number;
    selectionEnd: number;
    textareaScrollTop: number;
  } | null = null;
  let lastViewportHeight = typeof window !== 'undefined' ? (window.visualViewport?.height || window.innerHeight) : 0;

  ['note-title', 'note-body', 'note-keywords'].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('focus', () => {
        lastFocusedFieldId = id;
      });
    }
  });

  // 본문(#note-body)의 마지막 커서/스크롤 위치를 상시 추적하여 툴바 버튼 클릭 시에도 정확한 삽입 위치 보장
  if (noteBodyEl) {
    const syncBodySelection = () => {
      lastKnownBodySelection = {
        start: noteBodyEl.selectionStart ?? 0,
        end: noteBodyEl.selectionEnd ?? 0,
        scrollTop: noteBodyEl.scrollTop
      };
      hasKnownBodySelection = true;
    };
    ['focus', 'click', 'keyup', 'mouseup', 'select', 'input', 'touchend'].forEach(evt => {
      noteBodyEl.addEventListener(evt, syncBodySelection, { passive: true });
    });
  }

  // 미러 엘리먼트를 사용해 textarea 내 특정 문자 인덱스의 정확한 픽셀 Y좌표·줄 높이를 측정
  let caretMirrorEl: HTMLDivElement | null = null;
  function getTextareaCaretMetrics(ta: HTMLTextAreaElement, charIndex: number): { top: number; lineHeight: number } {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return { top: 0, lineHeight: 24 };
    }
    if (!caretMirrorEl) {
      caretMirrorEl = document.createElement('div');
      caretMirrorEl.setAttribute('aria-hidden', 'true');
      caretMirrorEl.style.position = 'fixed';
      caretMirrorEl.style.top = '-9999px';
      caretMirrorEl.style.left = '-9999px';
      caretMirrorEl.style.visibility = 'hidden';
      caretMirrorEl.style.pointerEvents = 'none';
      caretMirrorEl.style.whiteSpace = 'pre-wrap';
      caretMirrorEl.style.wordWrap = 'break-word';
      caretMirrorEl.style.overflowWrap = 'break-word';
      document.body.appendChild(caretMirrorEl);
    }
    const cs = window.getComputedStyle(ta);
    caretMirrorEl.style.boxSizing = cs.boxSizing;
    caretMirrorEl.style.width = `${ta.clientWidth}px`;
    caretMirrorEl.style.padding = cs.padding;
    caretMirrorEl.style.border = 'none';
    caretMirrorEl.style.font = cs.font;
    caretMirrorEl.style.fontSize = cs.fontSize;
    caretMirrorEl.style.fontFamily = cs.fontFamily;
    caretMirrorEl.style.fontWeight = cs.fontWeight;
    caretMirrorEl.style.lineHeight = cs.lineHeight;
    caretMirrorEl.style.letterSpacing = cs.letterSpacing;

    const safeIdx = Math.max(0, Math.min(charIndex, ta.value.length));
    caretMirrorEl.textContent = ta.value.slice(0, safeIdx);
    const marker = document.createElement('span');
    marker.textContent = ta.value.slice(safeIdx, safeIdx + 1) || '\u200b';
    caretMirrorEl.appendChild(marker);

    const parsedLh = parseFloat(cs.lineHeight);
    const lineHeight = Number.isFinite(parsedLh) && parsedLh > 0 ? parsedLh : (marker.offsetHeight || 24);
    const top = marker.offsetTop;
    caretMirrorEl.textContent = '';
    return { top, lineHeight };
  }

  /**
   * 390px 이상인 #note-body 전체를 scrollIntoView('center')로 튀게 하지 않고,
   * 실제 커서(caret) 줄이 가시 영역 밖일 때만 필요한 만큼만 정밀 스크롤합니다.
   */
  function scrollTextareaCaretIntoView(
    modalBox: HTMLElement,
    ta: HTMLTextAreaElement,
    caretPos: number,
    restoreScroll?: { modalScrollTop: number; textareaScrollTop: number } | null
  ) {
    if (restoreScroll) {
      modalBox.scrollTop = restoreScroll.modalScrollTop;
      ta.scrollTop = restoreScroll.textareaScrollTop;
    }

    const { top: caretTop, lineHeight } = getTextareaCaretMetrics(ta, caretPos);

    // 1) textarea 자체 내부 스크롤 보정
    if (ta.scrollHeight > ta.clientHeight + 2) {
      const pad = 12;
      if (caretTop < ta.scrollTop + pad) {
        ta.scrollTop = Math.max(0, caretTop - pad);
      } else if (caretTop + lineHeight > ta.scrollTop + ta.clientHeight - pad) {
        ta.scrollTop = Math.max(0, caretTop + lineHeight - ta.clientHeight + pad);
      }
    }

    // 2) 모달 스크롤 보정 (커서 줄이 이미 화면 안에 보이면 0px 이동 — 화면 점프 방지)
    const boxRect = modalBox.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    const footerEl = $('note-modal-footer');
    const footerHeight = footerEl ? footerEl.offsetHeight : 76;
    const visibleTop = boxRect.top + 18;
    const visibleBottom = boxRect.bottom - footerHeight - 14;

    if (visibleBottom <= visibleTop) return;

    const caretViewportTop = taRect.top + (caretTop - ta.scrollTop);
    const caretViewportBottom = caretViewportTop + lineHeight;

    if (caretViewportBottom > visibleBottom) {
      modalBox.scrollTop += (caretViewportBottom - visibleBottom) + 18;
    } else if (caretViewportTop < visibleTop) {
      modalBox.scrollTop = Math.max(0, modalBox.scrollTop - (visibleTop - caretViewportTop) - 18);
    }
  }

  function captureModalEditPosition() {
    if (isDialogOpen(noteLinkModal) || Date.now() < suppressFocusRestoreUntil) return;
    const overlay = $('note-modal');
    if (!overlay || !isDialogOpen(overlay)) return;
    const modalBox = overlay.querySelector('.modal') as HTMLElement | null;
    const activeId = (document.activeElement as HTMLElement | null)?.id || lastFocusedFieldId;
    const fieldId = activeId === 'note-body' || activeId === 'note-title' || activeId === 'note-keywords'
      ? activeId
      : lastFocusedFieldId;
    savedEditCursor = {
      modalScrollTop: modalBox ? modalBox.scrollTop : 0,
      fieldId,
      selectionStart: noteBodyEl ? (noteBodyEl.selectionStart ?? 0) : 0,
      selectionEnd: noteBodyEl ? (noteBodyEl.selectionEnd ?? 0) : 0,
      textareaScrollTop: noteBodyEl ? noteBodyEl.scrollTop : 0
    };
  }

  function ensureActiveFieldVisibleInModal(modalBox: HTMLElement, fieldEl: HTMLElement, preferEnd = false) {
    if (fieldEl instanceof HTMLTextAreaElement) {
      const pos = preferEnd ? fieldEl.value.length : (fieldEl.selectionEnd ?? fieldEl.value.length);
      scrollTextareaCaretIntoView(modalBox, fieldEl, pos);
      return;
    }
    const boxRect = modalBox.getBoundingClientRect();
    const fieldRect = fieldEl.getBoundingClientRect();
    const footerEl = $('note-modal-footer');
    const footerHeight = footerEl ? footerEl.offsetHeight : 76;
    const visibleBottom = boxRect.bottom - footerHeight;
    if (fieldRect.bottom < boxRect.top + 20 || fieldRect.top > visibleBottom - 20) {
      fieldEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function restoreModalEditPosition() {
    if (isDialogOpen(noteLinkModal) || Date.now() < suppressFocusRestoreUntil) return;
    const overlay = $('note-modal');
    if (!overlay || !isDialogOpen(overlay) || !savedEditCursor) return;
    const snapshot = savedEditCursor;
    savedEditCursor = null; // 1회 복원 후 즉시 소모하여 이후 포커스 이벤트 시 유령 점프 방지
    const modalBox = overlay.querySelector('.modal') as HTMLElement | null;

    syncNoteModalViewportHeight();
    requestAnimationFrame(() => {
      if (!isDialogOpen(overlay) || isDialogOpen(noteLinkModal) || Date.now() < suppressFocusRestoreUntil) return;
      if (snapshot.fieldId === 'note-body' && noteBodyEl) {
        try {
          noteBodyEl.focus({ preventScroll: true });
          const len = noteBodyEl.value.length;
          const s = Math.min(snapshot.selectionStart, len);
          const e = Math.min(snapshot.selectionEnd, len);
          noteBodyEl.setSelectionRange(s, e);
          if (modalBox) {
            scrollTextareaCaretIntoView(modalBox, noteBodyEl, e, {
              modalScrollTop: snapshot.modalScrollTop,
              textareaScrollTop: snapshot.textareaScrollTop
            });
          }
        } catch {}
      } else if (snapshot.fieldId) {
        if (modalBox && snapshot.modalScrollTop > 0) {
          modalBox.scrollTop = snapshot.modalScrollTop;
        }
        const el = $(snapshot.fieldId) as HTMLInputElement | null;
        if (el) {
          try { el.focus({ preventScroll: true }); } catch {}
          if (modalBox) ensureActiveFieldVisibleInModal(modalBox, el);
        }
      }
    });
  }

  // 앱 전환(다른 앱에서 텍스트/이미지 복사 후 복귀) 시 커서와 스크롤 위치를 보존·복원
  window.addEventListener('blur', () => {
    captureModalEditPosition();
  });

  window.addEventListener('focus', () => {
    if (savedEditCursor) {
      restoreModalEditPosition();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      captureModalEditPosition();
      if (draftSaveTimer) {
        flushDraftNow();
      }
    } else if (document.visibilityState === 'visible') {
      if (savedEditCursor) {
        restoreModalEditPosition();
      }
    }
  });

  function resetInlineImgBtn(force = false) {
    if (force) activeImageUploadCount = 0;
    if (!inlineImgBtn || activeImageUploadCount > 0) return;
    inlineImgBtn.textContent = '이미지 삽입';
    inlineImgBtn.classList.remove('uploading');
    inlineImgBtn.disabled = false;
  }

  function setInlineImgBtnUploading() {
    if (!inlineImgBtn) return;
    inlineImgBtn.textContent = activeImageUploadCount > 1
      ? `업로드(${activeImageUploadCount})`
      : '업로드중';
    inlineImgBtn.classList.add('uploading');
    inlineImgBtn.disabled = true;
  }

  function stopRecording() {
    if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    isRecording = false;
    const vb = $('voice-btn');
    if (vb) {
      vb.textContent = '음성';
      vb.classList.remove('recording');
    }
  }

  let lastAppliedVvHeight = 0;
  let lastAppliedVvOffsetTop = -1;
  let lastAppliedLinkVvHeight = 0;
  let lastAppliedLinkVvOffsetTop = -1;

  function syncNoteModalViewportHeight(force = false) {
    const vv = window.visualViewport;
    if (!vv) return;

    // 1) 메모 링크 검색 모달이 열려 있을 때: 가시 뷰포트(키보드 위쪽 영역) 상단에 정확히 맞춤
    if (noteLinkModal && isDialogOpen(noteLinkModal)) {
      const nextH = Math.floor(vv.height);
      const nextTop = Math.floor(vv.offsetTop);
      if (force || Math.abs(nextH - lastAppliedLinkVvHeight) >= 1 || Math.abs(nextTop - lastAppliedLinkVvOffsetTop) >= 1) {
        lastAppliedLinkVvHeight = nextH;
        lastAppliedLinkVvOffsetTop = nextTop;
        noteLinkModal.style.height = `${nextH}px`;
        noteLinkModal.style.top = `${nextTop}px`;
        noteLinkModal.style.bottom = 'auto';
        const linkBox = noteLinkModal.querySelector('.note-link-modal') as HTMLElement | null;
        if (linkBox) {
          linkBox.style.maxHeight = `${Math.max(180, nextH - 16)}px`;
        }
      }
    }

    // 2) 하위 메모 작성·수정 모달도 항상 최신 뷰포트 치수로 동기화 (링크 모달 닫힐 때 뒤늦은 점프 방지)
    const overlay = $('note-modal');
    if (!overlay || !isDialogOpen(overlay)) return;

    if (
      !force &&
      Math.abs(vv.height - lastAppliedVvHeight) < 1 &&
      Math.abs(vv.offsetTop - lastAppliedVvOffsetTop) < 1
    ) {
      return;
    }
    lastAppliedVvHeight = vv.height;
    lastAppliedVvOffsetTop = vv.offsetTop;

    const modalBox = overlay.querySelector('.modal') as HTMLElement | null;
    const prevHeight = lastViewportHeight;
    const prevScrollTop = modalBox ? modalBox.scrollTop : 0;
    lastViewportHeight = vv.height;

    overlay.style.height = `${vv.height}px`;
    overlay.style.top = `${vv.offsetTop}px`;
    overlay.style.bottom = 'auto';
    if (modalBox) {
      modalBox.style.maxHeight = `${Math.max(240, Math.floor(vv.height - 12))}px`;
      if (prevScrollTop > 0 && modalBox.scrollTop === 0) {
        modalBox.scrollTop = prevScrollTop;
      }
      // 메모 링크 모달이 닫혀 있고 키보드가 새로 올라왔을 때만 실제 커서 줄 가시성 보정
      if (!isDialogOpen(noteLinkModal) && prevHeight - vv.height > 80) {
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && (activeEl.id === 'note-body' || activeEl.id === 'note-title' || activeEl.id === 'note-keywords')) {
          requestAnimationFrame(() => ensureActiveFieldVisibleInModal(modalBox, activeEl));
        }
      }
    }
  }

  function resetNoteLinkModalViewportStyle() {
    lastAppliedLinkVvHeight = 0;
    lastAppliedLinkVvOffsetTop = -1;
    if (!noteLinkModal) return;
    noteLinkModal.style.height = '';
    noteLinkModal.style.top = '';
    noteLinkModal.style.bottom = '';
    const linkBox = noteLinkModal.querySelector('.note-link-modal') as HTMLElement | null;
    if (linkBox) linkBox.style.maxHeight = '';
  }

  function resetNoteModalViewportStyle() {
    lastAppliedVvHeight = 0;
    lastAppliedVvOffsetTop = -1;
    resetNoteLinkModalViewportStyle();
    const overlay = $('note-modal');
    if (!overlay) return;
    overlay.style.height = '';
    overlay.style.top = '';
    overlay.style.bottom = '';
    const modalBox = overlay.querySelector('.modal') as HTMLElement | null;
    if (modalBox) modalBox.style.maxHeight = '';
  }

  if (typeof window !== 'undefined' && window.visualViewport) {
    const onViewportChange = () => syncNoteModalViewportHeight(false);
    window.visualViewport.addEventListener('resize', onViewportChange, { passive: true });
    window.visualViewport.addEventListener('scroll', onViewportChange, { passive: true });
  }

  function showNoteModalOverlay() {
    hasKnownBodySelection = false;
    lastKnownBodySelection = { start: 0, end: 0, scrollTop: 0 };
    openDialog('note-modal');
    syncNoteModalViewportHeight(true);
    const modalBox = $('note-modal')?.querySelector('.modal') as HTMLElement | null;
    if (modalBox) modalBox.scrollTop = 0;
  }

  function closeModal(saved = false) {
    modalSessionToken++;
    initialNoteFormSnapshot = null;
    savedEditCursor = null;
    savedNoteLinkPosition = null;
    hasKnownBodySelection = false;
    lastFocusedFieldId = null;
    closeDialog('note-modal');
    resetNoteModalViewportStyle();
    stopRecording();
    resetInlineImgBtn(true);
    if (!saved && sessionUploadedInlineImages.length > 0) {
      const pathsToDelete = sessionUploadedInlineImages.map(i => i.path || i.url);
      sessionUploadedInlineImages = [];
      deps.getImage().then(m => m.deleteImagesFromStorage(pathsToDelete)).catch(console.error);
    }
  }

  function requestCloseModal(saved = false): boolean {
    if (!saved && isNoteFormDirty()) {
      const leave = confirm('작성 중인 내용이 저장되지 않았습니다. 닫으시겠습니까?');
      if (!leave) return false;
    }
    clearDraft();
    closeModal(saved);
    return true;
  }

  function openAddModal() {
    modalSessionToken++;
    appState.editingNoteId = null;
    appState.existingImages = [];
    sessionUploadedInlineImages = [];
    resetInlineImgBtn(true);
    const catId = appState.currentCat || Object.keys(CATEGORIES)[0];

    try {
      const rawDraft = localStorage.getItem(NOTE_DRAFT_KEY);
      if (rawDraft) {
        const draft = JSON.parse(rawDraft);
        if (draft && (draft.title || draft.body || draft.keywords)) {
          if (confirm('이전에 작성 중이던 임시 저장 메모가 있습니다. 복구할까요?')) {
            fillNoteForm(draft.title || '', draft.body || '', draft.keywords || '', '새 메모 (임시저장 복구)');
            const draftCats = Array.isArray(draft.categories) && draft.categories.length > 0 ? draft.categories : [catId];
            renderCategorySelect(draftCats);
            renderTagOptions(draftCats, draft.tags || []);
            setPinToggleUI(!!draft.pinned);
            setLockToggleUI(!!draft.locked);
            initialNoteFormSnapshot = takeCurrentFormSnapshot();
            showNoteModalOverlay();
            return;
          } else {
            clearDraft();
          }
        }
      }
    } catch {
      clearDraft();
    }

    fillNoteForm('', '', '', `새 메모 — ${CATEGORIES[catId]?.name || ''}`);
    renderCategorySelect(catId);
    renderTagOptions(catId, appState.currentTag || null);
    setPinToggleUI(false);
    setLockToggleUI(false);
    initialNoteFormSnapshot = takeCurrentFormSnapshot();
    showNoteModalOverlay();
  }

  function openEditModal(note: Note) {
    modalSessionToken++;
    appState.editingNoteId = note.id || null;
    appState.existingImages = (note.images || []).map(i => ({ ...i }));
    sessionUploadedInlineImages = [];
    resetInlineImgBtn(true);

    // 구버전 메모 중 note.images에만 보관되고 본문(note.body)에 마크다운이 없던 첨부 이미지가 있는 경우,
    // 사용자가 '메모 수정'을 열었을 때 본문 하단에 자동으로 ![이미지](url) 마크다운을 통합 삽입하여
    // 이후 저장 시 화면 중앙 및 최적화된 마크다운 이미지로 일관되게 렌더링되도록 보정
    let initialBody = note.body || '';
    const unreferencedExisting = (note.images || []).filter(i => i?.url && !initialBody.includes(i.url));
    if (unreferencedExisting.length > 0) {
      const inlineAppend = unreferencedExisting
        .map(i => `\n\n![이미지](${i.url})`)
        .join('');
      initialBody = (initialBody ? initialBody.trimEnd() : '') + inlineAppend + '\n';
    }

    fillNoteForm(note.title || '', initialBody, note.keywords || '', '메모 수정');
    const editCats = getNoteCategories(note);
    renderCategorySelect(editCats);
    renderTagOptions(editCats, getNoteTags(note));

    setPinToggleUI(!!note.pinned);
    setLockToggleUI(!!note.locked);
    initialNoteFormSnapshot = takeCurrentFormSnapshot();

    // 기존 메모 수정 중 비정상 종료된 임시저장본이 있다면 복구 제안
    if (note.id && !note.locked) {
      try {
        const rawEditDraft = localStorage.getItem(getActiveDraftKey(note.id));
        if (rawEditDraft) {
          const draft = JSON.parse(rawEditDraft);
          if (draft && (draft.title !== undefined || draft.body !== undefined)) {
            if (confirm('이 메모의 저장되지 않은 수정 내용이 있습니다. 복구할까요?')) {
              fillNoteForm(draft.title || '', draft.body || '', draft.keywords || '', '메모 수정 (임시저장 복구)');
              const draftCats = Array.isArray(draft.categories) && draft.categories.length > 0 ? draft.categories : editCats;
              renderCategorySelect(draftCats);
              renderTagOptions(draftCats, Array.isArray(draft.tags) ? draft.tags : getNoteTags(note));
              setPinToggleUI(!!draft.pinned);
              setLockToggleUI(!!draft.locked);
            } else {
              clearDraft(note.id);
            }
          }
        }
      } catch {
        clearDraft(note.id);
      }
    }

    showNoteModalOverlay();
  }

  // ── 메모 링크 삽입 모달
  function getSortedNotesByTitle(): NoteIndexItem[] {
    if (!appState.sortedNotesByTitle) {
      appState.sortedNotesByTitle = (appState.allNotesCache || [])
        .slice()
        .sort((a, b) => koCollator.compare(a.title || '', b.title || ''));
    }
    return appState.sortedNotesByTitle;
  }

  function syncActiveNoteLinkItemUI(scrollIntoView = false) {
    if (!noteLinkList) return;
    const items = noteLinkList.querySelectorAll<HTMLElement>('.note-link-item');
    items.forEach((el, idx) => {
      const isAct = idx === activeNoteLinkIndex;
      el.classList.toggle('active', isAct);
      if (isAct && scrollIntoView) {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function renderNoteLinkList(rawKeyword: string, resetScroll = true) {
    if (!noteLinkList) return;
    const kw = rawKeyword.trim();
    if (noteLinkSearchClear) {
      noteLinkSearchClear.style.display = rawKeyword.length > 0 ? 'block' : 'none';
    }

    const allNotes = appState.allNotesCache || [];
    if (allNotes.length === 0 && !deps.isNotesLoaded()) {
      visibleNoteLinkTitles = [];
      activeNoteLinkIndex = -1;
      noteLinkList.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-light);font-size:13px">⏳ 메모 목록을 불러오는 중...</div>`;
      return;
    }

    const baseSorted = getSortedNotesByTitle();
    let filtered: NoteIndexItem[];

    if (!kw) {
      filtered = baseSorted.filter(n => n.id !== appState.editingNoteId);
    } else {
      const scored: { note: NoteIndexItem; score: number }[] = [];
      for (const n of baseSorted) {
        if (n.id === appState.editingNoteId) continue;
        const s = scoreKoreanTitleMatch(n.title || '', kw);
        if (s > 0) {
          scored.push({ note: n, score: s });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      filtered = scored.map(x => x.note);
    }

    if (filtered.length === 0) {
      visibleNoteLinkTitles = [];
      activeNoteLinkIndex = -1;
      noteLinkList.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-light);font-size:13px">`
        + (kw ? `🔍 "${escHtml(kw)}" 일치하는 메모 제목이 없어요` : '📝 메모가 없어요') + `</div>`;
      return;
    }

    const visible = filtered.slice(0, noteLinkRenderLimit);
    visibleNoteLinkTitles = visible.map(n => n.title || '');
    if (activeNoteLinkIndex >= visible.length) {
      activeNoteLinkIndex = -1;
    }

    const itemsHtml = visible.map((note, idx) => {
      const noteCats = getNoteCategories(note);
      const titleHtml = kw ? highlightKoreanTitleMatch(note.title || '', kw) : escHtml(note.title || '');
      const activeCls = idx === activeNoteLinkIndex ? ' active' : '';
      return `<button type="button" class="note-link-item${activeCls}" data-title="${escHtml(note.title)}">`
        + `<span class="note-link-item-cat" aria-hidden="true">${CATEGORIES[noteCats[0] || note.category]?.icon || '📝'}</span>`
        + `<span class="note-link-item-title">${titleHtml}</span>`
        + getNoteTags(note).map(t => `<span class="note-link-item-tag">#${escHtml(t)}</span>`).join('')
        + `</button>`;
    }).join('');

    const moreHtml = filtered.length > visible.length
      ? `<button type="button" class="note-link-more-btn" id="note-link-more-btn">더 보기 (${visible.length} / ${filtered.length}개)</button>`
      : '';
    noteLinkList.innerHTML = itemsHtml + moreHtml;
    if (resetScroll) {
      noteLinkList.scrollTop = 0;
    }
  }

  function captureNoteBodyPositionForLink() {
    const overlay = $('note-modal');
    const modalBox = overlay?.querySelector('.modal') as HTMLElement | null;
    if (!noteBodyEl) return;
    const isBodyActive = document.activeElement === noteBodyEl;
    const selStart = isBodyActive
      ? (noteBodyEl.selectionStart ?? noteBodyEl.value.length)
      : (hasKnownBodySelection ? lastKnownBodySelection.start : (noteBodyEl.selectionStart ?? noteBodyEl.value.length));
    const selEnd = isBodyActive
      ? (noteBodyEl.selectionEnd ?? noteBodyEl.value.length)
      : (hasKnownBodySelection ? lastKnownBodySelection.end : (noteBodyEl.selectionEnd ?? noteBodyEl.value.length));
    savedNoteLinkPosition = {
      modalScrollTop: modalBox ? modalBox.scrollTop : 0,
      textareaScrollTop: noteBodyEl.scrollTop,
      selectionStart: selStart,
      selectionEnd: selEnd
    };
  }

  function restoreNoteBodyPositionAfterLink(insertedRange?: { start: number; end: number }) {
    const pos = savedNoteLinkPosition;
    savedNoteLinkPosition = null;
    suppressFocusRestoreUntil = Date.now() + 450;
    savedEditCursor = null;

    const overlay = $('note-modal');
    const modalBox = overlay?.querySelector('.modal') as HTMLElement | null;
    if (!noteBodyEl || !overlay || !isDialogOpen(overlay)) return;

    const len = noteBodyEl.value.length;
    const targetStart = insertedRange
      ? Math.max(0, Math.min(insertedRange.start, len))
      : (pos ? Math.max(0, Math.min(pos.selectionStart, len)) : (noteBodyEl.selectionStart ?? len));
    const targetEnd = insertedRange
      ? Math.max(targetStart, Math.min(insertedRange.end, len))
      : (pos ? Math.max(targetStart, Math.min(pos.selectionEnd, len)) : (noteBodyEl.selectionEnd ?? len));

    try {
      noteBodyEl.focus({ preventScroll: true });
      noteBodyEl.setSelectionRange(targetStart, targetEnd);
      if (modalBox) {
        scrollTextareaCaretIntoView(
          modalBox,
          noteBodyEl,
          targetEnd,
          pos ? { modalScrollTop: pos.modalScrollTop, textareaScrollTop: pos.textareaScrollTop } : null
        );
      }
      lastKnownBodySelection = {
        start: targetStart,
        end: targetEnd,
        scrollTop: noteBodyEl.scrollTop
      };
      hasKnownBodySelection = true;
    } catch {}

    // 모바일 가상 키보드 레이아웃 전환이 뒤늦게 완료될 때 커서가 가려진 경우에만 조용히 보정 (이미 보이면 0px 이동)
    setTimeout(() => {
      if (!isDialogOpen(overlay) || isDialogOpen(noteLinkModal) || document.activeElement !== noteBodyEl) return;
      if (modalBox) {
        scrollTextareaCaretIntoView(modalBox, noteBodyEl, noteBodyEl.selectionEnd ?? targetEnd);
      }
    }, 140);
  }

  function openNoteLinkModal() {
    suppressFocusRestoreUntil = Date.now() + 450;
    savedEditCursor = null;
    if (!savedNoteLinkPosition) {
      captureNoteBodyPositionForLink();
    }
    deps.ensureSearchIndexReady();
    deps.ensureAllNotesCache();
    noteLinkRenderLimit = 80;
    activeNoteLinkIndex = -1;
    if (noteLinkSearchInput) noteLinkSearchInput.value = '';
    renderNoteLinkList('', true);
    openDialog(noteLinkModal);
    syncNoteModalViewportHeight(true);
    noteLinkSearchInput?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      syncNoteModalViewportHeight(true);
      if (document.activeElement !== noteLinkSearchInput) {
        noteLinkSearchInput?.focus({ preventScroll: true });
      }
    });
  }

  function closeNoteLinkModal(restoreBodyFocus = true) {
    suppressFocusRestoreUntil = Date.now() + 450;
    savedEditCursor = null;
    activeNoteLinkIndex = -1;
    resetNoteLinkModalViewportStyle();
    closeDialog(noteLinkModal);
    syncNoteModalViewportHeight(true);
    if (restoreBodyFocus) {
      restoreNoteBodyPositionAfterLink();
    }
  }

  function insertNoteLink(title: string) {
    const pos = savedNoteLinkPosition;
    const ta = $('note-body') as HTMLTextAreaElement | null;
    const linkText = `[[${title}]]`;
    // 1) 링크 모달을 즉시 닫아 하위 #note-modal의 inert 상태를 해제
    closeNoteLinkModal(false);
    // 2) 지연 프레임 없이 동기적으로 텍스트 삽입 + 커서 배치 + 정밀 스크롤 복원
    if (ta) {
      const len = ta.value.length;
      const start = pos ? Math.max(0, Math.min(pos.selectionStart, len)) : ta.selectionStart;
      const end = pos ? Math.max(start, Math.min(pos.selectionEnd, len)) : ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + linkText + ta.value.slice(end);
      const nextCursor = start + linkText.length;
      savedNoteLinkPosition = pos;
      restoreNoteBodyPositionAfterLink({ start: nextCursor, end: nextCursor });
      scheduleSaveDraft();
    } else {
      savedNoteLinkPosition = null;
    }
    showToast(`"${title}" 메모 링크를 삽입했어요 📝`);
  }

  async function uploadAndInsertImage(file: File, prefix: string, token: number): Promise<boolean> {
    const imgMod = await deps.getImage();
    const blob = await imgMod.compressImage(file, 2560, 2560, 0.88);
    const { url, path } = await imgMod.uploadImageToStorage(blob, imgMod.imageFileName(prefix, blob));
    if (token !== modalSessionToken) {
      imgMod.deleteImagesFromStorage([path || url]).catch(console.error);
      return false;
    }
    sessionUploadedInlineImages.push({ url, path });
    if (noteBodyEl) insertAtCursor(noteBodyEl, `\n![이미지](${url})\n`);
    return true;
  }

  function runBackgroundEmbeddingPipeline(params: {
    noteId: string;
    uid: string;
    candidate: {
      title: string;
      body: string;
      category: string;
      categories: string[];
      tag: string;
      tags: string[];
      keywords: string;
      locked: boolean;
    };
    isEdit: boolean;
    oldNote?: Note;
  }) {
    const { noteId, uid, candidate, isEdit, oldNote } = params;
    deletedNoteIds.delete(noteId);
    const seq = (embeddingPipelineSeqMap.get(noteId) || 0) + 1;
    embeddingPipelineSeqMap.set(noteId, seq);
    const isStaleOrDeleted = () =>
      embeddingPipelineSeqMap.get(noteId) !== seq || deletedNoteIds.has(noteId);

    (async () => {
      try {
        const ai = await deps.getAi();
        if (isStaleOrDeleted()) return;
        const currentInput = ai.buildNoteEmbeddingInput(candidate);

        if (
          isEdit &&
          oldNote &&
          ai.isCurrentEmbedding(oldNote.embeddingModel, oldNote.embedding) &&
          ai.buildNoteEmbeddingInput(oldNote) === currentInput
        ) {
          ai.upsertVectorNoteCache({
            id: noteId,
            uid,
            ...candidate,
            embedding: oldNote.embedding,
            embeddingModel: ai.EMBEDDING_VERSION,
            embeddingUpdatedAt: oldNote.embeddingUpdatedAt || Timestamp.now()
          });
          return;
        }

        const embedding = await ai.tryGenerateNoteEmbedding(candidate);
        if (isStaleOrDeleted()) return;

        if (embedding) {
          const nowTs = Timestamp.now();
          await updateDoc(doc(db, 'notes', noteId), {
            embedding,
            embeddingModel: ai.EMBEDDING_VERSION,
            embeddingUpdatedAt: nowTs
          });
          if (isStaleOrDeleted()) return;
          await updateNoteIndexEmbeddingMeta(
            noteId,
            candidate.categories,
            ai.EMBEDDING_VERSION,
            nowTs
          ).catch(err => console.warn('카테고리 인덱스 임베딩 메타 갱신 오류:', err));
          if (isStaleOrDeleted()) return;
          if (appState.currentNote?.id === noteId) {
            appState.currentNote.embedding = embedding;
            appState.currentNote.embeddingModel = ai.EMBEDDING_VERSION;
            appState.currentNote.embeddingUpdatedAt = nowTs;
          }
          ai.upsertVectorNoteCache({
            id: noteId,
            uid,
            ...candidate,
            embedding,
            embeddingModel: ai.EMBEDDING_VERSION,
            embeddingUpdatedAt: nowTs
          });
        } else if (isEdit) {
          await updateDoc(doc(db, 'notes', noteId), {
            embedding: null,
            embeddingModel: null,
            embeddingUpdatedAt: null
          });
          if (isStaleOrDeleted()) return;
          await updateNoteIndexEmbeddingMeta(
            noteId,
            candidate.categories,
            null,
            null
          ).catch(err => console.warn('카테고리 인덱스 임베딩 메타 초기화 오류:', err));
          if (appState.currentNote?.id === noteId) {
            appState.currentNote.embedding = null;
            appState.currentNote.embeddingModel = null;
            appState.currentNote.embeddingUpdatedAt = null;
          }
          ai.removeVectorNoteCache(noteId);
        }
      } catch (err) {
        console.warn('백그라운드 임베딩 파이프라인 처리 오류:', err);
      }
    })();
  }

  async function saveNote() {
    if (isSaving) return;
    const titleEl = $('note-title') as HTMLInputElement | null;
    const bodyEl = $('note-body') as HTMLTextAreaElement | null;
    const pinnedEl = $('note-pinned') as HTMLInputElement | null;
    const lockedEl = $('note-locked') as HTMLInputElement | null;
    const keywordsEl = $('note-keywords') as HTMLInputElement | null;

    const title = titleEl ? titleEl.value.trim() : '';
    const body = bodyEl ? bodyEl.value.trim() : '';
    const categories = getSelectedCategoriesFromUI();
    const category = categories[0] || appState.currentCat || Object.keys(CATEGORIES)[0];
    const tags = getSelectedTagsFromUI();
    const tag = tags[0] || null;
    // 수정 모달에서 핀 버튼을 제거했으므로 기존 메모 수정 시 기존 핀 상태를 그대로 보존
    const pinned = pinnedEl
      ? pinnedEl.checked
      : (appState.editingNoteId ? !!appState.currentNote?.pinned : false);
    const locked = lockedEl ? lockedEl.checked : false;
    const keywords = keywordsEl ? keywordsEl.value.trim() : '';

    if (!title) { showToast('제목을 입력해주세요'); return; }
    isSaving = true;
    const btn = $('btn-save') as HTMLButtonElement | null;
    if (btn) {
      btn.textContent = '저장 중...';
      btn.disabled = true;
    }
    try {
      // 본문에 실제로 남아 있는 기존 첨부 이미지만 유지 (수정 시 본문에서 지운 이미지는 images 목록·스토리지에서도 정리되어
      // 다음 수정 시 본문 하단에 다시 자동 삽입되지 않도록 보장)
      const allImages = appState.existingImages.filter(img => img?.url && body.includes(img.url));
      const isEdit = !!appState.editingNoteId;
      const prevPinned = isEdit ? !!appState.currentNote?.pinned : false;
      const pinnedAt = pinned
        ? (prevPinned && appState.currentNote?.pinnedAt ? appState.currentNote.pinnedAt : Timestamp.now())
        : null;

      const unusedSessionInlinePaths = sessionUploadedInlineImages
        .filter(img => !body.includes(img.url))
        .map(img => img.path || img.url);

      const candidateForEmbedding = {
        title,
        body,
        category,
        categories,
        tag: tag || '',
        tags,
        keywords,
        locked
      };

      if (isEdit && appState.editingNoteId && appState.currentNote) {
        const oldNote: Note = { ...appState.currentNote };
        const updateData: Partial<Note> = {
          category,
          categories,
          title,
          body,
          tag,
          tags,
          images: allImages,
          pinned,
          pinnedAt,
          locked,
          keywords,
          embedding: oldNote.embedding || null,
          embeddingModel: oldNote.embeddingModel || null,
          embeddingUpdatedAt: oldNote.embeddingUpdatedAt || null
        };

        await updateNoteWithIndex(appState.editingNoteId, updateData, oldNote);

        const oldPaths = collectImagePaths(oldNote);
        const newPathsSet = new Set(collectImagePaths({ images: allImages, body }));
        const removed = [
          ...oldPaths.filter(p => !newPathsSet.has(p)),
          ...unusedSessionInlinePaths
        ];
        if (removed.length) {
          deps.getImage().then(m => m.deleteImagesFromStorage(removed)).catch(console.error);
        }

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
        deps.onCacheNoteUpdated(appState.editingNoteId, { ...updateData, body } as any, deps.getDetailFrom());
        deps.openDetail(appState.currentNote, deps.getDetailFrom());

        runBackgroundEmbeddingPipeline({
          noteId: appState.editingNoteId,
          uid: appState.currentUser?.uid || '',
          candidate: candidateForEmbedding,
          isEdit: true,
          oldNote
        });
      } else {
        // 빠른 단일 트랜잭션 최적화: 자격 증명이 있고 본문이 짧다면 650ms 이내에 임베딩을 선행 시도
        let precomputedEmbedding: number[] | null = null;
        let precomputedModel: string | null = null;
        let precomputedUpdatedAt: Timestamp | null = null;

        try {
          const ai = await deps.getAi();
          if (ai.hasAiCredentials()) {
            const prePromise = ai.tryGenerateNoteEmbedding(candidateForEmbedding);
            const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), 650));
            const emb = await Promise.race([prePromise, timeoutPromise]);
            if (emb) {
              precomputedEmbedding = emb;
              precomputedModel = ai.EMBEDDING_VERSION;
              precomputedUpdatedAt = Timestamp.now();
            }
          }
        } catch {}

        const newNotePayload: Partial<Note> = {
          category,
          categories,
          tag,
          tags,
          title,
          body,
          images: allImages,
          pinned,
          pinnedAt,
          locked,
          keywords,
          embedding: precomputedEmbedding,
          embeddingModel: precomputedModel,
          embeddingUpdatedAt: precomputedUpdatedAt
        };
        const newNoteId = await createNoteWithIndex(newNotePayload);

        if (precomputedEmbedding && precomputedModel && precomputedUpdatedAt) {
          try {
            const ai = await deps.getAi();
            ai.upsertVectorNoteCache({
              id: newNoteId,
              uid: appState.currentUser?.uid || '',
              ...candidateForEmbedding,
              embedding: precomputedEmbedding,
              embeddingModel: precomputedModel,
              embeddingUpdatedAt: precomputedUpdatedAt
            });
          } catch {}
        }

        if (unusedSessionInlinePaths.length) {
          deps.getImage().then(m => m.deleteImagesFromStorage(unusedSessionInlinePaths)).catch(console.error);
        }
        if (!appState.currentCat || !categories.includes(appState.currentCat)) {
          deps.openList(category, tag);
        } else if (appState.currentTag && !tags.includes(appState.currentTag)) {
          deps.openList(appState.currentCat, tag);
        }
        showToast(pinned ? '메모가 저장되었어요 📌' : '메모가 저장되었어요 ✅');

        // 선행 임베딩이 성공했다면 중복 Firestore 트랜잭션을 생략
        if (!precomputedEmbedding) {
          runBackgroundEmbeddingPipeline({
            noteId: newNoteId,
            uid: appState.currentUser?.uid || '',
            candidate: candidateForEmbedding,
            isEdit: false
          });
        }
      }
      sessionUploadedInlineImages = [];
      requestCloseModal(true);
    } catch (e: any) {
      showToast('저장 실패: ' + e.message);
    } finally {
      isSaving = false;
      if (btn) {
        btn.textContent = '💾 저장';
        btn.disabled = false;
      }
    }
  }

  // 이벤트 바인딩
  const btnAddNote = $('btn-add-note');
  if (btnAddNote) btnAddNote.onclick = openAddModal;

  const btnCancel = $('btn-cancel');
  if (btnCancel) btnCancel.onclick = () => requestCloseModal(false);

  const btnSave = $('btn-save');
  if (btnSave) btnSave.onclick = saveNote;

  const noteLinkBtn = $('note-link-btn');
  if (noteLinkBtn) {
    // 버튼 클릭으로 #note-body 포커스가 풀리기 전에 커서/스크롤 위치를 선캡처하고 키보드 깜빡임 방지
    noteLinkBtn.addEventListener('pointerdown', () => captureNoteBodyPositionForLink(), { passive: true });
    noteLinkBtn.addEventListener('mousedown', e => e.preventDefault());
    noteLinkBtn.onclick = () => openNoteLinkModal();
  }

  const noteLinkCancel = $('note-link-cancel');
  if (noteLinkCancel) noteLinkCancel.onclick = () => closeNoteLinkModal();

  if (noteLinkModal) {
    noteLinkModal.addEventListener('click', e => {
      if ((e.target as HTMLElement).id === 'note-link-modal') closeNoteLinkModal();
    });
    noteLinkModal.addEventListener('cancel', e => {
      e.preventDefault();
      closeNoteLinkModal();
    });
  }

  if (noteLinkList) {
    // 항목 클릭 시 검색 입력창이 먼저 blur되어 모바일 키보드가 내려갔다 다시 올라오는 화면 출렁임 방지
    noteLinkList.addEventListener('mousedown', e => {
      if ((e.target as HTMLElement).closest('.note-link-item, #note-link-more-btn')) {
        e.preventDefault();
      }
    });
    noteLinkList.addEventListener('click', e => {
      const moreBtn = (e.target as HTMLElement).closest('#note-link-more-btn');
      if (moreBtn) {
        noteLinkRenderLimit += 100;
        renderNoteLinkList(noteLinkSearchInput ? noteLinkSearchInput.value : '', false);
        return;
      }
      const item = (e.target as HTMLElement).closest('.note-link-item') as HTMLElement | null;
      if (item && item.dataset.title !== undefined) insertNoteLink(item.dataset.title);
    });
  }

  if (noteLinkSearchClear && noteLinkSearchInput) {
    noteLinkSearchClear.addEventListener('mousedown', e => e.preventDefault());
    noteLinkSearchClear.addEventListener('click', () => {
      noteLinkSearchInput.value = '';
      noteLinkRenderLimit = 80;
      activeNoteLinkIndex = -1;
      renderNoteLinkList('', true);
      noteLinkSearchInput.focus({ preventScroll: true });
    });
  }

  if (noteLinkSearchInput) {
    // 한글 조합(IME) 중에도 엔터 없이 글자를 치는 즉시 아래 목록이 실시간 필터링되도록 즉시 렌더링
    noteLinkSearchInput.addEventListener('input', () => {
      noteLinkRenderLimit = 80;
      activeNoteLinkIndex = -1;
      renderNoteLinkList(noteLinkSearchInput.value, true);
    });

    noteLinkSearchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        if (visibleNoteLinkTitles.length === 0) return;
        e.preventDefault();
        activeNoteLinkIndex = (activeNoteLinkIndex + 1) % visibleNoteLinkTitles.length;
        syncActiveNoteLinkItemUI(true);
        return;
      }
      if (e.key === 'ArrowUp') {
        if (visibleNoteLinkTitles.length === 0) return;
        e.preventDefault();
        activeNoteLinkIndex = activeNoteLinkIndex <= 0
          ? visibleNoteLinkTitles.length - 1
          : activeNoteLinkIndex - 1;
        syncActiveNoteLinkItemUI(true);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 한글 조합 완료용 Enter 직후이거나 모바일 검색 키를 눌렀을 때도 최신 입력값으로 먼저 동기화
        renderNoteLinkList(noteLinkSearchInput.value, false);
        if (activeNoteLinkIndex >= 0 && activeNoteLinkIndex < visibleNoteLinkTitles.length) {
          insertNoteLink(visibleNoteLinkTitles[activeNoteLinkIndex]);
          return;
        }
        // 결과가 단 1개이거나 검색어와 정확히 일치하는 제목이 1순위이면 엔터로 즉시 삽입
        const qNorm = noteLinkSearchInput.value.trim().toLowerCase();
        if (
          visibleNoteLinkTitles.length === 1 ||
          (qNorm && visibleNoteLinkTitles.length > 0 && visibleNoteLinkTitles[0].trim().toLowerCase() === qNorm)
        ) {
          insertNoteLink(visibleNoteLinkTitles[0]);
        }
      }
    });
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
        cb.checked = true;
        showToast('최소 1개 이상의 카테고리를 선택해주세요');
        selected = getSelectedCategoriesFromUI();
      }
      const chip = cb.closest('.cat-option-chip');
      const checkMark = chip?.querySelector('.cat-option-check');
      if (chip) chip.classList.toggle('selected', cb.checked);
      if (checkMark) checkMark.textContent = cb.checked ? '✓' : '';

      updateCategoryMultiselectLabel(selected);
      renderTagOptions(selected, getSelectedTagsFromUI());
      scheduleSaveDraft();
    });
  }

  const tagOptionsEl = $('tag-options');
  if (tagOptionsEl) {
    tagOptionsEl.addEventListener('change', () => scheduleSaveDraft());
  }

  ['note-title', 'note-body', 'note-keywords'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', () => scheduleSaveDraft());
  });

  if (inlineImgBtn) {
    inlineImgBtn.onclick = () => inlineImgInput?.click();
  }

  if (inlineImgInput) {
    inlineImgInput.onchange = async e => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;
      const file = files[0];
      const token = modalSessionToken;

      activeImageUploadCount++;
      setInlineImgBtnUploading();
      try {
        const inserted = await uploadAndInsertImage(file, 'inline', token);
        if (inserted) showToast('이미지가 본문에 삽입되었어요 🖼️');
      } catch (e: any) {
        if (token === modalSessionToken) {
          showToast('업로드 실패: ' + (e?.message || '알 수 없는 오류'));
        }
      } finally {
        inlineImgInput.value = '';
        activeImageUploadCount = Math.max(0, activeImageUploadCount - 1);
        if (token === modalSessionToken) {
          resetInlineImgBtn();
        }
      }
    };
  }

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
        activeImageUploadCount++;
        setInlineImgBtnUploading();
        showToast('붙여넣은 이미지 업로드 중... ⏳');
        try {
          const inserted = await uploadAndInsertImage(file, 'pasted', token);
          if (inserted) showToast('이미지가 본문에 붙여넣어졌어요 🖼️');
        } catch (err: any) {
          if (token === modalSessionToken) {
            showToast('이미지 붙여넣기 실패: ' + (err?.message || '알 수 없는 오류'));
          }
        } finally {
          activeImageUploadCount = Math.max(0, activeImageUploadCount - 1);
          if (token === modalSessionToken) {
            resetInlineImgBtn();
          }
        }
        break;
      }
    });
  }

  const voiceBtn = $('voice-btn');
  if (voiceBtn) {
    voiceBtn.onclick = () => {
      if (isRecording) { stopRecording(); return; }
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) { showToast('이 브라우저는 음성 입력을 지원하지 않아요'); return; }
      const bodyTa = $('note-body') as HTMLTextAreaElement | null;
      const rawBaseText = bodyTa ? bodyTa.value : '';
      const baseText = rawBaseText && !/\s$/.test(rawBaseText) ? rawBaseText + ' ' : rawBaseText;
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
        if (bodyTa) {
          bodyTa.value = baseText + finalText + interim;
          scheduleSaveDraft();
        }
      };
      recognition.onerror = () => { stopRecording(); showToast('음성 인식 오류'); };
      recognition.onend = () => { if (isRecording) stopRecording(); };
      recognition.start();
      isRecording = true;
      voiceBtn.textContent = '녹음중';
      voiceBtn.classList.add('recording');
    };
  }

  const noteLockedCb = $('note-locked') as HTMLInputElement | null;
  if (noteLockedCb) {
    noteLockedCb.addEventListener('change', async () => {
      if (noteLockedCb.checked && !getStoredLockPin()) {
        await syncPinFromUserMeta();
        if (!getStoredLockPin()) {
          const ok = await openPinModal('setup', true);
          if (!ok) {
            setLockToggleUI(false);
            scheduleSaveDraft();
            return;
          }
        }
      }
      setLockToggleUI(noteLockedCb.checked);
      scheduleSaveDraft();
    });
  }

  const notePinnedCb = $('note-pinned') as HTMLInputElement | null;
  if (notePinnedCb) {
    notePinnedCb.addEventListener('change', () => {
      setPinToggleUI(notePinnedCb.checked);
      scheduleSaveDraft();
    });
  }

  const noteModal = $('note-modal');
  if (noteModal) {
    noteModal.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.id === 'note-modal') {
        requestCloseModal(false);
        return;
      }
      if (catMultiselectPanel && catMultiselectPanel.style.display !== 'none' && !target.closest('#cat-multiselect')) {
        setCategoryPanelOpen(false);
      }
    });
    // 네이티브 <dialog> Esc / 플랫폼 뒤로가기 취소 시 작성 중 내용 확인 보호
    noteModal.addEventListener('cancel', e => {
      e.preventDefault();
      requestCloseModal(false);
    });
  }

  return {
    openAddModal,
    openEditModal,
    closeModal,
    requestCloseModal,
    closeNoteLinkModal,
    isNoteLinkModalOpen: () => isDialogOpen(noteLinkModal),
    refreshNoteLinkListIfOpen: () => {
      if (isDialogOpen(noteLinkModal)) {
        renderNoteLinkList(noteLinkSearchInput ? noteLinkSearchInput.value : '', false);
      }
    },
    clearDraftTimer: () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
    },
    invalidateEmbeddingPipeline,
  };
}
