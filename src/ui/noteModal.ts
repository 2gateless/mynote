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
import { escHtml } from '../utils/formatter';
import { collectImagePaths } from '../utils/imagePaths';
import { showToast } from '../utils/toast';
import { openPinModal, syncPinFromUserMeta, getStoredLockPin } from './pinModal';
import { Note, NoteIndexItem } from '../types';
import { $, setDisplay, insertAtCursor } from './dom';

export const NOTE_DRAFT_KEY = 'mynote_new_note_draft_v1';

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
  const noteLinkList = $('note-link-list') as HTMLElement | null;
  const noteCategoryOptionsEl = $('note-category-options') as HTMLElement | null;
  const catMultiselectTrigger = $('cat-multiselect-trigger') as HTMLButtonElement | null;
  const catMultiselectLabel = $('cat-multiselect-label') as HTMLElement | null;
  const catMultiselectArrow = $('cat-multiselect-arrow') as HTMLElement | null;
  const catMultiselectPanel = $('cat-multiselect-panel') as HTMLElement | null;
  const inlineImgBtn = $('inline-img-btn') as HTMLButtonElement | null;
  const inlineImgInput = $('inline-img-input') as HTMLInputElement | null;
  const noteBodyEl = $('note-body') as HTMLTextAreaElement | null;

  let noteLinkSearchTimer: ReturnType<typeof setTimeout> | null = null;
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
    const icon = $('lock-toggle-icon');
    const status = $('lock-toggle-status');
    if (cb) cb.checked = isLocked;
    if (icon) icon.textContent = isLocked ? '🔒' : '🔓';
    if (wrap && status) {
      wrap.classList.toggle('active', isLocked);
      status.textContent = isLocked ? '🔒 잠금됨' : '해제';
    }
  }

  function setPinToggleUI(isPinned: boolean) {
    const cb = $('note-pinned') as HTMLInputElement | null;
    const wrap = $('pin-toggle-wrap');
    const status = $('pin-toggle-status');
    if (cb) cb.checked = isPinned;
    if (wrap && status) {
      wrap.classList.toggle('active', isPinned);
      status.textContent = isPinned ? '📌 고정됨' : '해제';
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

  function isNoteFormDirty(): boolean {
    const modal = $('note-modal');
    if (!modal || modal.style.display === 'none' || !initialNoteFormSnapshot) return false;
    if (sessionUploadedInlineImages.length > 0) return true;

    const current = takeCurrentFormSnapshot();
    const init = initialNoteFormSnapshot;

    if (current.title !== init.title) return true;
    if (current.body !== init.body) return true;
    if (current.keywords !== init.keywords) return true;
    if (current.pinned !== init.pinned) return true;
    if (current.locked !== init.locked) return true;

    if (init.categories.slice().sort().join(',') !== current.categories.slice().sort().join(',')) return true;
    if (init.tags.slice().sort().join(',') !== current.tags.slice().sort().join(',')) return true;

    return false;
  }

  function clearDraft() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    try {
      localStorage.removeItem(NOTE_DRAFT_KEY);
    } catch {}
  }

  function scheduleSaveDraft() {
    if (appState.editingNoteId) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      try {
        const snap = takeCurrentFormSnapshot();
        if (snap.title || snap.body || snap.keywords) {
          localStorage.setItem(NOTE_DRAFT_KEY, JSON.stringify(snap));
        } else {
          localStorage.removeItem(NOTE_DRAFT_KEY);
        }
      } catch {}
    }, 400);
  }

  function resetInlineImgBtn(force = false) {
    if (force) activeImageUploadCount = 0;
    if (!inlineImgBtn || activeImageUploadCount > 0) return;
    inlineImgBtn.textContent = '🖼️ 이미지 삽입';
    inlineImgBtn.classList.remove('uploading');
    inlineImgBtn.disabled = false;
  }

  function setInlineImgBtnUploading() {
    if (!inlineImgBtn) return;
    inlineImgBtn.textContent = activeImageUploadCount > 1
      ? `⏳ 업로드 중 (${activeImageUploadCount}개)...`
      : '⏳ 업로드 중...';
    inlineImgBtn.classList.add('uploading');
    inlineImgBtn.disabled = true;
  }

  function stopRecording() {
    if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    isRecording = false;
    const vb = $('voice-btn');
    if (vb) {
      vb.textContent = '🎤 음성 입력';
      vb.classList.remove('recording');
    }
  }

  function closeModal(saved = false) {
    modalSessionToken++;
    initialNoteFormSnapshot = null;
    setDisplay('note-modal', 'none');
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
            setDisplay('note-modal', 'flex');
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
    setDisplay('note-modal', 'flex');
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
    setDisplay('note-modal', 'flex');
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

  function renderNoteLinkList(keyword: string) {
    if (!noteLinkList) return;
    const kw = keyword.toLowerCase().trim();
    const allNotes = appState.allNotesCache || [];
    if (allNotes.length === 0 && !deps.isNotesLoaded()) {
      noteLinkList.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-light);font-size:13px">⏳ 메모 목록을 불러오는 중...</div>`;
      return;
    }
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
      const noteCats = getNoteCategories(note);
      return `<div class="note-link-item" data-title="${escHtml(note.title)}">`
        + `<span class="note-link-item-cat">${CATEGORIES[noteCats[0] || note.category]?.icon || '📝'}</span>`
        + `<span class="note-link-item-title">${escHtml(note.title)}</span>`
        + getNoteTags(note).map(t => `<span class="note-link-item-tag">#${escHtml(t)}</span>`).join('')
        + `</div>`;
    }).join('');
  }

  function openNoteLinkModal() {
    deps.ensureSearchIndexReady();
    deps.ensureAllNotesCache();
    if (noteLinkSearchInput) noteLinkSearchInput.value = '';
    renderNoteLinkList('');
    if (noteLinkModal) noteLinkModal.style.display = 'flex';
    setTimeout(() => noteLinkSearchInput?.focus(), 80);
  }

  function closeNoteLinkModal() {
    if (noteLinkSearchTimer) clearTimeout(noteLinkSearchTimer);
    if (noteLinkModal) noteLinkModal.style.display = 'none';
  }

  function insertNoteLink(title: string) {
    const ta = $('note-body') as HTMLTextAreaElement | null;
    if (ta) insertAtCursor(ta, `[[${title}]]`);
    closeNoteLinkModal();
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
    const pinned = pinnedEl ? pinnedEl.checked : false;
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
          embedding: null,
          embeddingModel: null,
          embeddingUpdatedAt: null
        };
        const newNoteId = await createNoteWithIndex(newNotePayload);

        if (unusedSessionInlinePaths.length) {
          deps.getImage().then(m => m.deleteImagesFromStorage(unusedSessionInlinePaths)).catch(console.error);
        }
        if (!appState.currentCat || !categories.includes(appState.currentCat)) {
          deps.openList(category, tag);
        } else if (appState.currentTag && !tags.includes(appState.currentTag)) {
          deps.openList(appState.currentCat, tag);
        }
        showToast(pinned ? '메모가 저장되었어요 📌' : '메모가 저장되었어요 ✅');

        runBackgroundEmbeddingPipeline({
          noteId: newNoteId,
          uid: appState.currentUser?.uid || '',
          candidate: candidateForEmbedding,
          isEdit: false
        });
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
  if (noteLinkBtn) noteLinkBtn.onclick = () => openNoteLinkModal();

  const noteLinkCancel = $('note-link-cancel');
  if (noteLinkCancel) noteLinkCancel.onclick = () => closeNoteLinkModal();

  if (noteLinkModal) {
    noteLinkModal.addEventListener('click', e => {
      if ((e.target as HTMLElement).id === 'note-link-modal') closeNoteLinkModal();
    });
  }

  if (noteLinkList) {
    noteLinkList.addEventListener('click', e => {
      const item = (e.target as HTMLElement).closest('.note-link-item') as HTMLElement | null;
      if (item && item.dataset.title !== undefined) insertNoteLink(item.dataset.title);
    });
  }

  if (noteLinkSearchInput) {
    noteLinkSearchInput.addEventListener('input', () => {
      if (noteLinkSearchTimer) clearTimeout(noteLinkSearchTimer);
      noteLinkSearchTimer = setTimeout(() => renderNoteLinkList(noteLinkSearchInput.value), 120);
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
      voiceBtn.textContent = '🔴 녹음 중... (클릭하여 종료)';
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
  }

  return {
    openAddModal,
    openEditModal,
    closeModal,
    requestCloseModal,
    closeNoteLinkModal,
    isNoteLinkModalOpen: () => Boolean(noteLinkModal && noteLinkModal.style.display !== 'none'),
    refreshNoteLinkListIfOpen: () => {
      if (noteLinkModal && noteLinkModal.style.display !== 'none') {
        renderNoteLinkList(noteLinkSearchInput ? noteLinkSearchInput.value : '');
      }
    },
    clearDraftTimer: () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
    },
    invalidateEmbeddingPipeline,
  };
}
