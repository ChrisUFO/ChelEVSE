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

// The held-window math prices local wall-clock hours; pin the zone so the
// fixtures mean the same thing here as in cost.test.js.
process.env.TZ = 'America/Denver';

const { showStatus, showSettings } = await import('../../web/js/screens/status.js');

function at(year, month, day, hours, minutes) {
  const ms = new Date(year, month - 1, day, hours, minutes).getTime();
  return { toMillis: () => ms };
}

function snapshot(overrides) {
  return {
    exists: () => true,
    data: () => ({
      state: 3,
      state_label: 'charging',
      charger_online: true,
      updated_at: at(2026, 1, 5, 3, 0),
      elapsed: 600,
      session_energy: 2000,
      amp: 16,
      pilot: 16,
      ...overrides,
    }),
  };
}

// The same fixtures cost.test.js prices: an off-peak 00:00–06:00 window over an
// all-day base, a base-less 16:00–19:00 window, and a flat config.
const NIGHTLY = {
  rate: 0.3,
  currency: 'GBP',
  rates: [
    {
      id: 'base',
      rate: 0.3,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '00:00',
      months: null,
    },
    {
      id: 'night',
      rate: 0.1,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '06:00',
      months: null,
    },
  ],
};
const WINDOW_ONLY = {
  rate: 0.3,
  currency: 'GBP',
  rates: [
    {
      id: 'peak',
      rate: 0.32,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '16:00',
      end: '19:00',
      months: null,
    },
  ],
};
const FLAT = { rate: 0.245, currency: 'GBP' };

const HOUR = 60 * 60 * 1000;
const cost = () => element('fig-cost').textContent;
const sub = () => element('cost-sub');

test('the cost tile shows the live window while charging', () => {
  showSettings(NIGHTLY);
  // 1 kWh over the off-peak hour ending 03:00.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 3, 0), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.10');
  // The hour ending 06:30 straddles the boundary: half at each rate.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 6, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.20');
});

test('the figure freezes at the charging-stop anchor, never sliding', () => {
  // Charging ended 06:30 (elapsed 3600): the figure on screen is GBP 0.20.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 6, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.20');
  // Charge complete, still plugged in: a newer write with pause time counted
  // into elapsed must neither re-price at the later clock (GBP 0.30) nor
  // stretch the frozen window with the newer elapsed (GBP 0.13).
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 8, 30),
      elapsed: 3 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
  // Hours of later polls keep the same figure and rate window.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 14, 30),
      elapsed: 8 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
});

test('an offline marker keeps the frozen figure without re-pricing it', () => {
  // The bridge's offline marker refreshes updated_at while keeping the frozen
  // state/elapsed: the held figure must survive it unchanged.
  showStatus(
    snapshot({
      charger_online: false,
      updated_at: at(2026, 1, 5, 14, 30),
      elapsed: 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
});

test('a session reset clears the anchor and a new charge re-anchors', () => {
  // Energy zeroed: fresh idle state, the tile hides.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 15, 0),
      elapsed: 0,
      session_energy: 0,
    }),
  );
  assert.equal(cost(), '—');
  // A later paused-with-energy write finds no anchor (the screen saw no
  // charging write for it) and hides rather than guessing a window.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 15, 30),
      elapsed: 3600,
      session_energy: 2000,
    }),
  );
  assert.equal(cost(), '—');
  // A new charge prices its own live window from its own write.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 16, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.30');
  // And its stop freezes there.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 18, 0),
      elapsed: 2 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.30');
});

test('flat configs price the session energy with no anchor at all', () => {
  // The same cold-opened paused session: the flat path is energy x rate,
  // byte-identical, shown for the whole session without ever needing a write.
  showSettings(FLAT);
  assert.equal(cost(), 'GBP 0.25');
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 19, 0),
      elapsed: 3 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.25');
});

test('the understates-cost marker sits under the figure, live and held', () => {
  showSettings(WINDOW_ONLY);
  // The live hour ending 16:30 is half uncovered: the figure prices at 0.16
  // and carries the marker with its tooltip.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 16, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.16');
  assert.equal(sub().textContent, 'understates cost');
  assert.ok(sub().children[0].title.includes('no price'));
  // The stop keeps the frozen window, so it keeps the marker too.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 17, 30),
      elapsed: 2 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.16');
  assert.equal(sub().textContent, 'understates cost');
  // A fully covered live window drops the marker.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 17, 0), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.32');
  assert.equal(sub().textContent, '');
  // A schedule with a base never marks.
  showSettings(NIGHTLY);
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 12, 0), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.30');
  assert.equal(sub().textContent, '');
});
