import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initTabbar, routeFor, buildDayPicker, toggleDay } from '../../web/js/ui.js';
import { initConfig } from '../../web/js/screens/config.js';
import { DAY_NAMES } from '../../web/js/schedule.js';

test('routeFor accepts known hashes and canonicalises the rest', () => {
  assert.equal(routeFor('#status'), 'status');
  assert.equal(routeFor('#History'), 'history');
  assert.equal(routeFor('#schedule'), 'schedule');
  assert.equal(routeFor(''), 'status');
  assert.equal(routeFor('#'), 'status');
  assert.equal(routeFor('#nope'), 'status');
});

test('routeFor ignores inherited object keys', () => {
  for (const hash of ['#constructor', '#__proto__', '#toString', '#valueOf']) {
    assert.equal(routeFor(hash), 'status', hash);
  }
});

// ---------- shared day-picker surface ----------
//
// `toggleDay` and `buildDayPicker` are load-bearing for both day-chip editors
// (schedule rules and the settings plan editor); before the shared extraction
// they were pinned only indirectly through those screens. These pins hold the
// edit idiom (sorted, unique) and the builder's attribute contract — the
// `data-day`/aria-pressed surface the screens' repaint passes read back.

test('toggleDay adds in sorted position, removes, and never duplicates', () => {
  // Add: the day lands in sorted position, not append order.
  assert.deepEqual(toggleDay([2, 4], 0), [0, 2, 4]);
  assert.deepEqual(toggleDay([0, 4], 2), [0, 2, 4]);
  // Remove: the day leaves, the rest keep their order.
  assert.deepEqual(toggleDay([0, 2, 4], 2), [0, 4]);
  assert.deepEqual(toggleDay([0, 2, 4], 4), [0, 2]);
  // An unsorted input still toggles against its own membership, and an add
  // normalises to sorted; duplicates can only shrink the result.
  assert.deepEqual(toggleDay([4, 4, 2], 4), [2]);
  assert.deepEqual(toggleDay([4, 2], 0), [0, 2, 4]);
});

// A minimal node for the builder: the picker only needs element creation, so a
// local stub keeps this file free of the heavier screen harnesses.
function pickerNode(tag) {
  const attrs = new Map();
  const listeners = new Map();
  return {
    tag,
    className: '',
    textContent: '',
    type: '',
    dataset: {},
    attrs,
    listeners,
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
}

function installPickerDoc() {
  globalThis.document = { createElement: (tag) => pickerNode(tag) };
}

test('buildDayPicker renders the chip group and drives onToggle with sorted unique days', () => {
  installPickerDoc();
  const days = [0, 1, 2, 3, 4];
  const toggles = [];
  const group = buildDayPicker({
    className: 'plan-days',
    chipClass: 'plan-day',
    describeId: 'rate-window-error-0',
    label: 'Days for the night window',
    getDays: () => days,
    pressed: (day) => days.includes(day),
    dataDay: true,
    onToggle: (day, nextDays, chip) => {
      days.length = 0;
      days.push(...nextDays);
      toggles.push([day, chip.dataset.day]);
    },
  });

  assert.equal(group.className, 'plan-days');
  assert.equal(group.attrs.get('role'), 'group');
  assert.equal(group.attrs.get('aria-label'), 'Days for the night window');
  assert.equal(group.attrs.get('aria-describedby'), 'rate-window-error-0');
  assert.equal(group.children.length, DAY_NAMES.length);

  group.children.forEach((chip, day) => {
    assert.equal(chip.className, 'plan-day');
    assert.equal(chip.textContent, DAY_NAMES[day]);
    assert.equal(chip.type, 'button');
    assert.equal(chip.dataset.day, String(day), 'data-day survives for repaint lookups');
    assert.equal(chip.attrs.get('aria-pressed'), String(day <= 4));
  });

  // A click on Sat: the callback receives the day, the next (sorted, unique)
  // set, and the chip itself.
  group.children[5].listeners.get('click')();
  assert.deepEqual(days, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(toggles, [[5, '5']]);

  // Clicking it again removes it; clicking an already-listed weekday removes
  // that one — membership, not position, decides.
  group.children[5].listeners.get('click')();
  assert.deepEqual(days, [0, 1, 2, 3, 4]);
  group.children[0].listeners.get('click')();
  assert.deepEqual(days, [1, 2, 3, 4]);
});

test('buildDayPicker leaves the label and per-chip aria off unless asked', () => {
  installPickerDoc();
  const group = buildDayPicker({
    className: 'days',
    chipClass: 'day',
    describeId: 'rule-error-0',
    getDays: () => [0],
    onToggle: () => {},
  });

  assert.equal(group.attrs.has('aria-label'), false);
  // Without `pressed`, no chip claims a state; without `dataDay`, no chip
  // carries data-day — the settings editor opts into both, the schedule
  // editor's initial paint opts into pressed only.
  group.children.forEach((chip) => {
    assert.equal(chip.attrs.has('aria-pressed'), false);
    assert.equal(chip.attrs.has('aria-label'), false);
    assert.equal('day' in chip.dataset, false);
  });
});

// ---------- initTabbar: route-change confirmation seam (#129) ----------
//
// The router can hold a route change for a confirmation dialog: the hook
// returns a promise, the panels do not switch until it resolves, a falsy
// resolution keeps the current route. A tab click asks *before* the hash
// moves, so a Stay answer rewrites no history entry; a hashchange the router
// did not make (back/forward) is held after the fact and snapped back with
// replaceState. Rewriting a pushed entry instead would strand a dead Back
// press — adjacent entries with the same fragment fire popstate only, and
// this router (like the harness below) listens to hashchange. These tests
// pin the seam with the repo's hand-rolled DOM stub (no jsdom), so
// `location`, `history` and `window` are stubs the harness owns and
// `hashchange` is dispatched by hand, exactly as the browser would deliver
// it.

const ROUTES = ['status', 'history', 'schedule', 'config', 'advanced'];

function makeShell() {
  const shell = {
    replaces: [],
    title: '',
    focused: null,
    routes: [],
    hashListeners: new Set(),
  };
  const tabs = ROUTES.map((route) => ({
    dataset: { route },
    ariaSelected: 'false',
    tabIndex: 0,
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    // HTMLElement.click() dispatches the click listener — how the Config
    // panel's "Advanced console" link drives the tab.
    click() {
      this.listeners.get('click')();
    },
    setAttribute(name, value) {
      if (name === 'aria-selected') this.ariaSelected = String(value);
    },
    focus() {
      shell.focused = this.dataset.route;
    },
  }));
  const panels = {};
  const tabbar = { listeners: new Map(), addEventListener() {} };
  // Screens wire buttons by id (initConfig below needs more than `hidden`).
  const element = (id) =>
    (panels[id] = panels[id] || {
      hidden: id !== 'panel-status',
      textContent: '',
      listeners: new Map(),
      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      },
      replaceChildren() {},
    });
  globalThis.document = {
    title: '',
    querySelectorAll: (selector) => (selector === '.tab' ? tabs : []),
    querySelector: (selector) => {
      if (selector === '.tabbar') return tabbar;
      if (selector === '.tab[aria-selected="true"]')
        return tabs.find((tab) => tab.ariaSelected === 'true') ?? null;
      const byRoute = selector.match(/^\.tab\[data-route="(.+)"\]$/);
      if (byRoute) return tabs.find((tab) => tab.dataset.route === byRoute[1]) ?? null;
      return null;
    },
    getElementById: element,
  };
  Object.defineProperty(globalThis.document, 'title', {
    get: () => shell.title,
    set: (value) => {
      shell.title = value;
    },
  });
  // A real location normalises a bare assignment: location.hash = 'history'
  // reads back '#history'. The stub must too — the router assigns bare route
  // names, and the tests assert the '#route' form the browser would show.
  globalThis.location = {
    rawHash: '',
    get hash() {
      return this.rawHash;
    },
    set hash(value) {
      this.rawHash = String(value).startsWith('#') ? String(value) : `#${value}`;
    },
  };
  globalThis.history = {
    scrollRestoration: 'auto',
    replaceState(state, title, url) {
      shell.replaces.push(url);
      globalThis.location.hash = url;
    },
  };
  globalThis.window = { scrollY: 0, scrollTo() {} };
  globalThis.addEventListener = (type, listener) => shell.hashListeners.add(listener);
  globalThis.removeEventListener = () => {};
  // The browser delivers one hashchange per hash move; the harness fires it.
  const fireHash = () => {
    for (const listener of shell.hashListeners) listener();
  };
  const go = (route) => {
    globalThis.location.hash = `#${route}`;
    fireHash();
  };
  return { shell, tabs, go, fireHash, tabVisible: (route) => !panels[`panel-${route}`].hidden };
}

test('initTabbar applies route changes immediately when no guard holds them', () => {
  const { shell, go, tabVisible } = makeShell();
  const routes = [];
  initTabbar({ onRoute: (route) => routes.push(route) });
  assert.equal(tabVisible('status'), true);

  go('config');
  assert.equal(tabVisible('config'), true);
  assert.equal(shell.title, 'Config — ChelEVSE');
  // The initial render enters Status once (null → status counts as changed),
  // exactly as the boot render does.
  assert.deepEqual(routes, ['status', 'config']);

  // A hook that does not vouch for a promise (a clean form) navigates as before.
  initTabbar({ onRoute: () => undefined, confirmLeave: () => null });
  go('history');
  assert.equal(tabVisible('history'), true);
});

test('a truthy non-promise hook return navigates immediately', () => {
  const { tabs, go, fireHash, tabVisible } = makeShell();
  // The app.js wiring returns the dialog promise or null; the seam's contract
  // is that only a promise holds the change. A truthy non-promise return
  // silently holding the route would kill that composition with tests green.
  initTabbar({ onRoute: () => {}, confirmLeave: () => 'asked but not a promise' });
  go('config');
  assert.equal(tabVisible('config'), true, 'a hashchange-held change applies');

  // The tab click asks the same hook and follows the same rule: it pushes,
  // and the hashchange the push fires applies the route.
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();
  assert.equal(globalThis.location.hash, '#history');
  fireHash();
  assert.equal(tabVisible('history'), true);
});

test('a held tab click asks before pushing, so Stay touches no history entry', async () => {
  const { shell, tabs, go, tabVisible } = makeShell();
  let hold = null;
  initTabbar({ onRoute: () => {}, confirmLeave: () => hold });
  go('config'); // No guard in the way yet (null decision navigates).

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();

  // The dialog holds the change before any push: the URL still names Config
  // (a reload mid-dialog cannot land on the pending tab) and nothing applied.
  assert.equal(globalThis.location.hash, '#config', 'the click has not pushed yet');
  assert.equal(tabVisible('history'), false);
  assert.equal(tabVisible('config'), true);

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('config'), true, 'Stay keeps the Config panels');
  assert.equal(globalThis.location.hash, '#config');
  // Only the boot canonicalisation — Stay rewrote nothing. Rewriting the
  // pushed entry instead would strand a dead Back press: adjacent entries
  // with the same fragment fire popstate only, not hashchange.
  assert.deepEqual(shell.replaces, ['#status'], 'Stay writes no history at all');
});

test('a confirmed held click pushes its route once; the push hashchange does not re-ask', async () => {
  const { shell, tabs, go, fireHash, tabVisible } = makeShell();
  const asks = [];
  let hold = null;
  const confirmLeave = (from, to) => {
    asks.push([from, to]);
    return hold;
  };
  initTabbar({ onRoute: () => {}, confirmLeave });
  go('config'); // ask 1: clean, navigates.

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();

  settle(true); // Leave
  await tick();
  assert.equal(tabVisible('history'), true, 'Leave applies the held click');
  assert.equal(globalThis.location.hash, '#history', 'the click pushes its entry');
  assert.equal(shell.focused, 'history', 'focus lands on the newly selected tab');
  assert.deepEqual(shell.replaces, ['#status'], 'the push is the entry — no rewrite');

  // The browser fires one hashchange after the push; it must re-render as a
  // no-op (the route already applies) — not re-ask or double-apply.
  const asksBefore = asks.length;
  fireHash();
  assert.equal(asks.length, asksBefore, 'the push hashchange does not re-ask');
  assert.equal(tabVisible('history'), true);
});

test('a hash move during a held click snaps back; Leave still applies the clicked route', async () => {
  const { shell, tabs, go, tabVisible } = makeShell();
  let hold = null;
  initTabbar({ onRoute: () => {}, confirmLeave: () => hold });
  go('config');

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();

  // A drift move mid-dialog is pinned back to the current route, exactly as
  // for a held traversal; nothing applies.
  go('schedule');
  assert.equal(globalThis.location.hash, '#config', 'the drift snaps back');
  assert.equal(tabVisible('schedule'), false);

  settle(true); // The original answer applies the originally clicked route.
  await tick();
  assert.equal(tabVisible('history'), true);
  assert.equal(globalThis.location.hash, '#history');
});

test('a rejected held click keeps the route, writes no history and frees the guard', async () => {
  const { shell, tabs, go, tabVisible } = makeShell();
  let hold = null;
  const routes = [];
  initTabbar({ onRoute: (route) => routes.push(route), confirmLeave: () => hold });
  go('config'); // No guard in the way yet.

  // The dialog promise itself breaks: a rejection is an implicit stay.
  hold = Promise.reject(new Error('the dialog broke'));
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();
  await tick();
  assert.equal(tabVisible('history'), false, 'the clicked route is not applied');
  assert.equal(tabVisible('config'), true, 'the panels stay on the current route');
  assert.equal(globalThis.location.hash, '#config', 'the hash never moved');
  assert.deepEqual(shell.replaces, ['#status'], 'the rejection rewrites nothing');

  // The rejection must free the guard, not wedge it: the next change is held
  // for its own answer, and only an applied Leave can prove it.
  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('schedule');
  assert.equal(tabVisible('schedule'), false, 'a later leave is held again');
  settle(true);
  await tick();
  assert.equal(tabVisible('schedule'), true, 'the later Leave applies — the guard was freed');
  assert.deepEqual(routes, ['status', 'config', 'schedule'], 'the entry hook runs once per route');
});

test('the Config panel link navigates through the guarded tab path, not a raw hash write', async () => {
  const { shell, go, fireHash, tabVisible } = makeShell();
  let hold = null;
  const asks = [];
  const confirmLeave = (from, to) => {
    asks.push([from, to]);
    return hold;
  };
  initTabbar({ onRoute: () => {}, confirmLeave });
  go('config'); // ask 1: clean, navigates.

  // The "Advanced console" link must drive the Advanced tab's own click
  // handler — ask before push. A direct location.hash write there would push
  // #advanced first, and the Stay snap-back would rewrite that pushed entry,
  // stranding a dead Back press between identical fragments.
  initConfig();
  const link = globalThis.document.getElementById('config-goto-advanced');
  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  link.listeners.get('click')();

  assert.deepEqual(asks.at(-1), ['config', 'advanced'], 'the link asks the same guard');
  assert.equal(globalThis.location.hash, '#config', 'nothing was pushed before the answer');
  assert.equal(tabVisible('advanced'), false);

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('config'), true, 'Stay keeps the Config panels');
  assert.equal(globalThis.location.hash, '#config');
  assert.deepEqual(shell.replaces, ['#status'], 'Stay writes no history at all');

  // Clean form: the link still ends up on Advanced, via the tab's push.
  hold = null;
  link.listeners.get('click')();
  assert.equal(globalThis.location.hash, '#advanced', 'the clean link pushes its entry');
  fireHash();
  assert.equal(tabVisible('advanced'), true);
});

test('a held leave keeps the panels on the current route until it resolves', async () => {
  const { shell, go, tabVisible } = makeShell();
  // Land on Config first, without a guard in the way.
  let hold = null;
  const confirmLeave = () => hold;
  initTabbar({ onRoute: () => {}, confirmLeave });
  go('config');

  // Now dirty: the next change is held.
  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('history');
  // The guard was asked, nothing was applied, and the hash waits on the answer.
  assert.equal(tabVisible('config'), true);
  assert.equal(tabVisible('history'), false);
  assert.equal(globalThis.location.hash, '#history');

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('config'), true, 'Stay keeps the Config panels');
  assert.equal(globalThis.location.hash, '#config');
  // '#status' is the boot render canonicalising the empty hash; '#config' is
  // the Stay restore.
  assert.deepEqual(shell.replaces, ['#status', '#config'], 'Stay restores the Config hash');
});

test('a confirmed leave applies the pending route, pins its hash and focuses its tab', async () => {
  const { shell, go, tabVisible } = makeShell();
  let hold = null;
  const routes = [];
  initTabbar({
    onRoute: (route) => routes.push(route),
    confirmLeave: () => hold,
  });
  go('config');

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('schedule');
  assert.equal(tabVisible('schedule'), false);

  settle(true); // Leave
  await tick();
  assert.equal(tabVisible('schedule'), true, 'Leave applies the pending route');
  assert.equal(globalThis.location.hash, '#schedule');
  assert.deepEqual(routes, ['status', 'config', 'schedule'], 'the entry hook runs once per route');
  assert.equal(shell.focused, 'schedule', 'focus lands on the newly selected tab');
});

test('an open guard owns the navigation: later hash moves and tab clicks wait for it', async () => {
  const { shell, go, fireHash, tabs, tabVisible } = makeShell();
  let hold = null;
  initTabbar({ onRoute: () => {}, confirmLeave: () => hold });
  go('config');

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('history');

  // Another hash move mid-dialog snaps back; nothing applies.
  go('schedule');
  assert.equal(tabVisible('history'), false);
  assert.equal(tabVisible('schedule'), false);
  assert.equal(globalThis.location.hash, '#config');

  // Re-clicking the pending route's tab must not shortcut past the dialog.
  const historyTab = tabs.find((tab) => tab.dataset.route === 'history');
  historyTab.listeners.get('click')();
  assert.equal(tabVisible('history'), false, 'the pending tab cannot apply itself');

  settle(true); // The original answer still applies the originally held route.
  await tick();
  assert.equal(tabVisible('history'), true);
  assert.equal(globalThis.location.hash, '#history');
});

test('a rejected confirmation keeps the current route, restores its hash and frees the guard', async () => {
  const { shell, go, tabVisible } = makeShell();
  let hold = null;
  const routes = [];
  initTabbar({ onRoute: (route) => routes.push(route), confirmLeave: () => hold });
  go('config'); // No guard in the way yet.

  // The dialog promise itself breaks: a rejection is an implicit stay.
  hold = Promise.reject(new Error('the dialog broke'));
  go('history');
  await tick();
  assert.equal(tabVisible('history'), false, 'the pending route is not applied');
  assert.equal(tabVisible('config'), true, 'the panels stay on the current route');
  assert.equal(globalThis.location.hash, '#config', 'the hash snaps back');
  assert.deepEqual(shell.replaces, ['#status', '#config'], 'the restore reuses replaceState');

  // The rejection must free the guard, not wedge it: the next leave is held
  // for its own answer, and only an applied Leave can prove it. A wedged
  // guard swallows the second ask entirely — a Stay-looking outcome (nothing
  // moves) would be indistinguishable from the wedge.
  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('schedule');
  assert.equal(tabVisible('schedule'), false, 'a later leave is held again');
  settle(true);
  await tick();
  assert.equal(tabVisible('schedule'), true, 'the later Leave applies — the guard was freed');
  assert.equal(globalThis.location.hash, '#schedule', 'the applied route pins its hash');
  assert.deepEqual(
    routes,
    ['status', 'config', 'schedule'],
    'the entry hook runs for the applied route',
  );
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
