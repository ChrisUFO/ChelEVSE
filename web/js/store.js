// Firestore data access: realtime subscriptions and command/schedule writes.
// The app starts these only after access is confirmed and stops them on sign-out.

import {
  db,
  doc,
  collection,
  addDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  documentId,
} from './firebase.js';

let unsubStatus = null;
let unsubCmds = null;
let unsubSettings = null;
let unsubConfig = null;
let unsubSchedule = null;
let unsubRapi = null;

export function startStore({
  onStatus,
  onCommands,
  onSettings,
  onConfig,
  onConfigError,
  onSchedule,
  onScheduleError,
  onRapiCommands,
  onRapiError,
  onAccessDenied,
}) {
  stopStore();
  const denied = (err) => {
    if (err && err.code === 'permission-denied' && onAccessDenied) {
      onAccessDenied();
      return true;
    }
    return false;
  };
  const watch = (path, onData, onError) =>
    onSnapshot(
      doc(db, path),
      (snap) => onData(snap && snap.exists() ? snap.data() : null),
      (err) => {
        if (!denied(err) && onError) onError(err);
      },
    );

  unsubStatus = onSnapshot(
    doc(db, 'status', 'current'),
    (snap) => onStatus(snap),
    (err) => {
      if (!denied(err)) onStatus(null);
    },
  );
  unsubCmds = onSnapshot(
    query(collection(db, 'commands'), orderBy('created_at', 'desc'), limit(3)),
    (snap) => onCommands(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    denied,
  );
  unsubSettings = watch('settings/current', (data) => onSettings && onSettings(data));
  unsubConfig = watch(
    'status/config',
    (data) => onConfig && onConfig(data),
    (err) => onConfigError && onConfigError(err),
  );
  unsubSchedule = watch(
    'schedule/current',
    (data) => onSchedule && onSchedule(data),
    (err) => onScheduleError && onScheduleError(err),
  );
  // The Advanced console keeps its own 20-entry RAPI history: a where+orderBy
  // query needs the declared (type, created_at) composite index.
  unsubRapi = onSnapshot(
    query(
      collection(db, 'commands'),
      where('type', '==', 'rapi'),
      orderBy('created_at', 'desc'),
      limit(RAPI_LIMIT),
    ),
    (snap) => onRapiCommands && onRapiCommands(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      if (!denied(err) && onRapiError) onRapiError(err);
    },
  );
}

export function stopStore() {
  for (const unsub of [
    unsubStatus,
    unsubCmds,
    unsubSettings,
    unsubConfig,
    unsubSchedule,
    unsubRapi,
  ]) {
    if (unsub) unsub();
  }
  unsubStatus = unsubCmds = unsubSettings = unsubConfig = unsubSchedule = unsubRapi = null;
}

// Every command is created pending; the bridge owns the lifecycle after that.
export function sendCommand(payload) {
  return addDoc(collection(db, 'commands'), {
    ...payload,
    status: 'pending',
    created_at: serverTimestamp(),
  });
}

// The Advanced console's scrollback depth.
export const RAPI_LIMIT = 20;

// Both fields travel together because firestore.rules rejects a partial
// settings document.
export function saveSettings({ rate, currency }) {
  return setDoc(doc(db, 'settings', 'current'), { rate, currency });
}

// Own-token-only, per firestore.rules: the doc id is the FCM token and the uid
// must be the signed-in account.
export function saveFcmToken(token, uid) {
  return setDoc(doc(db, 'fcmTokens', token), {
    uid,
    created_at: serverTimestamp(),
  });
}

// The owner removes its own token document before signing out: FCM hands the
// same browser token to the next account, whose setDoc would otherwise be a
// cross-uid update the rules deny.
export function deleteFcmToken(token) {
  return deleteDoc(doc(db, 'fcmTokens', token));
}

// Exact schedule shape: keys are fixed so no draft-only fields ever reach rules.
export function saveSchedule(schedule) {
  return setDoc(doc(db, 'schedule', 'current'), {
    enabled: schedule.enabled,
    rules: schedule.rules.map((rule) => ({
      id: rule.id,
      days: rule.days,
      start: rule.start,
      end: rule.end,
      amps: rule.amps,
    })),
  });
}

// The daily history range: zero-padded day ids sort lexicographically in
// calendar order, so an inclusive documentId() range is a date range.
export function historyBounds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return null;
  return { startId: list[0], endId: list[list.length - 1] };
}

// History is a one-shot read: daily docs use their date as the document id.
// The SDK resolves an offline read with cached docs (often empty) instead of
// rejecting, so `fromCache` travels with the result: the screen must not read a
// cached empty range as "no history".
export async function fetchHistory(startId, endId) {
  const snap = await getDocs(
    query(
      collection(db, 'history'),
      where(documentId(), '>=', startId),
      where(documentId(), '<=', endId),
    ),
  );
  return {
    docs: snap.docs.map((d) => ({ id: d.id, kwh: d.data().kwh })),
    fromCache: Boolean(snap.metadata && snap.metadata.fromCache),
  };
}

// The sessions list is the 20 most recent, newest first.
export const SESSION_LIMIT = 20;

export function sessionsQueryOptions() {
  return { field: 'started_at', direction: 'desc', limit: SESSION_LIMIT };
}

export async function fetchSessions() {
  const { field, direction, limit: max } = sessionsQueryOptions();
  const snap = await getDocs(
    query(collection(db, 'sessions'), orderBy(field, direction), limit(max)),
  );
  return {
    docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    fromCache: Boolean(snap.metadata && snap.metadata.fromCache),
  };
}
