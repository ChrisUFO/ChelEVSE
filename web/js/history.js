// Pure history helpers — local calendar dates, chart periods and the read
// classification. No DOM, no Firebase; covered by test/web/history.test.js;
// the sessions paging block by test/web/history-screen.test.js.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
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

export function dayId(date) {
  // Zero-padded to four digits so the id is dayStartFromId's format at every
  // year — the parser requires `^\d{4}` and the window's order comparisons are
  // lexicographic, so a deep-paged year must not emit '826-01-01'.
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Local midnight of a day id — dayId's inverse — or null when the id is
// malformed or rolls over (2026-02-31). The wall-clock window a stored day id
// names, shared by the hour-bucket pricing (js/cost.js) and the session range
// read, so both slice at exactly the midnight the id means.
export function dayStartFromId(id) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(id));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

// Local noon of a date. Every calendar step is taken at noon so a local-midnight
// DST transition cannot shift the day it lands on (23:00 plus an hour is
// tomorrow), and a day step on a midnight epoch can never skip or repeat a date.
function noonOf(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
}

// The local calendar unit a period window covers, whole and unclipped, as an
// inclusive day-id range oldest first. One row per unit: a day is itself, a week
// is ISO 8601 Monday–Sunday, a month is its 1st to its last day, a year is
// 1 January to 31 December. `periodBounds` is the only caller, and it is what
// clips these at the present — so "which days does this period cover" has
// exactly one answer and every period's length comes from the calendar.
function calendarUnitIds(unit, anchor) {
  const noon = noonOf(anchor);
  const year = noon.getFullYear();
  const month = noon.getMonth();
  if (unit === 'week') {
    // ISO 8601: Monday opens the week, so getDay()'s Sunday 0 becomes 6.
    const monday = new Date(year, month, noon.getDate() - ((noon.getDay() + 6) % 7), 12);
    return {
      startId: dayId(monday),
      endId: dayId(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 12)),
    };
  }
  if (unit === 'month') {
    return {
      startId: dayId(new Date(year, month, 1, 12)),
      endId: dayId(new Date(year, month + 1, 0, 12)),
    };
  }
  if (unit === 'year') {
    return { startId: dayId(new Date(year, 0, 1, 12)), endId: dayId(new Date(year, 11, 31, 12)) };
  }
  return { startId: dayId(noon), endId: dayId(noon) };
}

// Every day id in an inclusive range, oldest first. The read range and the
// series ids both start from the window's bounds, so they cannot drift apart; a
// range whose end precedes its start is no days at all, never a reversed list.
export function dayIdsInRange(startId, endId) {
  const first = dayStartFromId(startId);
  const last = dayStartFromId(endId);
  if (!first || !last) return [];
  const ids = [];
  const stop = dayId(last);
  const date = noonOf(first);
  while (dayId(date) <= stop) {
    ids.push(dayId(date));
    date.setDate(date.getDate() + 1);
  }
  return ids;
}

// Every local month whose days a range touches, oldest first: the Year period's
// buckets are the months its window covers (January..this month in the current
// year, all twelve in a completed one), never a fixed count.
export function monthIdsInRange(startId, endId) {
  const first = dayStartFromId(startId);
  const last = dayStartFromId(endId);
  if (!first || !last) return [];
  if (dayId(first) > dayId(last)) return [];
  const ids = [];
  const stop = monthId(last);
  let cursor = new Date(first.getFullYear(), first.getMonth(), 1, 12);
  while (monthId(cursor) <= stop) {
    ids.push(monthId(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12);
  }
  return ids;
}

// Local calendar month, e.g. 2026-10. The year series buckets a day document by
// this prefix; no UTC conversion, matching dayId's local-date convention, and the
// year is padded the same way so a document's prefix and its bucket id stay the
// same format at any depth of paging.
export function monthId(date) {
  const y = String(date.getFullYear()).padStart(4, '0');
  return `${y}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Stable "Oct 2026" label; a malformed id is returned unchanged.
export function monthLabel(id) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(id));
  if (!match) return String(id);
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return String(id);
  return `${MONTHS[month]} ${match[1]}`;
}

// Chart geometry shared by the screen and its hit-testing tests. The viewBox is
// fixed; every visible point owns an equal share of it.
export const CHART_VIEW_W = 300;

// One bucket per local hour of the day; the bridge keys them with strftime's
// zero-padded "%H" ('00'–'23').
const HOURS_PER_DAY = 24;

// '05' for hour 5. The stored keys are zero-padded in the document, not just in
// the UI, so the same helper serves both.
export function hourId(hour) {
  return String(hour).padStart(2, '0');
}

// The bucket values for a day, midnight first, in the order the chart draws
// them. A missing, malformed or empty map is 24 zeros: whether those zeros may
// be painted is the read state's decision, never this function's.
function hourValues(hours) {
  const map = hours && typeof hours === 'object' && !Array.isArray(hours) ? hours : {};
  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
    const kwh = Number(map[hourId(hour)]);
    return Number.isFinite(kwh) && kwh > 0 ? kwh : 0;
  });
}

// 24 hourly points in the same shape every period's series uses:
// { id, kwh, label, isCurrent }. `isCurrent` marks the hour in progress (the
// bar shows what is recorded so far — nothing is padded or extrapolated), and
// only for the day the anchor names: `now` is the clock, `anchor` is the day
// being drawn, so a paged (past) day marks no hour current. The default `now`
// is the anchor, which is exactly the pre-paging behaviour. `dayId` carries the
// day the buckets belong to (the Day period's read targets that day's
// document): the pricing inputs for a schedule-priced hour bar.
export function hourSeries(hours, anchor = new Date(), now = anchor) {
  const currentHour = hourId(now.getHours());
  const currentDay = dayId(anchor) === dayId(now);
  const day = dayId(anchor);
  return hourValues(hours).map((kwh, hour) => {
    const id = hourId(hour);
    return {
      id,
      kwh,
      label: `${id}:00`,
      isCurrent: currentDay && id === currentHour,
      dayId: day,
    };
  });
}

// "21:00–22:00" for the selected hour; the last hour closes at midnight rather
// than wrapping to 00:00 of a day the period does not cover.
export function hourRange(id) {
  const hour = Number(id);
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) return String(id);
  const end = hour + 1 === HOURS_PER_DAY ? '24:00' : `${hourId(hour + 1)}:00`;
  return `${hourId(hour)}:00–${end}`;
}

// One descriptor per selectable chart range. A period is data, not a branch:
// `bucket` decides how series points are derived ('hour', 'day' or 'month'),
// `source` decides which read supplies them (one day document or a contiguous
// day-id range) and `unit` is the calendar unit the window covers and pages by.
// A window's *length* is not data: it comes from the calendar, so a month is
// 28–31 daily bars and the current year is January..this month. The screen reads
// the series length for its bar geometry, so no layout constant knows how long a
// period is.
//
// Paging steps exactly one of the period's own calendar units; `copy(span)` is
// the single source of every string that names the window, and `span` is the
// description `periodSpan` returns. There is one register per period — offset 0
// is simply the current calendar unit ("October 2026"), not a second set of
// words.
export const PERIODS = [
  {
    id: 'day',
    unit: 'day',
    bucket: 'hour',
    source: 'day',
    noun: 'hourly energy',
    copy: (span) => ({
      chartLabel: `Hourly energy for ${span.phrase}. Use the left and right arrow keys to move between hours.`,
      emptyTitle: `No energy recorded on ${span.phrase}.`,
      emptyLine: 'Hours appear as charging is recorded.',
      noIntradayTitle: `No hourly detail for ${span.phrase}.`,
      noIntradayLine: `Hourly capture began recently, so ${span.phrase} has a total but no hours behind it.`,
      loadingLine: `Reading ${span.phrase}.`,
      offlineLine: `Reconnect, then tap Refresh to load the hours for ${span.phrase}.`,
    }),
  },
  {
    id: 'week',
    unit: 'week',
    bucket: 'day',
    source: 'range',
    noun: 'daily energy',
    copy: (span) => ({
      chartLabel: `Daily energy for ${span.phrase}. Use the left and right arrow keys to move between days.`,
      emptyTitle: `No energy recorded in ${span.phrase}.`,
      emptyLine: 'Days without charging count as zero.',
      loadingLine: `Reading ${span.phrase}.`,
      offlineLine: `Reconnect, then tap Refresh to load the energy for ${span.phrase}.`,
    }),
  },
  {
    id: 'month',
    unit: 'month',
    bucket: 'day',
    source: 'range',
    noun: 'daily energy',
    copy: (span) => ({
      chartLabel: `Daily energy for ${span.phrase}. Use the left and right arrow keys to move between days.`,
      emptyTitle: `No energy recorded in ${span.phrase}.`,
      emptyLine: 'Days without charging count as zero.',
      loadingLine: `Reading ${span.phrase}.`,
      offlineLine: `Reconnect, then tap Refresh to load the energy for ${span.phrase}.`,
    }),
  },
  {
    id: 'year',
    unit: 'year',
    bucket: 'month',
    source: 'range',
    noun: 'monthly energy',
    copy: (span) => ({
      chartLabel: `Monthly energy for ${span.phrase}. Use the left and right arrow keys to move between months.`,
      emptyTitle: `No energy recorded in ${span.phrase}.`,
      emptyLine: 'Months without charging count as zero.',
      loadingLine: `Reading ${span.phrase}.`,
      offlineLine: `Reconnect, then tap Refresh to load the energy for ${span.phrase}.`,
    }),
  },
];

// Month is the default period — after the calendar re-baseline, that means this
// month.
export const DEFAULT_PERIOD = 'month';

export function periodById(id) {
  return (
    PERIODS.find((period) => period.id === id) ||
    PERIODS.find((period) => period.id === DEFAULT_PERIOD)
  );
}

function periodFor(period) {
  return typeof period === 'string' ? periodById(period) : periodById(period && period.id);
}

// The anchor a window at `offset` is drawn for: offset 0 is now, every deeper
// offset steps back one whole calendar unit of the period's own kind — a day, an
// ISO week, a calendar month, a calendar year — so consecutive windows neither
// overlap nor leave a day uncovered. The anchor is the unit's first moment (the
// date itself for Day, that week's Monday for Week, the 1st for Month, 1 January
// for Year), so a step never carries a day-of-month into a shorter month: no
// month-end clamping exists to get wrong, and 29 February plus a year is simply
// the next year's January. Local noon keeps every step off a DST midnight
// transition.
export function periodAnchor(period, offset, now = new Date()) {
  const descriptor = periodFor(period);
  const steps = Number(offset);
  if (!Number.isFinite(steps) || steps <= 0) return new Date(now);
  const noon = noonOf(now);
  const year = noon.getFullYear();
  const month = noon.getMonth();
  if (descriptor.unit === 'week') {
    const monday = noon.getDate() - ((noon.getDay() + 6) % 7);
    return new Date(year, month, monday - steps * 7, 12);
  }
  if (descriptor.unit === 'month') return new Date(year, month - steps, 1, 12);
  if (descriptor.unit === 'year') return new Date(year - steps, 0, 1, 12);
  return new Date(year, month, noon.getDate() - steps, 12);
}

// A span reads in two registers, both built here from the same ids.
//
// The title register (`label`) is what the summary's label has room for: short
// months — the chart's own bar-label vocabulary ("Sat 18 Oct"). The prose
// register (`phrase`) spells the months out for the sentences ("No energy
// recorded on Saturday 18 October 2026"), where short month names would read
// like a table.
//
// Both registers glue each date run with a hard space and glue the dash to the
// date it follows, so the only place a week may wrap is the space after the
// dash. A year never lands on a line of its own, and a sentence never breaks
// between a day and its month.
const HARD_SPACE = '\u00a0';

// One calendar date — the Day period's whole span. "Sat 18 Oct 2026" in the
// title register, "Saturday 18 October 2026" in the prose one.
function dateSpan(id, weekdays, months) {
  const date = dayStartFromId(id);
  if (!date) return String(id);
  return (
    `${weekdays[date.getDay()]}${HARD_SPACE}${date.getDate()}${HARD_SPACE}` +
    `${months[date.getMonth()]}${HARD_SPACE}${date.getFullYear()}`
  );
}

// A whole ISO week, named by both of its ends: "Mon 5 – Sun 11 Oct 2026" in the
// title register, "Monday 5 – Sunday 11 October 2026" in the prose one, with the
// month collapsed when the week sits inside one and both years named when it
// crosses a year end. A single shared month is what most weeks look like, so it
// is the shape that must stay shortest.
//
// The one-day exception is the clipped current week on its Monday: both bounds
// are that Monday, so naming both ends would say the same date twice
// ("Mon 12 – Mon 12 Oct 2026"). It is a single date and reads as one.
function weekSpan(startId, endId, weekdays, months) {
  if (startId === endId) return dateSpan(startId, weekdays, months);
  const first = dayStartFromId(startId);
  const last = dayStartFromId(endId);
  if (!first || !last) return `${startId} – ${endId}`;
  const sameYear = first.getFullYear() === last.getFullYear();
  const sameMonth = sameYear && first.getMonth() === last.getMonth();
  const left = `${weekdays[first.getDay()]}${HARD_SPACE}${first.getDate()}`;
  return (
    (sameMonth
      ? left
      : `${left}${HARD_SPACE}${months[first.getMonth()]}` +
        (sameYear ? '' : `${HARD_SPACE}${first.getFullYear()}`)) +
    `${HARD_SPACE}– ${weekdays[last.getDay()]}${HARD_SPACE}${last.getDate()}${HARD_SPACE}` +
    `${months[last.getMonth()]}${HARD_SPACE}${last.getFullYear()}`
  );
}

// The calendar unit one chart paints, described once for every string that names
// it: `label` titles it (the summary label), `phrase` is the mid-sentence form
// the copy uses. Month and Year are named as the units they are ("October 2026",
// "2026"); Week and Day are named by the dates they cover, which for the unit
// holding the clock is exactly the days drawn, because the bounds are clipped at
// today. There is no second, default-view register: offset 0 is simply the
// current calendar unit.
export function periodSpan(period, anchor = new Date(), now = anchor) {
  const descriptor = periodFor(period);
  const bounds = periodBounds(descriptor, anchor, now);
  if (descriptor.unit === 'month') {
    const first = dayStartFromId(bounds.startId);
    const label = first
      ? `${MONTHS_LONG[first.getMonth()]}${HARD_SPACE}${first.getFullYear()}`
      : bounds.startId;
    return { label, phrase: label };
  }
  if (descriptor.unit === 'year') {
    const first = dayStartFromId(bounds.startId);
    const label = first ? String(first.getFullYear()) : bounds.startId;
    return { label, phrase: label };
  }
  return descriptor.unit === 'week'
    ? {
        label: weekSpan(bounds.startId, bounds.endId, WEEKDAYS, MONTHS),
        phrase: `the week of ${weekSpan(bounds.startId, bounds.endId, WEEKDAYS_LONG, MONTHS_LONG)}`,
      }
    : {
        label: dateSpan(bounds.startId, WEEKDAYS, MONTHS),
        phrase: dateSpan(bounds.startId, WEEKDAYS_LONG, MONTHS_LONG),
      };
}

// Inclusive document-id range for one period, oldest first. Week, Month and
// Year resolve to a contiguous day-id range, so the store needs one
// documentId() query. The Day period has no range: it names exactly the day its
// single-document read targets and its window's anchor names.
//
// The start is the calendar unit's first day and the end is the unit's last day
// **clamped at today**. That clamp is the whole clipping rule: the unit holding
// the clock stops at today (this month 1..today, this week Monday..today, this
// year January..today), so no bar is a future bucket the app would have to paint
// as zero, while every completed unit ends before today and is therefore already
// whole (a past October is 1–31, a past year January–December). Offset 1 still
// ends the day before offset 0 begins, because it is the day before the current
// unit's first day.
export function periodBounds(period, anchor = new Date(), now = anchor) {
  const descriptor = periodFor(period);
  if (descriptor.source === 'day') {
    const id = dayId(anchor);
    return { startId: id, endId: id };
  }
  const unit = calendarUnitIds(descriptor.unit, anchor);
  const today = dayId(now);
  return { startId: unit.startId, endId: unit.endId < today ? unit.endId : today };
}

// How far before the range a session may have started and still be read.
// `started_at` is the only span field the sessions query can bound, so a
// session still running into the range from before it is caught by backing
// the start up: the bridge merges pause/resume while the vehicle stays
// connected and caps idle gaps at 48 h (pi/bridge.py SESSION_MERGE_MAX_GAP),
// so a real plug-in is bounded by its charging pattern — a week covers the
// weekly schedule shape. A longer plug-in's pre-range energy is not attributed
// (catching it would need an `ended_at` query Firestore does not offer here).
// (catching it would need an `ended_at` query Firestore does not offer here).
// #210 decision: Day windows share this unchanged — every period derives its
// read from the same sessionsRange arithmetic, so a Day window's lookback is
// exactly as deep as a Week's from its own first midnight, and no period gets
// a second, period-shaped depth.
export const SESSIONS_LOOKBACK_DAYS = 7;

// The sessions read that prices a period (#123, #210): every session
// overlapping the window the day ids name — the Day period's single-day
// window included, same as every range — as a half-open `started_at` range.
// The end is the midnight after the last day — a session starting on the last
// day must be included — and the start is the range's first midnight minus the
// plug-in lookback above.
export function sessionsRange(bounds) {
  const first = dayStartFromId(bounds && bounds.startId);
  const last = dayStartFromId(bounds && bounds.endId);
  if (!first || !last) return null;
  return {
    start: new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate() - SESSIONS_LOOKBACK_DAYS,
    ),
    end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
  };
}

// One point per rendered bucket, oldest first, in one shape for every period:
// { id, kwh, label, isCurrent }. The buckets are the window's own bounds read
// back through the calendar — never a slot count — so a 28-day February draws 28
// bars and the current year draws January..this month. The Day period's data is
// the single day document (`{ kwh, hours }`) rather than a list, so its series is
// the hours map itself; every range period aligns an array of daily documents to
// its days.
// A month bucket sums its daily documents by the local YYYY-MM prefix — kWh is
// all the point carries, because a Year bar's $ comes from the period's
// overlapping sessions, never from day documents; days without a document are
// genuine zero points, not gaps, and the current month is partial because only
// recorded days exist.
//
// `anchor` is the window the chart draws; `now` is the clock, and a bucket is
// current only when it is now's own bucket (today's day, the hour in progress,
// this month) — so a paged window, whose anchor is in the past, marks nothing
// current and the live pricing gate stays closed for it. `now` defaults to the
// anchor, which is the pre-paging shape.
export function periodSeries(period, data, anchor = new Date(), now = anchor) {
  const descriptor = periodFor(period);
  if (descriptor.source === 'day') return hourSeries(data && data.hours, anchor, now);
  const docs = data;
  const bounds = periodBounds(descriptor, anchor, now);
  if (descriptor.bucket === 'month') {
    const months = monthIdsInRange(bounds.startId, bounds.endId);
    const totals = new Map(months.map((id) => [id, 0]));
    for (const doc of docs || []) {
      if (!doc || typeof doc.id !== 'string') continue;
      const bucket = doc.id.slice(0, 7);
      if (!totals.has(bucket)) continue;
      const kwh = Number(doc.kwh);
      if (Number.isFinite(kwh) && kwh > 0) {
        totals.set(bucket, totals.get(bucket) + kwh);
      }
    }
    const current = monthId(now);
    return months.map((id) => ({
      id,
      kwh: totals.get(id),
      label: monthLabel(id),
      isCurrent: id === current,
    }));
  }
  const current = dayId(now);
  return historySeries(dayIdsInRange(bounds.startId, bounds.endId), docs).map((point) => ({
    ...point,
    isCurrent: point.id === current,
  }));
}

// Slot index for a pointer x, or null outside the plot. `count` is the number of
// points actually rendered: they fill the viewBox with no dead slots, whatever
// the calendar hands the period — 7, 12, 24 or a 28–31-bar month. `rect` is the
// SVG's bounding box in CSS pixels.
export function chartIndexAt(clientX, rect, count) {
  if (!rect || !(rect.width > 0) || !Number.isFinite(clientX)) return null;
  const slots = Number(count);
  if (!Number.isFinite(slots) || slots <= 0) return null;
  const x = ((clientX - rect.left) / rect.width) * CHART_VIEW_W;
  if (x < 0 || x > CHART_VIEW_W) return null;
  const index = Math.floor((x / CHART_VIEW_W) * slots);
  return index < slots ? index : null;
}

// Stable "Sat 18 Oct" label; parsing the id as local time keeps the same day.
export function dayLabel(id) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(id));
  if (!match) return String(id);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (Number.isNaN(date.getTime())) return String(id);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// Align Firestore docs to the requested day ids; absent/malformed days are 0.
// A point carries its kWh total alone: a range period's $ comes from the
// period's overlapping sessions (#123), so no pricing input rides on the
// point — `hours` prices only the Day period's own bars, and a day with no
// document is a genuine zero like any other, not a gap to disclose.
export function historySeries(ids, docs) {
  const byId = new Map();
  for (const doc of docs || []) {
    if (!doc || typeof doc.id !== 'string') continue;
    const kwh = Number(doc.kwh);
    byId.set(doc.id, Number.isFinite(kwh) && kwh > 0 ? kwh : 0);
  }
  return ids.map((id) => ({
    id,
    kwh: byId.get(id) || 0,
    label: dayLabel(id),
  }));
}

export function sumSeries(series) {
  return series.reduce((total, point) => total + (Number.isFinite(point.kwh) ? point.kwh : 0), 0);
}

export function maxSeries(series) {
  return series.reduce((max, point) => Math.max(max, point.kwh || 0), 0);
}

// One-shot reads resolve from the local cache when the SDK is offline. An empty
// cached range is not evidence that nothing was recorded, so classify the read:
// 'fresh' / 'cached' (has data), 'empty' (server said none), or 'offline'
// (cached and empty — the server was never reached).
export function historyReadState(result) {
  const count = result && Array.isArray(result.docs) ? result.docs.length : 0;
  const cached = Boolean(result && result.fromCache);
  if (count > 0) return cached ? 'cached' : 'fresh';
  return cached ? 'offline' : 'empty';
}

// Classification for the Day period's single-document read. The rule the issue
// turns on: hours recorded before hourly capture existed do not exist, so they
// must never be drawn as zero. 'no-intraday' marks a day whose document has a
// real daily total but no usable hourly buckets — including a cached copy, whose
// honest reading is still "no hours here" rather than 24 empty bars. A missing
// document is 'empty' only when the server answered; a cached read with no
// usable data is 'offline', because "nothing recorded today" would be a claim
// this device cannot make.
export function hourReadState(result) {
  if (!result) return 'empty';
  const fromCache = Boolean(result.fromCache);
  // `exists` is explicit in the store's shape; a bare { kwh, hours } fixture is
  // treated as a document that exists.
  const exists = result.exists !== false;
  const values = exists ? hourValues(result.hours) : [];
  if (values.some((kwh) => kwh > 0)) return fromCache ? 'cached' : 'fresh';
  const kwh = Number(result.kwh);
  if (exists && Number.isFinite(kwh) && kwh > 0) return 'no-intraday';
  return fromCache ? 'offline' : 'empty';
}

// A rejected single-document read is the Day period's cache miss: getDoc cannot
// resolve an empty snapshot for a document the cache never held, so it rejects
// with a transport code instead (a range query resolves an empty list). Only a
// transport failure is 'offline'; a permission or backend error keeps the error
// copy, which says to check the connection and refresh without claiming the
// device is offline.
export function hourReadFailure(error) {
  const code = error && error.code;
  return code === 'unavailable' || code === 'deadline-exceeded' ? 'offline' : 'error';
}

// Presentation for one settled section read (`fresh`, `empty`, `cached`,
// `offline`, `error`, `no-intraday`). Only a read the server answered may be
// presented as current, and only 'empty' may claim nothing was recorded: a cache
// miss or a failed read either shows a previously loaded payload as stale or
// shows the section message, never zeroed data. 'no-intraday' is a message too,
// not data: the period has points it must not paint.
export function sectionView(state, hasPreviousData) {
  if (state === 'fresh' || state === 'empty') {
    return { showData: true, stale: false, claimEmpty: state === 'empty' };
  }
  if (state === 'cached') return { showData: true, stale: true, claimEmpty: false };
  if (state === 'offline' || state === 'error') {
    return {
      showData: Boolean(hasPreviousData),
      stale: Boolean(hasPreviousData),
      claimEmpty: false,
    };
  }
  return { showData: false, stale: false, claimEmpty: false };
}

// ---------- sessions view (pure) ----------

// The sessions list's page size: the query cap store.js reads and the
// short-page rule below concludes exhaustion from — one number, one home.
export const SESSION_LIMIT = 20;

// A view with nothing shown: the state every first read starts from.
export function emptySessionsView() {
  return {
    sessions: [],
    month: null,
    cursor: null,
    exhausted: false,
    state: 'idle',
  };
}

// Pages are disjoint by construction — `startAfter` continues past the last
// shown document — but a re-read or a cache overlap must never render a row
// twice, so pages merge by id (the bridge's id is the start epoch, unique per
// session). The query's newest-first order is the kept order; nothing re-sorts.
export function mergeSessions(shown = [], page = []) {
  const merged = Array.isArray(shown) ? [...shown] : [];
  const seen = new Set(merged.map((item) => item && item.id));
  for (const item of Array.isArray(page) ? page : []) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

// The sessions view after one settled read; `read` null means the read failed.
//   kind 'first'  page one of the view named by `month` ('YYYY-MM') or null
//                 (recent): a read the server or the cache answered adopts
//                 that view and replaces the list — refresh, a month pick and
//                 the Recent reset all land here — while a failed read or an
//                 offline cache miss keeps the previous view on screen.
//   kind 'more'   the next page of the rendered view: appended without
//                 duplicates, the cursor advanced past it.
// Exhaustion is concluded only by a server-answered short page: a cached short
// page is the cache answering, not the archive ending.
export function nextSessionsView(view, read, { kind = 'first', month = null } = {}) {
  const current = view || emptySessionsView();
  if (!read) {
    // A failed read changes nothing but the state: the rendered list stays
    // exactly as it was, ready for a retry.
    return { ...current, state: 'error' };
  }
  const state = historyReadState(read);
  if (state === 'offline') {
    // An offline cache miss is not an answer: keep the previous view the way
    // the pre-paging screen kept its last loaded list.
    return { ...current, state };
  }
  const short = !read.fromCache && read.docs.length < SESSION_LIMIT;
  if (kind === 'more') {
    const sessions = mergeSessions(current.sessions, read.docs);
    return {
      ...current,
      // An empty page ends the archive without erasing it: the kept list is
      // complete, which is a current presentation, not "no sessions".
      state: state === 'empty' && sessions.length ? 'fresh' : state,
      sessions,
      cursor: read.lastDoc || current.cursor,
      exhausted: current.exhausted || short,
    };
  }
  return {
    state,
    month,
    sessions: read.docs,
    cursor: read.lastDoc || null,
    exhausted: short,
  };
}

// The "show more" control's painting: offered only beside a rendered list that
// no server-answered short page has concluded, whatever the read state — a
// failed or cached page leaves it usable for a retry. Previous data is "rows
// exist", not payload provenance: a cached view survives an offline or failed
// read the same way a server-sourced one does.
export function sessionsControls(view) {
  const section = sectionView(view.state, view.sessions.length > 0);
  return { more: Boolean(section.showData) && !view.exhausted && view.sessions.length > 0 };
}
