import { ref, uploadString, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../services/firebase';
import { appState } from '../state';

// 이미지 압축 및 dataUrl 생성
export async function compressImage(file: File, maxW = 800, maxH = 800, quality = 0.6): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const reader = new FileReader();
    reader.onload = ev => res(ev.target?.result as string);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
  
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  
  let { width: w, height: h } = img;
  if (w > maxW || h > maxH) {
    const ratio = Math.min(maxW / w, maxH / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }
  
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
  
  return canvas.toDataURL('image/jpeg', quality);
}

// Storage에 업로드
export async function uploadImageToStorage(base64DataUrl: string, fileName: string, pathPrefix = 'notes'): Promise<{ url: string; path: string }> {
  if (!appState.currentUser) {
    throw new Error('인증 정보가 없습니다.');
  }
  const path = `${pathPrefix}/${appState.currentUser.uid}/${Date.now()}_${fileName}`;
  const sRef = ref(storage, path);
  const base64Data = base64DataUrl.split(',')[1];
  await uploadString(sRef, base64Data, 'base64');
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
