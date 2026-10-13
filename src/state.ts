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

  // allNotesCache 갱신 시 한 번만 계산해 두는 파생 데이터 (검색/링크 성능용)
  searchIndex: [] as { note: any; text: string }[], // 소문자화된 검색용 텍스트
  notesByTitle: new Map<string, any>(),              // 제목 → 메모 (메모 링크 O(1) 조회)
  sortedNotesByTitle: null as any[] | null,          // 제목순 정렬본 (메모 링크 모달용, 지연 계산)

  // 콜백/구독 관리용 훅 및 유틸리티 매핑
  handleNoteLinkClick: null,
  openList: null,
  openImageViewer: null,
};

// 디버깅 편의를 위해 window 객체에 상태 객체를 연결합니다. (인라인 onclick은 더 이상 사용하지 않음)
(window as any).appState = appState;
