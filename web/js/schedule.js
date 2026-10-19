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
export function reconcileDirtyRemote({ confirmed, draft, incoming }) {
  const incomingKey = scheduleKey(incoming);
  const changed = incomingKey !== scheduleKey(confirmed);
  const dirty = scheduleKey(draft) !== incomingKey;
  return {
    confirmed: incoming,
    dirty,
    remoteNotice: changed && dirty,
  };
}
