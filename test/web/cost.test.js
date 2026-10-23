// Cost-presentation helpers: flat parity, schedule selection, interval costing
// and the hidden aggregate. The timezone is pinned before any Date is built, so
// the DST cases only mean something in a zone that observes daylight saving.
process.env.TZ = 'America/Denver';

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptedAnchor,
  aggregateCostLabel,
  costSettings,
  heldAnchorAfter,
  heldCostLabel,
  heldCostUncovered,
  hourCost,
  liveCostLabel,
  liveSessionContribution,
  liveSessionSettled,
  liveSessionSpan,
  sessionBucketCost,
  sessionCostLabel,
  sessionCostSpans,
  sessionIntervalsValid,
  statusCostLabel,
  statusCostUncovered,
} from '../../web/js/cost.js';
import { costForIntervals, costForSession } from '../../web/js/rates.js';
import { fmtCost, fmtMoney } from '../../web/js/format.js';

const HOUR_MS = 60 * 60 * 1000;

// Month is 1-based here so the fixtures read like the stored documents.
function date(year, month, day, hours = 0, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes);
}

const FLAT = { rate: 0.245, currency: 'GBP' };

// A nightly off-peak window (00:00–06:00) at 0.10 over a visible all-day base
// at 0.30. The stored rate is no longer an invisible fallback.
function nightly(overrides = {}) {
  return {
    rate: 0.3,
    currency: 'GBP',
    rates: [
      {
        id: 'base',
        rate: 0.3,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: null,
      },
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

// A base-less season: the window prices 16:00–19:00 and every other hour of the
// day prices 0.00, which is the slice the live marker reports.
function windowOnly(overrides = {}) {
  return {
    rate: 0.3,
    currency: 'GBP',
    rates: [
      {
        id: 'peak',
        rate: 0.32,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '16:00',
        end: '19:00',
        months: null,
        ...overrides,
      },
    ],
  };
}

test('the live "understates cost" marker follows the interval it describes', () => {
  const inWindow = date(2026, 1, 5, 17, 0).getTime();
  const outside = date(2026, 1, 5, 12, 0).getTime();
  // A plan with a base prices every slice of the interval.
  assert.equal(statusCostUncovered(liveStatus(3, inWindow, 3600), nightly()), false);
  // A base-less window prices only its own hours.
  assert.equal(statusCostUncovered(liveStatus(3, inWindow, 3600), windowOnly()), false);
  assert.equal(statusCostUncovered(liveStatus(3, outside, 3600), windowOnly()), true);
  // An interval that straddles the window edge includes an unpriced slice, and
  // the figure it caveats is still shown: the marker never stands alone.
  const straddle = date(2026, 1, 5, 16, 30).getTime();
  assert.equal(statusCostUncovered(liveStatus(3, straddle, 3600), windowOnly()), true);
  assert.notEqual(statusCostLabel(liveStatus(3, straddle, 3600), windowOnly()), null);
  // The marker shares the cost's gate: nothing to caveat when the figure is
  // hidden (not charging, missing write time or elapsed, flat config).
  for (const status of [
    liveStatus(1, outside, 3600),
    liveStatus(3, null, 3600),
    liveStatus(3, outside, null),
    liveStatus(3, outside, 0),
    liveStatus(3, outside, -60),
    liveStatus(3, outside, 3600, 1000, { charger_online: false }),
  ]) {
    assert.equal(statusCostUncovered(status, windowOnly()), false);
  }
  assert.equal(statusCostUncovered(liveStatus(3, outside, 3600), FLAT), false);
  assert.equal(statusCostUncovered(null, windowOnly()), false);
});

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

// ---------- held session (plugged in, not charging) ----------

test('a held session prices the frozen window, not the current clock', () => {
  // 1 kWh charged 05:30–06:30 (elapsed 3600); the charging write was stamped
  // 06:30. Hours later the frozen figure is still that straddled half-and-half
  // window — the live figure at the moment charging stopped.
  const anchor = date(2026, 1, 5, 6, 30).getTime();
  assert.equal(heldCostLabel(1000, 3600, anchor, nightly()), 'GBP 0.20');
  // The same energy priced at a *later* anchor would be the 0.30 fallback, so
  // the assertion above really is the frozen window.
  assert.equal(heldCostLabel(1000, 3600, anchor + 6 * HOUR_MS, nightly()), 'GBP 0.30');
  // The whole window off-peak prices as the live figure did.
  assert.equal(heldCostLabel(1000, 3600, date(2026, 1, 5, 3, 0).getTime(), nightly()), 'GBP 0.10');
  // A frozen anchor with the *stopped* write's elapsed (pause time added)
  // would stretch the window past the plug-in's start and dilute the figure —
  // which is why the anchor carries the charging write's own elapsed.
  assert.equal(heldCostLabel(1000, 3 * 3600, anchor, nightly()), 'GBP 0.13');
});

test('a held session hides when elapsed or anchor is unusable', () => {
  const anchor = date(2026, 1, 5, 6, 30).getTime();
  // The same degenerate inputs liveCostLabel hides on.
  for (const elapsed of [null, undefined, 0, -60, '', 'x', Number.NaN]) {
    assert.equal(heldCostLabel(1000, elapsed, anchor, nightly()), null, String(elapsed));
  }
  for (const ms of [null, undefined, Number.NaN, Infinity]) {
    assert.equal(heldCostLabel(1000, 3600, ms, nightly()), null, String(ms));
  }
  // Unusable energy hides exactly like the live path.
  assert.equal(heldCostLabel(null, 3600, anchor, nightly()), null);
  assert.equal(heldCostLabel('', 3600, anchor, nightly()), null);
});

test('held flat output is byte-identical to the live and fmtCost paths', () => {
  const now = date(2026, 1, 5, 12, 0);
  // The anchor and elapsed are irrelevant without a schedule, including when
  // missing: energy x rate is the whole figure.
  assert.equal(heldCostLabel(12345, 3600, now.getTime(), FLAT), 'GBP 3.02');
  assert.equal(heldCostLabel(12345, null, null, FLAT), 'GBP 3.02');
  assert.equal(heldCostLabel(12345, null, null, FLAT), fmtCost(12.345, 0.245, 'GBP'));
  assert.equal(heldCostLabel(12345, null, null, FLAT), liveCostLabel(12345, null, now, FLAT));
  assert.equal(heldCostLabel(1000, 3600, null, { ...FLAT, rates: [] }), 'GBP 0.25');
  assert.equal(heldCostLabel(null, 3600, now.getTime(), FLAT), null);
});

test('the held marker follows the frozen interval', () => {
  const noon = date(2026, 1, 5, 12, 0).getTime();
  const peak = date(2026, 1, 5, 17, 0).getTime();
  const edge = date(2026, 1, 5, 16, 30).getTime();
  // A base-less window prices only its own hours; the frozen window decides.
  assert.equal(heldCostUncovered(3600, noon, windowOnly()), true);
  assert.equal(heldCostUncovered(3600, peak, windowOnly()), false);
  assert.equal(heldCostUncovered(3600, edge, windowOnly()), true);
  assert.notEqual(heldCostLabel(1000, 3600, edge, windowOnly()), null);
  // A schedule with a base covers every slice.
  assert.equal(heldCostUncovered(3600, noon, nightly()), false);
  // Flat configs and degenerate inputs never carry the marker.
  assert.equal(heldCostUncovered(3600, noon, FLAT), false);
  for (const elapsed of [null, 0, -60]) {
    assert.equal(heldCostUncovered(elapsed, noon, windowOnly()), false, String(elapsed));
  }
  assert.equal(heldCostUncovered(3600, null, windowOnly()), false);
});

test('heldAnchorAfter captures, holds, clears and re-anchors', () => {
  const t0 = date(2026, 1, 5, 6, 30).getTime();
  const charging = liveStatus(3, t0, 3600);
  const anchor = heldAnchorAfter(null, charging);
  assert.deepEqual(anchor, { ms: t0, elapsed: 3600 });
  // A live charging write re-anchors on every write, including a document
  // refreshed in place (same stamp, newer elapsed).
  const refreshed = liveStatus(3, t0, 4200);
  assert.deepEqual(heldAnchorAfter(anchor, refreshed), { ms: t0, elapsed: 4200 });
  const later = liveStatus(3, t0 + 60000, 4300);
  const laterAnchor = heldAnchorAfter(anchor, later);
  assert.deepEqual(laterAnchor, { ms: t0 + 60000, elapsed: 4300 });
  // A late, older charging write must not rewind the anchor.
  assert.deepEqual(heldAnchorAfter(laterAnchor, charging), laterAnchor);
  // Charging stops with energy on the meter: the anchor holds, and a newer
  // stopped write (pause time counted into elapsed) does not move it.
  const stopped = liveStatus(2, t0 + 2 * HOUR_MS, 3 * 3600);
  assert.equal(heldAnchorAfter(laterAnchor, stopped), laterAnchor);
  const hoursLater = liveStatus(2, t0 + 6 * HOUR_MS, 7 * 3600);
  assert.equal(heldAnchorAfter(laterAnchor, hoursLater), laterAnchor);
  // The bridge's offline marker keeps the charging label but is not live.
  const offline = liveStatus(3, t0 + 6 * HOUR_MS, 4300, 1000, { charger_online: false });
  assert.equal(heldAnchorAfter(laterAnchor, offline), laterAnchor);
  // A session reset clears it, and so does absent/unusable energy. (`undefined`
  // energy is the same toNumber path as null; the fixture's default hides it.)
  const reset = liveStatus(2, t0 + 6 * HOUR_MS, 0, 0);
  assert.equal(heldAnchorAfter(laterAnchor, reset), null);
  for (const wh of [null, 0, -1, 'x', ' ']) {
    assert.equal(heldAnchorAfter(laterAnchor, liveStatus(2, t0, 3600, wh)), null, String(wh));
  }
  // A new charge re-anchors from its own write.
  const again = liveStatus(3, t0 + 12 * HOUR_MS, 600);
  assert.deepEqual(heldAnchorAfter(null, again), { ms: t0 + 12 * HOUR_MS, elapsed: 600 });
  // A charging write without a usable timestamp anchors nothing, and there is
  // no anchor without a document.
  assert.equal(heldAnchorAfter(laterAnchor, liveStatus(3, null, 3600)), null);
  assert.equal(heldAnchorAfter(laterAnchor, null), null);
});

// ---------- cold-open adoption (the bridge's stop stamp) ----------

// The stamp fixture: a Firestore Timestamp surface over a fixed instant.
function stampAt(ms) {
  return { toMillis: () => ms };
}

test('adoptedAnchor reconstructs the stop pair from a stamped snapshot', () => {
  // Charge complete 06:30, still plugged in; the page opens at 08:30 to a
  // write whose elapsed has grown with the pause. The anchor takes the
  // stamp as its ms and the snapshot's own elapsed — the pairing the
  // pair-freeze pricer expects.
  const stop = date(2026, 1, 5, 6, 30).getTime();
  const later = liveStatus(2, date(2026, 1, 5, 8, 30).getTime(), 3 * 3600, 1000, {
    charging_stopped_at: stampAt(stop),
  });
  assert.deepEqual(adoptedAnchor(later), { ms: stop, elapsed: 3 * 3600 });
  // The reconstructed anchor prices through the same held pricer, and its
  // figure freezes exactly like a captured one (the single-span
  // approximation: pause time folds into the pro-rated window).
  assert.equal(heldCostLabel(1000, 3 * 3600, stop, nightly()), 'GBP 0.13');
});

test('adoptedAnchor hides without a usable stamp or usable energy', () => {
  const t = date(2026, 1, 5, 8, 30).getTime();
  const stopped = (overrides) => liveStatus(2, t, 3600, 1000, overrides);
  // Absent (an older or pre-deploy bridge) or malformed stamps never adopt.
  for (const malformed of [undefined, null, 0, 'x', {}, { toMillis: null }, { toMillis: 'x' }]) {
    assert.equal(
      adoptedAnchor(stopped({ charging_stopped_at: malformed })),
      null,
      String(malformed),
    );
  }
  // A stamp that resolves to nothing is as good as absent.
  assert.equal(adoptedAnchor(stopped({ charging_stopped_at: stampAt(null) })), null);
  // The live path governs a charging snapshot regardless of the field.
  assert.equal(
    adoptedAnchor(liveStatus(3, t, 3600, 1000, { charging_stopped_at: stampAt(t) })),
    null,
  );
  // The bridge's offline marker over a stopped session is not live: the
  // frozen figure still adopts (parity with the held machine's hold).
  assert.notEqual(
    adoptedAnchor(stopped({ charger_online: false, charging_stopped_at: stampAt(t) })),
    null,
  );
  // No energy on the meter: nothing to price, captured or adopted.
  for (const wh of [0, null, -1, 'x', ' ']) {
    assert.equal(
      adoptedAnchor(stopped({ charging_stopped_at: stampAt(t), session_energy: wh })),
      null,
      String(wh),
    );
  }
  assert.equal(adoptedAnchor(null), null);
});

test('a captured anchor outranks the stamp, and adoption never re-adopts', () => {
  // The screen's exact wiring: the held machine first, adoption only for
  // the null it leaves. Precedence must be explicit — the figures agree by
  // construction when both saw the same stop, but a stale anchor must not
  // be rebuilt from whatever stamp a later poll carries.
  const screen = (prev, status) => heldAnchorAfter(prev, status) ?? adoptedAnchor(status);
  const t0 = date(2026, 1, 5, 6, 30).getTime();
  const captured = heldAnchorAfter(null, liveStatus(3, t0, 3600));
  const stop = liveStatus(2, t0 + 2 * HOUR_MS, 3 * 3600, 1000, {
    charging_stopped_at: stampAt(t0),
  });
  // The page-open path keeps its captured anchor, stamp or no stamp.
  assert.equal(screen(captured, stop), captured);
  // The cold open adopts once; later polls — even a *newer* stamp — hold it.
  const adopted = screen(null, stop);
  assert.deepEqual(adopted, { ms: t0, elapsed: 3 * 3600 });
  const later = liveStatus(2, t0 + 6 * HOUR_MS, 7 * 3600, 1000, {
    charging_stopped_at: stampAt(t0 + 6 * HOUR_MS),
  });
  assert.equal(screen(adopted, later), adopted);
  // The session reset clears it, and only a fresh snapshot can re-adopt.
  const reset = liveStatus(2, t0 + 6 * HOUR_MS, 0, 0);
  assert.equal(screen(adopted, reset), null);
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

// ---------- charging intervals ----------

// A paused plug-in: an evening peak hour, an idle night, then an off-peak top-up.
// Aggregate: 18:00 → 06:00 over 5 kWh, so uniform pro-rating spreads the energy
// across the idle hours — half of it into a cheap window it was never drawn in —
// and understates the true cost.
function pausedSession(overrides = {}) {
  return {
    wh: 5000,
    elapsed: 12 * 3600,
    started_at: date(2026, 1, 5, 18, 0),
    ended_at: date(2026, 1, 6, 6, 0),
    intervals: [
      {
        started_at: date(2026, 1, 5, 18, 0),
        ended_at: date(2026, 1, 5, 19, 0),
        wh: 3000,
      },
      {
        started_at: date(2026, 1, 6, 3, 0),
        ended_at: date(2026, 1, 6, 4, 0),
        wh: 2000,
      },
    ],
    ...overrides,
  };
}

test('a paused session is priced per interval, not pro-rated over the plug-in', () => {
  const item = pausedSession();
  // 3 kWh at the 0.30 fallback plus 2 kWh in the 0.10 window.
  assert.equal(sessionCostLabel(item, nightly()), 'GBP 1.10');
  // The aggregate path is what the same document costs without intervals: 2.5
  // kWh at each rate, which is 0.10 less because the peak hour carried most of
  // the energy. The two figures must not agree, or the fixture proves nothing.
  const legacy = { ...item };
  delete legacy.intervals;
  assert.equal(sessionCostLabel(legacy, nightly()), 'GBP 1.00');
  // Flat configs ignore intervals entirely, as before.
  assert.equal(sessionCostLabel(item, FLAT), 'GBP 1.23');
});

test('a single interval prices exactly like the aggregate path', () => {
  const aggregate = session(date(2026, 1, 5, 5, 0), date(2026, 1, 5, 7, 0), 4000);
  const withInterval = {
    ...aggregate,
    intervals: [{ started_at: aggregate.started_at, ended_at: aggregate.ended_at, wh: 4000 }],
  };
  assert.equal(sessionCostLabel(withInterval, nightly()), sessionCostLabel(aggregate, nightly()));
  assert.equal(sessionCostLabel(withInterval, nightly()), 'GBP 0.80');
});

test('absent, empty or malformed intervals fall back byte-identically', () => {
  const item = session(date(2026, 1, 5, 5, 0), date(2026, 1, 5, 7, 0), 4000);
  const expected = sessionCostLabel(item, nightly());
  const malformed = [
    [],
    null,
    'intervals',
    42,
    {},
    [null],
    [{}],
    [{ started_at: item.started_at, ended_at: item.ended_at }],
    [{ started_at: item.started_at, ended_at: item.ended_at, wh: 0 }],
    [{ started_at: item.started_at, ended_at: item.ended_at, wh: -1 }],
    [{ started_at: item.started_at, ended_at: item.ended_at, wh: 'x' }],
    [{ started_at: null, ended_at: item.ended_at, wh: 1000 }],
    [{ started_at: item.ended_at, ended_at: item.started_at, wh: 1000 }],
    // One good interval does not rescue a bad one: the list is unusable.
    [
      { started_at: item.started_at, ended_at: item.ended_at, wh: 4000 },
      { started_at: item.started_at, ended_at: item.started_at, wh: 10 },
    ],
  ];
  for (const intervals of malformed) {
    assert.equal(
      sessionCostLabel({ ...item, intervals }, nightly()),
      expected,
      JSON.stringify(intervals),
    );
  }
});

test('sessionIntervalsValid is the fallback rule on its own', () => {
  const start = date(2026, 1, 5, 5, 0);
  const end = date(2026, 1, 5, 6, 0);
  const one = (wh) => [{ started_at: start, ended_at: end, wh }];
  // Shape and the energy agreement, together.
  assert.equal(sessionIntervalsValid(one(1000), 1000), true);
  assert.equal(sessionIntervalsValid(one(1000), 1125), true, 'inside the floor');
  assert.equal(sessionIntervalsValid(one(1000), 1250), true, 'exactly the 250 Wh floor');
  assert.equal(sessionIntervalsValid(one(1000), 1251), false, 'one Wh past the floor');
  assert.equal(sessionIntervalsValid(one(1000), 750), true, 'exactly the floor, short');
  assert.equal(sessionIntervalsValid(one(1000), 749), false, 'one Wh past it, short');
  // 2% takes over on a big session: 20 kWh tolerates 400 Wh.
  assert.equal(sessionIntervalsValid(one(20400), 20000), true, 'exactly 2%');
  assert.equal(sessionIntervalsValid(one(20401), 20000), false, 'over by one Wh');
  assert.equal(sessionIntervalsValid(one(19600), 20000), true, 'exactly 2%, short');
  assert.equal(sessionIntervalsValid(one(19599), 20000), false, 'short by one Wh');
  // The PR's own two divergence shapes are far outside it.
  assert.equal(sessionIntervalsValid(one(2000), 6000), false, 'restart orphan');
  assert.equal(sessionIntervalsValid(one(2800), 900), false, 'reset overshoot');
  // An unusable aggregate cannot reconcile: the legacy path decides.
  for (const wh of [undefined, null, 0, -1000, 'x', ' ', true, Number.NaN]) {
    assert.equal(sessionIntervalsValid(one(1000), wh), false, String(wh));
  }
  // Shape alone still rejects.
  assert.equal(sessionIntervalsValid([], 0), false);
  assert.equal(sessionIntervalsValid(undefined, 0), false);
  assert.equal(sessionIntervalsValid(null, 0), false);
  assert.equal(sessionIntervalsValid('x', 0), false);
  assert.equal(sessionIntervalsValid(one(0), 0), false);
  assert.equal(
    sessionIntervalsValid([{ started_at: start, ended_at: end, wh: 0 }], 0),
    false,
    'zero-wh interval',
  );
  assert.equal(
    sessionIntervalsValid(
      [
        { started_at: start, ended_at: end, wh: 1000 },
        { started_at: end, ended_at: end, wh: 0 },
      ],
      1000,
    ),
    false,
    'one bad entry',
  );
});

test('a restart-orphaned interval list prices by the fallback', () => {
  // Mid-charge bridge restart: the seeded baseline keeps the 4 kWh drawn before
  // it out of the only interval, while the aggregate covers the whole plug-in.
  const orphan = {
    wh: 6000,
    elapsed: 5400,
    started_at: date(2026, 1, 5, 1, 0),
    ended_at: date(2026, 1, 5, 2, 30),
    intervals: [
      { started_at: date(2026, 1, 5, 2, 0), ended_at: date(2026, 1, 5, 2, 30), wh: 2000 },
    ],
  };
  const legacy = { ...orphan, intervals: undefined };
  // 6 kWh off-peak, not the 2 kWh the interval alone accounts for.
  assert.equal(sessionCostLabel(orphan, nightly()), 'GBP 0.60');
  assert.equal(sessionCostLabel(orphan, nightly()), sessionCostLabel(legacy, nightly()));
});

test('a counter-reset overshoot prices by the fallback', () => {
  // 2.8 kWh of intervals against a 0.9 kWh aggregate: the reset made the list
  // exceed the session, the mirror image of the restart case.
  const overshoot = {
    wh: 900,
    elapsed: 1800,
    started_at: date(2026, 1, 5, 12, 0),
    ended_at: date(2026, 1, 5, 12, 30),
    intervals: [
      { started_at: date(2026, 1, 5, 12, 0), ended_at: date(2026, 1, 5, 12, 30), wh: 2800 },
    ],
  };
  const legacy = { ...overshoot, intervals: undefined };
  assert.equal(sessionCostLabel(overshoot, nightly()), 'GBP 0.27');
  assert.equal(sessionCostLabel(overshoot, nightly()), sessionCostLabel(legacy, nightly()));
});

test('the energy tolerance is inclusive on both sides and a fallback beyond it', () => {
  // 20 kWh aggregate: the 2% band is 400 Wh, and the interval span (03:00–05:00)
  // prices differently from the aggregate span (03:00–07:00), so the two paths
  // are distinguishable by their figure.
  const session20 = (sum) => {
    const first = Math.floor(sum / 2);
    return {
      wh: 20000,
      elapsed: 4 * 3600,
      started_at: date(2026, 1, 5, 3, 0),
      ended_at: date(2026, 1, 5, 7, 0),
      intervals: [
        {
          started_at: date(2026, 1, 5, 3, 0),
          ended_at: date(2026, 1, 5, 4, 0),
          wh: first,
        },
        {
          started_at: date(2026, 1, 5, 4, 0),
          ended_at: date(2026, 1, 5, 5, 0),
          wh: sum - first,
        },
      ],
    };
  };
  assert.equal(sessionCostLabel(session20(20400), nightly()), 'GBP 2.04', 'over, at 2%');
  assert.equal(sessionCostLabel(session20(20401), nightly()), 'GBP 3.00', 'over, past 2%');
  assert.equal(sessionCostLabel(session20(19600), nightly()), 'GBP 1.96', 'short, at 2%');
  assert.equal(sessionCostLabel(session20(19599), nightly()), 'GBP 3.00', 'short, past 2%');
});

test('a tiny session one poll short still prices per interval', () => {
  // 0.2 kWh over four hours, its only interval a single 32 Wh poll short
  // (11.5 kW for 10 s): inside the 250 Wh floor, so the interval figure stands.
  const tiny = {
    wh: 200,
    elapsed: 4 * 3600,
    started_at: date(2026, 1, 5, 3, 0),
    ended_at: date(2026, 1, 5, 7, 0),
    intervals: [{ started_at: date(2026, 1, 5, 3, 0), ended_at: date(2026, 1, 5, 3, 10), wh: 168 }],
  };
  assert.equal(sessionCostLabel(tiny, nightly()), 'GBP 0.02');
  // The pro-rated aggregate would read 0.03 — the figures differ, so the
  // assertion above really is the interval path.
  assert.equal(sessionCostLabel({ ...tiny, intervals: undefined }, nightly()), 'GBP 0.03');
});

test('a folded head prices as a span and the rest per interval', () => {
  // Past the 100-interval cap the oldest blocks fold into one head whose span
  // covers idle time. That head is energy-preserving, so the list still
  // reconciles with `wh` and prices per interval, with only the head pro-rated.
  const folded = {
    wh: 8000,
    elapsed: 8 * 3600,
    started_at: date(2026, 1, 5, 0, 0),
    ended_at: date(2026, 1, 5, 8, 0),
    intervals: [
      { started_at: date(2026, 1, 5, 0, 0), ended_at: date(2026, 1, 5, 3, 0), wh: 3000 },
      { started_at: date(2026, 1, 5, 3, 0), ended_at: date(2026, 1, 5, 4, 0), wh: 2000 },
      { started_at: date(2026, 1, 5, 7, 0), ended_at: date(2026, 1, 5, 8, 0), wh: 3000 },
    ],
  };
  // 3 kWh + 2 kWh off-peak, 3 kWh at the 0.30 fallback.
  assert.equal(sessionCostLabel(folded, nightly()), 'GBP 1.40');
  // The pro-rated aggregate would read 1.20, so this is really the interval path.
  assert.equal(sessionCostLabel({ ...folded, intervals: undefined }, nightly()), 'GBP 1.20');
});

test('an unusable aggregate keeps the legacy path, intervals or not', () => {
  const start = date(2026, 1, 5, 5, 0);
  const end = date(2026, 1, 5, 7, 0);
  const intervals = [{ started_at: start, ended_at: end, wh: 4000 }];
  for (const wh of [undefined, null, 'x', -1]) {
    assert.equal(
      sessionCostLabel({ wh, started_at: start, ended_at: end, intervals }, nightly()),
      sessionCostLabel({ wh, started_at: start, ended_at: end }, nightly()),
      String(wh),
    );
  }
  // A zero aggregate is a real number: the legacy path prices it at 0.00.
  assert.equal(
    sessionCostLabel({ wh: 0, started_at: start, ended_at: end, intervals }, nightly()),
    'GBP 0.00',
  );
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
  // The day before the season is outside every season and costs 0; the first
  // day pays the season.
  assert.equal(
    sessionCostLabel(session(date(2026, 6, 14, 12, 0), date(2026, 6, 14, 13, 0), 1000), summer),
    'GBP 0.00',
  );
  assert.equal(
    sessionCostLabel(session(date(2026, 6, 15, 12, 0), date(2026, 6, 15, 13, 0), 1000), summer),
    'GBP 0.20',
  );
  // 15 September 23:00 → 16 September 01:00 pro-rates across the edge into
  // the uncovered 0.00 hour.
  assert.equal(
    sessionCostLabel(session(date(2026, 9, 15, 23, 0), date(2026, 9, 16, 1, 0), 2000), summer),
    'GBP 0.20',
  );
  // The season rate prices any hour, live included.
  assert.equal(liveCostLabel(1000, 3600, date(2026, 7, 1, 3, 0), summer, true), 'GBP 0.20');
  assert.equal(liveCostLabel(1000, 3600, date(2026, 6, 14, 3, 0), summer, true), 'GBP 0.00');
});

// ---------- schedule-priced hour buckets (the Day period's bars) ----------

test('hourCost prices one bucket over its own wall-clock hour', () => {
  const settings = nightly();
  // The 06:00 boundary sits between buckets: 05 is window, 06 is not.
  assert.ok(Math.abs(hourCost('2026-01-05', '05', 1, settings) - 0.1) < 1e-9);
  assert.ok(Math.abs(hourCost('2026-01-05', '06', 1, settings) - 0.3) < 1e-9);
  // A window boundary inside one hour splits the bucket: 05:30–06:30 at 0.10
  // leaves hour 05 half window, half fallback.
  const straddle = nightly({ start: '05:30', end: '06:30' });
  assert.ok(Math.abs(hourCost('2026-01-05', '05', 1, straddle) - 0.2) < 1e-9);
  // Hour ids reach here as the series points' zero-padded strings; a bare
  // number is accepted for direct use, anything else is unusable.
  assert.ok(Math.abs(hourCost('2026-01-05', 5, 1, settings) - 0.1) < 1e-9);
  assert.equal(hourCost('2026-01-05', '24', 1, settings), null);
  assert.equal(hourCost('2026-01-05', 'nope', 1, settings), null);
  assert.equal(hourCost('2026-01-05', '05', 'nope', settings), null);
  assert.equal(hourCost('2026-01-05', '05', -1, settings), null);
  assert.equal(hourCost('2026-02-31', '05', 1, settings), null);
  assert.equal(hourCost('nope', '05', 1, settings), null);
});

test('hour buckets price season edges and the new-year tail from the day id', () => {
  // A date-scoped season: all-day 0.20 from 15 June to 15 September only.
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
  assert.ok(Math.abs(hourCost('2026-06-15', '12', 1, summer) - 0.2) < 1e-9);
  // The day before the season is outside every season: 0.00, not hidden.
  assert.equal(hourCost('2026-06-14', '12', 1, summer), 0);
  // A December-only 22:00–06:00 window covers the early hours of 1 January
  // (the tail of the window that started on 31 December), as any interval.
  const december = nightly({ start: '22:00', end: '06:00', months: [12] });
  assert.ok(Math.abs(hourCost('2026-01-01', '01', 1, december) - 0.1) < 1e-9);
  assert.ok(Math.abs(hourCost('2026-01-01', '12', 1, december) - 0.3) < 1e-9);
});

test('hours no base or window covers price 0.00 (the plan-banner rule)', () => {
  // windowOnly prices 16:00–19:00 and nothing else: noon is 0.00, 17:00 pays.
  const cost = hourCost('2026-01-05', '12', 1, windowOnly());
  assert.ok(Math.abs(cost - 0) < 1e-9);
  assert.ok(Math.abs(hourCost('2026-01-05', '17', 1, windowOnly()) - 0.32) < 1e-9);
  // A zero-energy hour prices 0.00 rather than hiding.
  assert.equal(hourCost('2026-01-05', '12', 0, windowOnly()), 0);
});

// ---------- session-attributed period pricing (#123) ----------

test('sessionCostSpans returns the intervals, the span, or nothing', () => {
  // A reconciling intervals list is the intervals themselves, wh as numbers.
  const paused = pausedSession();
  assert.deepEqual(sessionCostSpans(paused), paused.intervals);
  // A single interval that reconciles is the span with interval precision.
  const single = session(date(2026, 1, 5, 5, 0), date(2026, 1, 5, 7, 0), 4000);
  const withInterval = {
    ...single,
    intervals: [{ started_at: single.started_at, ended_at: single.ended_at, wh: 4000 }],
  };
  assert.deepEqual(sessionCostSpans(withInterval), [
    { started_at: single.started_at, ended_at: single.ended_at, wh: 4000 },
  ]);
  // Absent, empty, malformed or divergent intervals fall back to the span.
  for (const intervals of [undefined, null, [], 'x', [null], [{ started_at: single.started_at }]]) {
    assert.deepEqual(
      sessionCostSpans({ ...single, intervals }),
      [{ started_at: single.started_at, ended_at: single.ended_at, wh: 4000 }],
      JSON.stringify(intervals),
    );
  }
  // The restart orphan prices by its span, like its label.
  const orphan = {
    wh: 6000,
    started_at: date(2026, 1, 5, 1, 0),
    ended_at: date(2026, 1, 5, 2, 30),
    intervals: [
      { started_at: date(2026, 1, 5, 2, 0), ended_at: date(2026, 1, 5, 2, 30), wh: 2000 },
    ],
  };
  assert.deepEqual(sessionCostSpans(orphan), [
    { started_at: orphan.started_at, ended_at: orphan.ended_at, wh: 6000 },
  ]);
  // A zero-energy session is a real span (a 0.00); unusable wh or endpoints
  // price nothing, exactly like the label's null rules.
  const zero = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 0);
  assert.deepEqual(sessionCostSpans(zero), [
    { started_at: zero.started_at, ended_at: zero.ended_at, wh: 0 },
  ]);
  for (const bad of [
    null,
    'x',
    {},
    { wh: 1000 },
    session(date(2026, 1, 5, 2, 0), date(2026, 1, 5, 1, 0), 2000),
    { ...zero, wh: 'x' },
    { ...zero, wh: -1 },
  ]) {
    assert.equal(sessionCostSpans(bad), null, JSON.stringify(bad));
  }
});

test('a session attributes its exact intervals across local midnights', () => {
  const item = pausedSession();
  // 3 kWh in the 18:00–19:00 peak on 5 January, 2 kWh in the 03:00–04:00
  // off-peak block on 6 January — each day prices its own block.
  const fifth = sessionBucketCost([item], '2026-01-05', 3, nightly());
  assert.ok(Math.abs(fifth.cost - 0.9) < 1e-9);
  assert.ok(Math.abs(fifth.wh - 3000) < 1e-9);
  assert.equal(fifth.covered, true);
  const sixth = sessionBucketCost([item], '2026-01-06', 2, nightly());
  assert.ok(Math.abs(sixth.cost - 0.2) < 1e-9);
  assert.ok(Math.abs(sixth.wh - 2000) < 1e-9);
  assert.equal(sixth.covered, true);
  // The reconciliation the period summary leans on: the two days sum to
  // exactly the session's own label figure.
  assert.ok(Math.abs(fifth.cost + sixth.cost - costForIntervals(item.intervals, nightly())) < 1e-9);
});

test('an interval-less session pro-rates its span across the midnight it spans', () => {
  // 22:00→02:00, 4 kWh uniformly: half into each side of local midnight, at
  // the rate each side's window prices — the sessions-list approximation,
  // applied per day.
  const overnight = session(date(2026, 1, 5, 22, 0), date(2026, 1, 6, 2, 0), 4000);
  const fifth = sessionBucketCost([overnight], '2026-01-05', 2, nightly());
  assert.ok(Math.abs(fifth.cost - 0.6) < 1e-9);
  assert.ok(Math.abs(fifth.wh - 2000) < 1e-9);
  const sixth = sessionBucketCost([overnight], '2026-01-06', 2, nightly());
  assert.ok(Math.abs(sixth.cost - 0.2) < 1e-9);
  assert.ok(Math.abs(sixth.wh - 2000) < 1e-9);
  // And the two days reconcile with the span-priced label figure.
  assert.ok(Math.abs(fifth.cost + sixth.cost - costForSession(overnight, nightly())) < 1e-9);
});

test('a session straddling the range edges attributes only its in-range energy', () => {
  // Started the evening before the range's first day: the range's buckets see
  // only the energy after local midnight, and the rest is not the range's.
  const straddler = session(date(2026, 1, 4, 22, 0), date(2026, 1, 5, 2, 0), 4000);
  const inside = sessionBucketCost([straddler], '2026-01-05', 2, nightly());
  assert.ok(Math.abs(inside.cost - 0.2) < 1e-9);
  assert.ok(Math.abs(inside.wh - 2000) < 1e-9);
  const outside = sessionBucketCost([straddler], '2026-01-04', 2, nightly());
  assert.ok(Math.abs(outside.cost - 0.6) < 1e-9);
  // A session running past the range's last midnight is cut the same way.
  const tail = session(date(2026, 1, 11, 23, 0), date(2026, 1, 12, 1, 0), 2000);
  const last = sessionBucketCost([tail], '2026-01-11', 1, nightly());
  assert.ok(Math.abs(last.wh - 1000) < 1e-9);
  assert.ok(Math.abs(last.cost - 0.3) < 1e-9);
});

test('DST-shifted spans attribute by real duration and still reconcile', () => {
  // Fall-back night (2026-11-01 in Denver is 25 h): 22:00→06:00 is 9 real
  // hours. 2 kWh land on 31 October at the fallback; 7 real hours of wall
  // 00:00–06:00 land on 1 November inside the off-peak window.
  const fall = session(date(2026, 10, 31, 22, 0), date(2026, 11, 1, 6, 0), 9000);
  const halloween = sessionBucketCost([fall], '2026-10-31', 2, nightly());
  assert.ok(Math.abs(halloween.wh - 2000) < 1e-9);
  assert.ok(Math.abs(halloween.cost - 0.6) < 1e-9);
  const november = sessionBucketCost([fall], '2026-11-01', 7, nightly());
  assert.ok(Math.abs(november.wh - 7000) < 1e-9);
  assert.ok(Math.abs(november.cost - 0.7) < 1e-9);
  assert.ok(Math.abs(halloween.cost + november.cost - costForSession(fall, nightly())) < 1e-9);
  // Spring-forward night (2026-03-08 in Denver is 23 h): 22:00→06:00 is 7 real
  // hours, and the wall 00:00–03:00 window is only 2 of the November-side
  // hours (the "02" hour does not exist).
  const offPeak = nightly({ end: '03:00' });
  const spring = session(date(2026, 3, 7, 22, 0), date(2026, 3, 8, 6, 0), 7000);
  const march7 = sessionBucketCost([spring], '2026-03-07', 2, offPeak);
  assert.ok(Math.abs(march7.wh - 2000) < 1e-9);
  assert.ok(Math.abs(march7.cost - 0.6) < 1e-9);
  const march8 = sessionBucketCost([spring], '2026-03-08', 5, offPeak);
  assert.ok(Math.abs(march8.wh - 5000) < 1e-9);
  assert.ok(Math.abs(march8.cost - 1.1) < 1e-9);
  assert.ok(Math.abs(march7.cost + march8.cost - costForSession(spring, offPeak)) < 1e-9);
});

test('month buckets slice at local month boundaries, including the year rollover', () => {
  // 23:00→01:00 across 31 January: an hour of fallback, an hour of window.
  const crossing = session(date(2026, 1, 31, 23, 0), date(2026, 2, 1, 1, 0), 2000);
  const january = sessionBucketCost([crossing], '2026-01', 1, nightly());
  assert.ok(Math.abs(january.wh - 1000) < 1e-9);
  assert.ok(Math.abs(january.cost - 0.3) < 1e-9);
  const february = sessionBucketCost([crossing], '2026-02', 1, nightly());
  assert.ok(Math.abs(february.wh - 1000) < 1e-9);
  assert.ok(Math.abs(february.cost - 0.1) < 1e-9);
  // The same shape across New Year prices 1 January's early hours.
  const newYear = session(date(2025, 12, 31, 23, 0), date(2026, 1, 1, 1, 0), 2000);
  assert.ok(Math.abs(sessionBucketCost([newYear], '2025-12', 1, nightly()).cost - 0.3) < 1e-9);
  assert.ok(Math.abs(sessionBucketCost([newYear], '2026-01', 1, nightly()).cost - 0.1) < 1e-9);
});

test('coverage measures attributed session Wh against the recorded kWh', () => {
  const settings = nightly();
  const inside = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 2000);
  // Recorded energy with no covering session is disclosed, never priced free.
  const none = sessionBucketCost([], '2026-01-05', 4.2, settings);
  assert.deepEqual(none, { cost: 0, wh: 0, covered: false });
  const full = sessionBucketCost([inside], '2026-01-05', 2, settings);
  assert.equal(full.covered, true);
  // The interval reconciliation's tolerance is the coverage tolerance too:
  // 40 Wh short of 4 kWh is inside the 250 Wh floor…
  const jitter = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 3960);
  assert.equal(sessionBucketCost([jitter], '2026-01-05', 4, settings).covered, true);
  // …300 Wh short is not…
  const lost = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 3700);
  const partial = sessionBucketCost([lost], '2026-01-05', 4, settings);
  assert.equal(partial.covered, false);
  assert.ok(Math.abs(partial.cost - 0.37) < 1e-9);
  // …and 2% scales it on a big bucket (600 Wh at 30 kWh).
  const bigMonth = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 29500);
  assert.equal(sessionBucketCost([bigMonth], '2026-01', 30, settings).covered, true);
  assert.equal(
    sessionBucketCost([{ ...bigMonth, wh: 29300 }], '2026-01', 30, settings).covered,
    false,
  );
  // A zero-energy bucket is covered by nothing at all…
  assert.equal(sessionBucketCost([], '2026-01-05', 0, settings).covered, true);
  // …and a zero-energy session covers no recorded energy either.
  const zero = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 0);
  const zeroOnly = sessionBucketCost([zero], '2026-01-05', 2, settings);
  assert.deepEqual(zeroOnly, { cost: 0, wh: 0, covered: false });
  // An unusable recorded total says nothing to compare: the session figure
  // stands, covered (the series always carries a number here; this is the
  // defensive shape).
  assert.equal(sessionBucketCost([inside], '2026-01-05', 'nope', settings).covered, true);
});

test('unusable rows, ids and flat settings attribute nothing', () => {
  const settings = nightly();
  // Malformed session rows are skipped like the series builders skip them.
  const junk = sessionBucketCost(
    [null, 'x', 42, {}, { wh: 1000 }, [{ started_at: date(2026, 1, 5, 1, 0) }]],
    '2026-01-05',
    2,
    settings,
  );
  assert.deepEqual(junk, { cost: 0, wh: 0, covered: false });
  assert.equal(sessionBucketCost(null, '2026-01-05', 2, settings).wh, 0);
  // Malformed bucket ids price nothing; a day-shaped id never reads as a
  // month, and a rolling-over month id is no month at all.
  assert.equal(sessionBucketCost([], 'nope', 2, settings), null);
  assert.equal(sessionBucketCost([], '2026-02-31', 2, settings), null);
  assert.equal(sessionBucketCost([], '2026-13', 2, settings), null);
  assert.equal(sessionBucketCost([], '2026-1', 2, settings), null);
  // The flat path is aggregateCostLabel's alone.
  assert.equal(
    sessionBucketCost(
      [session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 2000)],
      '2026-01-05',
      2,
      FLAT,
    ),
    null,
  );
});

// The week's bucket costs reconcile with the sessions list, by construction:
// every bucket edge is a boundary costForInterval already splits at. Every
// session here lies inside the bucketed range — a straddler's label prices its
// out-of-range energy too, which is not the range's to sum.
test('a week of mixed sessions sums to exactly their per-session figures', () => {
  const settings = nightly();
  const sessions = [
    pausedSession(),
    session(date(2026, 1, 5, 22, 0), date(2026, 1, 6, 2, 0), 4000),
    session(date(2026, 1, 7, 1, 0), date(2026, 1, 7, 2, 0), 2000),
    session(date(2026, 1, 8, 11, 0), date(2026, 1, 8, 13, 0), 4000),
  ];
  let buckets = 0;
  for (const id of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) {
    buckets += sessionBucketCost(sessions, id, 0, settings).cost;
  }
  const labels =
    costForIntervals(sessions[0].intervals, settings) +
    sessions.slice(1).reduce((sum, item) => sum + costForSession(item, settings), 0);
  assert.ok(Math.abs(buckets - labels) < 1e-9);
  // Every session's own label agrees with the same engines.
  for (const item of sessions) {
    const label = sessionCostLabel(item, settings);
    assert.ok(label != null && label !== '—');
  }
});

// ---------- the live session's period contribution (#126) ----------

test("liveSessionSpan is the status write's own window, or nothing", () => {
  // The same interval the Status tab prices: [updated_at − elapsed, updated_at]
  // as raw ms endpoints — the span shape sessionCostSpans' fallback accepts.
  const at = date(2026, 1, 5, 3, 0).getTime();
  assert.deepEqual(liveSessionSpan(liveStatus(3, at, 3600, 2000)), {
    started_at: at - 3600_000,
    ended_at: at,
    wh: 2000,
  });
  // The liveness gates the live label shares: not charging, the offline
  // marker, no energy on the meter, no usable elapsed or write time.
  for (const status of [
    null,
    liveStatus(1, at, 3600),
    liveStatus(3, at, 3600, 1000, { state_label: 'ready' }),
    liveStatus(3, at, 3600, 1000, { charger_online: false }),
    liveStatus(3, at, 3600, 0),
    liveStatus(3, at, 3600, null),
    liveStatus(3, at, null),
    liveStatus(3, at, 0),
    liveStatus(3, at, -60),
    liveStatus(3, null, 3600),
  ]) {
    assert.equal(liveSessionSpan(status), null, JSON.stringify(status));
  }
  // Numeric text from a hand-edited document parses like a number.
  assert.equal(liveSessionSpan(liveStatus(3, at, '3600', '2000')).wh, 2000);
});

test('a live contribution prices into buckets by its own window', () => {
  const settings = nightly();
  // Charging 01:00→03:00, 2 kWh off-peak: the day bucket's figure is exactly
  // the Status tab's label for the same snapshot — the two screens price one
  // window, not two approximations of it.
  const at = date(2026, 1, 5, 3, 0).getTime();
  const contribution = liveSessionContribution(liveStatus(3, at, 7200, 2000), [], settings);
  assert.ok(contribution);
  const totals = sessionBucketCost([contribution], '2026-01-05', 2, settings);
  assert.ok(Math.abs(totals.cost - 0.2) < 1e-9);
  assert.ok(Math.abs(totals.wh - 2000) < 1e-9);
  // The live Wh covers the accruing day total, so no partial note fires.
  assert.equal(totals.covered, true);
  assert.equal(statusCostLabel(liveStatus(3, at, 7200, 2000), settings), 'GBP 0.20');
  // Other days see none of it.
  assert.equal(sessionBucketCost([contribution], '2026-01-04', 2, settings).wh, 0);
  // Flat configs never price a live contribution: the day total already
  // accrues under the one rate, so flat output stays byte-identical.
  assert.equal(liveSessionContribution(liveStatus(3, at, 7200, 2000), [], FLAT), null);
  // The gates suppress it before any pricing: not charging, offline, junk.
  assert.equal(liveSessionContribution(liveStatus(1, at, 7200, 2000), [], settings), null);
  assert.equal(liveSessionContribution(null, [], settings), null);
  assert.equal(liveSessionContribution(liveStatus(3, null, 7200, 2000), [], settings), null);
});

test('a midnight-spanning live charge attributes to both local days', () => {
  const settings = nightly();
  // 22:00→02:00, 4 kWh uniformly: half at the fallback, half off-peak — the
  // same pro-rated split the recorded session will price (#125's rule), and
  // the two days still reconcile with the Status tab's single-window figure.
  const at = date(2026, 1, 6, 2, 0).getTime();
  const contribution = liveSessionContribution(liveStatus(3, at, 14400, 4000), [], settings);
  const fifth = sessionBucketCost([contribution], '2026-01-05', 2, settings);
  assert.ok(Math.abs(fifth.wh - 2000) < 1e-9);
  assert.ok(Math.abs(fifth.cost - 0.6) < 1e-9);
  assert.equal(fifth.covered, true);
  const sixth = sessionBucketCost([contribution], '2026-01-06', 2, settings);
  assert.ok(Math.abs(sixth.wh - 2000) < 1e-9);
  assert.ok(Math.abs(sixth.cost - 0.2) < 1e-9);
  assert.equal(sixth.covered, true);
  assert.equal(statusCostLabel(liveStatus(3, at, 14400, 4000), settings), 'GBP 0.80');
  assert.ok(Math.abs(fifth.cost + sixth.cost - 0.8) < 1e-9);
});

test('the settle guard drops a contribution a recorded session already prices', () => {
  const settings = nightly();
  // Charging 01:00→03:00 on 5 January; the recorded session covers exactly
  // that charge (the session document that lands at the stop, beside a status
  // snapshot that still says charging — one order of the read race).
  const at = date(2026, 1, 5, 3, 0).getTime();
  const status = liveStatus(3, at, 7200, 2000);
  const recorded = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 3, 0), 2000);
  assert.equal(liveSessionSettled(liveSessionSpan(status), [recorded]), true);
  assert.equal(liveSessionContribution(status, [recorded], settings), null);
  // The bridge writes ended_at at its own finalize instant, which trails the
  // last charging write: a later endpoint still overlaps.
  const trailing = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 3, 1), 2000);
  assert.equal(liveSessionContribution(status, [trailing], settings), null);
  // A pause-resumed plug-in prices the same way: the recorded prefix (the
  // pause edge's document) overlaps the live window — the whole-window
  // estimate cannot be added beside energy the record already prices, so the
  // contribution drops and the uncovered tail is disclosed, never mispriced.
  const pausedPrefix = session(date(2026, 1, 5, 0, 0), date(2026, 1, 5, 2, 0), 1000);
  assert.equal(liveSessionContribution(status, [pausedPrefix], settings), null);
  // An unrelated earlier charge — ended before this one started — does not
  // settle anything, and neither does an interval-bearing session whose
  // charging blocks all lie outside the live window.
  const earlier = session(date(2026, 1, 4, 22, 0), date(2026, 1, 5, 0, 30), 2000);
  assert.equal(liveSessionSettled(liveSessionSpan(status), [earlier]), false);
  assert.ok(liveSessionContribution(status, [earlier], settings));
  const gapped = {
    ...session(date(2026, 1, 4, 22, 0), date(2026, 1, 5, 4, 0), 2000),
    intervals: [
      { started_at: date(2026, 1, 4, 22, 0), ended_at: date(2026, 1, 4, 23, 0), wh: 1000 },
      { started_at: date(2026, 1, 5, 3, 30), ended_at: date(2026, 1, 5, 4, 0), wh: 1000 },
    ],
  };
  assert.equal(liveSessionSettled(liveSessionSpan(status), [gapped]), false);
  // A session that cannot be priced at all covers nothing: it prices no
  // bucket, so the estimate beside it is not a double count.
  const unpriceable = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 3, 0), 'x');
  assert.ok(liveSessionContribution(status, [unpriceable], settings));
  // Junk payloads and a missing span settle nothing.
  assert.equal(liveSessionSettled(liveSessionSpan(status), null), false);
  assert.equal(liveSessionSettled(liveSessionSpan(status), [null, 'x', {}]), false);
  assert.equal(liveSessionSettled(null, [recorded]), false);
});

test('a settled live charge prices exactly once across the transition', () => {
  const settings = nightly();
  // The double-count the guard exists for: the same 2 kWh as a recorded
  // session and an unsettled live contribution would price GBP 0.40 into a
  // 2 kWh day. With the guard, the bucket carries the recorded figure alone —
  // whichever listener delivered first, because the predicate reads the
  // merged payload, not the arrival order.
  const at = date(2026, 1, 5, 3, 0).getTime();
  const status = liveStatus(3, at, 7200, 2000);
  const recorded = session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 3, 0), 2000);
  const merged = [...[recorded], liveSessionContribution(status, [recorded], settings)].filter(
    Boolean,
  );
  const totals = sessionBucketCost(merged, '2026-01-05', 2, settings);
  assert.ok(Math.abs(totals.cost - 0.2) < 1e-9);
  assert.ok(Math.abs(totals.wh - 2000) < 1e-9);
  // And without the recording — mid-charge — the contribution alone carries
  // the same figure, so the settled number is the one the estimate promised.
  const live = [liveSessionContribution(status, [], settings)].filter(Boolean);
  assert.ok(Math.abs(sessionBucketCost(live, '2026-01-05', 2, settings).cost - 0.2) < 1e-9);
});

// ---------- the live archive (issue #123's evidence, 2026-10-22) ----------
//
// Four sessions against the October season rate $0.15303, exactly as the owner
// reported them: two interval-less spans that straddle local midnights
// (pro-rated), two with one exact interval each. Denver is the observing
// timezone, so the UTC spans land on the local Oct 19–22 days the history
// screen renders.

function octoberRate() {
  return {
    rate: 0.15303,
    currency: 'USD',
    rates: [
      {
        id: 'october',
        rate: 0.15303,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: [10],
      },
    ],
  };
}

const utc = (year, month, day, hours, minutes) =>
  new Date(Date.UTC(year, month - 1, day, hours, minutes));

function liveArchive() {
  return [
    {
      id: '1792455533',
      wh: 11461,
      started_at: utc(2026, 10, 20, 0, 18),
      ended_at: utc(2026, 10, 20, 6, 31),
    },
    {
      id: '1792543109',
      wh: 6841,
      started_at: utc(2026, 10, 21, 0, 38),
      ended_at: utc(2026, 10, 21, 7, 0),
    },
    {
      id: '1792613313',
      wh: 10833,
      started_at: utc(2026, 10, 21, 20, 8),
      ended_at: utc(2026, 10, 22, 7, 0),
      intervals: [
        {
          started_at: utc(2026, 10, 21, 20, 8),
          ended_at: utc(2026, 10, 22, 7, 0),
          wh: 10833,
        },
      ],
    },
    {
      id: '1792698073',
      wh: 1796,
      started_at: utc(2026, 10, 22, 19, 41),
      ended_at: utc(2026, 10, 22, 20, 39),
      intervals: [
        {
          started_at: utc(2026, 10, 22, 19, 41),
          ended_at: utc(2026, 10, 22, 20, 39),
          wh: 1796,
        },
      ],
    },
  ];
}

test('the live archive attributes across its local midnights exactly once', () => {
  const sessions = liveArchive();
  const settings = octoberRate();
  // Local (MDT, UTC-6) spans and the exact per-day attribution:
  //   1792455533  Oct 19 18:18 → Oct 20 00:31   (span, 20520 s | 1860 s of 22380 s)
  //   1792543109  Oct 20 18:38 → Oct 21 01:00   (span, 19320 s |  3600 s of 22920 s)
  //   1792613313  Oct 21 14:08 → Oct 22 01:00   (interval, 35520 s | 3600 s of 39120 s)
  //   1792698073  Oct 22 13:41 → Oct 22 14:39   (interval, all Oct 22)
  const expected = {
    '2026-10-19': (11461 * 20520) / 22380,
    '2026-10-20': (11461 * 1860) / 22380 + (6841 * 19320) / 22920,
    '2026-10-21': (6841 * 3600) / 22920 + (10833 * 35520) / 39120,
    '2026-10-22': (10833 * 3600) / 39120 + 1796,
  };
  for (const [id, wh] of Object.entries(expected)) {
    const bucket = sessionBucketCost(sessions, id, wh / 1000, settings);
    assert.ok(Math.abs(bucket.wh - wh) < 1e-6, `${id} wh ${bucket.wh} != ${wh}`);
    assert.ok(Math.abs(bucket.cost - (wh / 1000) * 0.15303) < 1e-9, id);
    assert.equal(bucket.covered, true, id);
  }
});

test('the live archive week reconciles with the sessions list figures', () => {
  const sessions = liveArchive();
  const settings = octoberRate();
  let week = 0;
  for (const id of [
    '2026-10-16',
    '2026-10-17',
    '2026-10-18',
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
  ]) {
    week += sessionBucketCost(sessions, id, 0, settings).cost;
  }
  const list = sessions.reduce(
    (sum, item) =>
      sum +
      (item.intervals
        ? costForIntervals(item.intervals, settings)
        : costForSession(item, settings)),
    0,
  );
  // Σ the four sessions at $0.15303: 30.931 kWh → $4.7334, rendered "USD 4.73".
  assert.ok(Math.abs(list - 4.73337093) < 1e-6);
  assert.ok(Math.abs(week - list) < 1e-9);
  assert.equal(fmtMoney(week, 'USD'), 'USD 4.73');
  // Each session's own label is the same figure the sessions list renders.
  const labels = sessions.map((item) => sessionCostLabel(item, settings));
  assert.deepEqual(labels, ['USD 1.75', 'USD 1.05', 'USD 1.66', 'USD 0.27']);
});

test('flat settings never price through the schedule helpers', () => {
  // One flat implementation: aggregateCostLabel. The bucket- and
  // session-priced helpers return hidden under a flat config, so a flat figure
  // on screen can only ever come from the byte-identical aggregate path.
  assert.equal(hourCost('2026-01-05', '02', 2, FLAT), null);
  assert.equal(
    sessionBucketCost(
      [session(date(2026, 1, 5, 1, 0), date(2026, 1, 5, 2, 0), 2000)],
      '2026-01-05',
      2,
      FLAT,
    ),
    null,
  );
});

test('flat aggregate output stays byte-identical across the input matrix', () => {
  // The regression the whole PR leans on: for the same inputs the flat label
  // is exactly the fmtCost string the pre-schedule screen rendered.
  for (const kwh of [0, 0.001, 0.125, 1, 12.345, 250, 999.999, 12345.6789, -1]) {
    assert.equal(
      aggregateCostLabel(kwh, FLAT),
      fmtCost(kwh, FLAT.rate, FLAT.currency),
      String(kwh),
    );
  }
  for (const bad of [null, undefined, '', 'nope', ' ', Number.NaN, Infinity, true]) {
    assert.equal(aggregateCostLabel(bad, FLAT), null, String(bad));
  }
  // A missing rate or currency hides exactly as before.
  assert.equal(aggregateCostLabel(1, { rate: null, currency: 'GBP' }), null);
  assert.equal(aggregateCostLabel(1, null), null);
});
