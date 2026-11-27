import { test } from 'node:test';
import assert from 'node:assert/strict';

// The notification card's two focus hand-offs (#164). The card's pure copy and
// token lifecycle are pinned in test/web/notifications.test.js; this file pins
// the DOM wiring that no other test loaded. It uses the repo's module-mock-free
// stub harness (the one test/web/status-error.test.js and
// test/web/settings-screen.test.js prove): one stub element per id, every lookup
// deferred to render time, then a plain `await import` of the real screen — so
// the call sites under test are the shipping ones.
//
// What this cannot see: layout, real DOM events, or a screen reader. The focus
// assertions are the stub's `focus()` recording where the card sent focus, which
// is the whole claim.
//
// The card also reports its painted state to the Settings list on every render
// (#228, the `onState` callback app.js wires): that report is recorded here.

// Where the card moved focus, in order.
const focusLog = [];
// What the card reported to the Settings list, in order.
const reported = [];

function stubElement(tag = '') {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  return {
    tag,
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
    className: '',
    id: '',
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    focus(options) {
      this.focused = options;
      focusLog.push(this.id);
    },
  };
}

const elements = new Map();
const body = { nodeName: 'BODY' };
const documentElement = { nodeName: 'HTML' };
// Every node this harness hands out stands for an element in the page;
// `document.contains` is how the shared helper tells one from a detached node.
const live = new Set([body, documentElement]);

function element(id) {
  let el = elements.get(id);
  if (!el) {
    el = stubElement();
    el.id = id;
    elements.set(id, el);
    live.add(el);
  }
  return el;
}

globalThis.document = {
  body,
  documentElement,
  activeElement: null,
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  contains: (node) => live.has(node),
};

// The card asks the browser what it supports; nothing here reaches the network.
// No VAPID key is configured in this harness (`firebase-config.js` never loads),
// so the no-key path answers before `loadMessaging`, and a signed-out uid stops
// registration before any token request.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true, serviceWorker: {} },
});

globalThis.Notification = {
  permission: 'default',
  requestPermission: async () => 'granted',
};

const { initNotifications, resetNotifications } =
  await import('../../web/js/screens/notifications.js');

// The listeners under test are the ones initNotifications itself registers.
initNotifications({ onState: (view) => reported.push(view) });

// The card keeps module state, so every case starts from the load-time state:
// nothing asked, no permission, nothing registered. The reset's own render is
// not a report any case reads.
function resetCard() {
  globalThis.Notification.permission = 'default';
  focusLog.length = 0;
  globalThis.document.activeElement = null;
  resetNotifications();
  reported.length = 0;
}

async function click(node) {
  const listeners = node.listeners.get('click') || [];
  assert.equal(listeners.length, 1, `#${node.id} is wired once`);
  await listeners[0]();
}

test('the retry path moves focus from the hidden Retry to #notify-status', async () => {
  // A failed registration leaves a Retry the owner clicked; the render that
  // answers hides it, so the status line takes the focus it dropped instead of
  // the top of the page.
  resetCard();
  globalThis.document.activeElement = body;

  await click(element('notify-retry'));

  assert.equal(element('notify-retry').hidden, true, 'the trigger was gone when focus moved');
  assert.deepEqual(focusLog, ['notify-status']);
  assert.deepEqual(element('notify-status').focused, { preventScroll: true });
});

test('the retry path leaves focus alone when it sits on a live control', async () => {
  // The owner moved on to another control while the retry was pending; nothing
  // is stolen back from them.
  resetCard();
  globalThis.document.activeElement = element('notify-detail');

  await click(element('notify-retry'));

  assert.equal(element('notify-retry').hidden, true);
  assert.deepEqual(focusLog, []);
});

test('the enable path moves focus from the hidden Enable to #notify-status', async () => {
  // Enable hides the moment it is pressed (the card goes to "registering"), so
  // the click's own focus is gone by the time it settles; whichever way the
  // permission and token answer lands, the finally hands focus to the status
  // line rather than the top of the page.
  resetCard();
  globalThis.document.activeElement = body;

  await click(element('notify-enable'));

  assert.equal(element('notify-enable').hidden, true, 'the trigger was gone when focus moved');
  assert.deepEqual(focusLog, ['notify-status']);
  assert.deepEqual(element('notify-status').focused, { preventScroll: true });
});

test('the enable path leaves focus alone when it sits on a live control', async () => {
  resetCard();
  globalThis.document.activeElement = element('notify-detail');

  await click(element('notify-enable'));

  assert.equal(element('notify-enable').hidden, true);
  assert.deepEqual(focusLog, []);
});

test('every render reports the card’s state to the Settings list, with the token phase', async () => {
  // The list's Notifications card (#228) has no listener of its own: its one
  // line is what the card reports here on every render — the kind it was just
  // painted in, and the token phase, which the kind alone cannot use to tell
  // a registered device from one still registering. This harness has no VAPID
  // key and no account, so both paths below stop early and the card stays on
  // "checking"; which line each kind becomes is pinned in
  // test/web/settings-list.test.js.
  resetCard();
  assert.deepEqual(reported, []);

  // Enable: "registering" from the press, before anything is asked.
  await click(element('notify-enable'));
  assert.equal(element('notify-card').dataset.state, 'checking');
  assert.deepEqual(reported, [{ kind: 'checking', tokenPhase: 'registering' }]);

  // Retry: a registration that fails early reports the failure, not the
  // phase the path started in.
  resetCard();
  await click(element('notify-retry'));
  assert.deepEqual(reported, [{ kind: 'checking', tokenPhase: 'failed' }]);
});
