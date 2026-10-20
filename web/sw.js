// ChelEVSE service worker — cache-first for the local app shell only.
// Never caches gstatic/firebase requests: cross-origin and non-GET are passed through.
// Bump CACHE version when any shell file changes.
//
// Push delivery: this worker intentionally has no Firebase SDK. FCM delivers a
// notification-only message as a standard `push` event carrying the raw payload,
// so the handlers below are the whole delivery path — no SDK import, no
// messaging-specific worker. A visible page gets a `chelevse-push` message and
// shows the in-app toast itself; otherwise the system notification is shown.
// (The payload reduction mirrors js/push.js, which this classic worker cannot
// import; keep the two in step.)
//
// A rotated push subscription (`pushsubscriptionchange`) is handed to the open
// pages: only the page can re-acquire an FCM token and re-save it.
const CACHE = 'chelevse-v25';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './js/firebase.js',
  './js/auth.js',
  './js/store.js',
  './js/format.js',
  './js/push.js',
  './js/history.js',
  './js/schedule.js',
  './js/config.js',
  './js/settings.js',
  './js/notifications.js',
  './js/notification-session.js',
  './js/advanced.js',
  './js/write.js',
  './js/ui.js',
  './js/screens/status.js',
  './js/screens/history.js',
  './js/screens/schedule.js',
  './js/screens/config.js',
  './js/screens/settings.js',
  './js/screens/notifications.js',
  './js/screens/advanced.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; // gstatic/firebase: network only
  // firebase-config.js is served no-cache; never serve it from, or store it in,
  // the Cache API (which would ignore that header).
  const uncached = url.pathname.endsWith('/firebase-config.js');
  event.respondWith(
    (uncached ? Promise.resolve(null) : caches.match(event.request)).then(
      (hit) =>
        hit ||
        fetch(event.request)
          .then((res) => {
            if (res.ok && !uncached) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          })
          .catch(() =>
            event.request.mode === 'navigate'
              ? caches.match('./index.html')
              : new Response('Offline', { status: 503 }),
          ),
    ),
  );
});

// ---------- push delivery ----------

function payloadFrom(event) {
  const data = event.data;
  if (!data) return null;
  try {
    return data.json();
  } catch {
    // Not JSON: keep the text as the body rather than dropping the event.
  }
  try {
    const body = data.text();
    return body ? { data: { body } } : null;
  } catch {
    return null;
  }
}

function textValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pushMessage(payload) {
  const root = objectValue(payload);
  const notification = objectValue(root.notification);
  const data = objectValue(root.data);
  const options = objectValue(root.fcmOptions);
  return {
    title: textValue(notification.title) ?? textValue(data.title) ?? 'ChelEVSE',
    body: textValue(notification.body) ?? textValue(data.body) ?? '',
    // Mirrors notificationFromPush() in js/push.js (covered by test/web/push.test.js):
    // fcmOptions.link, then the notification block's url, then data.url.
    url: textValue(options.link) ?? textValue(notification.url) ?? textValue(data.url) ?? './',
    id: textValue(root.fcmMessageId) ?? textValue(root.messageId) ?? textValue(root.id) ?? null,
  };
}

function visibleClient(clients) {
  const visible = clients.filter((client) => client && client.visibilityState === 'visible');
  return visible.find((client) => client.focused === true) ?? visible[0] ?? null;
}

// Only same-origin targets are honoured; a payload cannot navigate the user off
// the app (the fallback is the app scope).
function appUrl(value) {
  try {
    const url = new URL(textValue(value) ?? './', self.registration.scope);
    return url.origin === self.location.origin ? url.href : self.registration.scope;
  } catch {
    return self.registration.scope;
  }
}

function sameAppClient(client) {
  try {
    return Boolean(client && client.url) && new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener('push', (event) => {
  const payload = payloadFrom(event);
  if (!payload) return;
  const message = pushMessage(payload);
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = visibleClient(clients);
      if (target) {
        // The open page announces the event itself (one toast, no OS
        // notification while the app is in front of the user). A client that
        // disappeared mid-match falls through to the system notification.
        try {
          target.postMessage({ type: 'chelevse-push', notification: message, id: message.id });
          return;
        } catch {
          // Discarded client: notify the platform instead of dropping the event.
        }
      }
      try {
        await self.registration.showNotification(message.title, {
          body: message.body,
          icon: './icon.svg',
          tag: 'chelevse-state',
          renotify: false,
          data: { url: message.url },
        });
      } catch {
        // Permission revoked between registration and this push: nothing to
        // show and nothing to retry.
      }
    })(),
  );
});

// The browser rotated or invalidated the push subscription (long idle, storage
// pressure, a VAPID key change). The token saved at registration no longer
// delivers, and only the page holds the FCM SDK, so ask every open window to
// re-acquire and re-save it. With no page open there is nothing to do here: the
// next app load re-runs the same registration.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        try {
          client.postMessage({ type: 'chelevse-resubscribe' });
        } catch {
          // A window discarded mid-match: the other windows, or the next load,
          // still recover the registration.
        }
      }
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = appUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const sameApp = clients.filter(sameAppClient);
      // Prefer the app window the user was last in; any other app window is the
      // fallback before opening a new one.
      const target = sameApp.find((client) => client.focused) ?? sameApp[0] ?? null;
      if (target) {
        try {
          await target.focus();
          return;
        } catch {
          // A window that closed between matchAll and focus: open a new one.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
