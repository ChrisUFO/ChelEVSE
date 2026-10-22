import { test } from 'node:test';
import assert from 'node:assert/strict';

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
};

// The screen registers online/offline handlers on the global and focuses
// through matchMedia-aware scroll paths; node offers neither.
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.matchMedia ??= () => ({ matches: false });
globalThis.requestAnimationFrame ??= () => {};

const { initSettings, resetSettings, showSettingsData } =
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
