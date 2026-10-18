// Firestore data access: realtime subscriptions and command writes.
// The app starts these only after access is confirmed and stops them on sign-out.

import {
  db,
  doc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from './firebase.js';

let unsubStatus = null;
let unsubCmds = null;
let unsubSettings = null;

export function startStore({ onStatus, onCommands, onSettings, onAccessDenied }) {
  stopStore();
  const denied = (err) => {
    if (err && err.code === 'permission-denied' && onAccessDenied) {
      onAccessDenied();
      return true;
    }
    return false;
  };
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
  unsubSettings = onSnapshot(
    doc(db, 'settings', 'current'),
    (snap) => {
      if (onSettings) onSettings(snap.exists() ? snap.data() : null);
    },
    denied,
  );
}

export function stopStore() {
  if (unsubStatus) unsubStatus();
  if (unsubCmds) unsubCmds();
  if (unsubSettings) unsubSettings();
  unsubStatus = unsubCmds = unsubSettings = null;
}

// Every command is created pending; the bridge owns the lifecycle after that.
export function sendCommand(payload) {
  return addDoc(collection(db, 'commands'), {
    ...payload,
    status: 'pending',
    created_at: serverTimestamp(),
  });
}
