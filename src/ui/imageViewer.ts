// ── 이미지 뷰어 / 이미지 컨텍스트 메뉴 모듈
// (2배 더블클릭 확대 / 마우스·터치 드래그 이동 / 휠 줌 / 롱프레스 메뉴 / 다운로드)
import { appState } from '../state';
import { showToast } from '../utils/toast';

export async function downloadImage(url: string) {
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

  const viewer = document.getElementById('img-viewer');
  const viewerViewport = document.getElementById('img-viewer-viewport');
  const viewerImg = document.getElementById('img-viewer-img') as HTMLImageElement;
  const viewerBadge = document.getElementById('img-viewer-zoom-badge');
  const viewerToggleBtn = document.getElementById('img-viewer-zoom-toggle');
  const viewerResetBtn = document.getElementById('img-viewer-zoom-reset');
  const viewerZoomInBtn = document.getElementById('img-viewer-zoom-in');
  const viewerZoomOutBtn = document.getElementById('img-viewer-zoom-out');
  const viewerCloseBtn = document.getElementById('img-viewer-close');
  const viewerDownloadBtn = document.getElementById('img-viewer-download') as HTMLElement;

  function updateViewerTransform(smooth = true) {
    if (!viewerImg) return;
    viewerImg.style.transition = smooth ? 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
    viewerImg.style.transform = `translate(${viewerPanX}px, ${viewerPanY}px) scale(${viewerScale})`;
    if (viewerBadge) viewerBadge.textContent = `${Math.round(viewerScale * 100)}%`;
    if (viewerToggleBtn) viewerToggleBtn.textContent = viewerScale > 1.05 ? '↺ 맞춤' : '2x 확대';
    if (viewerViewport) {
      if (viewerScale > 1.05) {
        viewerViewport.classList.add('zoomed');
        viewerImg.style.cursor = isPanning ? 'grabbing' : 'grab';
      } else {
        viewerViewport.classList.remove('zoomed');
        viewerImg.style.cursor = 'zoom-in';
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
    updateViewerTransform(smooth);
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
    if (viewer) viewer.style.display = 'none';
    resetViewerZoom(false);
  }

  appState.openImageViewer = function(url: string, initialScale = 1) {
    if (!viewer || !viewerImg) return;
    viewerImg.src = url;
    if (viewerDownloadBtn) viewerDownloadBtn.dataset.url = url;
    viewer.style.display = 'flex';
    viewerScale = initialScale || 1;
    viewerPanX = 0;
    viewerPanY = 0;
    updateViewerTransform(false);
    viewer.focus();
  };

  if (viewerCloseBtn) viewerCloseBtn.onclick = () => closeImageViewer();
  if (viewerResetBtn) viewerResetBtn.onclick = () => resetViewerZoom(true);
  if (viewerToggleBtn) viewerToggleBtn.onclick = () => toggleViewerDoubleZoom();

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

  if (viewerViewport) {
    // 뷰포트 내 마우스 더블클릭 (2배 확대 토글)
    viewerViewport.addEventListener('dblclick', (e: MouseEvent) => {
      e.preventDefault();
      toggleViewerDoubleZoom(e.clientX, e.clientY);
    });

    // 마우스 드래그 (Pan) — window 리스너는 드래그 중에만 등록
    const onMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      viewerPanX = panStartPanX + dx;
      viewerPanY = panStartPanY + dy;
      scheduleDragTransform();
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (!isPanning) return;
      isPanning = false;
      viewerViewport.classList.remove('panning');
      viewerImg?.classList.remove('dragging');
      updateViewerTransform(false);
    };

    viewerViewport.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (viewerScale <= 1.05) return;
      isPanning = true;
      hasMoved = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartPanX = viewerPanX;
      panStartPanY = viewerPanY;
      viewerViewport.classList.add('panning');
      viewerImg?.classList.add('dragging');
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
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

    // 배경 빈 영역 클릭 시 닫기 (드래그하지 않은 경우)
    viewerViewport.addEventListener('click', (e: MouseEvent) => {
      if (hasMoved) return;
      if (e.target === viewerViewport) closeImageViewer();
    });

    // 모바일 터치 제스처 (드래그 및 더블탭)
    let lastViewerTouchEnd = 0;
    viewerViewport.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length === 1 && viewerScale > 1.05) {
        isPanning = true;
        hasMoved = false;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
        panStartPanX = viewerPanX;
        panStartPanY = viewerPanY;
        viewerImg?.classList.add('dragging');
      }
    }, { passive: true });

    viewerViewport.addEventListener('touchmove', (e: TouchEvent) => {
      if (!isPanning || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - panStartX;
      const dy = e.touches[0].clientY - panStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      viewerPanX = panStartPanX + dx;
      viewerPanY = panStartPanY + dy;
      scheduleDragTransform();
    }, { passive: true });

    viewerViewport.addEventListener('touchend', (e: TouchEvent) => {
      if (isPanning) {
        isPanning = false;
        viewerImg?.classList.remove('dragging');
      }
      const now = Date.now();
      if (now - lastViewerTouchEnd <= 300 && !hasMoved) {
        const touch = e.changedTouches[0];
        toggleViewerDoubleZoom(touch?.clientX, touch?.clientY);
      }
      lastViewerTouchEnd = now;
    });
  }

  // ESC 키로 뷰어 닫기
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && viewer && viewer.style.display !== 'none') {
      closeImageViewer();
    }
  });

  // ── IMAGE CONTEXT MENU (ContextMenu & LongPress)
  let ctxMenuUrl: string | null = null;
  let longPressTimer: any = null;
  const ctxMenu = document.getElementById('img-ctx-menu') as HTMLElement;

  function showImgCtxMenu(x: number, y: number, url: string) {
    if (!ctxMenu) return;
    ctxMenuUrl = url;
    ctxMenu.style.display = 'block';
    const menuW = 200, menuH = 110;
    const vw = window.innerWidth, vh = window.innerHeight;
    ctxMenu.style.left = Math.min(x, vw - menuW - 8) + 'px';
    ctxMenu.style.top  = Math.min(y, vh - menuH - 8) + 'px';
  }
  function hideImgCtxMenu() {
    if (!ctxMenu || ctxMenu.style.display === 'none') return;
    ctxMenu.style.display = 'none';
    ctxMenuUrl = null;
  }

  const ctxView = document.getElementById('img-ctx-view');
  if (ctxView) {
    ctxView.onclick = () => {
      if (ctxMenuUrl) appState.openImageViewer(ctxMenuUrl, 1);
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

  // 상세 본문 이미지: 컨텍스트 메뉴 / 클릭 / 더블클릭 / 롱프레스 (이벤트 위임)
  let detailTouchTime = 0;
  const detailContent = document.getElementById('detail-content');
  if (detailContent) {
    const imgOf = (e: Event) => (e.target as HTMLElement).closest('img') as HTMLImageElement | null;

    detailContent.addEventListener('contextmenu', e => {
      const img = imgOf(e);
      if (!img) return;
      e.preventDefault();
      showImgCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, img.src);
    });

    // 본문 이미지 1회 클릭 시 이미지 뷰어 열기
    detailContent.addEventListener('click', e => {
      const img = imgOf(e);
      if (!img) return;
      appState.openImageViewer(img.src, 1);
    });

    // 본문 이미지 더블클릭 시 즉시 2배 확대 상태로 열기
    detailContent.addEventListener('dblclick', e => {
      const img = imgOf(e);
      if (!img) return;
      e.preventDefault();
      appState.openImageViewer(img.src, 2);
    });

    detailContent.addEventListener('touchstart', e => {
      const img = imgOf(e);
      if (!img) return;
      const touch = e.touches[0];
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        showImgCtxMenu(touch.clientX, touch.clientY, img.src);
      }, 600);
    }, { passive: true });

    detailContent.addEventListener('touchend', e => {
      clearTimeout(longPressTimer);
      const img = imgOf(e);
      if (!img) return;
      const now = Date.now();
      // 모바일 더블 탭 시 2배 확대 뷰어로 즉시 열기
      if (now - detailTouchTime <= 300) {
        e.preventDefault();
        appState.openImageViewer(img.src, 2);
      }
      detailTouchTime = now;
    });

    detailContent.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  }

  // 이미지 뷰어 롱프레스 / 우클릭
  if (viewerImg) {
    const currentUrl = () => viewerDownloadBtn ? viewerDownloadBtn.dataset.url : null;
    viewerImg.addEventListener('contextmenu', e => {
      e.preventDefault();
      const url = currentUrl();
      if (url) showImgCtxMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY, url);
    });
    viewerImg.addEventListener('touchstart', e => {
      const touch = e.touches[0];
      const url = currentUrl();
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (url) showImgCtxMenu(touch.clientX, touch.clientY, url);
      }, 600);
    }, { passive: true });
    viewerImg.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });
    viewerImg.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
  }
}
