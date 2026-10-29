import { Timestamp } from 'firebase/firestore';

export interface Note {
  id?: string;
  uid: string;
  title: string;
  category: string;
  tag: string;
  body: string;
  keywords?: string;
  pinned?: boolean;
  pinnedAt?: Timestamp | null;
  locked?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  [key: string]: any;
}

export interface NoteIndexItem {
  id: string;
  title: string;
  category: string;
  tag: string;
  snippet: string;
  keywords?: string;
  // 목록 화면을 notes 컬렉션 조회 없이 인덱스만으로 그리기 위한 필드
  // (구버전 인덱스에는 없을 수 있으며, 목록 최초 진입 시 자동 보정됨)
  createdAt?: Timestamp | null;
  pinned?: boolean;
  pinnedAt?: Timestamp | null;
  locked?: boolean;
}

export interface UserMeta {
  categoryCount: Record<string, number>;
  lockPin?: string;
}
