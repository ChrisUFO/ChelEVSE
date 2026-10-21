// Pure helpers for the app-settings form. No DOM, no Firebase — covered by
// test/web.

import {
  MAX_RATE_WINDOWS,
  RATE_MAX,
  RATE_MIN,
  normalizeRateSchedule,
  normalizeWindow,
  overlappingWindowPairs,
  parseRateValue,
  rateDayPartition,
  rateEntryAt,
  rateWindowsKey,
  validateRateWindows,
} from './rates.js';
import { DAY_NAMES } from './schedule.js';

// The rate bounds live in rates.js: the same 0–5 limit governs a flat rate and
// a window row, so both validators share one definition.
export { RATE_MAX, RATE_MIN } from './rates.js';

// Mirror firestore.rules: a write must carry both flat fields, rate is a number
// from 0 to 5, currency is a string of 1–8 characters. The optional `rates`
// list keeps the flat rate as its fallback; its rows are validated by
// validateRateWindows (rules only guard the container).
export const CURRENCY_MAX = 8;

// The form trims the currency, so a stray space cannot produce a string that
// rules would accept but people would read as empty. An absent `rates` list is
// a complete configuration: the flat rate covers every moment.
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

  // The rate editor owns the row and document-level rate messages; this
  // validator only reports the flat pair. A stored schedule must still be valid
  // for the document to be saveable (and must never be silently dropped), so its
  // verdict folds into `valid` without a second message channel.
  const windows = validateRateWindows(draft && draft.rates);

  return {
    valid: Object.keys(errors).length === 0 && windows.valid,
    errors,
    values: { rate, currency, rates: windows.values },
  };
}

// Only the documented shape is adopted from Firestore; anything else leaves the
// form empty for the owner to replace. Every rate row is kept here, invalid
// values included: the editor has to show a malformed stored row with its error
// rather than delete it silently on the next save. The costing layer
// (normalizeRateSchedule) still drops unusable rows, so a partially corrupt
// document prices what it can with the flat fallback.
export function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const normalized = normalizeRateSchedule(data);
  if (normalized.rate == null || normalized.currency == null) return null;
  const rates = Array.isArray(data.rates) ? data.rates.map(normalizeWindow) : [];
  return { rate: normalized.rate, currency: normalized.currency, rates };
}

// The form's fields. `rates` travels with them so a rate/currency edit never
// deletes a stored schedule, and the rate table can round-trip rows it does not
// change.
export function settingsFields(settings) {
  const normalized = normalizeSettings(settings);
  return normalized
    ? { rate: String(normalized.rate), currency: normalized.currency, rates: normalized.rates }
    : { rate: '', currency: '', rates: [] };
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
// so validation can point at it.
export function rateRowFields(raw) {
  const window = normalizeWindow(raw);
  return {
    id: window.id,
    rate: Number.isFinite(window.rate) ? String(window.rate) : '',
    days: window.days,
    start: window.start,
    end: window.end,
    months: Array.isArray(window.months) ? [...window.months] : window.months,
  };
}

// A fresh row is the everyday overnight preset with no price filled in: a
// made-up rate would be easy to save by accident, so the empty field keeps the
// row visibly incomplete until the owner enters their own. `months` is the
// period's scope, never a per-row choice.
export function defaultRateRow(id, months = null) {
  return {
    id,
    rate: '',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '07:00',
    months: Array.isArray(months) ? [...months] : months,
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
  const rates = rows
    .map((row) => parseRateValue(row && row.rate))
    .filter((rate) => Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX);
  if (rates.length === 0) return null;
  return { min: Math.min(...rates), max: Math.max(...rates) };
}

// The price range a plan summary advertises. Invalid rates are not allowed to
// widen it; the row's own error says what is wrong.
export function ratePlanRange(rows) {
  return rateRangeFor(Array.isArray(rows) ? rows : []);
}

// The longest contiguous run in a month set, used to give a new season a
// sensible default scope (the months no other season owns).
export function largestMonthRun(months) {
  const runs = monthRuns(Array.isArray(months) ? months : []);
  if (runs.length === 0) return [];
  const length = (run) => ((run.end - run.start + 12) % 12) + 1;
  let best = runs[0];
  for (const run of runs) if (length(run) > length(best)) best = run;
  const out = [];
  let month = best.start;
  for (;;) {
    out.push(month);
    if (month === best.end) break;
    month = month === 12 ? 1 : month + 1;
  }
  return out;
}

function periodOrder(period) {
  if (period.kind === 'invalid') return -1;
  if (period.kind === 'all') return 0;
  // The derived other-months period is the plan's tail, never a sibling that
  // can appear between two real seasons.
  if (period.kind === 'rest') return 100;
  return Math.min(...period.months);
}

// Group the flat draft into the periods the owner sees. Grouping is by stored
// month scope only: it is stable while prices, days and times are edited, and
// each row belongs to exactly one period, so a month edit can never move a row
// the owner did not touch. Rows are kept in their original positions (the
// stored order is the last-match-wins tie-break), with `index` pointing back
// into the draft array for editing.
export function ratePeriods(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  list.forEach((row, index) => {
    const scope = rateMonthScope(row);
    const key =
      scope.kind === 'invalid'
        ? 'invalid'
        : scope.kind === 'all'
          ? 'all'
          : `months:${scope.months.join(',')}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: scope.kind,
        months: scope.kind === 'months' ? scope.months : null,
        rows: [],
      });
    }
    groups.get(key).rows.push({ row, index });
  });
  const periods = [...groups.values()].map((period) => ({
    ...period,
    // `all` months are represented as null everywhere else in the form.
    months: period.kind === 'all' ? null : period.months,
    title: ratePeriodTitle(period.months, period.kind),
    monthText: rateMonthsText(period.months, period.kind),
    rateRange: rateRangeFor(period.rows.map((entry) => entry.row)),
  }));

  // Months no stored window covers still belong to the plan: they are where the
  // all-other-times rate applies. Showing them as one "Other months" period
  // makes the fallback literal instead of an unstated remainder. It owns no
  // rows, so it has no month editor and no remove action — only "Add window",
  // which turns those months into a real period.
  if (list.length > 0) {
    const covered = new Set();
    for (const period of periods) {
      if (period.kind === 'all') for (const month of ALL_MONTHS) covered.add(month);
      else for (const month of period.months || []) covered.add(month);
    }
    const rest = ALL_MONTHS.filter((month) => !covered.has(month));
    if (rest.length > 0) {
      periods.push({
        key: 'rest',
        kind: 'rest',
        months: rest,
        rows: [],
        title: 'Other months',
        monthText: rateMonthsText(rest),
        rateRange: null,
      });
    }
  }

  periods.sort(
    (a, b) =>
      periodOrder(a) - periodOrder(b) ||
      (b.months ? b.months.length : 12) - (a.months ? a.months.length : 12) ||
      a.key.localeCompare(b.key),
  );
  return periods;
}

// Change one period's months, in one edit, for every row it owns. Other rows are
// returned untouched (same array values, including order) so a legacy
// non-contiguous scope elsewhere is never rewritten as a side effect.
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
    targets.has(index) ? { ...row, months: next ? [...next] : null } : row,
  );
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

// Clone one period's rows into a new month scope, with fresh ids. Every array
// is copied so editing the copy cannot mutate the original.
export function copyPeriodRows(rows, indices, months, makeId) {
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
  }));
  return [...list, ...copies];
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
// Shoulder. A single price is described against the all-other-times rate, which
// is the comparison the owner actually makes. `Same price` is honest rather
// than calling an equal price cheap.
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

// A full name for an error that has to distinguish two rows ("Off-peak Weekdays
// · 16:00–19:00 · Nov–Feb"). The period months are included because that is
// what decides whether two rows can actually collide.
export function windowLabel(row, windowRates, fallbackRate, { months = true } = {}) {
  const tier = rateTierFor(row && row.rate, windowRates, fallbackRate);
  const price = parseRateValue(row && row.rate);
  const head = [tier, Number.isFinite(price) ? String(price) : ''].filter(Boolean).join(' ');
  const summary = rateWindowSummary(row);
  const monthText = months ? ` · ${rateMonthsText(row && row.months)}` : '';
  return `${head ? `${head} · ` : ''}${summary}${monthText}`;
}

// The rate table's validation. The old editor could only express one month
// range, so a valid non-contiguous list was flagged; the month chips can now
// show any set, so the shared window rules are the whole rulebook again.
export function validateRateEditorRows(rows, fallbackRate) {
  const base = validateRateWindows(rows);
  const list = Array.isArray(rows) ? rows : [];
  const rowErrors = base.errors.rows.map((errors) => ({ ...errors }));
  const overlaps = overlappingWindowPairs(list);
  const general = [];
  if (list.length > MAX_RATE_WINDOWS) {
    general.push(`A rate schedule can hold at most ${MAX_RATE_WINDOWS} windows.`);
  }
  if (overlaps.length > 0) general.push(rateOverlapMessage(overlaps, list, fallbackRate));
  const valid = rowErrors.every((errors) => Object.keys(errors).length === 0);
  return { valid: valid && general.length === 0, general, rows: rowErrors, overlaps };
}

// One document-level sentence naming both rows in every collision. Months are
// omitted when both rows share them (the period header already says so), and
// genuinely identical rows collapse to a single clause instead of repeating the
// same long name with an ordinal.
export function rateOverlapMessage(pairs, rows, fallbackRate) {
  const list = Array.isArray(rows) ? rows : [];
  const rates = list.map((row) => row && row.rate);
  const monthText = list.map((row) => rateMonthsText(row && row.months));
  const clauses = [];
  for (const [a, b] of Array.isArray(pairs) ? pairs : []) {
    const sameMonths = monthText[a] === monthText[b];
    const label = (index) =>
      list[index]
        ? windowLabel(list[index], rates, fallbackRate, { months: !sameMonths })
        : `Window ${index + 1}`;
    const left = label(a);
    const right = label(b);
    clauses.push(
      left === right ? `Two windows are identical: “${left}”` : `“${left}” overlaps “${right}”`,
    );
  }
  return `${clauses.join('; ')}. Change one of them so no moment has two rates.`;
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

function segmentSignature(segment) {
  const window = segment.window;
  const source = window
    ? [window.id, window.start, window.end, window.rate].join('|')
    : 'other-times';
  return [segment.from, segment.to, segment.rate, source].join(';');
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

// What applies in one period, for a representative month it sets on its own.
// Months shared with a broader period (an all-year window) are not used for the
// representative week when this period has its own months, so its coverage is
// not distorted by a sibling; when every month is shared, the first month is
// still the honest example.
export function periodCoverage(
  rows,
  fallbackRate,
  period,
  periods,
  year = new Date().getFullYear(),
) {
  const own = period && period.kind === 'all' ? ALL_MONTHS : (period && period.months) || [];
  const covered = new Set();
  for (const other of Array.isArray(periods) ? periods : []) {
    if (!other || other.key === (period && period.key) || other.kind === 'all') continue;
    for (const month of other.months || []) covered.add(month);
  }
  const exclusive = own.filter((month) => !covered.has(month));
  const months = exclusive.length > 0 ? exclusive : [...own];
  const month = months[0] || 1;
  const week = rateWeek(rows, fallbackRate, month, year);
  return {
    months,
    month,
    monthText: rateMonthsText(months),
    partial: months.length < own.length,
    week: Array.isArray(week) ? week : [],
    types: dayTypesForWeek(week),
  };
}

// The band name for a resolved segment, or "Other times" for the fallback.
export function rateSegmentLabel(segment, windowRates, fallbackRate) {
  if (!segment || !segment.window) return 'Other times';
  return rateTierFor(segment.rate, windowRates, fallbackRate) || 'Window';
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

// The exact-date checker: the winning row for one local instant, with the
// derived band and the row's own name. It reads the same draft array the editor
// shows, so unsaved edits are checked without a save.
export function previewRate(rows, fallbackRate, date) {
  const base = parseRateValue(fallbackRate);
  const entry = rateEntryAt(date, {
    rate: Number.isFinite(base) ? base : null,
    rates: rows,
  });
  if (!entry) return null;
  const rates = (Array.isArray(rows) ? rows : []).map((row) => row && row.rate);
  return {
    rate: entry.rate,
    window: entry.window,
    fallback: entry.window == null,
    tier: entry.window ? rateTierFor(entry.window.rate, rates, base) : '',
    summary: entry.window ? rateWindowSummary(entry.window) : '',
    monthsText: entry.window ? rateMonthsText(entry.window.months) : '',
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
// always has.
export function settingsPayload(values) {
  const source = values || {};
  const payload = { rate: source.rate, currency: source.currency };
  const rates = Array.isArray(source.rates) ? source.rates : [];
  if (rates.length > 0) {
    payload.rates = rates.map((row) => {
      const window = normalizeWindow(row);
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
// through rateWindowsKey so day/month order and numeric text do not matter.
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
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates)
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
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates)
  );
}

// ---------- save-state machine ----------

export const OFFLINE_MESSAGE = 'You’re offline — reconnect to save.';
export const WAITING_MESSAGE = 'Waiting for the server — this change may not be saved yet.';
export const SAVE_FAILED_MESSAGE =
  'Couldn’t save — the previous settings are back. Check your connection and try again.';
// A first-ever save has no previous document to restore, so the generic copy
// would describe a rollback that never happened.
export const SAVE_FAILED_FIRST_MESSAGE = 'Couldn’t save — try again.';

// The card's whole visible state, derived from the draft and the flags the
// screen owns. `dirty` is computed and returned so the screen never has to keep
// a second, possibly divergent copy.
export function settingsSaveState({
  draft = { rate: '', currency: '', rates: [] },
  confirmed = null,
  saving = false,
  waiting = false,
  saved = false,
  error = '',
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
  } else if (dirty) {
    text = 'Unsaved changes.';
    kind = 'warn';
  }
  return { dirty, saved: saved && !dirty && !error, text, kind, busy, canSave: dirty && !saving };
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
  const attempted = { rate: values.rate, currency: values.currency, rates };
  const untouched = settingsDraftMatches(draft, attempted);
  const draftFields = {
    rate: String(draft.rate ?? ''),
    currency: String(draft.currency ?? ''),
    rates: Array.isArray(draft.rates) ? draft.rates : [],
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
