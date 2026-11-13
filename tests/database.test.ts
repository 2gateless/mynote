import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/firebase', () => ({
  db: {},
  auth: {},
  app: {},
}));

import { getNoteCategories, getNoteTags } from '../src/services/database';
import { collectImagePaths } from '../src/utils/imagePaths';

describe('database 및 imagePaths 헬퍼', () => {
  it('getNoteCategories는 복수 categories와 구버전 단일 category를 안전하게 정규화해야 한다', () => {
    expect(getNoteCategories(null)).toEqual([]);
    expect(getNoteCategories({ category: 'memory' })).toEqual(['memory']);
    expect(getNoteCategories({ categories: ['memory', 'ref_science', 'memory', 'invalid_cat'] })).toEqual([
      'memory',
      'ref_science',
    ]);
  });

  it('getNoteTags는 중복 및 빈 문자열을 제거해 태그 배열을 반환해야 한다', () => {
    expect(getNoteTags(null)).toEqual([]);
    expect(getNoteTags({ tag: ' 물리 ' })).toEqual(['물리']);
    expect(getNoteTags({ tags: ['물리', '', '  ', '화학', '물리'] })).toEqual(['물리', '화학']);
  });

  it('collectImagePaths는 첨부 이미지와 본문 인라인 Firebase Storage URL을 모두 추출해야 한다', () => {
    const paths = collectImagePaths({
      images: [{ url: 'https://example.com/a.jpg', path: 'notes/u1/a.jpg' }],
      body: '본문 ![img](https://firebasestorage.googleapis.com/v0/b/mynote/o/notes%2F1.jpg?alt=media)',
    });
    expect(paths).toEqual([
      'notes/u1/a.jpg',
      'https://firebasestorage.googleapis.com/v0/b/mynote/o/notes%2F1.jpg?alt=media',
    ]);
  });
});
