// Pure history helpers — local calendar dates, chart periods and the read
// classification. No DOM, no Firebase; covered by test/web/history.test.js;
// the sessions paging block by test/web/history-screen.test.js.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayId(date) {
  const y = date.getFullYear();
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

// One bucket per local hour of the day; the bridge keys them with strftime's
// zero-padded "%H" ('00'–'23').
export const HOURS_PER_DAY = 24;

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
// bar shows what is recorded so far — nothing is padded or extrapolated).
// `dayId` carries the day the buckets belong to (the Day period's read targets
// that day's document): the pricing inputs for a schedule-priced hour bar.
export function hourSeries(hours, today = new Date()) {
  const currentHour = hourId(today.getHours());
  const day = dayId(today);
  return hourValues(hours).map((kwh, hour) => {
    const id = hourId(hour);
    return { id, kwh, label: `${id}:00`, isCurrent: id === currentHour, dayId: day };
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
// day-id range) and `slots` is the number of points the chart draws. The screen
// reads the series length for its bar geometry, so the Day period's 24 hourly
// points need a descriptor and a segment button — no geometry or hit-test
// change.
export const PERIODS = [
  {
    id: 'day',
    label: 'Day',
    slots: HOURS_PER_DAY,
    bucket: 'hour',
    source: 'day',
    prefixToday: false,
    summaryLabel: 'Today',
    noun: 'hourly energy',
    chartLabel: 'Hourly energy for today. Use the left and right arrow keys to move between hours.',
    emptyTitle: 'No energy recorded today.',
    emptyLine: 'Hours appear as charging is recorded.',
    noIntradayTitle: 'No hourly detail for today.',
    noIntradayLine: 'Hourly capture began recently, so today has a total but no hours behind it.',
    loadingLine: 'Reading today.',
    offlineLine: "Reconnect, then tap Refresh to load today's hours.",
  },
  {
    id: 'week',
    label: 'Week',
    slots: 7,
    bucket: 'day',
    source: 'range',
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
    source: 'range',
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
    source: 'range',
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

// Inclusive document-id range for one period, oldest first. Week, Month and
// Year resolve to a contiguous day-id range, so the store needs one
// documentId() query. The Day period has no range: it names exactly today, which
// is also the day its single-document read targets and the day the screen's
// midnight guard compares against.
export function periodBounds(period, today = new Date()) {
  const descriptor = periodFor(period);
  if (descriptor.source === 'day') {
    const id = dayId(today);
    return { startId: id, endId: id };
  }
  if (descriptor.bucket === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth() - (descriptor.slots - 1), 1, 12);
    return { startId: dayId(start), endId: dayId(today) };
  }
  const ids = lastDayIds(descriptor.slots, today);
  return { startId: ids[0], endId: ids[ids.length - 1] };
}

// How far before the range a session may have started and still be read.
// `started_at` is the only span field the sessions query can bound, so a
// session still running into the range from before it is caught by backing
// the start up: the bridge merges pause/resume while the vehicle stays
// connected and caps idle gaps at 48 h (pi/bridge.py SESSION_MERGE_MAX_GAP),
// so a real plug-in is bounded by its charging pattern — a week covers the
// weekly schedule shape. A longer plug-in's pre-range energy is not attributed
// (catching it would need an `ended_at` query Firestore does not offer here).
export const SESSIONS_LOOKBACK_DAYS = 7;

// The sessions read that prices a range period (#123): every session
// overlapping the window the day ids name, as a half-open `started_at` range.
// The end is the midnight after the last day — a session starting on the last
// day must be included — and the start is the range's first midnight minus the
// plug-in lookback above. Day-period reads never call this.
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

// One point per rendered slot, oldest first, in one shape for every period:
// { id, kwh, label, isCurrent }. The Day period's data is the single day
// document (`{ kwh, hours }`) rather than a list, so its series is the hours map
// itself; every range period aligns an array of daily documents to its slots.
// A month bucket sums its daily documents by the local YYYY-MM prefix — kWh is
// all the point carries, because a Year bar's $ comes from the period's
// overlapping sessions, never from day documents; days without a document are
// genuine zero points, not gaps, and the current month is partial because only
// recorded days exist.
export function periodSeries(period, data, today = new Date()) {
  const descriptor = periodFor(period);
  if (descriptor.source === 'day') return hourSeries(data && data.hours, today);
  const docs = data;
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
      if (Number.isFinite(kwh) && kwh > 0) {
        totals.set(bucket, totals.get(bucket) + kwh);
      }
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
