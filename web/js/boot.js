// Pure helpers for the boot watchdog. No DOM, no Firebase — covered by test/web.
//
// The app waits on network-bound work (config fetch, SDK load, auth restore)
// before it can show anything but the boot line. A single timer escapes that
// wait: it exists only while boot is on screen, and it fires only if boot is
// still the current screen when it expires.

// Returns `{ arm, clear }`. `arm` replaces any pending timer and schedules one
// timeout that calls `onTimeout` at most once, and only while `isBooting()`;
// `clear` cancels the pending timer and is safe to call repeatedly. Both are
// idempotent, so the callers can clear on every screen change without tracking
// timer state themselves.
export function createBootGuard({
  timeoutMs,
  isBooting,
  onTimeout,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let timer = null;
  let fired = false;

  function clear() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function arm() {
    clear();
    fired = false;
    // Arming outside boot would time out a screen that is already settled.
    if (!isBooting()) return;
    timer = setTimeout(() => {
      timer = null;
      // The screen may have moved on between arming and expiry; a stale timer
      // must never overwrite a later screen or a more specific error.
      if (fired || !isBooting()) return;
      fired = true;
      onTimeout();
    }, timeoutMs);
  }

  return { arm, clear };
}
