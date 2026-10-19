// Pure helpers for push delivery. No DOM, no Firebase — covered by test/web.
//
// FCM sends a notification-only message from the bridge; the plain service
// worker (web/sw.js) receives it as a raw `push` event and either forwards it to
// a visible page or shows a system notification. Both paths reduce the payload
// with `notificationFromPush` so the title/body shown never differ.

export const DEFAULT_PUSH_TITLE = 'ChelEVSE';
export const DEFAULT_PUSH_URL = './';
// Two paths can report one event (the SW's message and the SDK's defensive
// onMessage); the same title/body or message id inside this window is a dupe.
export const PUSH_DEDUPE_MS = 5000;

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Reduce a raw FCM payload (or the SW's `chelevse-push` message, which nests the
// same shape) to what the UI needs. Notification fields win, `data` is the
// fallback, and every field has a safe default, so malformed or missing
// payloads still render something harmless.
export function notificationFromPush(payload) {
  const root = record(payload);
  const notification = record(root.notification);
  const data = record(root.data);
  const options = record(root.fcmOptions);
  return {
    title: text(notification.title) ?? text(data.title) ?? DEFAULT_PUSH_TITLE,
    body: text(notification.body) ?? text(data.body) ?? '',
    url: text(options.link) ?? text(notification.url) ?? text(data.url) ?? DEFAULT_PUSH_URL,
    id: text(root.fcmMessageId) ?? text(root.messageId) ?? text(root.id) ?? null,
  };
}

// The page a foreground toast should reach: a visible window client, preferring
// the focused one. Non-array input, nulls, and non-window entries are ignored.
export function visibleClient(clients) {
  if (!Array.isArray(clients)) return null;
  const visible = clients.filter(
    (client) => client && typeof client === 'object' && client.visibilityState === 'visible',
  );
  return visible.find((client) => client.focused === true) ?? visible[0] ?? null;
}

// No visible page means the system notification is the only way the user sees
// the event. A visible page shows the in-app toast instead.
export function shouldShowSystemNotification(clients) {
  return visibleClient(clients) === null;
}

// Every key that identifies one delivery. The text key is what dedupes the two
// foreground paths when the SDK payload has no message id (or a different one);
// the id key also catches repeats that carry an id but no text.
export function pushDedupeKeys(notification) {
  const value = record(notification);
  const title = text(value.title) ?? DEFAULT_PUSH_TITLE;
  const body = text(value.body) ?? '';
  const keys = [`text:${title}\u0000${body}`];
  if (text(value.id)) keys.unshift(`id:${value.id}`);
  return keys;
}

// Returns `accept(notification) -> boolean`: false when any identifying key was
// seen inside the window. Expiry is pruned on every call, so the map stays
// small without a timer.
export function createPushDeduper({ windowMs = PUSH_DEDUPE_MS, now = Date.now } = {}) {
  const seen = new Map();
  return function accept(notification) {
    const at = now();
    for (const [key, time] of seen) {
      if (at - time >= windowMs) seen.delete(key);
    }
    const keys = pushDedupeKeys(notification);
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.set(key, at);
    return true;
  };
}
