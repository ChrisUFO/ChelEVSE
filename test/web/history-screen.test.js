import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodById, periodBounds, sessionsRange } from '../../web/js/history.js';
import { statusCostLabel } from '../../web/js/cost.js';
import { fmtMoney } from '../../web/js/format.js';

// Pin the zone before any Date is built (#123): the period-pricing pass below
// asserts a nightly-window figure, which is only deterministic in a known
// timezone. Mid-month dates keep it away from every DST edge.
process.env.TZ = 'America/Denver';

// Harness decision (recorded in test/web/settings-screen.test.js, #85/#102):
// the module-mock-free DOM stub plus a plain `await import` of the real screen
// module. The sessions read path cannot be driven to a *successful* Firestore
// read in Node — firebase.js keeps `getDocs` unbound until initFirebase(), so
// every store read rejects — which is exactly the kind of boundary
// settings-screen.test.js documents for its save path. The paging rules
// therefore live in the screen's pure exports (nextSessionsView /
// sessionsControls / mergeSessions / monthRange) and are pinned below against
// plain fixtures: they own every acceptance scenario's decision (append,
// dedupe, exhaustion, view adoption, failure handling). The DOM layer pins the
// wiring that is reachable without Firestore: the real click/change listeners,
// the real failure path (a genuine rejection through loadAll and the paging
// handlers), control painting on reset and failure, and the month/Recent
// round-trip's effect on the controls. It cannot cover layout, real DOM events
// or a successful read's painting — except through the period-pricing seam
// below, whose store read is injectable (#123 Gap: the payload's unwrap at the
// fetch→apply boundary was invisible to every pure test and regex pin).

function stubElement() {
  const classes = new Set();
  const listeners = new Map();
  return {
    classes,
    listeners,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    dataset: {},
    style: { setProperty() {} },
    children: [],
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    open: false,
    tabIndex: 0,
    title: '',
    className: '',
    id: '',
    type: '',
    htmlFor: '',
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    remove() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    toggleAttribute() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
  };
}

const elements = new Map();

function element(id) {
  let el = elements.get(id);
  if (!el) {
    el = stubElement();
    elements.set(id, el);
  }
  return el;
}

globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => element(id),
  createElement: () => stubElement(),
  // renderChart builds its SVG bars through the namespace creator (#123: the
  // pricing pass below is the first harness read to succeed, so the chart
  // actually renders here).
  createElementNS: () => stubElement(),
  createTextNode: (text) => ({ textContent: text }),
  // initHistory registers a visibilitychange listener and paints the period
  // switch through querySelectorAll.
  addEventListener() {},
  querySelectorAll: () => [],
};

globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};

const {
  initHistory,
  resetHistory,
  enterHistory,
  mergeSessions,
  monthRange,
  nextSessionsView,
  sessionsControls,
  applyHistory,
  fetchPeriodSessions,
  showHistorySettings,
  showHistoryStatus,
} = await import('../../web/js/screens/history.js');

initHistory();

// Fire one element's captured listeners; the last listener's return travels
// back so an async handler (the real click listener is loadAll itself) can be
// awaited to completion.
const fire = (id, type) => {
  let last;
  for (const listener of element(id).listeners.get(type) || []) last = listener();
  return last;
};

const settle = () => new Promise((done) => setTimeout(done, 0));

// Await a fire-and-forged settle re-read until its failure paint lands: in
// Node every store read genuinely rejects, so the read's completion is
// observable as the error copy replacing the loading copy. Polling the copy
// (not a fixed settle count) is what makes the await deterministic — the
// read's final repaint runs in its own turn.
async function readFailed() {
  for (let i = 0; i < 20; i++) {
    if (element('chart-empty-title').textContent.startsWith("Couldn't load")) return;
    await settle();
  }
}

// A settled page fixture: `n` docs (ids continue after `offset`), an opaque
// cursor, and a server answer unless overridden.
const page = (n, offset = 0, extra = {}) => ({
  docs: Array.from({ length: n }, (_, i) => ({
    id: `s${offset + i + 1}`,
    started_at: 1760000000000 - (offset + i) * 3600_000,
    wh: 1500,
    elapsed: 3600,
  })),
  lastDoc: { id: `cursor-${offset}` },
  fromCache: false,
  ...extra,
});

// ---------- the paging rules (pure) ----------

test('a full first page offers more and the next page appends without duplicates', () => {
  const first = nextSessionsView(null, page(20), { kind: 'first' });
  assert.equal(first.state, 'fresh');
  assert.equal(first.exhausted, false);
  assert.equal(first.cursor.id, 'cursor-0');
  assert.deepEqual(sessionsControls(first), { more: true });

  const second = nextSessionsView(first, page(20, 20), { kind: 'more' });
  // The shown count follows the appended rows…
  assert.equal(second.sessions.length, 40);
  // …and a page never renders a row twice.
  assert.equal(new Set(second.sessions.map((item) => item.id)).size, 40);
  assert.equal(second.cursor.id, 'cursor-20');
  assert.equal(second.exhausted, false);
  assert.deepEqual(sessionsControls(second), { more: true });
});

test('a repeated or overlapping page never renders a row twice', () => {
  const first = nextSessionsView(null, page(20), { kind: 'first' });
  const overlap = nextSessionsView(
    first,
    {
      docs: [first.sessions[19], { id: 's21', wh: 900 }],
      lastDoc: { id: 'cursor-20' },
      fromCache: false,
    },
    { kind: 'more' },
  );
  assert.equal(overlap.sessions.length, 21);
  assert.equal(overlap.sessions.filter((item) => item.id === 's20').length, 1);
  // Defensive shape handling: missing sides read as empty, never as garbage.
  assert.deepEqual(mergeSessions(null, null), []);
});

test('a short server page concludes the archive and hides the control', () => {
  const first = nextSessionsView(null, page(20), { kind: 'first' });
  const done = nextSessionsView(first, page(7, 20), { kind: 'more' });
  assert.equal(done.sessions.length, 27);
  assert.equal(done.exhausted, true);
  assert.deepEqual(sessionsControls(done), { more: false });
});

test('a small archive shows no control at all', () => {
  const small = nextSessionsView(null, page(3), { kind: 'first' });
  assert.equal(small.state, 'fresh');
  assert.equal(small.exhausted, true);
  assert.deepEqual(sessionsControls(small), { more: false });
});

test('a failed page keeps the list and the control for a retry', () => {
  const shown = nextSessionsView(
    nextSessionsView(null, page(20), { kind: 'first' }),
    page(20, 20),
    { kind: 'more' },
  );
  const failed = nextSessionsView(shown, null, { kind: 'more' });
  assert.equal(failed.sessions.length, 40);
  assert.equal(failed.cursor.id, 'cursor-20');
  assert.equal(failed.exhausted, false);
  assert.equal(failed.state, 'error');
  assert.deepEqual(sessionsControls(failed), { more: true });
});

test('a failed first page keeps the previous view on screen', () => {
  const march = nextSessionsView(null, page(20), { kind: 'first', month: '2026-03' });
  const failed = nextSessionsView(march, null, { kind: 'first', month: '2026-09' });
  // September was never adopted: March's list, cursor and exhaustion stay.
  assert.equal(failed.month, '2026-03');
  assert.equal(failed.sessions.length, 20);
  assert.equal(failed.state, 'error');
  assert.deepEqual(sessionsControls(failed), { more: true });
});

test('a month pick adopts the month and Recent resets to fresh-load control state', () => {
  const march = nextSessionsView(null, page(20), { kind: 'first', month: '2026-03' });
  assert.equal(march.month, '2026-03');
  assert.deepEqual(sessionsControls(march), { more: true });

  const recent = nextSessionsView(march, page(20), { kind: 'first', month: null });
  assert.equal(recent.month, null);
  assert.equal(recent.sessions.length, 20);
  assert.equal(recent.exhausted, false);
  // The reset control state is exactly a fresh load's.
  assert.deepEqual(
    sessionsControls(recent),
    sessionsControls(nextSessionsView(null, page(20), { kind: 'first' })),
  );
});

test('a cached page never concludes exhaustion', () => {
  // A cached short page is the cache answering, not the archive ending, so
  // the control stays for a retry that may reach the server.
  const cachedFirst = nextSessionsView(null, page(3, 0, { fromCache: true }), {
    kind: 'first',
  });
  assert.equal(cachedFirst.state, 'cached');
  assert.equal(cachedFirst.exhausted, false);
  assert.deepEqual(sessionsControls(cachedFirst), { more: true });

  const first = nextSessionsView(null, page(20), { kind: 'first' });
  const cachedPage = nextSessionsView(first, page(3, 20, { fromCache: true }), {
    kind: 'more',
  });
  assert.equal(cachedPage.state, 'cached');
  assert.equal(cachedPage.sessions.length, 23);
  assert.equal(cachedPage.exhausted, false);
});

test('an empty page ends the archive without erasing it', () => {
  // Exactly one page worth of sessions: the second page comes back empty, and
  // a kept list must not be reclassified as "no sessions".
  const first = nextSessionsView(null, page(20), { kind: 'first' });
  const end = nextSessionsView(
    first,
    { docs: [], lastDoc: null, fromCache: false },
    { kind: 'more' },
  );
  assert.equal(end.state, 'fresh');
  assert.equal(end.sessions.length, 20);
  assert.equal(end.exhausted, true);
  assert.deepEqual(sessionsControls(end), { more: false });
});

test('an offline page keeps the list and cursor for a retry', () => {
  const first = nextSessionsView(null, page(20), { kind: 'first' });
  const miss = nextSessionsView(
    first,
    { docs: [], lastDoc: null, fromCache: true },
    {
      kind: 'more',
    },
  );
  assert.equal(miss.state, 'offline');
  assert.equal(miss.sessions.length, 20);
  assert.equal(miss.cursor.id, 'cursor-0');
  assert.equal(miss.exhausted, false);
  assert.deepEqual(sessionsControls(miss), { more: true });

  // A first page that misses offline keeps the previous view, like the
  // pre-paging screen kept its last loaded list.
  const kept = nextSessionsView(
    first,
    { docs: [], lastDoc: null, fromCache: true },
    {
      kind: 'first',
      month: '2026-09',
    },
  );
  assert.equal(kept.month, null);
  assert.equal(kept.sessions.length, 20);
  assert.equal(kept.state, 'offline');
});

test('an offline or failed read keeps a cached view on screen', () => {
  // The failure matrix's cached-provenance variant: a first page answered by
  // the cache must keep its rows and retry control through a later offline
  // cache miss or rejection, like a server-sourced view does.
  const cachedFirst = nextSessionsView(null, page(20, 0, { fromCache: true }), {
    kind: 'first',
  });
  assert.equal(cachedFirst.state, 'cached');

  const miss = nextSessionsView(
    cachedFirst,
    { docs: [], lastDoc: null, fromCache: true },
    { kind: 'more' },
  );
  assert.equal(miss.state, 'offline');
  assert.equal(miss.sessions.length, 20);
  assert.deepEqual(sessionsControls(miss), { more: true });

  const failed = nextSessionsView(cachedFirst, null, { kind: 'more' });
  assert.equal(failed.state, 'error');
  assert.equal(failed.sessions.length, 20);
  assert.deepEqual(sessionsControls(failed), { more: true });
});

test('monthRange bounds one month half-open', () => {
  const march = monthRange('2026-03');
  assert.equal(march.start.getTime(), new Date(2026, 2, 1).getTime());
  assert.equal(march.end.getTime(), new Date(2026, 3, 1).getTime());
  assert.equal(monthRange(null), null);
  // December's exclusive end rolls into the next year.
  const december = monthRange('2026-12');
  assert.equal(december.end.getFullYear(), 2027);
  assert.equal(december.end.getMonth(), 0);
});

// ---------- the screen wiring (DOM stub) ----------

test('a first read that fails reports through the section state and offers no control', async () => {
  resetHistory();
  enterHistory();
  // The real refresh listener is loadAll itself; with no Firestore bindings
  // every read genuinely rejects, which is this failure path's production
  // route — not a stubbed one.
  await fire('history-refresh', 'click');
  const state = element('sessions-state');
  assert.equal(state.hidden, false);
  assert.equal(state.className, 'section-state err');
  assert.match(state.textContent, /Couldn't load sessions/);
  assert.equal(element('sessions-list').hidden, true);
  assert.equal(element('sessions-more').hidden, true);
  assert.equal(element('sessions-count').textContent, '');
});

test('the month picker and Recent reset drive the read and the way back', async () => {
  resetHistory();
  enterHistory();
  await fire('history-refresh', 'click');

  // A month pick starts its read immediately (the loading copy is painted
  // synchronously) and offers the Recent reset.
  element('sessions-month').value = '2026-03';
  const pick = fire('sessions-month', 'change');
  // The picker names the read, so the copy says "sessions", not "recent" —
  // the view still holds the previous month until the page lands.
  assert.equal(element('sessions-state').textContent, 'Loading sessions…');
  await pick;
  await settle();
  // The read failed: the feedback element reports it and the way back stays.
  assert.match(element('sessions-state').textContent, /Couldn't load sessions/);
  assert.equal(element('sessions-recent').hidden, false);

  // Recent clears the picker, hides itself, and re-reads the recent page.
  const reset = fire('sessions-recent', 'click');
  assert.equal(element('sessions-month').value, '');
  assert.equal(element('sessions-recent').hidden, true);
  await reset;
  await settle();
  assert.match(element('sessions-state').textContent, /Couldn't load sessions/);

  // An unparsable picker value (a browser without the native control falls
  // back to text) reads the recent view and never offers Recent.
  element('sessions-month').value = 'march?';
  await fire('sessions-month', 'change');
  await settle();
  assert.equal(element('sessions-recent').hidden, true);
  assert.match(element('sessions-state').textContent, /Couldn't load sessions/);
});

test('a show-more click with nothing shown is a safe no-op', async () => {
  resetHistory();
  enterHistory();
  await fire('history-refresh', 'click');
  // The control is hidden with no list on screen; clicking through it anyway
  // (the listener is real) must neither throw nor change the reporting.
  await fire('sessions-more', 'click');
  assert.equal(element('sessions-more').hidden, true);
  assert.match(element('sessions-state').textContent, /Couldn't load sessions/);
});

test('resetHistory clears the browse controls with the view', () => {
  resetHistory();
  element('sessions-month').value = '2026-03';
  element('sessions-recent').hidden = false;
  element('sessions-more').hidden = false;
  element('sessions-more').disabled = true;

  resetHistory();
  assert.equal(element('sessions-month').value, '');
  assert.equal(element('sessions-recent').hidden, true);
  assert.equal(element('sessions-more').hidden, true);
  assert.equal(element('sessions-more').disabled, false);
  assert.equal(element('sessions-count').textContent, '');
  assert.equal(element('sessions-state').hidden, true);
});

// ---------- the period pricing pipeline, executed (#123) ----------
//
// The Gap this section exists for: `fetchPeriodSessions` once resolved the
// paged read's envelope ({docs, fromCache}) verbatim, and `applyHistory`'s
// Array.isArray guard quietly turned it into zero sessions — Week/Month/Year
// showed no $ under a schedule while every pure test and regex wiring pin
// stayed green, because none of them executed the payload crossing the
// fetch→apply boundary. The store seam is injectable for exactly this read, so
// this drives the real functions the real read path calls: fetch, then the
// apply step readHistory/loadAll perform, then the render boot performs when
// settings land (showHistorySettings re-renders the applied series).

// The cost.test.js nightly shape: a visible base at 0.30 with an off-peak
// 00:00–06:00 window at 0.10.
function nightly() {
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
      },
    ],
  };
}

test('a successful range read lands its docs in the applied period and prices the summary', async () => {
  resetHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  const bounds = periodBounds('week', today);

  // One session wholly inside Wed 14 Oct's off-peak hours: 2 kWh at 0.10.
  const session = {
    id: 's1',
    wh: 2000,
    started_at: new Date(2026, 9, 14, 1),
    ended_at: new Date(2026, 9, 14, 3),
  };
  // The store seam, stubbed the way Node's harness must: the raw paged-read
  // envelope Firestore path returns.
  const seen = [];
  const readRange = async (range) => {
    seen.push(range);
    return { docs: [session], fromCache: true };
  };

  const sessions = await fetchPeriodSessions(descriptor, bounds, readRange);
  // The unwrap is the fix: what crosses into applyHistory is the read's docs,
  // never the envelope around them (an object here priced nothing).
  assert.ok(Array.isArray(sessions), 'the applied payload is the docs array');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0], session);
  // The read still derives its window from the bounds: the widened started_at
  // range with the 7-day plug-in lookback.
  assert.deepEqual(seen, [sessionsRange(bounds)]);

  // The apply step both read paths perform, with the history read's docs
  // beside the session payload…
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-14', kwh: 2 }], fromCache: false },
    null,
    today,
    sessions,
  );
  // …and the render boot performs when settings land: the summary prices from
  // the applied sessions — 2 kWh off-peak, nothing uncovered, so the figure
  // shows with no partial note beside it.
  showHistorySettings(nightly());
  assert.equal(element('history-cost-cell').hidden, false);
  assert.equal(element('history-cost').textContent, fmtMoney(0.2, 'GBP'));
  assert.equal(element('history-cost-note').hidden, true);
  // The energy it priced is on screen too: the same read's kWh total.
  assert.equal(element('history-total').textContent, '2.00');
});

test('the period sessions read keeps its empty and rejecting edges', async () => {
  const bounds = periodBounds('week', new Date(2026, 9, 18, 12));
  const fail = async () => {
    throw new Error('offline');
  };
  // The Day period never reads the archive: no store call, an empty payload.
  assert.deepEqual(await fetchPeriodSessions(periodById('day'), bounds, fail), []);
  // A range period with no derivable window (malformed bounds) reads nothing.
  assert.deepEqual(await fetchPeriodSessions(periodById('week'), {}, fail), []);
  // A rejected range read rejects — the callers' allSettled fallback owns the
  // empty payload, so the fetch itself must not swallow the failure.
  await assert.rejects(fetchPeriodSessions(periodById('week'), bounds, fail), /offline/);
});

// ---------- the live session's period contribution, executed (#126) ----------
//
// The same seam as #123's pricing pass, extended with the status input: the
// app's listener fans each snapshot out through showHistoryStatus, and the
// screen decides the live contribution against the merged period payload at
// render time. The settle race is pinned in both orders — the session
// document and the stopped status write travel two listeners — because the
// bridge's _finalize_session writes the record on the very edge whose status
// snapshot says charging stopped.

// A status document as the store delivers it: the numeric state plus the
// bridge's derived label, and `updated_at` in the Timestamp snapshot shape.
function statusAt(state, updatedMs, elapsed, wh, overrides = {}) {
  return {
    state,
    state_label: state === 3 ? 'charging' : 'ready',
    charger_online: true,
    updated_at: { toMillis: () => updatedMs },
    elapsed,
    session_energy: wh,
    ...overrides,
  };
}

test("a mid-charge week carries the live estimate in today's bar and the summary", () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  // No recorded session and no live input yet: today's accruing kWh is
  // uncovered, so the $ hides — the pre-#126 mid-charge presentation.
  assert.equal(element('history-cost-cell').hidden, true);

  // 10:00→12:00, 1 kWh at the all-day base: the figure the Status tab shows
  // for the very same write.
  const charging = statusAt(3, today.getTime(), 7200, 1000);
  assert.equal(statusCostLabel(charging, nightly()), fmtMoney(0.3, 'GBP'));
  showHistoryStatus(charging);
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
  assert.equal(element('history-cost-cell').hidden, false);
  // Today's bar carries the same estimate (the current slot is selected).
  assert.equal(element('chart-cost').textContent, fmtMoney(0.3, 'GBP'));
  // The live Wh covers today's accruing kWh, so the partial note stays down…
  assert.equal(element('history-cost-note').hidden, true);
  // …and the kWh display is still the day document's own total.
  assert.equal(element('history-total').textContent, '1.00');

  // A re-delivery of the same write cannot slide the figure: the window is
  // anchored to the write's own updated_at, never a render clock.
  showHistoryStatus(charging);
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // A genuinely missing record is still disclosed: yesterday's kWh has no
  // covering session and no live window over it, and today's live pricing
  // never silences that note.
  applyHistory(
    descriptor,
    {
      docs: [
        { id: '2026-10-17', kwh: 1 },
        { id: '2026-10-18', kwh: 1 },
      ],
      fromCache: false,
    },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost-note').hidden, false);
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
});

test('a settle in the session-first order prices the charge exactly once', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // The race's first order: the recorded session is applied while the
  // snapshot still says charging (the stopped write has not landed). The
  // settle guard drops the estimate and the record prices the same figure
  // alone — never both. The finalize instant trails the last charging write,
  // so its ended_at genuinely overlaps the live window.
  const recorded = {
    id: '1765792800',
    wh: 1000,
    started_at: new Date(2026, 9, 18, 10),
    ended_at: new Date(2026, 9, 18, 12, 1),
  };
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [recorded],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
  assert.equal(element('history-cost-note').hidden, true);
  // A re-delivery of the stale charging write re-renders and still prices
  // exactly once: the guard keys on the merged payload, not on which
  // listener delivered last.
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
});

test('a settle in the status-first order re-reads and prices exactly once', async () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // The race's second order: the stopped snapshot arrives first, so the
  // estimate is gone with it and the charging→stopped edge queues the settle
  // re-read — the bridge records the session on that same edge. In Node the
  // read genuinely rejects (no Firestore bindings), which is the failure
  // route's own presentation; the harness then drives the successful read's
  // apply step through the same seam as above.
  showHistoryStatus(statusAt(1, today.getTime() + 60_000, 7200, 1000));
  await readFailed();
  const recorded = {
    id: '1765792800',
    wh: 1000,
    started_at: new Date(2026, 9, 18, 10),
    ended_at: new Date(2026, 9, 18, 12, 1),
  };
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [recorded],
  );
  showHistorySettings(nightly());
  // With no live span left there is exactly one pricing of the charge — the
  // recorded figure, the same number the estimate promised.
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
  assert.equal(element('history-cost-note').hidden, true);
});

test('a settle read that misses the retried session write recovers on the next push', async () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // The stopped push fires the settle re-read, but the bridge's session write
  // failed and is retried on its next tick — so the read fetches before the
  // record commits. In Node the read genuinely rejects, the same outcome for
  // this path: the settle read ended without the recorded session.
  showHistoryStatus(statusAt(1, today.getTime() + 60_000, 7200, 1000));
  await readFailed();

  // An idle push has no live span on either side of it, so nothing but the
  // verification re-read could move the screen: the loading copy painted
  // synchronously by readHistory is the proof the one-shot re-read fired.
  showHistoryStatus(statusAt(1, today.getTime() + 120_000, 7200, 1000));
  assert.match(element('chart-empty-title').textContent, /Loading/);
  await readFailed();

  // The retried write has committed: the verify read's payload — driven
  // through the same apply seam — prices the recorded session exactly once,
  // the same number the estimate promised.
  const recorded = {
    id: '1765792800',
    wh: 1000,
    started_at: new Date(2026, 9, 18, 10),
    ended_at: new Date(2026, 9, 18, 12, 1),
  };
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [recorded],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
  assert.equal(element('history-cost-note').hidden, true);
  assert.equal(element('history-total').textContent, '1.00');

  // The flag is spent: a further idle push starts no re-read (a read would
  // clear the total synchronously), so the idle stream settles for good.
  showHistoryStatus(statusAt(1, today.getTime() + 180_000, 7200, 1000));
  assert.equal(element('history-total').textContent, '1.00');
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
});

test('a midnight-spanning live charge attributes to both local days', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 1); // 01:00 Sunday 18 October
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    {
      docs: [
        { id: '2026-10-17', kwh: 1 },
        { id: '2026-10-18', kwh: 1 },
      ],
      fromCache: false,
    },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  // 23:00 Saturday → 01:00 Sunday, 2 kWh: an hour of base then an hour of
  // off-peak — the Status tab's single-window figure, split at the midnight
  // the recorded session will split at too.
  const charging = statusAt(3, today.getTime(), 7200, 2000);
  assert.equal(statusCostLabel(charging, nightly()), fmtMoney(0.4, 'GBP'));
  showHistoryStatus(charging);
  // The summary carries both days' slices…
  assert.equal(element('history-cost').textContent, fmtMoney(0.4, 'GBP'));
  // …today's bar only its own (the current slot is selected)…
  assert.equal(element('chart-cost').textContent, fmtMoney(0.1, 'GBP'));
  // …and each day is covered by its slice, so the partial note stays down.
  assert.equal(element('history-cost-note').hidden, true);
});

test('an offline marker hides the live contribution instead of repricing it', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // The bridge's offline marker: the charging label is kept over frozen
  // values while updated_at refreshes. The Status tab hides its live figure
  // under the same marker; history must hide too, never reprice the frozen
  // window at whatever rates the marker's own clock would apply.
  showHistoryStatus(statusAt(3, today.getTime() + 1800_000, 7200, 1000, { charger_online: false }));
  assert.equal(element('history-cost-cell').hidden, true);
  assert.equal(element('history-cost-note').hidden, true);
  // A later live write restores the estimate at its own, newer window.
  showHistoryStatus(statusAt(3, today.getTime() + 2400_000, 7440, 1030));
  assert.equal(element('history-cost').textContent, fmtMoney(0.31, 'GBP'));
});

test('the flat path is byte-identical with a charge in progress', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings({ rate: 0.245, currency: 'GBP' });
  assert.equal(element('history-cost').textContent, 'GBP 0.25');
  // The push changes nothing: a flat day total already prices the accruing
  // kWh, and the live contribution is schedule-path only.
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, 'GBP 0.25');
  assert.equal(element('history-cost-cell').hidden, false);
});

test("the Day period's hour bars price from the day document, live input or not", async () => {
  resetHistory();
  enterHistory();
  // Switch the screen to the Day period through its real click listener; the
  // read it starts genuinely rejects in Node (no Firestore bindings), and the
  // apply step below is the payload that read would deliver.
  const switchClick = element('period-switch').listeners.get('click')[0];
  element('period-switch').contains = () => true;
  await switchClick({ target: { closest: () => ({ dataset: { period: 'day' } }) } });
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('day');
  applyHistory(descriptor, { id: '2026-10-18', kwh: 1, hours: { 12: 1 } }, null, today, []);
  showHistorySettings(nightly());
  // The in-progress 12:00 hour at the all-day base — before and after a live
  // push: the live contribution never reaches the hour path, so the Day
  // period's pricing is exactly #125's.
  assert.equal(element('chart-cost').textContent, fmtMoney(0.3, 'GBP'));
  showHistoryStatus(statusAt(3, today.getTime(), 3600, 500));
  assert.equal(element('chart-cost').textContent, fmtMoney(0.3, 'GBP'));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
});

test('a settle that lands while the tab is hidden is caught up on the next visible push', async () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  const descriptor = periodById('week');
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // Hidden tab: the stopped push updates the snapshot only — the paint and
  // the period payload stand exactly as they were.
  element('panel-history').hidden = true;
  showHistoryStatus(statusAt(1, today.getTime() + 60_000, 7200, 1000));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // The next visible push consumes the queued settle: one re-read. In Node
  // the read genuinely rejects, and the failed repaint is itself the proof
  // the read ran — a hidden push would have left the old paint standing
  // (the read clears the chart before it fetches, so the total is gone).
  element('panel-history').hidden = false;
  showHistoryStatus(statusAt(1, today.getTime() + 120_000, 7200, 1000));
  await readFailed();
  assert.equal(element('history-total').textContent, '—');
  assert.equal(element('history-cost-cell').hidden, true);
});
