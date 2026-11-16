import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GATE_INITIAL,
  RAPI_MAX,
  commandMillis,
  gateTransition,
  rapiErrorMessage,
  rapiLogSignature,
  rapiTickLabels,
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

test('rapiErrorMessage explains all three branches without a reload', () => {
  const index = rapiErrorMessage({ code: 'failed-precondition' });
  assert.match(index, /index/);
  assert.match(index, /building/);
  assert.match(index, /Try again/);
  assert.doesNotMatch(index, /reload/i);

  const offline = rapiErrorMessage({ code: 'unavailable' });
  assert.match(offline, /connection/);
  assert.match(offline, /try again/);

  // Unknown codes and a missing error get the plain failure line; recovery is
  // the Retry control beside it, never a page reload.
  for (const message of [rapiErrorMessage({ code: 'something-else' }), rapiErrorMessage(null)]) {
    assert.equal(message, 'Couldn’t load recent commands.');
    assert.doesNotMatch(message, /reload/i);
  }
});

test('commandMillis reads Firestore timestamps, numbers, and seconds', () => {
  assert.equal(commandMillis({ toMillis: () => 1234 }), 1234);
  assert.equal(commandMillis(4321), 4321);
  assert.equal(commandMillis({ seconds: 12 }), 12000);
  assert.equal(commandMillis(null), null);
  assert.equal(commandMillis({}), null);
});

test('a ticker tick cannot detach the focused or expanded command row', () => {
  // A fixed timestamp, not a live clock: commandMillis feeds raw millis into
  // the signature, so a 1 ms tick between the two reads below would flip it.
  const createdAt = 1759000000000;
  const created = { toMillis: () => createdAt };
  const commands = [
    { id: 'a', command: '$FS 16', status: 'acked', created_at: created, result: 'OK' },
    { id: 'b', command: '$FS 20', status: 'pending', created_at: created },
  ];

  // A tick is time, not data: the rendered signature is unchanged, so the screen
  // keeps the existing nodes instead of rebuilding the list.
  const signature = rapiLogSignature(commands);
  assert.equal(rapiLogSignature(commands.map((command) => ({ ...command }))), signature);

  // The only thing a tick produces is the elapsed labels for the rows already on
  // screen; no row identity or content is emitted, so no node is replaced and
  // the focused/expanded row, its selection and the scroll position survive.
  const now = createdAt + 65000;
  assert.deepEqual(rapiTickLabels(commands, commands.length, now), ['1 min ago', '1 min ago']);

  // A changed row (status, command, result, timestamp, or a new document) needs a
  // rebuild, whether or not the row count stays the same.
  assert.notEqual(rapiLogSignature([{ ...commands[0], status: 'failed' }, commands[1]]), signature);
  assert.notEqual(rapiLogSignature([{ ...commands[0], result: 'ERR' }, commands[1]]), signature);
  assert.notEqual(rapiLogSignature([commands[0], { ...commands[1], id: 'c' }]), signature);
  // The ticker refuses to label a list that no longer has one row per command.
  assert.equal(rapiTickLabels(commands, commands.length + 1, now), null);
  assert.equal(rapiTickLabels(commands, commands.length - 1, now), null);
  assert.equal(rapiTickLabels([], 0, now), null);
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
  // A visit reset keeps the in-flight write busy: re-entering during a send
  // must not clear "Sending…" or accept another command.
  for (const type of ['enter', 'leave']) {
    const step = gateTransition(sending.state, { type });
    assert.equal(step.state.sending, true, type);
    assert.equal(step.state.open, false, type);
    assert.equal(
      gateTransition(step.state, { type: 'submit', command: '$OK' }).action,
      'idle',
      type,
    );
  }
  // Confirm without an open gate never sends.
  assert.equal(gateTransition(GATE_INITIAL, { type: 'confirm' }).action, 'idle');
});

test('the index error points at Try again, not a page reload', () => {
  const message = rapiErrorMessage({ code: 'failed-precondition' });
  assert.match(message, /index/);
  assert.match(message, /Try again/);
  assert.doesNotMatch(message, /reload/i);
});

// ---------- the RAPI log's failure surface ----------

// The same module-mock-free DOM stub the other screen tests use: one stub per
// id, lookups deferred to render time, then a plain import of the real screen
// module (no jsdom, no module mocks).
function stubElement(tag = '') {
  return {
    tag,
    className: '',
    textContent: '',
    hidden: false,
    id: '',
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

const elements = new Map();
const element = (id) => {
  let node = elements.get(id);
  if (!node) {
    node = stubElement();
    node.id = id;
    elements.set(id, node);
  }
  return node;
};

globalThis.document = {
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
};

const { showRapiCommands, showRapiError } = await import('../../web/js/screens/advanced.js');

test('a failed log read shows its copy beside a Retry, and a snapshot clears both', () => {
  showRapiError({ code: 'unavailable' });
  const state = element('rapi-log-state');
  assert.equal(state.hidden, false);
  assert.equal(state.className, 'section-state err');
  assert.equal(state.textContent, rapiErrorMessage({ code: 'unavailable' }));
  assert.equal(element('rapi-log-retry').hidden, false);

  // The snapshot that lands owns the recovery, and an empty list is still a
  // working read: the control goes with the failure.
  showRapiCommands([]);
  assert.equal(element('rapi-log-retry').hidden, true);
  assert.equal(state.className, 'section-state');
  assert.equal(state.textContent, 'No commands sent yet. Recent RAPI commands will appear here.');
});

test('index.html makes the log line a polite live region above its Retry', () => {
  // The stub answers any id on demand, so the markup is pinned from source (the
  // status-error/settings-screen convention). renderLog writes the failure copy
  // into #rapi-log-state with setText: without a live region a screen-reader
  // user gets nothing, while the other three screens all announce.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const tag = /<p\b[^>]*id="rapi-log-state"[^>]*>/.exec(source);
  assert.ok(tag, 'web/index.html ships #rapi-log-state');
  // Polite, not alert: the same node is the `Loading recent commands…` line, so
  // an alert would interrupt for a line that is not an error.
  assert.match(tag[0], /role="status"/);
  assert.match(tag[0], /aria-live="polite"/);

  const at = {
    state: source.indexOf('id="rapi-log-state"'),
    retry: source.indexOf('id="rapi-log-retry"'),
    list: source.indexOf('id="rapi-log"'),
  };
  for (const [marker, position] of Object.entries(at)) {
    assert.notEqual(position, -1, `${marker} is missing from web/index.html`);
  }
  assert.ok(at.state < at.retry && at.retry < at.list, 'the Retry sits under the log line');
});
