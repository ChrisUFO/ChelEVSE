// Pure schedule helpers — default draft, snapshot normalization, validation
// mirroring the rules container + bridge constraints, and change keys.
// No DOM, no Firebase; covered by test/web/schedule.test.js.

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MAX_RULES = 20;
export const MIN_AMPS = 6;
export const MAX_AMPS = 48;

// ASCII digits only, exactly HH:MM — the bridge's fullmatch validator.
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function defaultSchedule() {
  return { enabled: false, rules: [] };
}

export function defaultRule(id) {
  return { id, days: [0, 1, 2, 3, 4], start: '22:00', end: '06:00', amps: 32 };
}

function normalizeRule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // Keep the server's values visible instead of repairing them: the bridge
  // skips a rule whose days/amps are malformed, so repairing it here would let
  // a later save activate a window the charger currently ignores.
  return {
    id: typeof source.id === 'string' ? source.id : '',
    days: Array.isArray(source.days) ? [...source.days] : [],
    start: typeof source.start === 'string' ? source.start : '',
    end: typeof source.end === 'string' ? source.end : '',
    amps: source.amps !== undefined ? source.amps : 0,
  };
}

// Incoming documents may predate this editor; normalize to the editable shape
// while keeping invalid values visible so validation can flag them. The bridge
// skips a document whose `enabled` is not a boolean or whose `rules` is not a
// list and leaves the firmware untouched, so those containers are flagged
// rather than silently repaired into a saveable schedule.
export function normalizeSchedule(data) {
  if (!data || typeof data !== 'object') return defaultSchedule();
  const out = {
    enabled: data.enabled === true,
    rules: Array.isArray(data.rules) ? data.rules.map(normalizeRule) : [],
  };
  if (data.malformed === true || typeof data.enabled !== 'boolean' || !Array.isArray(data.rules)) {
    out.malformed = true;
  }
  return out;
}

function validateRule(rule) {
  const errors = {};
  if (!rule || typeof rule.id !== 'string' || rule.id.trim() === '') {
    errors.id = 'This window is missing its id.';
  }

  if (!Array.isArray(rule && rule.days) || rule.days.length === 0) {
    errors.days = 'Pick at least one day.';
  } else if (rule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.days = 'Days must be whole numbers from 0 to 6.';
  } else if (new Set(rule.days).size !== rule.days.length) {
    errors.days = 'Each weekday can only appear once.';
  }

  const start = rule && rule.start;
  const end = rule && rule.end;
  if (typeof start !== 'string' || start === '' || typeof end !== 'string' || end === '') {
    errors.start = 'Set a start and end time.';
    errors.end = 'Set a start and end time.';
  } else if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    errors.start = 'Use 24-hour times like 22:00.';
    errors.end = 'Use 24-hour times like 22:00.';
  } else if (start === end) {
    errors.start = 'Start and end must be different.';
    errors.end = 'Start and end must be different.';
  }

  if (!rule || !Number.isInteger(rule.amps)) {
    errors.amps = 'Current must be a whole number from 6 to 48 A.';
  } else if (rule.amps < MIN_AMPS || rule.amps > MAX_AMPS) {
    errors.amps = 'Current must be a whole number from 6 to 48 A.';
  }
  return errors;
}

export function validateSchedule(draft) {
  const errors = {};
  if (!draft || typeof draft !== 'object') {
    return {
      valid: false,
      errors: { enabled: 'Schedule is missing.', rules: 'Schedule is missing.' },
      ruleErrors: [],
    };
  }
  if (typeof draft.enabled !== 'boolean') errors.enabled = 'Enabled must be true or false.';
  if (draft.malformed === true) {
    errors.rules =
      'The stored schedule has an unsupported shape — edit it to replace the stored schedule.';
  } else if (!Array.isArray(draft.rules)) {
    errors.rules = 'Rules must be a list.';
  } else if (draft.rules.length > MAX_RULES) {
    errors.rules = `A schedule can hold at most ${MAX_RULES} windows.`;
  }
  const rules = Array.isArray(draft.rules) ? draft.rules : [];
  const ruleErrors = rules.map(validateRule);
  const valid = Object.keys(errors).length === 0 && ruleErrors.every((e) => !Object.keys(e).length);
  return { valid, errors, ruleErrors };
}

// Save eligibility. The bridge treats enabled:false as an explicit clear and
// ignores unusable rules, so a disable must not be blocked by rule warnings.
// Container errors (non-list, over the cap) still block every save.
export function scheduleSaveValid(draft, validation = validateSchedule(draft)) {
  if (validation.errors && Object.keys(validation.errors).length > 0) return false;
  if (draft && draft.enabled === false) return true;
  return validation.ruleErrors.every((errors) => !errors || Object.keys(errors).length === 0);
}

// Settle an optimistic save. `pendingRemote` is whatever snapshot arrived while
// the write was in flight. Firestore delivers the latency-compensated local echo
// before it rejects a failed write, so a queued snapshot that equals the payload
// is not remote truth and must never become the rollback baseline.
export function reconcileAfterSave({ confirmed, payload, pendingRemote, ok }) {
  if (ok) {
    return { baseline: normalizeSchedule(pendingRemote ?? payload), remote: false, error: '' };
  }
  const echoPending = pendingRemote != null && scheduleKey(pendingRemote) === scheduleKey(payload);
  const remote = pendingRemote != null && !echoPending;
  return {
    baseline: normalizeSchedule(remote ? pendingRemote : confirmed),
    remote,
    error: remote
      ? "Couldn't save. The latest server schedule was restored."
      : "Couldn't save. The previous schedule was restored.",
  };
}

// The save bar is driven from one pure description of the write's state.
//   queued      – the SDK holds the write in its persistent queue (offline, or
//                 the connection dropped mid-write); it is durable, not lost.
//   unconfirmed – the UI stopped waiting while the browser still says online.
//   dirty       – the draft differs from the last locally accepted payload (the
//                 queued payload while queued, otherwise the confirmed snapshot),
//                 so a queued save is not "unsaved" but a later edit is.
// `saved` only means the last write was acknowledged: with a newer draft the
// bar reports the previous change instead of a misleading "Saved.".
export function queuedSaveState({
  online = true,
  saving = false,
  queued = false,
  unconfirmed = false,
  dirty = false,
  saved = false,
  error = '',
} = {}) {
  const idle = { label: '', kind: '', busy: false, canSave: false, canDiscard: false };
  if (error) return { ...idle, label: error, kind: 'err', canSave: dirty, canDiscard: dirty };
  if (saving && online) return { ...idle, label: 'Saving…', busy: true };
  if (queued) {
    return {
      ...idle,
      label: dirty
        ? 'Queued — will save when online. Newer edits are not saved yet.'
        : 'Queued — will save when online.',
      kind: 'warn',
      canSave: dirty,
      canDiscard: true,
    };
  }
  if (saving || unconfirmed) {
    return {
      ...idle,
      label: 'Save unconfirmed — connection lost. You can keep editing.',
      kind: 'warn',
      canSave: dirty,
      canDiscard: true,
    };
  }
  if (saved) {
    if (dirty) {
      return {
        ...idle,
        label: 'Previous change saved — save your latest edits.',
        kind: 'warn',
        canSave: true,
        canDiscard: true,
      };
    }
    return { ...idle, label: 'Saved.', kind: 'ok' };
  }
  if (dirty) {
    return { ...idle, label: 'Unsaved changes.', kind: 'warn', canSave: true, canDiscard: true };
  }
  return idle;
}

// A `schedule/current` snapshot carries `metadata.hasPendingWrites`. Across a
// reload that flag is the only evidence of an unacknowledged write: the save
// that issued it belonged to a previous page, so no promise in this session
// will settle it. One transition rule drives the editor's queued state:
//   - a local save in flight (`saving`/`savingUnconfirmed`) owns the save bar;
//     a watch snapshot never relabels it.
//   - `pendingWrites === true` means the write is still queued (or a newer write
//     replaced it): the snapshot's key becomes the queued payload.
//   - `pendingWrites === false` while queued resolves it. The snapshot key
//     matching the queued payload is 'acked' (the draft is untouched); a
//     different key is 'reverted' — the queued change never landed.
//   - metadata absent (`undefined`/`null`) is not evidence of acknowledgement
//     and leaves the state alone.
// `adopt` marks a reverted snapshot the screen may replace the draft with: only
// when the draft still matches the queued payload, never a dirty draft.
export function reloadQueuedState({
  pendingWrites,
  queued = false,
  saving = false,
  savingUnconfirmed = false,
  dataKey = null,
  payloadKey = null,
  draftKey = null,
} = {}) {
  const unchanged = { queued, payloadKey, outcome: 'none', adopt: false };
  if (saving || savingUnconfirmed) return unchanged;
  if (pendingWrites === true) {
    return {
      queued: true,
      payloadKey: dataKey,
      outcome: payloadKey != null && payloadKey === dataKey ? 'none' : 'queued',
      adopt: false,
    };
  }
  if (!queued || pendingWrites !== false) return unchanged;
  const acked = payloadKey != null && payloadKey === dataKey;
  return {
    queued: false,
    payloadKey: null,
    outcome: acked ? 'acked' : 'reverted',
    adopt: !acked && payloadKey != null && draftKey === payloadKey,
  };
}

// A queued write rediscovered after a reload has no cached pre-write baseline:
// the local document already carries the mutation, so Discard would re-save the
// queued change. The previous schedule has to come from the server, and the
// control is only honest when that read succeeded. `status` is the single
// decision the screen renders:
//   ready       – the server copy differs from the queued payload; Discard can
//                 restore it with the compensating write.
//   committed   – the server already holds the queued payload: there is nothing
//                 to discard, and writing again would repeat it.
//   checking    – the server read is still in flight, or the fetched copy
//                 belongs to a different queued payload and a fresh read is
//                 starting.
//   unavailable – no baseline can be trusted. The copy names the actual cause:
//                 offline needs a connection to restore the saved schedule; a
//                 read that failed (or never answered) on a healthy connection
//                 is a check failure, not a connectivity problem.
// `baselineKey` is the queued payload the fetched copy was read for: it must
// still be the current `payloadKey`, or the copy says nothing about the queued
// write Discard would compensate.
export const DISCARD_OFFLINE_REASON = 'Discard needs a connection to restore the saved schedule.';
export const DISCARD_FAILED_REASON = "Couldn't check the saved schedule — Discard is unavailable.";
export const DISCARD_CHECKING_REASON = 'Checking the saved schedule before Discard…';
export const DISCARD_COMMITTED_REASON = 'The queued change is already saved — nothing to discard.';

export function reloadDiscardBaseline({
  baseline = null,
  baselineKey = null,
  payloadKey = null,
  online = true,
  pending = false,
  failed = false,
} = {}) {
  if (!online) {
    return { status: 'unavailable', baseline: null, reason: DISCARD_OFFLINE_REASON };
  }
  if (failed) {
    return { status: 'unavailable', baseline: null, reason: DISCARD_FAILED_REASON };
  }
  if (pending) {
    return { status: 'checking', baseline: null, reason: DISCARD_CHECKING_REASON };
  }
  if (baseline == null) {
    return { status: 'unavailable', baseline: null, reason: DISCARD_FAILED_REASON };
  }
  // A copy fetched for an earlier queued payload cannot justify Discard for the
  // current one: the screen invalidates it and reads again.
  if (payloadKey != null && baselineKey !== payloadKey) {
    return { status: 'checking', baseline: null, reason: DISCARD_CHECKING_REASON };
  }
  if (payloadKey != null && scheduleKey(baseline) === payloadKey) {
    return { status: 'committed', baseline: null, reason: DISCARD_COMMITTED_REASON };
  }
  return { status: 'ready', baseline, reason: '' };
}

// What the screen must do when a baseline read is requested for the current
// queued payload. A ready or in-flight read is reusable only for the payload it
// was started for; a different payload invalidates it (the screen bumps its read
// token so a late response cannot land) and starts a fresh server read. A
// `fresh` trigger resets the bounded retry budget even when the read it
// interrupts was still in flight, so that reset must happen before any early
// return. No queued payload key means there is nothing to fetch a baseline for.
export function discardBaselineStart({
  status = 'idle',
  baselineKey = null,
  payloadKey = null,
  fresh = false,
  online = true,
} = {}) {
  const applies = payloadKey != null && baselineKey === payloadKey;
  const reusable = (status === 'loading' || status === 'ready') && applies;
  return {
    reusable,
    invalidate: (status === 'loading' || status === 'ready') && !applies,
    resetRetries: fresh,
    start: !reusable && online && payloadKey != null,
  };
}

// A server read for a reload-queued Discard baseline may only install its
// result while it still owns the baseline: the same page generation, the same
// read token (bumped when a new payload invalidates the read), and the queued
// payload it was issued for.
export function discardBaselineReadApplies({
  readGeneration = null,
  generation = null,
  readToken = null,
  token = null,
  readKey = null,
  payloadKey = null,
} = {}) {
  return (
    readGeneration === generation &&
    readToken === token &&
    readKey != null &&
    readKey === payloadKey
  );
}

// A baseline read that failed while the browser reports online is usually
// transient (a 500, a timeout). Retrying it with bounded backoff gives Discard a
// second chance without waiting for a reconnect event that may never fire;
// `attempts` counts the retries already made, and `null` means the budget is
// spent (a reconnect or a new queued payload starts a fresh one). A failed read
// while offline is not retried on a timer: the `online` event is its trigger.
export const DISCARD_RETRY_DELAYS_MS = [5000, 15000, 30000];

export function discardRetry({ status = 'idle', online = true, attempts = 0 } = {}) {
  if (status !== 'failed' || !online) return null;
  return attempts < DISCARD_RETRY_DELAYS_MS.length ? DISCARD_RETRY_DELAYS_MS[attempts] : null;
}

// Which schedule Discard restores, and `null` when there is nothing it may
// write. A write rediscovered after a reload can only compensate against the
// fetched server copy, and only once the read is `ready`; an in-session write
// keeps reverting to the confirmed snapshot, as before.
export function discardTarget({
  queuedFromSnapshot = false,
  decision = null,
  confirmed = null,
} = {}) {
  if (!queuedFromSnapshot) return confirmed;
  return decision && decision.status === 'ready' ? decision.baseline : null;
}

// Stable comparison for "unsaved changes" and for ignoring stale snapshots
// that arrive after a successful save. Day order is not meaningful. The
// malformed flag is part of the key: clearing it by editing is a real change
// (an explicit replacement of the stored shape).
export function scheduleKey(schedule) {
  const rules = schedule && Array.isArray(schedule.rules) ? schedule.rules : [];
  return JSON.stringify({
    enabled: Boolean(schedule && schedule.enabled === true),
    rules: rules.map((rule) => ({
      id: rule && rule.id,
      days: rule && Array.isArray(rule.days) ? [...new Set(rule.days)].sort((a, b) => a - b) : [],
      start: rule && rule.start,
      end: rule && rule.end,
      amps: rule && rule.amps,
    })),
    malformed: Boolean(schedule && schedule.malformed === true),
  });
}

// A server snapshot arrived while the user has unsaved edits. The confirmed
// baseline always tracks server truth (the live banner and rollback read it),
// the draft is never overwritten, and the overwrite notice marks a real remote
// change. If the remote copy happens to match the draft, nothing is unsaved.
// `metadataOnly` marks a notification that repeated the data (a metadata change
// such as an acknowledgment or a fromCache flip): it must not erase the notice
// explaining the last real change.
export function reconcileDirtyRemote({ confirmed, draft, incoming }) {
  const incomingKey = scheduleKey(incoming);
  const changed = incomingKey !== scheduleKey(confirmed);
  const dirty = scheduleKey(draft) !== incomingKey;
  return {
    confirmed: incoming,
    dirty,
    remoteNotice: changed && dirty,
    metadataOnly: !changed,
  };
}

// Route a `schedule/current` snapshot to the one branch the screen may take.
// The branch order is the contract:
//   1. a write this page issued (`saving`/`savingUnconfirmed`) or a queued write
//      that still has a promise (`queued && !queuedFromSnapshot`) owns the save
//      bar until it settles; the snapshot is only a candidate baseline, and a
//      metadata repeat changes no notice.
//   2. a write rediscovered from snapshot metadata (or a `pendingWrites` flag)
//      is resolved by `reloadQueuedState`: an ack or a replacement transitions,
//      while a same-payload repeat of an already queued write is inert.
//   3. a dirty draft reconciles through `reconcileDirtyRemote`, whose
//      `metadataOnly` flag keeps the notice explaining the last real change.
//   4. a clean draft treats a data-identical repeat as a no-op (keeping "Saved."
//      and any notice) and only adopts a genuinely new server state.
// `remoteChange` is `null` when the notice must stay as it is, otherwise whether
// the snapshot is a real remote change.
export function routeScheduleSnapshot({
  initialized = false,
  saving = false,
  savingUnconfirmed = false,
  queued = false,
  queuedFromSnapshot = false,
  dirty = false,
  confirmed = null,
  draft = null,
  incoming = null,
  pendingWrites = undefined,
  payloadKey = null,
} = {}) {
  const dataKey = scheduleKey(incoming);
  if (!initialized) {
    // The screen adopts the snapshot before applying the transition, so the
    // draft it compares is the incoming data.
    return {
      kind: 'initial',
      transition: reloadQueuedState({
        pendingWrites,
        queued,
        saving,
        savingUnconfirmed,
        dataKey,
        payloadKey,
        draftKey: dataKey,
      }),
    };
  }
  const confirmedKey = scheduleKey(confirmed);
  if (saving || savingUnconfirmed || (queued && !queuedFromSnapshot)) {
    return {
      kind: 'in-flight',
      remoteChange: dataKey === confirmedKey ? null : Boolean(payloadKey && dataKey !== payloadKey),
    };
  }
  if (queuedFromSnapshot || pendingWrites === true) {
    const transition = reloadQueuedState({
      pendingWrites,
      queued,
      saving,
      savingUnconfirmed,
      dataKey,
      payloadKey,
      draftKey: scheduleKey(draft),
    });
    if (transition.outcome !== 'none') return { kind: 'transition', transition };
    if (queued) return { kind: 'queued-still' };
  }
  if (dirty) {
    return { kind: 'dirty', reconcile: reconcileDirtyRemote({ confirmed, draft, incoming }) };
  }
  if (dataKey === confirmedKey) return { kind: 'repeat' };
  return { kind: 'adopt' };
}

// Copy for the schedule toggle. A malformed stored container is an unknown
// state, not "off": the bridge skips it and leaves the charger's own firmware
// schedule untouched, so the editor must not claim charging is unrestricted.
export function toggleNote(schedule) {
  if (schedule && schedule.malformed === true) {
    return 'Unsupported stored schedule — the charger may still be running its own firmware schedule until a valid schedule is saved.';
  }
  return schedule && schedule.enabled === true
    ? 'Charging follows these windows.'
    : 'Charging is not restricted by a schedule.';
}
