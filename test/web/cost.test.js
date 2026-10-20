// Cost-presentation helpers: flat parity, schedule selection, interval costing
// and the hidden aggregate. The timezone is pinned before any Date is built, so
// the DST cases only mean something in a zone that observes daylight saving.
process.env.TZ = 'America/Denver';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCostLabel,
  costSettings,
  liveCostLabel,
  sessionCostLabel,
} from '../../web/js/cost.js';
import { fmtCost } from '../../web/js/format.js';

const HOUR_MS = 60 * 60 * 1000;

// Month is 1-based here so the fixtures read like the stored documents.
function date(year, month, day, hours = 0, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes);
}

const FLAT = { rate: 0.245, currency: 'GBP' };

// A nightly off-peak window (00:00–06:00) at 0.10 and a 0.30 fallback.
function nightly(overrides = {}) {
  return {
    rate: 0.3,
    currency: 'GBP',
    rates: [
      {
        id: 'night',
        rate: 0.1,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '06:00',
        months: null,
        ...overrides,
      },
    ],
  };
}

function session(started, ended, wh) {
  return { wh, started_at: started, ended_at: ended };
}

test('the test process runs in a DST-observing local timezone', () => {
  assert.equal(date(2026, 1, 1).getTimezoneOffset(), 420); // MST, UTC-7
  assert.equal(date(2026, 7, 1).getTimezoneOffset(), 360); // MDT, UTC-6
});

// ---------- flat parity ----------

test('flat output is byte-identical to fmtCost for every helper', () => {
  const now = date(2026, 1, 5, 12, 0);
  // Status: kWh from Wh, flat rate and currency exactly as before.
  assert.equal(liveCostLabel(12345, 3600, now, FLAT), fmtCost(12.345, 0.245, 'GBP'));
  assert.equal(liveCostLabel(12345, 3600, now, FLAT), 'GBP 3.02');
  // The elapsed span is irrelevant without a schedule, including when missing.
  assert.equal(liveCostLabel(12345, null, now, FLAT), 'GBP 3.02');
  assert.equal(liveCostLabel(12345, 0, now, FLAT), 'GBP 3.02');
  // A finished session: Wh → kWh → flat cost.
  const item = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 2000);
  assert.equal(sessionCostLabel(item, FLAT), fmtCost(2, 0.245, 'GBP'));
  // Aggregate: kWh input straight through fmtCost.
  assert.equal(aggregateCostLabel(12.345, FLAT), fmtCost(12.345, 0.245, 'GBP'));
  // Absent rate/currency and unusable energy keep today's null (hidden).
  assert.equal(liveCostLabel(1000, 3600, now, null), null);
  assert.equal(aggregateCostLabel(null, FLAT), null);
  assert.equal(aggregateCostLabel('', FLAT), null);
  assert.equal(sessionCostLabel(null, FLAT), null);
});

test('an empty or unusable rates list is the flat path', () => {
  const empty = { ...FLAT, rates: [] };
  assert.equal(aggregateCostLabel(10, empty), 'GBP 2.45');
  assert.equal(liveCostLabel(1000, null, date(2026, 1, 5), empty), 'GBP 0.25');
  // normalizeRateSchedule drops malformed rows, so a corrupt list is no schedule.
  const corrupt = { ...FLAT, rates: [{ id: 'bad' }] };
  assert.equal(costSettings(corrupt).rates.length, 0);
  assert.equal(aggregateCostLabel(10, corrupt), 'GBP 2.45');
});

// ---------- live session ----------

test('live cost uses the schedule over the elapsed interval', () => {
  // 1 kWh drawn over one hour inside the off-peak window.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 5, 3, 0), nightly()), 'GBP 0.10');
  // Same energy outside the window pays the fallback.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 5, 12, 0), nightly()), 'GBP 0.30');
  // Straddling the 06:00 boundary: half the hour at each rate.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 5, 6, 30), nightly()), 'GBP 0.20');
  // The 22:00–06:00 wrap keeps the early hours of the next day cheap.
  const wrap = nightly({ start: '22:00', end: '06:00' });
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 6, 0, 30), wrap), 'GBP 0.10');
  // Numeric text from a hand-edited status document parses like a number.
  assert.equal(liveCostLabel('1000', '3600', date(2026, 1, 5, 3, 0), nightly()), 'GBP 0.10');
});

test('a schedule hides the live cost when the interval cannot be priced', () => {
  const now = date(2026, 1, 5, 3, 0);
  // No elapsed duration: the fallback would misprice a window that applies now.
  assert.equal(liveCostLabel(1000, null, now, nightly()), null);
  assert.equal(liveCostLabel(1000, 0, now, nightly()), null);
  assert.equal(liveCostLabel(1000, -60, now, nightly()), null);
  assert.equal(liveCostLabel(1000, '', now, nightly()), null);
  // No usable clock.
  assert.equal(liveCostLabel(1000, 3600, null, nightly()), null);
  assert.equal(liveCostLabel(1000, 3600, Number.NaN, nightly()), null);
});

// ---------- finished sessions ----------

test('session cost uses the stored interval', () => {
  const inside = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 2000);
  assert.equal(sessionCostLabel(inside, nightly()), 'GBP 0.20');
  const outside = session(date(2026, 1, 5, 12, 0), date(2026, 1, 5, 13, 0), 2000);
  assert.equal(sessionCostLabel(outside, nightly()), 'GBP 0.60');
  // 05:00–07:00: 2 kWh off-peak, 2 kWh at the fallback.
  const crossing = session(date(2026, 1, 5, 5, 0), date(2026, 1, 5, 7, 0), 4000);
  assert.equal(sessionCostLabel(crossing, nightly()), 'GBP 0.80');
});

test('a session without usable endpoints hides its scheduled cost', () => {
  const missingEnd = { wh: 2000, started_at: date(2026, 1, 5, 1, 0) };
  assert.equal(sessionCostLabel(missingEnd, nightly()), null);
  const reversed = session(date(2026, 1, 5, 2, 0), date(2026, 1, 5, 1, 0), 2000);
  assert.equal(sessionCostLabel(reversed, nightly()), null);
  assert.equal(sessionCostLabel({ wh: 2000 }, nightly()), null);
});

// ---------- DST and calendar boundaries ----------

test('a spring-forward session is priced over its real duration', () => {
  // 2026-03-08 in Denver: 02:00 MST → 03:00 MDT, so 00:00–06:00 is 5 real
  // hours. The 03:00 boundary leaves 2 h off-peak and 3 h at the fallback.
  const spring = session(date(2026, 3, 8, 0, 0), date(2026, 3, 8, 6, 0), 5000);
  assert.equal(sessionCostLabel(spring, nightly({ end: '03:00' })), 'GBP 1.10');
});

test('a fall-back session is priced over its real duration', () => {
  // 2026-11-01 in Denver: 02:00 MDT → 01:00 MST, so 00:00–06:00 is 7 real
  // hours. The 03:00 boundary leaves 4 h off-peak and 3 h at the fallback.
  const autumn = session(date(2026, 11, 1, 0, 0), date(2026, 11, 1, 6, 0), 7000);
  assert.equal(sessionCostLabel(autumn, nightly({ end: '03:00' })), 'GBP 1.30');
});

test('a December window prices the early hours of 1 January', () => {
  const december = nightly({ start: '22:00', end: '06:00', months: [12] });
  const newYear = session(date(2025, 12, 31, 23, 0), date(2026, 1, 1, 1, 0), 2000);
  assert.equal(sessionCostLabel(newYear, december), 'GBP 0.20');
  // A day later the window no longer applies and the fallback prices the hour.
  const later = session(date(2026, 1, 1, 23, 0), date(2026, 1, 2, 1, 0), 2000);
  assert.equal(sessionCostLabel(later, december), 'GBP 0.60');
});

// ---------- aggregate ----------

test('aggregate cost is hidden exactly when a schedule exists', () => {
  assert.equal(aggregateCostLabel(12.345, FLAT), 'GBP 3.02');
  assert.equal(aggregateCostLabel(12.345, nightly()), null);
  // A single window is enough; it never falls back to a made-up flat total.
  assert.equal(aggregateCostLabel(0, nightly()), null);
  // Zero energy still formats under the flat rate, as before.
  assert.equal(aggregateCostLabel(0, FLAT), 'GBP 0.00');
});
