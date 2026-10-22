// Firebase bootstrap: the local config module and the SDK are loaded
// dynamically so a missing config or an offline SDK yields a friendly screen
// instead of a blank page or SDK noise.
//
// The SDK function exports below are assigned by initFirebase(); importers see
// the live bindings once it resolves. Boot calls initFirebase() before wiring
// anything that uses them.

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export let auth = null;
export let db = null;
// Public Web Push key from the local config module; undefined when the
// deployment has not set one yet (the opt-in shows a clear state).
export let vapidKey;

export let onAuthStateChanged;
export let signOut;
export let getRedirectResult;
export let GoogleAuthProvider;
export let signInWithPopup;
export let signInWithRedirect;

export let doc;
export let getDoc;
export let getDocFromServer;
export let getDocs;
export let setDoc;
export let deleteDoc;
export let collection;
export let addDoc;
export let serverTimestamp;
export let query;
export let where;
export let orderBy;
export let limit;
export let startAfter;
export let onSnapshot;
export let documentId;

function tagged(kind) {
  const err = new Error(kind);
  err.kind = kind;
  return err;
}

export async function initFirebase() {
  let firebaseConfig;
  try {
    // vapidKey is optional: older config files simply leave it undefined.
    ({ firebaseConfig, vapidKey } = await import('../firebase-config.js'));
  } catch {
    throw tagged('config');
  }
  try {
    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);

    const app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    // A persistent cache keeps the last schedule snapshot and any queued write
    // across a reload. Offline persistence needs IndexedDB; browsers that do
    // not offer it (some private windows, storage disabled) fall back to the
    // default in-memory cache so the rest of the app keeps working.
    // initializeFirestore must run before the first Firestore use, and getFirestore
    // cannot follow a successful initialize — hence the try/catch, not a probe.
    try {
      db = dbMod.initializeFirestore(app, {
        localCache: dbMod.persistentLocalCache({
          tabManager: dbMod.persistentMultipleTabManager(),
        }),
      });
    } catch {
      db = dbMod.getFirestore(app);
    }

    ({
      onAuthStateChanged,
      signOut,
      getRedirectResult,
      GoogleAuthProvider,
      signInWithPopup,
      signInWithRedirect,
    } = authMod);
    ({
      doc,
      getDoc,
      getDocFromServer,
      getDocs,
      setDoc,
      deleteDoc,
      collection,
      addDoc,
      serverTimestamp,
      query,
      where,
      orderBy,
      limit,
      startAfter,
      onSnapshot,
      documentId,
    } = dbMod);
  } catch {
    throw tagged('sdk');
  }
}

// The messaging SDK is only needed by the notification opt-in, so it loads on
// first use rather than on every boot. Same SDK version as the rest of the app.
export function loadMessaging() {
  return import(`${SDK}/firebase-messaging.js`);
}
