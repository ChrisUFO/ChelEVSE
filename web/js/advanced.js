// Pure helpers for the Advanced RAPI console. No DOM, no Firebase — covered by
// test/web.

// The console mirrors the rules and the bridge: a literal "$", one or two
// letters/digits, then an optional space-separated argument list, capped at 32
// characters. The explicit newline check closes JavaScript's "$ matches before
// a final newline" quirk, so a pasted "$OK\n" never reaches Firestore.
export const RAPI_MAX = 32;
const RAPI_RE = /^\$[A-Za-z0-9]{1,2}( .*)?$/;

export function validateRapi(raw) {
  const command = typeof raw === 'string' ? raw : '';
  if (!command) {
    return { valid: false, error: 'Enter a RAPI command.', command: '' };
  }
  if (command.length > RAPI_MAX) {
    return {
      valid: false,
      error: `RAPI commands are limited to ${RAPI_MAX} characters.`,
      command,
    };
  }
  if (/[\r\n]/.test(command) || !RAPI_RE.test(command)) {
    return {
      valid: false,
      error:
        'Use $ followed by 1–2 letters or digits, then an optional argument (for example $FS 20).',
      command,
    };
  }
  return { valid: true, error: '', command };
}

// Firestore surfaces a missing composite index as failed-precondition. The
// console query is the only one that needs one, so say what is happening
// instead of showing a generic failure while the index builds. The listener is
// not retried, so recovery really does need a reload.
export function rapiErrorMessage(err) {
  const code = err && err.code;
  if (code === 'failed-precondition') {
    return 'Recent commands need a Firestore index that is still being built. They’ll appear here when it’s ready — reload the page once it has finished building.';
  }
  if (code === 'unavailable') {
    return 'Recent commands are unavailable right now. Check your connection and try again.';
  }
  return 'Couldn’t load recent commands. Reload the page to try again.';
}

export function commandMillis(createdAt) {
  if (createdAt && typeof createdAt.toMillis === 'function') return createdAt.toMillis();
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt;
  if (createdAt && typeof createdAt.seconds === 'number') return createdAt.seconds * 1000;
  return null;
}

// ---------- confirmation gate ----------

// The confirm-before-send gate, as a pure state machine so "no write before
// confirm" and the per-visit re-arm are executable without a DOM. `armed` is
// per visit: once a command has been confirmed the rest of that visit's sends
// skip the gate; entering or leaving the tab re-arms it.
export const GATE_INITIAL = Object.freeze({
  armed: false,
  open: false,
  command: '',
  sending: false,
});

// Returns `{ state, action }` where action is 'idle', 'gate', 'confirm', or
// 'send' (with `command`). The screen owns every side effect.
export function gateTransition(state, event) {
  const base = { ...GATE_INITIAL, ...(state || {}) };
  const type = event && event.type;
  if (type === 'enter' || type === 'leave') {
    // Entering and leaving both reset the per-visit confirmation. A write that
    // is already in flight keeps the form busy, though: re-entry must not
    // pretend the send is over or accept another command until it settles.
    return { state: { ...GATE_INITIAL, sending: Boolean(base.sending) }, action: 'idle' };
  }
  if (type === 'edit' || type === 'cancel') {
    return { state: { ...base, open: false, command: '' }, action: 'idle' };
  }
  if (type === 'sending') {
    return { state: { ...base, sending: Boolean(event.value) }, action: 'idle' };
  }
  if (type === 'submit') {
    if (base.sending) return { state: base, action: 'idle' };
    // A gate is already showing: the confirm press owns the send.
    if (base.open) return { state: base, action: 'confirm' };
    if (!base.armed) {
      return { state: { ...base, open: true, command: event.command }, action: 'gate' };
    }
    return { state: base, action: 'send', command: event.command };
  }
  if (type === 'confirm') {
    if (!base.open || base.sending) return { state: base, action: 'idle' };
    return {
      state: { ...base, armed: true, open: false, command: '' },
      action: 'send',
      command: base.command,
    };
  }
  return { state: base, action: 'idle' };
}
