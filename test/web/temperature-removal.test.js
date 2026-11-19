import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// S2 #159 removed the Temperature stat end-to-end: no tile, no switch, no
// `show_temperature` plumbing. The behavior tests for the old preference are
// gone with the feature; these source pins keep it deleted. (The bridge still
// parses temp1–temp3 for the `thermal.high_temp` health gate — that is the pi
// side and never reaches the web.)

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the temperature tile is gone from the status screen markup', () => {
  const html = read('../../web/index.html');
  assert.equal(/id="fig-temp/.test(html), false, 'no fig-temp* element ids');
  for (const token of ['temp-sensors', 'temp-sensor', 'temp-idx', 'fig-wide']) {
    assert.equal(html.includes(token), false, token);
  }
});

test('the show-temperature switch is gone from the settings markup', () => {
  const html = read('../../web/index.html');
  assert.equal(html.includes('setting-show-temperature'), false);
  assert.equal(html.includes('Show temperature'), false);
});

test('no show_temperature plumbing remains in the settings and status sources', () => {
  const sources = [
    read('../../web/js/settings/state.js'),
    read('../../web/js/settings/validate.js'),
    read('../../web/js/screens/settings.js'),
    read('../../web/js/screens/status.js'),
  ];
  for (const source of sources) {
    assert.equal(source.includes('show_temperature'), false, 'show_temperature');
    assert.equal(source.includes('showTemperature'), false, 'showTemperature');
  }
});

test('the temperature styles are gone from the stylesheet', () => {
  const css = read('../../web/styles.css');
  for (const token of ['.temp-sensors', '.temp-sensor', '.temp-idx', 'fig-wide']) {
    assert.equal(css.includes(token), false, token);
  }
});
