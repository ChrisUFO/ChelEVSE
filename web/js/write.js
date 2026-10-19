// Bounded UI wait for Firestore writes. No DOM, no Firebase — covered by
// test/web.
//
// A write settles only when the backend acknowledges it. When the browser
// reports online but the backend is unreachable (captive portal, DNS or VPN
// flap, an outage), that promise can stay pending for as long as the SDK's
// queue holds it, which would leave a form disabled on "Saving…" forever. The
// timeout here is a UI bound only: the write keeps running and `onLate` reports
// its real outcome so the screen can reconcile.

export const WRITE_TIMEOUT_MS = 10000;

// Resolves `{ status: 'ok' }`, `{ status: 'error', error }`, or
// `{ status: 'timeout' }` at the deadline. `onLate` runs only when the timeout
// won the race and the write settles afterwards.
export function settleWrite(write, { timeout = WRITE_TIMEOUT_MS, onLate } = {}) {
  const outcome = Promise.resolve(write).then(
    () => ({ status: 'ok' }),
    (error) => ({ status: 'error', error }),
  );
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeout);
  });
  return Promise.race([outcome, deadline]).then((result) => {
    clearTimeout(timer);
    if (result.status === 'timeout' && typeof onLate === 'function') {
      outcome.then((settled) => {
        try {
          onLate(settled);
        } catch {
          // A reconciler must never surface as an unhandled rejection.
        }
      });
    }
    return result;
  });
}
