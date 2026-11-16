import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The listener-failure state (#153) is DOM wiring, so it is pinned the repo's
// way: the module-mock-free stub proven in test/web/status-pulse.test.js and
// test/web/settings-screen.test.js — one stub element per id, every lookup
// deferred to render time, then a plain `await import` of the real screen. No
// jsdom and no module mocks, so `retryStore()` behaves exactly as it does in
// the app: with no store started it returns false, which is the case the
// Retry control has to survive.
//
// What this cannot see: layout, real DOM events, or a screen reader. The
// `role="alert"` exposure is therefore pinned from source (the
// config-lifetime convention) beside the copy, which the alert's own text
// carries.

// What the screen moved focus to, in order (settings-screen.test.js records the
// same way: the stub's focus() is the only observer an unstubbed DOM offers).
const focusLog = [];

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

function element(id) {
  let el = elements.get(id);
  if (!el) {
    el = stubElement();
    el.id = id;
    elements.set(id, el);
  }
  return el;
}

globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
  createTextNode: (text) => ({ textContent: text }),
};

const { initStatus, showStatus, showStatusError } = await import('../../web/js/screens/status.js');
const { retryStore } = await import('../../web/js/store.js');

// The listeners the Retry case needs are the ones initStatus itself registers.
initStatus();

const snapshot = (overrides) => ({
  exists: () => true,
  data: () => ({
    state: 3,
    state_label: 'charging',
    charger_online: true,
    updated_at: { toMillis: () => Date.now() },
    elapsed: 600,
    power: 7400,
    session_energy: 2000,
    amp: 16,
    pilot: 16,
    ...overrides,
  }),
});

const errorVisible = () => element('status-error').hidden === false;
const retryVisible = () => element('status-retry').hidden === false;

test('a screen that never got data still reads "waiting for data"', () => {
  // The pre-data presentation is not allowed to move: this is the byte-for-byte
  // baseline every other case is a departure from.
  showStatus({ exists: () => false });
  assert.equal(element('updated').textContent, 'waiting for data');
  assert.equal(element('updated').hidden, false);
  assert.equal(errorVisible(), false);
  assert.equal(retryVisible(), false);
  assert.equal(element('banner').hidden, true);
  assert.equal(element('fig-amp').textContent, '—');
});

test('a live snapshot renders the figures it always did', () => {
  showStatus(snapshot());
  assert.equal(element('fig-amp').textContent, '16');
  assert.notEqual(element('power').textContent, '—');
  assert.match(element('updated').textContent, /^updated /);
  assert.equal(element('updated').hidden, false);
});

test('a listener failure states the failure instead of waiting for data (R1/R2)', () => {
  // Start from a screen that was rendering: the error must take the figures
  // away, not merely fail to add them.
  showStatus(snapshot());
  showStatusError();

  const error = element('status-error');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Couldn’t load the charger status.');
  // A Retry that tells the owner to reload the page is the bug this replaces.
  assert.doesNotMatch(error.textContent, /reload/i);
  assert.equal(retryVisible(), true);
  // The control's label lives in the markup, not in JS: it is pinned with the
  // rest of the element in the source test at the end of this file.

  // The caption is the pre-data claim; it must not survive the failure.
  const updated = element('updated');
  assert.equal(updated.hidden, true);
  assert.notEqual(updated.textContent, 'waiting for data');

  // No snapshot, no figures, and the staleness banner stays out of it.
  assert.equal(element('fig-amp').textContent, '—');
  assert.equal(element('power').textContent, '—');
  assert.equal(element('banner').hidden, true);
});

test('a snapshot after the failure puts the screen back (R3)', () => {
  showStatusError();
  assert.equal(errorVisible(), true);

  showStatus(snapshot());
  assert.equal(errorVisible(), false);
  assert.equal(retryVisible(), false);
  assert.equal(element('updated').hidden, false);
  assert.match(element('updated').textContent, /^updated /);
  assert.equal(element('fig-amp').textContent, '16');
  assert.notEqual(element('power').textContent, '—');
});

test('a cached snapshot clears the failure too', () => {
  // Provenance does not matter here: the listener answered, which is the whole
  // claim the failure line made. (The screen's staleness verdict is #banner's
  // job, not this line's.)
  showStatusError();
  showStatus(snapshot({ charger_online: false }));
  assert.equal(errorVisible(), false);
  assert.equal(retryVisible(), false);
});

test('the alert is exposed before its text is written', () => {
  // A live region announces content inserted into a node it can already see; a
  // hidden → shown node whose text changed while it was hidden is not announced
  // by every screen-reader/browser pair, so the order is the promise. Pinned
  // from source, the convention this file already uses for the markup.
  const source = readFileSync(new URL('../../web/js/screens/status.js', import.meta.url), 'utf8');
  const body = /function renderStatusError\(\) \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(body, 'status.js still declares renderStatusError');
  const reveal = body[1].indexOf('error.hidden = !failed');
  const write = body[1].indexOf('setText(error, STATUS_FAILED)');
  assert.notEqual(reveal, -1, 'renderStatusError still reveals #status-error');
  assert.notEqual(write, -1, 'renderStatusError still writes the failure text');
  assert.ok(reveal < write, 'the alert is on screen before its text is written');
});

test('a snapshot no retry preceded moves no focus', () => {
  // Recovery focus must not become a general "every snapshot jumps the caret"
  // rule: nothing was asked for, so nothing moves.
  showStatusError();
  focusLog.length = 0;
  showStatus(snapshot());
  assert.deepEqual(focusLog, []);
  showStatus(snapshot());
  assert.deepEqual(focusLog, []);
});

test('a successful retry moves focus from the hidden control to the panel', () => {
  // The snapshot that clears the failure hides Try again; a focused node that
  // leaves the tree sends focus to <body>, so the panel it just refilled takes
  // it instead. The retry itself moves nothing while it is still pending.
  const listeners = element('status-retry').listeners.get('click') || [];
  assert.equal(listeners.length, 1, 'initStatus wired #status-retry once');

  showStatusError();
  focusLog.length = 0;
  listeners[0]();
  assert.deepEqual(focusLog, [], 'a pending retry leaves focus where the click put it');

  showStatus(snapshot());
  assert.equal(retryVisible(), false);
  assert.equal(errorVisible(), false);
  assert.equal(focusLog.at(-1), 'panel-status');
  assert.deepEqual(element('panel-status').focused, { preventScroll: true });
});

test('activating Retry with no store started throws nothing (R5)', () => {
  // R5 in this unit is the wiring, not a live re-subscribe: retryStore() is the
  // shared path PR-2 will reuse, and in this harness nothing was ever retained,
  // so the real function returns false. The control must stay inert and the
  // failure line must stay on screen for it.
  const listeners = element('status-retry').listeners.get('click') || [];
  assert.equal(listeners.length, 1, 'initStatus wired #status-retry once');

  showStatusError();
  assert.doesNotThrow(() => listeners[0]());
  assert.equal(retryStore(), false, 'no retained options to replay');
  assert.equal(errorVisible(), true, 'a no-op retry leaves the failure state alone');
  assert.equal(element('updated').hidden, true);
});

test('index.html ships the alert line and the Retry beside #updated', () => {
  // The stub answers any id on demand, so the markup is pinned from source
  // (the config-lifetime/settings-screen convention). `role="alert"` is here
  // and nowhere else in JS: the element's exposure is a markup fact.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(source, /<p class="field-error" id="status-error" role="alert" hidden><\/p>/);
  assert.match(
    source,
    /<button id="status-retry" class="btn small" type="button" hidden>Try again<\/button>/,
  );

  const at = {
    panel: source.indexOf('id="panel-status"'),
    updated: source.indexOf('id="updated"'),
    error: source.indexOf('id="status-error"'),
    retry: source.indexOf('id="status-retry"'),
    figures: source.indexOf('class="figures"'),
  };
  for (const [marker, position] of Object.entries(at)) {
    assert.notEqual(position, -1, `${marker} is missing from web/index.html`);
  }
  assert.ok(
    at.panel < at.updated && at.updated < at.error && at.error < at.retry && at.retry < at.figures,
    'the failure line and its Retry sit under the freshness caption, inside the status panel',
  );
});
