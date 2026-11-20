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
  computeHybridWeights,
  computeBm25Scores,
  splitTextIntoSearchChunks,
  computeTimeDecayBonus,
  computeProximityRerankBonus,
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

  it('computeHybridWeights는 txtai 가이드에 따라 쿼리 유형별 Dense/Sparse 가중치를 조절해야 한다', () => {
    // 영문/숫자 코드 쿼리는 Sparse(BM25) 비중 우선
    const alnum = computeHybridWeights('a4', 1, true);
    expect(alnum.sparseWeight).toBeGreaterThan(alnum.denseWeight);

    // 자연어 질문형 쿼리는 Dense(시맨틱) 비중 우선
    const ragQuestion = computeHybridWeights('지난번 감기약 복용법이 뭐야?', 3, false);
    expect(ragQuestion.denseWeight).toBeGreaterThan(ragQuestion.sparseWeight);

    // 짧은 키워드형은 균형 유지
    const shortKw = computeHybridWeights('고양이', 1, false);
    expect(shortKw.denseWeight + shortKw.sparseWeight).toBeCloseTo(1);
  });

  it('computeBm25Scores는 반복 등장 빈도와 희귀 단어(IDF)를 반영해 높은 점수를 부여해야 한다', () => {
    const docs = [
      { docLen: 100, termTfs: [1, 0] }, // 흔한 단어 1회
      { docLen: 100, termTfs: [4, 1] }, // 흔한 단어 4회 + 희귀 단어 1회
      { docLen: 100, termTfs: [0, 0] }  // 미포함
    ];
    const docFreqs = [2, 1];
    const { rawScores, maxScore } = computeBm25Scores(docs, docFreqs);
    expect(rawScores[1]).toBeGreaterThan(rawScores[0]);
    expect(rawScores[0]).toBeGreaterThan(0);
    expect(rawScores[2]).toBe(0);
    expect(maxScore).toBe(rawScores[1]);
  });

  it('splitTextIntoSearchChunks는 긴 메모 본문을 오버랩 있는 청크로 분할해야 한다', () => {
    const shortText = '짧은 메모 내용';
    expect(splitTextIntoSearchChunks(shortText, 600, 100)).toEqual([shortText]);

    const longText = '가'.repeat(1300);
    const chunks = splitTextIntoSearchChunks(longText, 600, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].length).toBe(600);
  });

  it('computeTimeDecayBonus는 최신 메모일수록 더 높은 시간 보너스를 반환해야 한다', () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
    expect(computeTimeDecayBonus(threeDaysAgo, now)).toBeGreaterThan(computeTimeDecayBonus(yearAgo, now));
    expect(computeTimeDecayBonus(0, now)).toBe(0);
  });

  it('computeProximityRerankBonus는 연속 구문과 동일 청크 동시 출현 시 리랭크 보너스를 부여해야 한다', () => {
    const bonusExact = computeProximityRerankBonus(
      '감기약 복용법',
      '감기약 복용법 정리',
      '감기약 복용법 정리',
      '감기약 복용법은 식후 30분입니다',
      [['감기약'], ['복용법']]
    );
    const bonusScattered = computeProximityRerankBonus(
      '감기약 복용법',
      '병원 메모',
      '병원 메모',
      '감기약만 적혀 있음',
      [['감기약'], ['복용법']]
    );
    expect(bonusExact).toBeGreaterThan(bonusScattered);
  });
});
