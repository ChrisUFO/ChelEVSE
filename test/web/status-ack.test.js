import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { DISMISSALS_KEY, createDismissalStore } from '../../web/js/health-dismissals.js';

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
//
// The dismissal block at the end (#205) runs on the same harness. It is the one
// place that needs a signed-in account: a record is scoped to one, and
// `firebase.js`'s `auth` binding cannot be handed a user from outside the
// module. `initStatus` takes the account reader for exactly that, and the
// localStorage shim is installed before the screen loads so its store writes
// where these tests can read it back.

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

// A localStorage shim over a Map, installed before the screen loads: its
// module-level dismissal store binds to whatever `localStorage` is at that
// moment, as it does in the browser. `sets` counts writes, and `refuse` makes
// each one throw the way a full or private-mode storage does.
const storage = new Map();
const localStorageShim = {
  sets: 0,
  refuse: false,
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem(key, value) {
    if (this.refuse) throw new Error('QuotaExceededError');
    this.sets += 1;
    storage.set(key, String(value));
  },
  removeItem: (key) => storage.delete(key),
};
globalThis.localStorage = localStorageShim;

// The signed-in account the card reads — '' until a dismissal case signs one in.
const account = { uid: '' };

const { initStatus, leaveStatus, showHealth, showHealthError, showCommands } =
  await import('../../web/js/screens/status.js');

// The listeners the click cases need are the ones initStatus itself registers.
initStatus({ uid: () => account.uid });

const at = (year, month, day) => Math.floor(new Date(year, month - 1, day, 12).getTime() / 1000);

// A live, complete report with one recorded advisory (the shape on this charger
// once both gates are reported). `ack_command: true` is the current bridge's
// capability fact (#186); the deploy-skew shape (no fact) has its own test.
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
    ack_command: true,
    ...overrides,
  };
}

// A second advisory, so a case can dismiss one row and watch another.
const GROUND = {
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
};

const rows = () => element('health-list').children;
const rowOf = () => rows()[0];
// Every row's third child is its action line: head, meta, actions (#205 — the
// Dismiss control made it unconditional). It holds the Dismiss button, and on a
// row the bridge can acknowledge the Acknowledge button and its failure line.
const actionsOf = (row) => row.children[2] || null;
const actionChildren = (row) => (actionsOf(row) || { children: [] }).children;
const buttonsOf = (row) => actionChildren(row).filter((node) => node.tag === 'button');
// The two controls, told apart by the Dismiss button's variant class.
const dismissOf = (row) =>
  buttonsOf(row).find((node) => String(node.className).split(/\s+/).includes('ghost')) || null;
const ackOf = (row) =>
  buttonsOf(row).find((node) => !String(node.className).split(/\s+/).includes('ghost')) || null;
const messageOf = (row) => actionChildren(row).find((node) => node.tag === 'p') || null;
const labels = () => rows().flatMap((row) => buttonsOf(row).map((button) => button.textContent));
const chipOf = (row, className) =>
  row.children[0].children.find((node) => String(node.className).split(/\s+/).includes(className));

// A macrotask turn: the click's write settles off the microtask queue.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// An activation of a control. A keyboard one by default — the `click` a
// focused button fires, which carries no click count; a pointer click passes
// its own event, that count being what tells the two apart.
const click = (button, event = { detail: 0 }) => {
  for (const listener of button.listeners.get('click') || []) listener(event);
};

test('an unacknowledged row offers one real button that names its advisory', () => {
  showHealth(doc());
  const row = rowOf();
  const button = ackOf(row);

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
  const button = ackOf(row);

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
  const button = ackOf(row);
  click(button);
  await flush();

  // The node is the same one — busy and failure repaint in place.
  assert.equal(rowOf(), row);
  const message = messageOf(row);
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, 'Couldn’t send — check your connection and try again.');
  // Back to idle, ready for another try — and still recorded, never acknowledged.
  assert.equal(button.textContent, 'Acknowledge');
  assert.equal(button.disabled, false);
  assert.equal(chipOf(row, 'health-state').textContent, 'Recorded');
  assert.equal(element('health-title').textContent, '1 recorded advisory');
});

test('acknowledging from the control hands focus to the card, not to <body>', () => {
  showHealth(doc());
  const row = rowOf();
  const button = ackOf(row);
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
  assert.equal(ackOf(acked), null, 'no Acknowledge control remains on an acknowledged row');
  // The row itself can still be dismissed (#205): that control is not the one
  // the acknowledgement retires.
  assert.equal(dismissOf(acked).textContent, 'Dismiss');
  // Focus did not stay on <body>: it moved to the card title the live region
  // announces, even though the browser had already dropped it at click time.
  assert.equal(focusLog.at(-1), 'health-title');
  assert.deepEqual(element('health-title').focused, { preventScroll: true });
});

test('a control the owner tabbed to hands focus over when a remote ack removes it', () => {
  showHealth(doc());
  const button = ackOf(rowOf());
  // Never pressed: the acknowledgement came from elsewhere, so nothing disabled
  // the control and it still holds focus when the snapshot rebuilds the list.
  button.focus({ preventScroll: true });
  assert.equal(document.activeElement, button);

  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));

  assert.equal(ackOf(rowOf()), null);
  assert.equal(focusLog.at(-1), 'health-title');
});

test('a rebuild leaves focus alone when the owner has moved to another control', () => {
  showHealth(doc());
  const button = ackOf(rowOf());
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
  const button = ackOf(row);
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

test('a failed attempt leaves focus alone when the owner has moved to another control', async () => {
  showHealth(doc());
  const row = rowOf();
  const button = ackOf(row);
  button.focus({ preventScroll: true });
  click(button);
  // The disable dropped focus to <body>; while the write is still out the owner
  // went back to the charger controls, exactly as on the rebuild path above.
  const elsewhere = element('pause');
  elsewhere.focus({ preventScroll: true });
  focusLog.length = 0;

  // The write is then refused, so the attempt ends on the row: the control
  // repaints enabled and the reason appears, but the settle must not pull focus
  // off the live control the owner is on.
  await flush();

  assert.equal(button.disabled, false);
  assert.equal(messageOf(row).hidden, false);
  assert.equal(document.activeElement, elsewhere, 'focus stays where the owner put it');
  assert.deepEqual(focusLog, [], 'the settle steals no live focus');
});

test('a failed attempt leaves no flag for a later rebuild to spend', async () => {
  showHealth(doc());
  const button = ackOf(rowOf());
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
  showHealth(doc({ advisories: [...doc().advisories, GROUND] }));

  assert.equal(rows().length, 2, 'the unrelated advisory did rebuild the list');
  assert.equal(document.activeElement, body);
  assert.deepEqual(focusLog, [], 'a finished attempt owns no focus hand-off');
});

test('an already acknowledged advisory and unknown health offer no Acknowledge control', () => {
  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));
  assert.equal(ackOf(rowOf()), null);
  assert.equal(messageOf(rowOf()), null, 'nothing left to mute, so no failure line either');

  showHealth(doc({ advisories: [{ ...doc().advisories[0], acked: true }], acks: {} }));
  assert.equal(ackOf(rowOf()), null);

  // Health unknown lists nothing, so there is no row and no control of any kind.
  showHealth(null);
  assert.deepEqual(rows(), []);
  assert.equal(element('health-card').getAttribute('data-state'), 'unknown');
});

test('an older bridge’s document offers no ack control', () => {
  // Deploy skew (#159): a web deploy ahead of its bridge reads a document
  // with no `ack_command` — the control this screen paints would write a
  // command that bridge cannot perform, so the row renders without it.
  // The advisory itself still lists: the report is as good as ever.
  const legacy = doc();
  delete legacy.ack_command;
  showHealth(legacy);
  assert.equal(rows().length, 1);
  // Dismiss alone on the action line — no Acknowledge button, no failure line.
  assert.deepEqual(actionChildren(rowOf()), [dismissOf(rowOf())]);
  assert.equal(ackOf(rowOf()), null);

  // The bridge is then upgraded and the fact arrives on an otherwise
  // identical list: the row must rebuild so the control appears — the
  // rebuild signature carries the capability, not just the advisory facts.
  showHealth(doc());
  assert.notEqual(ackOf(rowOf()), null);

  // And the reverse skew — the fact hand-deleted in the console (A.8) or
  // the bridge rolled back: the same rebuild must remove the control
  // again; the gate is symmetric.
  showHealth(legacy);
  assert.equal(rows().length, 1);
  assert.deepEqual(actionChildren(rowOf()), [dismissOf(rowOf())]);
  assert.equal(ackOf(rowOf()), null);
});

test('sign-out teardown leaves no control or focus behind', () => {
  showHealth(doc());
  assert.notEqual(ackOf(rowOf()), null);
  leaveStatus();
  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'Health unknown');
});

// ---------- dismissal (#205) ----------
//
// The row's other control, on the same harness. Each case signs an account in
// and starts from an empty store: a record is scoped to an account, and the
// screen's store is module state. Clearing the store does reset an account an
// earlier case dismissed under — the store reads storage again once storage
// has taken a write — but never an account whose write was refused: that copy
// is the page's for life, which is the session-only hide. Each sign-in
// therefore starts a fresh account. What a record hides and when it is
// retired is health.js's (test/web/health.test.js); here it is that the
// control, the click, the focus hand-off and the persistence are wired the way
// those rules assume.

// Named accounts for the one case that changes account inside itself.
const OWNER = 'uid-owner';
const OTHER = 'uid-other';

// What the next page load would read, exactly as the store wrote it.
const stored = () => JSON.parse(storage.get(DISMISSALS_KEY) ?? 'null');
const twoRows = () => doc({ advisories: [...doc().advisories, GROUND] });

let accounts = 0;

// Sign in as `uid` (a fresh account by default) with an empty store and the
// card in its pre-data state; sign back out when the case ends. Returns the
// account.
function signIn(t, uid = `uid-case-${++accounts}`) {
  account.uid = uid;
  storage.clear();
  localStorageShim.refuse = false;
  localStorageShim.sets = 0;
  focusLog.length = 0;
  leaveStatus();
  showHealth(doc());
  t.after(() => {
    account.uid = '';
  });
  return uid;
}

// Change account without touching the store, the way a sign-out followed by a
// sign-in in the same page does.
function switchTo(uid) {
  account.uid = uid;
  leaveStatus();
  showHealth(doc());
}

test('every row offers Dismiss: with the capability fact, without it, and once acknowledged', (t) => {
  signIn(t);
  const row = rowOf();
  const dismiss = dismissOf(row);
  const ack = ackOf(row);

  // One action line: Dismiss first, then the ack control and its failure line.
  assert.equal(actionsOf(row).className, 'health-actions');
  assert.deepEqual(actionChildren(row), [dismiss, ack, messageOf(row)]);
  assert.equal(dismiss.tag, 'button');
  assert.equal(dismiss.type, 'button');
  assert.equal(dismiss.textContent, 'Dismiss');
  assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss No ground');
  assert.equal(dismiss.disabled, false);
  // The three facts sit beside it, unaltered.
  assert.equal(chipOf(row, 'health-state').textContent, 'Recorded');
  assert.equal(chipOf(row, 'health-severity').textContent, 'Critical');

  // An older bridge's document: the capability gates Acknowledge only.
  const legacy = doc();
  delete legacy.ack_command;
  showHealth(legacy);
  assert.deepEqual(actionChildren(rowOf()), [dismissOf(rowOf())]);
  assert.equal(dismissOf(rowOf()).getAttribute('aria-label'), 'Dismiss No ground');

  // Acknowledged: nothing left to mute, and still dismissible.
  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));
  assert.equal(rowOf().getAttribute('data-presentation'), 'acknowledged');
  assert.deepEqual(actionChildren(rowOf()), [dismissOf(rowOf())]);

  // Active — a live, corroborated condition — is dismissible like the rest,
  // and its Dismiss empties the card exactly as a record's does.
  showHealth(
    doc({ advisories: [{ ...doc().advisories[0], classification: 'active', corroborated: true }] }),
  );
  assert.equal(rowOf().getAttribute('data-presentation'), 'active');
  assert.equal(element('health-card').getAttribute('data-tone'), 'err');
  assert.deepEqual(actionChildren(rowOf()), [
    dismissOf(rowOf()),
    ackOf(rowOf()),
    messageOf(rowOf()),
  ]);
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  assert.equal(element('health-card').getAttribute('data-tone'), 'muted');
  assert.equal(element('health-title').textContent, 'No advisories');
});

test('activating Dismiss removes the row at once, and the last one empties the card', (t) => {
  signIn(t);
  click(dismissOf(rowOf()));

  assert.deepEqual(rows(), []);
  assert.equal(element('health-list').hidden, true);
  // The card's existing presentation for an empty list — nothing new.
  assert.equal(element('health-title').textContent, 'No advisories');
  assert.equal(
    element('health-detail').textContent,
    'The charger’s last health check listed none.',
  );
  assert.equal(element('health-card').getAttribute('data-state'), 'none');
  assert.equal(element('health-card').getAttribute('data-tone'), 'muted');

  // Two rows, as a fresh account: the other stays, and the summary counts what
  // is left.
  signIn(t, 'uid-second-case');
  showHealth(twoRows());
  assert.equal(rows().length, 2);
  const [first, second] = rows();
  click(dismissOf(second));

  // The dismissal changed the signature beneath the same advisory list, so the
  // list rebuilt: the survivor is a new node, not the one that was there.
  assert.equal(rows().length, 1);
  assert.notEqual(rowOf(), first);
  assert.equal(chipOf(rowOf(), 'health-name').textContent, 'No ground');
  assert.equal(element('health-title').textContent, '1 recorded advisory');

  // And the last one empties the card the same way.
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  assert.equal(element('health-list').hidden, true);
  assert.equal(element('health-title').textContent, 'No advisories');
});

test('dismissing from the control hands focus to the card, never to <body>', (t) => {
  signIn(t);
  const dismiss = dismissOf(rowOf());
  // Keyboard activation: focus is on the control when the click runs, and the
  // rebuild that follows destroys it with its row.
  dismiss.focus({ preventScroll: true });
  assert.equal(document.activeElement, dismiss);

  click(dismiss);

  // The same target the Acknowledge flow hands focus to, the live region that
  // has just announced the shorter list.
  assert.equal(focusLog.at(-1), 'health-title');
  assert.equal(document.activeElement, element('health-title'));
  assert.deepEqual(element('health-title').focused, { preventScroll: true });
  assert.notEqual(document.activeElement, body);
});

test('a Dismiss activated with nothing focused does not leave focus on <body>', (t) => {
  // A mouse click in a browser that does not focus buttons: the control never
  // held focus, so only the click's own record of what it activated can owe
  // the hand-off.
  signIn(t);
  // Nothing focused, established rather than assumed: an earlier case may have
  // left focus on the card title.
  body.focus({ preventScroll: true });
  focusLog.length = 0;
  assert.equal(document.activeElement, body);

  click(dismissOf(rowOf()));

  assert.equal(document.activeElement, element('health-title'));
  assert.deepEqual(focusLog, ['health-title']);
});

test('a Dismiss control the owner tabbed to hands focus over when a remote change rebuilds', (t) => {
  signIn(t);
  const dismiss = dismissOf(rowOf());
  // Never pressed: the acknowledgement came from elsewhere, so nothing disabled
  // the control and it still holds focus when the snapshot rebuilds the list.
  dismiss.focus({ preventScroll: true });
  assert.equal(document.activeElement, dismiss);

  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));

  assert.equal(focusLog.at(-1), 'health-title');
});

test('a rebuild leaves focus alone when the owner moved off a Dismiss control', (t) => {
  signIn(t);
  dismissOf(rowOf()).focus({ preventScroll: true });
  const elsewhere = element('pause');
  elsewhere.focus({ preventScroll: true });
  focusLog.length = 0;

  showHealth(doc({ acks: { 'fault.no_ground': at(2026, 11, 16) } }));

  assert.equal(document.activeElement, elsewhere, 'focus stays where the owner put it');
  assert.deepEqual(focusLog, [], 'no hand-off steals a live focus');
});

test('a spent Dismiss leaves no flag for a later rebuild to spend', (t) => {
  signIn(t);
  // Nothing is focused when the owner activates Dismiss — a mouse click in a
  // browser that does not focus buttons — so the hand-off the click owes is
  // paid by the rebuild the click itself triggers.
  body.focus({ preventScroll: true });
  click(dismissOf(rowOf()));
  assert.equal(document.activeElement, element('health-title'));

  // The owner then clicked the card's text: focus fell to <body>, so nothing
  // in the list is holding it any more.
  body.focus({ preventScroll: true });
  focusLog.length = 0;

  // An unrelated health update rebuilds the list. Nothing the owner was on is
  // going away, so focus stays where it is; the spent dismissal's flag must
  // not pull it to the card title a second time.
  showHealth(doc({ advisories: [...doc().advisories, GROUND] }));

  assert.equal(rows().length, 1, 'only the new advisory is listed');
  assert.equal(chipOf(rowOf(), 'health-name').textContent, 'Ground check');
  assert.equal(document.activeElement, body);
  assert.deepEqual(focusLog, [], 'a spent dismissal owns no focus hand-off');
});

test('the record is persisted under the signed-in account, and a steady report writes nothing', (t) => {
  const uid = signIn(t);
  const before = Date.now();
  click(dismissOf(rowOf()));

  const record = stored()?.[uid]?.['fault.no_ground'];
  assert.deepEqual(Object.keys(stored()), [uid]);
  assert.equal(record.severity, 'critical');
  assert.ok(
    Number.isFinite(record.dismissedAt) && record.dismissedAt >= before,
    'the record is stamped at the click',
  );
  // What a later page load reads: a fresh store over the same storage.
  assert.deepEqual(createDismissalStore({ storage: localStorageShim }).read(uid), {
    'fault.no_ground': record,
  });

  // Steady state: the same report again, and one with only its stamp moved,
  // cost no storage write — and the row stays hidden.
  const sets = localStorageShim.sets;
  showHealth(doc());
  showHealth(doc({ checked_at: Date.now() / 1000 - 5 }));
  assert.deepEqual(rows(), []);
  assert.equal(localStorageShim.sets, sets);
});

test('a record an earlier page load wrote is applied on this one', (t) => {
  // The reload case: a record only storage knows about, which no store in
  // this page has committed.
  const EARLIER = 'uid-earlier-page';
  signIn(t, EARLIER);
  assert.equal(rows().length, 1, 'nothing stored: the row lists');

  storage.set(
    DISMISSALS_KEY,
    JSON.stringify({
      [EARLIER]: {
        'fault.no_ground': {
          severity: 'critical',
          dismissedAt: 1794876000000,
          reportedPresent: false,
        },
      },
    }),
  );
  showHealth(doc());

  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'No advisories');
});

test('dismissals are scoped per account', (t) => {
  signIn(t, OWNER);
  click(dismissOf(rowOf()));
  assert.deepEqual(Object.keys(stored()), [OWNER]);

  // Another allowlisted account in the same browser sees the row…
  switchTo(OTHER);
  assert.equal(rows().length, 1);
  // …and gets its own independent Dismiss state.
  click(dismissOf(rowOf()));
  assert.deepEqual(Object.keys(stored()).sort(), [OTHER, OWNER]);

  // Signed out, no record is applied and none can be written: there is no
  // account to scope a dismissal to.
  switchTo('');
  assert.equal(rows().length, 1);
  click(dismissOf(rowOf()));
  assert.equal(rows().length, 1);
  assert.deepEqual(Object.keys(stored()).sort(), [OTHER, OWNER]);

  // Back as the first account: still hidden, with nothing done again.
  switchTo(OWNER);
  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'No advisories');
});

test('dismissing a row starts no acknowledgement and leaves the other rows alone', async (t) => {
  signIn(t);
  showHealth(twoRows());
  const [gone] = rows();
  assert.equal(chipOf(gone, 'health-name').textContent, 'No ground');
  assert.equal(ackOf(rows()[1]).textContent, 'Acknowledge');

  click(dismissOf(gone));
  // A macrotask turn: an attempt that had started would by now be busy, or
  // have been refused by the unbound SDK and painted its reason.
  await flush();

  // The other row rebuilt — a rebuild recreates every row — and is still
  // Ground check, with its Acknowledge control in the idle state it was in: no
  // attempt was started on its behalf, and none was painted on it.
  assert.equal(rows().length, 1);
  assert.equal(chipOf(rowOf(), 'health-name').textContent, 'Ground check');
  const ack = ackOf(rowOf());
  assert.equal(ack.textContent, 'Acknowledge');
  assert.equal(ack.getAttribute('aria-label'), 'Acknowledge Ground check');
  assert.equal(ack.disabled, false);
  assert.equal(messageOf(rowOf()).hidden, true);
  assert.equal(messageOf(rowOf()).textContent, '');
  assert.equal(labels().includes('Acknowledging…'), false);
  // The shared command feedback line stays silent too: no command was sent.
  assert.equal(element('feedback').className, 'feedback');
  assert.equal(element('feedback').textContent, '');
  // The survivor's own Dismiss control is wired once and still live.
  assert.equal(dismissOf(rowOf()).listeners.get('click').length, 1);
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
});

test('dismissing a row mid-acknowledgement ends the wait and strands no focus', async (t) => {
  signIn(t);
  const ack = ackOf(rowOf());
  ack.focus({ preventScroll: true });
  click(ack);
  assert.equal(ack.textContent, 'Acknowledging…');
  assert.equal(document.activeElement, body, 'the disable displaced the focus');

  click(dismissOf(rowOf()));

  // The row is gone and focus went to the card, not back to <body>.
  assert.deepEqual(rows(), []);
  assert.equal(focusLog.at(-1), 'health-title');
  assert.equal(document.activeElement, element('health-title'));

  // The write's refusal lands a microtask later on a row that no longer
  // exists: nothing is painted, exactly as when a row leaves the snapshot.
  await flush();
  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'No advisories');
  assert.equal(element('feedback').textContent, '');

  // It was the dismissal that ended the wait, though — not that refusal
  // landing. A second attempt, dismissed the same way, and the advisory then
  // listed again at another severity while its write is still out: only the
  // dismissal can have ended the attempt, and the new row's control is idle.
  showHealth(doc({ advisories: [{ ...doc().advisories[0], severity: 'warning' }] }));
  assert.equal(rows().length, 1, 're-rated, so listed again');
  const second = ackOf(rowOf());
  click(second);
  assert.equal(second.textContent, 'Acknowledging…');

  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  showHealth(doc());
  assert.equal(rows().length, 1, 'back at the dismissed rating, so listed again');
  const control = ackOf(rowOf());
  assert.notEqual(control, second, 'the row was rebuilt');
  assert.equal(control.textContent, 'Acknowledge');
  assert.equal(control.disabled, false);
  assert.equal(messageOf(rowOf()).hidden, true);

  // The second write's refusal then lands on nothing.
  await flush();
  assert.equal(control.textContent, 'Acknowledge');
  assert.equal(messageOf(rowOf()).hidden, true);
});

test('dismissing another row leaves a surviving row’s acknowledgement in flight', async (t) => {
  signIn(t);
  showHealth(twoRows());
  const [, otherRow] = rows();
  const ack = ackOf(rowOf());
  click(ack);
  assert.equal(ack.textContent, 'Acknowledging…');

  click(dismissOf(otherRow));

  // The rebuild recreated the surviving row, and its new control still reads
  // as the attempt in flight — busy and disabled, no reason — because the
  // snapshot it was rebuilt from still lists that advisory as acknowledgeable.
  assert.equal(rows().length, 1);
  assert.equal(chipOf(rowOf(), 'health-name').textContent, 'No ground');
  const control = ackOf(rowOf());
  assert.notEqual(control, ack, 'the survivor was rebuilt, not repainted');
  assert.equal(control.textContent, 'Acknowledging…');
  assert.equal(control.disabled, true);
  assert.equal(messageOf(rowOf()).hidden, true);

  // The write's refusal then lands on that row: the reason is shown and the
  // control is enabled again, exactly as on a row nothing dismissed.
  await flush();
  assert.equal(control.textContent, 'Acknowledge');
  assert.equal(control.disabled, false);
  assert.equal(messageOf(rowOf()).hidden, false);
  assert.equal(
    messageOf(rowOf()).textContent,
    'Couldn’t send — check your connection and try again.',
  );
});

test('a dismissed row returns when its severity changes, and after it leaves and is relisted', (t) => {
  signIn(t);
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);

  // The firmware rates it differently: listed again, and dismissible again.
  showHealth(doc({ advisories: [{ ...doc().advisories[0], severity: 'warning' }] }));
  assert.equal(rows().length, 1);
  assert.equal(chipOf(rowOf(), 'health-severity').textContent, 'Warning');
  assert.equal(element('health-title').textContent, '1 recorded advisory');
  assert.equal(dismissOf(rowOf()).textContent, 'Dismiss');
  // The record went with that report — it lasts only while it hides a row —
  // so the row would be shown as well if it returned to Critical as it is.
  assert.equal(stored(), null, 'the retired record is not kept');

  // Dismissed at the new rating too, and then the charger clears it: the
  // record goes with it…
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  showHealth(doc({ advisories: [] }));
  assert.equal(stored(), null, 'no record is left, so no key either');

  // …so the same advisory, listed again, is shown.
  showHealth(doc());
  assert.equal(rows().length, 1);
  assert.equal(element('health-card').getAttribute('data-state'), 'advisories');
  assert.equal(element('health-list').hidden, false);
});

test('a dismissed record returns when the charger starts reporting it as present', (t) => {
  const uid = signIn(t);
  const standing = doc().advisories[0];
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  const record = stored()[uid]['fault.no_ground'];
  assert.equal(record.severity, 'critical');
  assert.equal(record.reportedPresent, false, 'dismissed as the record it was');

  // Tripped again: the same id at the same severity, now Active from live
  // controller state. The row is back, as the live condition it now is…
  const tripped = doc({
    advisories: [{ ...standing, classification: 'active', corroborated: true }],
  });
  showHealth(tripped);
  assert.equal(rows().length, 1, 'the same severity does not keep it hidden');
  assert.equal(rowOf().getAttribute('data-presentation'), 'active');
  assert.equal(chipOf(rowOf(), 'health-severity').textContent, 'Critical');
  assert.equal(element('health-title').textContent, '1 active advisory');
  assert.equal(element('health-card').getAttribute('data-tone'), 'err');
  assert.equal(dismissOf(rowOf()).textContent, 'Dismiss');
  // …and its record went with the report that shows it.
  assert.equal(stored(), null, 'the record is not kept');

  // Dismissed again, the record now says the condition was present.
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  assert.equal(stored()[uid]['fault.no_ground'].reportedPresent, true);
});

test('health unknown leaves the records alone', (t) => {
  signIn(t);
  click(dismissOf(rowOf()));
  const before = stored();
  localStorageShim.sets = 0;

  // An outage of any kind — no document, a failed listener — is no evidence
  // that the advisory is gone, so nothing is retired and nothing is written.
  showHealth(null);
  assert.equal(element('health-title').textContent, 'Health unknown');
  showHealthError();
  assert.equal(element('health-retry').hidden, false);
  assert.deepEqual(stored(), before);
  assert.equal(localStorageShim.sets, 0);

  // The report is back: the row is still hidden.
  showHealth(doc());
  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'No advisories');
});

test('a gate that may still close retires nothing, so the row stays hidden when it closes', (t) => {
  const uid = signIn(t);
  // A safety check — the family a gateway that has not answered its settings
  // query yet reports nothing about.
  showHealth(doc({ advisories: [GROUND] }));
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  const before = stored();
  assert.deepEqual(Object.keys(before[uid]), ['safety.ground_check']);
  localStorageShim.sets = 0;

  // The gateway restarts: the report is usable, its safety gate is open, and
  // the advisory is simply not reported. That is silence, not a clearing, so
  // nothing is retired — and nothing is written, the screen's whole write path
  // being the projection's answer.
  const open = { settings_known: false, relay_health_known: true };
  showHealth(doc({ advisories: [], gates: open }));
  assert.equal(element('health-title').textContent, 'Health incomplete');
  assert.deepEqual(stored(), before, 'a report under an open gate retires no record');
  assert.equal(localStorageShim.sets, 0, 'and writes nothing');

  // Steady while the gate stays open: still nothing.
  showHealth(doc({ advisories: [], gates: open, checked_at: Date.now() / 1000 - 5 }));
  assert.deepEqual(stored(), before);
  assert.equal(localStorageShim.sets, 0);

  // The gate closes and the advisory is listed again, unchanged: still hidden.
  showHealth(doc({ advisories: [GROUND] }));
  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'No advisories');
  assert.deepEqual(stored(), before);

  // A complete report that leaves it out is the clearing that retires it.
  showHealth(doc());
  assert.equal(rows().length, 1, 'the other advisory lists');
  assert.equal(stored(), null, 'the record went with the advisory');
});

test('a refused storage write still hides the row for this page', (t) => {
  const uid = signIn(t);
  localStorageShim.refuse = true;

  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  assert.equal(stored(), null, 'storage never took it');

  // Hidden on every later report while the page lives…
  showHealth(doc());
  assert.deepEqual(rows(), []);

  // …and honestly gone on the next one: a session-only hide, never a record
  // the store pretends to have kept.
  assert.deepEqual(createDismissalStore({ storage: localStorageShim }).read(uid), {});
});

test('sign-out teardown drops the controls and keeps the records', (t) => {
  signIn(t);
  showHealth(twoRows());
  assert.notEqual(dismissOf(rowOf()), null);
  click(dismissOf(rowOf()));
  const before = stored();

  leaveStatus();

  assert.deepEqual(rows(), []);
  assert.equal(element('health-title').textContent, 'Health unknown');
  assert.deepEqual(stored(), before, 'records are durable per-account state');
});

test('a double-click on Dismiss removes one row, not the one that slides under the pointer', (t) => {
  // The clock is held, so the guard's window can be shown to open and lapse.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => mock.timers.reset());
  const uid = signIn(t);
  showHealth(twoRows());
  assert.equal(rows().length, 2);

  // A pointer click. The list rebuilds at once, and the next row's Dismiss
  // takes the place of the button just pressed — where the second click of
  // the same gesture lands.
  click(dismissOf(rows()[0]), { detail: 1 });
  assert.equal(rows().length, 1);
  click(dismissOf(rowOf()), { detail: 1 });
  assert.equal(rows().length, 1, 'the second click of the gesture is ignored');
  assert.equal(chipOf(rowOf(), 'health-name').textContent, 'Ground check');
  assert.deepEqual(Object.keys(stored()[uid]), ['fault.no_ground']);

  // The keyboard is never guarded: an activation with no click count is
  // taken at once, inside the window.
  click(dismissOf(rowOf()));
  assert.deepEqual(rows(), []);
  assert.deepEqual(Object.keys(stored()[uid]).sort(), ['fault.no_ground', 'safety.ground_check']);

  // Both dismissed; bring the rows back by a report that leaves them out,
  // and let the first gesture's window lapse.
  showHealth(doc({ advisories: [] }));
  showHealth(twoRows());
  assert.equal(rows().length, 2);
  mock.timers.tick(500);

  // A new gesture opens the window again. One millisecond short of its end
  // the pointer is still guarded…
  click(dismissOf(rows()[0]), { detail: 1 });
  assert.equal(rows().length, 1);
  mock.timers.tick(499);
  click(dismissOf(rowOf()), { detail: 1 });
  assert.equal(rows().length, 1, 'inside the window');
  assert.equal(chipOf(rowOf(), 'health-name').textContent, 'Ground check');

  // …and at its end it is trusted again.
  mock.timers.tick(1);
  click(dismissOf(rowOf()), { detail: 1 });
  assert.deepEqual(rows(), []);
});

test('sign-out drops the Dismiss guard: the next session’s first click is taken', (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => mock.timers.reset());
  const uid = signIn(t);
  showHealth(twoRows());
  click(dismissOf(rows()[0]), { detail: 1 });
  assert.equal(rows().length, 1);

  // Sign out and back in inside the window, then click: the last session's
  // gesture guards nothing.
  switchTo('');
  switchTo(uid);
  showHealth(twoRows());
  assert.equal(rows().length, 1, 'the first row is still dismissed');
  click(dismissOf(rowOf()), { detail: 1 });
  assert.deepEqual(rows(), []);
});
