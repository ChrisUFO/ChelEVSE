import { test } from 'node:test';
import assert from 'node:assert/strict';

import { notificationState, vapidConfigured } from '../../web/js/notifications.js';

test('notificationState covers every permission state without asking', () => {
  assert.equal(notificationState({ supported: null }).kind, 'checking');
  assert.equal(notificationState({ supported: false }).kind, 'unsupported');
  assert.equal(notificationState({ supported: true, vapid: false }).kind, 'no-vapid');
  assert.equal(notificationState({ supported: true, permission: 'denied' }).kind, 'denied');
  const blocked = notificationState({ supported: true, permission: 'denied' });
  assert.match(blocked.detail, /browser settings/);
  assert.equal(blocked.action, null);

  const granted = notificationState({
    supported: true,
    permission: 'granted',
    tokenPhase: 'saved',
  });
  assert.equal(granted.kind, 'granted');
  assert.match(granted.detail, /registered/);
  assert.equal(granted.action, null);
  // A granted permission whose token save failed offers a retry.
  assert.equal(
    notificationState({ supported: true, permission: 'granted', tokenPhase: 'failed' }).action,
    'retry',
  );
  const initial = notificationState({ supported: true, permission: 'default' });
  assert.equal(initial.kind, 'default');
  assert.equal(initial.action, 'enable');
  // Unsupported outranks a blocked permission: there is nothing to unblock.
  assert.equal(notificationState({ supported: false, permission: 'denied' }).kind, 'unsupported');
});

test('vapidConfigured ignores the template placeholder and empty values', () => {
  assert.equal(vapidConfigured('BK-real-public-key'), true);
  assert.equal(vapidConfigured('  BK-real-public-key  '), true);
  assert.equal(vapidConfigured('<public Web Push key>'), false);
  assert.equal(vapidConfigured('  <public Web Push key>  '), false);
  assert.equal(vapidConfigured(''), false);
  assert.equal(vapidConfigured(null), false);
  assert.equal(vapidConfigured(undefined), false);
});
