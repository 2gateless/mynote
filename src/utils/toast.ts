// Toast 메시지 유틸리티 (Popover API Top Layer 지원 + 연속 호출 시 깜빡임 방지)
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastHideTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string) {
  const t = document.getElementById('toast') as (HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  }) | null;
  if (!t) return;
  if (toastHideTimer) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  t.textContent = msg;
  // Popover API 지원 브라우저에서는 <dialog> Top Layer 위에서도 가려지지 않도록 showPopover 호출
  if (typeof t.showPopover === 'function') {
    try {
      // 이미 열려 있으면 닫았다가 다시 열어 최상위 Top Layer로 끌어올림
      if (t.matches(':popover-open')) {
        t.hidePopover?.();
      }
      t.showPopover();
    } catch {}
  }
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    if (typeof t.hidePopover === 'function') {
      toastHideTimer = setTimeout(() => {
        toastHideTimer = null;
        try {
          if (t.matches(':popover-open')) t.hidePopover?.();
        } catch {}
      }, 320);
    }
  }, 2500);
}
