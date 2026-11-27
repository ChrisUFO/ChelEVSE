import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dayId,
  dayLabel,
  periodAnchor,
  periodById,
  periodBounds,
  periodSeries,
  periodSpan,
  sessionsRange,
} from '../../web/js/history.js';
import { statusCostLabel, windowCostSummary } from '../../web/js/cost.js';
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
  periodReads,
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

test('the chart month and the sessions browser name the same calendar month', () => {
  // #155's cross-screen claim: one meaning for a month. The chart's October 2026
  // window and the picker's `2026-10` are the same calendar month, so the two
  // controls can never describe different 30-day spans.
  const now = new Date(2026, 10, 16, 12);
  const anchor = periodAnchor('month', 1, now); // October 2026, one page back
  const bounds = periodBounds('month', anchor, now);
  const range = monthRange('2026-10');
  assert.equal(dayId(range.start), bounds.startId);
  // The picker's range is half-open, so the chart's last day is the day before
  // its end.
  const after = new Date(range.end);
  after.setDate(after.getDate() - 1);
  assert.equal(dayId(after), bounds.endId);
  assert.equal(plain(periodSpan('month', anchor, now).label), 'October 2026');
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

// ---------- the plan banner's copy (#188) ----------
//
// The predicate (showPlanBanner) is pinned pure in test/web/history.test.js;
// this executes the paint that carries its words. The banner keeps appearing
// while any instant sits outside every window — transparency about the gap —
// but since #188 such an instant costs the stored flat rate, so the copy says
// so; only a missing fallback keeps the 0.00 sentence.

test('the plan banner names the flat fallback, or 0.00 only when none is stored', () => {
  resetHistory();
  enterHistory();
  const summer = {
    id: 'summer',
    rate: 0.2,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '00:00',
    months: [5, 6, 7, 8, 9],
    from: '06-15',
    to: '09-15',
  };

  // A finite flat rate prices the gap: the banner appears and names it.
  showHistorySettings({ rate: 0.12, currency: 'USD', rates: [summer] });
  assert.equal(element('history-plan-banner').hidden, false);
  assert.equal(
    element('history-plan-banner-text').textContent,
    'Some dates or hours fall outside every season window and are priced at your flat rate USD 0.12.',
  );

  // The same rows with no finite flat rate are genuinely unpriced: 0.00 copy.
  showHistorySettings({ currency: 'USD', rates: [summer] });
  assert.equal(element('history-plan-banner').hidden, false);
  assert.equal(
    element('history-plan-banner-text').textContent,
    'Some dates or hours have no price and are shown at 0.00.',
  );

  // A plan with no gap hides the banner whatever the flat rate.
  showHistorySettings(nightly());
  assert.equal(element('history-plan-banner').hidden, true);
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
  // #210: the Day period reads the archive through the same widened window a
  // range does — the read derives from the bounds alone, so the Day payload
  // is whatever the archive answers, never a period-shaped constant.
  const seen = [];
  const readRange = async (range) => {
    seen.push(range);
    return { docs: [], fromCache: false };
  };
  assert.deepEqual(await fetchPeriodSessions(periodById('day'), bounds, readRange), []);
  assert.deepEqual(seen, [sessionsRange(bounds)]);
  // A range period with no derivable window (malformed bounds) reads nothing.
  assert.deepEqual(await fetchPeriodSessions(periodById('week'), {}, fail), []);
  // A rejected range read rejects — the callers' allSettled fallback owns the
  // empty payload, so the fetch itself must not swallow the failure. The Day
  // period rejects the same way: its read is the same read.
  await assert.rejects(fetchPeriodSessions(periodById('week'), bounds, fail), /offline/);
  await assert.rejects(fetchPeriodSessions(periodById('day'), bounds, fail), /offline/);
});

// ---------- the summary's coverage disclosure, executed (#194) ----------
//
// The same seam as the pricing pass above, on the live case the issue was
// filed on (19 Nov 2026): the week of Mon 16 – Thu 19 Nov holds 48.1 kWh of
// day documents while the counter-reset plug-in's failed reconciliation
// leaves the aggregate pricing 13.7 kWh of it. The rendered cost cell must
// carry the disclosure under the figure, on its own small muted line; the
// pure math is pinned in history.test.js.

// The live plan shape: one all-day November season at 0.1127, with the same
// figure stored as the flat fallback.
function novemberPlan() {
  return {
    rate: 0.1127,
    currency: 'USD',
    rates: [
      {
        id: 'november',
        rate: 0.1127,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: [11],
      },
    ],
  };
}

test('a partially covered week renders the disclosure under the summary $', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 10, 19, 12); // Thursday 19 November 2026
  const descriptor = periodById('week');
  // Seven usable intervals summing to 48.038 kWh against the record's
  // 15.956 kWh `wh` — reconciliation fails, so the stored span's aggregate is
  // the pricing record, and only its in-window share (80 h of the 93.2 h
  // plug-in) lands inside the week.
  const reset = {
    id: '1795142880',
    wh: 15956,
    started_at: new Date(2026, 10, 15, 10, 48),
    ended_at: new Date(2026, 10, 19, 8),
    intervals: [
      {
        started_at: new Date(2026, 10, 15, 10, 48),
        ended_at: new Date(2026, 10, 15, 22),
        wh: 11800,
      },
      { started_at: new Date(2026, 10, 16), ended_at: new Date(2026, 10, 16, 8), wh: 8600 },
      { started_at: new Date(2026, 10, 16, 20), ended_at: new Date(2026, 10, 17, 4), wh: 7800 },
      { started_at: new Date(2026, 10, 17, 21), ended_at: new Date(2026, 10, 18, 5), wh: 7200 },
      { started_at: new Date(2026, 10, 18, 10), ended_at: new Date(2026, 10, 18, 18), wh: 6238 },
      { started_at: new Date(2026, 10, 18, 22), ended_at: new Date(2026, 10, 19, 2), wh: 3200 },
      { started_at: new Date(2026, 10, 19, 5), ended_at: new Date(2026, 10, 19, 8), wh: 3200 },
    ],
  };
  applyHistory(
    descriptor,
    {
      docs: [
        { id: '2026-11-16', kwh: 12.4 },
        { id: '2026-11-17', kwh: 11.8 },
        { id: '2026-11-18', kwh: 11.9 },
        { id: '2026-11-19', kwh: 12.0 },
      ],
      fromCache: false,
    },
    null,
    today,
    [reset],
  );
  showHistorySettings(novemberPlan());
  // USD 1.54 prices 13.7 kWh at 0.1127 — said on the #194 caption, the small
  // muted line under the figure. #210: the headline kWh is the pass's own
  // energy — what the figure prices — while the 48.1 the caption names stays
  // the day documents' own total, the basis the disclosure measures.
  assert.equal(element('history-cost-cell').hidden, false);
  assert.equal(element('history-cost').textContent, 'USD 1.54');
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 13.7 of 48.1 kWh');
  assert.equal(element('history-total').textContent, '13.7');
  // The bars take the pass's side of that compare (#226): each prints the
  // slice the reset session's aggregate pro-rate attributes to its day — three
  // flat 4.11 kWh bars and 1.37 for Thursday's eight hours inside the week —
  // never the 12.4 / 11.8 / 11.9 / 12.0 its day documents recorded, which only
  // the caption's 48.1 still counts. The one-figure rule is direction-neutral:
  // a day the archive attributes only part of prints the smaller slice beside
  // the $ it prices, and this caption is the whole disclosure.
  assert.deepEqual(
    drawnBars().map((bar) => bar.getAttribute('aria-label')),
    [
      'Mon 16 Nov: 4.11 kWh, USD 0.46',
      'Tue 17 Nov: 4.11 kWh, USD 0.46',
      'Wed 18 Nov: 4.11 kWh, USD 0.46',
      'Thu 19 Nov: 1.37 kWh, USD 0.15',
    ],
  );
});

test('one missing Wh renders the caption the tolerance band used to hide (#211)', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  applyHistory(
    periodById('week'),
    { docs: [{ id: '2026-10-18', kwh: 2 }], fromCache: false },
    null,
    today,
    // A session inside the day covering 1,999 of its 2,000 Wh.
    [{ wh: 1999, started_at: new Date(2026, 9, 18, 1), ended_at: new Date(2026, 9, 18, 3) }],
  );
  showHistorySettings(nightly());
  // The retired band's floor was 250 Wh, so this 1 Wh gap stayed silent
  // through #194. The caption now fires on any missing Wh: both figures read
  // alike at the caption's 0.01 kWh precision, so the line itself carries
  // the disclosure. The pure math is pinned in history.test.js.
  assert.equal(element('history-cost-cell').hidden, false);
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 2.00 of 2.00 kWh');
});

// (#210 honesty pin, the range shape) A window whose day documents recorded
// energy the span pass prices none of renders — as its kWh total, never a
// false 0.00 (which would read as free beside the recorded bar), with the $
// and the caption hidden beside it — the same maximal-divergence honesty the
// #194 caption gives partial divergence. The pure layer pins the pass's null
// cost in history.test.js; this pins what the screen does with it.
test('a week with recorded but unpriced energy renders — as its total (#210)', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  applyHistory(
    periodById('week'),
    { docs: [{ id: '2026-10-18', kwh: 2 }], fromCache: false },
    null,
    today,
    // No session overlaps the window, so nothing prices the recorded 2 kWh.
    [],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-total').textContent, '—');
  assert.equal(element('history-cost-cell').hidden, true);
  assert.equal(element('history-cost-coverage').hidden, true);
  // The bar still draws the recorded energy: the archive lost its pricing,
  // not the reading.
  assert.equal(element('chart-empty').hidden, true);

  // The same unpriced window under a gapped plan: the #193 note painted above
  // must hide with the figures it would describe (mirroring the no-data
  // branch), never stand alone beside — naming the pricing of a total the
  // summary refuses to show — the "shown at 0.00" wording literally so.
  showHistorySettings(expiredSeasonPlan());
  assert.equal(element('history-total').textContent, '—');
  assert.equal(element('history-cost-cell').hidden, true);
  assert.equal(element('history-window-note').hidden, true);
});

// (#210 decision, pinned) The Day period's no-intraday $-hiding escape is
// REMOVED: it existed because the $ needed the hours map, and the session
// archive genuinely covers that case — it predates hourly capture — so a day
// with a total but no hours prices from sessions under a schedule, while the
// flat path keeps the day document's total byte-identically.
test('a day with a total but no hours prices from the session basis (#210)', async () => {
  resetHistory();
  enterHistory();
  // Put the screen on the Day period through its real listener; the read it
  // starts rejects in Node as usual, and the apply step below is the payload
  // that read would deliver.
  element('period-switch').contains = () => true;
  const switchClick = element('period-switch').listeners.get('click')[0];
  await switchClick({ target: { closest: () => ({ dataset: { period: 'day' } }) } });
  await readFailed();
  const doc = { id: '2026-11-05', exists: true, kwh: 4.2, hours: null, fromCache: false };
  applyHistory(periodById('day'), doc, null, new Date(2026, 10, 5, 12), []);
  showHistorySettings(nightly());
  // The no-intraday panel still owns the chart — the hours were never
  // recorded and must not draw as 24 zero bars.
  assert.match(element('chart-empty-title').textContent, /No hourly detail/);
  // Nothing prices the day's recorded energy yet, so both figures hide — the
  // $ by the hide-not-misprice rule (not the old hours-map escape) and the
  // kWh with it: a 0.00 there would read as free beside the 4.2 the document
  // recorded, so the headline renders the app's unknown (—) instead.
  assert.equal(element('history-total').textContent, '—');
  assert.equal(element('history-cost-cell').hidden, true);
  // A covering session shows the day's real figures: the archive's 4.2 kWh
  // off-peak, with no caption (covered meets the day document's own total).
  applyHistory(periodById('day'), doc, null, new Date(2026, 10, 5, 12), [
    { wh: 4200, started_at: new Date(2026, 10, 5, 1), ended_at: new Date(2026, 10, 5, 3) },
  ]);
  showHistorySettings(nightly());
  assert.match(element('chart-empty-title').textContent, /No hourly detail/);
  assert.equal(element('history-total').textContent, '4.20');
  assert.equal(element('history-cost').textContent, fmtMoney(0.42, 'GBP'));
  assert.equal(element('history-cost-coverage').hidden, true);
  // Flat keeps the day document's own total and its flat cost, exactly as
  // before schedules existed.
  showHistorySettings({ rate: 0.25, currency: 'GBP' });
  assert.equal(element('history-total').textContent, '4.20');
  assert.equal(element('history-cost').textContent, 'GBP 1.05');
});

// ---------- the day-verdict caption, executed (#212) ----------
//
// The same fetch→apply seam as the pricing pass, with the read's
// reconciliation marker beside the payload: a window whose every day is
// verdict-settled takes its caption from the bridge's per-day `gap_wh`
// verdicts (the pure classification and caption decision are pinned in
// history.test.js), and anything the marker cannot vouch for keeps the
// #211 attribution compare above. The settled fixtures sit a week back from
// the clock so no day is inside the reconciler's trailing deferral window.

// The week of Mon 2 – Sun 8 Nov 2026: every day at or after the marker
// ('2026-11-01') and eleven days before the clock (Thu 19 Nov), with one
// plug-in covering the whole week so the attribution compare stays silent —
// whatever the caption shows is the verdict's alone. Days absent from
// `gaps` keep their document (its kWh rides in the series) with no verdict
// written: the reconciler's clean case.
function settledNovemberWeek(gaps) {
  const docs = [
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ].map((id) => {
    const doc = { id, kwh: 3 };
    if (gaps[id] !== undefined) doc.gap_wh = gaps[id];
    return doc;
  });
  return {
    docs,
    sessions: [
      { wh: 21000, started_at: new Date(2026, 10, 2, 1), ended_at: new Date(2026, 10, 8, 5) },
    ],
  };
}

test("a settled week's ≥10 Wh verdict renders the full caption the attribution missed", () => {
  resetHistory();
  enterHistory();
  const { docs, sessions } = settledNovemberWeek({ '2026-11-06': 4800 });
  applyHistory(
    periodById('week'),
    { docs, fromCache: false },
    null,
    new Date(2026, 10, 2, 12), // the window's anchor: Monday 2 November
    sessions,
    new Date(2026, 10, 19, 12), // the clock: Thursday 19 November
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  // The sessions cover the week's every kWh, so the #211 compare is silent
  // — the 4.8 kWh day verdict alone says its $ prices 16.2 of the 21 kWh
  // shown, on the same muted caption the compare uses.
  assert.equal(element('history-cost-cell').hidden, false);
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 16.2 of 21.0 kWh');
  assert.equal(element('history-total').textContent, '21.0');
});

test('a settled week of sub-10 Wh drift renders the quiet tolerance note', () => {
  resetHistory();
  enterHistory();
  const { docs, sessions } = settledNovemberWeek({ '2026-11-03': 3.1, '2026-11-05': 0.8 });
  applyHistory(
    periodById('week'),
    { docs, fromCache: false },
    null,
    new Date(2026, 10, 2, 12),
    sessions,
    new Date(2026, 10, 19, 12),
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  // Every verdict inside the two-meter drift band (owner decision
  // 2026-11-22): the full caption would cry wolf, so one muted line states
  // the 3.9 Wh net drift instead — never silence.
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(
    element('history-cost-coverage').textContent,
    'charger day meters differ by 0.004 kWh over this period — within meter tolerance',
  );
});

test('a clean settled week stays silent, even beside attribution noise', () => {
  resetHistory();
  enterHistory();
  // No verdicts written at all: the marker vouches the week clean, and the
  // exact same-basis verdict is the authority — so an attribution shortfall
  // the #211 compare would disclose (here: sessions covering 20 of the
  // 21 recorded kWh) is silenced rather than contradicted. The $ keeps its
  // own figure; only the caption is verdict-driven.
  const { docs } = settledNovemberWeek({});
  applyHistory(
    periodById('week'),
    { docs, fromCache: false },
    null,
    new Date(2026, 10, 2, 12),
    [{ wh: 20000, started_at: new Date(2026, 10, 2, 1), ended_at: new Date(2026, 10, 8, 5) }],
    new Date(2026, 10, 19, 12),
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost-cell').hidden, false);
  assert.equal(element('history-cost-coverage').hidden, true);
  assert.equal(element('history-cost-coverage').textContent, '');
});

test('any unverdictable day keeps the #211 attribution compare exactly', () => {
  // a) A period containing today: today itself is never verdicted (the
  //    reconciler defers the trailing window), so the current week falls
  //    back to the compare — honest: verdicts only vouch for settled days.
  resetHistory();
  enterHistory();
  const now = new Date(2026, 10, 19, 12);
  applyHistory(
    periodById('week'),
    {
      docs: [
        { id: '2026-11-16', kwh: 1, gap_wh: 0.5 },
        { id: '2026-11-17', kwh: 1 },
        { id: '2026-11-18', kwh: 1 },
        // Today: no verdict, inside the deferral window — unsettled.
        { id: '2026-11-19', kwh: 1 },
      ],
      fromCache: false,
    },
    null,
    now,
    [{ wh: 2000, started_at: new Date(2026, 10, 18, 1), ended_at: new Date(2026, 10, 18, 3) }],
    now,
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  // The compare fires on the 2 kWh no session covers — today's PR-1
  // behavior, verdicts aside.
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 2.00 of 4.00 kWh');

  // b) A legacy day before the marker: the week of 26 Oct straddles
  //    recon_from, and the days before it predate the verdicts.
  resetHistory();
  enterHistory();
  applyHistory(
    periodById('week'),
    {
      docs: [
        { id: '2026-10-26', kwh: 1 },
        { id: '2026-10-27', kwh: 1 },
        { id: '2026-10-28', kwh: 1 },
        { id: '2026-10-29', kwh: 1 },
        { id: '2026-10-30', kwh: 1 },
        { id: '2026-10-31', kwh: 1, gap_wh: 900 },
        { id: '2026-11-01', kwh: 1 },
      ],
      fromCache: false,
    },
    null,
    new Date(2026, 9, 26, 12),
    [{ wh: 4000, started_at: new Date(2026, 9, 27, 1), ended_at: new Date(2026, 9, 27, 3) }],
    now,
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost-coverage').textContent, 'priced 4.00 of 7.00 kWh');

  // c) A null-marked day inside an otherwise settled week: the reconciler
  //    said "not verdictable" out loud, so the verdicts cannot vouch.
  resetHistory();
  enterHistory();
  const { docs: nulled } = settledNovemberWeek({ '2026-11-04': null });
  applyHistory(
    periodById('week'),
    { docs: nulled, fromCache: false },
    null,
    new Date(2026, 10, 2, 12),
    [{ wh: 20000, started_at: new Date(2026, 10, 2, 1), ended_at: new Date(2026, 10, 8, 5) }],
    now,
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost-coverage').textContent, 'priced 20.0 of 21.0 kWh');
});

test('no marker means no verdicts: the attribution compare alone', () => {
  resetHistory();
  enterHistory();
  // The same ≥10 Wh verdict payload as the full-caption pin, applied with
  // no marker: the feature is off — a bridge without seam B keeps today's
  // behavior everywhere, and the fully covered week shows no caption.
  const { docs, sessions } = settledNovemberWeek({ '2026-11-06': 4800 });
  applyHistory(
    periodById('week'),
    { docs, fromCache: false },
    null,
    new Date(2026, 10, 2, 12),
    sessions,
    new Date(2026, 10, 19, 12),
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost-coverage').hidden, true);
  assert.equal(element('history-cost-coverage').textContent, '');
});

test("a paged settled day renders its verdict under the day's own summary", async () => {
  resetHistory();
  enterHistory();
  // The period switch is driven for real (the fetch→apply seam bypasses
  // the screen's periodId, and the Day period's hour bars only price
  // under the Day descriptor); the read itself rejects in Node as usual.
  element('period-switch').contains = () => true;
  const click = element('period-switch').listeners.get('click')[0];
  await click({ target: { closest: () => ({ dataset: { period: 'day' } }) } });
  await readFailed();
  // A past Sunday inside the marker, 11 days before the clock, whose archive
  // holds 1 kWh of the 3 the day document recorded: the Day period prices
  // the session basis (#210), so its coverage is comparable and the settled
  // verdict renders the range caption — the #218 Day carve-out is gone.
  const doc = {
    id: '2026-11-08',
    exists: true,
    kwh: 3,
    hours: { '02': 3 },
    gap_wh: 2000,
    fromCache: false,
  };
  const sessions = [
    { wh: 1000, started_at: new Date(2026, 10, 8, 1), ended_at: new Date(2026, 10, 8, 2) },
  ];
  applyHistory(
    periodById('day'),
    doc,
    null,
    new Date(2026, 10, 8, 12), // the paged day: Sunday 8 November
    sessions,
    new Date(2026, 10, 19, 12),
    { reconFrom: '2026-11-01' },
  );
  showHistorySettings(nightly());
  // The $ prices the session's off-peak kWh and the headline is the pass's
  // own energy; the verdict says the archive is missing 2 of the 3 recorded.
  assert.equal(element('history-cost').textContent, fmtMoney(0.1, 'GBP'));
  assert.equal(element('history-total').textContent, '1.00');
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 1.00 of 3.00 kWh');
  // The hour bars keep their own display pricing from the day document's
  // buckets — the chart's series, never the summary's basis. No bucket of a
  // past window is current, so the newest (23:00) is selected.
  assert.equal(element('chart-day').textContent, '23:00–24:00');
});

// ---------- the per-window rate-scope note, executed (#193) ----------
//
// The plan banner speaks for the saved plan (any gap, anywhere); the note
// beneath the summary speaks for the window on screen only. The predicate is
// pinned pure in history.test.js — this executes the paint and its copy,
// including the composition with the #194 disclosure above.

// The #188 plan shape: one all-day season base 15 June – 15 September, with
// the stored flat rate as the fallback every other instant prices at.
function expiredSeasonPlan(rate = 0.12) {
  return {
    rate,
    currency: 'USD',
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
}

test('a window no rate row covers renders the note naming the rate, or 0.00 (#193)', () => {
  resetHistory();
  enterHistory();
  // The screen's default period is Month, so the applied window is the month:
  // November 2026 through today, every instant of it outside the season.
  const today = new Date(2026, 10, 19, 12); // Thursday 19 November 2026
  applyHistory(
    periodById('month'),
    { docs: [{ id: '2026-11-18', kwh: 2 }], fromCache: false },
    null,
    today,
    [
      // One session wholly inside the day: 2 kWh, every instant off-season.
      { wh: 2000, started_at: new Date(2026, 10, 18, 1), ended_at: new Date(2026, 10, 18, 3) },
    ],
  );
  // The fallback prices the whole window: the note names it, beside a cost
  // figure that prices the session at that same flat rate.
  showHistorySettings(expiredSeasonPlan());
  assert.equal(element('history-window-note').hidden, false);
  assert.equal(
    element('history-window-note').textContent,
    'Part of this month prices at your flat rate USD 0.12.',
  );
  assert.equal(element('history-cost').textContent, 'USD 0.24');
  // The session covers the day's every kWh, so the #194 caption stays hidden:
  // the note below the card speaks, the figure stands alone.
  assert.equal(element('history-cost-coverage').hidden, true);
  // The plan-wide banner still applies its own predicate (the gap is real
  // even though this window prices): both speak, each about its own scope.
  assert.equal(element('history-plan-banner').hidden, false);

  // The same rows with no finite flat rate: the 0.00 vocabulary, and the
  // session genuinely prices at USD 0.00.
  showHistorySettings({ currency: 'USD', rates: expiredSeasonPlan().rates });
  assert.equal(
    element('history-window-note').textContent,
    'Part of this month has no price and is shown at 0.00.',
  );
  assert.equal(element('history-cost').textContent, 'USD 0.00');
});

test('a fully covered window under a gapped plan, and flat-only, keep the note hidden', () => {
  resetHistory();
  enterHistory();
  // A July month of the same expired-season plan: every instant row-priced,
  // while the plan's gap (the rest of the year) sits outside the window.
  applyHistory(
    periodById('month'),
    { docs: [{ id: '2026-07-21', kwh: 2 }], fromCache: false },
    null,
    new Date(2026, 6, 22, 12),
    [{ wh: 2000, started_at: new Date(2026, 6, 21, 1), ended_at: new Date(2026, 6, 21, 3) }],
  );
  showHistorySettings(expiredSeasonPlan());
  assert.equal(element('history-window-note').hidden, true);
  assert.equal(element('history-cost').textContent, 'USD 0.40'); // 2 kWh at the 0.20 season base
  // The plan banner still fires — the gap sits outside this window.
  assert.equal(element('history-plan-banner').hidden, false);

  // A flat-only plan flags nothing anywhere.
  showHistorySettings({ rate: 0.12, currency: 'USD' });
  assert.equal(element('history-window-note').hidden, true);
  assert.equal(element('history-plan-banner').hidden, true);
  assert.equal(element('history-cost').textContent, 'USD 0.24');
});

test('the rate-scope note composes with the coverage caption under the summary $', () => {
  // The #194 live case on a season that expires inside the window (through
  // Wednesday 18 November): the cost cell keeps its own sentence — which
  // energy the $ prices, on the small muted caption under the figure — and
  // the note adds the tariff scope of the window on its own subdued line
  // beneath the card; neither clobbers the other.
  resetHistory();
  enterHistory();
  const today = new Date(2026, 10, 19, 12); // Thursday 19 November 2026
  const reset = {
    id: '1795142880',
    wh: 15956,
    started_at: new Date(2026, 10, 15, 10, 48),
    ended_at: new Date(2026, 10, 19, 8),
    intervals: [
      {
        started_at: new Date(2026, 10, 15, 10, 48),
        ended_at: new Date(2026, 10, 15, 22),
        wh: 11800,
      },
      { started_at: new Date(2026, 10, 16), ended_at: new Date(2026, 10, 16, 8), wh: 8600 },
      { started_at: new Date(2026, 10, 16, 20), ended_at: new Date(2026, 10, 17, 4), wh: 7800 },
      { started_at: new Date(2026, 10, 17, 21), ended_at: new Date(2026, 10, 18, 5), wh: 7200 },
      { started_at: new Date(2026, 10, 18, 10), ended_at: new Date(2026, 10, 18, 18), wh: 6238 },
      { started_at: new Date(2026, 10, 18, 22), ended_at: new Date(2026, 10, 19, 2), wh: 3200 },
      { started_at: new Date(2026, 10, 19, 5), ended_at: new Date(2026, 10, 19, 8), wh: 3200 },
    ],
  };
  applyHistory(
    periodById('month'),
    {
      docs: [
        { id: '2026-11-16', kwh: 12.4 },
        { id: '2026-11-17', kwh: 11.8 },
        { id: '2026-11-18', kwh: 11.9 },
        { id: '2026-11-19', kwh: 12.0 },
      ],
      fromCache: false,
    },
    null,
    today,
    [reset],
  );
  // The stored span lies wholly inside the month, so its full 15.956 kWh is
  // attributed against the days' 48.1 — the #194 disclosure — while the
  // season and the fallback share 0.1127, so the $ keeps that one rate and
  // the note adds that the 19th's time is fallback-priced.
  showHistorySettings({
    rate: 0.1127,
    currency: 'USD',
    rates: [
      {
        id: 'november',
        rate: 0.1127,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: [11],
        from: '11-01',
        to: '11-18',
      },
    ],
  });
  assert.equal(element('history-cost').textContent, 'USD 1.80');
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 16.0 of 48.1 kWh');
  assert.equal(element('history-window-note').hidden, false);
  assert.equal(
    element('history-window-note').textContent,
    'Part of this month prices at your flat rate USD 0.1127.',
  );
});

test('a failed refresh over an empty window hides the note with the window it named (#193)', async () => {
  // The note is window-scoped, unlike the plan banner: it must die with the
  // window that earned it. A week the server answered with no documents still
  // draws (an empty range is a $0.00 range) and still flags its tariff scope;
  // the offline Refresh over it takes the branch that removes the window's
  // every figure — the note among them, or the screen would name a window the
  // presentation says isn't available. Driven exactly as triggered: a server
  // answer, then a failed read that retains the zero series.
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    // October lies wholly outside the summer season, so the week's every
    // bucket prices at the stored flat rate.
    showHistorySettings(expiredSeasonPlan());
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    const reads = controlPeriodReads();
    try {
      // Week, answered by the server with no documents: a 0.00 total whose
      // note still names the week's tariff scope.
      switchTo({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
      reads[0].settle({ docs: [], fromCache: false });
      await flushReads();
      assert.equal(element('history-total').textContent, '0.00');
      assert.equal(element('history-window-note').hidden, false);
      assert.equal(
        element('history-window-note').textContent,
        'Part of this week prices at your flat rate USD 0.12.',
      );

      // Offline, then Refresh: the read retains the series but sums nothing,
      // so the offline presentation replaces the window — and the note hides
      // with it while the banner keeps its own, plan-wide scope.
      const reload = fire('history-refresh', 'click');
      reads[1].settle({ docs: [], fromCache: true });
      await reload;
      for (let i = 0; i < 5; i++) await settle();
      assert.equal(
        element('chart-empty-title').textContent,
        "You're offline — history isn't available.",
      );
      assert.equal(element('history-total').textContent, '—');
      assert.equal(element('history-cost-cell').hidden, true);
      assert.equal(element('history-window-note').hidden, true);
      assert.equal(element('history-plan-banner').hidden, false);
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    mock.timers.reset();
  }
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
  // The live charge covers today's every recorded kWh: no caption while the
  // figure prices it all.
  assert.equal(element('history-cost-coverage').hidden, true);
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
  // The figure still prices today's live charge alone — and now says so
  // (#194): yesterday's recorded kWh has no covering session, so the summary
  // must not read as if GBP 0.30 covered both days. The caption carries that
  // sentence on its own small muted line, under the figure.
  assert.equal(element('history-cost').textContent, 'GBP 0.30');
  assert.equal(element('history-cost-coverage').hidden, false);
  assert.equal(element('history-cost-coverage').textContent, 'priced 1.00 of 2.00 kWh');

  // Back to the single covered day: the live charge prices its every kWh
  // again, and the caption the partial week just left visible must hide with
  // its text cleared. Unlike the covered pin above (whose pre-state was
  // already hidden), this one can fail — the render before it demonstrably
  // showed the caption.
  applyHistory(
    descriptor,
    { docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false },
    null,
    today,
    [],
  );
  showHistorySettings(nightly());
  assert.equal(element('history-cost').textContent, fmtMoney(0.3, 'GBP'));
  assert.equal(element('history-cost-coverage').hidden, true);
  assert.equal(element('history-cost-coverage').textContent, '');
});

test('resetHistory clears the coverage caption with its cell (#194)', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 9, 18, 12);
  // The same partial week as above: yesterday's recorded kWh has no covering
  // session, so the caption stands visibly under the figure.
  applyHistory(
    periodById('week'),
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
  showHistoryStatus(statusAt(3, today.getTime(), 7200, 1000));
  assert.equal(element('history-cost-coverage').hidden, false);

  // The sign-out/reset path cleared the disclosure when it lived inside the
  // cost string; the split node must not survive it with a stale visible
  // state, the #201 stale-note class.
  resetHistory();
  assert.equal(element('history-cost-coverage').hidden, true);
  assert.equal(element('history-cost-coverage').textContent, '');
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

test("the Day period's hour bars keep the day document's pricing as display", async () => {
  resetHistory();
  enterHistory();
  // Switch the screen to the Day period through its real click listener; the
  // read it starts genuinely rejects in Node (no Firestore bindings), and the
  // apply step below is the payload that read would deliver.
  const switchClick = element('period-switch').listeners.get('click')[0];
  element('period-switch').contains = () => true;
  await switchClick({ target: { closest: () => ({ dataset: { period: 'day' } }) } });
  const today = new Date(2026, 9, 18, 11, 30);
  const descriptor = periodById('day');
  applyHistory(descriptor, { id: '2026-10-18', kwh: 0.5, hours: { 11: 0.5 } }, null, today, []);
  showHistorySettings(nightly());
  // The in-progress 11:00 hour prices its own bucket over its wall-clock
  // hour — the display path, byte-identical to #125's — before and after a
  // live push: the live contribution never reaches the hour bars.
  assert.equal(element('chart-cost').textContent, fmtMoney(0.15, 'GBP'));
  // Before any live input the summary hides (#126's pre-push shape): the day
  // recorded half a kWh the span list prices none of.
  assert.equal(element('history-cost-cell').hidden, true);
  // The push makes the session basis whole: the summary carries the live
  // window's figure — the same one the Status tab prices — and the headline
  // is the pass's own energy, while the bars keep the document's buckets.
  showHistoryStatus(statusAt(3, today.getTime(), 1800, 500));
  assert.equal(element('chart-cost').textContent, fmtMoney(0.15, 'GBP'));
  assert.equal(element('history-cost').textContent, fmtMoney(0.15, 'GBP'));
  assert.equal(element('history-total').textContent, '0.50');
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
  // #210: the headline is the pass's own energy — the record's 1.03 kWh, the
  // archive's figure, beside the day document's 1.00 (the caption's basis).
  assert.equal(element('history-total').textContent, '1.03');

  // The settle armed the verification re-read; a hidden push holds it, and
  // the return visit — not the next push — spends it.
  element('panel-history').hidden = true;
  showHistoryStatus(statusAt(1, today.getTime() + 180_000, 7440, 1030));
  assert.equal(element('history-total').textContent, '1.03');
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
  assert.equal(element('history-total').textContent, '1.03');

  // Both flags are spent: another return visit re-renders, never re-reads —
  // a read would have cleared the total synchronously.
  activateHistory();
  assert.equal(element('history-total').textContent, '1.03');
  assert.equal(element('history-cost').textContent, fmtMoney(0.31, 'GBP'));
});

// ---------- one kWh figure per bucket ----------
//
// The screen the issue was filed on. A day document and the sessions archive
// are written by different bridge paths, and for a day that has not settled
// they can disagree: the bar used to print the document's kWh beside a $
// priced from the sessions, so one day read two ways with nothing on screen to
// say which to believe. Under a schedule a day or month bar now prints the
// energy the span pass attributes to it — what its $ prices — so the label,
// the height, the accessible name and the series maximum are one figure, the
// same one the summary prints for that day or month. The recorded figure keeps
// feeding the coverage guard, the summary's recorded total and the flat paths.

// Put the screen on a period through its real segment listener. The read it
// starts rejects in Node as usual; the apply step a test drives next is the
// payload that read would deliver.
async function switchTo(period) {
  element('period-switch').contains = () => true;
  const click = element('period-switch').listeners.get('click')[0];
  await click({ target: { closest: () => ({ dataset: { period } }) } });
  await readFailed();
}

// Tue 24 Nov 2026 at 15:50, the moment the issue was observed. The day's
// document recorded 2.25 kWh while the archive holds two sessions inside that
// local day attributing 12.90 kWh (12.01 + 0.89), under the one-rate November
// plan (0.1127 all day, also the stored flat rate). Mon 23 Nov agrees with its
// session, so the week reads 30.7 kWh as it did live.
function disagreeingDay() {
  const today = new Date(2026, 10, 24, 15, 50);
  return {
    today,
    docs: [
      { id: '2026-11-23', kwh: 17.8 },
      { id: '2026-11-24', kwh: 2.25 },
    ],
    sessions: [
      {
        id: 's-23',
        wh: 17800,
        started_at: new Date(2026, 10, 23, 1, 0),
        ended_at: new Date(2026, 10, 23, 6, 0),
      },
      {
        id: 's-24a',
        wh: 12010,
        started_at: new Date(2026, 10, 24, 0, 30),
        ended_at: new Date(2026, 10, 24, 4, 30),
      },
      // The newest session the issue lists: Tue 24 Nov 09:18–09:47, 0.89 kWh.
      {
        id: 's-24b',
        wh: 890,
        started_at: new Date(2026, 10, 24, 9, 18),
        ended_at: new Date(2026, 10, 24, 9, 47),
      },
    ],
    // The same day as the Day period reads it: a total with one hourly bucket,
    // deliberately not the energy any session attributes to that hour.
    dayDoc: {
      id: '2026-11-24',
      exists: true,
      kwh: 2.25,
      hours: { '09': 1.1 },
      fromCache: false,
    },
  };
}

// The bar groups the chart drew (the base line is the first child) and a
// bar's fill rect, whose height is the printed figure's share of the plot.
const drawnBars = () => element('chart-bars').children.slice(1);
const fillOf = (bar) => bar.children.find((kid) => kid.attrs.class === 'bar-fill');
// The plot a bar fills, less the 2-unit floor: the full height of the series
// maximum (118 − 10 − 2, the chart's base, top and floor).
const FULL_HEIGHT = 106;

test("a disagreeing day's bar prints its Day summary's kWh beside the same $, in Week and Month", async () => {
  resetHistory();
  enterHistory();
  const { today, docs, sessions, dayDoc } = disagreeingDay();

  // Week: the window selects today, its current slot.
  await switchTo('week');
  applyHistory(periodById('week'), { docs, fromCache: false }, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-day').textContent, 'Today · Tue 24 Nov');
  // The label prints the energy its $ prices — the sessions' 12.9 kWh — never
  // the document's 2.25 beside a USD 1.45 that 2.25 kWh did not cost.
  assert.equal(element('chart-kwh').textContent, '12.9');
  assert.equal(element('chart-cost').textContent, 'USD 1.45');
  // The bar says and stands at that one figure: its accessible name, its
  // height against the week's maximum (Mon 23 Nov's 17.8) and no zero class.
  // At its document's 2.25 it stood at a fraction of Monday's height.
  const [monday, tuesday] = drawnBars();
  assert.equal(tuesday.getAttribute('aria-label'), 'Tue 24 Nov: 12.9 kWh, USD 1.45');
  assert.equal(Number(fillOf(monday).attrs.height), FULL_HEIGHT);
  assert.ok(Math.abs(Number(fillOf(tuesday).attrs.height) - (12.9 / 17.8) * FULL_HEIGHT) < 1e-9);
  assert.ok(!tuesday.classList.contains('zero'));
  // A day whose document and sessions agree is untouched: Monday prints what
  // it always printed, at the height it always had — the week's maximum.
  assert.equal(monday.getAttribute('aria-label'), 'Mon 23 Nov: 17.8 kWh, USD 2.01');
  // The summary prices the same spans over the week — 30.7 kWh, USD 3.46, as
  // it read live — and says nothing about the disagreement: an under-recording
  // day is not missing data (the owner's decision), so no caption fires.
  assert.equal(element('history-total').textContent, '30.7');
  assert.equal(element('history-cost').textContent, 'USD 3.46');
  assert.equal(element('history-cost-coverage').hidden, true);

  // The Day period's summary for that day: the same 12.9 kWh beside the same $.
  await switchTo('day');
  applyHistory(periodById('day'), dayDoc, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('history-total').textContent, '12.9');
  assert.equal(element('history-cost').textContent, 'USD 1.45');
  // The hour bars stay the document's own: arrow back from the hour in
  // progress (15:00) to the nine o'clock bucket and the readout prints its
  // recorded 1.10 kWh — not a figure attributed from the sessions.
  for (let i = 0; i < 6; i++) keydown('history-chart', 'ArrowLeft');
  assert.equal(element('chart-day').textContent, '09:00–10:00');
  assert.equal(element('chart-kwh').textContent, '1.10');

  // Month: today's bar reads exactly as the Day summary did.
  await switchTo('month');
  applyHistory(periodById('month'), { docs, fromCache: false }, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-day').textContent, 'Today · Tue 24 Nov');
  assert.equal(element('chart-kwh').textContent, '12.9');
  assert.equal(element('chart-cost').textContent, 'USD 1.45');
  assert.equal(drawnBars().at(-1).getAttribute('aria-label'), 'Tue 24 Nov: 12.9 kWh, USD 1.45');
  assert.equal(drawnBars().length, 24);

  // One rate: the same documents print as they always did — the bar's kWh is
  // the day document's own, priced by the one rate, at its recorded height…
  showHistorySettings({ rate: 0.1127, currency: 'USD' });
  assert.equal(element('chart-kwh').textContent, '2.25');
  assert.equal(element('chart-cost').textContent, 'USD 0.25');
  assert.equal(element('history-total').textContent, '20.1');
  assert.equal(drawnBars().at(-1).getAttribute('aria-label'), 'Tue 24 Nov: 2.25 kWh, USD 0.25');
  assert.ok(
    Math.abs(Number(fillOf(drawnBars().at(-1)).attrs.height) - (2.25 / 17.8) * FULL_HEIGHT) < 1e-9,
  );
  // …and saving a schedule re-prices the same series back to the one figure.
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-kwh').textContent, '12.9');
  assert.equal(drawnBars().at(-1).getAttribute('aria-label'), 'Tue 24 Nov: 12.9 kWh, USD 1.45');
});

test("a Year month bar prints the Month summary's kWh when a month's documents disagree", async () => {
  resetHistory();
  enterHistory();
  const { today, docs, sessions } = disagreeingDay();
  // The month's day documents sum to 20.05 kWh; its sessions attribute 30.7.
  // The default view is the Month, so no switch is needed for its summary.
  applyHistory(periodById('month'), { docs, fromCache: false }, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('history-total').textContent, '30.7');
  assert.equal(element('history-cost').textContent, 'USD 3.46');

  // Year: the current month is the selected slot.
  await switchTo('year');
  applyHistory(periodById('year'), { docs, fromCache: false }, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-day').textContent, 'Nov 2026');
  // The bar prints the Month summary's figure beside the same $ — the
  // sessions' 30.7 kWh, not the 20.1 its day documents sum to.
  assert.equal(element('chart-kwh').textContent, '30.7');
  assert.equal(element('chart-cost').textContent, 'USD 3.46');
  const bars = drawnBars();
  assert.equal(bars.length, 11); // January to November
  assert.equal(bars[10].getAttribute('aria-label'), 'Nov 2026 (current month): 30.7 kWh, USD 3.46');
  assert.equal(Number(fillOf(bars[10]).attrs.height), FULL_HEIGHT);
  assert.ok(!bars[10].classList.contains('zero'));
  // A month with no document and no session is a genuine zero bar, as before.
  assert.ok(bars[9].classList.contains('zero'));
  assert.equal(Number(fillOf(bars[9]).attrs.height), 2);

  // One rate: the redrawn month bar falls back to its day documents' sum.
  showHistorySettings({ rate: 0.1127, currency: 'USD' });
  assert.equal(element('chart-kwh').textContent, '20.1');
  assert.equal(element('chart-cost').textContent, 'USD 2.26');
  assert.equal(
    drawnBars()[10].getAttribute('aria-label'),
    'Nov 2026 (current month): 20.1 kWh, USD 2.26',
  );
});

test('a mid-charge day prints the live estimate in its bar exactly once', async () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 10, 24, 12);
  // The day document has flushed 0.5 kWh of the charge so far and no session
  // is recorded yet: the live window is the archive's whole account of the
  // day. The default view is the Month.
  const docs = [{ id: '2026-11-24', kwh: 0.5 }];
  applyHistory(periodById('month'), { docs, fromCache: false }, null, today, [], today);
  showHistorySettings(novemberPlan());
  // Nothing prices the day yet: its $ hides and the bar keeps the record.
  assert.equal(element('chart-cost').hidden, true);
  assert.equal(element('chart-kwh').textContent, '0.50');

  // 10:00→12:00 at 1 kWh — the window the Status tab prices for this write.
  const charging = statusAt(3, today.getTime(), 7200, 1000);
  showHistoryStatus(charging);
  // The bar prints the estimate once — the energy its $ prices: not 1.50 (the
  // estimate added beside the document's 0.5) and not 0.50 (the document
  // alone). The summary beside it is the same figure.
  assert.equal(element('chart-kwh').textContent, '1.00');
  assert.equal(element('chart-cost').textContent, 'USD 0.11');
  assert.equal(element('history-total').textContent, '1.00');

  // The Day summary of the same mid-charge day: the same 1.00 kWh and $.
  await switchTo('day');
  applyHistory(
    periodById('day'),
    { id: '2026-11-24', exists: true, kwh: 0.5, hours: null, fromCache: false },
    null,
    today,
    [],
    today,
  );
  showHistorySettings(novemberPlan());
  assert.equal(element('history-total').textContent, '1.00');
  assert.equal(element('history-cost').textContent, 'USD 0.11');

  // A record lands while the charge still runs (the pause edge): the record
  // prices its own 0.4 kWh and the residual tail the other 0.6 — still 1.00,
  // never 1.40 (both whole) and never 0.60 (the tail alone).
  await switchTo('month');
  applyHistory(
    periodById('month'),
    { docs, fromCache: false },
    null,
    today,
    [
      {
        id: 's-1',
        wh: 400,
        started_at: new Date(2026, 10, 24, 10, 0),
        ended_at: new Date(2026, 10, 24, 10, 24),
      },
    ],
    today,
  );
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-kwh').textContent, '1.00');
  assert.equal(element('chart-cost').textContent, 'USD 0.11');

  // The settle, in the session-first order: a record reaching the write's own
  // instant drops the estimate and prices the same energy alone.
  applyHistory(
    periodById('month'),
    { docs, fromCache: false },
    null,
    today,
    [
      {
        id: 's-1',
        wh: 1000,
        started_at: new Date(2026, 10, 24, 10, 0),
        ended_at: new Date(2026, 10, 24, 12, 1),
      },
    ],
    today,
  );
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-kwh').textContent, '1.00');
  assert.equal(element('chart-cost').textContent, 'USD 0.11');
  assert.equal(element('history-total').textContent, '1.00');
});

test('a day no session covers keeps its recorded kWh while its $ hides', async () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 10, 24, 15, 50);
  const doc = { id: '2026-11-24', kwh: 2.25 };
  // Recorded energy, and nothing in the archive behind it. The default view
  // is the Month, with today the selected slot.
  applyHistory(periodById('month'), { docs: [doc], fromCache: false }, null, today, [], today);
  showHistorySettings(novemberPlan());
  // The $ hides rather than pricing the day free…
  assert.equal(element('chart-cost').hidden, true);
  assert.equal(element('chart-cost').textContent, '');
  // …and the kWh is the day document's own: 0.00 would read as free energy
  // beside a bar that stands for the recorded 2.25. It is still a real bar.
  assert.equal(element('chart-kwh').textContent, '2.25');
  const bar = drawnBars().at(-1);
  assert.equal(bar.getAttribute('aria-label'), 'Tue 24 Nov: 2.25 kWh');
  assert.ok(!bar.classList.contains('zero'));
  assert.equal(Number(fillOf(bar).attrs.height), FULL_HEIGHT);
  // The window's recorded energy is priced none of, so its summary — here and
  // on the Day period for the same day — hides both figures rather than
  // printing 0.00 beside the bars.
  assert.equal(element('history-total').textContent, '—');
  assert.equal(element('history-cost-cell').hidden, true);
  await switchTo('day');
  applyHistory(periodById('day'), { ...doc, exists: true, hours: null }, null, today, [], today);
  showHistorySettings(novemberPlan());
  assert.equal(element('history-total').textContent, '—');
  assert.equal(element('history-cost-cell').hidden, true);

  // Beside a covered day the window shows what it prices and says so — with
  // the caption's Y still the day documents' total, the uncovered 2.25
  // included: the recorded figure is what the summary measures coverage
  // against, whatever the bars print.
  await switchTo('month');
  applyHistory(
    periodById('month'),
    {
      docs: [{ id: '2026-11-23', kwh: 17.8 }, doc],
      fromCache: false,
    },
    null,
    today,
    [
      {
        id: 's-23',
        wh: 17800,
        started_at: new Date(2026, 10, 23, 1, 0),
        ended_at: new Date(2026, 10, 23, 6, 0),
      },
    ],
    today,
  );
  showHistorySettings(novemberPlan());
  assert.equal(element('history-total').textContent, '17.8');
  assert.equal(element('history-cost-coverage').textContent, 'priced 17.8 of 20.1 kWh');
  assert.equal(drawnBars().at(-1).getAttribute('aria-label'), 'Tue 24 Nov: 2.25 kWh');
  assert.equal(drawnBars().at(-2).getAttribute('aria-label'), 'Mon 23 Nov: 17.8 kWh, USD 2.01');
});

// The attribution memo (bucketTotals) answers from its cache until one of four
// inputs is replaced. Every test above re-renders through a settings push,
// which replaces `settings` on its own, so none of them can tell whether the
// payload's own keys still rebuild it. These two re-render with the settings
// and the live snapshot untouched — the way Refresh, a period switch, paging
// and the settle re-read do (applyHistory, then a render with no push), and
// the way a schedule save does (the payload standing).

test('a replaced payload re-attributes its bars with settings and status identity unchanged', async () => {
  resetHistory();
  enterHistory();
  // The real boot: loadAll marks the screen loaded and pins the midnight
  // window, so the return visit below re-renders instead of re-reading. In
  // Node the read genuinely rejects; the apply step is the payload.
  await fire('history-refresh', 'click');
  const today = new Date(2026, 10, 24, 15, 50);
  const { docs, sessions } = disagreeingDay();
  // The default view is the Month, with today the selected slot.
  applyHistory(periodById('month'), { docs, fromCache: false }, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-kwh').textContent, '12.9');

  // A later read delivers sessions that attribute 5.00 kWh to the day, in a
  // new series and a new session list. The return visit re-renders with no
  // settings or status push, so only the payload's identity can have told the
  // memo to rebuild: a stale answer is the #226 symptom again — 12.9 kWh
  // beside the USD 0.56 that 5.00 kWh cost.
  applyHistory(
    periodById('month'),
    { docs, fromCache: false },
    null,
    today,
    [
      {
        id: 's-23',
        wh: 17800,
        started_at: new Date(2026, 10, 23, 1, 0),
        ended_at: new Date(2026, 10, 23, 6, 0),
      },
      {
        id: 's-24',
        wh: 5000,
        started_at: new Date(2026, 10, 24, 0, 30),
        ended_at: new Date(2026, 10, 24, 4, 30),
      },
    ],
    today,
  );
  activateHistory();
  assert.equal(element('chart-kwh').textContent, '5.00');
  assert.equal(drawnBars().at(-1).getAttribute('aria-label'), 'Tue 24 Nov: 5.00 kWh, USD 0.56');
});

test('a different schedule re-prices the retained payload', () => {
  resetHistory();
  enterHistory();
  const today = new Date(2026, 10, 24, 15, 50);
  const { docs, sessions } = disagreeingDay();
  applyHistory(periodById('month'), { docs, fromCache: false }, null, today, sessions, today);
  showHistorySettings(novemberPlan());
  assert.equal(element('chart-cost').textContent, 'USD 1.45');

  // The payload stands — the same series and the same sessions; only the
  // schedule changes. Under the night plan the day's 12.01 kWh fell inside the
  // 00:00–06:00 window at 0.10 and its 0.89 kWh at the 0.30 base: 1.201 +
  // 0.267, so GBP 1.47 — never the old plan's 1.45 under the new currency,
  // which is what a memo that ignored the settings would print.
  showHistorySettings(nightly());
  assert.equal(element('chart-cost').textContent, 'GBP 1.47');
  assert.equal(drawnBars().at(-1).getAttribute('aria-label'), 'Tue 24 Nov: 12.9 kWh, GBP 1.47');
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

// Everything a press can reach from inside the chart card: the period switch and
// its option buttons, the pager buttons, the SVG and its bars. The real markup
// nests #period-switch (and its option buttons) inside #chart-card
// (web/index.html:412-465), so a key pressed on an option bubbles to the card's
// paging listener — the stub has no option elements of its own, so a test that
// stands on one passes the group element. <body> is in nothing, so a press that
// arrives after the focus was dropped reaches no listener and is the browser's
// key — the scroll this screen's focus continuity exists to prevent.
function inCard(node) {
  return (
    node === element('chart-card') ||
    node === element('period-switch') ||
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
  if (at === element('period-switch')) return keydown('period-switch', key);
  if (at === element('history-chart') || element('chart-bars').children.includes(at)) {
    return keydown('history-chart', key);
  }
  return false;
}

// The store's own period read, kept so a test can put it back: the chart read is
// indirected through periodReads precisely so the harness can substitute it.
const storePeriodRead = periodReads.range;

// A period read whose settling the harness decides: each call registers a pending
// read the test resolves when that read (and no other) should land. This is the
// only way to express the two orders a read and the read that superseded it can
// settle in — every store read genuinely rejects in Node, and rejections settle in
// the order they were issued.
function controlPeriodReads() {
  const reads = [];
  periodReads.range = () => {
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    reads.push({ promise, settle });
    return promise;
  };
  return reads;
}

// Let a settled read's whole chain run — applyHistory, the settle repaint and the
// focus handoff are consecutive microtasks behind the promise the test resolved.
async function flushReads() {
  for (let i = 0; i < 3; i++) await settle();
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

test('the default view names the current calendar month', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    // One register: offset 0 is October 2026, named as the calendar month it is
    // on the summary label, its aria-label, the SVG label and the heading.
    assert.equal(labelText(), 'October 2026');
    assert.equal(
      plain(element('history-summary').attrs['aria-label']),
      'Energy summary for October 2026',
    );
    assert.equal(
      plain(element('history-chart').attrs['aria-label']),
      'Daily energy for October 2026. Use the left and right arrow keys to move between days.',
    );
    assert.equal(element('chart-heading').textContent, 'Daily energy');
    // Next cannot reach the future; Previous pages back from the present.
    assert.equal(element('chart-next').disabled, true);
    assert.equal(element('chart-prev').disabled, false);
    assert.equal(element('chart-prev').attrs['aria-label'], 'Previous month');
    assert.equal(element('chart-next').attrs['aria-label'], 'Next month');
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
    assert.equal(labelText(), 'September 2026');
    assert.equal(
      plain(element('history-summary').attrs['aria-label']),
      'Energy summary for September 2026',
    );
    assert.equal(
      plain(element('history-chart').attrs['aria-label']),
      'Daily energy for September 2026. Use the left and right arrow keys to move between days.',
    );
    assert.equal(plain(element('chart-empty-line').textContent), 'Reading September 2026.');
    await back;
    await readFailed();
    // One more window back: the calendar month before September's.
    await fire('chart-prev', 'click');
    await readFailed();
    assert.equal(labelText(), 'August 2026');
    // Next walks back toward the present one window at a time.
    await fire('chart-next', 'click');
    await readFailed();
    assert.equal(labelText(), 'September 2026');
    assert.equal(element('chart-next').disabled, false);
    await fire('chart-next', 'click');
    await readFailed();
    assert.equal(labelText(), 'October 2026');
    assert.equal(element('chart-next').disabled, true);
    // Next at the present is inert: no window beyond it, and no re-read.
    await fire('chart-next', 'click');
    assert.equal(labelText(), 'October 2026');
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
    assert.equal(label, 'September 2026');
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
      assert.ok(plain(text).includes('September 2026'), text);
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
      'No energy recorded in September 2026.',
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
      'Reconnect, then tap Refresh to load the energy for September 2026.',
    );
    assert.equal(element('chart-bars').children.length, 0);

    // A paged window's readout names its own newest bucket (no bucket in it is
    // current, so the newest is September's last day) and still prices its $.
    applyHistory(
      descriptor,
      { docs: [{ id: '2026-09-30', kwh: 2 }], fromCache: false },
      null,
      anchor,
      [],
      now,
    );
    showHistorySettings({ rate: 0.25, currency: 'GBP' });
    assert.equal(element('chart-day').textContent, dayLabel('2026-09-30'));
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

test('a Year month bucket never carries the Today prefix', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    const now = new Date(PAGED_NOW);
    // The real segment listener puts the screen on Year, so the chart paints the
    // year descriptor's series with its own bucket kind.
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'year' } }) } });
    await readFailed();
    // The current year's newest bucket is this month: it is the bucket the clock
    // marks current, but "Today ·" names a day, so a month bar must not wear it.
    applyHistory(
      periodById('year'),
      { docs: [{ id: '2026-05-06', kwh: 1 }], fromCache: false },
      null,
      now,
      [],
      now,
    );
    showHistorySettings(nightly());
    assert.equal(element('chart-day').textContent, 'Oct 2026');
    assert.doesNotMatch(element('chart-day').textContent, /Today/);
    // Ten bars, not twelve: the current year stops with this month.
    assert.equal(element('chart-bars').children.length, 10 + 1);
  } finally {
    mock.timers.reset();
  }
});

test('the hint names only what the state on screen offers', async () => {
  // Two dimensions, one source: whether bars are drawn (the selection keys need
  // them) and which window is shown (Next and PageDown are inert at the present
  // — PageDown is not even consumed there — so neither is advertised).
  const presentPaging = 'Use ‹ or PageUp to page back';
  const presentBars = 'Tap or ← → · PageUp pages back';
  const pagedPaging = 'Use ‹ › or PageUp/PageDown to page';
  const pagedBars = 'Tap or ← → · PageUp/PageDown pages';
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    await fire('history-refresh', 'click');
    // Loading paints no bars, so nothing is there to tap or arrow through: the
    // hint names the pager that does work from here — and at the present that is
    // Previous alone.
    assert.equal(element('chart-hint').textContent, presentPaging);
    await readFailed();
    // A failed read is still an empty chart, and paging out of it still works.
    assert.equal(element('chart-hint').textContent, presentPaging);
    // Bars on screen: the selection keys join the pager, still at the present.
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
    assert.equal(element('chart-hint').textContent, presentBars);
    // One window back: both paging directions are live, so both are named — and
    // the paged read has cleared the bars, so the selection clause leaves.
    const reads = controlPeriodReads();
    try {
      const paging = fire('chart-prev', 'click');
      assert.equal(element('chart-hint').textContent, pagedPaging);
      reads[0].settle({ docs: [{ id: '2026-09-18', kwh: 2 }], fromCache: false });
      await paging;
      await flushReads();
      assert.equal(element('chart-hint').textContent, pagedBars);
    } finally {
      periodReads.range = storePeriodRead;
    }
    // The markup's hint is the pre-paint copy (and the SVG's aria-describedby
    // target); the first paint overwrites its textContent, so drift between the
    // shipped literal and the offset-0 paging register would be invisible to
    // every assertion above. The static copy is the present register, so pin it
    // at the same constant the behavioural half just drove.
    const markup = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    const shipped = /<p\b[^>]*id="chart-hint"[^>]*>([^<]*)<\/p>/.exec(markup);
    assert.ok(shipped, 'web/index.html ships #chart-hint');
    assert.equal(shipped[1], presentPaging);
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
    assert.equal(labelText(), 'August 2026');

    // The real segment listener: a Week switch resets the offset and renames the
    // paging controls for the unit it now pages in.
    element('period-switch').contains = () => true;
    const click = element('period-switch').listeners.get('click')[0];
    await click({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    assert.equal(labelText(), 'Mon 12 – Sun 18 Oct 2026');
    assert.equal(element('chart-next').disabled, true);
    assert.equal(element('chart-prev').attrs['aria-label'], 'Previous week');
    assert.equal(element('chart-next').attrs['aria-label'], 'Next week');
    await readFailed();

    // Back to Month: offset 0 again, not the offset it was left on.
    await click({ target: { closest: () => ({ dataset: { period: 'month' } }) } });
    assert.equal(labelText(), 'October 2026');
    assert.equal(element('chart-next').disabled, true);
    await readFailed();
  } finally {
    mock.timers.reset();
  }
});

test('a clipped current week on its Monday is named by one date', async () => {
  // Monday 12 October 2026: the current ISO week is that one day, so every string
  // that names the window names it once — never "Mon 12 – Mon 12 Oct 2026".
  freezeClock(new Date(2026, 9, 12, 12).getTime());
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    await switchTo({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
    await readFailed();
    assert.equal(labelText(), 'Mon 12 Oct 2026');
    assert.equal(
      plain(element('history-summary').attrs['aria-label']),
      'Energy summary for the week of Monday 12 October 2026',
    );
    assert.equal(
      plain(element('history-chart').attrs['aria-label']),
      'Daily energy for the week of Monday 12 October 2026. Use the left and right arrow keys to move between days.',
    );
    // A one-day week is still the present window: Next stays disabled.
    assert.equal(element('chart-next').disabled, true);
  } finally {
    mock.timers.reset();
  }
});

test('Year pages one calendar year each way across the year boundary', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    await switchTo({ target: { closest: () => ({ dataset: { period: 'year' } }) } });
    await readFailed();
    assert.equal(labelText(), '2026');
    assert.equal(element('chart-next').disabled, true);
    assert.equal(element('chart-prev').attrs['aria-label'], 'Previous year');
    assert.equal(element('chart-next').attrs['aria-label'], 'Next year');
    // Previous steps one whole calendar year: the completed 2025.
    await fire('chart-prev', 'click');
    await readFailed();
    assert.equal(labelText(), '2025');
    assert.equal(element('chart-next').disabled, false);
    // Next steps forward one calendar year, back across the January boundary.
    await fire('chart-next', 'click');
    await readFailed();
    assert.equal(labelText(), '2026');
    assert.equal(element('chart-next').disabled, true);
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
    assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
    await readFailed();
    // A two-ended week is announced in the prose register of the same span, months
    // spelled out — the clipped one-day week pinned above is the only title-form
    // exception.
    assert.equal(
      plain(element('history-summary').attrs['aria-label']),
      'Energy summary for the week of Monday 5 – Sunday 11 October 2026',
    );
    // PageDown pages toward the present, and stops at it.
    assert.equal(keydown('history-chart', 'PageDown'), true);
    assert.equal(labelText(), 'Mon 12 – Sun 18 Oct 2026');
    await readFailed();
    // At the present PageDown moves nothing, so it is the browser's key again:
    // consuming it would swallow a scroll for an action that does not happen.
    assert.equal(keydown('history-chart', 'PageDown'), false);
    assert.equal(labelText(), 'Mon 12 – Sun 18 Oct 2026');
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
    assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
    await readFailed();
    // The settled window handed the focus back inside the card rather than letting
    // it fall to <body> — this window drew no bars (the read failed), so it rests
    // on the pager, which is in the card and still hears the key.
    assert.equal(document.activeElement, element('chart-prev'));

    // Second press, with no re-Tab in between, pages again: the advertised
    // two-windows-back interaction works from the keyboard.
    assert.equal(keydown('chart-prev', 'PageUp'), true);
    assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
    await readFailed();
    assert.equal(document.activeElement, element('chart-prev'));
    assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
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
    assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
    // The focus is already on a control inside the card, so a press arriving
    // mid-read reaches the paging keys instead of scrolling the viewport.
    assert.notEqual(document.activeElement, document.body);
    assert.equal(inCard(document.activeElement), true);

    // A second press, typed before the first read settles, pages a second window.
    assert.equal(pressFromFocus('PageUp'), true);
    assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');

    // The read that lands is the newest one and it owns the settle focus. This
    // window drew no bars, so the focus rests on the pager — the documented
    // fallback — rather than being left on <body>.
    await readFailed();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
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

test("the selected bar is the window's single tab stop and current", async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    const bars = () => element('chart-bars').children.slice(1);
    const stop = () => bars().find((bar) => bar.getAttribute('tabindex') === '0');
    const currentBar = () => bars().filter((bar) => bar.getAttribute('aria-current') === 'true');
    assert.equal(bars().length, 7);
    // H.10/H.17: the selected bucket carries aria-current and is the single tab
    // stop; every other bar is neither focusable nor current.
    assert.ok(stop(), 'one bar is the tab stop');
    assert.equal(bars().filter((bar) => bar.getAttribute('tabindex') === '0').length, 1);
    assert.equal(currentBar().length, 1);
    assert.equal(currentBar()[0], stop());
    assert.ok(stop().classList.contains('selected'));
    for (const bar of bars()) {
      const selected = bar === stop();
      assert.equal(bar.getAttribute('tabindex'), selected ? '0' : '-1');
      assert.equal(bar.getAttribute('aria-current'), selected ? 'true' : null);
    }
    // Moving the selection moves the stop with it and leaves no second one behind.
    // The window selects its newest slot (index 6), where ArrowRight clamps, so the
    // move has to be the other way: that is the only press that takes aria-current
    // off a bar which had it, the branch a clamped press never reaches.
    const before = stop();
    assert.equal(bars().indexOf(before), 6);
    keydown('history-chart', 'ArrowLeft');
    assert.notEqual(stop(), before);
    assert.equal(bars().indexOf(stop()), 5);
    assert.equal(plain(element('chart-day').textContent), 'Sat 17 Oct');
    assert.equal(currentBar().length, 1);
    assert.equal(currentBar()[0], stop());
    assert.ok(stop().classList.contains('selected'));
    assert.equal(before.getAttribute('aria-current'), null);
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

// ---------- the settle focus handoff (#154) ----------
//
// The park half of the focus fix is pinned above; these pin the release half,
// which needs a read that *succeeds* (a rejecting read draws no bar to hand the
// focus to) and a read whose settling the test times (periodReads). Every order in
// which a read superseded by another one can settle is covered — a paged read vs a
// reload, both ways, and a paged read vs a paged read — because the screen's rule
// is that only the newest read may repaint the chart or spend the reservation.

test('a reload that lands as the newest read hands the focus to the bar its window drew', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    const reads = controlPeriodReads();
    try {
      // A Refresh with no read to supersede it: the reload itself is the newest
      // read, so its own settle hands the focus back.
      const reload = fire('history-refresh', 'click');
      assert.equal(reads.length, 1);
      assert.equal(document.activeElement, element('chart-prev'));
      reads[0].settle({ docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false });
      await reload;
      await flushReads();
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(bars().length, 7);
      const selected = bars().find((bar) => bar.classList.contains('selected'));
      assert.ok(selected, 'the window selects a bar');
      // Not the pager it was parked on: the settled window owns the focus.
      assert.equal(document.activeElement, selected);
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a successful paged read hands the reserved focus to the bar its window drew', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    const reads = controlPeriodReads();
    try {
      // The loading paint parks the focus on Previous before the bars go, so a
      // press arriving mid-read still pages.
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(document.activeElement, element('chart-prev'));
      assert.equal(reads.length, 1);
      // The read answers with a document inside the paged week (5 – 11 Oct 2026).
      reads[0].settle({ docs: [{ id: '2026-10-09', kwh: 1 }], fromCache: false });
      await flushReads();
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(bars().length, 7);
      const selected = bars().find((bar) => bar.classList.contains('selected'));
      assert.ok(selected, 'the window selects a bar');
      // The settled window spends the reservation on the bar it selected — the
      // release half, which no rejecting read can reach.
      assert.equal(document.activeElement, selected);
      // …so the next press pages from the bar instead of scrolling the page.
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a PageUp that supersedes a reload keeps the settle focus when the reload lands first', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    const reads = controlPeriodReads();
    try {
      // Refresh starts a reload: it parks the focus on Previous and reads.
      const reload = fire('history-refresh', 'click');
      assert.equal(reads.length, 1);
      assert.equal(document.activeElement, element('chart-prev'));
      // A PageUp typed during the reload's round trip supersedes it.
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(reads.length, 2);
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      // Order B: the superseded reload lands first, while the paged window is still
      // loading. Its control state finishes, but it must neither repaint the chart
      // nor spend the reservation the paged read is about to use.
      reads[0].settle({ docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false });
      await reload;
      await flushReads();
      assert.equal(document.activeElement, element('chart-prev'));
      // The superseded reload's own control state still finishes: `loading` is
      // cleared (so it never blocks the next reload for the session) and the
      // refresh control is usable again.
      assert.equal(element('history-refresh').disabled, false);
      assert.equal(element('history-refresh').textContent, 'Refresh');
      assert.equal(element('panel-history').attrs['aria-busy'], 'false');
      // The newest read then lands and hands the focus to the bar it drew, instead
      // of leaving it parked beside a fully drawn window.
      reads[1].settle({ docs: [{ id: '2026-10-09', kwh: 1 }], fromCache: false });
      await flushReads();
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(bars().length, 7);
      const selected = bars().find((bar) => bar.classList.contains('selected'));
      assert.ok(selected, 'the window selects a bar');
      assert.equal(document.activeElement, selected);
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a reload that lands after its window was superseded leaves the drawn window and its focus alone', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    const reads = controlPeriodReads();
    try {
      const reload = fire('history-refresh', 'click');
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(reads.length, 2);
      // Order A: the paged read lands first, draws its window and hands the focus
      // to the bar it selected.
      reads[1].settle({ docs: [{ id: '2026-10-09', kwh: 1 }], fromCache: false });
      await flushReads();
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(bars().length, 7);
      const selected = bars().find((bar) => bar.classList.contains('selected'));
      assert.ok(selected, 'the window selects a bar');
      assert.equal(document.activeElement, selected);
      // The superseded reload then lands. A repaint here would rebuild the bars —
      // dropping the focused one to <body>, where PageUp scrolls the page.
      reads[0].settle({ docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false });
      await reload;
      await flushReads();
      assert.equal(bars().length, 7);
      // The superseded reload still finishes its own control state: nothing it
      // set while it ran is left behind to block the next Refresh.
      assert.equal(element('history-refresh').disabled, false);
      assert.equal(element('history-refresh').textContent, 'Refresh');
      assert.equal(element('panel-history').attrs['aria-busy'], 'false');
      assert.equal(bars().includes(document.activeElement), true);
      assert.equal(document.activeElement, selected);
      // The paging keys are still deliverable from it, without a re-Tab.
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

test('a paged read that lands after a newer paged read paints neither its bars nor its focus', async () => {
  freezeClock();
  modelChartContainment();
  try {
    await showDrawnWeek();
    assert.equal(keydown('history-chart', 'ArrowLeft'), true);
    const reads = controlPeriodReads();
    try {
      // Two presses inside one round trip — a held key's repeat, or a quick
      // double press: read A names Mon 5 – Sun 11 Oct 2026, read B the week before.
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(reads.length, 2);
      assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
      // The newest read lands first and owns the window: its bar is drawn, focused
      // and priced.
      reads[1].settle({ docs: [{ id: '2026-10-01', kwh: 1 }], fromCache: false });
      await flushReads();
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(bars().length, 7);
      const selected = bars().find((bar) => bar.classList.contains('selected'));
      assert.ok(selected, 'the window selects a bar');
      assert.equal(document.activeElement, selected);
      assert.equal(element('history-total').textContent, '1.00');
      // The superseded read then lands with a payload of its own. Painting it here
      // would put read A's bars and total under read B's span label and rebuild the
      // bars — dropping the focused one to <body>, where PageUp scrolls the page.
      reads[0].settle({ docs: [{ id: '2026-10-09', kwh: 9 }], fromCache: false });
      await flushReads();
      assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
      assert.equal(element('history-total').textContent, '1.00');
      assert.equal(bars().length, 7);
      assert.equal(document.activeElement, selected);
      // The paging keys are still deliverable from it, without a re-Tab.
      assert.equal(pressFromFocus('PageUp'), true);
      assert.equal(labelText(), 'Mon 21 – Sun 27 Sep 2026');
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    element('history-chart').contains = () => false;
    mock.timers.reset();
  }
});

// Every full reload (loadAll) paints "Refreshing…" on the Refresh control exactly
// once; the screen's other reads do not. The stub's textContent is a plain
// property, so a setter counts them without touching the module under test. A
// guard that never rests reloads in a microtask chain that starves the timers, so
// the cap below turns that into a failing test instead of a hang. It is armed for
// every test, not only the two midnight ones: a regression in the guard reached
// from any paging test otherwise hangs the whole file with no failing test name,
// and the per-test reset keeps the count from drifting as the file grows.
const RELOAD_CAP = 40;
const reloads = [];
let reloadLimit = RELOAD_CAP;
beforeEach(() => {
  reloads.length = 0;
  reloadLimit = RELOAD_CAP;
});
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
    reloadLimit = 20;
    // Build the paged window on the 18th…
    const paging = fire('chart-prev', 'click');
    assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
    // …and let the clock cross local midnight before the read settles.
    mock.timers.setTime(new Date(2026, 9, 19, 0, 0, 20).getTime());
    await paging;
    await readFailed();
    for (let i = 0; i < 5; i++) await settle();
    // Exactly one re-entry, and it rebuilt the same paged offset from the new day.
    assert.equal(reloads.length - before, 1);
    assert.equal(labelText(), 'Mon 12 – Sun 18 Oct 2026');
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
    reloadLimit = 20;
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

// (#154) The label owns the window its bars were read for. A reload at a paged
// offset rebuilds the window from a new clock, so after local midnight the read
// that has not landed yet describes a different window than the bars on screen;
// naming those bars with it misattributes every day in them.
test('a failed reload at a paged offset keeps the bars under the window they were read for', async () => {
  freezeClock(new Date(2026, 9, 18, 23, 59, 40).getTime());
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    const reads = controlPeriodReads();
    try {
      // Week, one window back, both reads answered: bars for 5 – 11 Oct drawn,
      // summed from the document the paged read returned.
      switchTo({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
      assert.equal(reads.length, 1);
      reads[0].settle({ docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false });
      await flushReads();
      const paging = fire('chart-prev', 'click');
      assert.equal(reads.length, 2);
      reads[1].settle({ docs: [{ id: '2026-10-05', kwh: 2 }], fromCache: false });
      await paging;
      await flushReads();
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-total').textContent, '2.00');
      assert.equal(bars().length, 7);
      assert.equal(bars()[0].getAttribute('aria-label'), 'Mon 5 Oct: 2.00 kWh');
      assert.equal(bars()[6].getAttribute('aria-label'), 'Sun 11 Oct: 0.00 kWh');

      // Local midnight passes. The reload builds 12 – 18 Oct from the new clock
      // and its read fails, so the bars it retained are the only series there is.
      mock.timers.setTime(new Date(2026, 9, 19, 0, 0, 20).getTime());
      periodReads.range = () =>
        Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      const reload = fire('history-refresh', 'click');
      // A live status push repaints while the reload is in flight: that repaint
      // must not decorate the retained bars with the window being read either.
      showHistoryStatus(statusAt(3, new Date(2026, 9, 19, 0, 0, 20).getTime(), 7200, 1000));
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      await reload;
      for (let i = 0; i < 5; i++) await settle();
      // The in-flight repaint and the settled failure both name the window the
      // bars were read for — never 12 – 18 Oct, which the bars do not cover.
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-total').textContent, '2.00');
      assert.equal(bars().length, 7);
      assert.equal(bars()[0].getAttribute('aria-label'), 'Mon 5 Oct: 2.00 kWh');
      assert.equal(bars()[6].getAttribute('aria-label'), 'Sun 11 Oct: 0.00 kWh');
      // …and the note says these are the last values loaded.
      assert.equal(element('history-state').hidden, false);
      assert.match(element('history-state').textContent, /last values loaded/);

      // The paging read owns the same rule from the other side: it clears the
      // bars before its read, so the panel names the window it is reading. Two
      // steps back, because one lands on the same 5 – 11 Oct dates the retained
      // bars already name.
      await fire('chart-prev', 'click');
      await readFailed();
      await fire('chart-prev', 'click');
      await readFailed();
      assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
      assert.equal(bars().length, 0);
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    mock.timers.reset();
  }
});

// (#210, the pricing half of #154's rule above) The label owns the window its
// bars were read for, and under a schedule so do the figures: renderSummary
// prices exactly the window its points and sessions were read for
// (seriesWindowMs), never the window a newer, failed read has re-anchored
// chartWindow to — the state the variable exists to hold. The schedule-side
// shape the flat test above cannot see: a drawn, partly covered week retained
// through a re-anchored Refresh whose read fails. The session payload crosses
// the fetch→apply seam (the sessions read has no Node stub — see
// controlPeriodReads' note), the harness's one way to deliver a successful
// session read.
test('a failed reload keeps the schedule figures priced for the window on screen (#210)', async () => {
  freezeClock(new Date(2026, 9, 18, 23, 59, 40).getTime());
  try {
    resetHistory();
    enterHistory();
    showHistorySettings(nightly());
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    const reads = controlPeriodReads();
    try {
      // Week, one window back, both reads answered: bars for 5 – 11 Oct drawn
      // from the document the paged read returned.
      switchTo({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
      assert.equal(reads.length, 1);
      reads[0].settle({ docs: [{ id: '2026-10-12', kwh: 1 }], fromCache: false });
      await flushReads();
      const paging = fire('chart-prev', 'click');
      assert.equal(reads.length, 2);
      reads[1].settle({ docs: [{ id: '2026-10-05', kwh: 2 }], fromCache: false });
      await paging;
      await flushReads();
      // The same read's session payload: one 1.5 kWh session inside Mon 5 Oct
      // at the nightly base, pricing 1.5 of the week's recorded 2 kWh — the
      // partial-coverage shape — applied over the window the paging read named
      // (an anchor inside it, now the clock that read was built at, so the
      // window is the full Monday–Sunday week and no bucket is current).
      applyHistory(
        periodById('week'),
        { docs: [{ id: '2026-10-05', kwh: 2 }], fromCache: false },
        null,
        new Date(2026, 9, 8, 12),
        [{ wh: 1500, started_at: new Date(2026, 9, 5, 10), ended_at: new Date(2026, 9, 5, 12) }],
        new Date(2026, 9, 18, 23, 59, 40),
      );
      showHistorySettings(nightly());
      const bars = () => element('chart-bars').children.slice(1);
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-total').textContent, '1.50');
      assert.equal(element('history-cost-cell').hidden, false);
      assert.equal(element('history-cost').textContent, fmtMoney(0.45, 'GBP'));
      assert.equal(element('history-cost-coverage').textContent, 'priced 1.50 of 2.00 kWh');
      assert.equal(bars().length, 7);

      // Local midnight passes. The reload builds 12 – 18 Oct from the new clock
      // and re-anchors chartWindow to it before its read, and the read fails —
      // so the drawn window is the only series there is, and its figures must
      // stay the ones its own window priced.
      mock.timers.setTime(new Date(2026, 9, 19, 0, 0, 20).getTime());
      periodReads.range = () =>
        Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      const reload = fire('history-refresh', 'click');
      await reload;
      for (let i = 0; i < 5; i++) await settle();
      // Priced for 5 – 11 Oct, never for 12 – 18 Oct: pricing the re-anchored
      // window instead would find the retained sessions outside it and render
      // both figures unpriced (—) — the exact divergence seriesWindowMs exists
      // to prevent, live on every failed refresh.
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-total').textContent, '1.50');
      assert.equal(element('history-cost-cell').hidden, false);
      assert.equal(element('history-cost').textContent, fmtMoney(0.45, 'GBP'));
      assert.equal(element('history-cost-coverage').textContent, 'priced 1.50 of 2.00 kWh');
      assert.equal(bars().length, 7);
      // The bar prints the energy its $ prices — the 1.50 kWh the pass
      // attributes to the day, the summary's own figure and the caption's X —
      // never the day document's 2.00 beside a $ that does not price it.
      assert.equal(bars()[0].getAttribute('aria-label'), 'Mon 5 Oct: 1.50 kWh, GBP 0.45');
      // …and the state note says these are the last values loaded.
      assert.equal(element('history-state').hidden, false);
      assert.match(element('history-state').textContent, /last values loaded/);

      // The retained pair is loadAll's alone: the paging read clears the series
      // with its pricing window before it reads, so the figures cannot survive
      // it. One step back lands on the 5 – 11 Oct dates the bars still name —
      // the same label over dead figures — and a second reaches 28 Sep – 4 Oct.
      await fire('chart-prev', 'click');
      await readFailed();
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-total').textContent, '—');
      assert.equal(element('history-cost-cell').hidden, true);
      await fire('chart-prev', 'click');
      await readFailed();
      assert.equal(labelText(), 'Mon 28 Sep – Sun 4 Oct 2026');
      assert.equal(bars().length, 0);
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    mock.timers.reset();
  }
});

// (#154) The empty half of the same rule: a window the server answered with
// nothing draws no bars, so a failed re-entry over it has no drawn window to
// defend — its offline panel must name the window the next Refresh will read,
// not the superseded window the retained empty series still names.
test('a failed re-entry over an empty paged window names the window Refresh will load', async () => {
  freezeClock(new Date(2026, 9, 18, 23, 59, 40).getTime());
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    const reads = controlPeriodReads();
    try {
      // Week, one window back, answered by the server with no documents: the
      // empty panel for 5 – 11 Oct, with the pager still on screen.
      switchTo({ target: { closest: () => ({ dataset: { period: 'week' } }) } });
      reads[0].settle({ docs: [], fromCache: false });
      await flushReads();
      const paging = fire('chart-prev', 'click');
      reads[1].settle({ docs: [], fromCache: false });
      await paging;
      await flushReads();
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-total').textContent, '0.00');

      // Midnight, then a re-entry whose read is a cache miss: there are no bars
      // to keep, so the panel speaks for the window the re-entry reads.
      mock.timers.setTime(new Date(2026, 9, 19, 0, 0, 20).getTime());
      const reload = fire('history-refresh', 'click');
      reads[2].settle({ docs: [], fromCache: true });
      await reload;
      for (let i = 0; i < 5; i++) await settle();
      assert.equal(
        element('chart-empty-title').textContent,
        "You're offline — history isn't available.",
      );
      assert.equal(
        plain(element('chart-empty-line').textContent),
        'Reconnect, then tap Refresh to load the energy for the week of Monday 12 – Sunday 18 October 2026.',
      );
      // The label still names the read that produced the (empty) series: there
      // is no bar to mislabel, and Refresh is the only thing moving forward.
      assert.equal(labelText(), 'Mon 5 – Sun 11 Oct 2026');
      assert.equal(element('history-state').hidden, true);
    } finally {
      periodReads.range = storePeriodRead;
    }
  } finally {
    mock.timers.reset();
  }
});

// (#154) The Day period's read target is the whole claim that it reads the day
// its window names: the harness substitutes the read, so the argument is what
// must be pinned — a `dayId(new Date())` there reads today's document for every
// paged day, painting it under that day's date.
test('a paged Day read targets the date its window names', async () => {
  freezeClock();
  try {
    resetHistory();
    enterHistory();
    element('period-switch').contains = () => true;
    const switchTo = element('period-switch').listeners.get('click')[0];
    const days = [];
    const storeDayRead = periodReads.day;
    // Each day's document carries a different total, so the painted summary says
    // which document the bars came from — not just which id was requested.
    periodReads.day = (day) => {
      days.push(day);
      return Promise.resolve({
        exists: true,
        kwh: day === '2026-10-17' ? 3 : 1,
        hours: { '05': day === '2026-10-17' ? 3 : 1 },
        fromCache: false,
      });
    };
    try {
      switchTo({ target: { closest: () => ({ dataset: { period: 'day' } }) } });
      await flushReads();
      assert.deepEqual(days, ['2026-10-18']);
      assert.equal(labelText(), 'Sun 18 Oct 2026');
      // The Day readout names the hour in progress and nothing else: its bucket
      // is `hour`, so the "Today · " prefix (a day-bucket register) can never
      // appear here — the summary label above it names the date. Pinned so a
      // copy change cannot silently promise the prefix H.11 used to claim.
      assert.equal(element('chart-day').textContent, '12:00–13:00');
      assert.doesNotMatch(element('chart-day').textContent, /Today/);
      // One day back: the read targets the day the window names, and the bars and
      // summary are that document's.
      await fire('chart-prev', 'click');
      assert.deepEqual(days, ['2026-10-18', '2026-10-17']);
      assert.equal(labelText(), 'Sat 17 Oct 2026');
      assert.equal(element('history-total').textContent, '3.00');
      // 24 hour slots plus the base line.
      assert.equal(element('chart-bars').children.length, 25);
      assert.equal(element('chart-day').textContent, '23:00–24:00');
      assert.doesNotMatch(element('chart-day').textContent, /Today/);
    } finally {
      periodReads.day = storeDayRead;
    }
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
