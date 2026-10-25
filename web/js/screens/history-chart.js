// The History chart's SVG construction: geometry constants, the svg element
// builder and the bar builder. A view helper imported only by the History
// screen — the screen owns the series, the selection and the per-bar cost
// labels, and passes them in per bar.

import { CHART_VIEW_W, hourRange } from '../history.js';
import { fmtK } from '../format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = CHART_VIEW_W;
const VIEW_H = 132;
const TOP = 10;
const BASE = 118;
const PLOT_H = BASE - TOP;
// A bar keeps this share of its slot. 0.56 reproduces the 5.6-unit bar of the
// original 30-slot chart at VIEW_W / 30 and fills the viewBox for 7, 12 or 24
// bars.
const BAR_RATIO = 0.56;
// A partial current slot says so in its accessible name: a month holds only its
// recorded days, and an hour holds only what has been recorded so far.
const PARTIAL_SUFFIX = { month: ' (current month)', hour: ' (this hour so far)' };

export { BASE, BAR_RATIO, VIEW_W };

export function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

// One bar group: the transparent hit area, the full-height guide and the fill
// rect. `info` carries what the screen resolves per bar, so the geometry stays
// independent of the screen's state:
//   bucket  the period's bucket kind (names the partial current slot)
//   cost    the bar's cost label, or null to omit from the accessible name
//   max     the series maximum every bar height shares
export function buildBar(point, index, slot, barW, { bucket, cost, max }) {
  const suffix = point.isCurrent ? PARTIAL_SUFFIX[bucket] || '' : '';
  const label = bucket === 'hour' ? hourRange(point.id) : point.label;
  const group = svgEl('g', {
    class: 'bar',
    role: 'button',
    tabindex: '-1',
    'data-index': String(index),
    'aria-label': `${label}${suffix}: ${fmtK(point.kwh)} kWh${cost ? `, ${cost}` : ''}`,
  });
  const hit = svgEl('rect', {
    class: 'bar-hit',
    x: String(index * slot),
    y: '0',
    width: String(slot),
    height: String(VIEW_H),
    fill: 'transparent',
  });
  const guide = svgEl('rect', {
    class: 'bar-guide',
    x: String(index * slot + (slot - barW) / 2),
    y: String(TOP),
    width: String(barW),
    height: String(PLOT_H),
    rx: '2',
  });
  const height = point.kwh > 0 && max > 0 ? Math.max(2, (point.kwh / max) * (PLOT_H - 2)) : 2;
  const fill = svgEl('rect', {
    class: 'bar-fill',
    x: String(index * slot + (slot - barW) / 2),
    y: String(BASE - height),
    width: String(barW),
    height: String(height),
    rx: '1.2',
  });
  group.append(guide, hit, fill);
  if (point.kwh <= 0) group.classList.add('zero');
  return group;
}
