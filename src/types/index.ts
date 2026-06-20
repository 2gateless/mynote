import { Timestamp } from 'firebase/firestore';

export interface Note {
  id?: string;
  uid: string;
  title: string;
  category: string;
  tag: string;
  body: string;
  keywords?: string;
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
}

export interface UserMeta {
  categoryCount: Record<string, number>;
}
