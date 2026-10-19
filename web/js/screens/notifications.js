// Notification opt-in: permission state, the Enable button, and the FCM token
// lifecycle. Permission is requested only from the Enable click; on load an
// already-granted permission fetches the token and re-saves it only when it
// changed (the last save is remembered per account in localStorage). All errors
// stay inside this card and never break the rest of Config.

import { $, setText } from '../ui.js';
import { notificationState, vapidConfigured } from '../notifications.js';
import { auth, loadMessaging, vapidKey } from '../firebase.js';
import { saveFcmToken } from '../store.js';

const TOKEN_STORAGE_KEY = 'chelevse.fcmToken';
const SW_READY_TIMEOUT_MS = 15000;

let notificationApi = false;
let sessionActive = false;
let sessionGeneration = 0;
let permission = 'default';
let supported = null;
let phase = 'idle';
let error = '';
let message = '';
let busy = false;
let messaging = null;
let supportPromise = null;
let supportFailed = false;
let tokenInFlight = false;
let tokenRestoredFor = null;

function readPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

function hasNotificationApi() {
  return (
    typeof Notification !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

function currentUid() {
  return auth && auth.currentUser && typeof auth.currentUser.uid === 'string'
    ? auth.currentUser.uid
    : '';
}

function readStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.token !== 'string' || typeof parsed.uid !== 'string') return null;
    return { token: parsed.token, uid: parsed.uid };
  } catch {
    return null;
  }
}

function writeStoredToken(token, uid) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, uid }));
  } catch {
    // Private-mode storage failures must not break registration.
  }
}

function tokenErrorMessage(err) {
  const code = err && err.code;
  if (code === 'messaging/permission-blocked') {
    return 'The browser blocked notifications for this site. Allow them in the browser settings, then reload.';
  }
  if (code === 'permission-denied') {
    return 'Couldn’t save this device’s notification token. Check that your account still has access.';
  }
  if (code === 'unavailable') {
    return 'Couldn’t reach the network. Check your connection and try again.';
  }
  if (code === 'sw-timeout') {
    return 'The app isn’t ready to register for notifications yet. Reload the page and try again.';
  }
  if (err && err.message === 'no-token') {
    return 'The browser did not return a notification token. Try again.';
  }
  return 'Couldn’t register this device for notifications. Try again.';
}

// The service worker registers on page load; a waiting `ready` promise keeps
// the card in "Registering…" forever if registration failed, so bound the wait.
function serviceWorkerReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeout = new Error('sw-timeout');
      timeout.code = 'sw-timeout';
      reject(timeout);
    }, SW_READY_TIMEOUT_MS);
    navigator.serviceWorker.ready.then(
      (registration) => {
        clearTimeout(timer);
        resolve(registration);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function ensureSupport() {
  if (supported !== null) return supported;
  if (!hasNotificationApi()) {
    supported = false;
    return false;
  }
  if (!supportPromise) {
    supportPromise = (async () => {
      try {
        messaging = messaging || (await loadMessaging());
        return Boolean(await messaging.isSupported());
      } catch {
        supportFailed = true;
        return false;
      }
    })();
  }
  supported = await supportPromise;
  return supported;
}

function render() {
  const state = notificationState({
    supported,
    permission,
    vapid: vapidConfigured(vapidKey),
    tokenPhase: phase,
  });
  setText($('notify-status'), state.title);
  setText($('notify-detail'), message || state.detail);
  $('notify-card').dataset.state = state.kind;

  const errorNode = $('notify-error');
  errorNode.hidden = !error;
  setText(errorNode, error);

  const enable = $('notify-enable');
  const retry = $('notify-retry');
  enable.hidden = state.action !== 'enable';
  retry.hidden = state.action !== 'retry';
  enable.disabled = busy || tokenInFlight;
  retry.disabled = busy || tokenInFlight;
  setText(enable, busy || tokenInFlight ? 'Enabling…' : 'Enable notifications');
  $('notify-actions').hidden = enable.hidden && retry.hidden;
}

// Save the current device token only when it changed since the last successful
// save (or when the signed-in account changed). `force` is used after an
// explicit enable/retry, where re-registering is the point.
async function registerToken({ force = false, generation = sessionGeneration } = {}) {
  if (tokenInFlight || permission !== 'granted' || !supported || !vapidConfigured(vapidKey)) return;
  const uid = currentUid();
  if (!uid) {
    phase = 'failed';
    error = 'Sign in again to enable notifications.';
    render();
    return;
  }
  const gen = generation;
  tokenInFlight = true;
  phase = 'registering';
  error = '';
  message = '';
  supported = true;
  render();

  try {
    messaging = messaging || (await loadMessaging());
    const registration = await serviceWorkerReady();
    const token = await messaging.getToken(messaging.getMessaging(), {
      vapidKey,
      serviceWorkerRegistration: registration,
    });
    if (!token || typeof token !== 'string') {
      const missing = new Error('no-token');
      throw missing;
    }
    // Signed out while the token request was in flight: never write for a
    // session that no longer exists.
    if (gen !== sessionGeneration || !sessionActive) return;
    const stored = readStoredToken();
    if (force || !stored || stored.token !== token || stored.uid !== uid) {
      await saveFcmToken(token, uid);
      writeStoredToken(token, uid);
    }
    if (gen !== sessionGeneration || !sessionActive) return;
    tokenRestoredFor = uid;
    phase = 'saved';
  } catch (err) {
    if (gen !== sessionGeneration || !sessionActive) return;
    phase = 'failed';
    if (err && err.code === 'messaging/permission-blocked') permission = 'denied';
    error = tokenErrorMessage(err);
  } finally {
    tokenInFlight = false;
    if (gen === sessionGeneration) render();
  }
}

async function refresh({ probe = false, register = false } = {}) {
  if (!sessionActive) return;
  const generation = sessionGeneration;
  permission = readPermission();
  if (permission !== 'default') message = '';
  // A failed SDK probe is retried on the next explicit Config visit (for
  // example after reconnecting), instead of latching "unavailable" for the
  // whole session.
  if (probe && supportFailed) {
    supportFailed = false;
    supported = null;
    supportPromise = null;
    error = '';
  }
  if (!hasNotificationApi()) {
    supported = false;
    render();
    return;
  }
  // No key means opt-in is impossible; say so without downloading messaging.
  if (!vapidConfigured(vapidKey)) {
    supported = true;
    render();
    return;
  }

  if (probe || permission === 'granted') {
    const ok = await ensureSupport();
    if (generation !== sessionGeneration || !sessionActive) return;
    supported = ok;
    if (!ok && supportFailed) {
      error = 'Couldn’t load notification support. Check your connection and try again.';
    }
  }
  const uid = currentUid();
  const willRegister = Boolean(
    supported &&
    permission === 'granted' &&
    register &&
    uid &&
    tokenRestoredFor !== uid &&
    !tokenInFlight,
  );
  // Show "Registering…" before the first await inside registerToken so the
  // retry action never flashes on the way to the token request.
  if (willRegister) phase = 'registering';
  render();

  if (!supported || permission !== 'granted' || !register) return;
  if (!uid || tokenRestoredFor === uid) {
    if (tokenRestoredFor === uid) phase = 'saved';
    render();
    return;
  }
  await registerToken({ force: false, generation });
}

async function enable() {
  if (busy || tokenInFlight || permission !== 'default') return;
  if (typeof Notification === 'undefined') return;
  const generation = sessionGeneration;
  busy = true;
  phase = 'registering';
  error = '';
  message = '';
  render();

  // Must run inside this click handler, before any other await, so the browser
  // still treats the permission request as user-initiated.
  let result;
  try {
    result = await Notification.requestPermission();
  } catch {
    if (generation !== sessionGeneration) return;
    busy = false;
    phase = 'idle';
    error = 'Couldn’t ask for notification permission. Try again.';
    render();
    return;
  }
  if (generation !== sessionGeneration || !sessionActive) return;

  busy = false;
  permission = typeof result === 'string' ? result : readPermission();
  if (permission === 'granted') {
    phase = 'idle';
    render();
    await registerToken({ force: true, generation });
    return;
  }
  phase = 'idle';
  message = permission === 'default' ? 'Permission wasn’t granted. You can try again.' : '';
  render();
}

// ---------- screen lifecycle ----------

export function initNotifications() {
  $('notify-enable').addEventListener('click', enable);
  $('notify-retry').addEventListener('click', () => registerToken({ force: true }));
  notificationApi = hasNotificationApi();
  permission = readPermission();
  supported = notificationApi ? null : false;
  render();
}

// Called once per signed-in session: kicks the load-time token restore when the
// permission is already granted, without ever asking for permission.
export function enterNotifications() {
  sessionActive = true;
  sessionGeneration += 1;
  refresh({ register: true });
}

// Called on every entry to the Config tab; re-reads the permission in case it
// changed in browser settings and probes support on first visit.
export function activateNotifications() {
  if (!sessionActive) return;
  refresh({ probe: true, register: true });
}

export function resetNotifications() {
  sessionActive = false;
  sessionGeneration += 1;
  supported = notificationApi ? null : false;
  permission = readPermission();
  phase = 'idle';
  error = '';
  message = '';
  busy = false;
  tokenInFlight = false;
  tokenRestoredFor = null;
  supportPromise = null;
  supportFailed = false;
  if (!$('notify-card')) return;
  render();
}
