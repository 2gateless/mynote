import { ref, uploadString, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { auth, storage } from '../services/firebase';
import { appState } from '../state';

// 재인코딩 없이 원본을 그대로 올려도 되는 최대 크기 (1.5MB)
const PASSTHROUGH_MAX_BYTES = 1.5 * 1024 * 1024;

// 비동기 작업이 무한 대기 상태에 빠지지 않도록 타임아웃을 걸어주는 헬퍼
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// 이미지 디코딩: createImageBitmap 우선, 실패/지연 시 <img> + ObjectURL로 폴백
async function decodeImage(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await withTimeout(createImageBitmap(blob), 8000, '비트맵 디코딩 시간 초과');
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch (e) {
      // 일부 포맷이나 모바일 웹뷰에서 실패/지연될 경우 아래 <img> 폴백으로 진행
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await withTimeout(
      new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('이미지 디코딩 실패'));
        i.src = url;
      }),
      10000,
      '이미지 로딩 시간 초과'
    );
    // 주의: drawImage 호출 전까지 ObjectURL이 유지되어야 하므로 close()에서 해제한다
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return withTimeout(
    new Promise<Blob>((res, rej) => {
      canvas.toBlob(b => (b ? res(b) : rej(new Error('이미지 변환 실패'))), type, quality);
    }),
    10000,
    '이미지 압축 변환 시간 초과'
  );
}

// 이미지 압축 (문서/텍스트 가독성을 위해 고해상도 2560px, 품질 0.88 기본 적용)
export async function compressImage(file: File, maxW = 2560, maxH = 2560, quality = 0.88): Promise<Blob> {
  // OS 파일 핸들/클립보드 스트림이 비동기 경계나 input 초기화 후 무효화되는 현상(ERR_UPLOAD_FILE_CHANGED 등)을
  // 방지하기 위해 즉시 메모리 버퍼(Blob)로 복사한다.
  const rawBuffer = await withTimeout(file.arrayBuffer(), 10000, '이미지 파일을 읽는 중 시간이 초과되었습니다.');
  const mimeType = file.type || 'image/jpeg';
  const memoryBlob = new Blob([rawBuffer], { type: mimeType });

  // GIF는 애니메이션 보존을 위해 메모리 복사본을 그대로 업로드
  if (mimeType === 'image/gif') return memoryBlob;

  const decoded = await decodeImage(memoryBlob);
  try {
    let w = decoded.width;
    let h = decoded.height;
    const needsResize = w > maxW || h > maxH;

    // 이미 충분히 작고 웹 친화적인 포맷이면 재인코딩 생략 (메모리에 복사된 안전 Blob 반환)
    const webFriendly = mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp';
    if (!needsResize && webFriendly && memoryBlob.size <= PASSTHROUGH_MAX_BYTES) {
      return memoryBlob;
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
    if (!ctx) return memoryBlob;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, w, h);

    // PNG(스크린샷 등 투명도 가능)는 WebP 우선 시도 후 실패 시 JPEG로 폴백
    const isPngLike = mimeType === 'image/png' || mimeType === 'image/webp';
    let blob: Blob;
    try {
      blob = await canvasToBlob(canvas, isPngLike ? 'image/webp' : 'image/jpeg', quality);
    } catch {
      blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    }

    // 재인코딩 결과가 원본보다 크고 리사이즈도 필요 없었다면 메모리 복사본 사용
    if (!needsResize && webFriendly && blob.size >= memoryBlob.size) return memoryBlob;
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

// Storage에 업로드 (Uint8Array 메모리 전송으로 모바일/웹뷰 Blob 스트림 멈춤 현상 방지)
export async function uploadImageToStorage(data: Blob | string, fileName: string, pathPrefix = 'notes'): Promise<{ url: string; path: string }> {
  // 앱 실행 직후(낙관적 UI 캐시 상태) 아직 Firebase Auth 복원이 진행 중일 수 있으므로 대기
  if (!appState.currentUser) {
    try {
      await withTimeout(auth.authStateReady(), 8000, '인증 준비 시간 초과');
      if (auth.currentUser) appState.currentUser = auth.currentUser;
    } catch (e) {
      // 아래에서 currentUser 유무 재확인
    }
  }
  const user = appState.currentUser || auth.currentUser;
  if (!user) {
    throw new Error('로그인 인증 정보가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
  }

  const path = `${pathPrefix}/${user.uid}/${Date.now()}_${fileName}`;
  const sRef = ref(storage, path);

  const doUpload = async () => {
    if (typeof data === 'string') {
      await uploadString(sRef, data, 'data_url');
    } else {
      // Blob 대신 순수 메모리 바이트(Uint8Array)로 전달하여 XHR multipart Blob 스트림 멈춤 방지
      const bytes = new Uint8Array(await data.arrayBuffer());
      await uploadBytes(sRef, bytes, { contentType: data.type || 'image/jpeg' });
    }
    const url = await getDownloadURL(sRef);
    return { url, path };
  };

  return withTimeout(doUpload(), 25000, '이미지 업로드 시간이 초과되었습니다. 네트워크 상태를 확인 후 다시 시도해주세요.');
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
