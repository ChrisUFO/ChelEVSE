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
// instead of showing a generic failure while the index builds.
export function rapiErrorMessage(err) {
  const code = err && err.code;
  if (code === 'failed-precondition') {
    return 'Recent commands need a Firestore index that is still being built. They’ll appear here when it’s ready.';
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
