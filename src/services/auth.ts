import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './firebase';
import { appState } from '../state';

export const ALLOWED_EMAILS = ['2gateless@gmail.com'];

export function initAuthListener(onAuthSuccess: (user: User) => void, onAuthFailed: (email?: string) => void, onSignedOut: () => void) {
  onAuthStateChanged(auth, user => {
    if (user) {
      if (ALLOWED_EMAILS.includes(user.email || '')) {
        appState.currentUser = user;
        onAuthSuccess(user);
      } else {
        onAuthFailed(user.email || '');
      }
    } else {
      appState.currentUser = null;
      onSignedOut();
    }
  });
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export async function logout() {
  return signOut(auth);
}
