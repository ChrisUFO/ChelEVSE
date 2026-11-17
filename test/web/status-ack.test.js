import { test } from 'node:test';
import assert from 'node:assert/strict';

// The health card's acknowledgement wiring (#158, PR-6), pinned the repo's way:
// the module-mock-free DOM stub (one element per id, every lookup deferred to
// render time, then a plain `await import` of the real screen). What this can
// see is the control the rows carry, what a click does to it, and where focus
// lands when the control disappears.
//
// The settle semantics themselves are the tracker's, driven without a DOM in
// test/web/health.test.js — the successful click is the snapshot's, not this
// screen's, and the bridge's own failure reason is composed there too. What this
// file adds is that the control the rows carry is the one those states paint. The one path this harness cannot reach is a live Firestore write:
// `firebase.js` keeps `addDoc` unbound until `initFirebase()` runs, so the click
// here reaches the real `ackNotification`, is refused by the unbound SDK, and
// exercises the screen's "couldn't send" arm — a production code path.

const focusLog = [];
let activeElement = null;

function stubElement(tag = '') {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  let disabled = false;
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
    className: '',
    id: '',
    title: '',
    // The browser's focus fix-up rule, which the real DOM implements: a focused
    // control that becomes unfocusable loses focus to the nearest focusable
    // ancestor — <body> here. Without it this harness would let a disabled button
    // keep focus and hide the click→disable→rebuild timeline the screen exists to
    // handle.
    get disabled() {
      return disabled;
    },
    set disabled(value) {
      disabled = Boolean(value);
      if (disabled && activeElement === this) activeElement = body;
    },
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
      activeElement = this;
      this.focused = options;
      focusLog.push(this.id);
    },
  };
}

const elements = new Map();
const live = new Set();

function element(id) {
  let node = elements.get(id);
  if (!node) {
    node = stubElement();
    node.id = id;
    elements.set(id, node);
    live.add(node);
  }
  return node;
}

const body = stubElement('body');
activeElement = body;

globalThis.document = {
  body,
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  get activeElement() {
    return activeElement;
  },
  contains: (node) => live.has(node),
};

const { initStatus, leaveStatus, showHealth, showCommands } =
  await import('../../web/js/screens/status.js');

// The listeners the click cases need are the ones initStatus itself registers.
initStatus();

const at = (year, month, day) => Math.floor(new Date(year, month - 1, day, 12).getTime() / 1000);

// A live, complete report with one recorded advisory (the shape on this charger
// once both gates are reported).
function doc(overrides = {}) {
  return {
    reachable: true,
    source: 'http',
    checked_at: Date.now() / 1000 - 60,
    gates: { settings_known: true, relay_health_known: true },
    counters: { nogndcount: 7, gfcicount: 0, stuckcount: 0 },
    advisories: [
      {
        id: 'fault.no_ground',
        category: 'fault',
        severity: 'critical',
        firmware_sticky: false,
        acked: false,
        first_seen: at(2026, 11, 8),
        last_seen: Date.now() / 1000,
        classification: 'historical',
        corroborated: false,
        counter_token: 7,
        first_observed: at(2026, 11, 13),
      },
    ],
    alerted: {},
    acks: {},
    ...overrides,
  };
}

const rows = () => element('health-list').children;
const rowOf = () => rows()[0];
// The acknowledgement area is the row's third child: head, meta, control.
const controlOf = (row) => row.children[2] || null;
const buttonOf = (row) => {
  const area = controlOf(row);
  return area ? area.children[0] : null;
};
const messageOf = (row) => {
  const area = controlOf(row);
  return area ? area.children[1] : null;
};
const chipOf = (row, className) =>
  row.children[0].children.find((node) => String(node.className).split(/\s+/).includes(className));

// A macrotask turn: the click's write settles off the microtask queue.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const click = (button) => {
  for (const listener of button.listeners.get('click') || []) listener();
};

test('an unacknowledged row offers one real button that names its advisory', () => {
  showHealth(doc());
  const row = rowOf();
  const button = buttonOf(row);

  assert.equal(button.tag, 'button');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, 'Acknowledge');
  assert.equal(button.getAttribute('aria-label'), 'Acknowledge No ground');
  assert.equal(button.disabled, false);
  // The failure line is its own polite region and starts empty.
  const message = messageOf(row);
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.hidden, true);
  assert.equal(message.textContent, '');
  // The row still carries the three facts unaltered.
  assert.equal(chipOf(row, 'health-state').textContent, 'Recorded');
  assert.equal(chipOf(row, 'health-severity').textContent, 'Critical');
});

test('a click goes busy and disables the control, so a second one cannot repeat it', () => {
  showHealth(doc());
  const row = rowOf();
  const button = buttonOf(row);

  click(button);
  // Synchronously, before the write has an answer: busy, disabled, announced.
  assert.equal(button.textContent, 'Acknowledging…');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-label'), 'Acknowledging No ground');
  // The row is not acknowledged while the command is only in flight.
  assert.equal(chipOf(row, 'health-state').textContent, 'Recorded');

  // A second dispatch (a double click, a held Enter) changes nothing.
  click(button);
  assert.equal(button.textContent, 'Acknowledging…');
  assert.equal(button.disabled, true);
});

test('a write that cannot leave says so and leaves the row unacknowledged', async () => {
  showHealth(doc());
  const row = rowOf();
  const button = buttonOf(row);
  click(button);
  await flush();

  // The node is the same one — busy and failure repaint in place.
  assert.equal(rowOf(), row);
  const message = messageOf(row);
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, 'Couldn’t send — check your connection and try again.');
  // Back to idle, ready for another try — and still recorded, never dismissed.
  assert.equal(button.textContent, 'Acknowledge');
  assert.equal(button.disabled, false);
  assert.equal(chipOf(row, 'health-state').textContent, 'Recorded');
  assert.equal(element('health-title').textContent, '1 recorded advisory');
});

test('acknowledging from the control hands focus to the card, not to <body>', () => {
  showHealth(doc());
  const row = rowOf();
  const button = buttonOf(row);
  // The owner activates the control: focus is on it when the click runs, and the
  // synchronous disable takes it away inside that same dispatch (the stub models
  // the browser's focus fix-up rule). The success snapshot lands seconds later,
  // so `document.activeElement` is already <body> by then.
  button.focus({ preventScroll: true });
  assert.equal(document.activeElement, button);
  click(button);
  assert.equal(document.activeElement, body, 'the disable displaced the focus');

  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));

  const acked = rowOf();
  assert.equal(acked.getAttribute('data-presentation'), 'acknowledged');
  assert.equal(chipOf(acked, 'health-state').textContent, 'Acknowledged');
  assert.equal(acked.children.length, 2, 'no control remains on an acknowledged row');
  assert.equal(buttonOf(acked), null);
  // Focus did not stay on <body>: it moved to the card title the live region
  // announces, even though the browser had already dropped it at click time.
  assert.equal(focusLog.at(-1), 'health-title');
  assert.deepEqual(element('health-title').focused, { preventScroll: true });
});

test('a control the owner tabbed to hands focus over when a remote ack removes it', () => {
  showHealth(doc());
  const button = buttonOf(rowOf());
  // Never pressed: the acknowledgement came from elsewhere, so nothing disabled
  // the control and it still holds focus when the snapshot rebuilds the list.
  button.focus({ preventScroll: true });
  assert.equal(document.activeElement, button);

  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));

  assert.equal(buttonOf(rowOf()), null);
  assert.equal(focusLog.at(-1), 'health-title');
});

test('a rebuild leaves focus alone when the owner has moved to another control', () => {
  showHealth(doc());
  const button = buttonOf(rowOf());
  button.focus({ preventScroll: true });
  click(button);
  // The disable dropped focus to <body>; the owner went back to the charger
  // controls while the acknowledgement was still in flight.
  const elsewhere = element('pause');
  elsewhere.focus({ preventScroll: true });
  focusLog.length = 0;

  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));

  assert.equal(document.activeElement, elsewhere, 'focus stays where the owner put it');
  assert.deepEqual(focusLog, [], 'no hand-off steals a live focus');
});

test('a failed attempt puts focus back on the control that came back', async () => {
  showHealth(doc());
  const row = rowOf();
  const button = buttonOf(row);
  button.focus({ preventScroll: true });
  click(button);
  // The disable displaced focus synchronously, exactly as on the success path.
  assert.equal(document.activeElement, body);

  // Here the write itself is refused (the SDK is unbound), so the attempt ends
  // on the row: the control repaints enabled, under the reason.
  await flush();

  assert.equal(button.disabled, false);
  assert.equal(messageOf(row).hidden, false);
  // Focus went back to the retry target instead of being left on <body>.
  assert.equal(document.activeElement, button);
  assert.deepEqual(button.focused, { preventScroll: true });
});

test('a failed attempt leaves no flag for a later rebuild to spend', async () => {
  showHealth(doc());
  const button = buttonOf(rowOf());
  button.focus({ preventScroll: true });
  click(button);
  await flush();
  assert.equal(button.disabled, false);

  // The owner gave up on the retry and clicked the card's text: focus fell to
  // <body>, so nothing in the list is holding it any more.
  body.focus({ preventScroll: true });
  focusLog.length = 0;

  // An unrelated health update rebuilds the list. Nothing the owner was on is
  // going away, so focus stays where it is; the finished attempt's flag must not
  // pull it to the card title.
  showHealth(
    doc({
      advisories: [
        ...doc().advisories,
        {
          id: 'safety.ground_check',
          category: 'safety',
          severity: 'warning',
          firmware_sticky: false,
          acked: false,
          first_seen: at(2026, 11, 1),
          last_seen: Date.now() / 1000,
          classification: 'historical',
          corroborated: false,
          counter_token: 0,
          first_observed: at(2026, 11, 1),
        },
      ],
    }),
  );

  assert.equal(rows().length, 2, 'the unrelated advisory did rebuild the list');
  assert.equal(document.activeElement, body);
  assert.deepEqual(focusLog, [], 'a finished attempt owns no focus hand-off');
});

test('an already acknowledged advisory and unknown health offer no control at all', () => {
  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));
  assert.equal(rowOf().children.length, 2);
  assert.equal(buttonOf(rowOf()), null);

  showHealth(doc({ advisories: [{ ...doc().advisories[0], acked: true }], acks: {} }));
  assert.equal(rowOf().children.length, 2);
  assert.equal(buttonOf(rowOf()), null);

  // Health unknown lists nothing, so there is nothing to acknowledge.
  showHealth(null);
  assert.deepEqual(rows(), []);
  assert.equal(element('health-card').getAttribute('data-state'), 'unknown');
});

test('sign-out teardown leaves no control or focus behind', () => {
  showHealth(doc());
  assert.notEqual(buttonOf(rowOf()), null);
  leaveStatus();
  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'Health unknown');
});
