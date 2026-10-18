import { test } from 'node:test';
import assert from 'node:assert/strict';

import { routeFor } from '../../web/js/ui.js';

test('routeFor accepts known hashes and canonicalises the rest', () => {
  assert.equal(routeFor('#status'), 'status');
  assert.equal(routeFor('#History'), 'history');
  assert.equal(routeFor('#schedule'), 'schedule');
  assert.equal(routeFor(''), 'status');
  assert.equal(routeFor('#'), 'status');
  assert.equal(routeFor('#nope'), 'status');
});

test('routeFor ignores inherited object keys', () => {
  for (const hash of ['#constructor', '#__proto__', '#toString', '#valueOf']) {
    assert.equal(routeFor(hash), 'status', hash);
  }
});
