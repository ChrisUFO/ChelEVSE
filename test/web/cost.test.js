// Cost-presentation helpers: flat parity, schedule selection, interval costing
// and the hidden aggregate. The timezone is pinned before any Date is built, so
// the DST cases only mean something in a zone that observes daylight saving.
process.env.TZ = 'America/Denver';

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCostLabel,
  costSettings,
  liveCostLabel,
  sessionCostLabel,
  statusCostLabel,
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
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 5, 3, 0), nightly(), true), 'GBP 0.10');
  // Same energy outside the window pays the fallback.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 5, 12, 0), nightly(), true), 'GBP 0.30');
  // Straddling the 06:00 boundary: half the hour at each rate.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 5, 6, 30), nightly(), true), 'GBP 0.20');
  // The 22:00–06:00 wrap keeps the early hours of the next day cheap.
  const wrap = nightly({ start: '22:00', end: '06:00' });
  assert.equal(liveCostLabel(1000, 3600, date(2026, 1, 6, 0, 30), wrap, true), 'GBP 0.10');
  // Numeric text from a hand-edited status document parses like a number.
  assert.equal(liveCostLabel('1000', '3600', date(2026, 1, 5, 3, 0), nightly(), true), 'GBP 0.10');
});

test('a schedule hides the live cost when the interval cannot be priced', () => {
  const now = date(2026, 1, 5, 3, 0);
  // No elapsed duration: the fallback would misprice a window that applies now.
  assert.equal(liveCostLabel(1000, null, now, nightly(), true), null);
  assert.equal(liveCostLabel(1000, 0, now, nightly(), true), null);
  assert.equal(liveCostLabel(1000, -60, now, nightly(), true), null);
  assert.equal(liveCostLabel(1000, '', now, nightly(), true), null);
  // No usable clock.
  assert.equal(liveCostLabel(1000, 3600, null, nightly(), true), null);
  assert.equal(liveCostLabel(1000, 3600, Number.NaN, nightly(), true), null);
  // Not charging: the interval would cover idle time that drew no energy.
  assert.equal(liveCostLabel(1000, 3600, now, nightly()), null);
  assert.equal(liveCostLabel(1000, 3600, now, nightly(), false), null);
});

// ---------- live status snapshot ----------

// A status document as Firestore delivers it: `state` is the numeric charge
// state (3 = charging), `state_label` the bridge's derived label and
// `charger_online: false` the bridge's offline marker over a frozen snapshot.
function liveStatus(state, updated, elapsed, wh = 1000, overrides = {}) {
  return {
    state,
    state_label: state === 3 ? 'charging' : 'ready',
    charger_online: true,
    updated_at: updated == null ? undefined : { toMillis: () => updated },
    elapsed,
    session_energy: wh,
    ...overrides,
  };
}

test('live cost ends at the snapshot write, not the render instant', () => {
  // 1 kWh over the hour ending 06:30: half at 0.10, half at the fallback 0.30.
  const at = date(2026, 1, 5, 6, 30).getTime();
  assert.equal(statusCostLabel(liveStatus(3, at, 3600), nightly()), 'GBP 0.20');
  // Whole-hour off-peak interval ending 03:00.
  const offPeak = date(2026, 1, 5, 3, 0).getTime();
  assert.equal(statusCostLabel(liveStatus(3, offPeak, 3600), nightly()), 'GBP 0.10');
});

test('a paused or ready snapshot hides the scheduled live cost', () => {
  const at = date(2026, 1, 5, 3, 0).getTime();
  // Ready / connected / sleeping / disabled / absent state, plus a hand-edited
  // string state that is not 3.
  for (const state of [0, 1, 2, 4, 254, null, undefined, '3.5']) {
    assert.equal(statusCostLabel(liveStatus(state, at, 3600), nightly()), null);
  }
  // The bridge's label is the single source of truth, shared with the session
  // clock and the badge pulse: a charging write prices even when a hand-edited
  // state code disagrees, and a non-charging label hides even with state 3.
  assert.equal(statusCostLabel(liveStatus(3, at, 3600, 1000, { state: 1 }), nightly()), 'GBP 0.10');
  assert.equal(
    statusCostLabel(liveStatus(3, at, 3600, 1000, { state_label: 'ready' }), nightly()),
    null,
  );
  // The flat path ignores the state, exactly as before schedules existed.
  assert.equal(statusCostLabel(liveStatus(1, at, 3600), FLAT), 'GBP 0.25');
});

test('an offline snapshot hides the scheduled live cost', () => {
  // Charging since 05:15, 1 kWh, elapsed frozen at 1800 s when the charger went
  // unreachable. The bridge keeps writing offline markers: a fresh `updated_at`
  // over the frozen state/elapsed. Priced at 07:00 that would be the fallback
  // window for 06:30–07:00 — GBP 0.30 for energy that was drawn off-peak.
  const frozen = date(2026, 1, 5, 5, 45).getTime();
  const marker = date(2026, 1, 5, 7, 0).getTime();
  assert.equal(statusCostLabel(liveStatus(3, frozen, 1800), nightly()), 'GBP 0.10');
  assert.equal(statusCostLabel(liveStatus(3, marker, 1800), nightly()), 'GBP 0.30');
  // Under the offline banner the figure is hidden, however fresh the marker is.
  assert.equal(
    statusCostLabel(liveStatus(3, marker, 1800, 1000, { charger_online: false }), nightly()),
    null,
  );
  assert.equal(
    statusCostLabel(liveStatus(3, frozen, 1800, 1000, { charger_online: false }), nightly()),
    null,
  );
  // Flat configs keep pricing the last known energy under the same banner.
  assert.equal(
    statusCostLabel(liveStatus(3, marker, 1800, 1000, { charger_online: false }), FLAT),
    'GBP 0.25',
  );
  // An absent flag (older document) is not offline; the clock gate agrees.
  assert.equal(
    statusCostLabel(liveStatus(3, marker, 1800, 1000, { charger_online: null }), nightly()),
    'GBP 0.30',
  );
});
test('a missing write time or elapsed hides the scheduled cost', () => {
  const at = date(2026, 1, 5, 3, 0).getTime();
  assert.equal(statusCostLabel(liveStatus(3, null, 3600), nightly()), null);
  assert.equal(statusCostLabel(liveStatus(3, at, null), nightly()), null);
  assert.equal(statusCostLabel(null, nightly()), null);
  // Flat keeps today's behaviour without either.
  assert.equal(statusCostLabel(liveStatus(3, null, null), FLAT), 'GBP 0.25');
});

test('a stale cached snapshot does not slide with the wall clock', () => {
  // 2 h old but still reported as charging: the interval is the charging hour
  // that ended at the write (05:30–06:30), so it straddles the boundary. Move the
  // clock forward and the figure must not re-price to the current hour.
  const at = date(2026, 1, 5, 6, 30).getTime();
  mock.timers.enable({ apis: ['Date'], now: at });
  try {
    const status = liveStatus(3, at, 3600);
    assert.equal(statusCostLabel(status, nightly()), 'GBP 0.20');
    mock.timers.setTime(at + 2 * HOUR_MS);
    assert.equal(statusCostLabel(status, nightly()), 'GBP 0.20');
  } finally {
    mock.timers.reset();
  }
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

test('a date-season rate prices the edge days, and a season rate every hour', () => {
  const summer = {
    rate: 0.3,
    currency: 'GBP',
    rates: [
      {
        id: 'summer',
        rate: 0.2,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: [6, 7, 8, 9],
        from: '06-15',
        to: '09-15',
      },
    ],
  };
  // The day before the season pays the fallback; the first day pays the season.
  assert.equal(
    sessionCostLabel(session(date(2026, 6, 14, 12, 0), date(2026, 6, 14, 13, 0), 1000), summer),
    'GBP 0.30',
  );
  assert.equal(
    sessionCostLabel(session(date(2026, 6, 15, 12, 0), date(2026, 6, 15, 13, 0), 1000), summer),
    'GBP 0.20',
  );
  // 15 September 23:00 → 16 September 01:00 pro-rates across the edge.
  assert.equal(
    sessionCostLabel(session(date(2026, 9, 15, 23, 0), date(2026, 9, 16, 1, 0), 2000), summer),
    'GBP 0.50',
  );
  // The season rate prices any hour, live included.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 7, 1, 3, 0), summer, true), 'GBP 0.20');
  assert.equal(liveCostLabel(1000, 3600, date(2026, 6, 14, 3, 0), summer, true), 'GBP 0.30');
});
