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
import { $, initNetwork, initTabbar, routeFor, setCached, setText } from './js/ui.js';
import {
  enterStatus,
  focusStatus,
  blurStatus,
  initStatus,
  leaveStatus,
  showCommands,
  showConfig as showStatusConfig,
  showSettings,
  showStatus,
  showStatusError,
  showStatusSchedule,
} from './js/screens/status.js';
import { initConfig, resetConfig, showConfigData, showConfigError } from './js/screens/config.js';
import { initSettings, resetSettings, showSettingsData } from './js/screens/settings.js';
import {
  activateNotifications,
  enterNotifications,
  initNotifications,
  releaseNotifications,
  resetNotifications,
} from './js/screens/notifications.js';
import {
  enterAdvanced,
  initAdvanced,
  leaveAdvanced,
  resetAdvanced,
  showRapiCommands,
  showRapiError,
} from './js/screens/advanced.js';
import {
  activateHistory,
  enterHistory,
  initHistory,
  resetHistory,
  showHistorySettings,
} from './js/screens/history.js';
import {
  activateSchedule,
  enterSchedule,
  initSchedule,
  resetSchedule,
  showLiveStatus,
  showSchedule,
  showScheduleError,
} from './js/screens/schedule.js';

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
// Sign-out waits for the token release, but never indefinitely.
const SIGN_OUT_RELEASE_MS = 3000;

function setSignInBusy(busy) {
  $('google-signin').disabled = busy;
  setText($('google-signin-label'), busy ? 'Signing in…' : 'Sign in with Google');
}

function closeApp() {
  stopStore();
  leaveStatus();
  resetHistory();
  resetSchedule();
  resetConfig();
  resetSettings();
  resetNotifications();
  resetAdvanced();
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

// Tab activation: start/stop the status clock and load history on first visit.
// Screens keep their own state; only the visible work changes.
function handleRoute(route) {
  if (!activeUser) return;
  if (route === 'status') focusStatus();
  else blurStatus();
  if (route === 'history') activateHistory();
  if (route === 'schedule') activateSchedule();
  if (route === 'config') activateNotifications();
  // The RAPI gate is per visit: entering the tab re-arms it; leaving drops any
  // pending confirmation. Re-clicking the active tab is not a new entry.
  if (route === 'advanced') enterAdvanced();
  else leaveAdvanced();
}

function enterApp(user) {
  activeUser = user;
  setSignInBusy(false);
  showScreen('app');
  startStore({
    onStatus: (snap) => {
      if (!snap) {
        showStatusError();
        showLiveStatus(null);
        return;
      }
      setCached(snap.metadata.fromCache);
      const data = snap.data();
      showStatus(snap);
      showLiveStatus(data);
    },
    onCommands: showCommands,
    onSettings: (settings) => {
      showSettings(settings);
      showHistorySettings(settings);
      showSettingsData(settings);
    },
    onConfig: (data) => {
      showStatusConfig(data);
      showConfigData(data);
    },
    onConfigError: showConfigError,
    onSchedule: (data) => {
      showSchedule(data);
      showStatusSchedule(data);
    },
    onScheduleError: showScheduleError,
    onRapiCommands: showRapiCommands,
    onRapiError: showRapiError,
    onAccessDenied: () => {
      if (activeUser) showNoAccess(activeUser, 'no-access');
    },
  });
  enterStatus();
  enterHistory();
  enterSchedule();
  enterNotifications();
  handleRoute(routeFor(location.hash));
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

async function handleSignOut() {
  setText($('signin-error'), '');
  // Release this device's push registration while the old account is still
  // signed in (the rules key the delete on its uid), then end the session. A
  // stalled backend must not trap the user in a session they asked to leave, so
  // the release is best-effort and bounded.
  await Promise.race([
    releaseNotifications(),
    new Promise((resolve) => setTimeout(resolve, SIGN_OUT_RELEASE_MS)),
  ]);
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
  initHistory();
  initSchedule();
  initConfig();
  initSettings();
  initNotifications();
  initAdvanced();
  initTabbar({ onRoute: handleRoute });
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
