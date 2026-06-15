export const appState: any = {
  // 전역 상태 변수들
  currentUser: null,
  currentCat: null,
  currentTag: null,
  currentNote: null,
  editingNoteId: null,
  deleteTargetId: null,
  pendingImages: [],
  existingImages: [],
  allNotesCache: [],

  // 콜백/구독 관리용 훅 및 유틸리티 매핑
  handleNoteLinkClick: null,
  openList: null,
  openImageViewer: null,
};

// 인라인 이벤트 핸들러(onclick 등)에서 접근할 수 있도록 window 객체에 상태 객체를 연결합니다.
(window as any).appState = appState;
