import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayLabel,
  periodAnchor,
  periodById,
  periodBounds,
  sessionsRange,
} from '../../web/js/history.js';
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
  const attrs = {};
  return {
    classes,
    listeners,
    attrs,
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
      // A browser moves the focus to <body> when the element holding it leaves the
      // document. The screen's focus continuity exists because of exactly that, so
      // the harness models it: otherwise a read that repaints under a keyboard
      // user looks free of the failure it has to prevent.
      const focused = globalThis.document.activeElement;
      if (focused && this.children.includes(focused) && !nodes.includes(focused)) {
        globalThis.document.activeElement = globalThis.document.body;
      }
      this.children = nodes;
    },
    remove() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    toggleAttribute() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    focus() {
      // The real DOM moves focus; the stub records it so the screen's focus
      // handoff (a control that disables itself) can be asserted.
      globalThis.document.activeElement = this;
    },
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
  // The focus target a removal leaves behind (see replaceChildren above).
  body: stubElement(),
  activeElement: null,
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
  activateHistory,
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
  // shows.
  showHistorySettings(nightly());
  assert.equal(element('history-cost-cell').hidden, false);
  assert.equal(element('history-cost').textContent, fmtMoney(0.2, 'GBP'));
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
  // The kWh display is still the day document's own total.
  assert.equal(element('history-total').textContent, '1.00');

  // A re-delivery of the same write cannot slide the figure: the window is
  // anchored to the write's own updated_at, never a render clock.
  showHistoryStatus(charging);
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));

  // A genuinely missing record never prices: yesterday's kWh has no covering
  // session and no live window over it, and today's live pricing carries the
  // figure alone.
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
});

test('a resumed block carries its residual tail and reconciles with the Status figure', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 1); // 01:00 Sunday 18 October
  const descriptor = periodById('week');
  const docs = [
    { id: '2026-10-17', kwh: 1 },
    { id: '2026-10-18', kwh: 1 },
  ];
  applyHistory(descriptor, { docs, fromCache: false }, null, today, []);
  showHistorySettings(nightly());
  // The #128 shape on the midnight pattern: 23:00 Saturday → 01:00 Sunday at
  // 2 kWh, paused at midnight and resumed at the record's own end — a
  // zero-idle tail. The Status tab prices the full window: 1 kWh at the base
  // then 1 kWh off-peak.
  const charging = statusAt(3, today.getTime(), 7200, 2000);
  assert.equal(statusCostLabel(charging, nightly()), fmtMoney(0.4, 'GBP'));
  showHistoryStatus(charging);
  assert.equal(element('history-cost').textContent, fmtMoney(0.4, 'GBP'));

  // The pause edge's merged record lands (the settle read's payload): the
  // first hour is now the record's to price, and the estimate shrinks to the
  // residual tail instead of dropping — history keeps reconciling with the
  // Status figure exactly, where pre-#128 it hid beside the record.
  const recorded = {
    id: '1765789200',
    wh: 1000,
    started_at: new Date(2026, 9, 17, 23),
    ended_at: new Date(2026, 9, 18, 0),
  };
  applyHistory(descriptor, { docs, fromCache: false }, null, today, [recorded]);
  showHistorySettings(nightly());
  assert.equal(element('history-cost').textContent, fmtMoney(0.4, 'GBP'));
  // Today's bar carries only its own slice of it (the current slot is
  // selected): the off-peak hour after midnight.
  assert.equal(element('chart-cost').textContent, fmtMoney(0.1, 'GBP'));
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

test('a settle that lands while the tab is hidden is caught up on the return visit', async () => {
  resetHistory();
  enterHistory();
  // The real boot: the first visit reads through loadAll, which is what marks
  // the screen loaded and pins the midnight window — the state the direct
  // applyHistory seam never touches. In Node the read genuinely rejects, and
  // the apply step below is the payload it would have delivered.
  await fire('history-refresh', 'click');
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

  // A newer charging write while hidden paints nothing — the catch-up render
  // belongs to the return visit, and it is the else branch of the settle arm:
  // no edge queued, so activateHistory only renders.
  element('panel-history').hidden = true;
  showHistoryStatus(statusAt(3, today.getTime() + 60_000, 7440, 1030));
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
  element('panel-history').hidden = false;
  activateHistory();
  assert.equal(element('history-cost').textContent, fmtMoney(0.31, 'GBP'));

  // The stopped push queues the settle while hidden; the return visit spends
  // it through activateHistory — the loading copy readHistory paints before
  // it fetches is the proof the re-read fired.
  element('panel-history').hidden = true;
  showHistoryStatus(statusAt(1, today.getTime() + 120_000, 7440, 1030));
  element('panel-history').hidden = false;
  activateHistory();
  assert.match(element('chart-empty-title').textContent, /Loading/);
  await readFailed();

  // The retried write has committed: the settle read's payload — driven
  // through the same apply seam — prices the recorded session exactly once,
  // the same number the estimate promised.
  const recorded = {
    id: '1765792920',
    wh: 1030,
    started_at: new Date(2026, 9, 18, 9, 58),
    ended_at: new Date(2026, 9, 18, 12, 2),
  };
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [recorded],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost').textContent, fmtMoney(0.31, 'GBP'));
  assert.equal(element('history-total').textContent, '1.00');

  // The settle armed the verification re-read; a hidden push holds it, and
  // the return visit — not the next push — spends it.
  element('panel-history').hidden = true;
  showHistoryStatus(statusAt(1, today.getTime() + 180_000, 7440, 1030));
  assert.equal(element('history-total').textContent, '1.00');
  element('panel-history').hidden = false;
  activateHistory();
  assert.match(element('chart-empty-title').textContent, /Loading/);
  await readFailed();
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [recorded],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-total').textContent, '1.00');

  // Both flags are spent: another return visit re-renders, never re-reads —
  // a read would have cleared the total synchronously.
  activateHistory();
  assert.equal(element('history-total').textContent, '1.00');
  assert.equal(element('history-cost').textContent, fmtMoney(0.31, 'GBP'));
});

// ---------- paging the window (#154) ----------
//
// The window arithmetic and the copy registers are pure (history.test.js); this
// section drives the screen's wiring through the same DOM stub: the controls'
// disabled rule, the offset reset on a period switch, both key behaviours, and
// the copy the paged window paints. The read itself still genuinely rejects (no
// Firestore bindings), so the paged wording is asserted on the registers that
// are reachable — the loading panel and the empty panel — which come from the
// same `copy(span)` the offline line does; the offline line's paged wording is
// pinned at the pure layer.
//
// The clock is frozen for these tests because the read paths build their window
// from the real `new Date()`: a fixed clock makes the paged spans exact.

const PAGED_NOW = new Date(2026, 9, 18, 12).getTime();

function freezeClock(at = PAGED_NOW) {
  mock.timers.enable({ apis: ['Date'], now: at });
}

// Fire one keydown the way the document delivers it: to the focused element and
// then up its ancestors. The chart's keys live in two places — the selection keys
// on the SVG, the paging keys on the card that holds the SVG and its pager — so a
// key aimed at a chart descendant is offered to that element's listeners and then
// to the card's, and the return value reports whether either consumed it.
function keydown(target, key, mods = {}) {
  let prevented = false;
  const event = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    ...mods,
  };
  const path = target === 'chart-card' ? ['chart-card'] : [target, 'chart-card'];
  for (const id of path) {
    for (const listener of element(id).listeners.get('keydown') || []) listener(event);
  }
  return prevented;
}

// Model the one nesting the screen's focus checks ask about: a bar lives in
// #chart-bars, which lives in the SVG. (#chart-card is the stub's boundary, so
// the tests ask about it directly — see inCard.)
function modelChartContainment() {
  element('history-chart').contains = (node) =>
    node === element('history-chart') || element('chart-bars').children.includes(node);
}

// Everything a press can reach from inside the chart card: the pager buttons, the
// SVG and its bars. <body> is in nothing, so a press that arrives after the focus
// was dropped reaches no listener and is the browser's key — the scroll this
// screen's focus continuity exists to prevent.
function inCard(node) {
  return (
    node === element('chart-card') ||
    node === element('chart-prev') ||
    node === element('chart-next') ||
    node === element('history-chart') ||
    element('chart-bars').children.includes(node)
  );
}

// Fire a key from wherever the focus actually is, the way the document does: the
// focused element receives it, then its ancestors. Returns whether the screen
// consumed it — `false` means no listener ran, which for a paging key is a page
// scroll.
function pressFromFocus(key) {
  const at = document.activeElement;
  if (at === element('chart-prev')) return keydown('chart-prev', key);
  if (at === element('chart-next')) return keydown('chart-next', key);
  if (at === element('chart-card')) return keydown('chart-card', key);
  if (at === element('history-chart') || element('chart-bars').children.includes(at)) {
    return keydown('history-chart', key);
  }
  return false;
}

// A settled Week at the default view with its bars drawn: the state a keyboard
// pager starts from. (The read paths themselves always reject in Node, so the
// drawn window is applied through the fetch→apply seam.)
async function showDrawnWeek() {
  resetHistory();
  enterHistory();
  element('period-switch').contains = () => true;
  const click = element('period-switch').listeners.get('click')[0];
  await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
  await readFailed();
  const now = new Date(PAGED_NOW);
  applyHistory(
    periodById('week'),
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    now,
    [],
    now,
  );
  showHistorySettings({ rate: 0.25, currency: 'GBP' });
}

// Date spans glue their runs with hard spaces, leaving one breakable space after
// the dash; compare painted copy as plain text.
function plain(text) {
  return String(text).replace(/\u00a0/g, ' ');
}

function labelText() {
  return plain(element('history-total-label').textContent);
}

test('the default view paints exactly the strings it always has', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    // Byte-identical to the pre-paging screen: summary label, its aria-label,
    // the SVG label and the heading.
    assert.equal(element('history-total-label').textContent, 'Last 30 days');
    assert.equal(element('history-summary').attrs['aria-label'], 'Last 30 days summary');
    assert.equal(
      element('history-chart').attrs['aria-label'],
      'Daily energy for the last 30 days. Use the left and right arrow keys to move between days.',
    );
    assert.equal(element('chart-heading').textContent, 'Daily energy');
    // Next cannot reach the future; Previous pages back from the present.
    assert.equal(element('chart-next').disabled, true);
    assert.equal(element('chart-prev').disabled, false);
    assert.equal(element('chart-prev').attrs['aria-label'], 'Previous 30 days');
    assert.equal(element('chart-next').attrs['aria-label'], 'Next 30 days');
  } finally {
    mock.timers.reset();
  }
});

test('Previous pages one window back and Next returns to the default view', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    const back = fire('chart-prev', 'click');
    // The window is built before the read is awaited, so the control state and
    // the paged loading copy are painted synchronously.
    assert.equal(element('chart-next').disabled, false);
    assert.equal(labelText(), '20 Aug – 18 Sep 2026');
    assert.equal(
      plain(element('history-summary').attrs['aria-label']),
      'Energy summary for 20 August – 18 September 2026',
    );
    assert.equal(
      plain(element('history-chart').attrs['aria-label']),
      'Daily energy for 20 August – 18 September 2026. Use the left and right arrow keys to move between days.',
    );
    assert.equal(
      plain(element('chart-empty-line').textContent),
      'Reading 20 August – 18 September 2026.',
    );
    await back;
    await readFailed();
    // One more window back: the 30 days ending 30 days before the previous one.
    await fire('chart-prev', 'click');
    await readFailed();
    assert.equal(labelText(), '21 Jul – 19 Aug 2026');
    // Next walks back toward the present one window at a time.
    await fire('chart-next', 'click');
    await readFailed();
    assert.equal(labelText(), '20 Aug – 18 Sep 2026');
    assert.equal(element('chart-next').disabled, false);
    await fire('chart-next', 'click');
    await readFailed();
    assert.equal(element('history-total-label').textContent, 'Last 30 days');
    assert.equal(element('chart-next').disabled, true);
    // Next at the present is inert: no window beyond it, and no re-read.
    await fire('chart-next', 'click');
    assert.equal(element('history-total-label').textContent, 'Last 30 days');
    assert.doesNotMatch(element('chart-empty-title').textContent, /Loading/);
  } finally {
    mock.timers.reset();
  }
});

test('a paged window names its dates everywhere and never says today', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    await fire('chart-prev', 'click');
    await readFailed();
    const label = labelText();
    assert.equal(label, '20 Aug – 18 Sep 2026');
    // Chart, summary, SVG label and heading — none may claim a window they are
    // not drawing.
    for (const [what, text] of Object.entries({
      'summary label': label,
      'summary aria-label': element('history-summary').attrs['aria-label'],
      'chart aria-label': element('history-chart').attrs['aria-label'],
      heading: element('chart-heading').textContent,
      'loading line': element('chart-empty-line').textContent,
    })) {
      assert.ok(text, what);
      assert.doesNotMatch(text, /today|last 7 days|last 30 days|last 12 months/i, what);
    }
    // Accessible names use the prose register of the same span, so a screen
    // reader hears the months spelled out.
    for (const text of Object.values({
      'summary aria-label': element('history-summary').attrs['aria-label'],
      'chart aria-label': element('history-chart').attrs['aria-label'],
    })) {
      assert.ok(plain(text).includes('20 August – 18 September 2026'), text);
    }

    // The empty panel names the same window — the offline line is the same
    // copy(span) source (its paged wording is pinned in history.test.js).
    const now = new Date(PAGED_NOW);
    const anchor = periodAnchor('month', 1, now);
    const descriptor = periodById('month');
    applyHistory(descriptor, { docs: [], fromCache: false }, null, anchor, [], now);
    showHistorySettings(nightly());
    assert.equal(
      plain(element('chart-empty-title').textContent),
      'No energy recorded for 20 August – 18 September 2026.',
    );
    // An empty window is still a window: the paging controls stay on screen, so
    // the owner can page back out of it.
    assert.equal(element('chart-head').hidden, false);
    assert.equal(element('chart-next').disabled, false);
    assert.equal(element('chart-prev').disabled, false);
    // Its readout names no bar from the window that was on screen before.
    assert.equal(element('chart-day').textContent, '—');
    assert.equal(element('chart-kwh').textContent, '—');

    // A cached miss in the same window paints that window's offline copy — the
    // one changed branch (renderHistory's offline message) the empty read cannot
    // reach — and leaves none of the previous window's bars behind.
    applyHistory(descriptor, { docs: [], fromCache: true }, null, anchor, [], now);
    showHistorySettings(nightly());
    assert.equal(
      plain(element('chart-empty-line').textContent),
      'Reconnect, then tap Refresh to load the energy for 20 August – 18 September 2026.',
    );
    assert.equal(element('chart-bars').children.length, 0);

    // A paged window's readout names its own newest bucket (no bucket in it is
    // current, so the newest is selected) and still prices its $.
    applyHistory(
      descriptor,
      { docs: [{ id: '2026-09-18', kwh: 2 }], fromCache: false },
      null,
      anchor,
      [],
      now,
    );
    showHistorySettings({ rate: 0.25, currency: 'GBP' });
    assert.equal(element('chart-day').textContent, dayLabel('2026-09-18'));
    assert.doesNotMatch(element('chart-day').textContent, /Today/);
    assert.equal(element('history-total').textContent, '2.00');
    assert.equal(element('history-cost').textContent, fmtMoney(0.5, 'GBP'));

    // The live contribution's gate stays closed: no bucket of a past window is
    // current, so a charging push cannot price it — under a schedule the window
    // has no covering session and no live figure, where the same push on the
    // default view shows one (the #126 tests above).
    showHistorySettings(nightly());
    assert.equal(element('history-cost-cell').hidden, true);
    showHistoryStatus(statusAt(3, PAGED_NOW, 7200, 1000));
    assert.equal(element('history-cost-cell').hidden, true);
    assert.equal(element('chart-cost').textContent, '');
  } finally {
    mock.timers.reset();
  }
});

test('the hint names only what the state on screen offers', async () => {
  const PAGING_HINT = 'Use ‹ › or PageUp/PageDown to page';
  const BARS_HINT = 'Tap or ← → · PageUp/PageDown pages';
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    // Loading paints no bars, so nothing is there to tap or arrow through: the
    // hint names the pager that does work from here.
    assert.equal(element('chart-hint').textContent, PAGING_HINT);
    await readFailed();
    // A failed read is still an empty chart, and paging out of it still works.
    assert.equal(element('chart-hint').textContent, PAGING_HINT);
    // Bars on screen: the selection keys join the pager.
    const now = new Date(PAGED_NOW);
    const descriptor = periodById('month');
    applyHistory(
      descriptor,
      { docs: [{ id: '2026-10-18', kwh: 2 }], fromCache: false },
      null,
      now,
      [],
      now,
    );
    showHistorySettings(nightly());
    assert.equal(element('chart-hint').textContent, BARS_HINT);
    // The selection clause leaves with the bars.
    applyHistory(
      descriptor,
      { docs: [], fromCache: false },
      null,
      periodAnchor('month', 1, now),
      [],
      now,
    );
    showHistorySettings(nightly());
    assert.equal(element('chart-hint').textContent, PAGING_HINT);
  } finally {
    mock.timers.reset();
  }
});

test('paging back to the present hands focus from Next to Previous', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    await fire('chart-prev', 'click');
    await readFailed();
    assert.equal(element('chart-next').disabled, false);
    // A keyboard user activates Next while it owns the focus; the read that
    // returns to offset 0 disables it, which would otherwise drop focus to
    // <body> and restart the next Tab at the top of the page.
    element('chart-next').focus();
    assert.equal(document.activeElement, element('chart-next'));
    const back = fire('chart-next', 'click');
    assert.equal(element('chart-next').disabled, true);
    assert.equal(document.activeElement, element('chart-prev'));
    await back;
    await readFailed();
    // The handoff survives the settle: the default view keeps the focus.
    assert.equal(element('chart-next').disabled, true);
    assert.equal(document.activeElement, element('chart-prev'));
  } finally {
    mock.timers.reset();
  }
});

test('switching period returns the chart to the default view', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    await fire('chart-prev', 'click');
    await readFailed();
    await fire('chart-prev', 'click');
    await readFailed();
    assert.equal(labelText(), '21 Jul – 19 Aug 2026');

    // The real segment listener: a Week switch resets the offset and renames the
    // paging controls for the unit it now pages in.
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    assert.equal(element('history-total-label').textContent, 'Last 7 days');
    assert.equal(element('chart-next').disabled, true);
    assert.equal(element('chart-prev').attrs['aria-label'], 'Previous 7 days');
    assert.equal(element('chart-next').attrs['aria-label'], 'Next 7 days');
    await readFailed();

    // Back to Month: offset 0 again, not the offset it was left on.
    await click({ target: { closest: () => ({ dataset: { period: 'month' } }) } });
    assert.equal(element('history-total-label').textContent, 'Last 30 days');
    assert.equal(element('chart-next').disabled, true);
    await readFailed();
  } finally {
    mock.timers.reset();
  }
});

test('PageUp and PageDown page the window while the arrows move the selection', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    // The real segment listener puts the screen on Week: paging is the
    // selected period's own unit.
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    await readFailed();
    const now = new Date(PAGED_NOW);
    const descriptor = periodById('week');
    applyHistory(
      descriptor,
      { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
      null,
      now,
      [],
      now,
    );
    showHistorySettings({ rate: 0.25, currency: 'GBP' });
    // Today's bucket is selected and prefixed; ←/→ still move the selection
    // inside the rendered window, exactly as H.10/H.17 require.
    assert.equal(element('chart-day').textContent, 'Today · Sun 18 Oct');
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    assert.equal(element('chart-day').textContent, 'Sat 17 Oct');
    assert.equal(keydown('history-chart', 'ArrowRight'), true);
    assert.equal(element('chart-day').textContent, 'Today · Sun 18 Oct');
    // A modified arrow is the browser's, never the screen's.
    assert.equal(keydown('history-chart', 'ArrowLeft', { shiftKey: true }), false);
    assert.equal(element('chart-day').textContent, 'Today · Sun 18 Oct');

    // PageUp pages the window back one week; the new window names its dates.
    assert.equal(keydown('history-chart', 'PageUp'), true);
    assert.equal(labelText(), '5 – 11 Oct 2026');
    await readFailed();
    // PageDown pages toward the present, and stops at it.
    assert.equal(keydown('history-chart', 'PageDown'), true);
    assert.equal(element('history-total-label').textContent, 'Last 7 days');
    await readFailed();
    // At the present PageDown moves nothing, so it is the browser's key again:
    // consuming it would swallow a scroll for an action that does not happen.
    assert.equal(keydown('history-chart', 'PageDown'), false);
    assert.equal(element('history-total-label').textContent, 'Last 7 days');
  } finally {
    mock.timers.reset();
  }
});

test('PageUp pages twice in a row from inside the chart, keeping its focus', async () => {
  freezeClock();
  modelChartContainment();
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    await readFailed();
    const now = new Date(PAGED_NOW);
    const descriptor = periodById('week');
    applyHistory(
      descriptor,
      { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
      null,
      now,
      [],
      now,
    );
    showHistorySettings({ rate: 0.25, currency: 'GBP' });
    // A keyboard user arrives on the roving bar (Tab, an arrow press or a click).
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    const bars = () => element('chart-bars').children.slice(1);
    assert.equal(bars().includes(document.activeElement), true);

    // First press: paging crops the chart for the read, so the focused bar is
    // removed with it. The window still pages.
    assert.equal(keydown('history-chart', 'PageUp'), true);
    assert.equal(labelText(), '5 – 11 Oct 2026');
    await readFailed();
    // The settled window handed the focus back inside the card rather than letting
    // it fall to <body> — this window drew no bars (the read failed), so it rests
    // on the pager, which is in the card and still hears the key.
    assert.equal(document.activeElement, element('chart-prev'));

    // Second press, with no re-Tab in between, pages again: the advertised
    // two-windows-back interaction works from the keyboard.
    assert.equal(keydown('chart-prev', 'PageUp'), true);
    assert.equal(labelText(), '28 Sep – 4 Oct 2026');
    await readFailed();
    assert.equal(document.activeElement, element('chart-prev'));
    assert.equal(labelText(), '28 Sep – 4 Oct 2026');
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a press during a paged read keeps the focus in the card and pages again', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    // A keyboard user arrives on the roving bar.
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    assert.equal(inCard(document.activeElement), true);

    // First press: the read starts, and its loading paint removes the focused bar
    // before the fetch has settled.
    assert.equal(pressFromFocus('PageUp'), true);
    assert.equal(labelText(), '5 – 11 Oct 2026');
    // The focus is already on a control inside the card, so a press arriving
    // mid-read reaches the paging keys instead of scrolling the viewport.
    assert.notEqual(document.activeElement, document.body);
    assert.equal(inCard(document.activeElement), true);

    // A second press, typed before the first read settles, pages a second window.
    assert.equal(pressFromFocus('PageUp'), true);
    assert.equal(labelText(), '28 Sep – 4 Oct 2026');

    // The read that lands is the newest one and it owns the settle focus. This
    // window drew no bars, so the focus rests on the pager — the documented
    // fallback — rather than being left on <body>.
    await readFailed();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(labelText(), '28 Sep – 4 Oct 2026');
    assert.notEqual(document.activeElement, document.body);
    assert.equal(document.activeElement, element('chart-prev'));
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a Refresh during a paged read hands the focus back inside the card', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    // Start a paged read from the keyboard…
    assert.equal(pressFromFocus('PageUp'), true);
    assert.equal(inCard(document.activeElement), true);
    // …and supersede it with a Refresh. The paged read returns without painting,
    // so the reload's repaint is the one that has to hand the focus back.
    const refreshed = fire('history-refresh', 'click');
    await refreshed;
    await readFailed();
    for (let i = 0; i < 5; i++) await settle();
    assert.notEqual(document.activeElement, document.body);
    assert.equal(document.activeElement, element('chart-prev'));
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a repaint under a keyboard user focuses the bar the window selected', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    const bars = () => element('chart-bars').children.slice(1);
    assert.equal(bars().length, 7);
    // Land on a bar, then let a settings push repaint the chart beneath it: the
    // branch the failed-read tests cannot reach, because they draw no bars.
    bars()[3].focus();
    assert.equal(bars().includes(document.activeElement), true);
    showHistorySettings(nightly());
    const selected = bars().find((bar) => bar.classList.contains('selected'));
    assert.ok(selected, 'the window selects a bar');
    // The focus returns to that bar — not to the pager, and not to a neighbour an
    // off-by-one would pick.
    assert.equal(document.activeElement, selected);
    assert.notEqual(document.activeElement, element('chart-prev'));
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

// Every full reload (loadAll) paints "Refreshing…" on the Refresh control exactly
// once; the screen's other reads do not. The stub's textContent is a plain
// property, so a setter counts them without touching the module under test. A
// guard that never rests reloads in a microtask chain that starves the timers, so
// passing `reloadLimit` fails the run instead of hanging it.
const reloads = [];
let reloadLimit = Infinity;
{
  const button = element('history-refresh');
  let value = button.textContent;
  Object.defineProperty(button, 'textContent', {
    configurable: true,
    get: () => value,
    set(next) {
      value = String(next);
      if (value !== 'Refreshing…') return;
      reloads.push(value);
      if (reloads.length > reloadLimit) {
        throw new Error(`the midnight guard never rested (${reloads.length} reloads)`);
      }
    },
  });
}

test('a paged read that settles after local midnight reloads exactly once', async () => {
  // The guard asks which day the window was anchored to, never which day its
  // range ends: a paged window's last day is always in the past, so comparing
  // that (`bounds.endId !== dayId(now)`) would mark every paged read permanently
  // stale and re-enter it forever — an unbounded read loop on any paged window.
  freezeClock(new Date(2026, 9, 18, 23, 59, 40).getTime());
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    await readFailed();
    const before = reloads.length;
    reloadLimit = before + 20;
    // Build the paged window on the 18th…
    const paging = fire('chart-prev', 'click');
    assert.equal(labelText(), '5 – 11 Oct 2026');
    // …and let the clock cross local midnight before the read settles.
    mock.timers.setTime(new Date(2026, 9, 19, 0, 0, 20).getTime());
    await paging;
    await readFailed();
    for (let i = 0; i < 5; i++) await settle();
    // Exactly one re-entry, and it rebuilt the same paged offset from the new day.
    assert.equal(reloads.length - before, 1);
    assert.equal(labelText(), '6 – 12 Oct 2026');
    // The guard then rests: the re-entry captured today's anchor, so no further
    // reload follows however many turns pass.
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(reloads.length - before, 1);
  } finally {
    mock.timers.reset();
  }
});

test('the default read that settles after local midnight reloads exactly once', async () => {
  freezeClock(new Date(2026, 9, 18, 23, 59, 40).getTime());
  try {
    resetHistory();
    enterHistory();
    const before = reloads.length;
    reloadLimit = before + 20;
    const first = fire('history-refresh', 'click');
    mock.timers.setTime(new Date(2026, 9, 19, 0, 0, 20).getTime());
    await first;
    await readFailed();
    for (let i = 0; i < 5; i++) await settle();
    // The read itself, then exactly one re-entry for the new day.
    assert.equal(reloads.length - before, 2);
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(reloads.length - before, 2);
  } finally {
    mock.timers.reset();
  }
});

test('paging clears the previous window before the new read settles', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    await readFailed();
    const now = new Date(PAGED_NOW);
    const descriptor = periodById('week');
    applyHistory(
      descriptor,
      { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
      null,
      now,
      [],
      now,
    );
    showHistorySettings({ rate: 0.25, currency: 'GBP' });
    // Seven bars plus the base line.
    assert.equal(element('chart-bars').children.length, 8);
    const page = fire('chart-prev', 'click');
    // The previous window's bars are gone before the read is awaited, so an
    // offline cache miss cannot leave them on screen under the new labels.
    assert.equal(element('chart-bars').children.length, 0);
    assert.equal(element('history-total').textContent, '—');
    await page;
    await readFailed();
  } finally {
    mock.timers.reset();
  }
});
