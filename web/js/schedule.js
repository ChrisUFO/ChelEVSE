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
  const days = Array.isArray(raw && raw.days)
    ? [...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  let amps = raw && raw.amps;
  if (typeof amps !== 'number') amps = Number(amps);
  return {
    id: raw && typeof raw.id === 'string' ? raw.id : '',
    days,
    start: raw && typeof raw.start === 'string' ? raw.start : '',
    end: raw && typeof raw.end === 'string' ? raw.end : '',
    amps: Number.isFinite(amps) ? amps : 0,
  };
}

// Incoming documents may predate this editor; normalize to the editable shape
// while keeping invalid values visible so validation can flag them.
export function normalizeSchedule(data) {
  if (!data || typeof data !== 'object') return defaultSchedule();
  return {
    enabled: data.enabled === true,
    rules: Array.isArray(data.rules) ? data.rules.map(normalizeRule) : [],
  };
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
  if (!Array.isArray(draft.rules)) {
    errors.rules = 'Rules must be a list.';
  } else if (draft.rules.length > MAX_RULES) {
    errors.rules = `A schedule can hold at most ${MAX_RULES} windows.`;
  }
  const rules = Array.isArray(draft.rules) ? draft.rules : [];
  const ruleErrors = rules.map(validateRule);
  const valid = Object.keys(errors).length === 0 && ruleErrors.every((e) => !Object.keys(e).length);
  return { valid, errors, ruleErrors };
}

// Stable comparison for "unsaved changes" and for ignoring stale snapshots
// that arrive after a successful save. Day order is not meaningful.
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
  });
}
