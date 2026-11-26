import { describe, it, expect } from 'vitest';
import { computeWrappedGalleryIndex } from '../src/ui/imageViewer';

describe('이미지 뷰어 순환 갤러리 인덱스 계산', () => {
  it('다음(+1)으로 이동 시 마지막 이미지에서 첫 번째 이미지(0)로 순환해야 한다', () => {
    expect(computeWrappedGalleryIndex(0, 1, 3)).toBe(1);
    expect(computeWrappedGalleryIndex(1, 1, 3)).toBe(2);
    expect(computeWrappedGalleryIndex(2, 1, 3)).toBe(0);
  });

  it('이전(-1)으로 이동 시 첫 번째 이미지(0)에서 마지막 이미지(total - 1)로 순환해야 한다', () => {
    expect(computeWrappedGalleryIndex(0, -1, 3)).toBe(2);
    expect(computeWrappedGalleryIndex(2, -1, 3)).toBe(1);
    expect(computeWrappedGalleryIndex(1, -1, 3)).toBe(0);
  });

  it('단일 이미지(total = 1) 또는 빈 배열(total = 0)에서도 안전하게 0을 반환해야 한다', () => {
    expect(computeWrappedGalleryIndex(0, 1, 1)).toBe(0);
    expect(computeWrappedGalleryIndex(0, -1, 1)).toBe(0);
    expect(computeWrappedGalleryIndex(0, 1, 0)).toBe(0);
  });
});
