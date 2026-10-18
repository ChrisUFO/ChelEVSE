// Auth lifecycle: sign-in, sign-out, error copy. The grant check lives here in
// the identity unit; for now this mirrors the v0 email/password flow.

import { auth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from './firebase.js';

export function subscribeAuth(next) {
  return onAuthStateChanged(auth, next);
}

export async function signInWithEmail(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export function signOutUser() {
  return signOut(auth).catch(() => {});
}

export function signInErrorMessage(code) {
  const map = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-login-credentials': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/invalid-email': 'That email address does not look valid.',
    'auth/network-request-failed': 'Network error — check your connection and try again.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  };
  return map[code] || 'Sign-in failed. Try again.';
}
