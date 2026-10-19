// Notification opt-in: permission state, the Enable button, and the FCM token
// lifecycle. Permission is requested only from the Enable click; on load an
// already-granted permission fetches the token and re-saves it only when it
// changed (the last save is remembered per account in localStorage). All errors
// stay inside this card and never break the rest of Config.
//
// The token lifecycle itself (session/attempt generations, the in-flight token,
// cache and retry markers) lives in the DOM-free coordinator so the sign-out
// race is covered by test/web; this screen only wires Firebase and paints.

import { $, setText } from '../ui.js';
import {
  OFFLINE_TOKEN_MESSAGE,
  notificationState,
  registrationDecision,
  registrationResult,
  vapidConfigured,
} from '../notifications.js';
import { createTokenLifecycle } from '../notification-session.js';
import { auth, loadMessaging, vapidKey } from '../firebase.js';
import { deleteFcmToken, saveFcmToken } from '../store.js';

const SW_READY_TIMEOUT_MS = 15000;
const RELEASE_RETRY_MS = 5000;

let notificationApi = false;
let permission = 'default';
let supported = null;
let phase = 'idle';
let error = '';
let message = '';
let busy = false;
let messaging = null;
let supportPromise = null;
let supportFailed = false;

const lifecycle = createTokenLifecycle({
  saveTokenDoc: saveFcmToken,
  deleteTokenDoc: deleteFcmToken,
});

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

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// A button that disappears on the next render drops focus to <body>. Move it to
// the status line the user needs to hear instead of the top of the page.
function focusAfterAction(trigger) {
  if (!trigger || !trigger.hidden) return;
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return;
  $('notify-status').focus({ preventScroll: true });
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
  enable.disabled = busy || lifecycle.writing;
  retry.disabled = busy || lifecycle.writing;
  setText(enable, busy || lifecycle.writing ? 'Enabling…' : 'Enable notifications');
  $('notify-actions').hidden = enable.hidden && retry.hidden;
}

// Every signed-in load writes the token document once, even when the token is
// unchanged: the bridge prunes dead tokens server-side (`UnregisteredError`) and
// `acl.py --prune` deletes revoked ones, while the rules deny reads — so a
// cached copy is not evidence the document still exists. The comparison is kept
// for the local cache only.
//
// The whole attempt is bounded by settleWrite inside the lifecycle: an
// unreachable backend must not pin the card on "Registering…" or latch the
// retry button off.
async function registerToken({ force = false } = {}) {
  const uid = currentUid();
  if (!uid) {
    phase = 'failed';
    error = 'Sign in again to enable notifications.';
    render();
    return;
  }
  const decision = registrationDecision({
    requested: true,
    supported,
    permission,
    vapid: vapidConfigured(vapidKey),
    uid,
    online: !isOffline(),
    inFlight: lifecycle.writing,
    restoredForUid: force ? null : lifecycle.restoredFor,
  });
  if (!decision.start) {
    if (decision.reason === 'offline') {
      phase = 'failed';
      error = OFFLINE_TOKEN_MESSAGE;
      render();
    }
    return;
  }

  phase = 'registering';
  error = '';
  message = '';
  supported = true;

  // The FCM registration handed to getToken; a claim-denial rotation reuses it
  // instead of registering the worker again.
  let tokenOptions = null;
  const run = lifecycle.register({
    uid,
    acquire: async () => {
      messaging = messaging || (await loadMessaging());
      const registration = await serviceWorkerReady();
      tokenOptions = { vapidKey, serviceWorkerRegistration: registration };
      return messaging.getToken(messaging.getMessaging(), tokenOptions);
    },
    rotate: async () => {
      await messaging.deleteToken(messaging.getMessaging()).catch(() => {});
      return messaging.getToken(messaging.getMessaging(), tokenOptions);
    },
    onOutcome: (outcome) => {
      const result = registrationResult(outcome);
      if (result.blocked) permission = 'denied';
      phase = result.phase;
      error = result.error;
      render();
    },
  });
  render();
  await run;
}

async function refresh({ probe = false, register = false, force = false } = {}) {
  if (!lifecycle.active) return;
  const generation = lifecycle.generation;
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
    if (generation !== lifecycle.generation || !lifecycle.active) return;
    supported = ok;
    if (!ok && supportFailed) {
      error = 'Couldn’t load notification support. Check your connection and try again.';
    }
  }
  const uid = currentUid();
  const decision = registrationDecision({
    requested: Boolean(register && uid),
    supported,
    permission,
    vapid: vapidConfigured(vapidKey),
    uid,
    online: !isOffline(),
    inFlight: lifecycle.writing,
    restoredForUid: force ? null : lifecycle.restoredFor,
  });
  // Show "Registering…" before the first await inside registerToken so the
  // retry action never flashes on the way to the token request.
  if (decision.start) phase = 'registering';
  else if (decision.reason === 'restored') phase = 'saved';
  else if (decision.reason === 'offline' && phase !== 'saved') {
    // Offline is a retryable failure, not a silent "registering" that never
    // settles.
    phase = 'failed';
    error = OFFLINE_TOKEN_MESSAGE;
  }
  render();

  if (!decision.start) return;
  await registerToken({ force });
}

async function enable() {
  if (busy || lifecycle.writing || permission !== 'default') return;
  if (typeof Notification === 'undefined') return;
  const trigger = $('notify-enable');
  const generation = lifecycle.generation;
  busy = true;
  phase = 'registering';
  error = '';
  message = '';
  render();

  try {
    // Must run inside this click handler, before any other await, so the browser
    // still treats the permission request as user-initiated.
    let result;
    try {
      result = await Notification.requestPermission();
    } catch {
      if (generation !== lifecycle.generation) return;
      busy = false;
      phase = 'idle';
      error = 'Couldn’t ask for notification permission. Try again.';
      render();
      return;
    }
    if (generation !== lifecycle.generation || !lifecycle.active) return;

    busy = false;
    permission = typeof result === 'string' ? result : readPermission();
    if (permission === 'granted') {
      phase = 'idle';
      render();
      await registerToken();
      return;
    }
    phase = 'idle';
    message = permission === 'default' ? 'Permission wasn’t granted. You can try again.' : '';
    render();
  } finally {
    focusAfterAction(trigger);
  }
}

// ---------- screen lifecycle ----------

export function initNotifications() {
  $('notify-enable').addEventListener('click', enable);
  $('notify-retry').addEventListener('click', async () => {
    const trigger = $('notify-retry');
    await registerToken();
    focusAfterAction(trigger);
  });
  notificationApi = hasNotificationApi();
  permission = readPermission();
  supported = notificationApi ? null : false;
  render();
}

// Called once per signed-in session: retries a sign-out release that never
// reached the server, then kicks the load-time token restore when the
// permission is already granted, without ever asking for permission.
export function enterNotifications() {
  lifecycle.begin();
  // A pending delete for this account must land before the session registers a
  // token again, so the retry cannot race the re-save. Bounded so an offline
  // retry cannot delay the card.
  Promise.race([
    lifecycle.retryPending(currentUid()),
    new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS)),
  ]).finally(() => refresh({ register: true }));
}

// Sign-out/revocation hand-over. The token document belongs to the account that
// created it (the rules deny another uid an update), and a device that no longer
// holds the grant must stop receiving that account's alerts, so the owner
// deletes it while the session is still valid and drops the local copy once the
// delete is acknowledged. A failed release keeps the cache and leaves a marker
// for the next sign-in; failure must never block the sign-out.
export async function releaseNotifications() {
  // Only reset the FCM registration when the SDK was actually loaded; there is
  // nothing to unregister otherwise.
  const resetFcm = messaging ? () => messaging.deleteToken(messaging.getMessaging()) : null;
  await lifecycle.release({ resetFcm });
}

// Called on every entry to the Config tab; re-reads the permission in case it
// changed in browser settings and probes support on first visit.
export function activateNotifications() {
  if (!lifecycle.active) return;
  refresh({ probe: true, register: true });
}

// The browser rotated or invalidated this device's push subscription: the
// service worker forwards `pushsubscriptionchange` here because only the page
// holds the FCM SDK. Re-acquire and re-save the token now instead of waiting
// for the next app open, through the same path the card uses (`force` skips
// the once-per-session restore that saved the invalidated token). This path
// never asks for permission: a page without the grant is left alone.
export async function resubscribeNotifications() {
  if (readPermission() !== 'granted') return;
  await refresh({ register: true, force: true });
}

export function resetNotifications() {
  lifecycle.discard();
  // The cached token and the pending-release marker are deliberately kept: a
  // release that failed must stay retryable by the next sign-in instead of
  // being forgotten here.
  supported = notificationApi ? null : false;
  permission = readPermission();
  phase = 'idle';
  error = '';
  message = '';
  busy = false;
  supportPromise = null;
  supportFailed = false;
  if (!$('notify-card')) return;
  render();
}
