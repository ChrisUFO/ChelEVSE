import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The health card's DOM wiring (#158): the paint of the state projection, the
// listener-failure recovery, and the teardown reset. It uses the repo's
// module-mock-free stub harness (the one test/web/status-error.test.js proves):
// one stub element per id, every lookup deferred to render time, then a plain
// `await import` of the real screen — so the call sites under test are the
// shipping ones.
//
// The projection itself is pinned in test/web/health.test.js. What this file
// adds is that the screen writes it faithfully — and that no state the card can
// reach ever renders "no faults".
//
// What this cannot see: layout, real DOM events, or a screen reader. `role` and
// the focus target are therefore pinned from source, beside the copy the stub
// DOM can read.

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
const live = new Set();

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
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  // Every node this harness hands out stands for a node in the page; the shared
  // retry-focus policy asks whether focus is still inside the document.
  contains: (node) => live.has(node),
};

const { initStatus, leaveStatus, showHealth, showHealthError } =
  await import('../../web/js/screens/status.js');

// The listeners the retry cases need are the ones initStatus itself registers.
initStatus();

// Local timestamps, so the labels read the same in every timezone.
const at = (year, month, day, hour = 12, minute = 0) =>
  Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000);
const now = () => Date.now();

// The live shape on this charger: one acknowledged, counter-derived critical
// from a real trip, on a controller that never reports its relay health.
function liveDoc(overrides = {}) {
  return {
    reachable: true,
    source: 'http',
    checked_at: now() / 1000 - 60,
    gates: { settings_known: true, relay_health_known: false },
    counters: { nogndcount: 7, gfcicount: 0, stuckcount: 0 },
    advisories: [
      {
        id: 'fault.no_ground',
        category: 'fault',
        severity: 'critical',
        firmware_sticky: false,
        acked: true,
        first_seen: at(2026, 11, 8, 17, 12),
        last_seen: now() / 1000,
        classification: 'acknowledged',
        corroborated: false,
        counter_token: 7,
        first_observed: at(2026, 11, 13),
      },
    ],
    alerted: {},
    acks: { 'fault.no_ground': at(2026, 11, 14) },
    ...overrides,
  };
}

// Every string under a node, so the copy guards cover the list too.
function textOf(node) {
  if (!node) return '';
  const own = typeof node.textContent === 'string' ? node.textContent : '';
  const children = Array.isArray(node.children) ? node.children.map(textOf).join(' ') : '';
  return `${own} ${children}`.trim();
}

const cardText = () => textOf(element('health-card'));
const title = () => element('health-title').textContent;
const detail = () => element('health-detail').textContent;

function rows() {
  return element('health-list').children;
}

function chipOf(row, className) {
  const head = row.children[0];
  return head.children.find((node) => String(node.className).split(/\s+/).includes(className));
}

test('a snapshot renders the card: severity verbatim, the record kept as one', () => {
  showHealth(liveDoc());

  const card = element('health-card');
  assert.equal(card.getAttribute('data-state'), 'advisories');
  assert.equal(card.getAttribute('data-tone'), 'warn', 'the open relay gate is the caveat in play');
  assert.equal(title(), '1 acknowledged advisory');
  assert.match(detail(), /Acknowledged on the charger, kept here for the record/);
  assert.match(element('health-meta').textContent, /^Checked \d\d:\d\d$/);

  const caveat = element('health-caveat');
  assert.equal(caveat.hidden, false);
  assert.equal(
    caveat.textContent,
    'Relay health isn’t reported, so some advisory checks may be missing.',
  );

  assert.equal(element('health-list').hidden, false);
  const list = rows();
  assert.equal(list.length, 1);
  const [row] = list;
  assert.equal(row.tag, 'li');
  assert.equal(row.getAttribute('data-presentation'), 'acknowledged');
  assert.equal(row.getAttribute('data-severity'), 'critical');

  const name = chipOf(row, 'health-name');
  assert.equal(name.textContent, 'No ground');
  const state = chipOf(row, 'health-state');
  assert.equal(state.textContent, 'Acknowledged');
  const severity = chipOf(row, 'health-severity');
  assert.equal(severity.textContent, 'Critical');
  assert.equal(severity.getAttribute('data-severity'), 'critical');

  // The raw rule id and the record's date, for cross-referencing.
  const meta = row.children[1];
  assert.equal(meta.tag, 'p');
  assert.equal(meta.textContent, 'fault.no_ground · First seen 8 Nov');

  // The acceptance copy guard: a recorded critical is never an emergency, and
  // charging is not part of anything the card says.
  assert.doesNotMatch(cardText(), /no faults|all clear|is safe|\bhealthy\b|emergency|charging/i);
  assert.equal(element('health-retry').hidden, true);
});

test('a complete quiet report is neutral, and the list stands down', () => {
  showHealth(
    liveDoc({
      gates: { settings_known: true, relay_health_known: true },
      advisories: [],
    }),
  );
  assert.equal(element('health-card').getAttribute('data-state'), 'none');
  assert.equal(element('health-card').getAttribute('data-tone'), 'muted');
  assert.equal(title(), 'No advisories');
  assert.equal(element('health-caveat').hidden, true);
  assert.equal(element('health-list').hidden, true);
  assert.equal(rows().length, 0);
  assert.doesNotMatch(cardText(), /no faults|all clear|is safe|\bhealthy\b/i);
});

test('an empty list under an open gate never reads as health', () => {
  showHealth(liveDoc({ advisories: [] }));
  assert.equal(element('health-card').getAttribute('data-state'), 'incomplete');
  assert.equal(title(), 'Health incomplete');
  assert.match(detail(), /Relay health isn’t reported/);
  assert.notEqual(title(), 'No advisories');
  assert.equal(element('health-caveat').hidden, true);
});

test('an absent document is health unknown, with nothing left over from before', () => {
  // Start from a rendered record so the unknown state must take it away.
  showHealth(liveDoc());
  assert.equal(rows().length, 1);

  showHealth(null);
  assert.equal(element('health-card').getAttribute('data-state'), 'unknown');
  assert.equal(title(), 'Health unknown');
  assert.match(detail(), /hasn’t reported its health yet/);
  assert.equal(element('health-meta').textContent, '');
  assert.equal(element('health-list').hidden, true);
  assert.equal(rows().length, 0);
  assert.equal(element('health-caveat').hidden, true);
  assert.equal(element('health-retry').hidden, true);
  assert.doesNotMatch(cardText(), /no faults|all clear|is safe|\bhealthy\b/i);
});

test('a listener error states the failure and offers the one re-subscribe path', () => {
  showHealth(liveDoc());
  showHealthError();

  assert.equal(element('health-card').getAttribute('data-state'), 'unknown');
  assert.equal(title(), 'Health unknown');
  assert.equal(detail(), 'Couldn’t load charger health.');
  assert.doesNotMatch(detail(), /reload/i);
  assert.equal(element('health-list').hidden, true);
  assert.deepEqual(rows(), [], 'the last projection does not survive the failure');
  assert.equal(element('health-retry').hidden, false);
  // The control's label lives in the markup, not in JS (pinned below).
});

test('a snapshot after the failure puts the card back', () => {
  showHealthError();
  assert.equal(element('health-retry').hidden, false);

  showHealth(liveDoc());
  assert.equal(element('health-retry').hidden, true);
  assert.equal(title(), '1 acknowledged advisory');
  assert.equal(rows().length, 1);
});

test('activating Retry clears the detail so a repeat failure writes it again', () => {
  // Same reason as the status screen's failure line: an unchanged line is no
  // mutation, so nothing would be announced on a second identical failure.
  const listeners = element('health-retry').listeners.get('click') || [];
  assert.equal(listeners.length, 1, 'initStatus wired #health-retry once');

  showHealthError();
  assert.equal(detail(), 'Couldn’t load charger health.');
  focusLog.length = 0;
  listeners[0]();
  assert.equal(detail(), '', 'the click leaves the line empty for the next answer');
  assert.deepEqual(focusLog, [], 'a pending retry leaves focus where the click put it');

  showHealthError();
  assert.equal(detail(), 'Couldn’t load charger health.');
});

test('the render that clears the failure moves focus to the card', () => {
  // The retry control leaves the tree with the failure, so the card the retry
  // refilled takes the focus rather than <body>.
  const listeners = element('health-retry').listeners.get('click') || [];
  showHealthError();
  focusLog.length = 0;
  listeners[0]();
  showHealth(liveDoc());
  assert.equal(element('health-retry').hidden, true);
  assert.equal(focusLog.at(-1), 'health-title');
  assert.deepEqual(element('health-title').focused, { preventScroll: true });
});

test('a snapshot no retry preceded moves no focus', () => {
  showHealth(liveDoc());
  focusLog.length = 0;
  showHealth(liveDoc());
  showHealth(liveDoc({ advisories: [] }));
  assert.deepEqual(focusLog, []);
});

test('the list is not rebuilt when only the check stamp moved', () => {
  // A rebuilt row would drop a text selection the owner is copying; the screen
  // rebuilds only when a row's own facts change.
  showHealth(liveDoc());
  const [first] = rows();
  showHealth(liveDoc({ checked_at: now() / 1000 - 5 }));
  assert.equal(rows()[0], first, 'the same row node survives an unchanged list');
  showHealth(liveDoc({ advisories: [] }));
  showHealth(
    liveDoc({
      acks: {},
      advisories: [{ ...liveDoc().advisories[0], classification: 'historical', acked: false }],
    }),
  );
  assert.equal(rows().length, 1);
  assert.equal(
    rows()[0].getAttribute('data-presentation'),
    'recorded',
    'a re-classified row is a new fact, so the list rebuilds with it',
  );
});

test('sign-out teardown returns the card to its pre-data state', () => {
  showHealth(liveDoc());
  assert.equal(rows().length, 1);
  leaveStatus();
  assert.equal(element('health-card').getAttribute('data-state'), 'unknown');
  assert.equal(title(), 'Health unknown');
  assert.match(detail(), /hasn’t reported its health yet/);
  assert.deepEqual(rows(), []);
  assert.equal(element('health-list').hidden, true);
  assert.equal(element('health-retry').hidden, true);
});

test('index.html ships the card inside the status panel, after the controls', () => {
  // The stub answers any id on demand, so the markup facts are pinned from
  // source (the status-error/config-lifetime convention): the card's exposure
  // and its place in the panel's order.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(source, /<div class="health-copy" role="status" aria-live="polite">/);
  assert.match(
    source,
    /<p class="health-title" id="health-title" tabindex="-1">Health unknown<\/p>/,
  );
  assert.match(source, /<ul class="health-list" id="health-list" hidden><\/ul>/);
  assert.match(
    source,
    /<button id="health-retry" class="btn small" type="button" hidden>Try again<\/button>/,
  );
  // The card opens in the unknown state, never in a "no advisories" one: the
  // static markup must not claim health before a report has arrived.
  assert.doesNotMatch(source, /id="health-title"[^>]*>No advisories/);

  const at = {
    panel: source.indexOf('id="panel-status"'),
    controls: source.indexOf('id="controls"'),
    card: source.indexOf('id="health-card"'),
    history: source.indexOf('id="panel-history"'),
  };
  for (const [marker, position] of Object.entries(at)) {
    assert.notEqual(position, -1, `${marker} is missing from web/index.html`);
  }
  assert.ok(
    at.panel < at.controls && at.controls < at.card && at.card < at.history,
    'the health card sits below the controls, inside the status panel',
  );
});
