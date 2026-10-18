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

// History is a one-shot read: daily docs use their date as the document id.
export async function fetchHistory(startId, endId) {
  const snap = await getDocs(
    query(
      collection(db, 'history'),
      where(documentId(), '>=', startId),
      where(documentId(), '<=', endId),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, kwh: d.data().kwh }));
}

export async function fetchSessions() {
  const snap = await getDocs(
    query(collection(db, 'sessions'), orderBy('started_at', 'desc'), limit(20)),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
