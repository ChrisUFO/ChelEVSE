// Per-account dismissal records for the Status screen's Health card (#205).
// DOM-free and storage-injected, modelled on notification-session.js: the
// screen hands it a signed-in uid and an advisory, and it keeps
//
//   { "<uid>": { "<advisory id>": { severity, dismissedAt } } }
//
// under one localStorage key. What a record hides and when one is retired is
// health.js's decision (an advisory is hidden while its severity is unchanged,
// and a record leaves once the snapshot stops listing its id) — this module
// only keeps them, so that logic stays unit-testable without any storage.
//
// Tolerant by design, three ways: a store that is unreadable or not this shape
// reads as empty rather than throwing into a render; a refused write is
// swallowed; and because that refusal must not undo the click the owner just
// made, every change is written to an in-memory copy first. So a private-mode
// or over-quota storage degrades to a hide that lasts this page's session,
// instead of to a button that does nothing.

export const DISMISSALS_KEY = 'chelevse.healthDismissals';

function safeStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // Access can throw in private mode; the card then keeps dismissals in
    // memory for this page only.
  }
  return null;
}

// An account to scope to. Nothing is read or written without one: a record
// under no uid would be every signed-out visitor's.
function isUid(uid) {
  return typeof uid === 'string' && uid !== '';
}

function isRecord(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.severity === 'string' &&
    typeof value.dismissedAt === 'number' &&
    Number.isFinite(value.dismissedAt)
  );
}

// Only records in the exact shape this module writes survive a read — a
// hand-edited or older-shaped entry is dropped, never guessed at. Built from
// entries so an id cannot become a prototype (`__proto__` stays an own key).
function recordsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, record]) => isRecord(record))
      .map(([id, record]) => [id, { severity: record.severity, dismissedAt: record.dismissedAt }]),
  );
}

function sameRecords(a, b) {
  const ids = Object.keys(a);
  return (
    ids.length === Object.keys(b).length &&
    ids.every(
      (id) =>
        Object.hasOwn(b, id) &&
        b[id].severity === a[id].severity &&
        b[id].dismissedAt === a[id].dismissedAt,
    )
  );
}

// `storage` is a localStorage-compatible adapter (tests pass a Map wrapper);
// `now` stamps each record, injected so the stamp is assertable.
export function createDismissalStore({
  storage = safeStorage(),
  key = DISMISSALS_KEY,
  now = Date.now,
} = {}) {
  // Each account's map as this page last wrote it, whether or not storage
  // took it. `read` prefers a copy here over what storage holds for that uid.
  const written = new Map();

  function readRaw() {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(raw) {
    if (!storage) return;
    try {
      storage.setItem(key, raw);
    } catch {
      // Private-mode and quota failures must not break the card.
    }
  }

  function remove() {
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      // Same tolerance as write.
    }
  }

  function read(uid) {
    if (!isUid(uid)) return {};
    if (written.has(uid)) return { ...written.get(uid) };
    let all;
    try {
      all = JSON.parse(readRaw());
    } catch {
      return {};
    }
    // Own key only: an account spelled like an inherited name must read as
    // absent, not as `Object.prototype`'s member.
    return recordsOf(
      all && typeof all === 'object' && !Array.isArray(all) && Object.hasOwn(all, uid)
        ? all[uid]
        : null,
    );
  }

  // One account's whole map, written through. `records` is already in this
  // module's shape. An empty map retires the account's entry, and the key
  // itself goes once no account is left, so the store never grows a tombstone.
  function commit(uid, records) {
    written.set(uid, { ...records });
    let all = {};
    try {
      const parsed = JSON.parse(readRaw());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed;
    } catch {
      // An unreadable store is replaced, not merged into.
    }
    const others = { ...all };
    delete others[uid];
    const next = Object.keys(records).length ? { ...others, [uid]: records } : others;
    if (!Object.keys(next).length) remove();
    else write(JSON.stringify(next));
  }

  return {
    read,

    // Hide one advisory for this account. Returns the record, or null when
    // there is no account or no advisory to key it by.
    dismiss(uid, advisory) {
      if (!isUid(uid) || !advisory) return null;
      const { id, severity } = advisory;
      if (typeof id !== 'string' || typeof severity !== 'string') return null;
      const record = { severity, dismissedAt: now() };
      commit(uid, { ...read(uid), [id]: record });
      return record;
    },

    // Make `records` this account's whole map — the path the screen uses for
    // a map health.js has already pruned. Records outside the stored shape
    // are dropped, and an unchanged map writes nothing.
    replace(uid, records) {
      if (!isUid(uid)) return {};
      const next = recordsOf(records);
      if (!sameRecords(read(uid), next)) commit(uid, next);
      return next;
    },
  };
}
