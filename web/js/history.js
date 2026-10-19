// Pure history helpers — local calendar dates and the 30-day series. No DOM,
// no Firebase; covered by test/web/history.test.js.

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

// Chart geometry shared by the screen and its hit-testing tests. The viewBox is
// fixed and every one of its 30 slots is an equal share.
export const CHART_VIEW_W = 300;
export const CHART_SLOTS = 30;

// Nearest slot index for a pointer x, or null outside the plot. `rect` is the
// SVG's bounding box in CSS pixels.
export function chartIndexAt(clientX, rect, count) {
  if (!rect || !(rect.width > 0) || !Number.isFinite(clientX)) return null;
  const x = ((clientX - rect.left) / rect.width) * CHART_VIEW_W;
  if (x < 0 || x > CHART_VIEW_W) return null;
  const index = Math.max(0, Math.round((x / CHART_VIEW_W) * CHART_SLOTS - 0.5));
  return index < count ? index : null;
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
