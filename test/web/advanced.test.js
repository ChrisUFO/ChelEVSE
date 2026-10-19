import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GATE_INITIAL,
  RAPI_MAX,
  commandMillis,
  gateTransition,
  rapiErrorMessage,
  validateRapi,
} from '../../web/js/advanced.js';

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

test('the gate opens before a write and only confirm can send', () => {
  // First send of a visit: no write, gate shows the exact command.
  const opened = gateTransition(GATE_INITIAL, { type: 'submit', command: '$FS 16' });
  assert.equal(opened.action, 'gate');
  assert.equal(opened.state.open, true);
  assert.equal(opened.state.command, '$FS 16');
  assert.equal(opened.state.armed, false);
  // The reducer never emits `send` from the submit that opened the gate: a
  // second submit while it is open only re-focuses confirmation.
  const again = gateTransition(opened.state, { type: 'submit', command: '$FS 32' });
  assert.equal(again.action, 'confirm');
  assert.equal(again.state.command, '$FS 16');

  // Confirming sends exactly the previewed command and arms the rest of the
  // visit.
  const confirmed = gateTransition(opened.state, { type: 'confirm' });
  assert.equal(confirmed.action, 'send');
  assert.equal(confirmed.command, '$FS 16');
  assert.equal(confirmed.state.open, false);
  assert.equal(confirmed.state.armed, true);

  // Later commands in the same visit skip the gate.
  const next = gateTransition(confirmed.state, { type: 'submit', command: '$FS 32' });
  assert.equal(next.action, 'send');
  assert.equal(next.command, '$FS 32');
});

test('the gate re-arms on every visit and cancel/edit dismiss it', () => {
  const opened = gateTransition(GATE_INITIAL, { type: 'submit', command: '$FS 16' });
  const confirmed = gateTransition(opened.state, { type: 'confirm' });

  // Entering and leaving the tab both start a fresh visit: armed again.
  for (const type of ['enter', 'leave']) {
    const rearmed = gateTransition(confirmed.state, { type });
    assert.deepEqual(rearmed.state, GATE_INITIAL, type);
    assert.equal(
      gateTransition(rearmed.state, { type: 'submit', command: '$FS 16' }).action,
      'gate',
      type,
    );
  }

  // Cancel drops the preview without a send; a confirmed visit stays confirmed.
  const cancelled = gateTransition(confirmed.state, { type: 'cancel' });
  assert.equal(cancelled.action, 'idle');
  assert.equal(cancelled.state.open, false);
  assert.equal(cancelled.state.command, '');
  assert.equal(cancelled.state.armed, true);
  assert.equal(gateTransition(opened.state, { type: 'cancel' }).action, 'idle');

  // Editing the command invalidates the preview.
  const edited = gateTransition(opened.state, { type: 'edit' });
  assert.equal(edited.state.open, false);
  assert.equal(edited.state.command, '');
  assert.equal(edited.action, 'idle');

  // A send in flight refuses further submits and confirmations.
  const sending = gateTransition(opened.state, { type: 'sending', value: true });
  assert.equal(gateTransition(sending.state, { type: 'submit', command: '$OK' }).action, 'idle');
  assert.equal(gateTransition(sending.state, { type: 'confirm' }).action, 'idle');
  // Confirm without an open gate never sends.
  assert.equal(gateTransition(GATE_INITIAL, { type: 'confirm' }).action, 'idle');
});

test('the index error tells the operator a reload is required', () => {
  const message = rapiErrorMessage({ code: 'failed-precondition' });
  assert.match(message, /index/);
  assert.match(message, /reload/i);
});
