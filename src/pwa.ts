import { appState } from './state';
import { stopAllVideos } from './utils/formatter';

export function currentScreen(): string {
  if (document.getElementById('note-modal')?.style.display !== 'none') return 'modal';
  if (document.getElementById('del-modal')?.style.display !== 'none') return 'del-modal';
  if (document.getElementById('share-modal')?.style.display !== 'none') return 'share-modal';
  const active = document.querySelector('.screen.active');
  return active ? active.id.replace('screen-', '') : 'home';
}

export function showAppScreen(name: string) {
  if (name !== 'detail') {
    stopAllVideos();
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name)?.classList.add('active');
  window.scrollTo(0, 0);
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
