import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './firebase';
import { appState } from '../state';

// 환경변수(VITE_ALLOWED_EMAILS, 쉼표 구분)로 허용 계정 오버라이드 지원 (미설정 시 기본값 폴백)
const ENV_ALLOWED = (import.meta as any).env?.VITE_ALLOWED_EMAILS as string | undefined;
export const ALLOWED_EMAILS = ENV_ALLOWED
  ? ENV_ALLOWED.split(',').map(e => e.trim()).filter(Boolean)
  : ['2gateless@gmail.com'];

let isHandlingDeniedSignOut = false;

export function initAuthListener(onAuthSuccess: (user: User) => void, onAuthFailed: (email?: string) => void, onSignedOut: () => void) {
  onAuthStateChanged(auth, user => {
    if (user) {
      if (ALLOWED_EMAILS.includes(user.email || '')) {
        isHandlingDeniedSignOut = false;
        appState.currentUser = user;
        onAuthSuccess(user);
      } else {
        appState.currentUser = null;
        const deniedEmail = user.email || '';
        isHandlingDeniedSignOut = true;
        onAuthFailed(deniedEmail);
        // 권한 없는 계정은 즉시 세션 토큰을 파기하되, 방금 띄운 접근 거부 화면은 유지
        signOut(auth).catch(console.error);
      }
    } else {
      appState.currentUser = null;
      if (isHandlingDeniedSignOut) {
        isHandlingDeniedSignOut = false;
        return;
      }
      onSignedOut();
    }
  });
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export async function logout() {
  isHandlingDeniedSignOut = false;
  return signOut(auth);
}
