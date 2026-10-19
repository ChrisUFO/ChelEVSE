import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RAPI_MAX, commandMillis, rapiErrorMessage, validateRapi } from '../../web/js/advanced.js';

test('validateRapi accepts the documented RAPI shape', () => {
  for (const command of ['$OK', '$FS 20', '$1', '$AB', '$FS  20', '$OK ']) {
    const result = validateRapi(command);
    assert.equal(result.valid, true, command);
    assert.equal(result.error, '');
    assert.equal(result.command, command);
  }
  // Exactly 32 characters is the boundary the rules and the bridge accept.
  const max = '$FS ' + 'A'.repeat(28);
  assert.equal(max.length, RAPI_MAX);
  assert.equal(validateRapi(max).valid, true);
});

test('validateRapi rejects everything else before it reaches Firestore', () => {
  for (const command of [
    '',
    null,
    undefined,
    42,
    '$',
    '$ABC',
    '$$',
    'x$',
    ' $OK',
    '$OK\n',
    '$OK\r',
    '$OK\t',
    '$FS 20\n',
    '$' + 'A'.repeat(32),
    '$OK ' + 'A'.repeat(29),
  ]) {
    assert.equal(validateRapi(command).valid, false, JSON.stringify(command));
  }
  assert.match(validateRapi('').error, /Enter/);
  assert.match(validateRapi('$' + 'A'.repeat(32)).error, /32/);
  assert.match(validateRapi('$ABC').error, /\$/);
});

test('rapiErrorMessage explains a building index and offline reads', () => {
  assert.match(rapiErrorMessage({ code: 'failed-precondition' }), /index/);
  assert.match(rapiErrorMessage({ code: 'failed-precondition' }), /built/);
  assert.match(rapiErrorMessage({ code: 'unavailable' }), /connection/);
  assert.match(rapiErrorMessage({ code: 'something-else' }), /Reload/);
  assert.match(rapiErrorMessage(null), /Reload/);
});

test('commandMillis reads Firestore timestamps, numbers, and seconds', () => {
  assert.equal(commandMillis({ toMillis: () => 1234 }), 1234);
  assert.equal(commandMillis(4321), 4321);
  assert.equal(commandMillis({ seconds: 12 }), 12000);
  assert.equal(commandMillis(null), null);
  assert.equal(commandMillis({}), null);
});

test('the commands (type, created_at) composite index is declared', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../firestore.indexes.json', import.meta.url), 'utf8'),
  );
  const index = config.indexes.find(
    (entry) => entry.collectionGroup === 'commands' && entry.queryScope === 'COLLECTION',
  );
  assert.ok(index, 'commands composite index');
  assert.deepEqual(index.fields, [
    { fieldPath: 'type', order: 'ASCENDING' },
    { fieldPath: 'created_at', order: 'DESCENDING' },
  ]);
});
