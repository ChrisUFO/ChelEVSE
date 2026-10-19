// Notification opt-in: permission state, the Enable button, and the FCM token
// lifecycle. Permission is requested only from the Enable click; on load an
// already-granted permission fetches the token and re-saves it only when it
// changed (the last save is remembered per account in localStorage). All errors
// stay inside this card and never break the rest of Config.

import { $, setText } from '../ui.js';
import {
  OFFLINE_TOKEN_MESSAGE,
  isTokenClaimDenial,
  notificationState,
  registrationDecision,
  registrationResult,
  tokenReleasePlan,
  vapidConfigured,
} from '../notifications.js';
import { auth, loadMessaging, vapidKey } from '../firebase.js';
import { deleteFcmToken, saveFcmToken } from '../store.js';
import { settleWrite } from '../write.js';

const TOKEN_STORAGE_KEY = 'chelevse.fcmToken';
// A sign-out whose token-doc delete never reached the server leaves a marker
// behind; the next session of that account retries the delete instead of
// leaving the doc to deny the next account's save. A registration that is
// still writing its document can add its own marker after sign-out, so this
// is a list rather than a single pending token.
const RELEASE_STORAGE_KEY = 'chelevse.fcmPendingRelease';
const SW_READY_TIMEOUT_MS = 15000;
const RELEASE_RETRY_MS = 5000;
const RELEASE_WRITE_MS = 5000;

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
// The token this session obtained, recorded as soon as the browser returns it
// and before its document write starts. The local cache is only written after
// the write settles, so a sign-out that lands while the write is in flight
// needs this to know which document to release.
let inFlightToken = null;
// Bumped per registration attempt so a timed-out write that settles later can
// never overwrite the outcome of a newer retry.
let registrationGeneration = 0;

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

function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Same tolerance as writeStoredToken.
  }
}

function readPendingReleases() {
  try {
    const raw = localStorage.getItem(RELEASE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Older builds stored one marker object; accept both shapes.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (item) => item && typeof item.token === 'string' && typeof item.uid === 'string',
    );
  } catch {
    return [];
  }
}

function writePendingReleases(list) {
  try {
    if (!list.length) localStorage.removeItem(RELEASE_STORAGE_KEY);
    else localStorage.setItem(RELEASE_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // A storage failure must never block the sign-out itself.
  }
}

function sameRelease(a, b) {
  return a.token === b.token && a.uid === b.uid;
}

function addPendingRelease(marker) {
  const list = readPendingReleases();
  if (list.some((item) => sameRelease(item, marker))) return;
  list.push({ token: marker.token, uid: marker.uid });
  writePendingReleases(list);
}

function clearPendingRelease(marker) {
  const list = readPendingReleases();
  const next = list.filter((item) => !sameRelease(item, marker));
  if (next.length !== list.length) writePendingReleases(next);
}

function dropCachedToken(token) {
  const cached = readStoredToken();
  if (cached && cached.token === token) clearStoredToken();
}

// Release one token document, exactly the one this attempt owns. The retry
// marker is written before the delete so a refusal (offline, revoked, or a
// delete that now runs without auth after sign-out) stays recoverable by that
// account's next session. The wait is bounded: sign-out is best-effort.
function releaseTokenDoc(token, uid) {
  const marker = { token, uid };
  if (uid) addPendingRelease(marker);
  const settle = (release) => {
    if (uid) clearPendingRelease(marker);
    dropCachedToken(token);
    return release;
  };
  return Promise.race([
    deleteFcmToken(token).then(
      () => settle(true),
      () => false,
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), RELEASE_WRITE_MS)),
  ]);
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
  enable.disabled = busy || tokenInFlight;
  retry.disabled = busy || tokenInFlight;
  setText(enable, busy || tokenInFlight ? 'Enabling…' : 'Enable notifications');
  $('notify-actions').hidden = enable.hidden && retry.hidden;
}

// Every signed-in load writes the token document once, even when the token is
// unchanged: the bridge prunes dead tokens server-side (`UnregisteredError`) and
// `acl.py --prune` deletes revoked ones, while the rules deny reads — so a
// cached copy is not evidence the document still exists. The comparison is kept
// for the local cache only.
//
// The whole attempt is bounded by settleWrite: an unreachable backend must not
// pin the card on "Registering…" or latch the retry button off.
function settleRegistration(generation, attemptSession, uid, outcome, savedToken) {
  // A newer retry (or a sign-out) owns the card now; never clobber it.
  if (generation !== registrationGeneration) return;
  if (attemptSession !== sessionGeneration || !sessionActive) return;
  tokenInFlight = false;
  const result = registrationResult(outcome);
  if (result.phase === 'saved' && savedToken) {
    const stored = readStoredToken();
    if (!stored || stored.token !== savedToken || stored.uid !== uid) {
      writeStoredToken(savedToken, uid);
    }
    tokenRestoredFor = uid;
  }
  if (result.blocked) permission = 'denied';
  phase = result.phase;
  error = result.error;
  render();
}

async function registerToken({ generation = sessionGeneration } = {}) {
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
    inFlight: tokenInFlight,
    restoredForUid: tokenRestoredFor,
  });
  if (!decision.start) {
    if (decision.reason === 'offline') {
      phase = 'failed';
      error = OFFLINE_TOKEN_MESSAGE;
      render();
    }
    return;
  }
  const gen = ++registrationGeneration;
  const attemptSession = generation;
  tokenInFlight = true;
  phase = 'registering';
  error = '';
  message = '';
  supported = true;
  render();

  let savedToken = null;
  const attempt = (async () => {
    messaging = messaging || (await loadMessaging());
    const registration = await serviceWorkerReady();
    const tokenOptions = { vapidKey, serviceWorkerRegistration: registration };
    let token = await messaging.getToken(messaging.getMessaging(), tokenOptions);
    if (!token || typeof token !== 'string') {
      const missing = new Error('no-token');
      throw missing;
    }
    // Record the token before its document write: if sign-out starts while the
    // write is pending, the release path must know which doc id to remove.
    inFlightToken = { token, uid, session: attemptSession };
    // Signed out while the token request was in flight: never write for a
    // session that no longer exists.
    if (attemptSession !== sessionGeneration || !sessionActive) return null;
    try {
      await saveFcmToken(token, uid);
    } catch (err) {
      if (!isTokenClaimDenial(err)) throw err;
      // The doc id still belongs to the previous account (its sign-out release
      // never reached the server). A fresh FCM registration produces a new doc
      // id, which the create rule accepts — otherwise this card could never
      // recover on this browser.
      await messaging.deleteToken(messaging.getMessaging()).catch(() => {});
      token = await messaging.getToken(messaging.getMessaging(), tokenOptions);
      if (!token || typeof token !== 'string') {
        const missing = new Error('no-token');
        throw missing;
      }
      inFlightToken = { token, uid, session: attemptSession };
      if (attemptSession !== sessionGeneration || !sessionActive) return null;
      await saveFcmToken(token, uid);
    }
    if (attemptSession !== sessionGeneration || !sessionActive) {
      // The session ended while the write was still running. The document may
      // have landed after the sign-out release (which had no id yet), so
      // release this exact token now; if the delete runs without auth or the
      // backend is unreachable, the marker retries it next session.
      if (!sessionActive) await releaseTokenDoc(token, uid);
      return null;
    }
    savedToken = token;
    return token;
  })();

  const outcome = await settleWrite(attempt, {
    onLate: (late) => settleRegistration(gen, attemptSession, uid, late, savedToken),
  });
  settleRegistration(gen, attemptSession, uid, outcome, savedToken);
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
  const decision = registrationDecision({
    requested: Boolean(register && uid),
    supported,
    permission,
    vapid: vapidConfigured(vapidKey),
    uid,
    online: !isOffline(),
    inFlight: tokenInFlight,
    restoredForUid: tokenRestoredFor,
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
  await registerToken({ generation });
}

async function enable() {
  if (busy || tokenInFlight || permission !== 'default') return;
  if (typeof Notification === 'undefined') return;
  const trigger = $('notify-enable');
  const generation = sessionGeneration;
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
      await registerToken({ generation });
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
  sessionActive = true;
  sessionGeneration += 1;
  // A pending delete for this account must land before the session registers a
  // token again, so the retry cannot race the re-save. Bounded so an offline
  // retry cannot delay the card.
  Promise.race([
    retryPendingRelease(),
    new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS)),
  ]).finally(() => refresh({ register: true }));
}

// A token doc whose delete failed (offline, revoked session) is retried the
// next time its owner is signed in. The cached token survives until the delete
// is acknowledged, so the failure stays recoverable instead of locking the
// browser's next account out of notifications.
async function retryPendingRelease() {
  const uid = currentUid();
  const markers = readPendingReleases().filter((marker) => marker.uid === uid);
  for (const marker of markers) {
    try {
      await deleteFcmToken(marker.token);
    } catch {
      continue; // Keep this marker for the next session.
    }
    clearPendingRelease(marker);
    const cached = readStoredToken();
    if (cached && cached.token === marker.token && cached.uid === marker.uid) clearStoredToken();
  }
}

// Sign-out hand-over. The token document belongs to the account that created it
// (the rules deny another uid an update), and a signed-out device must stop
// receiving that account's alerts, so the owner deletes it while the session is
// still valid and drops the local copy once the delete is acknowledged. A
// failed release keeps the cache and leaves a marker for the next sign-in;
// failure must never block the sign-out.
export async function releaseNotifications() {
  sessionActive = false;
  sessionGeneration += 1;
  registrationGeneration += 1;
  const stored = readStoredToken();
  // The cache is only written after a successful save, so a registration that
  // is still writing has to contribute its token from memory.
  const inFlight = inFlightToken;
  inFlightToken = null;
  tokenRestoredFor = null;
  const plan = tokenReleasePlan({ stored, inFlight, messaging: Boolean(messaging) });
  const pending = plan.docs.map((item) => releaseTokenDoc(item.token, item.uid));
  if (plan.deleteToken) {
    pending.push(
      Promise.resolve()
        .then(() => messaging.deleteToken(messaging.getMessaging()))
        .catch(() => {}),
    );
  }
  await Promise.all(pending);
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
  registrationGeneration += 1;
  // The cached token and the pending-release marker are deliberately kept: a
  // release that failed must stay retryable by the next sign-in instead of
  // being forgotten here.
  supported = notificationApi ? null : false;
  permission = readPermission();
  phase = 'idle';
  error = '';
  message = '';
  busy = false;
  tokenInFlight = false;
  inFlightToken = null;
  tokenRestoredFor = null;
  supportPromise = null;
  supportFailed = false;
  if (!$('notify-card')) return;
  render();
}
