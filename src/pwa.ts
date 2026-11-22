import { stopAllVideos } from './utils/formatter';
import { isDialogOpen } from './ui/dom';

export function currentScreen(): string {
  if (isDialogOpen('pin-modal')) return 'pin-modal';
  if (isDialogOpen('ai-config-modal')) return 'ai-config-modal';
  if (isDialogOpen('img-viewer')) return 'img-viewer';
  if (isDialogOpen('note-link-modal')) return 'note-link-modal';
  if (isDialogOpen('note-modal')) return 'modal';
  if (isDialogOpen('del-modal')) return 'del-modal';
  const active = document.querySelector('.screen.active');
  return active ? active.id.replace('screen-', '') : 'home';
}

export function showAppScreen(name: string) {
  if (name !== 'detail') {
    stopAllVideos();
  }
  const applySwitch = () => {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name)?.classList.add('active');
    window.scrollTo(0, 0);
  };

  const active = document.querySelector('.screen.active');
  const prevName = active ? active.id.replace('screen-', '') : '';
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Same-Document View Transitions API (지원 브라우저 & 모션 축소 비활성 시에만 적용)
  const docAny = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  if (prevName && prevName !== name && !prefersReducedMotion && typeof docAny.startViewTransition === 'function') {
    try {
      docAny.startViewTransition(applySwitch);
      return;
    } catch {
      // 폴백으로 즉시 전환
    }
  }
  applySwitch();
}

export function showRootScreen(name: string) {
  ['loading-screen', 'auth-screen', 'denied-screen', 'app'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(name);
  if (el) {
    el.style.display = name === 'app' ? 'block' : 'flex';
    if (name !== 'app') el.style.flexDirection = 'column';
  }
}

// PWA의 뒤로가기 동작 및 팝스테이트 리스너 초기화
export function initPwaNavigation(onNavigateBack: (screen: string) => void) {
  window.addEventListener('popstate', () => {
    const screen = currentScreen();
    onNavigateBack(screen);
  });
  // 초기 히스토리 엔트리 생성
  history.pushState(null, '', location.href);
}

// 프로덕션 환경에서 오프라인 앱 셸 캐싱을 위한 서비스 워커 등록
export function registerServiceWorker() {
  if (!(import.meta as any).env?.PROD) return;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const base = (import.meta as any).env?.BASE_URL || '/mynote/';
      navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(err => {
        console.warn('Service Worker 등록 실패:', err);
      });
    });
  }
}
