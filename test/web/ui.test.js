import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initTabbar, routeFor } from '../../web/js/ui.js';

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

// ---------- initTabbar: route-change confirmation seam (#129) ----------
//
// The router can hold a route change for a confirmation dialog: the hook
// returns a promise, the panels do not switch until it resolves, a falsy
// resolution keeps the current route and restores its hash. These tests pin
// the seam with the repo's hand-rolled DOM stub (no jsdom), so `location`,
// `history` and `window` are stubs the harness owns and `hashchange` is
// dispatched by hand, exactly as the browser would deliver it.

const ROUTES = ['status', 'history', 'schedule', 'config', 'advanced'];

function makeShell() {
  const shell = {
    hash: '',
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
    setAttribute(name, value) {
      if (name === 'aria-selected') this.ariaSelected = String(value);
    },
    focus() {
      shell.focused = this.dataset.route;
    },
  }));
  const panels = {};
  const tabbar = { listeners: new Map(), addEventListener() {} };
  globalThis.document = {
    title: '',
    querySelectorAll: (selector) => (selector === '.tab' ? tabs : []),
    querySelector: (selector) => {
      if (selector === '.tabbar') return tabbar;
      if (selector === '.tab[aria-selected="true"]')
        return tabs.find((tab) => tab.ariaSelected === 'true') ?? null;
      return null;
    },
    getElementById: (id) => (panels[id] = panels[id] || { hidden: id !== 'panel-status' }),
  };
  Object.defineProperty(globalThis.document, 'title', {
    get: () => shell.title,
    set: (value) => {
      shell.title = value;
    },
  });
  globalThis.location = { hash: '' };
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

  settle(true); // Discard
  await tick();
  assert.equal(tabVisible('schedule'), true, 'Discard applies the pending route');
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
