import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The config screen renders into the live DOM. Give it the smallest document
// it needs — one stub element per id — and import the module afterwards; every
// lookup is deferred to render time.
function stubElement() {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    style: { setProperty() {} },
    textContent: '',
    title: '',
    hidden: false,
    value: '',
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((node) => node.textContent || '').join('');
    },
    append(...nodes) {
      this.children.push(...nodes);
      this.textContent += nodes.map((node) => node.textContent || '').join('');
    },
    setAttribute() {},
    addEventListener() {},
    focus() {},
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

const { showLifetimeEnergy, resetConfig } = await import('../../web/js/screens/config.js');

const note = () => element('lifetime-note');

test('the lifetime note shows only a usable total_energy', () => {
  // Nothing usable yet: the line stays hidden until status/current reports it.
  showLifetimeEnergy(null);
  assert.equal(note().hidden, true);
  // A usable total renders one plain line in the shared kWh shape (fmtK
  // compacts: no decimals by 12,346 kWh, two below 10).
  showLifetimeEnergy(12345.6);
  assert.equal(note().hidden, false);
  assert.equal(note().textContent, 'Lifetime energy: 12346 kWh');
  showLifetimeEnergy(1.234);
  assert.equal(note().textContent, 'Lifetime energy: 1.23 kWh');
  // Zero and non-numeric totals hide it again.
  showLifetimeEnergy(0);
  assert.equal(note().hidden, true);
  showLifetimeEnergy('not a number');
  assert.equal(note().hidden, true);
});

test('resetConfig clears the note with the rest of the screen', () => {
  showLifetimeEnergy(9876.5);
  assert.equal(note().hidden, false);
  resetConfig();
  assert.equal(note().hidden, true);
});

test('index.html ships the note element the screen renders into', () => {
  // The stub above answers any id, so the wiring is pinned from source: if
  // this element is renamed or removed, renderLifetime has nothing to fill
  // and the Lifetime figure silently vanishes from the Config screen.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(source, /id="lifetime-note"/);
});
