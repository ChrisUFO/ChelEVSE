// Firestore data access: realtime subscriptions and command/schedule writes.
// The app starts these only after access is confirmed and stops them on sign-out.

import {
  db,
  doc,
  collection,
  addDoc,
  getDocs,
  setDoc,
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

export function startStore({
  onStatus,
  onCommands,
  onSettings,
  onConfig,
  onSchedule,
  onScheduleError,
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
  unsubConfig = watch('status/config', (data) => onConfig && onConfig(data));
  unsubSchedule = watch(
    'schedule/current',
    (data) => onSchedule && onSchedule(data),
    (err) => onScheduleError && onScheduleError(err),
  );
}

export function stopStore() {
  for (const unsub of [unsubStatus, unsubCmds, unsubSettings, unsubConfig, unsubSchedule]) {
    if (unsub) unsub();
  }
  unsubStatus = unsubCmds = unsubSettings = unsubConfig = unsubSchedule = null;
}

// Every command is created pending; the bridge owns the lifecycle after that.
export function sendCommand(payload) {
  return addDoc(collection(db, 'commands'), {
    ...payload,
    status: 'pending',
    created_at: serverTimestamp(),
  });
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
