// Pure history helpers — local calendar dates, chart periods and the read
// classification. No DOM, no Firebase; covered by test/web/history.test.js.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayId(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The last `count` local day ids, oldest first, ending with `today`.
// Noon avoids local-midnight DST transitions shifting the calendar date.
export function lastDayIds(count, today = new Date()) {
  const ids = [];
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(end);
    date.setDate(end.getDate() - i);
    ids.push(dayId(date));
  }
  return ids;
}

// Local calendar month, e.g. 2026-10. The year series buckets a day document by
// this prefix; no UTC conversion, matching dayId's local-date convention.
export function monthId(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
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

// One descriptor per selectable chart range. A period is data, not a branch:
// `bucket` decides how bounds and series are derived ('day' points or 'month'
// points) and `slots` is the number of points the chart draws. The screen reads
// the series length for its bar geometry, so a fourth period (#61's 24 hourly
// points) needs a descriptor and a segment button — no geometry or hit-test
// change.
export const PERIODS = [
  {
    id: 'week',
    label: 'Week',
    slots: 7,
    bucket: 'day',
    prefixToday: true,
    summaryLabel: 'Last 7 days',
    noun: 'daily energy',
    chartLabel:
      'Daily energy for the last 7 days. Use the left and right arrow keys to move between days.',
    emptyTitle: 'No energy recorded in the last 7 days.',
    emptyLine: 'Days without charging count as zero.',
    loadingLine: 'Reading the last 7 days.',
    offlineLine: 'Reconnect, then tap Refresh to load the last 7 days.',
  },
  {
    id: 'month',
    label: 'Month',
    slots: 30,
    bucket: 'day',
    prefixToday: true,
    summaryLabel: 'Last 30 days',
    noun: 'daily energy',
    chartLabel:
      'Daily energy for the last 30 days. Use the left and right arrow keys to move between days.',
    emptyTitle: 'No energy recorded in the last 30 days.',
    emptyLine: 'Days without charging count as zero.',
    loadingLine: 'Reading the last 30 days.',
    offlineLine: 'Reconnect, then tap Refresh to load the last 30 days.',
  },
  {
    id: 'year',
    label: 'Year',
    slots: 12,
    bucket: 'month',
    prefixToday: false,
    summaryLabel: 'Last 12 months',
    noun: 'monthly energy',
    chartLabel:
      'Monthly energy for the last 12 months. Use the left and right arrow keys to move between months.',
    emptyTitle: 'No energy recorded in the last 12 months.',
    emptyLine: 'Months without charging count as zero.',
    loadingLine: 'Reading the last 12 months.',
    offlineLine: 'Reconnect, then tap Refresh to load the last 12 months.',
  },
];

// Month keeps today's 30-day behaviour when the screen first opens.
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

// Inclusive document-id range for one period, oldest first. Both day periods and
// the year resolve to a contiguous day-id range, so the store needs one
// documentId() query and no period-specific read.
export function periodBounds(period, today = new Date()) {
  const descriptor = periodFor(period);
  if (descriptor.bucket === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth() - (descriptor.slots - 1), 1, 12);
    return { startId: dayId(start), endId: dayId(today) };
  }
  const ids = lastDayIds(descriptor.slots, today);
  return { startId: ids[0], endId: ids[ids.length - 1] };
}

// One point per rendered slot, oldest first, in one shape for every period:
// { id, kwh, label, isCurrent }. A month bucket sums its daily documents by the
// local YYYY-MM prefix; days without a document are genuine zero points, not
// gaps, and the current month is partial because only recorded days exist.
export function periodSeries(period, docs, today = new Date()) {
  const descriptor = periodFor(period);
  if (descriptor.bucket === 'month') {
    const months = [];
    const end = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    for (let i = descriptor.slots - 1; i >= 0; i--) {
      months.push(monthId(new Date(end.getFullYear(), end.getMonth() - i, 1, 12)));
    }
    const totals = new Map(months.map((id) => [id, 0]));
    for (const doc of docs || []) {
      if (!doc || typeof doc.id !== 'string') continue;
      const bucket = doc.id.slice(0, 7);
      if (!totals.has(bucket)) continue;
      const kwh = Number(doc.kwh);
      if (Number.isFinite(kwh) && kwh > 0) totals.set(bucket, totals.get(bucket) + kwh);
    }
    const current = monthId(today);
    return months.map((id) => ({
      id,
      kwh: totals.get(id),
      label: monthLabel(id),
      isCurrent: id === current,
    }));
  }
  const current = dayId(today);
  return historySeries(lastDayIds(descriptor.slots, today), docs).map((point) => ({
    ...point,
    isCurrent: point.id === current,
  }));
}

// Slot index for a pointer x, or null outside the plot. `count` is the number of
// points actually rendered: they fill the viewBox with no dead slots (7, 12 and
// 30 all map across the full width). `rect` is the SVG's bounding box in CSS
// pixels.
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
export function historySeries(ids, docs) {
  const byId = new Map();
  for (const doc of docs || []) {
    if (!doc || typeof doc.id !== 'string') continue;
    const kwh = Number(doc.kwh);
    byId.set(doc.id, Number.isFinite(kwh) && kwh > 0 ? kwh : 0);
  }
  return ids.map((id) => ({ id, kwh: byId.get(id) ?? 0, label: dayLabel(id) }));
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

// Presentation for one settled section read (`fresh`, `empty`, `cached`,
// `offline`, `error`). Only a read the server answered may be presented as
// current, and only 'empty' may claim nothing was recorded: a cache miss or a
// failed read either shows a previously loaded payload as stale or shows the
// section message, never zeroed data.
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
