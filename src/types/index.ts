import { Timestamp } from 'firebase/firestore';

export interface NoteImage {
  url: string;
  path?: string;
}

export interface Note {
  id?: string;
  uid: string;
  title: string;
  category: string;
  categories?: string[];
  tag: string | null;
  tags?: string[];
  body: string;
  images?: NoteImage[];
  keywords?: string;
  pinned?: boolean;
  pinnedAt?: Timestamp | null;
  locked?: boolean;
  embedding?: number[] | null;
  embeddingUpdatedAt?: Timestamp | null;
  embeddingModel?: string | null; // 예: 'gemini-embedding-001@768' (모델·차원이 다른 벡터는 혼용 불가)
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface NoteIndexItem {
  id: string;
  title: string;
  category: string;
  categories?: string[];
  tag: string;
  tags?: string[];
  snippet: string;
  keywords?: string;
  // 목록 화면을 notes 컬렉션 조회 없이 인덱스만으로 그리기 위한 필드
  // (구버전 인덱스에는 없을 수 있으며, 목록 최초 진입 시 자동 보정됨)
  createdAt?: Timestamp | null;
  pinned?: boolean;
  pinnedAt?: Timestamp | null;
  locked?: boolean;
  embeddingUpdatedAt?: Timestamp | number | null;
  embeddingModel?: string | null;
}

export interface UserMeta {
  categoryCount: Record<string, number>;
  totalNotesCount?: number;
}
