import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initTabbar,
  routeFor,
  buildDayPicker,
  toggleDay,
  focusAfterRetry,
} from '../../web/js/ui.js';
import { initConfig } from '../../web/js/screens/config.js';
import { DAY_NAMES } from '../../web/js/schedule.js';

test('routeFor accepts known hashes and canonicalises the rest', () => {
  assert.equal(routeFor('#status'), 'status');
  assert.equal(routeFor('#History'), 'history');
  // The Settings list and the four screens its cards open (#228). #schedule
  // keeps resolving: a link saved before the move must still open the editor.
  assert.equal(routeFor('#config'), 'config');
  assert.equal(routeFor('#schedule'), 'schedule');
  assert.equal(routeFor('#prices'), 'prices');
  assert.equal(routeFor('#Notifications'), 'notifications');
  assert.equal(routeFor('#charger'), 'charger');
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
//
// The bar holds four tabs (#228): Status, History, Settings, Advanced. The
// Settings list is the Settings tab's own route (`config`), and the four
// screens its cards open are views inside that tabpanel — `panel-<route>`.
// The guard cases below sit on `prices`, the screen the dirty form moved to.

// The tabs the shipped bar holds, in its order.
const ROUTES = ['status', 'history', 'config', 'advanced'];

function makeShell() {
  const shell = {
    replaces: [],
    title: '',
    focused: null,
    // Every focus, in order — the tab's route or the element's id. The
    // Settings focus hand-offs land on views and cards, not only on tabs.
    focusLog: [],
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
    // HTMLElement.click() dispatches the click listener — how the Charger
    // screen's "Advanced console" link drives the tab.
    click() {
      this.listeners.get('click')();
    },
    setAttribute(name, value) {
      if (name === 'aria-selected') this.ariaSelected = String(value);
    },
    focus() {
      shell.focused = this.dataset.route;
      shell.focusLog.push(this.dataset.route);
    },
  }));
  const panels = {};
  const tabbar = { listeners: new Map(), addEventListener() {} };
  // Screens wire buttons by id (initConfig below needs more than `hidden`).
  // Every id under `panel-` is a view the router shows; `settings-list` and
  // `settings-card-<route>` are the list and its cards.
  const element = (id) =>
    (panels[id] = panels[id] || {
      id,
      hidden: id !== 'panel-status',
      textContent: '',
      listeners: new Map(),
      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      },
      replaceChildren() {},
      focus(options) {
        this.focused = options;
        shell.focused = id;
        shell.focusLog.push(id);
      },
    });
  globalThis.document = {
    title: '',
    activeElement: undefined,
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
  const settingsTab = () => tabs.find((tab) => tab.dataset.route === 'config');
  // Whether a tab claims selection, and whether a view is shown.
  const selected = (route) =>
    tabs.find((tab) => tab.dataset.route === route)?.ariaSelected === 'true';
  const tabVisible = (route) => !panels[`panel-${route}`].hidden;
  return { shell, tabs, panels, go, fireHash, tabVisible, settingsTab, selected };
}

test('initTabbar applies route changes immediately when no guard holds them', () => {
  const { shell, go, tabVisible } = makeShell();
  const routes = [];
  initTabbar({ onRoute: (route) => routes.push(route) });
  assert.equal(tabVisible('status'), true);

  go('config');
  assert.equal(tabVisible('config'), true);
  assert.equal(shell.title, 'Settings — ChelEVSE');
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
  go('prices');
  assert.equal(tabVisible('prices'), true, 'a hashchange-held change applies');

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
  go('prices'); // No guard in the way yet (null decision navigates).

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();

  // The dialog holds the change before any push: the URL still names the
  // Prices screen (a reload mid-dialog cannot land on the pending tab) and
  // nothing applied.
  assert.equal(globalThis.location.hash, '#prices', 'the click has not pushed yet');
  assert.equal(tabVisible('history'), false);
  assert.equal(tabVisible('prices'), true);

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('prices'), true, 'Stay keeps the Prices screen');
  assert.equal(globalThis.location.hash, '#prices');
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
  go('prices'); // ask 1: clean, navigates.

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
  go('prices');

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();

  // A drift move mid-dialog is pinned back to the current route, exactly as
  // for a held traversal; nothing applies.
  go('schedule');
  assert.equal(globalThis.location.hash, '#prices', 'the drift snaps back');
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
  go('prices'); // No guard in the way yet.

  // The dialog promise itself breaks: a rejection is an implicit stay.
  hold = Promise.reject(new Error('the dialog broke'));
  tabs.find((tab) => tab.dataset.route === 'history').listeners.get('click')();
  await tick();
  assert.equal(tabVisible('history'), false, 'the clicked route is not applied');
  assert.equal(tabVisible('prices'), true, 'the panels stay on the current route');
  assert.equal(globalThis.location.hash, '#prices', 'the hash never moved');
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
  assert.deepEqual(routes, ['status', 'prices', 'schedule'], 'the entry hook runs once per route');
});

test('the Charger screen link navigates through the guarded tab path, not a raw hash write', async () => {
  const { shell, go, fireHash, tabVisible } = makeShell();
  let hold = null;
  const asks = [];
  const confirmLeave = (from, to) => {
    asks.push([from, to]);
    return hold;
  };
  initTabbar({ onRoute: () => {}, confirmLeave });
  go('charger'); // ask 1: clean, navigates.

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

  assert.deepEqual(asks.at(-1), ['charger', 'advanced'], 'the link asks the same guard');
  assert.equal(globalThis.location.hash, '#charger', 'nothing was pushed before the answer');
  assert.equal(tabVisible('advanced'), false);

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('charger'), true, 'Stay keeps the Charger screen');
  assert.equal(tabVisible('config'), true, 'inside the Settings tabpanel');
  assert.equal(globalThis.location.hash, '#charger');
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
  // Land on the Prices screen first, without a guard in the way.
  let hold = null;
  const confirmLeave = () => hold;
  initTabbar({ onRoute: () => {}, confirmLeave });
  go('prices');

  // Now dirty: the next change is held.
  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('history');
  // The guard was asked, nothing was applied, and the hash waits on the answer.
  assert.equal(tabVisible('prices'), true);
  assert.equal(tabVisible('history'), false);
  assert.equal(globalThis.location.hash, '#history');

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('prices'), true, 'Stay keeps the Prices screen');
  assert.equal(globalThis.location.hash, '#prices');
  // '#status' is the boot render canonicalising the empty hash; '#prices' is
  // the Stay restore.
  assert.deepEqual(shell.replaces, ['#status', '#prices'], 'Stay restores the Prices hash');
});

test('a confirmed leave applies the pending route, pins its hash and focuses its tab', async () => {
  const { shell, go, tabVisible } = makeShell();
  let hold = null;
  const routes = [];
  initTabbar({
    onRoute: (route) => routes.push(route),
    confirmLeave: () => hold,
  });
  go('prices');

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
  assert.deepEqual(routes, ['status', 'prices', 'schedule'], 'the entry hook runs once per route');
  // A Settings screen keeps the Settings tab selected, so that is the tab a
  // confirmed leave leaves focus on.
  assert.equal(shell.focused, 'config', 'focus lands on the newly selected tab');
});

test('an open guard owns the navigation: later hash moves and tab clicks wait for it', async () => {
  const { shell, go, fireHash, tabs, tabVisible } = makeShell();
  let hold = null;
  initTabbar({ onRoute: () => {}, confirmLeave: () => hold });
  go('prices');

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('history');

  // Another hash move mid-dialog snaps back; nothing applies.
  go('schedule');
  assert.equal(tabVisible('history'), false);
  assert.equal(tabVisible('schedule'), false);
  assert.equal(globalThis.location.hash, '#prices');

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
  go('prices'); // No guard in the way yet.

  // The dialog promise itself breaks: a rejection is an implicit stay.
  hold = Promise.reject(new Error('the dialog broke'));
  go('history');
  await tick();
  assert.equal(tabVisible('history'), false, 'the pending route is not applied');
  assert.equal(tabVisible('prices'), true, 'the panels stay on the current route');
  assert.equal(globalThis.location.hash, '#prices', 'the hash snaps back');
  assert.deepEqual(shell.replaces, ['#status', '#prices'], 'the restore reuses replaceState');

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
    ['status', 'prices', 'schedule'],
    'the entry hook runs for the applied route',
  );
});

// ---------- the Settings tab and its screens (#228) ----------
//
// Settings is one tab with a list and four screens. Each route shows exactly
// one tabpanel and, inside the Settings tabpanel, exactly one view; the tab
// follows the route's parent; and the two focus hand-offs — the region when a
// card opens a screen, the card when the list comes back — are the router's.
// What the stub cannot see: the visual list, the focus ring, and a screen
// reader naming the region (docs/VALIDATION.md, S rows).

const SETTINGS_ROUTES = ['schedule', 'prices', 'notifications', 'charger'];
const VIEW_ROUTES = ['status', 'history', 'config', 'advanced', ...SETTINGS_ROUTES];

test('each route shows one tabpanel and, inside Settings, exactly one view', () => {
  const { panels, go } = makeShell();
  initTabbar({ onRoute: () => {} });
  const shown = (routes) => routes.filter((route) => !panels[`panel-${route}`].hidden);
  // The four tabs' own tabpanels, and the five views inside the Settings one.
  const TABS = ['status', 'history', 'config', 'advanced'];
  const views = () => [
    ...SETTINGS_ROUTES.filter((route) => !panels[`panel-${route}`].hidden),
    ...(panels['settings-list'].hidden ? [] : ['settings-list']),
  ];

  // The list is the Settings tab's own route: its tabpanel, holding the list.
  go('config');
  assert.deepEqual(shown(TABS), ['config']);
  assert.deepEqual(views(), ['settings-list']);

  // A card's route: the same tabpanel, now holding that screen alone.
  for (const route of SETTINGS_ROUTES) {
    go(route);
    assert.deepEqual(shown(TABS), ['config'], `${route} shows only the Settings tabpanel`);
    assert.deepEqual(views(), [route], `${route} shows its own view, and nothing else`);
  }

  // Another tab: its tabpanel alone; every Settings view is hidden with theirs.
  go('status');
  assert.deepEqual(shown(TABS), ['status']);
  assert.deepEqual(views(), []);
});

test('a Settings screen keeps the Settings tab selected and names itself in the title', () => {
  const { shell, tabs, go, selected } = makeShell();
  initTabbar({ onRoute: () => {} });
  assert.equal(selected('status'), true);

  // Roving focus follows the selection: the selected tab is the one Tab stop.
  const tabStops = () => tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.dataset.route);
  assert.deepEqual(tabStops(), ['status']);

  const titles = {
    config: 'Settings — ChelEVSE',
    schedule: 'Charge schedule — ChelEVSE',
    prices: 'Prices and charger address — ChelEVSE',
    notifications: 'Notifications — ChelEVSE',
    charger: 'Charger — ChelEVSE',
  };
  for (const [route, title] of Object.entries(titles)) {
    go(route);
    assert.equal(selected('config'), true, `${route} selects the Settings tab`);
    assert.equal(selected('status'), false);
    assert.equal(selected('history'), false);
    assert.equal(selected('advanced'), false);
    assert.deepEqual(tabStops(), ['config'], `${route} leaves one Tab stop, on Settings`);
    assert.equal(shell.title, title);
  }

  // Another tab's route takes the selection back.
  go('history');
  assert.equal(selected('config'), false);
  assert.deepEqual(tabStops(), ['history']);
});

test('the first render opens a direct link on its Settings screen, never Status', () => {
  // A refresh, a typed URL, or a #schedule link saved before the schedule
  // moved under Settings: the route is applied by initTabbar's own first
  // render, so the screen is already open when the app shows its shell.
  for (const route of SETTINGS_ROUTES) {
    const { shell, tabVisible, selected } = makeShell();
    globalThis.location.hash = `#${route}`;
    const routes = [];
    initTabbar({ onRoute: (name) => routes.push(name) });

    assert.equal(tabVisible(route), true, `${route} is shown by the first render`);
    assert.equal(tabVisible('config'), true);
    assert.equal(tabVisible('status'), false, 'never Status');
    assert.equal(selected('config'), true, `${route} selects Settings on the first render`);
    assert.deepEqual(routes, [route], 'the entry hook runs once for the opened screen');
    // Nothing was activated: the first render places no focus of its own.
    assert.deepEqual(shell.focusLog, []);
  }

  // The list itself.
  const { tabVisible, selected } = makeShell();
  globalThis.location.hash = '#config';
  initTabbar({ onRoute: () => {} });
  assert.equal(tabVisible('config'), true);
  assert.equal(selected('config'), true);
});

test('on a Settings screen the Settings tab returns to the list, asking the guard first', async () => {
  // On #prices the hash is not the Settings tab's own route, so the tab click
  // cannot short-circuit: it goes through ask-then-push, exactly like any
  // other tab. Stay therefore adds no history entry.
  const { shell, settingsTab, go, tabVisible } = makeShell();
  let hold = null;
  const asks = [];
  initTabbar({
    onRoute: () => {},
    confirmLeave: (from, to) => {
      asks.push([from, to]);
      return hold;
    },
  });
  go('prices');

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  settingsTab().click();
  assert.deepEqual(asks.at(-1), ['prices', 'config'], 'the tab asks the guard before pushing');
  assert.equal(globalThis.location.hash, '#prices', 'nothing was pushed before the answer');
  assert.equal(tabVisible('prices'), true, 'the Prices screen stays until the answer');

  settle(false); // Stay
  await tick();
  assert.equal(tabVisible('prices'), true);
  assert.equal(globalThis.location.hash, '#prices');
  assert.deepEqual(shell.replaces, ['#status'], 'Stay writes no history at all');

  // A clean form returns to the list at #config: the tab's own push, applied
  // by the hashchange it fires.
  hold = null;
  settingsTab().click();
  assert.equal(globalThis.location.hash, '#config', 'the Settings tab pushes its own route');
  go('config');
  assert.equal(tabVisible('config'), true);
  assert.equal(tabVisible('prices'), false);

  // On the other three screens no form is dirty, so the return is immediate.
  for (const route of ['schedule', 'notifications', 'charger']) {
    go(route);
    settingsTab().click();
    assert.equal(globalThis.location.hash, '#config', `${route} returns to the list`);
  }
});

test('a card activation lands focus on the screen it opened', () => {
  // The card that was activated is hidden with the list, and the browser
  // then drops focus to <body>: the region, named by its heading, takes it.
  const { shell, panels, go, tabVisible } = makeShell();
  initTabbar({ onRoute: () => {} });
  go('config');

  for (const route of SETTINGS_ROUTES) {
    shell.focusLog.length = 0;
    go(route);
    assert.equal(tabVisible(route), true);
    assert.deepEqual(shell.focusLog, [`panel-${route}`], `${route} takes focus on entry`);
    assert.deepEqual(panels[`panel-${route}`].focused, { preventScroll: true });
    go('config'); // back to the list for the next card
  }

  // Only the list's own card activation moves focus: arriving at a Settings
  // screen from another tab is an ordinary navigation, as before.
  go('history');
  shell.focusLog.length = 0;
  go('prices');
  assert.deepEqual(shell.focusLog, [], 'nothing was activated, so nothing takes focus');
});

test('back to the list from a screen lands focus on the card that was opened', () => {
  // "Back to Settings" is an ordinary link to #config, and the browser's Back
  // button lands the same way: the card the screen was opened from takes
  // focus back, wherever in the screen focus was left.
  const { shell, panels, go, tabVisible } = makeShell();
  initTabbar({ onRoute: () => {} });
  go('config');

  for (const route of SETTINGS_ROUTES) {
    go(route);
    shell.focusLog.length = 0;
    go('config');
    assert.equal(tabVisible('config'), true);
    assert.deepEqual(
      shell.focusLog,
      [`settings-card-${route}`],
      `${route}: the list takes focus back`,
    );
    assert.deepEqual(panels[`settings-card-${route}`].focused, { preventScroll: true });
    // Once is enough: re-rendering the list moves nothing.
    shell.focusLog.length = 0;
    go('config');
    assert.deepEqual(shell.focusLog, []);
  }

  // Focus inside a control of the screen being left counts the same as focus
  // on the region: the Back control itself is such a control.
  go('charger');
  globalThis.document.activeElement = panels['config-retry'];
  shell.focusLog.length = 0;
  go('config');
  assert.deepEqual(shell.focusLog, ['settings-card-charger']);
});

test('a tap on the Settings tab keeps focus on the tab, not the card', () => {
  // The one return that must not move focus: a tab tap. The tab pattern keeps
  // focus on the selected tab for every other tab, and Settings is no
  // different — focus was on a live element the owner chose.
  const { shell, settingsTab, go, tabVisible } = makeShell();
  initTabbar({ onRoute: () => {} });
  go('config');
  go('notifications');
  // A click on a tab button focuses it first.
  globalThis.document.activeElement = settingsTab();
  shell.focusLog.length = 0;

  settingsTab().click();
  assert.equal(globalThis.location.hash, '#config');
  go('config'); // the push's hashchange, as the browser delivers it
  assert.equal(tabVisible('config'), true);
  assert.equal(tabVisible('notifications'), false);
  assert.deepEqual(shell.focusLog, [], 'the list returns without stealing focus');
  globalThis.document.activeElement = undefined;
});

test('leaving a dirty Prices screen by its Back control lands on its card after the dialog', async () => {
  // Back to Settings on the Prices screen rides the Settings tab's click, so
  // the guard asks before anything moves. A confirmed leave is still a return
  // to the list: focus goes to the card that was opened, not to the tab.
  const { shell, settingsTab, panels, go } = makeShell();
  let hold = null;
  initTabbar({ onRoute: () => {}, confirmLeave: () => hold });
  go('config');
  go('prices');
  const listShown = () => panels['settings-list'].hidden === false;

  let settle;
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  shell.focusLog.length = 0;
  settingsTab().click();
  assert.equal(listShown(), false, 'held until the answer');
  assert.equal(globalThis.location.hash, '#prices');

  settle(true); // Leave without saving
  await tick();
  assert.equal(listShown(), true, 'Leave returns to the list');
  assert.equal(panels['panel-prices'].hidden, true);
  assert.equal(globalThis.location.hash, '#config');
  assert.deepEqual(shell.focusLog, ['settings-card-prices'], 'focus lands on the opened card');

  // The same leave from a back/forward move — held after the fact — lands
  // the same way instead of leaving focus on the hidden dialog's button.
  hold = null;
  go('prices');
  hold = new Promise((resolve) => {
    settle = resolve;
  });
  go('config');
  assert.equal(listShown(), false, 'the traversal is held');
  shell.focusLog.length = 0;
  settle(true);
  await tick();
  assert.equal(listShown(), true);
  assert.deepEqual(shell.focusLog, ['settings-card-prices']);
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------- focusAfterRetry: the one retry-focus policy (#164) ----------
//
// #153 pinned this helper indirectly, through the five screens that call it;
// #164 makes it the only implementation, so its policy is pinned here directly:
// the cases that must move focus (a trigger that left with the failure, while
// focus sat on <body>, on <html>, on a detached node, or on nothing at all), the
// cases that must not (a still-visible trigger, a live element the owner chose,
// a panel id that is not in the page). Same hand-rolled stub idiom as
// status-error.test.js — `focus()` is the only observer an unstubbed DOM offers.

function installFocusDoc() {
  const focusLog = [];
  const elements = new Map();
  const body = { nodeName: 'BODY' };
  const documentElement = { nodeName: 'HTML' };
  // Every node this harness hands out stands for an element in the page;
  // `contains` is how the helper tells one from a node it can only leak.
  const live = new Set([body, documentElement]);
  const element = (id) => {
    let node = elements.get(id);
    if (!node) {
      node = {
        id,
        hidden: false,
        focused: null,
        focus(options) {
          this.focused = options;
          focusLog.push(id);
        },
      };
      elements.set(id, node);
      live.add(node);
    }
    return node;
  };
  const document_ = {
    body,
    documentElement,
    activeElement: null,
    getElementById: element,
    contains: (node) => live.has(node),
  };
  globalThis.document = document_;
  return { document: document_, element, focusLog };
}

test('focusAfterRetry moves focus to the panel when focus fell to <body> or <html>', () => {
  // A Retry that leaves with its failure drops a focused control out of the tree,
  // and the browser hands focus to the top of the document: nothing there says
  // what just happened, so the panel the snapshot refilled takes it instead.
  const { document: doc, element, focusLog } = installFocusDoc();
  const retry = element('status-retry');
  retry.hidden = true;

  for (const active of [doc.body, doc.documentElement, null]) {
    doc.activeElement = active;
    focusAfterRetry(retry, 'panel-status');
  }

  assert.deepEqual(focusLog, ['panel-status', 'panel-status', 'panel-status']);
  assert.deepEqual(element('panel-status').focused, { preventScroll: true });
});

test('focusAfterRetry moves focus when the focused node left the document', () => {
  // The browser can keep `activeElement` pointing at the control a retry or a
  // rebuild removed: the reference is real, the node is not in the page. That is
  // not focus the owner placed (the settings rebuild restores already read it
  // this way), so it must not keep focus off the panel.
  const { document: doc, element, focusLog } = installFocusDoc();
  doc.activeElement = { id: 'removed-control' }; // never handed out here: detached
  const retry = element('status-retry');
  retry.hidden = true;

  focusAfterRetry(retry, 'panel-status');

  assert.deepEqual(focusLog, ['panel-status']);
});

test('focusAfterRetry leaves a visible trigger alone, and a missing one too', () => {
  // A Retry still on screen means the failure is still there, so there is no
  // recovery to move focus for. No trigger at all is the same answer.
  const { document: doc, element, focusLog } = installFocusDoc();
  doc.activeElement = doc.body;
  const retry = element('status-retry');
  retry.hidden = false;

  focusAfterRetry(retry, 'panel-status');
  focusAfterRetry(null, 'panel-status');
  focusAfterRetry(undefined, 'panel-status');

  assert.deepEqual(focusLog, []);
});

test('focusAfterRetry does not steal focus from a live element', () => {
  // The owner tabbed somewhere else while the retry was pending; that is where
  // they are, even though the trigger went away underneath them.
  const { document: doc, element, focusLog } = installFocusDoc();
  const retry = element('status-retry');
  retry.hidden = true;
  doc.activeElement = element('status-stop');

  focusAfterRetry(retry, 'panel-status');

  assert.deepEqual(focusLog, []);
});

test('focusAfterRetry no-ops when the panel id is not in the document', () => {
  // `panelId` is a lookup, not a promise: a screen whose panel is absent (or has
  // not painted yet) must not throw on the way out of a retry.
  const { document: doc, element, focusLog } = installFocusDoc();
  const retry = element('status-retry');
  retry.hidden = true;
  doc.activeElement = doc.body;
  doc.getElementById = () => undefined;

  assert.doesNotThrow(() => focusAfterRetry(retry, 'panel-status'));
  assert.deepEqual(focusLog, []);
});
