import { test } from 'node:test';
import assert from 'node:assert/strict';

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
// or a successful read's painting.

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
