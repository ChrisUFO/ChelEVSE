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

export let onAuthStateChanged;
export let signOut;
export let getRedirectResult;
export let GoogleAuthProvider;
export let signInWithPopup;
export let signInWithRedirect;

export let doc;
export let getDoc;
export let collection;
export let addDoc;
export let serverTimestamp;
export let query;
export let orderBy;
export let limit;
export let onSnapshot;

function tagged(kind) {
  const err = new Error(kind);
  err.kind = kind;
  return err;
}

export async function initFirebase() {
  let firebaseConfig;
  try {
    ({ firebaseConfig } = await import('../firebase-config.js'));
  } catch {
    throw tagged('config');
  }
  try {
    const appMod = await import(`${SDK}/firebase-app.js`);
    const authMod = await import(`${SDK}/firebase-auth.js`);
    const dbMod = await import(`${SDK}/firebase-firestore.js`);

    const app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db = dbMod.getFirestore(app);

    ({
      onAuthStateChanged,
      signOut,
      getRedirectResult,
      GoogleAuthProvider,
      signInWithPopup,
      signInWithRedirect,
    } = authMod);
    ({ doc, getDoc, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot } =
      dbMod);
  } catch {
    throw tagged('sdk');
  }
}
