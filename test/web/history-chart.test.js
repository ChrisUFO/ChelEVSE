import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBar } from '../../web/js/screens/history-chart.js';
import { fmtK } from '../../web/js/format.js';

// buildBar is pure geometry over an injected SVG namespace: it only needs
// setAttribute, classList.add and append, so a recording stub pins the whole
// output contract (accessible name, slot math, zero floor, class hooks).
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
  const bar = buildBar(point, 3, 40, 20, { bucket: 'month', cost: '$1.23', max: 12.34 });

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
    { bucket: 'month', cost: null, max: 9.9 },
  );
  assert.equal(month.attrs.get('aria-label'), `Oct 2026 (current month): ${fmtK(3.2)} kWh`);

  const hour = buildBar({ id: '05', kwh: 1.5, isCurrent: true }, 5, 40, 20, {
    bucket: 'hour',
    cost: null,
    max: 9.9,
  });
  assert.equal(hour.attrs.get('aria-label'), `05:00–06:00 (this hour so far): ${fmtK(1.5)} kWh`);
});

test('buildBar floors a zero-kwh bar at the 2-unit minimum and marks it zero', () => {
  const bar = buildBar({ id: '2026-04', label: 'Apr 2026', kwh: 0, isCurrent: false }, 2, 40, 20, {
    bucket: 'month',
    cost: null,
    max: 5,
  });

  assert.ok(bar.classList.classes.has('zero'));
  assert.equal(bar.attrs.get('aria-label'), `Apr 2026: ${fmtK(0)} kWh`);
  const fill = byClass(bar, 'bar-fill');
  assert.equal(fill.attrs.get('y'), '116');
  assert.equal(fill.attrs.get('height'), '2');
});
