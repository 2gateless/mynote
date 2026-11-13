import { User } from 'firebase/auth';
import { Note, NoteImage, NoteIndexItem } from './types';

export interface SearchIndexEntry {
  note: NoteIndexItem;
  text: string;
}

export interface AppState {
  currentUser: User | null;
  currentCat: string | null;
  currentTag: string | null;
  currentNote: Note | null;
  editingNoteId: string | null;
  deleteTargetId: string | null;
  existingImages: NoteImage[];
  allNotesCache: NoteIndexItem[];
  isAllNotesComplete: boolean;
  // 보안: PIN은 평문으로 메모리에 보관하지 않으며, Web Crypto 해시로만 검증합니다.

  // allNotesCache 갱신 시 필요 시점에만 지연 계산해 두는 파생 데이터 (검색/링크 성능용)
  searchIndex: SearchIndexEntry[] | null;
  notesByTitle: Map<string, NoteIndexItem> | null;
  sortedNotesByTitle: NoteIndexItem[] | null;

  // 콜백/구독 관리용 훅 및 유틸리티 매핑
  handleNoteLinkClick: ((el: HTMLElement) => void) | null;
  getNotesByTitle: (() => Map<string, NoteIndexItem>) | null;
  openList: ((catId: string, tag?: string | null) => void) | null;
  openImageViewer: ((url: string, initialScale?: number) => void) | null;
  closeImageViewer: (() => void) | null;
}

export const appState: AppState = {
  currentUser: null,
  currentCat: null,
  currentTag: null,
  currentNote: null,
  editingNoteId: null,
  deleteTargetId: null,
  existingImages: [],
  allNotesCache: [],
  isAllNotesComplete: false,

  searchIndex: null,
  notesByTitle: null,
  sortedNotesByTitle: null,

  handleNoteLinkClick: null,
  getNotesByTitle: null,
  openList: null,
  openImageViewer: null,
  closeImageViewer: null,
};

// 개발 모드 디버깅 편의를 위해 window 객체에 상태 객체를 연결합니다.
if ((import.meta as any).env?.DEV && typeof window !== 'undefined') {
  (window as any).appState = appState;
}
