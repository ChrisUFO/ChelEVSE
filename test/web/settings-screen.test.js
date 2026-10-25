import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Harness decision (#85/#102, recorded so the two issues cannot diverge): the
// repo's screen-level harness is the module-mock-free DOM stub proven in
// test/web/status-pulse.test.js and test/web/config.test.js — a
// `globalThis.document` whose `$` lookups are deferred to render time, then a
// plain `await import` of the real screen module. jsdom (a new devDependency)
// and node:test module mocks (a runner flag) were both rejected: the repo's
// convention is dependency-free `node --test` over the real sources. This layer
// pins the screen wiring — snapshot (`showSettingsData`) → field seeding
// (`writeFields`) → the captured submit listener's draft (`readFields()` →
// `submitSettingsPlan`) — which is exactly what can silently delete
// `settings/current.charger_host` on a rate-only save. It cannot cover layout,
// real DOM events or visual rendering, and it cannot reach the Firestore write
// itself: `firebase.js` keeps `doc`/`setDoc` null until `initFirebase()` runs,
// so a save is driven through the real submit listener to its commit boundary
// and then refused by the screen's own offline guard (`navigator.onLine =
// false`), which is a production code path, not a test seam. The
// values→payload half (`validateSettings` → `settingsPayload`) stays pinned at
// the helper layer in test/web/settings.test.js; the oracles here are the
// screen's own outputs — the seeded input, the rendered plan, and the
// save-state view (`settingsSaveState` over `readFields()`), which reports the
// form clean exactly when the submit draft re-sends every stored field.

// What the screen focuses and reveals, in order — the guard's a11y
// commitments (#129) are observable only through this log, exactly as the
// router harness records focus in test/web/ui.test.js.
const focusLog = [];
const scrollLog = [];

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
    // The one selector the paint pipeline resyncs through that the harness
    // observes: the day chips' pressed state (paintDayControl). Every other
    // query stays invisible, as before — enabling more selectors is a
    // per-finding decision, not a harness goal.
    querySelectorAll(selector) {
      if (selector !== '[data-day]') return [];
      const found = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.dataset && child.dataset.day != null) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    removeAttribute(name) {
      attrs.delete(name);
    },
    toggleAttribute() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    focus() {
      focusLog.push(this.id);
    },
    click() {},
    scrollIntoView() {
      scrollLog.push(this.id);
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

// The screen registers online/offline handlers and the beforeunload guard on
// the global, and focuses through matchMedia-aware scroll paths; node offers
// neither. The recorder keeps attach/detach observable for the guard (#129).
const windowListeners = new Map();
globalThis.addEventListener = (type, listener) => {
  if (!windowListeners.has(type)) windowListeners.set(type, new Set());
  windowListeners.get(type).add(listener);
};
globalThis.removeEventListener = (type, listener) => {
  windowListeners.get(type)?.delete(listener);
};
globalThis.matchMedia ??= () => ({ matches: false });
globalThis.requestAnimationFrame ??= () => {};

const { initSettings, resetSettings, showSettingsData, confirmLeaveSettings, isSettingsDirty } =
  await import('../../web/js/screens/settings.js');
const { BLOCKED_SAVE_MESSAGE, OFFLINE_MESSAGE } = await import('../../web/js/settings.js');

// One real wiring pass: the form/input listeners the save drive needs are the
// ones initSettings itself registers.
initSettings();

const night = {
  id: 'night',
  rate: 0.12,
  days: [0, 1, 2, 3, 4],
  start: '22:00',
  end: '06:00',
  months: null,
};

const storedDoc = { rate: 0.31, currency: 'USD', rates: [night], charger_host: '192.168.1.50' };

// The owner's keystroke: the value lands in the input and the screen's own
// input listener recomputes the draft (`handleInput` → `readFields()`).
const type = (id, value) => {
  const input = element(id);
  input.value = value;
  for (const listener of input.listeners.get('input') || []) listener();
};

// The owner's save: the submit listener initSettings captured on the form.
const submitForm = async () => {
  for (const listener of element('settings-form').listeners.get('submit') || []) {
    await listener({ preventDefault() {} });
  }
};

// The owner's toggle: the state lands on the checkbox and the screen's own
// change listener recomputes the draft (readFields()).
const toggle = (id, checked) => {
  const input = element(id);
  input.checked = checked;
  for (const listener of input.listeners.get('change') || []) listener();
};

const feedbackText = () => element('settings-feedback').textContent;

// A dirty edit clears a shown error only when the recomputed draft is still
// dirty, so an error left by a refused save needs one more real edit before
// the form can return to clean (that asymmetry is production behavior).
async function editRateBackToStored() {
  type('setting-rate', '0.35');
  assert.equal(feedbackText(), 'Unsaved changes.');
  type('setting-rate', '0.31');
  assert.equal(feedbackText(), '');
}

test('a rate-only save re-sends the stored charger address through the real screen', async () => {
  resetSettings();
  showSettingsData(storedDoc);

  // The snapshot seeded the address input (writeFields) and rendered the
  // stored row, and the loaded form is clean.
  assert.equal(element('setting-charger-host').value, '192.168.1.50');
  assert.equal(element('rates-plan').hidden, false);
  assert.equal(element('rate-periods').children.length, 1);
  assert.equal(feedbackText(), '');

  // The owner edits only the rate, through the screen's own input listener.
  type('setting-rate', '0.4');
  assert.equal(feedbackText(), 'Unsaved changes.');

  // The save: the real submit listener runs the real gate over the real draft.
  // Offline so the write layer is refused before any Firestore binding is
  // touched — the refusal message (not BLOCKED_SAVE_MESSAGE) proves the draft
  // passed validation and the commit callback ran.
  navigator.onLine = false;
  await submitForm();
  assert.equal(feedbackText(), OFFLINE_MESSAGE);
  navigator.onLine = true;

  // Returning to the stored rate leaves the form clean: the screen's own
  // draft comparison says the submit values equal the stored document —
  // charger address and rate rows included — so the whole-document write
  // re-sends them. Dropping `chargerHost` from `readFields()` (or its seed
  // from `writeFields()`) flips this to "Unsaved changes."
  await editRateBackToStored();
});

test('the submit path carries the charger-host field into validation', async () => {
  resetSettings();
  showSettingsData(storedDoc);

  // The owner types a malformed address over the seeded one and saves online:
  // a blocked draft returns before the write layer, and the field error is
  // the screen's proof that the submit listener read the input through
  // `readFields()` into `validateSettings`.
  type('setting-charger-host', '192.168.1.50:8080');
  type('setting-rate', '0.4');
  await submitForm();

  const error = element('charger-host-error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /port/);
  assert.equal(feedbackText(), BLOCKED_SAVE_MESSAGE);
});

test('a stored rate row survives the same rate-only path', async () => {
  resetSettings();
  showSettingsData({ rate: 0.31, currency: 'USD', rates: [night] });

  // The stored row rendered as one season.
  assert.equal(element('rates-plan').hidden, false);
  assert.equal(element('rate-periods').children.length, 1);

  type('setting-rate', '0.4');
  assert.equal(feedbackText(), 'Unsaved changes.');

  // The same save drive: the stored row does not block the gate.
  navigator.onLine = false;
  await submitForm();
  assert.equal(feedbackText(), OFFLINE_MESSAGE);
  navigator.onLine = true;

  // Clean again only if the draft still carries the row: dropping
  // `rates: draftRates` from `readFields()` leaves the form forever dirty.
  await editRateBackToStored();
});

// ---------- plan-editor day controls ----------
//
// The day presets and custom day chips are the plan editor's primary edit
// gesture, and the paint pipeline wires them through the `state` verbs
// (commitRowShape → markEdited/refresh), not module closures — a missed
// argument in that threading is exactly the class of regression the green
// suite could not see before these tests. Each click below drives the real
// listener on the really-rendered card, the same way the owner's pointer does.

// Depth-first over the stub tree: the harness keeps no parent links and the
// card builders nest the controls (window → day-control → presets/chips), so
// class lookup is the pointer's own path to a control.
const nodesByClass = (node, className, found = []) => {
  for (const child of node.children || []) {
    if (child.className === className) found.push(child);
    nodesByClass(child, className, found);
  }
  return found;
};

const windowCard = () => {
  const cards = nodesByClass(element('rate-periods'), 'rate-window');
  assert.equal(cards.length, 1, 'one window card renders for the stored row');
  return cards[0];
};

const presetButton = (card, id) => {
  const button = nodesByClass(card, 'preset').find((entry) => entry.dataset.preset === id);
  assert.ok(button, `the ${id} preset button renders`);
  return button;
};

const dayChip = (card, day) => {
  const chip = nodesByClass(card, 'plan-day').find((entry) => entry.dataset.day === String(day));
  assert.ok(chip, `the day-${day} chip renders`);
  return chip;
};

const chipGroup = (card) => nodesByClass(card, 'plan-days')[0];

const click = (node) => {
  for (const listener of node.listeners.get('click') || []) listener();
};

test('a day preset click commits the preset through the real card wiring', () => {
  resetSettings();
  showSettingsData(storedDoc);

  const card = windowCard();
  const summary = nodesByClass(card, 'rate-summary')[0];
  assert.equal(summary.textContent, 'Weekdays · 22:00–06:00 next day');
  assert.equal(presetButton(card, 'weekdays').attrs.get('aria-pressed'), 'true');
  assert.equal(feedbackText(), '');

  // Weekends: the row's days become the preset, the selection moves to it, and
  // the draft turns unsaved — the whole commit path, not just the mutation.
  click(presetButton(card, 'weekends'));
  assert.equal(summary.textContent, 'Weekends · 22:00–06:00 next day');
  assert.equal(presetButton(card, 'weekends').attrs.get('aria-pressed'), 'true');
  assert.equal(presetButton(card, 'weekdays').attrs.get('aria-pressed'), 'false');
  assert.equal(presetButton(card, 'every').attrs.get('aria-pressed'), 'false');
  assert.equal(chipGroup(card).hidden, true, 'a preset folds the custom chips away');
  assert.equal(feedbackText(), 'Unsaved changes.');
  assert.equal(isSettingsDirty(), true);
});

// Custom takes the preset click's no-days branch, which never touches state:
// the state-threading regression is pinned by the preset-commit test above
// and "day chips toggle…" below (both reach state.commitRowShape). Keep this
// one for the reveal itself, not for that pin.
test('the Custom preset only reveals the chips — the days and the clean draft stay put', () => {
  resetSettings();
  showSettingsData(storedDoc);

  const card = windowCard();
  const summary = nodesByClass(card, 'rate-summary')[0];
  assert.equal(chipGroup(card).hidden, true, 'a preset-shaped row starts folded');

  click(presetButton(card, 'custom'));
  assert.equal(chipGroup(card).hidden, false, 'Custom reveals the chip editor');
  assert.equal(presetButton(card, 'custom').attrs.get('aria-pressed'), 'true');
  assert.equal(presetButton(card, 'weekdays').attrs.get('aria-pressed'), 'false');
  assert.equal(summary.textContent, 'Weekdays · 22:00–06:00 next day', 'no day changed');
  assert.equal(feedbackText(), '', 'revealing chips is not an edit');
  assert.equal(isSettingsDirty(), false);
});

test('day chips toggle individual days and move the row to a custom set', () => {
  resetSettings();
  showSettingsData(storedDoc);

  const card = windowCard();
  const summary = nodesByClass(card, 'rate-summary')[0];
  click(presetButton(card, 'custom'));

  // Sat joins the weekday set in sorted position; the row is no longer a named
  // preset, so the selection lands on Custom. The chip's own pressed state
  // comes from the repaint's resync pass (paintDayControl walks [data-day]),
  // so asserting it pins that loop — not just the row mutation.
  click(dayChip(card, 5));
  assert.equal(summary.textContent, 'Mon, Tue, Wed, Thu, Fri, Sat · 22:00–06:00 next day');
  assert.equal(presetButton(card, 'custom').attrs.get('aria-pressed'), 'true');
  assert.equal(dayChip(card, 5).attrs.get('aria-pressed'), 'true');
  assert.equal(dayChip(card, 0).attrs.get('aria-pressed'), 'true');
  assert.equal(feedbackText(), 'Unsaved changes.');

  // Mon leaves the same way.
  click(dayChip(card, 0));
  assert.equal(summary.textContent, 'Tue, Wed, Thu, Fri, Sat · 22:00–06:00 next day');
  assert.equal(dayChip(card, 0).attrs.get('aria-pressed'), 'false');
  assert.equal(dayChip(card, 5).attrs.get('aria-pressed'), 'true');
  assert.equal(isSettingsDirty(), true);
});

// ---------- scoped seasons and the season date editor ----------
//
// A months- or date-scoped season is the plan editor's other render mode: the
// action row consults the plan algebra (complementScope, the complement
// overlap check, the duplicate cap) and the card carries the season date
// editor whose commit discards the year of a picked date. Every other render
// test uses an all-year single-window document, which never reaches these
// branches — the gap that hid a dropped import in the paint split.

const seasonCard = () => {
  const cards = nodesByClass(element('rate-periods'), 'rate-period');
  assert.equal(cards.length, 1, 'one season card renders');
  return cards[0];
};

const duplicateButton = (card) => {
  const button = nodesByClass(card, 'btn small').find(
    (entry) => entry.dataset.action === 'duplicate',
  );
  assert.ok(button, 'the Duplicate action renders on the season card');
  return button;
};

const seasonDateInput = (card, field) => {
  const input = nodesByClass(card, 'season-date-input').find(
    (entry) => entry.dataset.field === field,
  );
  assert.ok(input, `the ${field} season date input renders`);
  return input;
};

// Pairs with "two months-scoped seasons occupy each other’s complement, so
// Duplicate is withheld" below: only that test forces scopesOverlap across
// cards — together they pin the scoped-season render helpers, so a dedupe pass
// must keep both.
test('a months-scoped season renders with its duplicate action offered', () => {
  resetSettings();
  showSettingsData({
    rate: 0.31,
    currency: 'USD',
    rates: [{ ...night, id: 'summer', months: [6, 7, 8, 9] }],
  });

  // The complement (Jan–May, Oct–Dec) is unoccupied and the plan is under the
  // window cap, so Duplicate is offered: the render decided it through the
  // plan algebra, the branch an all-year document never executes.
  const card = seasonCard();
  assert.equal(duplicateButton(card).hidden, false);
  assert.equal(duplicateButton(card).disabled, false);
  assert.equal(feedbackText(), '');
});

test('two months-scoped seasons occupy each other’s complement, so Duplicate is withheld', () => {
  resetSettings();
  showSettingsData({
    rate: 0.31,
    currency: 'USD',
    rates: [
      { ...night, id: 'summer', months: [6, 7, 8, 9] },
      { ...night, id: 'winter', months: [1, 2, 3] },
    ],
  });

  // Both seasons render, and each sits inside the other's complement: the
  // overlap check ran for every card and correctly withholds the button — a
  // duplicate with nowhere to go reads as a broken action.
  const cards = nodesByClass(element('rate-periods'), 'rate-period');
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.equal(duplicateButton(card).hidden, true);
  }
  assert.equal(feedbackText(), '');
});

test('a date-scoped season renders its date editor seeded from the stored bounds', () => {
  resetSettings();
  showSettingsData({
    rate: 0.31,
    currency: 'USD',
    rates: [{ ...night, id: 'jun-sep', from: '06-15', to: '09-15' }],
  });

  // One wrapping complement range, unoccupied and under the cap: Duplicate is
  // offered, and both native date inputs render seeded with the stored
  // month-day in the reference year (the year is a rendering detail).
  const card = seasonCard();
  assert.equal(duplicateButton(card).hidden, false);
  assert.match(seasonDateInput(card, 'from-date').value, /-06-15$/);
  assert.match(seasonDateInput(card, 'to-date').value, /-09-15$/);
  assert.equal(feedbackText(), '');
});

test('a season date edit commits through the card wiring and unsaves the draft', () => {
  resetSettings();
  showSettingsData({
    rate: 0.31,
    currency: 'USD',
    rates: [{ ...night, id: 'jun-sep', from: '06-15', to: '09-15' }],
  });

  // The owner picks a new start date: the native input carries a full date,
  // the commit discards the year (boundFromDateInput stores MM-DD), and the
  // changed bound is a real edit — the same unsaved state as any keystroke.
  const card = seasonCard();
  const from = seasonDateInput(card, 'from-date');
  from.value = `${from.value.slice(0, 4)}-06-01`;
  for (const listener of from.listeners.get('change') || []) listener();
  assert.equal(feedbackText(), 'Unsaved changes.');
  assert.equal(isSettingsDirty(), true);
});

// The temperature switch (issue #117) rides the same #102 carry-through as the
// charger address: the snapshot seeds the checkbox, the draft re-sends it, and a
// rate-only save can no longer delete a stored hidden preference.
test('a rate-only save re-sends a stored hidden temperature through the real screen', async () => {
  resetSettings();
  showSettingsData({ ...storedDoc, show_temperature: false });

  // The snapshot seeded the switch off (writeFields) and the loaded form is
  // clean — the seeded checkbox already matches the stored document.
  assert.equal(element('setting-show-temperature').checked, false);
  assert.equal(feedbackText(), '');

  // The owner edits only the rate, through the screen's own input listener.
  type('setting-rate', '0.4');
  assert.equal(feedbackText(), 'Unsaved changes.');

  // The real submit gate over the real draft: offline refusal proves the draft
  // passed validation with the checkbox carried into it.
  navigator.onLine = false;
  await submitForm();
  assert.equal(feedbackText(), OFFLINE_MESSAGE);
  navigator.onLine = true;

  // Returning to the stored rate leaves the form clean: the draft comparison
  // says the submit values equal the stored document — temperature toggle
  // included — so the whole-document write re-sends the stored false. Dropping
  // `showTemperature` from `readFields()` (or its seed from `writeFields()`)
  // flips this to "Unsaved changes."
  await editRateBackToStored();

  // The toggle itself is a real edit, and toggling back is clean again.
  toggle('setting-show-temperature', true);
  assert.equal(feedbackText(), 'Unsaved changes.');
  toggle('setting-show-temperature', false);
  assert.equal(feedbackText(), '');
});

test('the temperature switch is seeded visible for a stored document without it', async () => {
  resetSettings();
  showSettingsData(storedDoc);

  // Absent means visible: the checkbox seeds checked and the form is clean.
  assert.equal(element('setting-show-temperature').checked, true);
  assert.equal(feedbackText(), '');

  // Hiding through the switch is the same unsaved edit as typing a new rate.
  toggle('setting-show-temperature', false);
  assert.equal(feedbackText(), 'Unsaved changes.');
  toggle('setting-show-temperature', true);
  assert.equal(feedbackText(), '');
});

// ---------- unsaved-changes guard (#129) ----------
//
// The guard rides the same dirty flag the feedback pipeline maintains, so the
// screen's own outputs are the oracle: the beforeunload listener's presence on
// the global, the dialog element's `hidden`, and the promise the router waits
// on. The route gating itself is pinned pure in test/web/settings.test.js and
// the router's half in test/web/ui.test.js.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The dialog markup ships `hidden`; the generic stub would otherwise report a
// never-touched element as open.
element('leave-settings-confirm').hidden = true;

const beforeUnloadAttached = () => (windowListeners.get('beforeunload')?.size ?? 0) > 0;

const fireBeforeUnload = () => {
  let prevented = false;
  const event = {
    preventDefault() {
      prevented = true;
    },
    returnValue: undefined,
  };
  for (const listener of windowListeners.get('beforeunload') || []) listener(event);
  return { prevented, event };
};

const clickButton = (id) => {
  for (const listener of element(id).listeners.get('click') || []) listener();
};

const pressKey = (id, key) => {
  for (const listener of element(id).listeners.get('keydown') || []) listener({ key });
};

const dialogOpen = () => element('leave-settings-confirm').hidden === false;

// Resolves to a getter for the promise's eventual answer ('pending' until then).
const answerOf = (promise) => {
  let answer = 'pending';
  promise.then((value) => {
    answer = value;
  });
  return () => answer;
};

test('beforeunload attaches only for the dirty window and tears down with the screen', async () => {
  resetSettings();
  showSettingsData(storedDoc);
  assert.equal(beforeUnloadAttached(), false, 'a clean form never intercepts the unload');

  type('setting-rate', '0.4');
  assert.equal(isSettingsDirty(), true);
  assert.equal(beforeUnloadAttached(), true, 'a dirty draft attaches the guard');

  const { prevented, event } = fireBeforeUnload();
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '', 'the legacy returnValue flag is set');

  await editRateBackToStored();
  assert.equal(isSettingsDirty(), false);
  assert.equal(beforeUnloadAttached(), false, 'editing back to clean detaches the guard');

  type('setting-rate', '0.4');
  assert.equal(beforeUnloadAttached(), true);
  resetSettings();
  assert.equal(beforeUnloadAttached(), false, 'sign-out teardown clears the guard');
  assert.equal(isSettingsDirty(), false);
});

test('a clean form resolves the leave immediately and never opens the dialog', async () => {
  resetSettings();
  showSettingsData(storedDoc);

  const answer = answerOf(confirmLeaveSettings());
  await tick();
  assert.equal(answer(), true);
  assert.equal(dialogOpen(), false);
});

test('a dirty form asks: Stay keeps the draft, Leave proceeds, Escape stays', async () => {
  resetSettings();
  showSettingsData(storedDoc);
  type('setting-rate', '0.4');

  const answer = answerOf(confirmLeaveSettings());
  await tick();
  assert.equal(answer(), 'pending', 'the router waits for an answer');
  assert.equal(dialogOpen(), true, 'the dialog is the One-rate alertdialog pattern');
  assert.equal(focusLog.at(-1), 'stay-settings', 'Stay takes focus when the dialog opens');
  // The trigger is the fixed bottom tab bar, reachable at any scroll offset,
  // so opening must reveal the in-flow dialog itself.
  assert.ok(
    scrollLog.includes('leave-settings-confirm'),
    'opening the dialog scrolls it into view',
  );
  // Asking again while open returns the same open question, not a second one.
  const answerAgain = answerOf(confirmLeaveSettings());
  focusLog.length = 0;
  clickButton('stay-settings');
  await tick();
  assert.equal(answer(), false, 'Stay declines the navigation');
  assert.equal(answerAgain(), false, 'a repeat ask shares the same answer');
  assert.equal(dialogOpen(), false);
  assert.equal(focusLog.at(-1), 'tab-config', 'Stay returns focus to the Config tab');
  assert.equal(element('setting-rate').value, '0.4', 'the draft survives Stay');

  // Escape is the safe action, exactly like the One-rate confirm's Cancel.
  const escAnswer = answerOf(confirmLeaveSettings());
  pressKey('leave-settings-confirm', 'Escape');
  await tick();
  assert.equal(escAnswer(), false);
  assert.equal(dialogOpen(), false);

  const discardAnswer = answerOf(confirmLeaveSettings());
  clickButton('discard-settings');
  await tick();
  assert.equal(discardAnswer(), true, 'Leave releases the navigation');
  assert.equal(dialogOpen(), false);
  // The edits stay unsaved (the write never ran), exactly as a plain tab
  // switch leaves them today — the screen keeps its state, panels only hide.
  assert.equal(isSettingsDirty(), true);
});

test('an offline save refusal keeps the guard: the draft is still unsaved', async () => {
  resetSettings();
  showSettingsData(storedDoc);
  type('setting-rate', '0.4');

  navigator.onLine = false;
  await submitForm();
  assert.equal(feedbackText(), OFFLINE_MESSAGE);
  navigator.onLine = true;

  assert.equal(isSettingsDirty(), true, 'the refused save leaves the draft dirty');
  assert.equal(beforeUnloadAttached(), true);
  const answer = answerOf(confirmLeaveSettings());
  clickButton('discard-settings');
  await tick();
  assert.equal(answer(), true);
});

test('a snapshot that un-dirties the form detaches beforeunload and settles an open ask', async () => {
  resetSettings();
  showSettingsData(storedDoc);
  type('setting-rate', '0.4');
  assert.equal(beforeUnloadAttached(), true);

  const answer = answerOf(confirmLeaveSettings());
  assert.equal(dialogOpen(), true);

  // The stored document catches up to the typed rate: the draft is confirmed
  // by the server, so the guard's premise disappears underneath it.
  showSettingsData({ ...storedDoc, rate: 0.4 });
  assert.equal(isSettingsDirty(), false);
  assert.equal(beforeUnloadAttached(), false, 'the snapshot detach is immediate');
  await tick();
  assert.equal(answer(), true, 'the pending navigation completes — nothing is at stake now');
  assert.equal(dialogOpen(), false);
});

test('index.html ships the leave dialog the screen wires', () => {
  // The harness above answers any id on demand, so the wiring is pinned from
  // source (the config-lifetime convention): drop or rename one of these in
  // the markup and initSettings throws on a null element at boot — loud, but
  // only when a browser loads the page.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(source, /id="leave-settings-confirm"/);
  assert.match(source, /id="stay-settings"/);
  assert.match(source, /id="discard-settings"/);
});

test('index.html groups the charger address into the connection card, ahead of pricing', () => {
  // The Config regroup (#129 → #135) is placement, not behaviour: every
  // binding in this file is id-only, so moving the charger address back under
  // pricing (or swapping the cards) would keep the whole harness green. The
  // grouping is pinned from source, the same convention as the dialog ids
  // above: the connection card comes first and owns the address, the
  // Electricity price card follows, and its single save bar submits both.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const at = {
    form: source.indexOf('id="settings-form"'),
    connectionCard: source.indexOf('class="card-block connection-card"'),
    chargerHost: source.indexOf('id="setting-charger-host"'),
    pricingCard: source.indexOf('class="card-block settings-card"'),
    pricingHeading: source.indexOf('id="settings-heading"'),
    rateEditor: source.indexOf('class="rate-editor"'),
    fallbackCard: source.indexOf('class="fallback-card"'),
    saveBar: source.indexOf('id="save-settings"'),
  };
  for (const [marker, position] of Object.entries(at)) {
    assert.notEqual(position, -1, `${marker} is missing from web/index.html`);
  }
  assert.ok(
    at.form < at.connectionCard &&
      at.connectionCard < at.chargerHost &&
      at.chargerHost < at.pricingCard,
    'the charger address sits inside the connection card, before the pricing card',
  );
  assert.ok(
    at.pricingCard < at.pricingHeading &&
      at.pricingHeading < at.rateEditor &&
      at.rateEditor < at.fallbackCard,
    'the Electricity price card follows — heading, rate editor, then fallback rate',
  );
  assert.ok(at.rateEditor < at.saveBar, 'the save bar closes the pricing card after its editor');
  assert.equal(
    source.match(/id="save-settings"/g)?.length,
    1,
    'exactly one save bar submits the whole form',
  );
});
