import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKEN_TIMEOUT_MESSAGE,
  accessDenialRelease,
  isTokenClaimDenial,
  notificationState,
  registrationDecision,
  registrationResult,
  tokenErrorMessage,
  tokenReleasePlan,
  vapidConfigured,
} from '../../web/js/notifications.js';
import {
  RELEASE_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  createTokenLifecycle,
} from '../../web/js/notification-session.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('notificationState covers every permission state without asking', () => {
  assert.equal(notificationState({ supported: null }).kind, 'checking');
  assert.equal(notificationState({ supported: false }).kind, 'unsupported');
  assert.equal(notificationState({ supported: true, vapid: false }).kind, 'no-vapid');
  assert.equal(notificationState({ supported: true, permission: 'denied' }).kind, 'denied');
  const blocked = notificationState({ supported: true, permission: 'denied' });
  assert.match(blocked.detail, /browser settings/);
  assert.equal(blocked.action, null);

  const granted = notificationState({
    supported: true,
    permission: 'granted',
    tokenPhase: 'saved',
  });
  assert.equal(granted.kind, 'granted');
  assert.match(granted.detail, /registered/);
  assert.equal(granted.action, null);
  // A granted permission whose token save failed offers a retry, and the card
  // must not claim success above the failure.
  const failed = notificationState({
    supported: true,
    permission: 'granted',
    tokenPhase: 'failed',
  });
  assert.equal(failed.action, 'retry');
  assert.equal(failed.kind, 'attention');
  assert.match(failed.title, /attention/);
  assert.doesNotMatch(failed.title, /are on/);
  const initial = notificationState({ supported: true, permission: 'default' });
  assert.equal(initial.kind, 'default');
  assert.equal(initial.action, 'enable');
  // Unsupported outranks a blocked permission: there is nothing to unblock.
  assert.equal(notificationState({ supported: false, permission: 'denied' }).kind, 'unsupported');
});

test('vapidConfigured ignores the template placeholder and empty values', () => {
  assert.equal(vapidConfigured('BK-real-public-key'), true);
  assert.equal(vapidConfigured('  BK-real-public-key  '), true);
  assert.equal(vapidConfigured('<public Web Push key>'), false);
  assert.equal(vapidConfigured('  <public Web Push key>  '), false);
  assert.equal(vapidConfigured(''), false);
  assert.equal(vapidConfigured(null), false);
  assert.equal(vapidConfigured(undefined), false);
});

const ready = {
  requested: true,
  supported: true,
  permission: 'granted',
  vapid: true,
  uid: 'u1',
  online: true,
  inFlight: false,
  restoredForUid: null,
};

test('registration starts only when every gate is open', () => {
  assert.deepEqual(registrationDecision(ready), { start: true, reason: '' });

  assert.deepEqual(registrationDecision({ ...ready, requested: false }), {
    start: false,
    reason: 'not-requested',
  });
  assert.deepEqual(registrationDecision({ ...ready, supported: false }), {
    start: false,
    reason: 'unsupported',
  });
  assert.deepEqual(registrationDecision({ ...ready, supported: null }), {
    start: false,
    reason: 'unsupported',
  });
  assert.deepEqual(registrationDecision({ ...ready, permission: 'default' }), {
    start: false,
    reason: 'permission',
  });
  assert.deepEqual(registrationDecision({ ...ready, vapid: false }), {
    start: false,
    reason: 'no-vapid',
  });
  assert.deepEqual(registrationDecision({ ...ready, uid: '' }), {
    start: false,
    reason: 'signed-out',
  });
  // An offline browser must not hand the write to Firestore.
  assert.deepEqual(registrationDecision({ ...ready, online: false }), {
    start: false,
    reason: 'offline',
  });
  // The in-flight latch keeps a second attempt (and the button) quiet.
  assert.deepEqual(registrationDecision({ ...ready, inFlight: true }), {
    start: false,
    reason: 'in-flight',
  });
  // One unconditional re-save per account per session.
  assert.deepEqual(registrationDecision({ ...ready, restoredForUid: 'u1' }), {
    start: false,
    reason: 'restored',
  });
  // A different account in the same session registers again.
  assert.equal(registrationDecision({ ...ready, restoredForUid: 'u0' }).start, true);
});

test('registrationResult maps every settled outcome to the card state', () => {
  const saved = registrationResult({ status: 'ok' });
  assert.equal(saved.phase, 'saved');
  assert.equal(saved.error, '');

  // A backend that never answers leaves a retryable attention state, never a
  // card pinned on "Registering…".
  const timedOut = registrationResult({ status: 'timeout' });
  assert.equal(timedOut.phase, 'failed');
  assert.equal(timedOut.error, TOKEN_TIMEOUT_MESSAGE);
  assert.match(timedOut.error, /try again/);
  const view = notificationState({
    supported: true,
    permission: 'granted',
    tokenPhase: timedOut.phase,
  });
  assert.equal(view.kind, 'attention');
  assert.equal(view.action, 'retry');

  const denied = registrationResult({ status: 'error', error: { code: 'permission-denied' } });
  assert.equal(denied.phase, 'failed');
  assert.equal(denied.denied, true);
  assert.match(denied.error, /account/);

  const offline = registrationResult({ status: 'error', error: { code: 'unavailable' } });
  assert.equal(offline.phase, 'failed');
  assert.match(offline.error, /connection/);

  const blocked = registrationResult({
    status: 'error',
    error: { code: 'messaging/permission-blocked' },
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.error, /browser settings/);

  const sw = registrationResult({ status: 'error', error: { code: 'sw-timeout' } });
  assert.match(sw.error, /Reload/);
  const noToken = registrationResult({
    status: 'error',
    error: Object.assign(new Error('no-token'), { code: 'no-token' }),
  });
  assert.match(noToken.error, /did not return/);
});

test('tokenErrorMessage is the single copy source', () => {
  assert.equal(
    tokenErrorMessage({ code: 'permission-denied' }),
    'Couldn’t save this device’s notification token. Check that your account still has access.',
  );
  assert.match(tokenErrorMessage(null), /Try again/);
});

test('tokenReleasePlan releases the cached and the in-flight token exactly once', () => {
  assert.deepEqual(tokenReleasePlan({ stored: { token: 'T', uid: 'A' }, messaging: true }), {
    docs: [{ token: 'T', uid: 'A' }],
    deleteToken: true,
  });
  // No messaging module loaded yet (permission never granted): only the doc.
  assert.deepEqual(tokenReleasePlan({ stored: { token: 'T', uid: 'A' }, messaging: false }), {
    docs: [{ token: 'T', uid: 'A' }],
    deleteToken: false,
  });
  // A cached token without a uid cannot be attributed, so it is released but
  // not retried by a later session.
  assert.deepEqual(tokenReleasePlan({ stored: { token: 'T' } }), {
    docs: [{ token: 'T', uid: '' }],
    deleteToken: false,
  });
  assert.deepEqual(tokenReleasePlan({ stored: null, messaging: true }), {
    docs: [],
    deleteToken: true,
  });
  assert.deepEqual(tokenReleasePlan(), { docs: [], deleteToken: false });

  // A sign-out while a registration is writing: the token exists only in the
  // attempt record, never in the cache.
  assert.deepEqual(tokenReleasePlan({ inFlight: { token: 'T', uid: 'A' } }), {
    docs: [{ token: 'T', uid: 'A' }],
    deleteToken: false,
  });
  // The usual case: the cache and the attempt carry the same token.
  assert.deepEqual(
    tokenReleasePlan({ stored: { token: 'T', uid: 'A' }, inFlight: { token: 'T', uid: 'A' } }).docs,
    [{ token: 'T', uid: 'A' }],
  );
  // A rotated token has two documents to remove.
  assert.deepEqual(
    tokenReleasePlan({ stored: { token: 'OLD', uid: 'A' }, inFlight: { token: 'NEW', uid: 'A' } })
      .docs,
    [
      { token: 'OLD', uid: 'A' },
      { token: 'NEW', uid: 'A' },
    ],
  );
});

test('a pruned-token denial is the handover signal, not a dead end', () => {
  // Account A signed out while offline: the doc still carries uid A, so B's save
  // of the same FCM token is a cross-uid update the rules deny.
  const deniedErr = Object.assign(new Error('denied'), { code: 'permission-denied' });
  assert.equal(isTokenClaimDenial(deniedErr), true);
  assert.equal(isTokenClaimDenial({ code: 'unavailable' }), false);
  assert.equal(isTokenClaimDenial(null), false);

  // The self-heal deletes the FCM registration and asks for a new token: a new
  // document id takes the create path instead of the denied update.
  const staleToken = 'tok-shared';
  const rotatedToken = 'tok-rotated';
  assert.notEqual(staleToken, rotatedToken);
  assert.equal(registrationResult({ status: 'error', error: deniedErr }).denied, true);

  // The retry marker belongs to A, so only A's next session retries the delete.
  const plan = tokenReleasePlan({ stored: { token: staleToken, uid: 'A' }, messaging: true });
  assert.deepEqual(plan.docs, [{ token: staleToken, uid: 'A' }]);
  assert.equal(plan.docs[0].uid === 'B', false);
});

test('the registered copy says what is true before delivery ships', () => {
  const granted = notificationState({
    supported: true,
    permission: 'granted',
    tokenPhase: 'saved',
  });
  assert.match(granted.detail, /registered/);
  assert.match(granted.detail, /when the charger reports an event/);
  // The worker in this build has no push handler, so the copy must not promise
  // an alert the app cannot yet deliver while closed.
  assert.doesNotMatch(granted.detail, /even when the app is closed/);
  assert.equal(granted.action, null);
});

test('only a revoked grant releases this device on the way out', () => {
  // A store permission-denial means the grant is gone: release the token while
  // the account can still authenticate.
  assert.equal(accessDenialRelease('no-access'), true);
  // A failed access check is a network/backend problem; the grant may still be
  // intact, so nothing is unregistered.
  assert.equal(accessDenialRelease('error'), false);
  assert.equal(accessDenialRelease(undefined), false);
});

test('a sign-out before the token write settles deletes that exact doc and states no success', async () => {
  const storage = memoryStorage();
  const deleted = [];
  const write = deferred();
  const lifecycle = createTokenLifecycle({
    saveTokenDoc: () => write.promise,
    deleteTokenDoc: async (token) => {
      deleted.push(token);
    },
    storage,
  });
  lifecycle.begin();
  const outcomes = [];
  const run = lifecycle.register({
    uid: 'A',
    acquire: async () => 'TOKEN-A',
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  await flush();

  // The token is recorded before its document write, which is still pending.
  assert.deepEqual(lifecycle.inFlightToken, {
    token: 'TOKEN-A',
    uid: 'A',
    session: lifecycle.generation,
  });
  assert.equal(lifecycle.writing, true);

  // Sign-out lands now: the release must use the acquired token, not an empty
  // cache, and the session must be over before the write settles.
  await lifecycle.release();
  assert.equal(lifecycle.active, false);
  write.resolve();
  await run;

  // The exact document id is deleted by the sign-out handover and again by the
  // late write's own release, which is what keeps it from surviving the race.
  assert.deepEqual(deleted, ['TOKEN-A', 'TOKEN-A']);
  assert.deepEqual(outcomes, []);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(storage.getItem(RELEASE_STORAGE_KEY), null);
});

test('a failed release keeps the cache and its retry marker for the next session', async () => {
  const storage = memoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token: 'T', uid: 'A' }));
  const deleted = [];
  let offline = true;
  const lifecycle = createTokenLifecycle({
    saveTokenDoc: async () => {},
    deleteTokenDoc: async (token) => {
      deleted.push(token);
      if (offline) throw new Error('unavailable');
    },
    storage,
    releaseWriteMs: 50,
  });
  lifecycle.begin();
  await lifecycle.release();

  assert.deepEqual(deleted, ['T']);
  // The delete was refused: the cached token and the marker stay, so the next
  // session of that account retries exactly this document.
  assert.deepEqual(JSON.parse(storage.getItem(TOKEN_STORAGE_KEY)), { token: 'T', uid: 'A' });
  assert.deepEqual(JSON.parse(storage.getItem(RELEASE_STORAGE_KEY)), [{ token: 'T', uid: 'A' }]);

  offline = false;
  await lifecycle.retryPending('A');
  assert.deepEqual(deleted, ['T', 'T']);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(storage.getItem(RELEASE_STORAGE_KEY), null);
  // Unknown accounts do not get another account's release attempt.
  await lifecycle.retryPending('B');
  assert.deepEqual(deleted, ['T', 'T']);
});

test('revoking access releases an active registered session while the user is still signed in', async () => {
  const storage = memoryStorage();
  const deleted = [];
  const fcm = [];
  const lifecycle = createTokenLifecycle({
    saveTokenDoc: async () => {},
    deleteTokenDoc: async (token) => {
      deleted.push(token);
    },
    storage,
  });
  lifecycle.begin();
  await lifecycle.register({ uid: 'A', acquire: async () => 'TOKEN-A' });
  assert.equal(lifecycle.active, true);
  assert.deepEqual(JSON.parse(storage.getItem(TOKEN_STORAGE_KEY)), { token: 'TOKEN-A', uid: 'A' });

  // The access-denied callback runs this before closeApp/resetNotifications, so
  // the uid-keyed delete starts while the Firebase user still authenticates.
  assert.equal(accessDenialRelease('no-access'), true);
  await lifecycle.release({ resetFcm: async () => fcm.push('reset') });

  assert.deepEqual(deleted, ['TOKEN-A']);
  assert.deepEqual(fcm, ['reset']);
  assert.equal(lifecycle.active, false);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(storage.getItem(RELEASE_STORAGE_KEY), null);
});
