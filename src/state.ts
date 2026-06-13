export const appState: any = {
  handleNoteLinkClick: null,
  openList: null,
  openImageViewer: null,
};

// 인라인 이벤트 핸들러(onclick 등)에서 접근할 수 있도록 window 객체에 상태 객체를 연결합니다.
(window as any).appState = appState;
