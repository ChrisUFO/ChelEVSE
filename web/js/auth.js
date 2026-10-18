// Auth lifecycle: Google sign-in (popup first, redirect only when the popup
// cannot open), the users/{uid} grant check, and sign-out.
//
// Popup is the primary path: Chrome's storage partitioning makes Firebase's
// cross-origin redirect bridge unreliable, so a redirect is a best-effort
// fallback rather than the default.

import {
  auth,
  db,
  doc,
  getDoc,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from './firebase.js';

const REDIRECT_FALLBACK = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
]);

let handlers = {};
let generation = 0;
let currentUser = null;
let activeUid = null;
let accessState = 'signed-out';

function resolveAccess(user, gen) {
  accessState = 'checking';
  return getDoc(doc(db, 'users', user.uid))
    .then((snap) => {
      if (gen !== generation) return;
      if (snap.exists() && snap.data().allowed === true) {
        accessState = 'granted';
        handlers.onGranted(user);
      } else {
        accessState = 'no-access';
        handlers.onNoAccess(user, 'no-access');
      }
    })
    .catch((err) => {
      if (gen !== generation) return;
      // The self-read is allowed, so a denial here means the account is not
      // usable. Anything else is a network/backend problem worth retrying.
      if (err && err.code === 'permission-denied') {
        accessState = 'no-access';
        handlers.onNoAccess(user, 'no-access');
      } else {
        accessState = 'error';
        handlers.onAccessError(user);
      }
    });
}

export function subscribeAuth(next) {
  handlers = next;
  return onAuthStateChanged(auth, (user) => {
    const gen = ++generation;
    currentUser = user;
    if (!user) {
      activeUid = null;
      accessState = 'signed-out';
      handlers.onSignedOut();
      return;
    }
    // Token refreshes re-emit the same user; don't restart the granted app.
    if (user.uid === activeUid && accessState === 'granted') return;
    activeUid = user.uid;
    resolveAccess(user, gen);
  });
}

// Retry the grant check after a network/backend failure. Returns the promise
// so the caller can restore its button state.
export function retryAccess() {
  if (!currentUser) return Promise.resolve();
  const gen = ++generation;
  activeUid = currentUser.uid;
  return resolveAccess(currentUser, gen);
}

// Handle the redirect fallback's return trip. Must run before subscribing:
// onAuthStateChanged then emits the already-restored session.
export async function completeRedirect() {
  try {
    await getRedirectResult(auth);
    return null;
  } catch (err) {
    if (err && err.code === 'auth/redirect-cancelled-by-user') return null;
    return authErrorMessage(err && err.code);
  }
}

export function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider).catch((err) => {
    const code = err && err.code;
    if (REDIRECT_FALLBACK.has(code)) {
      return signInWithRedirect(auth, provider).then(() => ({ redirected: true }));
    }
    throw err;
  });
}

export function signOutUser() {
  return signOut(auth).catch(() => {});
}

export function authErrorMessage(code) {
  const map = {
    'auth/popup-closed-by-user': 'Sign-in window closed. Try again.',
    'auth/cancelled-popup-request': 'Another sign-in attempt is already open. Try again.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow popups and try again.',
    'auth/unauthorized-domain':
      "This site isn't authorised for Google sign-in. Add its domain in Firebase Authentication settings.",
    'auth/network-request-failed': 'Network error — check your connection and try again.',
    'auth/operation-not-supported-in-this-environment':
      "Google sign-in isn't available in this browser. Try opening the app in Chrome.",
    'auth/account-exists-with-different-credential':
      'This email is already linked to a different sign-in method.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  };
  return map[code] || 'Sign-in failed. Try again.';
}
