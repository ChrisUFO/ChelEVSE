// Pure helpers for the app-settings form. No DOM, no Firebase — covered by
// test/web.

import {
  ANNUAL_DAYS,
  MAX_RATE_WINDOWS,
  RATE_MAX,
  RATE_MIN,
  annualDayIndex,
  annualMonthDay,
  intersectDateSets,
  isBaseWindow,
  lastDayOfMonth,
  monthsCovering,
  normalizeRateSchedule,
  normalizeWindow,
  overlappingWindowPairs,
  parseMonthDay,
  parseRateValue,
  rateDayPartition,
  rateEntryAt,
  rateWindowsKey,
  scopeMatches,
  seasonDateSet,
  seasonScope,
  validateRateWindows,
  windowSegments,
} from './rates.js';
import { DAY_NAMES } from './schedule.js';

// The rate bounds live in rates.js: the same 0–5 limit governs a flat rate and
// a window row, so both validators share one definition.
export { RATE_MAX, RATE_MIN } from './rates.js';

// A rate the engine can actually use: finite once parsed and inside the
// documented bounds. The validators and the resolver both reject anything else,
// so any view asking "does this row have a price?" must ask it the same way —
// otherwise it quotes a price the rest of the screen denies.
export function rateIsUsable(value) {
  const rate = parseRateValue(value);
  return Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX;
}

// Mirror firestore.rules: a write must carry both flat fields, rate is a number
// from 0 to 5, currency is a string of 1–8 characters. The optional `rates`
// list is a season plan; the stored flat rate is used only when no usable row
// remains. Its rows are validated by validateRateWindows (rules only guard the
// container).
export const CURRENCY_MAX = 8;

// The charger address grammar (issue #54), mirrored exactly by the bridge's
// `_normalize_charger_host` (pi/bridge.py) so the app rejects and normalizes the
// same values the running bridge does. `firestore.rules` enforces only the
// coarse part (length, character set, first/last alphanumeric): rules cannot
// split labels or compare octets.
export const CHARGER_HOST_MAX = 253;
export const CHARGER_HOST_LABEL_MAX = 63;
const CHARGER_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CHARGER_HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const OCTET_RE = /^[0-9]+$/;

// An IPv4 literal or a hostname, or an error that names the failure. Empty
// (after trim) is valid and means unset: the bridge then falls back to its
// `CHARGER_HOST` bootstrap. A scheme, port, path, userinfo and inner whitespace
// are rejected by construction, as are a leading/trailing dot or hyphen, a
// 64-character label, a 254-character address and an octet above 255. Case is
// kept exactly as typed.
export function validateChargerHost(value) {
  // A non-string (a console-written number, say) is not an address. Mirroring the
  // bridge: it rejects a non-string outright rather than stringifying it.
  if (value != null && typeof value !== 'string') {
    return {
      value: '',
      error: 'Enter an IPv4 address or hostname, like 192.168.1.50 or evse.local.',
    };
  }
  const host = (value || '').trim();
  if (!host) return { value: '', error: null };
  const reject = (error) => ({ value: '', error });
  if (host.includes('://')) return reject('Enter just the address — no http:// or https://.');
  if (host.includes('@')) return reject('Enter just the address — no username or password.');
  if (host.includes('/')) return reject('Enter just the address — no path.');
  if (host.includes(':')) return reject('Enter just the address — no port number.');
  if (/\s/.test(host)) return reject('Remove the spaces from the address.');
  if (host.length > CHARGER_HOST_MAX) {
    return reject(`Use ${CHARGER_HOST_MAX} characters or fewer.`);
  }
  if (!CHARGER_HOST_RE.test(host)) {
    if (/^\.|\.$/.test(host)) return reject('The address cannot start or end with a dot.');
    if (/^-|-$/.test(host)) return reject('The address cannot start or end with a hyphen.');
    return reject('Use only letters, numbers, dots and hyphens.');
  }
  const labels = host.split('.');
  for (const label of labels) {
    if (label.length === 0) return reject('Each part of the address must be 1–63 characters.');
    if (label.length > CHARGER_HOST_LABEL_MAX) {
      return reject(
        `Each part of the address must be ${CHARGER_HOST_LABEL_MAX} characters or fewer.`,
      );
    }
    if (!CHARGER_HOST_LABEL_RE.test(label)) {
      return reject('A part of the address cannot start or end with a hyphen.');
    }
  }
  // Four all-numeric labels are an IPv4 literal, so each must be a real octet.
  if (labels.length === 4 && labels.every((label) => OCTET_RE.test(label))) {
    if (labels.some((label) => Number(label) > 255)) {
      return reject('Each part of an IPv4 address must be 0–255.');
    }
  }
  return { value: host, error: null };
}

// The form trims the currency, so a stray space cannot produce a string that
// rules would accept but people would read as empty. An absent `rates` list is
// a complete configuration: the flat rate covers every moment; likewise an
// absent/blank charger address means "use the bridge's bootstrap".
export function validateSettings(draft) {
  const errors = {};
  const rate = parseRateValue(draft && draft.rate);

  if (!Number.isFinite(rate)) {
    errors.rate = 'Enter a rate between 0 and 5.';
  } else if (rate < RATE_MIN || rate > RATE_MAX) {
    errors.rate = `Rate must be between ${RATE_MIN} and ${RATE_MAX}.`;
  }

  const rawCurrency = draft && draft.currency;
  const currency = typeof rawCurrency === 'string' ? rawCurrency.trim() : '';
  if (!currency) {
    errors.currency = 'Enter a currency, like USD or $.';
  } else if (currency.length > CURRENCY_MAX) {
    errors.currency = `Use ${CURRENCY_MAX} characters or fewer.`;
  }

  // An empty charger address is a valid (unset) choice, never a blocker: the
  // save then omits the key and the bridge reverts to its bootstrap.
  const host = validateChargerHost(draft && draft.chargerHost);
  if (host.error) errors.chargerHost = host.error;

  // The temperature toggle is a checkbox, so the draft is already boolean;
  // anything else (a form built without the field) reads as the default
  // "visible" and can never block a save.
  const showTemperature = !(draft && draft.showTemperature === false);

  // The rate editor owns the row and document-level rate messages; this
  // validator only reports the flat pair. A stored schedule must still be valid
  // for the document to be saveable (and must never be silently dropped), so its
  // verdict folds into `valid` without a second message channel.
  const windows = validateRateWindows(draft && draft.rates);

  return {
    valid: Object.keys(errors).length === 0 && windows.valid,
    errors,
    values: { rate, currency, rates: windows.values, chargerHost: host.value, showTemperature },
  };
}

// Only the documented shape is adopted from Firestore; anything else leaves the
// form empty for the owner to replace. Every rate row is kept here, invalid
// values included: the editor has to show a malformed stored row with its error
// rather than delete it silently on the next save. The costing layer
// (normalizeRateSchedule) still drops unusable rows, so a partially corrupt
// document prices what it can; the flat rate remains only when no usable row is
// left.
//
// The charger address is optional and never blocks a save: a stored value the
// grammar rejects (a console-written scheme or port, say) normalizes to '' so the
// form stays saveable and the next write replaces it. A valid host is carried
// through so an unrelated rate edit re-sends it instead of deleting it — the
// settings write replaces the whole document.
//
// `show_temperature` is optional the same way, with absent/non-bool meaning
// visible: a corrupt value must not hide the stat nor block a save.
export function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const normalized = normalizeRateSchedule(data);
  if (normalized.rate == null || normalized.currency == null) return null;
  const rates = Array.isArray(data.rates) ? data.rates.map(normalizeWindow) : [];
  return {
    rate: normalized.rate,
    currency: normalized.currency,
    rates,
    // Stored shape, like every other key here: normalizeSettings output is fed
    // back into settingsFields (showSettingsData -> setFields), so the key must
    // survive that round trip.
    charger_host: validateChargerHost(data.charger_host).value,
    show_temperature: data.show_temperature !== false,
  };
}

// The form's fields. `rates` travels with them so a rate/currency edit never
// deletes a stored schedule, and the rate table can round-trip rows it does not
// change. `chargerHost` travels the same way: the form always holds the stored
// address, so a rate-only save does not drop it from the whole-document write.
// `showTemperature` rides along identically.
export function settingsFields(settings) {
  const normalized = normalizeSettings(settings);
  return normalized
    ? {
        rate: String(normalized.rate),
        currency: normalized.currency,
        rates: normalized.rates,
        chargerHost: normalized.charger_host,
        showTemperature: normalized.show_temperature,
      }
    : { rate: '', currency: '', rates: [], chargerHost: '', showTemperature: true };
}

// The form before the first settings snapshot is blank apart from whatever the
// owner typed into it, so it carries none of the stored values that a
// whole-document write must re-send. Hydrating it as-is would discard that
// typing; adopting it as-is would delete the stored rate plan and charger
// address. Fill the blanks from the snapshot and keep what the owner typed.
export function firstLoadFields(draft, stored) {
  const fields = settingsFields(stored);
  const kept = (value) => typeof value === 'string' && value.trim() !== '';
  const rows = Array.isArray(draft && draft.rates) ? draft.rates : [];
  // The checkbox's untouched state is checked (visible), so only an explicit
  // off-toggle counts as typing; anything else adopts the stored preference.
  const toggledOff = draft && draft.showTemperature === false;
  // Stored values arrive in the stored shape; a draft row the owner typed is
  // already an editor row. writeFields normalizes both, and rateRowFields maps
  // an editor row to itself, so the mix is inert.
  return {
    rate: kept(draft && draft.rate) ? draft.rate : fields.rate,
    currency: kept(draft && draft.currency) ? draft.currency : fields.currency,
    chargerHost: kept(draft && draft.chargerHost) ? draft.chargerHost : fields.chargerHost,
    showTemperature: toggledOff ? false : fields.showTemperature,
    rates: rows.length ? rows : fields.rates,
  };
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));

// One rate-table row as the form holds it: the rate is text because it feeds a
// number input, and every other field keeps the stored value (invalid ones too)
// so validation can point at it. The optional season bounds travel with the row
// so an unrelated edit (or an old month-only control) never drops them.
export function rateRowFields(raw) {
  const window = normalizeWindow(raw);
  return {
    id: window.id,
    rate: Number.isFinite(window.rate) ? String(window.rate) : '',
    days: window.days,
    start: window.start,
    end: window.end,
    months: Array.isArray(window.months) ? [...window.months] : window.months,
    from: window.from,
    to: window.to,
  };
}

// A fresh row is the everyday overnight preset with no price filled in: a
// made-up rate would be easy to save by accident, so the empty field keeps the
// row visibly incomplete until the owner enters their own. `months` is the
// period's scope, never a per-row choice; `dates` (optional `{from, to}`)
// carries a day-precision scope the same way.
export function defaultRateRow(id, months = null, dates = null) {
  return {
    id,
    rate: '',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '07:00',
    months: Array.isArray(months) ? [...months] : months,
    from: dates && dates.from != null ? dates.from : null,
    to: dates && dates.to != null ? dates.to : null,
  };
}

// ---------- month scopes and periods ----------

const ALL_MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

// The stored month value reduced to what it means for matching, without losing
// the fact that it is unusable. `all` covers the whole year (`null` or a real
// 12-month list); `months` is the unique sorted list the row can match; and
// `invalid` is a value that matches nothing (`[]`, a non-list, or values that
// are all outside 1–12). Entries outside the range alongside valid months are
// kept in the row for validation, while grouping uses the months that can
// actually match.
export function rateMonthScope(row) {
  const months = row && row.months;
  if (months == null) return { kind: 'all', months: null };
  if (!Array.isArray(months)) return { kind: 'invalid', months: [] };
  const valid = [];
  for (const month of months) {
    if (Number.isInteger(month) && month >= 1 && month <= 12 && !valid.includes(month)) {
      valid.push(month);
    }
  }
  valid.sort((a, b) => a - b);
  if (valid.length === 0) return { kind: 'invalid', months: [] };
  if (valid.length === 12) return { kind: 'all', months: null };
  return { kind: 'months', months: valid };
}

function sameMonthSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  const a = new Set(left);
  return a.size === right.length && right.every((month) => a.has(month));
}

// The stored season scope as the editor projects it. Date mode outranks months
// whenever both bounds are valid; `months` is then the derived compatibility
// hint, never what decides matching. An unusable pair is `invalid`, so a typo
// never silently falls back to stale months.
export function rateScope(row) {
  const scope = seasonScope(row);
  if (scope.kind === 'dates') {
    return { ...scope, months: monthsCovering(scope.from, scope.to) };
  }
  return scope;
}

function scopeOf(value) {
  if (!value) return { kind: 'invalid', months: [] };
  if (value.kind === 'dates' && value.fromKey != null) return value;
  if (value.kind === 'dates') return seasonScope({ from: value.from, to: value.to });
  if (value.kind === 'months' || value.kind === 'all' || value.kind === 'invalid') return value;
  return rateScope(value);
}

// A zero-padded "MM-DD" from a month and day (values are validated by the
// caller; this is only the storage spelling the editor writes).
function formatMonthDay(month, day) {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The raw date bounds a period's rows carry, even when they are invalid. The
// period's `kind` may be `invalid` for an unusable pair, so the editor reads the
// stored values here rather than from the derived scope.
export function periodDateBounds(period) {
  const entries = (period && period.rows) || [];
  for (const entry of entries) {
    const row = entry && entry.row;
    if (!row) continue;
    const from = row.from == null || row.from === '' ? null : row.from;
    const to = row.to == null || row.to === '' ? null : row.to;
    if (from != null || to != null) return { from, to };
  }
  return { from: null, to: null };
}

// Whether a period is in date mode. A one-sided or unreal pair still counts:
// the owner needs the date fields to see and fix the stored value.
export function periodHasDates(period) {
  const bounds = periodDateBounds(period);
  return bounds.from != null || bounds.to != null;
}

// Whether a period's stored month values are not the canonical set the scope
// derives from them: an entry outside 1–12, a duplicate, a non-list, or a list
// that repeats an all-year scope. Such a row is rejected by validation, and no
// date range can repair it — only the chips can rewrite the months.
function monthsNeedRepair(period) {
  const entries = (period && period.rows) || [];
  return entries.some((entry) => {
    const raw = entry && entry.row ? entry.row.months : null;
    if (raw == null) return false;
    if (!Array.isArray(raw)) return true;
    const scope = rateMonthScope({ months: raw });
    if (scope.kind === 'invalid') return true;
    if (scope.kind === 'all') return raw.length !== 12 || new Set(raw).size !== 12;
    return (
      raw.length !== scope.months.length || !scope.months.every((month) => raw.includes(month))
    );
  });
}

// The month-chip editor is a compatibility path, not a normal editor: dates are
// the scope for every season the owner creates. It is offered only where dates
// cannot express the stored scope — a legacy non-contiguous month list (Jan +
// Jun), or a month scope that has to be repaired. A contiguous month range and a
// date season both reach their scope through the date fields.
export function monthEditorIsLegacy(period) {
  if (!period || periodHasDates(period)) return false;
  if (period.kind === 'invalid') return true;
  // A malformed stored list outranks the shape tests: its canonical set can be a
  // single contiguous run (months [1, 13] reads as January), so the run count
  // alone would hide the only editor that can repair it.
  if (monthsNeedRepair(period)) return true;
  if (period.kind !== 'months') return false;
  return monthRuns(period.months).length !== 1;
}

// A month scope as the contiguous run the date editor can seed, or null when it
// is not one run (January + June). All-year is represented by `all`.
export function monthScopeBounds(months) {
  const scope = rateMonthScope({ months });
  if (scope.kind === 'all') return { all: true, fromMonth: null, toMonth: null };
  if (scope.kind !== 'months') return null;
  const runs = monthRuns(scope.months);
  if (runs.length !== 1) return null;
  return { all: false, fromMonth: runs[0].start, toMonth: runs[0].end };
}

// The first and last date of a month scope, for the Months -> Specific dates
// conversion. All-year seeds the current month (the same "start somewhere"
// rule as unchecking All year); a non-contiguous or unusable scope has no
// single date range and returns null, which disables the mode.
export function periodDateSeed(period, now = new Date()) {
  const bounds = periodDateBounds(period);
  if (bounds.from != null || bounds.to != null) return bounds;
  if (!period) return null;
  if (period.kind === 'all') {
    const month = now.getMonth() + 1;
    return {
      from: formatMonthDay(month, 1),
      to: formatMonthDay(month, lastDayOfMonth(month)),
    };
  }
  if (period.kind !== 'months') return null;
  const scope = monthScopeBounds(period.months);
  if (!scope || scope.all) return null;
  return {
    from: formatMonthDay(scope.fromMonth, 1),
    to: formatMonthDay(scope.toMonth, lastDayOfMonth(scope.toMonth)),
  };
}

// A short hint for a range whose end precedes its start: it wraps the annual
// calendar (the same-month reverse case is the surprising one).
export function dateRangeHint(from, to) {
  const start = parseMonthDay(from);
  const end = parseMonthDay(to);
  if (!start || !end) return '';
  const startKey = start.month * 100 + start.day;
  const endKey = end.month * 100 + end.day;
  return startKey > endKey ? 'This range wraps the year.' : '';
}

// A base the editor can present as one price: the shape plus valid equal times.
// A malformed all-day row stays in the window list where it can be repaired.
function isUiBaseRow(row) {
  return isBaseWindow(row) && isAllDayWindow(row);
}

// The flat rate reference a season's overrides are compared with. A base-less
// season has no reference, so its windows stay simply "Window".
export function periodBaseRate(period) {
  const row = period && period.base && period.base.row;
  const rate = parseRateValue(row && row.rate);
  return rateIsUsable(rate) ? rate : null;
}

// Two modes only: no rows is One rate; any rows is Seasons & time-of-use. The
// stored `rate` remains in both, but is ignored for pricing once rows exist.
export function rateEditorMode(value) {
  const rates = Array.isArray(value)
    ? value
    : Array.isArray(value && value.rates)
      ? value.rates
      : [];
  return rates.length > 0 ? 'seasons' : 'flat';
}

// A fresh base row: all-day, every-day, with the scope's month/date hint. Used
// for a new season, a gap fill (empty rate) and the flat -> Seasons seed.
export function baseRateRow(id, rate, months = null, dates = null) {
  const usable = rateIsUsable(rate);
  return {
    id,
    rate: usable ? String(parseRateValue(rate)) : '',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '00:00',
    months: Array.isArray(months) ? [...months] : months,
    from: dates && dates.from != null ? dates.from : null,
    to: dates && dates.to != null ? dates.to : null,
  };
}

// Flat -> Seasons: a date-bounded season covering the current month at the
// current flat rate. It is deliberately not an All-year base: a base covering
// every date leaves nowhere non-overlapping to add the next season, which
// dead-ends "Add a season" on the first thing a new Seasons owner sees. The rest
// of the year stays an uncovered gap the owner can fill with a season (or with
// Fill gaps), and the plan says so on screen.
export function flatToScheduleRow(id, rate, now = new Date()) {
  const seed = periodDateSeed({ kind: 'all' }, now);
  return baseRateRow(id, rate, monthsCovering(seed.from, seed.to), seed);
}

// Seasons -> One rate: reuse the single All-year base's price when the plan is
// exactly that, otherwise keep the stored flat rate. The schedule's other rows
// are intentionally dropped only after the confirmation.
export function scheduleToFlatRate(rows, storedRate) {
  const list = Array.isArray(rows) ? rows.map(normalizeWindow) : [];
  if (list.length !== 1) return storedRate;
  const only = list[0];
  const scope = seasonScope(only);
  if (isBaseWindow(only) && scope.kind === 'all' && rateIsUsable(only.rate)) {
    return parseRateValue(only.rate);
  }
  return storedRate;
}

// The date gaps with no season at all, as rows a Fill gaps action can create.
// A partial gap is a date season; a whole-year gap is the canonical All-year
// base. The price stays empty so nothing is silently repriced.
export function uncoveredGapScopes(rows) {
  return mergeDateRanges(uncoveredDateRanges(rows)).map(([start, end]) => {
    if (start === 0 && end === ANNUAL_DAYS - 1) {
      return { months: null, from: null, to: null };
    }
    const from = monthDayText(annualMonthDay(start));
    const to = monthDayText(annualMonthDay(end));
    return { months: monthsCovering(from, to), from, to };
  });
}

// Whether adding a base to this season would collide with a base that already
// covers part of its dates. A base in another season can price this season's
// uncovered hours, but two bases on the same date are invalid. The period's own
// rows are excluded: a row that has just become this season's base is the base
// the block is showing, not another season's.
export function periodHasBaseOverlap(period, rows) {
  const first = period && period.rows && period.rows[0] && period.rows[0].row;
  if (!first) return false;
  const dates = seasonDateSet(rateScope(first));
  if (dates.length === 0) return false;
  const own = new Set(
    ((period && period.rows) || []).map((entry) => entry.row && entry.row.id).filter(Boolean),
  );
  return (Array.isArray(rows) ? rows : []).some((row) => {
    if (!row || own.has(row.id)) return false;
    if (!isBaseWindow(row)) return false;
    return intersectDateSets(dates, seasonDateSet(rateScope(row)));
  });
}

// Whether a non-empty plan has any instant with no price. The engine prices an
// instant from the union of the rows that match it: a row's season decides the
// date, and its weekday segment decides the minutes — a window that wraps
// midnight also prices the next day's early hours from the day it started. A
// plan is therefore fully priced exactly when, for every date and weekday, the
// matching segments cover the whole day. Counting base rows alone declared a
// plan whose hours are all covered by overrides "unpriced"; a window-only
// stretch of dates still is unpriced for the hours it does not cover. These are
// warnings, not validation blockers.
const MINUTES_PER_DAY = 1440;
// A leap reference year, so slot 59 is a real 29 February and every slot has a
// well-defined weekday; only the month and day are read.
const COVERAGE_YEAR = 2024;

function slotDate(slot, dayOffset = 0) {
  const { month, day } = annualMonthDay(slot);
  return new Date(COVERAGE_YEAR, month - 1, day + dayOffset, 12, 0, 0, 0);
}

// Whether the rows in `main` (segments on the instant's own day) and `tail`
// (early hours of a window that started the previous day) cover one weekday.
function dayCovered(segments, main, tail, weekday) {
  const spans = [];
  for (const index of main) {
    for (const segment of segments[index]) {
      if (segment.day !== weekday || segment.tail) continue;
      spans.push([segment.from, segment.to]);
    }
  }
  for (const index of tail) {
    for (const segment of segments[index]) {
      if (segment.day !== weekday || !segment.tail) continue;
      spans.push([segment.from, segment.to]);
    }
  }
  if (spans.length === 0) return false;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = 0;
  for (const [from, to] of spans) {
    if (from > covered) return false;
    if (to > covered) covered = to;
    if (covered >= MINUTES_PER_DAY) return true;
  }
  return covered >= MINUTES_PER_DAY;
}

export function planHasUnpriced(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return false;
  // A row whose own price is unusable is rejected by the validator and dropped
  // by the engine, so it cannot make an instant priced.
  const segments = list.map((row) => (rateIsUsable(row && row.rate) ? windowSegments(row) : []));
  if (segments.every((entry) => entry.length === 0)) return true;
  const scopes = list.map((row) => seasonScope(row));
  // Dates with the same matching rows share an answer; a month- or all-year
  // scope collapses the 366 slots to one or two probes.
  const seen = new Set();
  for (let slot = 0; slot < ANNUAL_DAYS; slot += 1) {
    const date = slotDate(slot);
    const previous = slotDate(slot, -1);
    const main = [];
    const tail = [];
    scopes.forEach((scope, index) => {
      if (scopeMatches(scope, date)) main.push(index);
      if (scopeMatches(scope, previous)) tail.push(index);
    });
    const key = `${main.join(',')}|${tail.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (!dayCovered(segments, main, tail, weekday)) return true;
    }
  }
  return false;
}

// Whether two scopes can match the same date. Duplicating a season into its
// complement is only a clean action while that complement is still free.
export function scopesOverlap(left, right) {
  return intersectDateSets(seasonDateSet(scopeOf(left)), seasonDateSet(scopeOf(right)));
}

// The largest uncovered annual range, for seeding a new season base. Ranges are
// leap-ring intervals; the result is an owner-facing MM-DD pair and says whether
// it is the whole year.
export function largestDateScope(ranges) {
  const merged = mergeDateRanges(ranges);
  if (merged.length === 0) return null;
  const length = ([start, end]) => (start <= end ? end - start + 1 : ANNUAL_DAYS - start + end + 1);
  let best = merged[0];
  for (const range of merged) if (length(range) > length(best)) best = range;
  const from = annualMonthDay(best[0]);
  const to = annualMonthDay(best[1]);
  return {
    from: formatMonthDay(from.month, from.day),
    to: formatMonthDay(to.month, to.day),
    fullYear: best[0] === 0 && best[1] === ANNUAL_DAYS - 1,
  };
}

// A stored or draft season bound in owner language: "Jun 15–Sep 15". A range
// whose end precedes its start is marked "(wraps)": printed bare it reads as an
// inverted or empty range, and only the hint underneath explained it. One day is
// marked "(one day)" so an annual single date is never mistaken for a weekday
// scope that moves with the calendar.
export function dateRangeText(from, to) {
  const start = parseMonthDay(from);
  const end = parseMonthDay(to);
  if (!start || !end) return '';
  const startText = `${MONTH_SHORT[start.month - 1]} ${start.day}`;
  if (start.month === end.month && start.day === end.day) return `${startText} (one day)`;
  const wraps = start.month * 100 + start.day > end.month * 100 + end.day;
  return `${startText}–${MONTH_SHORT[end.month - 1]} ${end.day}${wraps ? ' (wraps)' : ''}`;
}

// "MM-DD" from a leap-ring slot, for a computed complement.
function monthDayText({ month, day }) {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The number of days in an inclusive, possibly wrapping annual range.
function dateRangeLength(from, to) {
  const start = annualDayIndex(from.month, from.day);
  const end = annualDayIndex(to.month, to.day);
  return ((end - start + ANNUAL_DAYS) % ANNUAL_DAYS) + 1;
}

// The sample dates a period is inspected at. A range of a week or less is shown
// whole; a longer one is sampled at seven dates around its centre, which keeps
// the coverage table and the effective range anchored inside the season instead
// of at an arbitrary edge.
export function representativeDates(period) {
  if (!period || period.kind !== 'dates') return [];
  const start = parseMonthDay(period.from);
  const end = parseMonthDay(period.to);
  if (!start || !end) return [];
  const startIndex = annualDayIndex(start.month, start.day);
  const length = dateRangeLength(start, end);
  const first = length <= 7 ? 0 : Math.floor((length - 1) / 2) - 3;
  const count = length <= 7 ? length : 7;
  const dates = [];
  for (let offset = 0; offset < count; offset += 1) {
    dates.push(annualMonthDay((startIndex + first + offset) % ANNUAL_DAYS));
  }
  return dates;
}

// Merge touching/overlapping annual ranges and fold a range that touches both
// ends of the ring into one wrapping range, so a complement reads as a single
// "Sep 16–Jun 14" instead of two fragments.
export function mergeDateRanges(ranges) {
  const sorted = (Array.isArray(ranges) ? ranges : [])
    .filter((range) => Array.isArray(range) && range.length === 2)
    .map(([start, end]) => [start, end])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  if (merged.length > 1 && merged[0][0] === 0 && merged[merged.length - 1][1] === ANNUAL_DAYS - 1) {
    const first = merged.shift();
    const last = merged.pop();
    merged.unshift([last[0], first[1]]);
  }
  return merged;
}

// The days a set of annual ranges does not cover, as leap-ring intervals.
function complementDateRanges(ranges) {
  const covered = new Array(ANNUAL_DAYS).fill(false);
  for (const [start, end] of Array.isArray(ranges) ? ranges : []) {
    covered.fill(true, start, end + 1);
  }
  const gaps = [];
  let start = -1;
  for (let day = 0; day < ANNUAL_DAYS; day += 1) {
    if (!covered[day] && start < 0) start = day;
    else if (covered[day] && start >= 0) {
      gaps.push([start, day - 1]);
      start = -1;
    }
  }
  if (start >= 0) gaps.push([start, ANNUAL_DAYS - 1]);
  return gaps;
}

function isMonthStart(index) {
  return annualMonthDay(index).day === 1;
}

function isMonthEnd(index) {
  return index === ANNUAL_DAYS - 1 || isMonthStart(index + 1);
}

// Owner language for a set of annual ranges. Whole months collapse to
// "Mar–Oct", partial months stay "Apr 16–Jun 14", and a range that wraps the
// year reads as one run marked "(wraps)" — a bare "Sep 16–Jun 14" looks
// inverted. An empty set is an empty line.
export function dateSetText(ranges) {
  const merged = mergeDateRanges(ranges);
  if (merged.length === 0) return '';
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === ANNUAL_DAYS - 1) {
    return 'All year';
  }
  return merged
    .map(([start, end]) => {
      const a = annualMonthDay(start);
      const b = annualMonthDay(end);
      if (isMonthStart(start) && isMonthEnd(end)) {
        return a.month === b.month
          ? MONTH_SHORT[a.month - 1]
          : `${MONTH_SHORT[a.month - 1]}–${MONTH_SHORT[b.month - 1]}`;
      }
      const startText = `${MONTH_SHORT[a.month - 1]} ${a.day}`;
      if (a.month === b.month && a.day === b.day) return startText;
      return `${startText}–${MONTH_SHORT[b.month - 1]} ${b.day}${start > end ? ' (wraps)' : ''}`;
    })
    .join(', ');
}

// The days no stored season covers, as leap-ring intervals. "No window" means
// days with no season, not hours: hourly gaps are shown by the tables and the
// checker.
export function uncoveredDateRanges(rows) {
  const covered = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    covered.push(...seasonDateSet(rateScope(row)));
  }
  return complementDateRanges(covered);
}

// The complement a duplicate should use: the months a month scope does not
// cover, or the single wrapping date range a date scope leaves. An all-year or
// unusable scope has no complement, so there is nothing to duplicate into.
export function complementScope(value) {
  const scope = scopeOf(value);
  if (scope.kind === 'all' || scope.kind === 'invalid') return null;
  if (scope.kind === 'months') {
    const months = complementMonths(scope.months);
    return months.length > 0 ? { kind: 'months', months } : null;
  }
  const gaps = mergeDateRanges(complementDateRanges(seasonDateSet(scope)));
  if (gaps.length !== 1) return null;
  const from = monthDayText(annualMonthDay(gaps[0][0]));
  const to = monthDayText(annualMonthDay(gaps[0][1]));
  return { kind: 'dates', from, to, months: monthsCovering(from, to) };
}

function monthRuns(months) {
  const sorted = [...new Set(months)]
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
    .sort((a, b) => a - b);
  const runs = [];
  for (const month of sorted) {
    const last = runs[runs.length - 1];
    if (last && month === last.end + 1) last.end = month;
    else runs.push({ start: month, end: month });
  }
  // December → January is one run, not two: November → February must read as
  // the owner chose it, not as "Jan–Feb, Nov–Dec".
  if (runs.length > 1 && runs[0].start === 1 && runs[runs.length - 1].end === 12) {
    const first = runs.shift();
    const last = runs.pop();
    runs.unshift({ start: last.start, end: first.end });
  }
  return runs;
}

// The month scope in owner language: "All year", "Nov–Feb", "Jan, Jun".
export function rateMonthsText(months, kind) {
  if (kind === 'invalid' || (months != null && !Array.isArray(months))) return 'No months';
  if (months == null) return 'All year';
  const runs = monthRuns(months);
  if (runs.length === 0) return 'No months';
  if (runs.length === 1 && runs[0].start === 1 && runs[0].end === 12) return 'All year';
  return runs
    .map((run) =>
      run.start === run.end
        ? MONTH_SHORT[run.start - 1]
        : `${MONTH_SHORT[run.start - 1]}–${MONTH_SHORT[run.end - 1]}`,
    )
    .join(', ');
}

// A period title is derived, never stored. The two common seasonal shapes get
// a familiar word; any other set is "Custom months" with its exact months in
// the band, so a custom scope is never mislabelled as a season it does not
// match.
export function ratePeriodTitle(months, kind) {
  if (kind === 'invalid') return 'Needs attention';
  if (kind === 'all' || months == null) return 'All year';
  if (sameMonthSet(months, [11, 12, 1, 2])) return 'Winter';
  if (sameMonthSet(months, [3, 4, 5, 6, 7, 8, 9, 10])) return 'Summer';
  // Any other set is shown by its months in the header; the title stays a
  // stable kind so a one-month period does not pretend to be a named season.
  return 'Custom months';
}

function rateRangeFor(rows) {
  const rates = rows.map((row) => parseRateValue(row && row.rate)).filter(rateIsUsable);
  if (rates.length === 0) return null;
  return { min: Math.min(...rates), max: Math.max(...rates) };
}

// The price range a plan summary advertises. Invalid rates are not allowed to
// widen it; the row's own error says what is wrong.
export function ratePlanRange(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const range = rateRangeFor(list);
  if (!range) return null;
  // Uncovered dates and base-less hours price at 0, so an advertised minimum
  // above 0 would hide the fact that some instants are free/stale rather than
  // priced by the plan.
  return planHasUnpriced(list) ? { ...range, min: 0 } : range;
}

function periodOrder(period) {
  if (period.kind === 'invalid') return -1;
  if (period.kind === 'all') return 0;
  if (period.kind === 'dates') {
    const start = parseMonthDay(period.from);
    return start ? start.month * 100 + start.day : 1;
  }
  return Math.min(...period.months);
}

// Group the flat draft into the periods the owner sees. Grouping is by stored
// season scope only: it is stable while prices, days and times are edited, and
// each row belongs to exactly one period, so a season edit can never move a row
// the owner did not touch. Date rows group by their dates, not by the stale
// `months` hint. Rows are kept in their original positions (the stored order is
// the last-match-wins tie-break), with `index` pointing back into the draft
// array for editing.
export function ratePeriods(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  list.forEach((row, index) => {
    const scope = rateScope(row);
    const key =
      scope.kind === 'invalid'
        ? 'invalid'
        : scope.kind === 'all'
          ? 'all'
          : scope.kind === 'dates'
            ? `dates:${scope.from}-${scope.to}`
            : `months:${scope.months.join(',')}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: scope.kind,
        months: scope.kind === 'months' || scope.kind === 'dates' ? scope.months : null,
        from: scope.kind === 'dates' ? scope.from : null,
        to: scope.kind === 'dates' ? scope.to : null,
        rows: [],
      });
    }
    groups.get(key).rows.push({ row, index });
  });
  const periods = [...groups.values()].map((period) => {
    const dateText = period.kind === 'dates' ? dateRangeText(period.from, period.to) : '';
    const baseEntries = period.rows.filter((entry) => isUiBaseRow(entry.row));
    const base = baseEntries[0] || null;
    const overrides = period.rows.filter((entry) => !isUiBaseRow(entry.row));
    // Every row except the one shown in the Base rate block: ordinary overrides
    // plus any extra malformed/duplicate base rows that still need a control.
    const windows = period.rows.filter((entry) => !base || entry.index !== base.index);
    const mode =
      baseEntries.length === 0 ? 'windows' : period.rows.length === 1 ? 'base' : 'base+windows';
    return {
      ...period,
      // `all` months are represented as null everywhere else in the form.
      months: period.kind === 'all' ? null : period.months,
      dateText,
      // The band reads as dates for a date period and as months otherwise; the
      // old month-only view renders this same field.
      monthText: period.kind === 'dates' ? dateText : rateMonthsText(period.months, period.kind),
      // The title names the scope only, so the same shape always reads the same
      // way: one base and a base-plus-windows all-year season are both "All
      // year", and every date season is a "Season" whose band carries its
      // dates. Whether the season has a base is what the Base rate block and
      // the meta ("1 rate" vs "1 window") say.
      title:
        period.kind === 'invalid'
          ? 'Needs attention'
          : period.kind === 'all'
            ? 'All year'
            : period.kind === 'dates'
              ? 'Season'
              : ratePeriodTitle(period.months, period.kind),
      mode,
      base,
      overrides,
      windows,
    };
  });

  periods.sort(
    (a, b) =>
      periodOrder(a) - periodOrder(b) ||
      (b.months ? b.months.length : 12) - (a.months ? a.months.length : 12) ||
      a.key.localeCompare(b.key),
  );
  return periods;
}

// A period is a layer, not a slice of a partition: an every-month night and a
// Nov–Feb peak can both apply in January. These helpers make that layering
// explicit without changing the stored rows.

// The month used for a period's representative week. `null` months mean every
// month, so January is the stable example; otherwise the first (sorted) month
// of the scope is used.
export function representativeMonth(period) {
  const months = period && Array.isArray(period.months) ? period.months : [];
  return months.length > 0 ? months[0] : 1;
}

function periodAppliesInMonth(period, month) {
  if (!period) return false;
  if (period.kind === 'all') return true;
  if (period.kind !== 'months') return false;
  return Array.isArray(period.months) && period.months.includes(month);
}

function sampleDate(month, day, year) {
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  // A sample year that is not a leap year has no 29 February; anchor it on the
  // leap day rather than silently sliding into March.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    return new Date(2024, month - 1, day, 12, 0, 0, 0);
  }
  return date;
}

// The one leap-year rule in the app. The coverage ring uses it to keep 29
// February a real slot; the season date pickers use it to render a stored
// 29 February in a year that has one.
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Whether a period's own season covers one date. Months still answer by month;
// a date period answers exactly, so a sibling season is named only where it
// actually applies.
function periodAppliesOn(period, date) {
  if (!period) return false;
  return scopeMatches(scopeOf(period), date);
}

// The effective price range a period header should advertise for its
// representative sample (a month, or the dates of a date season): every base and
// daily window that can apply there (own, inherited and all-year). An uncovered
// hour is 0.00, never the stored flat rate; this answers "what could this season
// cost", while the row count stays the period's own.
export function periodEffectiveRange(rows, fallbackRate, period, year = new Date().getFullYear()) {
  const dated = Boolean(period && period.kind === 'dates');
  const dates = dated ? representativeDates(period) : [];
  const month = dated ? (dates[0] ? dates[0].month : 1) : representativeMonth(period);
  // Resolve the representative sample from the whole plan, so a sibling base or
  // window that also prices these dates is included. Uncovered hours contribute
  // 0.00 instead of a stored fallback.
  const week = dated
    ? rateWeekForDates(rows, fallbackRate, dates, year)
    : rateWeek(rows, fallbackRate, month, year);
  const values = [];
  for (const entry of Array.isArray(week) ? week : []) {
    if (!entry) continue;
    for (const segment of entry.segments) {
      const price = parseRateValue(segment.rate);
      if (Number.isFinite(price) && price >= RATE_MIN && price <= RATE_MAX) values.push(price);
    }
  }
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values), month };
}

// A one-line explanation of a period that also prices some of this month.
export function siblingNote(sibling) {
  if (!sibling) return '';
  if (sibling.kind === 'all') return 'All year windows also apply here.';
  // A date season is always titled "Season"; its dates are what tell two of
  // them apart.
  if (sibling.kind === 'dates') return `Season ${sibling.monthText} also applies here.`;
  if (sibling.title === 'Custom months') return `${sibling.monthText} windows also apply here.`;
  return `${sibling.title} also applies in ${sibling.monthText}.`;
}

// Change one period's months, in one edit, for every row it owns. Other rows are
// returned untouched (same array values, including order) so a legacy
// non-contiguous scope elsewhere is never rewritten as a side effect. A month
// edit is a month-mode edit, so it clears any day-precision bounds: leaving them
// would silently outrank the months just chosen.
export function applyPeriodMonths(rows, indices, months) {
  const list = Array.isArray(rows) ? rows : [];
  const targets = new Set(Array.isArray(indices) ? indices : [...(indices || [])]);
  const next =
    months == null
      ? null
      : [...new Set(months)]
          .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
          .sort((a, b) => a - b);
  return list.map((row, index) =>
    targets.has(index) ? { ...row, months: next ? [...next] : null, from: null, to: null } : row,
  );
}

// Change one period's day-precision bounds, in one edit, for every row it owns.
// Values are stored as typed so an invalid date stays visible and validation
// blocks the save; `months` is kept as the derived compatibility hint when both
// bounds are real. Other rows are returned untouched.
export function applyPeriodDates(rows, indices, from, to) {
  const list = Array.isArray(rows) ? rows : [];
  const targets = new Set(Array.isArray(indices) ? indices : [...(indices || [])]);
  const months = monthsCovering(from, to);
  return list.map((row, index) =>
    targets.has(index)
      ? {
          ...row,
          from: from == null ? null : from,
          to: to == null ? null : to,
          ...(months.length > 0 ? { months } : {}),
        }
      : row,
  );
}

// `applyPeriodDates` as a draft edit. The editor's base and window controls hold
// the row objects themselves, and a date edit that keeps the period shape
// repaints the cards in place instead of rebuilding them. Writing the new bounds
// onto those same objects keeps every control bound to a row the draft still
// contains; a copy would orphan them, so the next typed rate would land on a row
// validation never sees and the field would keep reporting the old, empty value.
// The list is returned for convenience.
export function applyPeriodDatesInPlace(rows, indices, from, to) {
  const list = Array.isArray(rows) ? rows : [];
  const updated = applyPeriodDates(list, indices, from, to);
  const targets = new Set(Array.isArray(indices) ? indices : [...(indices || [])]);
  list.forEach((row, index) => {
    if (targets.has(index) && row && typeof row === 'object') Object.assign(row, updated[index]);
  });
  return list;
}

// Every month the period's rows do not already cover. Duplicating a winter
// period into "the rest of the year" is the one-click variant the owner needs;
// an all-year period has no complement, so there is nothing to duplicate into.
export function complementMonths(months) {
  const scope = months == null ? { kind: 'all' } : rateMonthScope({ months });
  if (scope.kind === 'all' || scope.months.length === 0) return [];
  const set = new Set(scope.months);
  return ALL_MONTHS.filter((month) => !set.has(month));
}

// One month chip's activation is the inverse of the pressed state it announces:
// on an all-year scope every chip is pressed, so activating one removes that
// month and leaves the other eleven. The last month cannot be removed (an empty
// scope is not a useful edit), and a malformed scope starts from the click.
export function toggledMonthScope(period, month) {
  if (!period || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const current =
    period.kind === 'all' ? ALL_MONTHS : Array.isArray(period.months) ? period.months : [];
  const set = new Set(current);
  if (set.size === 0) return [month];
  if (set.has(month)) {
    if (set.size === 1) return null;
    set.delete(month);
  } else {
    set.add(month);
  }
  return [...set].sort((a, b) => a - b);
}

// Clone one period's rows into a new scope, with fresh ids. `months` is the
// month scope (or the derived hint for a date scope); `dates` optionally carries
// `{from, to}` for a day-precision copy. Every array is copied so editing the
// copy cannot mutate the original, and a month copy never inherits stale dates
// that would outrank it.
export function copyPeriodRows(rows, indices, months, makeId, dates = null) {
  const list = Array.isArray(rows) ? rows : [];
  const targets = Array.isArray(indices) ? indices : [...(indices || [])];
  const next =
    months == null
      ? null
      : [...new Set(months)]
          .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
          .sort((a, b) => a - b);
  const copies = targets.map((index) => ({
    ...list[index],
    id: makeId(),
    days: Array.isArray(list[index].days) ? [...list[index].days] : [],
    months: next ? [...next] : null,
    from: dates && dates.from != null ? dates.from : null,
    to: dates && dates.to != null ? dates.to : null,
  }));
  return [...list, ...copies];
}

// Duplicating a period appends one row per window it owns, so the same
// 24-window cap that guards Add season/Add window has to guard the copy: the UI
// must never build an unsaveable plan out of its own action.
export function canDuplicatePeriod(rowCount, periodRowCount) {
  return (
    Number.isInteger(periodRowCount) &&
    periodRowCount > 0 &&
    rowCount + periodRowCount <= MAX_RATE_WINDOWS
  );
}

// The scope a row added inside a period must inherit: its months, plus the raw
// date bounds when the period is day-scoped. Passing only the months would put
// the new row in a second, month-wide season and silently widen a date season to
// the whole months it touches.
export function periodRowScope(period) {
  if (!period) return { months: null, dates: null };
  const months = period.kind === 'all' ? null : (period.months ?? null);
  if (!periodHasDates(period)) return { months, dates: null };
  return { months, dates: periodDateBounds(period) };
}

// The preset Add window should use: the one the season does not already contain,
// so the editor's own action does not immediately build an overlapping pair the
// validator rejects. A first window is the overnight preset; once a season
// already has the weekday-evening shape, the next row is the overnight one.
export function nextWindowPreset(period) {
  const entries = (period && period.rows) || [];
  if (entries.length === 0) return 'overnight';
  const hasPeak = entries.some((entry) => {
    const row = entry && entry.row;
    return Boolean(
      row && dayPresetFor(row.days) === 'weekdays' && row.start === '16:00' && row.end === '19:00',
    );
  });
  return hasPeak ? 'overnight' : 'peak';
}

// ---------- day presets ----------

// Presets are shortcuts over the same `days` array the chips edit, not a second
// model. `custom` keeps the current days and only reveals the chips.
export const DAY_PRESETS = [
  { id: 'every', label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { id: 'weekdays', label: 'Weekdays', days: [0, 1, 2, 3, 4] },
  { id: 'weekends', label: 'Weekends', days: [5, 6] },
  { id: 'custom', label: 'Custom', days: null },
];

export function daysForPreset(preset) {
  const found = DAY_PRESETS.find((entry) => entry.id === preset);
  return found && found.days ? [...found.days] : null;
}

export function dayPresetFor(days) {
  const list = Array.isArray(days) ? days : [];
  const valid = list.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (valid.length !== list.length || new Set(valid).size !== list.length) return 'custom';
  const set = new Set(valid);
  if (set.size === 7) return 'every';
  if (set.size === 5 && [0, 1, 2, 3, 4].every((day) => set.has(day))) return 'weekdays';
  if (set.size === 2 && set.has(5) && set.has(6)) return 'weekends';
  return 'custom';
}

// ---------- price bands ----------

// Peak / Off-peak / Shoulder are derived from relative price for display only.
// Two window prices split into the two ends; three or more put the middle in
// Shoulder. A single price is described against its season's base rate, which is
// the comparison the owner actually makes. `Same price` is honest rather than
// calling an equal price a bargain.
export function rateTierFor(rate, windowRates, fallbackRate) {
  const price = parseRateValue(rate);
  if (!Number.isFinite(price)) return '';
  const distinct = [
    ...new Set(
      (Array.isArray(windowRates) ? windowRates : [])
        .map((value) => parseRateValue(value))
        .filter((value) => Number.isFinite(value) && value >= RATE_MIN && value <= RATE_MAX),
    ),
  ].sort((a, b) => a - b);
  const index = distinct.indexOf(price);
  if (index === -1) return '';
  if (distinct.length === 1) {
    const base = parseRateValue(fallbackRate);
    if (!Number.isFinite(base) || price < base) return 'Off-peak';
    if (price > base) return 'Peak';
    return 'Same price';
  }
  if (index === 0) return 'Off-peak';
  if (index === distinct.length - 1) return 'Peak';
  return 'Shoulder';
}

// ---------- labels and validation ----------

// A short line under a row's title, so a stack of tall rows stays scannable.
// Months are the period's concern and are shown once in the period header;
// invalid values stay visible in the controls and their error line.
export function rateWindowSummary(row) {
  const source = row || {};
  const days = Array.isArray(source.days) ? [...new Set(source.days)].sort((a, b) => a - b) : [];
  let dayText;
  if (days.length === 0) {
    dayText = 'No days';
  } else if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    // Checked before the shorthand labels: seven values that include one outside
    // 0–6 are not every day, and the summary must not claim coverage the row
    // does not have.
    dayText = 'Invalid days';
  } else if (days.length === 7) {
    dayText = 'Every day';
  } else if (days.length === 5 && days.every((day, index) => day === index)) {
    dayText = 'Weekdays';
  } else if (days.length === 2 && days[0] === 5 && days[1] === 6) {
    dayText = 'Weekends';
  } else {
    dayText = days.map((day) => DAY_NAMES[day]).join(', ');
  }

  const start = typeof source.start === 'string' ? source.start : '';
  const end = typeof source.end === 'string' ? source.end : '';
  const timed =
    /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start) && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(end);
  let timeText;
  if (!start || !end) timeText = 'Times not set';
  else if (!timed) timeText = `${start}–${end}`;
  else if (start === end) timeText = 'All day';
  else if (end < start) timeText = `${start}–${end} next day`;
  else timeText = `${start}–${end}`;

  return `${dayText} · ${timeText}`;
}

// The season in owner language, dates first: a date row reads as its dates and
// a month row as its months.
export function rateScopeText(row) {
  const scope = rateScope(row);
  return scope.kind === 'dates'
    ? dateRangeText(scope.from, scope.to)
    : rateMonthsText(scope.months, scope.kind);
}

// A full name for an error that has to distinguish two rows ("Off-peak Weekdays
// · 16:00–19:00 · Nov–Feb"). The season is included because that is what
// decides whether two rows can actually collide; a date season reads as its
// dates. A base is named Base rather than a relative price tier, the same name
// its card and table row carry.
export function windowLabel(row, windowRates, fallbackRate, { months = true } = {}) {
  const tier = isBaseWindow(row) ? 'Base' : rateTierFor(row && row.rate, windowRates, fallbackRate);
  const price = parseRateValue(row && row.rate);
  const head = [tier, Number.isFinite(price) ? String(price) : ''].filter(Boolean).join(' ');
  const summary = rateWindowSummary(row);
  const scopeText = months ? ` · ${rateScopeText(row)}` : '';
  return `${head ? `${head} · ` : ''}${summary}${scopeText}`;
}

// The rate table's validation. The old editor could only express one month
// range, so a valid non-contiguous list was flagged; the month chips can now
// show any set, so the shared window rules are the whole rulebook again.
export const RATE_CAP_MESSAGE = `A rate schedule can hold at most ${MAX_RATE_WINDOWS} windows.`;
// The remedy belongs to the cap alone: an over-cap plan is fixed by removing
// windows, and telling the owner to separate a pair of colliding windows would
// leave the count over the limit.
export const RATE_CAP_REMEDY = `Remove a window to get back to ${MAX_RATE_WINDOWS}.`;

export function validateRateEditorRows(rows, fallbackRate) {
  const base = validateRateWindows(rows);
  const list = Array.isArray(rows) ? rows : [];
  const rowErrors = base.errors.rows.map((errors) => ({ ...errors }));
  const overlaps = overlappingWindowPairs(list);
  const bases = list.map((row) => isBaseWindow(row));
  const capped = list.length > MAX_RATE_WINDOWS;
  const general = [];
  // A plan over the cap gets one cap-only message and the cap remedy. The
  // overlap clauses are withheld here because their remedy ("change one of
  // them") would not bring the plan back under the cap; the rows still carry
  // their own overlap notes, so nothing is hidden.
  if (capped) general.push(RATE_CAP_MESSAGE, RATE_CAP_REMEDY);
  else if (overlaps.length > 0) general.push(rateOverlapMessage(overlaps, list, fallbackRate));
  const valid = rowErrors.every((errors) => Object.keys(errors).length === 0);
  return {
    valid: valid && general.length === 0,
    general,
    rows: rowErrors,
    overlaps,
    bases,
    capped,
  };
}

// One document-level sentence naming both rows in every collision. Months are
// omitted when both rows share them (the period header already says so), and
// genuinely identical rows collapse to a single clause instead of repeating the
// same long name with an ordinal.
export function rateOverlapMessage(pairs, rows, fallbackRate) {
  const list = Array.isArray(rows) ? rows : [];
  const rates = list.map((row) => row && row.rate);
  const scopeText = list.map((row) => rateScopeText(row));
  const clauses = [];
  for (const [a, b] of Array.isArray(pairs) ? pairs : []) {
    const sameScope = scopeText[a] === scopeText[b];
    const label = (index) =>
      list[index]
        ? windowLabel(list[index], rates, fallbackRate, { months: !sameScope })
        : `Window ${index + 1}`;
    const left = label(a);
    const right = label(b);
    if (isBaseWindow(list[a]) && isBaseWindow(list[b])) {
      clauses.push(
        `“${left}” and “${right}” are both base rates and cover some of the same dates. Keep one base per date`,
      );
    } else {
      clauses.push(
        left === right ? `Two windows are identical: “${left}”` : `“${left}” overlaps “${right}”`,
      );
    }
  }
  const baseOnly = (Array.isArray(pairs) ? pairs : []).every(
    ([a, b]) => isBaseWindow(list[a]) && isBaseWindow(list[b]),
  );
  return baseOnly
    ? `${clauses.join('; ')}.`
    : `${clauses.join('; ')}. Change one of them so no moment has two rates.`;
}

// How many rows the edit has to fix. Counts affected rows (not collision
// pairs), so the plan summary, a period badge and the save row all agree.
// A plan over the cap has no row to blame: the cap counts once, and only when
// no row is already flagged. Counting it alongside flagged rows would put a
// number on the plan row that no period badge carries, and those same row
// edits are what brings the plan back under the cap.
export function validationProblemCount(validation, rowCount = 0) {
  if (!validation) return 0;
  const affected = new Set();
  (validation.rows || []).forEach((errors, index) => {
    if (errors && Object.keys(errors).length > 0) affected.add(index);
  });
  for (const [a, b] of validation.overlaps || []) {
    affected.add(a);
    affected.add(b);
  }
  const capped = rowCount > MAX_RATE_WINDOWS;
  return affected.size + (capped && affected.size === 0 ? 1 : 0);
}

// The plan row and the save row share this text. `cap` labels the one count
// that has no period badge of its own, so the numbers on screen never disagree
// about what is left to fix.
export function planProblemText({ problems = 0, capped = false } = {}) {
  if (problems <= 0) return '';
  return capped ? `${problems} to fix · cap` : `${problems} to fix`;
}

// Save's visible and accessible state. A plan with blockers keeps the button
// submit-capable: it is the form's only submit button, so disabling it would
// swallow Enter and with it the jump to the first problem. `blocked` styles it
// and marks it aria-disabled while the submit path stays live.
export function saveButtonState({ canSave = false, saving = false, problems = 0 } = {}) {
  const blocked = problems > 0;
  const label = (saving && 'Saving…') || (blocked && `Fix ${problems} to save`) || 'Save settings';
  return {
    disabled: !canSave,
    blocked,
    label,
    describedBy: blocked ? 'save-blockers' : '',
  };
}

// What a blocked submit leaves in the save row. Short on purpose: the row shares
// its width with the count chip and Save, so a full sentence stacks into a list
// of fragments at 320 px.
export const BLOCKED_SAVE_MESSAGE = 'Fix the highlighted fields.';

// The first problem a blocked submit must reveal. Field errors come first (they
// sit above the plan and carry their own message), then the first row with a
// field error, then the first row an overlap names. `doc` is a blocker with no
// row of its own — the window cap — and lands on the first row so the user is
// in the table that fixes it. `save` means nothing blocks the write.
export function submitFocusTarget({ errors = {}, rateValidation } = {}) {
  if (errors.rate) return { kind: 'field', field: 'rate' };
  if (errors.currency) return { kind: 'field', field: 'currency' };
  if (errors.chargerHost) return { kind: 'field', field: 'chargerHost' };
  const rows = (rateValidation && rateValidation.rows) || [];
  const index = rows.findIndex((row) => row && Object.keys(row).length > 0);
  if (index >= 0) {
    const row = rows[index];
    const isBase = Boolean(rateValidation && rateValidation.bases && rateValidation.bases[index]);
    const focus =
      row.from || row.to
        ? 'dates'
        : row.months
          ? 'months'
          : row.rate
            ? isBase
              ? 'base-rate'
              : 'rate'
            : row.days
              ? 'days'
              : row.start
                ? 'start'
                : row.end
                  ? 'end'
                  : isBase
                    ? 'base-rate'
                    : 'rate';
    return { kind: 'row', index, focus };
  }
  const overlaps = (rateValidation && rateValidation.overlaps) || [];
  if (overlaps.length > 0) return { kind: 'row', index: overlaps[0][0], focus: 'rate' };
  if (rateValidation && rateValidation.valid === false) return { kind: 'doc' };
  return { kind: 'save' };
}

// The form's submit gate, extracted from the screen so the keyboard recovery
// path is testable without a DOM. A blocked plan never reaches `onCommit` — the
// screen's only route to the persistence layer — and the returned target is what
// it reveals and focuses.
export function submitSettingsPlan({ fields, onCommit = () => {} } = {}) {
  const result = validateSettings(fields);
  const rateValidation = validateRateEditorRows(fields.rates, fields.rate);
  const blocked = !result.valid || !rateValidation.valid;
  const target = blocked
    ? submitFocusTarget({ errors: result.errors, rateValidation })
    : { kind: 'save' };
  if (!blocked) onCommit(result.values);
  return {
    blocked,
    errors: result.errors,
    values: result.values,
    rateValidation,
    message: blocked ? BLOCKED_SAVE_MESSAGE : '',
    target,
  };
}

// A definitive checker answer is withheld while the plan has anything blocking:
// the invalid row would otherwise be dropped and a price claimed for a moment
// it may actually price. The remedy names the cause: an unpriced row
// needs a price, not its windows repaired.
export const CHECK_BLOCKED_MESSAGE = 'Fix the incomplete windows to check this moment.';
export const CHECK_RATE_MESSAGE = 'Add a rate to check this moment.';
export const CHECK_CONFLICT_MESSAGE = 'Fix the overlapping windows to check this moment.';
export const CHECK_CAP_MESSAGE = `Reduce the plan to ${MAX_RATE_WINDOWS} windows to check this moment.`;

export function previewBlocker(validation) {
  if (!validation || validation.valid !== false) return '';
  const incomplete = (validation.rows || []).filter(
    (errors) => errors && Object.keys(errors).length > 0,
  );
  if (incomplete.length > 0) {
    // A row whose only problem is its price has no incomplete window to fix:
    // telling the owner to repair a window that is fine sends them to the wrong
    // field.
    const unpricedOnly = incomplete.every((errors) =>
      Object.keys(errors).every((field) => field === 'rate'),
    );
    return unpricedOnly ? CHECK_RATE_MESSAGE : CHECK_BLOCKED_MESSAGE;
  }
  // A plan over the cap has no overlap to fix: naming the cap keeps the
  // checker from accusing windows that are fine.
  if (validation.capped) return CHECK_CAP_MESSAGE;
  return CHECK_CONFLICT_MESSAGE;
}

// A window whose stored start equals its end covers the whole day. The editor
// shows "All day" for it; the table still renders 00:00–24:00.
const ALL_DAY_TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isAllDayWindow(row) {
  return Boolean(
    row &&
    typeof row.start === 'string' &&
    ALL_DAY_TIME_RE.test(row.start) &&
    row.start === row.end,
  );
}

// Whether an all-day window's time fields are showing. "Set times" opens them,
// and they must stay open while focus moves from Start to End — a blur on Start
// fires before End takes focus, so a snapshot of `activeElement` at that moment
// would hide the row the owner is still using. `focusWithin` is the block's own
// focus state, kept current by focusout/relatedTarget.
export function timeFieldsVisible({ allDay, timesOpen, focusWithin }) {
  return !allDay || Boolean(timesOpen) || Boolean(focusWithin);
}

// ---------- coverage and preview ----------

export function minutesToClock(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export function dayTypeLabel(days) {
  const list = [...new Set(Array.isArray(days) ? days : [])]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  if (list.length === 7) return 'Every day';
  if (list.length === 5 && [0, 1, 2, 3, 4].every((day) => list.includes(day))) return 'Weekdays';
  if (list.length === 2 && list[0] === 5 && list[1] === 6) return 'Weekends';
  // A contiguous run of three or more is a range ("Tue–Sun"), which fits the
  // narrow strip label where a full day list would be clipped.
  if (list.length >= 3 && list.every((day, index) => index === 0 || day === list[index - 1] + 1)) {
    return `${DAY_NAMES[list[0]]}–${DAY_NAMES[list[list.length - 1]]}`;
  }
  return list.map((day) => DAY_NAMES[day]).join(', ');
}

// A typical week inside one month: seven complete day partitions, resolved with
// the same matching as `rateAt`. The week is anchored mid-month (8th–14th) so a
// month-boundary tail never makes one weekday look different from its
// neighbours; the exact-date checker below is where 1 Jan / 31 Oct edge cases
// are inspected.
export function rateWeek(rows, fallbackRate, month, year = new Date().getFullYear()) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return [];
  const base = parseRateValue(fallbackRate);
  const schedule = { rate: Number.isFinite(base) ? base : null, rates: rows };
  const week = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(year, month - 1, 8 + offset, 12, 0, 0, 0);
    const day = (date.getDay() + 6) % 7;
    week[day] = { day, segments: rateDayPartition(schedule, date) };
  }
  return week;
}

// The same sample for a date season: one entry per representative date, keyed by
// its weekday. A range of seven or fewer days (or a centred seven-day sample)
// covers every weekday, and a shorter one leaves the other weekdays absent —
// they genuinely are not part of the season. A sample that includes 29 February
// moves to a leap year as a whole, so its weekdays stay consecutive.
export function rateWeekForDates(rows, fallbackRate, dates, year = new Date().getFullYear()) {
  const base = parseRateValue(fallbackRate);
  const schedule = { rate: Number.isFinite(base) ? base : null, rates: rows };
  const list = Array.isArray(dates) ? dates : [];
  const needsLeap = list.some((entry) => entry && entry.month === 2 && entry.day === 29);
  const sampleYear = needsLeap && !isLeapYear(year) ? 2024 : year;
  const week = [];
  for (const entry of list) {
    if (!entry) continue;
    const date = sampleDate(entry.month, entry.day, sampleYear);
    const day = (date.getDay() + 6) % 7;
    week[day] = { day, segments: rateDayPartition(schedule, date) };
  }
  return week;
}

function segmentSignature(segment) {
  const window = segment.window;
  const source = window
    ? [window.id, window.start, window.end, window.rate].join('|')
    : segment.source || 'uncovered';
  return [segment.from, segment.to, segment.rate, segment.source || '', source].join(';');
}

// Weekdays with an identical complete day partition are one row group. The
// grouping is derived from what the plan actually prices, so a weekday-only
// peak and an everyday night become "Weekdays" and "Every day" without a second
// stored model.
export function dayTypesForWeek(week) {
  const types = [];
  for (const entry of Array.isArray(week) ? week : []) {
    if (!entry) continue;
    const signature = entry.segments.map(segmentSignature).join('/');
    const found = types.find((type) => type.signature === signature);
    if (found) found.days.push(entry.day);
    else types.push({ signature, days: [entry.day], segments: entry.segments });
  }
  return types
    .sort((a, b) => Math.min(...a.days) - Math.min(...b.days))
    .map((type) => ({
      days: type.days,
      label: dayTypeLabel(type.days),
      segments: type.segments,
    }));
}

// One period's own layer for a representative sample in its own scope. The table
// is deliberately not the union: it shows this period's rows, prices an
// uncovered hour at 0.00, and names the sibling periods that also apply in that
// sample. The checker is the place that resolves the union. For an all-year period the
// representative month is January; otherwise it is the first month of the
// scope; a date period is sampled at its own dates, so the caption can never
// disagree with the season.
export function periodCoverage(
  rows,
  fallbackRate,
  period,
  periods,
  year = new Date().getFullYear(),
) {
  const dated = Boolean(period && period.kind === 'dates');
  const dates = dated ? representativeDates(period) : [];
  const month = dated ? (dates[0] ? dates[0].month : 1) : representativeMonth(period);
  // The table is the effective sample, but every segment keeps its owner: own
  // rows are the period's rows, sibling rows are named in the band column
  // instead of being mislabelled as the base.
  const week = dated
    ? rateWeekForDates(rows, fallbackRate, dates, year)
    : rateWeek(rows, fallbackRate, month, year);
  const ownIds = new Set(
    (period && period.rows ? period.rows : [])
      .map((entry) => entry.row && entry.row.id)
      .filter(Boolean),
  );
  const samples = dated ? dates.map((entry) => sampleDate(entry.month, entry.day, year)) : [];
  const siblings = (Array.isArray(periods) ? periods : []).filter(
    (other) =>
      other &&
      other.key !== (period && period.key) &&
      (dated
        ? samples.some((date) => periodAppliesOn(other, date))
        : periodAppliesInMonth(other, month)),
  );
  // A base-only season is one price for every day and hour of the season: it is
  // shown as one Every day type and one 00:00–24:00 row, however short the
  // representative sample is.
  let types = dayTypesForWeek(week);
  if (period && period.mode === 'base' && types.length > 0) {
    types = [{ days: [0, 1, 2, 3, 4, 5, 6], label: 'Every day', segments: types[0].segments }];
  }
  // A one-date season is sampled on one weekday. Printing that weekday ("Mon")
  // asserts a weekday scope on a date that moves every year, so the sample is
  // named for what it is instead.
  const onlyDate = dated && dates.length === 1 ? dates[0] : null;
  if (onlyDate && types.length === 1) {
    types = [{ ...types[0], label: 'One day' }];
  }
  return {
    month,
    monthName: dated ? period.dateText : MONTH_NAMES[month - 1],
    // The table caption names the sample: a date season its dates, an all-year
    // season "All year" (the January the week is sampled in is not a scope), and
    // a month season its month. A month season that spans several months is
    // sampled in the first of them, so the caption marks that month as the
    // example instead of reading as the season's whole scope. One date drops its
    // "(one day)" marker here because the row group is already labelled "One
    // day".
    captionText: dated
      ? onlyDate
        ? `${MONTH_SHORT[onlyDate.month - 1]} ${onlyDate.day}`
        : period.dateText
      : period && period.kind === 'all'
        ? 'All year'
        : Array.isArray(period && period.months) && period.months.length > 1
          ? `${MONTH_NAMES[month - 1]} · example`
          : MONTH_NAMES[month - 1],
    dateText: dated ? period.dateText : '',
    dates,
    week: Array.isArray(week) ? week : [],
    types,
    siblings,
    ownIds,
  };
}

// The band name for a resolved segment. A base is named Base; an hour with no
// row is Uncovered (0.00), not a fallback. Overrides keep their relative tier
// only when their season has a base to compare against.
export function rateSegmentLabel(segment, windowRates, baseRate) {
  if (!segment || !segment.window) return 'Uncovered';
  if (segment.source === 'base' || isBaseWindow(segment.window)) return 'Base';
  if (!rateIsUsable(baseRate)) return 'Window';
  return rateTierFor(segment.rate, windowRates, baseRate) || 'Window';
}

// How a wrap reads in a partition: the tail says where it came from and the
// main part says where it goes, so two rows for one overnight window are not
// mistaken for two windows.
export function segmentNote(segment) {
  const window = segment && segment.window;
  if (!window) return '';
  if (typeof window.start !== 'string' || typeof window.end !== 'string') return '';
  // 00:00–24:00 already reads as the whole day; the note is for wraps only.
  if (window.start === window.end) return '';
  if (window.end > window.start) return '';
  if (segment.from === 0) return `from ${window.start} the day before`;
  return `continues to ${window.end} the next day`;
}

// The exact-date checker: the winning row for one local instant and why. A base
// prices the season's ordinary hours, an override wins over it, and both
// unmatched cases are 0: an uncovered date (no season) or an unpriced hour (a
// season with neither a base nor a window for that time).
export function previewRate(rows, fallbackRate, date) {
  const base = parseRateValue(fallbackRate);
  const list = Array.isArray(rows) ? rows : [];
  const entry = rateEntryAt(date, {
    rate: Number.isFinite(base) ? base : null,
    rates: rows,
  });
  if (!entry) return null;
  const periods = ratePeriods(list);
  const winningPeriod = entry.window
    ? periods.find((period) =>
        period.rows.some((row) => row.row && row.row.id === entry.window.id),
      ) || null
    : null;
  const baseRate = winningPeriod ? periodBaseRate(winningPeriod) : null;
  const referenceRates = winningPeriod
    ? winningPeriod.rows.map((row) => row.row && row.row.rate)
    : list.map((row) => row && row.rate);
  const scope = entry.window ? rateScope(entry.window) : null;
  const tier =
    entry.source === 'base'
      ? 'Base'
      : entry.source === 'window'
        ? baseRate != null
          ? rateTierFor(entry.window.rate, referenceRates, baseRate) || 'Window'
          : 'Window'
        : '';
  return {
    rate: entry.rate,
    window: entry.window,
    source: entry.source,
    uncoveredDate: Boolean(entry.uncoveredDate),
    unpricedHour: Boolean(entry.unpricedHour),
    tier,
    baseRate,
    summary: entry.window ? rateWindowSummary(entry.window) : '',
    monthsText: entry.window ? rateMonthsText(entry.window.months) : '',
    dateText:
      entry.window && scope && scope.kind === 'dates' ? dateRangeText(scope.from, scope.to) : '',
    scopeText: entry.window ? rateScopeText(entry.window) : '',
  };
}

// ---------- date and time fields ----------

// Local Date from the two native inputs, or null for an incomplete/invalid
// pair. Parsed by parts: `new Date('2026-10-20')` is UTC and can land on the
// previous local day.
export function parseLocalDateTime(dateText, timeText) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateText === 'string' ? dateText : '');
  const timeMatch = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(
    typeof timeText === 'string' ? timeText : '',
  );
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const date = new Date(year, month - 1, day, hours, minutes);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) {
    return null;
  }
  return date;
}

export function dateInputValue(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function timeInputValue(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// "Tue 15 Dec, 18:30" (with the year only when it is not the current one).
export function formatPreviewWhen(date, now = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  const day = DAY_NAMES[(date.getDay() + 6) % 7];
  const month = MONTH_SHORT[date.getMonth()];
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${day} ${date.getDate()} ${month}${year}, ${timeInputValue(date)}`;
}

// The exact Firestore payload for a validated settings save. `rates` is omitted
// when empty, so a flat configuration writes byte-for-byte the two fields it
// always has. `charger_host` is omitted the same way: absent means "use the
// bridge's bootstrap", so clearing the field removes the key. `show_temperature`
// is omitted when true — absent already means visible — so a visible toggle
// never adds a key, and only a stored `false` (which the form always carries)
// reaches the document. A month row keeps its stored key order; a date row
// appends `from`/`to` after `months`, whose value is the derived compatibility
// hint.
export function settingsPayload(values) {
  const source = values || {};
  const payload = { rate: source.rate, currency: source.currency };
  const rates = Array.isArray(source.rates) ? source.rates : [];
  if (rates.length > 0) {
    payload.rates = rates.map((row) => {
      const window = normalizeWindow(row);
      const scope = seasonScope(window);
      if (scope.kind === 'dates') {
        return {
          id: window.id,
          rate: window.rate,
          days: window.days,
          start: window.start,
          end: window.end,
          months: monthsCovering(scope.from, scope.to),
          from: scope.from,
          to: scope.to,
        };
      }
      return {
        id: window.id,
        rate: window.rate,
        days: window.days,
        start: window.start,
        end: window.end,
        months: window.months,
      };
    });
  }
  // Only a value the grammar accepts is ever written: the payload must not be
  // able to carry something `firestore.rules` would refuse.
  const host = validateChargerHost(source.chargerHost).value;
  if (host) payload.charger_host = host;
  if (source.showTemperature === false) payload.show_temperature = false;
  return payload;
}

// ---------- draft comparison ----------

function parseCurrencyValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The form compares parsed values, never raw strings: a rate typed as "0.250"
// and a currency typed as " USD " are the same settings as the canonical
// rendering, so they must not read as unsaved forever. Two non-numeric drafts
// only match each other when their text is identical. Window rows compare
// through rateWindowsKey so day/month order and numeric text do not matter. The
// charger address is compared trimmed (the only normalization it has), so
// " 192.168.1.50 " matches "192.168.1.50" but an invalid value never compares
// equal to a blank one. The temperature toggle compares by its visible/hidden
// meaning, so an absent field (the default) matches an explicit true.
export function sameSettingsInput(a, b) {
  const left = a || {};
  const right = b || {};
  const rateLeft = parseRateValue(left.rate);
  const rateRight = parseRateValue(right.rate);
  const ratesMatch =
    Number.isNaN(rateLeft) || Number.isNaN(rateRight)
      ? String(left.rate ?? '').trim() === String(right.rate ?? '').trim()
      : rateLeft === rateRight;
  return (
    ratesMatch &&
    parseCurrencyValue(left.currency) === parseCurrencyValue(right.currency) &&
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates) &&
    String(left.chargerHost ?? '').trim() === String(right.chargerHost ?? '').trim() &&
    (left.showTemperature !== false) === (right.showTemperature !== false)
  );
}

// Raw input fields against a stored settings document.
export function settingsDraftMatches(draft, settings) {
  return sameSettingsInput(draft, settingsFields(settings));
}

function settingsEqual(a, b) {
  const left = normalizeSettings(a);
  const right = normalizeSettings(b);
  if (!left || !right) return left === right;
  return (
    left.rate === right.rate &&
    left.currency === right.currency &&
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates) &&
    left.charger_host === right.charger_host &&
    left.show_temperature === right.show_temperature
  );
}

// ---------- save-state machine ----------

export const OFFLINE_MESSAGE = 'You’re offline — reconnect to save.';
export const WAITING_MESSAGE = 'Waiting for the server — this change may not be saved yet.';
// No settings document has been read yet, so the blank form is not a baseline:
// the whole-document write would replace the stored plan with nothing.
export const LOADING_MESSAGE = 'Loading your settings…';
// The listener failed: the hold on Save has no natural end until the page is
// reloaded (a failed subscription does not retry), so the copy says so.
export const LOAD_FAILED_MESSAGE = 'Couldn’t read your settings. Reload the page to try again.';
export const SAVE_FAILED_MESSAGE =
  'Couldn’t save — the previous settings are back. Check your connection and try again.';
// A first-ever save has no previous document to restore, so the generic copy
// would describe a rollback that never happened.
export const SAVE_FAILED_FIRST_MESSAGE = 'Couldn’t save — try again.';

// Whether one settings snapshot can establish the save baseline. A snapshot that
// carries a document always can: it holds the stored values a whole-document
// write has to re-send. A snapshot that reports no document only can when the
// server answered — the local cache also answers "no document" before any read
// has reached the backend, and a save against that fiction would replace the
// stored rate plan and charger address with whatever this device typed.
export function settingsSnapshotIsBaseline(data, meta = {}) {
  if (data != null) return true;
  return !(meta && meta.fromCache === true);
}

// Whether a route change needs the unsaved-changes confirmation (#129). Only
// the App settings form keeps unsaved state, so only leaving the Config tab
// with a dirty draft asks; every other route change applies immediately. The
// router owns the asking (it owns the hash); the screen owns the dialog.
export function settingsLeaveNeedsConfirm({ from = '', to = '', dirty = false } = {}) {
  return Boolean(dirty) && from === 'config' && to !== 'config';
}

// The card's whole visible state, derived from the draft and the flags the
// screen owns. `dirty` is computed and returned so the screen never has to keep
// a second, possibly divergent copy.
export function settingsSaveState({
  draft = { rate: '', currency: '', rates: [] },
  confirmed = null,
  loaded = true,
  saving = false,
  waiting = false,
  saved = false,
  error = '',
  offline = false,
} = {}) {
  const dirty = !settingsDraftMatches(draft, confirmed);
  let text = '';
  let kind = '';
  let busy = false;
  if (saving) {
    text = 'Saving…';
    busy = true;
  } else if (waiting) {
    // A refusal raised while an earlier write is still in flight explains more
    // than "waiting" and must stay visible: the offline copy says why this
    // retry did not start. The write itself is still running, so the retry
    // stays available and its late settlement still reconciles the form.
    text = error || WAITING_MESSAGE;
    kind = error ? 'err' : 'warn';
    busy = !error;
  } else if (error) {
    text = error;
    kind = 'err';
  } else if (saved && !dirty) {
    text = 'Saved.';
    kind = 'ok';
  } else if (!loaded) {
    // Hold the save path, don't just describe it: writing this form now would
    // replace the whole document with fields that only the owner's typing has
    // filled, deleting the stored rate plan and charger address.
    //
    // Offline with nothing read yet is not "still loading": the read cannot
    // finish until the connection returns, so name the cause instead of leaving
    // a loading hold that will never end on its own.
    text = offline ? OFFLINE_MESSAGE : LOADING_MESSAGE;
    kind = 'warn';
  } else if (dirty) {
    text = 'Unsaved changes.';
    kind = 'warn';
  }
  return {
    dirty,
    saved: saved && !dirty && !error,
    text,
    kind,
    busy,
    canSave: loaded && dirty && !saving,
  };
}

// Decide the post-settlement form state for one save. `draft` is what is in the
// inputs right now (a late settlement can land after the user typed again),
// `remote` is the snapshot observed while the write was in flight (`remoteSeen`
// distinguishes "none arrived" from "the document is missing").
export function reconcileSettingsSave({
  ok,
  values,
  previous = null,
  draft = { rate: '', currency: '', rates: [] },
  remote = null,
  remoteSeen = false,
} = {}) {
  const rates = Array.isArray(values.rates) ? values.rates : [];
  // The confirmed/attempted document is in stored shape (`charger_host`, absent
  // when the field was cleared; `show_temperature`, absent when the stat is
  // visible), exactly like a snapshot: every comparison below runs it through
  // settingsFields/normalizeSettings.
  const attempted = { rate: values.rate, currency: values.currency, rates };
  if (values.chargerHost) attempted.charger_host = values.chargerHost;
  if (values.showTemperature === false) attempted.show_temperature = false;
  const untouched = settingsDraftMatches(draft, attempted);
  const draftFields = {
    rate: String(draft.rate ?? ''),
    currency: String(draft.currency ?? ''),
    rates: Array.isArray(draft.rates) ? draft.rates : [],
    chargerHost: String(draft.chargerHost ?? ''),
    showTemperature: draft.showTemperature !== false,
  };

  if (ok) {
    // The write is confirmed; canonicalise the fields when only formatting
    // differs so the form is not left looking dirty after a successful save.
    let confirmed = attempted;
    let saved = untouched;
    let fields = untouched ? settingsFields(attempted) : draftFields;
    let dirty = !untouched;
    const snapshot = normalizeSettings(remote);
    if (snapshot && !settingsEqual(snapshot, confirmed)) {
      // A genuinely different snapshot arrived while the write was in flight;
      // adopt it rather than leave the form on our optimistic values.
      confirmed = snapshot;
      saved = false;
      // Only an untouched form is hydrated: a draft typed during the save wins.
      if (untouched) {
        fields = settingsFields(snapshot);
        dirty = false;
      }
    }
    return { confirmed, fields, dirty, saved, error: '' };
  }

  // Failure: roll back to the newest known server state — a snapshot that
  // arrived during the write outranks the baseline captured before it.
  const baseline = remoteSeen ? normalizeSettings(remote) : normalizeSettings(previous);
  if (!baseline) {
    // Nothing was ever confirmed (the account has no settings document): there
    // is no previous state to restore. Keep exactly what the user typed, stay
    // dirty, and leave Save available so the attempt can be repeated without
    // retyping both fields.
    return {
      confirmed: null,
      fields: draftFields,
      dirty: !settingsDraftMatches(draftFields, null),
      saved: false,
      error: SAVE_FAILED_FIRST_MESSAGE,
    };
  }
  const dirty = untouched ? false : !settingsDraftMatches(draft, baseline);
  return {
    confirmed: baseline,
    // Only an untouched form (or one whose draft already matches the baseline)
    // is hydrated; a typed draft is never overwritten.
    fields: untouched || !dirty ? settingsFields(baseline) : draftFields,
    dirty,
    saved: false,
    error: SAVE_FAILED_MESSAGE,
  };
}
