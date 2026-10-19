// DOM-free coordinator for this device's push-token lifecycle. It owns the
// values that must stay consistent across an in-flight registration and a
// session ending — the session/attempt generations, the token obtained before
// its document write, the cached token, and the retry markers — so the screen
// only paints, and the sign-out race is executable in test/web. No DOM, no
// Firebase: the Firestore and FCM operations are injected.

import { isTokenClaimDenial, tokenReleasePlan } from './notifications.js';
import { settleWrite } from './write.js';

export const TOKEN_STORAGE_KEY = 'chelevse.fcmToken';
// A release whose delete never reached the server leaves a marker behind; the
// next session of that account retries the delete instead of leaving the doc to
// deny the next account's save. A registration that is still writing its
// document can add its own marker after sign-out, so this is a list.
export const RELEASE_STORAGE_KEY = 'chelevse.fcmPendingRelease';
export const RELEASE_WRITE_MS = 5000;

function safeStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // Access can throw in private mode; the lifecycle then runs without a cache.
  }
  return null;
}

function requireToken(token) {
  if (!token || typeof token !== 'string') throw new Error('no-token');
  return token;
}

// `saveTokenDoc(token, uid)` and `deleteTokenDoc(token)` are the Firestore
// writes. `storage` is a localStorage-compatible adapter (tests pass a Map
// wrapper); `settle` bounds a write and reports its late outcome.
export function createTokenLifecycle({
  saveTokenDoc,
  deleteTokenDoc,
  storage = safeStorage(),
  settle = settleWrite,
  isClaimDenial = isTokenClaimDenial,
  releaseWriteMs = RELEASE_WRITE_MS,
} = {}) {
  let active = false;
  let session = 0;
  let attempt = 0;
  let inFlight = null;
  let writing = false;
  let restoredFor = null;

  function read(key) {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(key, value) {
    if (!storage) return;
    try {
      storage.setItem(key, value);
    } catch {
      // Private-mode storage failures must not break registration or release.
    }
  }

  function remove(key) {
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      // Same tolerance as write.
    }
  }

  function readStoredToken() {
    const raw = read(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.token !== 'string' || typeof parsed.uid !== 'string') return null;
      return { token: parsed.token, uid: parsed.uid };
    } catch {
      return null;
    }
  }

  function writeStoredToken(token, uid) {
    write(TOKEN_STORAGE_KEY, JSON.stringify({ token, uid }));
  }

  function readPendingReleases() {
    const raw = read(RELEASE_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      // Older builds stored one marker object; accept both shapes.
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.filter(
        (item) => item && typeof item.token === 'string' && typeof item.uid === 'string',
      );
    } catch {
      return [];
    }
  }

  function writePendingReleases(list) {
    if (!list.length) remove(RELEASE_STORAGE_KEY);
    else write(RELEASE_STORAGE_KEY, JSON.stringify(list));
  }

  function sameRelease(a, b) {
    return a.token === b.token && a.uid === b.uid;
  }

  function addPendingRelease(marker) {
    const list = readPendingReleases();
    if (list.some((item) => sameRelease(item, marker))) return;
    list.push({ token: marker.token, uid: marker.uid });
    writePendingReleases(list);
  }

  function clearPendingRelease(marker) {
    const list = readPendingReleases();
    const next = list.filter((item) => !sameRelease(item, marker));
    if (next.length !== list.length) writePendingReleases(next);
  }

  function dropCachedToken(token) {
    const cached = readStoredToken();
    if (cached && cached.token === token) remove(TOKEN_STORAGE_KEY);
  }

  // Release one token document, exactly the one this attempt owns. The retry
  // marker is written before the delete so a refusal (offline, revoked, or a
  // delete that now runs without auth after sign-out) stays recoverable by that
  // account's next session. The wait is bounded: sign-out is best-effort.
  function releaseTokenDoc(token, uid) {
    const marker = { token, uid };
    if (uid) addPendingRelease(marker);
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), releaseWriteMs);
    });
    const deletion = Promise.resolve()
      .then(() => deleteTokenDoc(token))
      .then(
        () => {
          if (uid) clearPendingRelease(marker);
          dropCachedToken(token);
          return true;
        },
        () => false,
      );
    return Promise.race([deletion, deadline]).finally(() => clearTimeout(timer));
  }

  // Ends the session: no attempt may report or cache a token afterwards. The
  // exact in-flight token is handed back so the caller can release a document
  // the attempt had no chance to cache.
  function endSession() {
    active = false;
    session += 1;
    attempt += 1;
    writing = false;
    restoredFor = null;
    const token = inFlight;
    inFlight = null;
    return token;
  }

  return {
    get active() {
      return active;
    },
    get generation() {
      return session;
    },
    // The retry latch: a registration attempt is running.
    get writing() {
      return writing;
    },
    // The account this session already re-saved for, so the load-time restore
    // runs once per session.
    get restoredFor() {
      return restoredFor;
    },
    // The token obtained for a write that has not been released yet; exposed for
    // the screen's release plan and for tests.
    get inFlightToken() {
      return inFlight;
    },

    begin() {
      active = true;
      session += 1;
      return session;
    },

    // Sign-out/reset without a release (the document was already handed over, or
    // the cache and markers must stay retryable).
    discard() {
      endSession();
    },

    // Sign-out/revocation: end the session, then release the cached and in-flight
    // token documents plus the FCM registration. Every release is bounded and
    // best-effort; a failure leaves its retry marker behind.
    async release({ resetFcm = null } = {}) {
      const escaped = endSession();
      const plan = tokenReleasePlan({
        stored: readStoredToken(),
        inFlight: escaped,
        messaging: Boolean(resetFcm),
      });
      const pending = plan.docs.map((doc) => releaseTokenDoc(doc.token, doc.uid));
      if (plan.deleteToken) {
        pending.push(
          Promise.resolve()
            .then(resetFcm)
            .catch(() => {}),
        );
      }
      await Promise.all(pending);
    },

    // A token doc whose delete failed (offline, revoked session) is retried the
    // next time its owner is signed in. The cached token survives until the
    // delete is acknowledged, so the failure stays recoverable instead of
    // locking the browser's next account out of notifications.
    async retryPending(uid) {
      if (!uid) return;
      const markers = readPendingReleases().filter((marker) => marker.uid === uid);
      for (const marker of markers) {
        try {
          await deleteTokenDoc(marker.token);
        } catch {
          continue; // Keep this marker for the next session.
        }
        clearPendingRelease(marker);
        dropCachedToken(marker.token);
      }
    },

    // One registration attempt. `acquire` returns the browser token, `rotate`
    // re-registers after a cross-account claim denial, and `onOutcome` receives
    // the settled outcome (also after a timeout) so the screen can paint it.
    async register({ uid, acquire, rotate, onOutcome = () => {} } = {}) {
      if (!active || !uid || writing || typeof acquire !== 'function') return null;
      const attemptSession = session;
      const attemptId = ++attempt;
      writing = true;
      let savedToken = null;

      const attemptWrite = (async () => {
        let token = requireToken(await acquire());
        // A sign-out that landed while acquire() was pending already captured and
        // cleared the in-flight token. Recording this one now would attach a
        // token to no session: a later account's release would read it and try a
        // doomed cross-uid delete, potentially leaving its retry marker behind
        // forever. No document was written for it, so nothing needs releasing.
        if (!active || attemptSession !== session) return null;
        // Record the token before its document write: a sign-out that lands
        // while the write is pending must know which doc id to remove.
        inFlight = { token, uid, session: attemptSession };
        try {
          await saveTokenDoc(token, uid);
        } catch (err) {
          if (!isClaimDenial(err) || typeof rotate !== 'function') throw err;
          // The doc id still belongs to the previous account (its sign-out
          // release never reached the server). A fresh FCM registration produces
          // a new doc id, which the create rule accepts — otherwise this card
          // could never recover on this browser.
          token = requireToken(await rotate());
          // Same ordering as above: a session that ended while rotate() was
          // running gets only the token it already recorded.
          if (!active || attemptSession !== session) return null;
          inFlight = { token, uid, session: attemptSession };
          await saveTokenDoc(token, uid);
        }
        if (!active) {
          // The session ended while the write was still running. The document
          // may have landed after the sign-out release (which had no id yet), so
          // release this exact token now; if the delete is refused or the
          // backend is unreachable, the marker retries it next session.
          await releaseTokenDoc(token, uid);
          return null;
        }
        // A timed-out attempt that a newer retry superseded must not write the
        // cache, or it could resurrect a token that retry already replaced.
        if (attemptId !== attempt || attemptSession !== session) return null;
        writeStoredToken(token, uid);
        restoredFor = uid;
        savedToken = token;
        return token;
      })();

      const report = (outcome) => {
        // A newer retry (or an ended session) owns the card now.
        if (attemptId !== attempt) return;
        if (!active || attemptSession !== session) return;
        writing = false;
        onOutcome(outcome, { token: savedToken, uid });
      };

      const outcome = await settle(attemptWrite, { onLate: report });
      report(outcome);
      return outcome;
    },
  };
}
