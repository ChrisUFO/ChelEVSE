// Small shared UI helpers: DOM lookup and the header network badge.

export const $ = (id) => document.getElementById(id);

export const setText = (el, text) => {
  if (el && el.textContent !== text) el.textContent = text;
};

let netOnline = navigator.onLine;
let netCached = false;

function paintNet() {
  const mode = !netOnline ? 'offline' : netCached ? 'cached' : 'live';
  const el = $('net');
  if (!el) return;
  el.dataset.net = mode;
  setText(el, mode === 'live' ? 'Live' : mode === 'cached' ? 'Cached' : 'Offline');
}

export function setCached(cached) {
  netCached = Boolean(cached);
  paintNet();
}

export function initNetwork() {
  addEventListener('online', () => {
    netOnline = true;
    paintNet();
  });
  addEventListener('offline', () => {
    netOnline = false;
    paintNet();
  });
  paintNet();
}
