import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/firebase', () => ({
  db: {},
  auth: {},
  app: {},
}));

import {
  cosineSimilarity,
  cleanTextForEmbedding,
  extractQueryTermGroups,
  buildNoteEmbeddingInput,
  isCurrentEmbedding,
  EMBEDDING_VERSION,
  EMBEDDING_DIM
} from '../src/services/ai';

describe('ai 서비스 순수 함수', () => {
  it('cosineSimilarity는 동일 벡터에서 1, 직교 벡터에서 0, 길이가 다르면 0을 반환해야 한다', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
  });

  it('cleanTextForEmbedding은 마크다운 이미지와 URL을 제거하고 최대 길이를 제한해야 한다', () => {
    const text = '안녕 ![사진설명](https://example.com/img.png) https://google.com 반가워';
    expect(cleanTextForEmbedding(text)).toBe('안녕 사진설명 반가워');
  });

  it('extractQueryTermGroups는 한국어 조사를 제거하고 불용어를 필터링해야 한다', () => {
    const groups = extractQueryTermGroups('양자역학에 대해서 알려줘');
    expect(groups.some(g => g.includes('양자역학'))).toBe(true);
  });

  it('buildNoteEmbeddingInput은 잠금 메모의 본문을 제외해야 한다', () => {
    const lockedInput = buildNoteEmbeddingInput({
      title: '비밀 메모',
      category: 'family',
      body: '절대 노출되면 안 되는 본문',
      locked: true,
    });
    expect(lockedInput).toContain('비밀 메모');
    expect(lockedInput).not.toContain('절대 노출되면 안 되는 본문');
  });

  it('isCurrentEmbedding은 현재 모델 버전과 차원이 모두 일치할 때만 true를 반환해야 한다', () => {
    const validVec = new Array(EMBEDDING_DIM).fill(0.1);
    expect(isCurrentEmbedding(EMBEDDING_VERSION, validVec)).toBe(true);
    expect(isCurrentEmbedding('text-embedding-004', validVec)).toBe(false);
    expect(isCurrentEmbedding(EMBEDDING_VERSION, [0.1, 0.2])).toBe(false);
  });
});
