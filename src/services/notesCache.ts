// ── IndexedDB 기반 메모 인덱스 영구 로컬 캐시 레이어
// localStorage(5MB 한계 및 동기 블로킹)를 대체하여 수천 건의 메모도 0초대로 고속 로드합니다.
import { NoteIndexItem } from '../types';

const DB_NAME = 'mynote_cache_db';
const DB_VERSION = 1;
const STORE_NAME = 'note_index';
const CACHE_KEY = 'all_notes_index';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * IndexedDB에 메모 인덱스 목록 영구 저장 (비동기)
 */
export async function saveNotesToLocalDb(notes: NoteIndexItem[]): Promise<void> {
  if (!Array.isArray(notes)) return;
  const db = await getDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(notes, CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * IndexedDB에서 캐시된 메모 인덱스 목록 읽기 (비동기)
 */
export async function loadNotesFromLocalDb(): Promise<NoteIndexItem[] | null> {
  const db = await getDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(CACHE_KEY);
      req.onsuccess = () => {
        const res = req.result;
        if (Array.isArray(res) && res.length > 0) {
          resolve(res);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 로그아웃 시 로컬 캐시 삭제
 */
export async function clearNotesLocalDb(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

