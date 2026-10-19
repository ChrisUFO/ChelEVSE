import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PUSH_TITLE,
  DEFAULT_PUSH_URL,
  createPushDeduper,
  notificationFromPush,
  pushDedupeKeys,
  shouldShowSystemNotification,
  visibleClient,
} from '../../web/js/push.js';

test('notificationFromPush prefers the notification block', () => {
  const message = notificationFromPush({
    notification: { title: 'ChelEVSE', body: 'Charging started' },
    data: {
      title: 'ignored',
      body: 'ignored',
      url: 'https://evil.example/',
    },
    fcmOptions: { link: 'https://charge.example/#history' },
    fcmMessageId: 'msg-1',
  });
  assert.deepEqual(message, {
    title: 'ChelEVSE',
    body: 'Charging started',
    url: 'https://charge.example/#history',
    id: 'msg-1',
  });
});

test('notificationFromPush falls back to data fields', () => {
  const message = notificationFromPush({
    data: { title: 'Charger', body: 'Charging stopped', url: './#status' },
    messageId: 'msg-2',
  });
  assert.equal(message.title, 'Charger');
  assert.equal(message.body, 'Charging stopped');
  assert.equal(message.url, './#status');
  assert.equal(message.id, 'msg-2');
});

test('notificationFromPush defaults title and url, and keeps an empty body', () => {
  assert.deepEqual(notificationFromPush({}), {
    title: DEFAULT_PUSH_TITLE,
    body: '',
    url: DEFAULT_PUSH_URL,
    id: null,
  });
  assert.deepEqual(notificationFromPush(null), {
    title: DEFAULT_PUSH_TITLE,
    body: '',
    url: DEFAULT_PUSH_URL,
    id: null,
  });
});

test('notificationFromPush tolerates non-object and malformed payloads', () => {
  for (const payload of [undefined, null, 'Charging started', 42, true, [], ['x']]) {
    assert.deepEqual(notificationFromPush(payload), {
      title: DEFAULT_PUSH_TITLE,
      body: '',
      url: DEFAULT_PUSH_URL,
      id: null,
    });
  }
  const malformed = notificationFromPush({
    notification: 'Charging started',
    data: null,
    fcmOptions: ['x'],
    fcmMessageId: 7,
  });
  assert.equal(malformed.title, DEFAULT_PUSH_TITLE);
  assert.equal(malformed.body, '');
  assert.equal(malformed.url, DEFAULT_PUSH_URL);
  // Message ids are strings; a number is not one.
  assert.equal(malformed.id, null);
});

test('notificationFromPush ignores blank strings', () => {
  const message = notificationFromPush({
    notification: { title: '  ', body: '' },
    data: { title: 'Charger', body: 'Charging stopped' },
    fcmOptions: { link: '   ' },
    fcmMessageId: '   ',
    messageId: 'msg-3',
  });
  assert.equal(message.title, 'Charger');
  assert.equal(message.body, 'Charging stopped');
  assert.equal(message.url, DEFAULT_PUSH_URL);
  assert.equal(message.id, 'msg-3');
});

test('notificationFromPush reads the service worker message shape', () => {
  const message = notificationFromPush({
    type: 'chelevse-push',
    notification: { title: 'ChelEVSE', body: 'Charger offline', url: './#history' },
    id: 'fcm-9',
  });
  assert.equal(message.title, 'ChelEVSE');
  assert.equal(message.body, 'Charger offline');
  assert.equal(message.url, './#history');
  assert.equal(message.id, 'fcm-9');
});

test('visibleClient prefers a focused visible window', () => {
  const focused = { visibilityState: 'visible', focused: true };
  const visible = { visibilityState: 'visible', focused: false };
  const hidden = { visibilityState: 'hidden', focused: false };
  assert.equal(visibleClient([hidden, visible]), visible);
  assert.equal(visibleClient([hidden, visible, focused]), focused);
  assert.equal(visibleClient([hidden]), null);
  assert.equal(visibleClient([]), null);
  assert.equal(visibleClient(null), null);
  assert.equal(visibleClient(undefined), null);
  assert.equal(visibleClient('visible'), null);
});

test('visibleClient skips malformed entries', () => {
  const visible = { visibilityState: 'visible' };
  const clients = [null, undefined, 'visible', 7, {}, { visibilityState: 'prerender' }, visible];
  assert.equal(visibleClient(clients), visible);
  // A visible client without `focused` is still visible.
  assert.equal(shouldShowSystemNotification([visible]), false);
});

test('shouldShowSystemNotification is the inverse of a visible client', () => {
  assert.equal(shouldShowSystemNotification([]), true);
  assert.equal(shouldShowSystemNotification([{ visibilityState: 'hidden' }]), true);
  assert.equal(shouldShowSystemNotification([{ visibilityState: 'visible' }]), false);
});

test('pushDedupeKeys uses the id and the rendered text', () => {
  assert.deepEqual(pushDedupeKeys({ id: 'a', title: 'ChelEVSE', body: 'Charging stopped' }), [
    'id:a',
    'text:ChelEVSE\u0000Charging stopped',
  ]);
  assert.deepEqual(pushDedupeKeys({ title: 'ChelEVSE' }), ['text:ChelEVSE\u0000']);
  // Malformed input still yields a stable key instead of throwing.
  assert.deepEqual(pushDedupeKeys(null), ['text:ChelEVSE\u0000']);
});

test('createPushDeduper drops repeats inside the window', () => {
  let now = 1000;
  const accept = createPushDeduper({ windowMs: 5000, now: () => now });
  const message = { id: 'm1', title: 'ChelEVSE', body: 'Charging started' };
  assert.equal(accept(message), true);
  assert.equal(accept({ ...message }), false);
  now += 4999;
  assert.equal(accept({ ...message }), false);
  now += 1;
  assert.equal(accept({ ...message }), true);
});

test('createPushDeduper dedupes by id across differing text', () => {
  const accept = createPushDeduper({ now: () => 0 });
  assert.equal(accept({ id: 'm1', title: 'ChelEVSE', body: 'Charging started' }), true);
  assert.equal(accept({ id: 'm1', title: 'ChelEVSE', body: 'Charging started.' }), false);
  assert.equal(accept({ id: 'm2', title: 'ChelEVSE', body: 'Charging stopped' }), true);
});

test('createPushDeduper dedupes the SW and SDK paths for one event', () => {
  let now = 0;
  const accept = createPushDeduper({ now: () => now });
  // The service worker forwards the message; the SDK's defensive onMessage sees
  // the same event with no (or a different) message id.
  const viaWorker = notificationFromPush({
    notification: { title: 'ChelEVSE', body: 'Charging stopped' },
    fcmMessageId: 'fcm-1',
  });
  const viaSdk = notificationFromPush({
    notification: { title: 'ChelEVSE', body: 'Charging stopped' },
  });
  assert.equal(accept(viaWorker), true);
  now += 20;
  assert.equal(accept(viaSdk), false);
  // A genuinely different event still shows.
  assert.equal(
    accept(notificationFromPush({ notification: { title: 'ChelEVSE', body: 'Charger offline' } })),
    true,
  );
});

test('createPushDeduper instances are independent', () => {
  const first = createPushDeduper({ now: () => 0 });
  const second = createPushDeduper({ now: () => 0 });
  const message = { title: 'ChelEVSE', body: 'Charging started' };
  assert.equal(first(message), true);
  assert.equal(first(message), false);
  assert.equal(second(message), true);
});
