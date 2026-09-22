import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { auth } from './firebase';

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

/** Installed PWA? Popups fail silently there, especially on iOS. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export async function signIn(): Promise<void> {
  if (isStandalone()) {
    await signInWithRedirect(auth, provider);
    return;
  }
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const code = (e as { code?: string }).code;
    // Browser blocked the popup: fall back to a full-page redirect.
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
    throw e;
  }
}

/** Completes a redirect sign-in, if one is in progress. Surfaces its error. */
export function completeRedirect(): Promise<unknown> {
  return getRedirectResult(auth);
}

export function signOut(): Promise<void> {
  return fbSignOut(auth);
}

export function watchUser(cb: (u: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
}
