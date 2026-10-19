// Pure copy for the notification opt-in card. No DOM, no Firebase — covered by
// test/web.

// A deployment has a usable key only when the config carries a real value. The
// example template's "<public Web Push key>" placeholder counts as unset so a
// copied config shows the no-VAPID state instead of a token error.
export function vapidConfigured(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return Boolean(key) && !key.startsWith('<');
}

// The permission card has one visual state at a time. `supported` is null while
// the messaging SDK's isSupported() probe is in flight. The token phase only
// refines the granted state; permission is never requested from here.
export function notificationState({
  supported = null,
  permission = 'default',
  vapid = true,
  tokenPhase = 'idle',
} = {}) {
  if (supported === null) {
    return {
      kind: 'checking',
      title: 'Checking notifications…',
      detail: 'Working out what this browser supports.',
      action: null,
    };
  }
  if (!supported) {
    return {
      kind: 'unsupported',
      title: 'Notifications aren’t available',
      detail:
        'This browser can’t receive push notifications. On Android, install the app to your home screen and open it from there.',
      action: null,
    };
  }
  if (!vapid) {
    return {
      kind: 'no-vapid',
      title: 'Push isn’t configured',
      detail:
        'This deployment has no public Web Push key. Add vapidKey to web/firebase-config.js to enable notifications.',
      action: null,
    };
  }
  if (permission === 'denied') {
    return {
      kind: 'denied',
      title: 'Notifications are blocked',
      detail:
        'Allow notifications for this site in your browser settings (the lock or tune icon by the address), then reload the page.',
      action: null,
    };
  }
  if (permission === 'granted') {
    // The headline follows the actual registration outcome: a failed token save
    // is not "on", however granted the permission is.
    if (tokenPhase === 'failed') {
      return {
        kind: 'attention',
        title: 'Notifications need attention',
        detail: 'Enabled in this browser, but this device isn’t registered yet.',
        action: 'retry',
      };
    }
    const detail =
      tokenPhase === 'saved'
        ? 'This device is registered. You’ll get charging alerts even when the app is closed.'
        : 'Enabled in this browser. Registering this device…';
    return {
      kind: 'granted',
      title: 'Notifications are on',
      detail,
      action: tokenPhase === 'saved' || tokenPhase === 'registering' ? null : 'retry',
    };
  }
  return {
    kind: 'default',
    title: 'Get charging alerts',
    detail:
      'Enable notifications to hear when charging starts or stops, even when the app is closed.',
    action: 'enable',
  };
}

// ---------- token lifecycle ----------

export const OFFLINE_TOKEN_MESSAGE = 'You’re offline — reconnect to register this device.';
export const TOKEN_TIMEOUT_MESSAGE =
  'Still registering this device — check your connection, then try again.';

// Copy for every failed registration. Pure so the classification is testable
// without a browser.
export function tokenErrorMessage(err) {
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

// Whether this load may start a token registration, and why not when it must
// not. `online` guards against handing a write to Firestore while the browser
// knows it is offline; `inFlight` is the retry latch; `restoredForUid` records
// the once-per-session re-save.
export function registrationDecision({
  requested = false,
  supported = null,
  permission = 'default',
  vapid = true,
  uid = '',
  online = true,
  inFlight = false,
  restoredForUid = null,
} = {}) {
  if (!requested) return { start: false, reason: 'not-requested' };
  if (!supported) return { start: false, reason: 'unsupported' };
  if (permission !== 'granted') return { start: false, reason: 'permission' };
  if (!vapid) return { start: false, reason: 'no-vapid' };
  if (!uid) return { start: false, reason: 'signed-out' };
  if (!online) return { start: false, reason: 'offline' };
  if (inFlight) return { start: false, reason: 'in-flight' };
  if (restoredForUid === uid) return { start: false, reason: 'restored' };
  return { start: true, reason: '' };
}

// A denied token save means the document id already belongs to another account:
// the previous sign-out's delete never reached the server. Deleting the FCM
// registration (not the doc — the rules deny that) gives the next attempt a new
// document id, which the create rule accepts.
export function isTokenClaimDenial(err) {
  return Boolean(err) && err.code === 'permission-denied';
}

// Settled registration outcome → card state.
export function registrationResult(outcome) {
  if (!outcome || !outcome.status || outcome.status === 'ok') {
    return { phase: 'saved', error: '', blocked: false, denied: false };
  }
  if (outcome.status === 'timeout') {
    return { phase: 'failed', error: TOKEN_TIMEOUT_MESSAGE, blocked: false, denied: false };
  }
  const error = outcome.error;
  return {
    phase: 'failed',
    error: tokenErrorMessage(error),
    blocked: Boolean(error && error.code === 'messaging/permission-blocked'),
    denied: isTokenClaimDenial(error),
  };
}

// What a sign-out must do to this device's push registration. `stored` is the
// cached token from an earlier settlement; `inFlight` is a token this session
// already obtained while its document write may still be running. Every doc id
// is released exactly once (a cache and an attempt usually carry the same
// token), and the cached token plus retry markers may only be dropped after the
// document delete is acknowledged, so a failed release is retried next session.
export function tokenReleasePlan({ stored = null, inFlight = null, messaging = false } = {}) {
  const docs = [];
  for (const item of [stored, inFlight]) {
    if (!item || typeof item.token !== 'string' || !item.token) continue;
    if (docs.some((doc) => doc.token === item.token)) continue;
    docs.push({ token: item.token, uid: typeof item.uid === 'string' ? item.uid : '' });
  }
  return { docs, deleteToken: Boolean(messaging) };
}
