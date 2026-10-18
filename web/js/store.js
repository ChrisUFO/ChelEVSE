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

export function startStore({ onStatus, onCommands }) {
  stopStore();
  unsubStatus = onSnapshot(
    doc(db, 'status', 'current'),
    (snap) => onStatus(snap),
    () => onStatus(null),
  );
  unsubCmds = onSnapshot(
    query(collection(db, 'commands'), orderBy('created_at', 'desc'), limit(3)),
    (snap) => onCommands(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => {},
  );
}

export function stopStore() {
  if (unsubStatus) unsubStatus();
  if (unsubCmds) unsubCmds();
  unsubStatus = unsubCmds = null;
}

// Every command is created pending; the bridge owns the lifecycle after that.
export function sendCommand(payload) {
  return addDoc(collection(db, 'commands'), {
    status: 'pending',
    created_at: serverTimestamp(),
    ...payload,
  });
}
