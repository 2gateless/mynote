// Toast 메시지 유틸리티 (연속 호출 시 이전 타이머를 취소해 깜빡임 방지)
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
