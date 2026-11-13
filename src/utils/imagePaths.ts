import { NoteImage } from '../types';

/**
 * 메모에서 삭제 대상 이미지 경로 전부 수집 (첨부 이미지 + 본문 인라인 이미지)
 * Firebase Storage SDK를 로드하지 않고도 경량으로 경로를 추출하기 위해 분리됨.
 */
export function collectImagePaths(note: { images?: NoteImage[]; body?: string } | null | undefined): string[] {
  const paths: string[] = [];
  (note?.images || []).forEach((img) => {
    if (img.path || img.url) paths.push(img.path || img.url);
  });
  const body = note?.body || '';
  const re = /https:\/\/[^\s)"'<]*firebasestorage[^\s)"'<]+/g;
  (body.match(re) || []).forEach(url => paths.push(url));
  return paths;
}
