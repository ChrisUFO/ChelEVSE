import { test } from 'node:test';
import assert from 'node:assert/strict';

// Characterization tests for the schedule screen's card builder — the file had
// zero direct coverage (test/web/schedule.test.js covers the pure logic module
// only). Same module-mock-free DOM-stub harness as test/web/settings-screen.test.js
// and test/web/history-screen.test.js: a globalThis.document whose getElementById
// lookups are deferred to render time, then a plain `await import` of the real
// screen module. These pin the DOM shape and behaviours a shared day-picker
// extraction could silently change: the card tree, the day-chip
// select/deselect wiring over DAY_NAMES, the aria-invalid / `invalid` class
// toggling driven by validateAndPaint, and the feedback line's states. They
// cannot cover layout, real DOM events, or a Firestore write.

import { DAY_NAMES, MAX_RULES } from '../../web/js/schedule.js';

function stubElement(tag = '') {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  const bySelector = new Map();
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
    // renderLive reaches into a rendered card for its "Active now" line; the
    // memoized stub keeps that reachable without a real DOM.
    querySelector(selector) {
      if (!bySelector.has(selector)) bySelector.set(selector, stubElement());
      return bySelector.get(selector);
    },
    querySelectorAll: () => [],
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
    focus() {},
    click() {},
    scrollIntoView() {},
  };
}

const elements = new Map();

function element(id) {
  let node = elements.get(id);
  if (!node) {
    node = stubElement();
    node.id = id;
    elements.set(id, node);
  }
  return node;
}

globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
  createTextNode: (text) => ({ textContent: text }),
};

const windowListeners = new Map();
globalThis.addEventListener = (type, listener) => {
  if (!windowListeners.has(type)) windowListeners.set(type, new Set());
  windowListeners.get(type).add(listener);
};
globalThis.removeEventListener = (type, listener) => {
  windowListeners.get(type)?.delete(listener);
};
globalThis.matchMedia ??= () => ({ matches: false });

const { initSchedule, enterSchedule, resetSchedule, showSchedule, showScheduleError } =
  await import('../../web/js/screens/schedule.js');

initSchedule();

// A schedule document as store.js delivers it: one everyday overnight window.
const nightRule = { id: 'rule-1', days: [0, 1, 2, 3, 4], start: '22:00', end: '06:00', amps: 32 };
const document_ = { enabled: true, rules: [nightRule] };

const fire = (node, type) => {
  for (const listener of node.listeners.get(type) || []) listener();
};

// The first rendered card in the list, after one snapshot adoption.
function adoptOneRule() {
  resetSchedule();
  enterSchedule();
  showSchedule(document_);
  const list = element('rule-list');
  assert.equal(list.children.length, 1, 'one rule renders one card');
  return list.children[0];
}

function feedback() {
  return {
    text: element('schedule-feedback').textContent,
    className: element('schedule-feedback').className,
  };
}

test('createCard builds the documented window-card shape', () => {
  const card = adoptOneRule();

  assert.equal(card.tag, 'article');
  assert.equal(card.className, 'rule-card');
  assert.equal(card.dataset.id, 'rule-1');

  // head: title, live badge, remove
  const [head, days, times, ampsRow, errorEl] = card.children;
  assert.equal(head.tag, 'div');
  assert.equal(head.className, 'rule-head');
  const [title, live, remove] = head.children;
  assert.equal(title.tag, 'h3');
  assert.equal(title.className, 'rule-title');
  assert.equal(title.textContent, 'Window 1');
  assert.equal(live.tag, 'span');
  assert.equal(live.className, 'rule-live');
  assert.equal(live.textContent, 'Active now');
  // (Visibility is driven by renderLive through the card's .rule-live lookup,
  // which the deferred stub cannot alias to this node.)
  assert.equal(remove.tag, 'button');
  assert.equal(remove.className, 'rule-remove');
  assert.equal(remove.textContent, 'Remove');
  assert.equal(remove.type, 'button');
  assert.deepEqual([...remove.attrs.keys()], ['aria-label']);
  assert.equal(remove.attrs.get('aria-label'), 'Remove window 1');

  // days: one role=group of seven DAY_NAMES toggle chips
  assert.equal(days.tag, 'div');
  assert.equal(days.className, 'days');
  assert.equal(days.attrs.get('role'), 'group');
  assert.equal(days.attrs.get('aria-label'), 'Days for window 1');
  assert.equal(days.attrs.get('aria-describedby'), 'rule-error-0');
  assert.equal(days.children.length, DAY_NAMES.length);
  days.children.forEach((chip, day) => {
    assert.equal(chip.tag, 'button');
    assert.equal(chip.className, 'day');
    assert.equal(chip.type, 'button');
    assert.equal(chip.textContent, DAY_NAMES[day]);
    assert.equal(chip.attrs.get('aria-label'), `${DAY_NAMES[day]} for window 1`);
    assert.equal(chip.attrs.get('aria-pressed'), String(nightRule.days.includes(day)));
  });

  // times: Start/End fields with an aria-hidden arrow between them
  assert.equal(times.tag, 'div');
  assert.equal(times.className, 'time-row');
  const [startField, sep, endField] = times.children;
  assert.equal(startField.tag, 'label');
  assert.equal(startField.className, 'field');
  assert.equal(startField.children[0].textContent, 'Start');
  assert.equal(startField.children[1].type, 'time');
  assert.equal(startField.children[1].value, '22:00');
  assert.equal(startField.children[1].attrs.get('aria-describedby'), 'rule-error-0');
  assert.equal(sep.textContent, '→');
  assert.equal(sep.attrs.get('aria-hidden'), 'true');
  assert.equal(endField.children[0].textContent, 'End');
  assert.equal(endField.children[1].type, 'time');
  assert.equal(endField.children[1].value, '06:00');

  // current: a minus/number/plus stepper
  assert.equal(ampsRow.tag, 'div');
  assert.equal(ampsRow.className, 'amps-row');
  const [currentLabel, stepper] = ampsRow.children;
  assert.equal(currentLabel.textContent, 'Current');
  assert.equal(stepper.tag, 'div');
  assert.equal(stepper.className, 'stepper');
  const [minus, ampsInput, unit, plus] = stepper.children;
  assert.equal(minus.textContent, '−');
  assert.equal(minus.attrs.get('aria-label'), 'Decrease current for window 1');
  assert.equal(ampsInput.tag, 'input');
  assert.equal(ampsInput.className, 'amps-input');
  assert.equal(ampsInput.type, 'number');
  assert.equal(ampsInput.value, '32');
  assert.equal(ampsInput.attrs.get('aria-label'), 'Current for window 1');
  assert.equal(unit.textContent, 'A');
  assert.equal(plus.textContent, '+');
  assert.equal(plus.attrs.get('aria-label'), 'Increase current for window 1');

  // error line: present, identified, hidden while the rule is valid
  assert.equal(errorEl.tag, 'p');
  assert.equal(errorEl.className, 'rule-error');
  assert.equal(errorEl.id, 'rule-error-0');
  assert.equal(errorEl.hidden, true);
});

test('day chips select and deselect through their click listeners', () => {
  const card = adoptOneRule();
  const days = card.children[1];
  // Day 2 (Wed) starts selected on the weekday preset.
  assert.equal(days.children[2].attrs.get('aria-pressed'), 'true');
  assert.deepEqual(feedback(), { text: '', className: 'feedback' });

  // Deselect: the day leaves the rule and the chip announces it.
  fire(days.children[2], 'click');
  assert.equal(days.children[2].attrs.get('aria-pressed'), 'false');
  assert.deepEqual(feedback(), { text: 'Unsaved changes.', className: 'feedback warn' });

  // Select again: the day returns in sorted position.
  fire(days.children[2], 'click');
  assert.equal(days.children[2].attrs.get('aria-pressed'), 'true');

  // A weekend day joins the weekday set the same way.
  fire(days.children[6], 'click');
  assert.equal(days.children[6].attrs.get('aria-pressed'), 'true');
  // The other chips keep their own state.
  assert.equal(days.children[0].attrs.get('aria-pressed'), 'true');
});

test('an empty day set toggles aria-invalid and the invalid class on the days group', () => {
  const card = adoptOneRule();
  const [head, days] = card.children;
  assert.equal(days.attrs.get('aria-invalid'), 'false');
  assert.equal(days.classes.has('invalid'), false);

  // Remove all five selected days: "Pick at least one day."
  for (const day of [0, 1, 2, 3, 4]) fire(days.children[day], 'click');
  assert.equal(days.attrs.get('aria-invalid'), 'true');
  assert.equal(days.classes.has('invalid'), true);
  assert.equal(card.classes.has('invalid'), true);
  const errorEl = card.children[4];
  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, 'Pick at least one day.');

  // Re-selecting a day clears every invalid marker again.
  fire(days.children[0], 'click');
  assert.equal(days.attrs.get('aria-invalid'), 'false');
  assert.equal(days.classes.has('invalid'), false);
  assert.equal(card.classes.has('invalid'), false);
  assert.equal(errorEl.hidden, true);
});

test('a missing time toggles aria-invalid on the time inputs', () => {
  const card = adoptOneRule();
  const times = card.children[2];
  const startInput = times.children[0].children[1];
  const endInput = times.children[2].children[1];
  const errorEl = card.children[4];

  startInput.value = '';
  fire(startInput, 'input');
  assert.equal(startInput.attrs.get('aria-invalid'), 'true');
  assert.equal(endInput.attrs.get('aria-invalid'), 'true');
  assert.equal(errorEl.hidden, false);
  assert.equal(errorEl.textContent, 'Set a start and end time.');
  assert.equal(card.classes.has('invalid'), true);
  // Days stay valid: only the edited field's markers turn on.
  assert.equal(card.children[1].attrs.get('aria-invalid'), 'false');

  startInput.value = '23:00';
  fire(startInput, 'input');
  assert.equal(startInput.attrs.get('aria-invalid'), 'false');
  assert.equal(errorEl.hidden, true);
});

test('renderFeedback reports clean, unsaved, invalid and load-error states', () => {
  // Clean: an adopted snapshot with no edits.
  adoptOneRule();
  assert.deepEqual(feedback(), { text: '', className: 'feedback' });

  // Unsaved: a valid edit.
  const card = element('rule-list').children[0];
  fire(card.children[1].children[6], 'click');
  assert.deepEqual(feedback(), { text: 'Unsaved changes.', className: 'feedback warn' });

  // Invalid: the actionable state, once no write state is outstanding.
  const startInput = card.children[2].children[0].children[1];
  startInput.value = '';
  fire(startInput, 'input');
  assert.deepEqual(feedback(), {
    text: 'Fix the highlighted fields before saving.',
    className: 'feedback',
  });

  // Load error before the first snapshot: the standalone failed-load line.
  resetSchedule();
  enterSchedule();
  showScheduleError();
  const fb = element('schedule-feedback');
  assert.equal(fb.textContent, "Couldn't load the schedule. Reload the page to try again.");
  assert.equal(fb.className, 'feedback err');
});

test('the plan count and empty state follow the rendered rules', () => {
  adoptOneRule();
  assert.equal(element('schedule-count').textContent, `1 of ${MAX_RULES}`);
  assert.equal(element('schedule-empty').hidden, true);

  // Add window: the captured click listener appends a default rule.
  fire(element('add-rule'), 'click');
  assert.equal(element('rule-list').children.length, 2);
  assert.equal(element('schedule-count').textContent, `2 of ${MAX_RULES}`);
  const second = element('rule-list').children[1];
  assert.equal(second.children[0].children[0].textContent, 'Window 2');
  // A fresh rule is the weekday overnight preset.
  const days = second.children[1];
  days.children.forEach((chip, day) => {
    assert.equal(chip.attrs.get('aria-pressed'), String([0, 1, 2, 3, 4].includes(day)));
  });
});

test('syncControls drives the save/add/discard disabled states and the editor lock', () => {
  // Clean, unlocked form: nothing to save or discard, room for more rules.
  adoptOneRule();
  assert.equal(element('save-schedule').disabled, true);
  assert.equal(element('discard-schedule').disabled, true);
  assert.equal(element('add-rule').disabled, false);

  // A valid edit unlocks save and discard together.
  const card = element('rule-list').children[0];
  fire(card.children[1].children[6], 'click');
  assert.equal(element('save-schedule').disabled, false);
  assert.equal(element('discard-schedule').disabled, false);

  // An invalid draft re-locks save alone: canSave stays true, saveValid() goes false.
  const startInput = card.children[2].children[0].children[1];
  startInput.value = '';
  fire(startInput, 'input');
  assert.equal(element('save-schedule').disabled, true);
  assert.equal(element('discard-schedule').disabled, false);

  // The rule cap locks add-rule while the draft stays editable.
  resetSchedule();
  enterSchedule();
  showSchedule(document_);
  while (element('rule-list').children.length < MAX_RULES) fire(element('add-rule'), 'click');
  assert.equal(element('add-rule').disabled, true);
  assert.equal(element('save-schedule').disabled, false);

  // Lock loop: a load error disables every input and button inside the editor.
  // In the real DOM the id-bound controls live in #schedule-editor; the shared
  // stub returns no children for querySelectorAll, so this test aliases them
  // in for the selector the loop uses.
  const editor = element('schedule-editor');
  const controls = [element('save-schedule'), element('add-rule'), element('discard-schedule')];
  const originalQuerySelectorAll = editor.querySelectorAll;
  editor.querySelectorAll = (selector) => (selector === 'input, button' ? controls : []);
  try {
    showScheduleError();
    for (const control of controls) assert.equal(control.disabled, true);
    assert.equal(element('panel-schedule').attrs.get('aria-busy'), 'false');
  } finally {
    editor.querySelectorAll = originalQuerySelectorAll;
  }
});
