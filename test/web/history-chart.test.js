import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBar } from '../../web/js/screens/history-chart.js';
import { fmtK } from '../../web/js/format.js';

// buildBar is pure geometry over an injected SVG namespace: it only needs
// setAttribute, classList.add and append, so a recording stub pins the whole
// output contract (accessible name, slot math, zero floor, class hooks). The
// printed figure is the `kwh` the screen passes in `info` — never the point's
// own — so each call states it the way the screen does.
function svgStub(tag) {
  return {
    tag,
    attrs: new Map(),
    children: [],
    setAttribute(name, value) {
      this.attrs.set(name, String(value));
    },
    classList: {
      classes: new Set(),
      add(name) {
        this.classes.add(name);
      },
    },
    append(...kids) {
      this.children.push(...kids);
    },
  };
}

globalThis.document = { createElementNS: (_ns, tag) => svgStub(tag) };

const byClass = (bar, className) =>
  bar.children.find((kid) => kid.attrs.get('class') === className);

test('buildBar shapes and names a full-height priced bar', () => {
  const point = { id: '2026-04', label: 'Apr 2026', kwh: 12.34, isCurrent: false };
  const bar = buildBar(point, 3, 40, 20, {
    bucket: 'month',
    cost: '$1.23',
    kwh: 12.34,
    max: 12.34,
  });

  assert.equal(bar.attrs.get('class'), 'bar');
  assert.equal(bar.attrs.get('role'), 'button');
  assert.equal(bar.attrs.get('tabindex'), '-1');
  assert.equal(bar.attrs.get('data-index'), '3');
  assert.equal(bar.attrs.get('aria-label'), `Apr 2026: ${fmtK(12.34)} kWh, $1.23`);
  assert.ok(!bar.classList.classes.has('zero'));

  // Slot math: the hit area spans the whole slot, guide and fill share the
  // centered bar width, and a max-height fill spans the full plot.
  const hit = byClass(bar, 'bar-hit');
  assert.equal(hit.attrs.get('x'), '120');
  assert.equal(hit.attrs.get('width'), '40');
  assert.equal(hit.attrs.get('height'), '132');
  const guide = byClass(bar, 'bar-guide');
  assert.equal(guide.attrs.get('x'), '130');
  assert.equal(guide.attrs.get('width'), '20');
  assert.equal(guide.attrs.get('y'), '10');
  assert.equal(guide.attrs.get('height'), '108');
  const fill = byClass(bar, 'bar-fill');
  assert.equal(fill.attrs.get('x'), '130');
  assert.equal(fill.attrs.get('width'), '20');
  assert.equal(fill.attrs.get('y'), '12');
  assert.equal(fill.attrs.get('height'), '106');
  // Group children order: guide, hit, fill.
  assert.deepEqual(
    bar.children.map((kid) => kid.attrs.get('class')),
    ['bar-guide', 'bar-hit', 'bar-fill'],
  );
});

test('buildBar appends the partial-slot suffix to the current month and hour', () => {
  const month = buildBar(
    { id: '2026-10', label: 'Oct 2026', kwh: 3.2, isCurrent: true },
    0,
    40,
    20,
    { bucket: 'month', cost: null, kwh: 3.2, max: 9.9 },
  );
  assert.equal(month.attrs.get('aria-label'), `Oct 2026 (current month): ${fmtK(3.2)} kWh`);

  const hour = buildBar({ id: '05', kwh: 1.5, isCurrent: true }, 5, 40, 20, {
    bucket: 'hour',
    cost: null,
    kwh: 1.5,
    max: 9.9,
  });
  assert.equal(hour.attrs.get('aria-label'), `05:00–06:00 (this hour so far): ${fmtK(1.5)} kWh`);
});

test('buildBar floors a zero-kwh bar at the 2-unit minimum and marks it zero', () => {
  const bar = buildBar({ id: '2026-04', label: 'Apr 2026', kwh: 0, isCurrent: false }, 2, 40, 20, {
    bucket: 'month',
    cost: null,
    kwh: 0,
    max: 5,
  });

  assert.ok(bar.classList.classes.has('zero'));
  assert.equal(bar.attrs.get('aria-label'), `Apr 2026: ${fmtK(0)} kWh`);
  const fill = byClass(bar, 'bar-fill');
  assert.equal(fill.attrs.get('y'), '116');
  assert.equal(fill.attrs.get('height'), '2');
});

test('buildBar takes its figure from info, never from the point', () => {
  // A day whose document recorded 2.25 kWh while the sessions attributed 12.9
  // to it: the screen passes the figure it decided, and the accessible name,
  // the height and the zero class all follow that one value.
  const day = { id: '2026-11-24', label: 'Tue 24 Nov', kwh: 2.25, isCurrent: false };
  const bar = buildBar(day, 1, 40, 20, { bucket: 'day', cost: 'USD 1.45', kwh: 12.9, max: 17.8 });
  assert.equal(bar.attrs.get('aria-label'), 'Tue 24 Nov: 12.9 kWh, USD 1.45');
  assert.ok(!bar.classList.classes.has('zero'));
  // The height is the passed figure's share of the passed maximum: 12.9 of
  // 17.8 across the plot's 106 units, standing on the 118 base — where the
  // point's own 2.25 would have stood at a fraction of that.
  const fill = byClass(bar, 'bar-fill');
  assert.ok(Math.abs(Number(fill.attrs.get('height')) - (12.9 / 17.8) * 106) < 1e-9);
  assert.equal(Number(fill.attrs.get('y')) + Number(fill.attrs.get('height')), 118);

  // The passed figure is the whole contract. A passed zero is a zero bar
  // whatever the point recorded…
  const none = buildBar({ ...day, kwh: 2.25 }, 2, 40, 20, {
    bucket: 'day',
    cost: null,
    kwh: 0,
    max: 17.8,
  });
  assert.ok(none.classList.classes.has('zero'));
  assert.equal(none.attrs.get('aria-label'), 'Tue 24 Nov: 0.00 kWh');
  assert.equal(Number(byClass(none, 'bar-fill').attrs.get('height')), 2);
  // …and a recorded zero with attributed energy is a real bar.
  const attributed = buildBar({ ...day, kwh: 0 }, 3, 40, 20, {
    bucket: 'day',
    cost: 'USD 0.10',
    kwh: 0.89,
    max: 17.8,
  });
  assert.ok(!attributed.classList.classes.has('zero'));
  assert.equal(attributed.attrs.get('aria-label'), 'Tue 24 Nov: 0.89 kWh, USD 0.10');
  assert.equal(
    Number(byClass(attributed, 'bar-fill').attrs.get('height')),
    Math.max(2, (0.89 / 17.8) * 106),
  );
});
