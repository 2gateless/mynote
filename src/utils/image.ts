import { ref, uploadString, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../services/firebase';
import { appState } from '../state';

// 재인코딩 없이 원본을 그대로 올려도 되는 최대 크기 (1.5MB)
const PASSTHROUGH_MAX_BYTES = 1.5 * 1024 * 1024;

// 이미지 디코딩: createImageBitmap 우선(빠르고 메모리 효율적), 실패 시 <img> + ObjectURL로 폴백
async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch (e) {
      // 일부 포맷(HEIC 등)은 브라우저에 따라 실패할 수 있으므로 아래 폴백으로 진행
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) => {
    canvas.toBlob(b => (b ? res(b) : rej(new Error('이미지 변환 실패'))), type, quality);
  });
}

// 이미지 압축 (문서/텍스트 가독성을 위해 고해상도 2560px, 품질 0.88 기본 적용)
// Base64 변환 없이 Blob으로 반환하여 메모리 사용량과 전송량(약 33%)을 줄인다.
export async function compressImage(file: File, maxW = 2560, maxH = 2560, quality = 0.88): Promise<Blob> {
  // GIF는 애니메이션 보존을 위해 그대로 업로드
  if (file.type === 'image/gif') return file;

  const decoded = await decodeImage(file);
  try {
    let w = decoded.width;
    let h = decoded.height;
    const needsResize = w > maxW || h > maxH;

    // 이미 충분히 작고 웹 친화적인 포맷이면 재인코딩 생략 (화질 손실·CPU 낭비 방지)
    const webFriendly = file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp';
    if (!needsResize && webFriendly && file.size <= PASSTHROUGH_MAX_BYTES) {
      return file;
    }

    if (needsResize) {
      const ratio = Math.min(maxW / w, maxH / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, w, h);

    // PNG(스크린샷 등 투명도 가능)는 WebP로 — 미지원 브라우저는 자동으로 PNG로 폴백됨
    // 그 외(사진 등)는 JPEG
    const isPngLike = file.type === 'image/png' || file.type === 'image/webp';
    const blob = await canvasToBlob(canvas, isPngLike ? 'image/webp' : 'image/jpeg', quality);

    // 재인코딩 결과가 원본보다 크고 리사이즈도 필요 없었다면 원본 사용
    if (!needsResize && webFriendly && blob.size >= file.size) return file;
    return blob;
  } finally {
    decoded.close();
  }
}

// Blob의 MIME 타입에 맞는 확장자로 파일명 생성
export function imageFileName(prefix: string, blob: Blob): string {
  const t = blob.type;
  const ext = t.includes('png') ? 'png'
    : t.includes('webp') ? 'webp'
    : t.includes('gif') ? 'gif'
    : t.includes('heic') ? 'heic'
    : t.includes('heif') ? 'heif'
    : 'jpg';
  return `${prefix}_${Date.now()}.${ext}`;
}

// Storage에 업로드 (Blob 권장, 하위 호환을 위해 Base64 dataURL도 지원)
export async function uploadImageToStorage(data: Blob | string, fileName: string, pathPrefix = 'notes'): Promise<{ url: string; path: string }> {
  if (!appState.currentUser) {
    throw new Error('인증 정보가 없습니다.');
  }
  const path = `${pathPrefix}/${appState.currentUser.uid}/${Date.now()}_${fileName}`;
  const sRef = ref(storage, path);
  if (typeof data === 'string') {
    await uploadString(sRef, data, 'data_url');
  } else {
    await uploadBytes(sRef, data, { contentType: data.type || 'image/jpeg' });
  }
  const url = await getDownloadURL(sRef);
  return { url, path };
}

// Storage에서 이미지 파일 삭제 (경로 또는 다운로드 URL 모두 지원)
export async function deleteImageFromStorage(pathOrUrl: string) {
  try {
    await deleteObject(ref(storage, pathOrUrl));
  } catch (e: any) {
    // 이미 삭제된 파일이면 조용히 넘어감
    if (e?.code !== 'storage/object-not-found') {
      console.error('이미지 삭제 오류:', pathOrUrl, e);
    }
  }
}

// 여러 이미지를 병렬로 삭제 (개별 실패는 deleteImageFromStorage 내부에서 처리)
export async function deleteImagesFromStorage(paths: string[]) {
  await Promise.all(paths.map(p => deleteImageFromStorage(p)));
}

// 메모에서 삭제 대상 이미지 경로 전부 수집 (첨부 이미지 + 본문 인라인 이미지)
export function collectImagePaths(note: any): string[] {
  const paths: string[] = [];
  (note?.images || []).forEach((i: any) => {
    if (i.path || i.url) paths.push(i.path || i.url);
  });
  // 본문 마크다운 속 Firebase Storage 인라인 이미지 URL 찾기
  const body: string = note?.body || '';
  const re = /https:\/\/[^\s)"'<]*firebasestorage[^\s)"'<]+/g;
  (body.match(re) || []).forEach(u => paths.push(u));
  return paths;
}
