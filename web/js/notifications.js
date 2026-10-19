// Pure copy for the notification opt-in card. No DOM, no Firebase — covered by
// test/web.

// A deployment has a usable key only when the config carries a real value. The
// example template's "<public Web Push key>" placeholder counts as unset so a
// copied config shows the no-VAPID state instead of a token error.
export function vapidConfigured(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return Boolean(key) && !key.startsWith('<');
}

// The permission card has one visual state at a time. `supported` is null while
// the messaging SDK's isSupported() probe is in flight. The token phase only
// refines the granted state; permission is never requested from here.
export function notificationState({
  supported = null,
  permission = 'default',
  vapid = true,
  tokenPhase = 'idle',
} = {}) {
  if (supported === null) {
    return {
      kind: 'checking',
      title: 'Checking notifications…',
      detail: 'Working out what this browser supports.',
      action: null,
    };
  }
  if (!supported) {
    return {
      kind: 'unsupported',
      title: 'Notifications aren’t available',
      detail:
        'This browser can’t receive push notifications. On Android, install the app to your home screen and open it from there.',
      action: null,
    };
  }
  if (!vapid) {
    return {
      kind: 'no-vapid',
      title: 'Push isn’t configured',
      detail:
        'This deployment has no public Web Push key. Add vapidKey to web/firebase-config.js to enable notifications.',
      action: null,
    };
  }
  if (permission === 'denied') {
    return {
      kind: 'denied',
      title: 'Notifications are blocked',
      detail:
        'Allow notifications for this site in your browser settings (the lock or tune icon by the address), then reload the page.',
      action: null,
    };
  }
  if (permission === 'granted') {
    const detail =
      tokenPhase === 'saved'
        ? 'This device is registered. You’ll get charging alerts even when the app is closed.'
        : tokenPhase === 'failed'
          ? 'Enabled in this browser, but this device isn’t registered yet.'
          : 'Enabled in this browser. Registering this device…';
    return {
      kind: 'granted',
      title: 'Notifications are on',
      detail,
      action: tokenPhase === 'saved' || tokenPhase === 'registering' ? null : 'retry',
    };
  }
  return {
    kind: 'default',
    title: 'Get charging alerts',
    detail:
      'Enable notifications to hear when charging starts or stops, even when the app is closed.',
    action: 'enable',
  };
}
