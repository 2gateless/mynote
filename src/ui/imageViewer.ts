// ── 이미지 뷰어 / 순환 갤러리 스와이프 / 이미지 컨텍스트 메뉴 모듈
// (다중 이미지 좌우 스와이프 및 무한 순환 / 2배 더블클릭 확대 / 팬 이동 / 휠 줌 / 롱프레스 메뉴 / 다운로드)
import { appState } from '../state';
import { showToast } from '../utils/toast';
import { openDialog, closeDialog, isDialogOpen } from './dom';

/**
 * 다중 이미지 갤러리에서 좌우 이동 시 순환(Wrap-around) 인덱스를 계산합니다.
 * - 마지막 이미지(total - 1)에서 다음(+1)으로 이동하면 첫 이미지(0)로 돌아갑니다.
 * - 첫 이미지(0)에서 이전(-1)으로 이동하면 마지막 이미지(total - 1)로 이동합니다.
 */
export function computeWrappedGalleryIndex(currentIndex: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return ((currentIndex + delta) % total + total) % total;
}

export async function downloadImage(url: string) {
  showToast('이미지 저장 중...');
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function'
      ? (AbortSignal as any).timeout(15000)
      : undefined;
    const response = await fetch(url, signal ? { signal } : undefined);
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
  } catch (e) {
    window.open(url, '_blank');
    showToast('새 탭에서 이미지를 길게 눌러 저장하세요');
  }
}

export function initImageViewer() {
  let viewerScale = 1;
  let viewerPanX = 0;
  let viewerPanY = 0;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartPanX = 0;
  let panStartPanY = 0;
  let hasMoved = false;
  let rafId = 0;

  // 다중 이미지 갤러리 상태
  let galleryUrls: string[] = [];
  let galleryIndex = 0;
  let isSwipingGallery = false;
  let swipeAxis: 'x' | 'y' | null = null;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeStartTime = 0;
  let swipeDeltaX = 0;

  const viewer = document.getElementById('img-viewer');
  const viewerViewport = document.getElementById('img-viewer-viewport');
  const viewerImg = document.getElementById('img-viewer-img') as HTMLImageElement | null;
  const viewerCounter = document.getElementById('img-viewer-counter');
  const viewerHint = document.getElementById('img-viewer-hint');
  const viewerPrevBtn = document.getElementById('img-viewer-prev') as HTMLButtonElement | null;
  const viewerNextBtn = document.getElementById('img-viewer-next') as HTMLButtonElement | null;
  const viewerBadge = document.getElementById('img-viewer-zoom-badge');
  const viewerToggleBtn = document.getElementById('img-viewer-zoom-toggle');
  const viewerResetBtn = document.getElementById('img-viewer-zoom-reset');
  const viewerZoomInBtn = document.getElementById('img-viewer-zoom-in');
  const viewerZoomOutBtn = document.getElementById('img-viewer-zoom-out');
  const viewerCloseBtn = document.getElementById('img-viewer-close');
  const viewerDownloadBtn = document.getElementById('img-viewer-download') as HTMLElement | null;

  /**
   * 현재 열려 있는 상세 메모(#detail-content)의 첨부 이미지 목록과 클릭된 이미지의 인덱스를 수집합니다.
   * (Google Drive 동영상 썸네일은 제외)
   */
  function collectCurrentNoteGallery(target: HTMLImageElement | string): { urls: string[]; index: number } {
    const fallbackUrl = typeof target === 'string' ? target : target.src;
    const detailEl = document.getElementById('detail-content');
    if (!detailEl) {
      return { urls: fallbackUrl ? [fallbackUrl] : [], index: 0 };
    }
    const imgs = Array.from(detailEl.querySelectorAll<HTMLImageElement>('img'))
      .filter(el => !el.closest('.video-drive-card') && Boolean(el.src));

    if (imgs.length === 0) {
      return { urls: fallbackUrl ? [fallbackUrl] : [], index: 0 };
    }

    const urls = imgs.map(el => el.src);
    let idx = -1;
    if (typeof target !== 'string') {
      idx = imgs.indexOf(target);
    }
    if (idx === -1 && fallbackUrl) {
      idx = urls.indexOf(fallbackUrl);
    }
    if (idx === -1) {
      return { urls: fallbackUrl ? [fallbackUrl] : [], index: 0 };
    }
    return { urls, index: idx };
  }

  function preloadAdjacentImages() {
    const total = galleryUrls.length;
    if (total <= 1) return;
    const nextUrl = galleryUrls[computeWrappedGalleryIndex(galleryIndex, 1, total)];
    const prevUrl = galleryUrls[computeWrappedGalleryIndex(galleryIndex, -1, total)];
    for (const u of [nextUrl, prevUrl]) {
      if (u) {
        const pre = new Image();
        pre.decoding = 'async';
        pre.src = u;
      }
    }
  }

  function syncGalleryControlsUI() {
    const total = galleryUrls.length;
    const hasMulti = total > 1;
    if (viewerCounter) {
      viewerCounter.style.display = hasMulti ? 'block' : 'none';
      if (hasMulti) {
        viewerCounter.textContent = `${galleryIndex + 1} / ${total}`;
      }
    }
    if (viewerPrevBtn) viewerPrevBtn.style.display = hasMulti ? 'flex' : 'none';
    if (viewerNextBtn) viewerNextBtn.style.display = hasMulti ? 'flex' : 'none';
    if (viewerHint) {
      viewerHint.textContent = hasMulti
        ? '💡 좌우로 쓸어 넘기기 · 더블클릭 2배 확대'
        : '💡 더블클릭하면 2배 확대 · 드래그로 이동';
    }
  }

  function updateViewerTransform(smooth = true) {
    if (!viewerImg) return;
    viewerImg.style.transition = smooth ? 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease' : 'none';
    viewerImg.style.transform = `translate(${viewerPanX}px, ${viewerPanY}px) scale(${viewerScale})`;
    if (viewerBadge) viewerBadge.textContent = `${Math.round(viewerScale * 100)}%`;
    if (viewerToggleBtn) viewerToggleBtn.textContent = viewerScale > 1.05 ? '↺ 맞춤' : '2x 확대';
    if (viewerViewport) {
      if (viewerScale > 1.05) {
        viewerViewport.classList.add('zoomed');
        viewerImg.style.cursor = isPanning ? 'grabbing' : 'grab';
      } else {
        viewerViewport.classList.remove('zoomed');
        viewerImg.style.cursor = isSwipingGallery ? 'grabbing' : (galleryUrls.length > 1 ? 'grab' : 'zoom-in');
      }
    }
  }

  // 드래그 중에는 이벤트마다가 아니라 프레임당 1회만 transform 갱신
  function scheduleDragTransform() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      updateViewerTransform(false);
    });
  }

  function resetViewerZoom(smooth = true) {
    viewerScale = 1;
    viewerPanX = 0;
    viewerPanY = 0;
    if (viewerImg) viewerImg.style.opacity = '1';
    updateViewerTransform(smooth);
  }

  /**
   * 갤러리에서 이전(-1) 또는 다음(+1) 이미지로 순환 이동합니다.
   */
  function stepGallery(delta: 1 | -1) {
    const total = galleryUrls.length;
    if (!viewerImg || total <= 1) return;

    galleryIndex = computeWrappedGalleryIndex(galleryIndex, delta, total);
    const nextUrl = galleryUrls[galleryIndex];
    if (!nextUrl) return;

    viewerScale = 1;
    viewerPanY = 0;
    viewerImg.classList.remove('dragging');
    viewerImg.src = nextUrl;
    if (viewerDownloadBtn) viewerDownloadBtn.dataset.url = nextUrl;
    syncGalleryControlsUI();
    preloadAdjacentImages();

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!prefersReducedMotion) {
      // 스와이프/이동 방향에 맞춰 반대편에서 부드럽게 슬라이드 인
      const enterOffset = delta > 0 ? 56 : -56;
      viewerPanX = enterOffset;
      viewerImg.style.opacity = '0.45';
      updateViewerTransform(false);
      requestAnimationFrame(() => {
        viewerPanX = 0;
        if (viewerImg) viewerImg.style.opacity = '1';
        updateViewerTransform(true);
      });
    } else {
      viewerPanX = 0;
      viewerImg.style.opacity = '1';
      updateViewerTransform(false);
    }
  }

  function toggleViewerDoubleZoom(originX?: number, originY?: number) {
    if (viewerScale <= 1.05) {
      viewerScale = 2;
      if (originX !== undefined && originY !== undefined && viewerViewport) {
        const rect = viewerViewport.getBoundingClientRect();
        const clickOffsetX = originX - (rect.left + rect.width / 2);
        const clickOffsetY = originY - (rect.top + rect.height / 2);
        // 더블클릭한 영역이 시야 중심에 가깝게 이동하도록 팬 좌표 보정
        viewerPanX = Math.round(-clickOffsetX * 0.7);
        viewerPanY = Math.round(-clickOffsetY * 0.7);
      } else {
        viewerPanX = 0;
        viewerPanY = 0;
      }
    } else {
      viewerScale = 1;
      viewerPanX = 0;
      viewerPanY = 0;
    }
    updateViewerTransform(true);
  }

  function closeImageViewer() {
    closeDialog(viewer);
    isPanning = false;
    isSwipingGallery = false;
    swipeAxis = null;
    resetViewerZoom(false);
  }

  appState.closeImageViewer = closeImageViewer;

  appState.openImageViewer = function (
    url: string,
    initialScale = 1,
    explicitGalleryUrls?: string[],
    explicitStartIndex?: number
  ) {
    if (!viewer || !viewerImg) return;

    if (Array.isArray(explicitGalleryUrls) && explicitGalleryUrls.length > 0) {
      galleryUrls = explicitGalleryUrls;
      const idx = typeof explicitStartIndex === 'number' && explicitStartIndex >= 0 && explicitStartIndex < explicitGalleryUrls.length
        ? explicitStartIndex
        : Math.max(0, explicitGalleryUrls.indexOf(url));
      galleryIndex = idx;
    } else {
      const collected = collectCurrentNoteGallery(url);
      galleryUrls = collected.urls;
      galleryIndex = collected.index;
    }

    const activeUrl = galleryUrls[galleryIndex] || url;
    viewerImg.src = activeUrl;
    viewerImg.style.opacity = '1';
    if (viewerDownloadBtn) viewerDownloadBtn.dataset.url = activeUrl;
    syncGalleryControlsUI();
    openDialog(viewer);
    viewerScale = initialScale || 1;
    viewerPanX = 0;
    viewerPanY = 0;
    updateViewerTransform(false);
    preloadAdjacentImages();
  };

  function openViewerFromElement(img: HTMLImageElement, initialScale = 1) {
    const { urls, index } = collectCurrentNoteGallery(img);
    appState.openImageViewer?.(img.src, initialScale, urls, index);
  }

  if (viewerCloseBtn) viewerCloseBtn.onclick = () => closeImageViewer();
  if (viewerResetBtn) viewerResetBtn.onclick = () => resetViewerZoom(true);
  if (viewerToggleBtn) viewerToggleBtn.onclick = () => toggleViewerDoubleZoom();

  if (viewerPrevBtn) {
    viewerPrevBtn.onclick = (e) => {
      e.stopPropagation();
      stepGallery(-1);
    };
  }
  if (viewerNextBtn) {
    viewerNextBtn.onclick = (e) => {
      e.stopPropagation();
      stepGallery(1);
    };
  }

  if (viewerZoomInBtn) {
    viewerZoomInBtn.onclick = () => {
      viewerScale = Math.min(5, Math.round((viewerScale + 0.5) * 10) / 10);
      updateViewerTransform(true);
    };
  }

  if (viewerZoomOutBtn) {
    viewerZoomOutBtn.onclick = () => {
      viewerScale = Math.max(1, Math.round((viewerScale - 0.5) * 10) / 10);
      if (viewerScale === 1) { viewerPanX = 0; viewerPanY = 0; }
      updateViewerTransform(true);
    };
  }

  if (viewerDownloadBtn) {
    viewerDownloadBtn.onclick = () => {
      const url = viewerDownloadBtn.dataset.url;
      if (url) downloadImage(url);
    };
  }

  // 스와이프 완료 판정 (이동 거리 또는 빠른 플릭 속도 충족 시 이전/다음 순환 전환)
  function finishGallerySwipe(): boolean {
    const dx = swipeDeltaX;
    const elapsed = Math.max(1, Date.now() - swipeStartTime);
    const velocity = Math.abs(dx) / elapsed;
    const threshold = Math.min(72, Math.max(38, window.innerWidth * 0.12));
    const shouldSwitch =
      swipeAxis === 'x' &&
      galleryUrls.length > 1 &&
      (Math.abs(dx) >= threshold || (velocity > 0.32 && Math.abs(dx) >= 22));

    isSwipingGallery = false;
    swipeAxis = null;
    swipeDeltaX = 0;
    viewerImg?.classList.remove('dragging');

    if (shouldSwitch) {
      // 왼쪽으로 쓸기(dx < 0) => 다음 이미지(+1), 오른쪽으로 쓸기(dx > 0) => 이전 이미지(-1)
      stepGallery(dx < 0 ? 1 : -1);
      return true;
    }

    viewerPanX = 0;
    viewerPanY = 0;
    if (viewerImg) viewerImg.style.opacity = '1';
    updateViewerTransform(true);
    return false;
  }

  if (viewerViewport) {
    // 뷰포트 내 마우스 더블클릭 (2배 확대 토글)
    viewerViewport.addEventListener('dblclick', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.img-viewer-nav')) return;
      e.preventDefault();
      toggleViewerDoubleZoom(e.clientX, e.clientY);
    });

    // 마우스 드래그 (확대 상태: Pan / 1배율 다중 이미지 상태: 좌우 스와이프)
    const onMouseMove = (e: MouseEvent) => {
      if (isPanning) {
        const dx = e.clientX - panStartX;
        const dy = e.clientY - panStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        viewerPanX = panStartPanX + dx;
        viewerPanY = panStartPanY + dy;
        scheduleDragTransform();
        return;
      }
      if (isSwipingGallery) {
        const dx = e.clientX - swipeStartX;
        const dy = e.clientY - swipeStartY;
        if (!swipeAxis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          hasMoved = true;
          swipeAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        }
        if (swipeAxis === 'x') {
          swipeDeltaX = dx;
          viewerPanX = Math.round(dx * 0.92);
          scheduleDragTransform();
        }
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (isPanning) {
        isPanning = false;
        viewerViewport.classList.remove('panning');
        viewerImg?.classList.remove('dragging');
        updateViewerTransform(false);
        return;
      }
      if (isSwipingGallery) {
        finishGallerySwipe();
      }
    };

    viewerViewport.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.img-viewer-nav')) return;
      hasMoved = false;

      if (viewerScale > 1.05) {
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartPanX = viewerPanX;
        panStartPanY = viewerPanY;
        viewerViewport.classList.add('panning');
        viewerImg?.classList.add('dragging');
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      } else if (galleryUrls.length > 1) {
        isSwipingGallery = true;
        swipeAxis = null;
        swipeStartX = e.clientX;
        swipeStartY = e.clientY;
        swipeStartTime = Date.now();
        swipeDeltaX = 0;
        viewerImg?.classList.add('dragging');
        updateViewerTransform(false);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      }
    });

    // 휠 스크롤 부드러운 줌
    viewerViewport.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      let newScale = viewerScale * zoomFactor;
      if (newScale < 1) newScale = 1;
      if (newScale > 5) newScale = 5;
      viewerScale = Math.round(newScale * 100) / 100;
      if (viewerScale === 1) { viewerPanX = 0; viewerPanY = 0; }
      updateViewerTransform(true);
    }, { passive: false });

    // 배경 빈 영역 클릭 시 닫기 (드래그/스와이프하지 않은 경우)
    viewerViewport.addEventListener('click', (e: MouseEvent) => {
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      if (e.target === viewerViewport) closeImageViewer();
    });

    // 모바일 터치 제스처 (1배율: 좌우 스와이프 순환 / 확대 상태: 드래그 Pan / 더블탭 2x 확대)
    let lastViewerTouchEnd = 0;
    viewerViewport.addEventListener('touchstart', (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest('.img-viewer-nav')) return;
      if (e.touches.length !== 1) {
        if (isSwipingGallery) {
          isSwipingGallery = false;
          swipeAxis = null;
          swipeDeltaX = 0;
          viewerPanX = 0;
          updateViewerTransform(true);
        }
        return;
      }

      hasMoved = false;
      const touch = e.touches[0];

      if (viewerScale > 1.05) {
        isPanning = true;
        isSwipingGallery = false;
        panStartX = touch.clientX;
        panStartY = touch.clientY;
        panStartPanX = viewerPanX;
        panStartPanY = viewerPanY;
        viewerImg?.classList.add('dragging');
      } else if (galleryUrls.length > 1) {
        isSwipingGallery = true;
        isPanning = false;
        swipeAxis = null;
        swipeStartX = touch.clientX;
        swipeStartY = touch.clientY;
        swipeStartTime = Date.now();
        swipeDeltaX = 0;
        viewerImg?.classList.add('dragging');
      }
    }, { passive: true });

    viewerViewport.addEventListener('touchmove', (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      if (isPanning) {
        const dx = touch.clientX - panStartX;
        const dy = touch.clientY - panStartY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          hasMoved = true;
          clearTimeout(longPressTimer);
        }
        viewerPanX = panStartPanX + dx;
        viewerPanY = panStartPanY + dy;
        scheduleDragTransform();
        return;
      }

      if (isSwipingGallery) {
        const dx = touch.clientX - swipeStartX;
        const dy = touch.clientY - swipeStartY;
        if (!swipeAxis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
          hasMoved = true;
          clearTimeout(longPressTimer);
          swipeAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        }
        if (swipeAxis === 'x') {
          swipeDeltaX = dx;
          viewerPanX = Math.round(dx * 0.92);
          scheduleDragTransform();
        }
      }
    }, { passive: true });

    viewerViewport.addEventListener('touchend', (e: TouchEvent) => {
      if ((e.target as HTMLElement).closest('.img-viewer-nav')) return;

      if (isPanning) {
        isPanning = false;
        viewerImg?.classList.remove('dragging');
      }

      if (isSwipingGallery) {
        const switched = finishGallerySwipe();
        if (switched) {
          // 연속 빠른 스와이프가 더블탭 확대로 오인식되지 않도록 타이머 초기화
          lastViewerTouchEnd = 0;
          return;
        }
      }

      const now = Date.now();
      if (now - lastViewerTouchEnd <= 300 && !hasMoved) {
        const touch = e.changedTouches[0];
        toggleViewerDoubleZoom(touch?.clientX, touch?.clientY);
        lastViewerTouchEnd = 0;
        return;
      }
      lastViewerTouchEnd = now;
    });

    viewerViewport.addEventListener('touchcancel', () => {
      isPanning = false;
      if (isSwipingGallery) {
        isSwipingGallery = false;
        swipeAxis = null;
        swipeDeltaX = 0;
        viewerPanX = 0;
        viewerImg?.classList.remove('dragging');
        updateViewerTransform(true);
      }
    }, { passive: true });
  }

  // 네이티브 <dialog> 닫기(Esc/플랫폼 뒤로가기) 시 줌 상태 초기화
  if (viewer) {
    viewer.addEventListener('close', () => {
      isPanning = false;
      isSwipingGallery = false;
      swipeAxis = null;
      resetViewerZoom(false);
    });
  }

  // ── IMAGE CONTEXT MENU (Native Popover + ContextMenu & LongPress)
  let ctxMenuUrl: string | null = null;
  let ctxMenuTargetImg: HTMLImageElement | null = null;
  let longPressTimer: any = null;
  let longPressTriggeredAt = 0;
  const ctxMenu = document.getElementById('img-ctx-menu') as (HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  }) | null;

  function showImgCtxMenu(x: number, y: number, url: string, sourceImg?: HTMLImageElement | null) {
    if (!ctxMenu) return;
    ctxMenuUrl = url;
    ctxMenuTargetImg = sourceImg || null;
    const menuW = 200, menuH = 110;
    const vw = window.innerWidth, vh = window.innerHeight;
    ctxMenu.style.left = Math.max(8, Math.min(x, vw - menuW - 8)) + 'px';
    ctxMenu.style.top  = Math.max(8, Math.min(y, vh - menuH - 8)) + 'px';
    if (typeof ctxMenu.showPopover === 'function') {
      try {
        if (!ctxMenu.matches(':popover-open')) ctxMenu.showPopover();
        return;
      } catch {}
    }
    ctxMenu.style.display = 'block';
  }
  function hideImgCtxMenu() {
    if (!ctxMenu) return;
    if (typeof ctxMenu.hidePopover === 'function') {
      try {
        if (ctxMenu.matches(':popover-open')) ctxMenu.hidePopover();
      } catch {}
    } else if (ctxMenu.style.display !== 'none') {
      ctxMenu.style.display = 'none';
    }
    ctxMenuUrl = null;
    ctxMenuTargetImg = null;
  }

  // 키보드 좌우 화살표 순환 이동 & 구형 브라우저용 Esc 폴백
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!viewer || !isDialogOpen(viewer)) return;
    if (e.key === 'ArrowLeft' && galleryUrls.length > 1) {
      e.preventDefault();
      stepGallery(-1);
      return;
    }
    if (e.key === 'ArrowRight' && galleryUrls.length > 1) {
      e.preventDefault();
      stepGallery(1);
      return;
    }
    if (e.key === 'Escape' && !(typeof HTMLDialogElement !== 'undefined' && viewer instanceof HTMLDialogElement)) {
      closeImageViewer();
    }
  });

  const ctxView = document.getElementById('img-ctx-view');
  if (ctxView) {
    ctxView.onclick = () => {
      if (ctxMenuTargetImg) {
        openViewerFromElement(ctxMenuTargetImg, 1);
      } else if (ctxMenuUrl) {
        appState.openImageViewer?.(ctxMenuUrl, 1);
      }
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
    // 모바일 롱프레스 직후 손가락을 뗄 때 발생하는 합성 click으로 메뉴가 즉시 닫히는 현상 방지
    if (Date.now() - longPressTriggeredAt < 450) return;
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) hideImgCtxMenu();
  });
  document.addEventListener('contextmenu', e => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) hideImgCtxMenu();
  });

  // 상세 본문 이미지: 컨텍스트 메뉴 / 클릭 / 더블클릭 / 롱프레스 (이벤트 위임)
  let detailTouchTime = 0;
  const detailContent = document.getElementById('detail-content');
  if (detailContent) {
    // Google Drive 동영상 카드(.video-drive-card) 내부의 썸네일 이미지는 뷰어 대상에서 제외
    const imgOf = (e: Event) => {
      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (!img || img.closest('.video-drive-card')) return null;
      return img;
    };

    detailContent.addEventListener('contextmenu', e => {
      const img = imgOf(e);
      if (!img) return;
      e.preventDefault();
      showImgCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, img.src, img);
    });

    // 본문 이미지 1회 클릭 시 해당 메모의 전체 이미지 갤러리와 함께 뷰어 열기
    detailContent.addEventListener('click', e => {
      if (Date.now() - longPressTriggeredAt < 450) return;
      const img = imgOf(e);
      if (!img) return;
      openViewerFromElement(img, 1);
    });

    // 본문 이미지 더블클릭 시 즉시 2배 확대 상태로 열기
    detailContent.addEventListener('dblclick', e => {
      const img = imgOf(e);
      if (!img) return;
      e.preventDefault();
      openViewerFromElement(img, 2);
    });

    detailContent.addEventListener('touchstart', e => {
      const img = imgOf(e);
      if (!img) return;
      const touch = e.touches[0];
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTriggeredAt = Date.now();
        showImgCtxMenu(touch.clientX, touch.clientY, img.src, img);
      }, 600);
    }, { passive: true });

    detailContent.addEventListener('touchend', e => {
      clearTimeout(longPressTimer);
      if (Date.now() - longPressTriggeredAt < 450) {
        if (e.cancelable) e.preventDefault();
        return;
      }
      const img = imgOf(e);
      if (!img) return;
      const now = Date.now();
      // 모바일 더블 탭 시 2배 확대 뷰어로 즉시 열기
      if (now - detailTouchTime <= 300) {
        if (e.cancelable) e.preventDefault();
        openViewerFromElement(img, 2);
      }
      detailTouchTime = now;
    });

    detailContent.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  }

  // 이미지 뷰어 내부 롱프레스 / 우클릭 (현재 보고 있는 이미지 기준 다운로드 메뉴)
  if (viewerImg) {
    let viewerLongPressStartX = 0;
    let viewerLongPressStartY = 0;
    const currentUrl = () => viewerDownloadBtn ? viewerDownloadBtn.dataset.url : null;

    viewerImg.addEventListener('contextmenu', e => {
      e.preventDefault();
      const url = currentUrl();
      if (url) showImgCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, url);
    });
    viewerImg.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      viewerLongPressStartX = touch.clientX;
      viewerLongPressStartY = touch.clientY;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        const url = currentUrl();
        if (url && !hasMoved) {
          longPressTriggeredAt = Date.now();
          showImgCtxMenu(touch.clientX, touch.clientY, url);
        }
      }, 600);
    }, { passive: true });
    viewerImg.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    viewerImg.addEventListener('touchmove', e => {
      const touch = e.touches[0];
      if (!touch) {
        clearTimeout(longPressTimer);
        return;
      }
      if (Math.abs(touch.clientX - viewerLongPressStartX) > 8 || Math.abs(touch.clientY - viewerLongPressStartY) > 8) {
        clearTimeout(longPressTimer);
      }
    }, { passive: true });
  }
}
