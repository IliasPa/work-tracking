import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

const env = import.meta.env;

// When served from Firebase Hosting, use the current host as authDomain so the
// sign-in redirect stays same-origin. Safari (and installed iOS PWAs) partition
// third-party storage, which otherwise breaks getRedirectResult.
const onFirebaseHosting = /\.(web\.app|firebaseapp\.com)$/.test(location.hostname);

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: onFirebaseHosting ? location.hostname : env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);

// Offline-first: reads come from the IndexedDB cache, writes are queued and
// synced when the connection returns. Multi-tab safe.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
