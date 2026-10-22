// Firestore data access: realtime subscriptions and command/schedule writes.
// The app starts these only after access is confirmed and stops them on sign-out.

import {
  db,
  doc,
  collection,
  addDoc,
  getDoc,
  getDocFromServer,
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
import { settingsPayload } from './settings.js';

let unsubStatus = null;
let unsubCmds = null;
let unsubSettings = null;
let unsubConfig = null;
let unsubSchedule = null;
let unsubRapi = null;
let unsubPending = null;

export function startStore({
  onStatus,
  onCommands,
  onSettings,
  onSettingsError,
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
  // Every document subscription hands the snapshot's provenance to its callback
  // alongside the data: a cached snapshot is what the local cache knew before
  // the server answered, which is not the same as the server's answer.
  const watch = (path, onData, onError, options = {}) =>
    onSnapshot(
      doc(db, path),
      options,
      (snap) =>
        onData(snap && snap.exists() ? snap.data() : null, {
          fromCache: Boolean(snap && snap.metadata && snap.metadata.fromCache),
        }),
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
  // The status feedback needs the newest settled commands (newest first) and
  // every pending command. Pending state cannot rely on a finite mixed window:
  // a burst of RAPI sends would evict a still-pending stop/auto/set-current and
  // re-enable the controls before the charger applied it. The pending query is
  // a single-field equality, so it needs no composite index.
  let recentCommands = [];
  let pendingCommands = [];
  const emitCommands = () => {
    if (onCommands) onCommands(mergeCommandWindows(recentCommands, pendingCommands));
  };
  unsubCmds = onSnapshot(
    query(collection(db, 'commands'), orderBy('created_at', 'desc'), limit(COMMAND_LIMIT)),
    (snap) => {
      recentCommands = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emitCommands();
    },
    denied,
  );
  unsubPending = onSnapshot(
    query(collection(db, 'commands'), where('status', '==', 'pending')),
    (snap) => {
      pendingCommands = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emitCommands();
    },
    denied,
  );
  // The settings gate needs the snapshot's provenance: a cached snapshot that
  // reports no document is the local cache answering before the server, not
  // evidence that the owner has no stored plan. `includeMetadataChanges` is what
  // delivers the server's confirmation of an absent document — the data is
  // unchanged (still no document), so a metadata-only change is otherwise
  // filtered out and the gate would never open on a genuinely empty account.
  unsubSettings = watch(
    'settings/current',
    (data, meta) => onSettings && onSettings(data, meta),
    (err) => onSettingsError && onSettingsError(err),
    { includeMetadataChanges: true },
  );
  unsubConfig = watch(
    'status/config',
    (data) => onConfig && onConfig(data),
    (err) => onConfigError && onConfigError(err),
  );
  // Schedule metadata travels with the data: a write still queued in the
  // persistent cache across a reload is durable but unacknowledged, and the
  // editor labels it instead of trusting the cached document as server truth.
  // `includeMetadataChanges` is what makes the acknowledgment visible: the
  // backend confirms a write without changing the data, and Firestore filters
  // metadata-only changes unless the listener asks for them.
  unsubSchedule = onSnapshot(
    doc(db, 'schedule', 'current'),
    { includeMetadataChanges: true },
    (snap) =>
      onSchedule &&
      onSchedule(snap && snap.exists() ? snap.data() : null, {
        pendingWrites: Boolean(snap && snap.metadata && snap.metadata.hasPendingWrites),
      }),
    (err) => {
      if (!denied(err) && onScheduleError) onScheduleError(err);
    },
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
    unsubPending,
  ]) {
    if (unsub) unsub();
  }
  unsubStatus =
    unsubCmds =
    unsubSettings =
    unsubConfig =
    unsubSchedule =
    unsubRapi =
    unsubPending =
      null;
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

// The status screen's settled-command window. Pending commands are subscribed
// separately (`where('status', '==', 'pending')`), so this only bounds the
// "latest command" feedback history; CONTROL_TYPES still filters it client-side.
export const COMMAND_LIMIT = 20;

// Combine the newest mixed-type window with the independent pending set. A
// pending command the window already carries is not duplicated, and pending
// entries the window lost are appended: the status renderer gives pending
// precedence, while the settled history keeps its newest-first order.
export function mergeCommandWindows(recent = [], pending = []) {
  const merged = Array.isArray(recent) ? [...recent] : [];
  const seen = new Set(merged.map((doc) => doc && doc.id));
  for (const doc of Array.isArray(pending) ? pending : []) {
    if (!doc || seen.has(doc.id)) continue;
    seen.add(doc.id);
    merged.push(doc);
  }
  return merged;
}

// Both flat fields travel together because firestore.rules rejects a partial
// settings document. The optional rate schedule rides along only when it has
// rows: an empty list is omitted, so flat saves stay byte-identical (and old
// rules versions keep accepting them).
export function saveSettings(values) {
  return setDoc(doc(db, 'settings', 'current'), settingsPayload(values));
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
// `days` is 0 = Monday … 6 = Sunday, the same convention as the rate windows in
// rates.js (and `DAY_NAMES`), not Date#getDay()'s 0 = Sunday.
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

// A reloaded page's cached schedule already carries a queued write, so the
// pre-write document exists only on the backend. `getDocFromServer` bypasses
// the cache (and rejects while offline) — exactly the baseline Discard needs to
// compensate against after a reload. The caller renders the failure, so this
// reports it instead of throwing (a read racing a route change must not become
// an unhandled rejection).
export async function readScheduleBaseline() {
  try {
    const snap = await getDocFromServer(doc(db, 'schedule', 'current'));
    return { ok: true, data: snap && snap.exists() ? snap.data() : null };
  } catch {
    return { ok: false, data: null };
  }
}

// History is a one-shot read: daily docs use their date as the document id, and
// zero-padded day ids sort lexicographically in calendar order, so an inclusive
// documentId() range is a date range. The SDK resolves an offline read with
// cached docs (often empty) instead of rejecting, so `fromCache` travels with
// the result: the screen must not read a cached empty range as "no history".
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

// The Day period reads one document: `history/{today}` already carries the
// whole day, so a range query would add nothing and could not tell an absent
// document from one that a cached read never reached. The bridge writes
// `hours.<HH>` with zero-padded, strftime-shaped keys ('00'–'23'); a day
// recorded before hourly capture has `kwh` and no `hours` at all, so `hours`
// stays null rather than becoming an empty map — the screen uses that to say
// "no intraday detail" instead of drawing 24 zero bars.
//
// getDoc prefers the server but may resolve from the cache (reported in
// metadata) and rejects while offline when the document is not cached, which the
// screen already classifies as an error. A missing document is `exists: false`
// with zero energy: the caller must not treat that as "nothing was recorded"
// unless the read actually reached the server.
export async function fetchHistoryDay(dayId) {
  const snap = await getDoc(doc(db, 'history', dayId));
  const exists = Boolean(snap && snap.exists());
  const data = exists ? snap.data() || {} : {};
  const kwh = Number(data.kwh);
  const hours = data.hours;
  return {
    id: dayId,
    exists,
    kwh: exists && Number.isFinite(kwh) ? kwh : 0,
    hours: exists && hours && typeof hours === 'object' ? hours : null,
    fromCache: Boolean(snap && snap.metadata && snap.metadata.fromCache),
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
