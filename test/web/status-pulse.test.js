import { test } from 'node:test';
import assert from 'node:assert/strict';

// The status screen renders into the live DOM. Give it the smallest document it
// needs — one stub element per id, with the class list the badge toggles — and
// import the module afterwards; every lookup is deferred to render time.
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

const { showStatus } = await import('../../web/js/screens/status.js');

function snapshot(overrides) {
  return {
    exists: () => true,
    data: () => ({
      state: 3,
      state_label: 'charging',
      charger_online: true,
      updated_at: { toMillis: () => Date.now() },
      elapsed: 600,
      session_energy: 2000,
      amp: 16,
      pilot: 16,
      ...overrides,
    }),
  };
}

const pulsing = () => element('state-badge').classes.has('pulse');

test('the state badge pulses only for a live charging snapshot', () => {
  // The bridge's offline marker keeps the last-known charging label while its
  // clock and cost are frozen, so the badge must not claim a live charge.
  showStatus(snapshot({ charger_online: false }));
  assert.equal(pulsing(), false);

  showStatus(snapshot({ charger_online: true }));
  assert.equal(pulsing(), true);

  // A paused/ready write is not charging, however fresh it is.
  showStatus(snapshot({ state: 2, state_label: 'ready' }));
  assert.equal(pulsing(), false);

  // An older document without the flag still counts as online.
  showStatus(snapshot({ charger_online: null }));
  assert.equal(pulsing(), true);

  // No snapshot at all renders without the pulse.
  showStatus({ exists: () => false });
  assert.equal(pulsing(), false);
});

test('the banner routes state-aware staleness verdicts', () => {
  const ago = (ms) => ({ toMillis: () => Date.now() - ms });
  const banner = () => element('banner');
  const bannerText = () => banner().textContent;

  // Charging inside the 150 s bound stays banner-free.
  showStatus(snapshot({ updated_at: ago(149_000) }));
  assert.equal(banner().hidden, true);
  // One second past it: the dedicated charging wording, not "Bridge offline".
  showStatus(snapshot({ updated_at: ago(151_000) }));
  assert.equal(banner().hidden, false);
  assert.equal(bannerText(), 'Not updating — showing last known values');
  // The idle bound is 12 min, so a 151 s old ready snapshot is not stale…
  showStatus(snapshot({ state: 2, state_label: 'ready', updated_at: ago(151_000) }));
  assert.equal(banner().hidden, true);
  // …but 12 min and one second is, with the bridge wording.
  showStatus(snapshot({ state: 2, state_label: 'ready', updated_at: ago(721_000) }));
  assert.equal(banner().hidden, false);
  assert.equal(bannerText(), 'Bridge offline — showing last known values');
  // The offline marker wins regardless of age, even over the frozen charging
  // label it leaves behind.
  showStatus(snapshot({ charger_online: false, updated_at: ago(721_000) }));
  assert.equal(banner().hidden, false);
  assert.equal(bannerText(), 'Charger offline — showing last known values');
  // A missing timestamp is bridge-stale immediately, and even a charging label
  // gets the plain bridge banner: with no age there is nothing softer to say.
  showStatus(snapshot({ updated_at: null }));
  assert.equal(banner().hidden, false);
  assert.equal(bannerText(), 'Bridge offline — showing last known values');
  assert.equal(element('updated').textContent, 'updated unknown');
});
