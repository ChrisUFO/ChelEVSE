// Boot only: load Firebase, wire the sign-in/out shell, then hand control to
// the auth lifecycle. Screen rendering lives in js/screens/.

import { initFirebase } from './js/firebase.js';
import {
  authErrorMessage,
  completeRedirect,
  retryAccess,
  signInWithGoogle,
  signOutUser,
  subscribeAuth,
} from './js/auth.js';
import { startStore, stopStore } from './js/store.js';
import { $, initNetwork, initTabbar, setCached, setText } from './js/ui.js';
import {
  enterStatus,
  initStatus,
  leaveStatus,
  showCommands,
  showStatus,
  showStatusError,
} from './js/screens/status.js';

const SCREENS = ['booting', 'boot-error', 'signin', 'noaccess', 'app'];

let activeUser = null;
let currentScreen = 'booting';

function showScreen(id) {
  const changed = currentScreen !== id;
  currentScreen = id;
  for (const name of SCREENS) $(name).hidden = name !== id;
  return changed;
}

function bootFail(title, body) {
  setText($('boot-title'), title);
  setText($('boot-body'), body);
  showScreen('boot-error');
}

// If the redirect fallback never navigates (installed PWAs and some in-app
// browsers swallow it), the page stays here with a disabled button. Restore
// the button after a bounded wait so retrying does not need a reload.
const REDIRECT_RECOVERY_MS = 4000;

function setSignInBusy(busy) {
  $('google-signin').disabled = busy;
  setText($('google-signin-label'), busy ? 'Signing in…' : 'Sign in with Google');
}

function closeApp() {
  stopStore();
  leaveStatus();
  activeUser = null;
}

function showSignedOut() {
  closeApp();
  setSignInBusy(false);
  showScreen('signin');
  $('google-signin').focus({ preventScroll: true });
}

function showNoAccess(user, reason) {
  closeApp();
  setSignInBusy(false);
  const checkFailed = reason === 'error';
  const account = user && (user.email || user.displayName);
  setText($('noaccess-email'), account || 'Signed-in account');
  setText($('noaccess-eyebrow'), checkFailed ? 'Connection problem' : 'Access restricted');
  setText($('noaccess-title'), checkFailed ? "Couldn't check access" : "You're not on the list");
  $('noaccess-glyph').setAttribute('href', checkFailed ? '#i-retry' : '#i-lock');
  const retry = $('noaccess-retry');
  retry.hidden = !checkFailed;
  setText(
    $('noaccess-reason'),
    reason === 'error'
      ? "We couldn't check your access. Check your connection and try again."
      : 'Ask the owner to add your email to the charger, then sign in again.',
  );
  if (showScreen('noaccess')) $('noaccess-title').focus({ preventScroll: true });
}

function enterApp(user) {
  activeUser = user;
  setSignInBusy(false);
  showScreen('app');
  startStore({
    onStatus: (snap) => {
      if (!snap) {
        showStatusError();
        return;
      }
      setCached(snap.metadata.fromCache);
      showStatus(snap);
    },
    onCommands: showCommands,
    onAccessDenied: () => {
      if (activeUser) showNoAccess(activeUser, 'no-access');
    },
  });
  enterStatus();
  const activeTab = document.querySelector('.tab[aria-selected="true"]');
  if (activeTab) activeTab.focus({ preventScroll: true });
}

async function handleGoogleSignIn() {
  setText($('signin-error'), '');
  setSignInBusy(true);
  try {
    const result = await signInWithGoogle();
    if (result && result.redirected) {
      setTimeout(() => {
        if (currentScreen !== 'signin' || !$('google-signin').disabled) return;
        setSignInBusy(false);
        setText(
          $('signin-error'),
          'Sign-in did not finish. Try again, or open this page in your browser.',
        );
        $('google-signin').focus();
      }, REDIRECT_RECOVERY_MS);
    }
  } catch (err) {
    setSignInBusy(false);
    setText($('signin-error'), authErrorMessage(err && err.code));
    $('google-signin').focus();
  }
}

async function handleRetryAccess() {
  const btn = $('noaccess-retry');
  btn.disabled = true;
  setText($('noaccess-reason'), 'Checking access…');
  await retryAccess();
  btn.disabled = false;
}

function handleSignOut() {
  setText($('signin-error'), '');
  signOutUser();
}

function wireUi() {
  $('google-signin').addEventListener('click', handleGoogleSignIn);
  $('noaccess-retry').addEventListener('click', handleRetryAccess);
  $('noaccess-signout').addEventListener('click', handleSignOut);
  $('signout').addEventListener('click', handleSignOut);
  initNetwork();
}

async function main() {
  try {
    await initFirebase();
  } catch (err) {
    if (err && err.kind === 'config') {
      bootFail(
        'Configuration missing',
        'Copy web/firebase-config.example.js to web/firebase-config.js, fill in your Firebase project values, and reload this page.',
      );
    } else {
      bootFail(
        'Could not load the app',
        'The Firebase SDK failed to load. Check your connection and reload this page.',
      );
    }
    return;
  }

  initStatus();
  initTabbar();
  wireUi();

  // The redirect fallback lands back here; surface a failure on the sign-in
  // card, then let onAuthStateChanged emit the restored session.
  const redirectError = await completeRedirect();
  subscribeAuth({
    onSignedOut: showSignedOut,
    onGranted: enterApp,
    onNoAccess: showNoAccess,
    onAccessError: (user) => showNoAccess(user, 'error'),
  });
  if (redirectError) setText($('signin-error'), redirectError);
}

main();
