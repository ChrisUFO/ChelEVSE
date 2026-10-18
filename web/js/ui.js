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

// ---------- five-tab shell ----------

const ROUTES = {
  status: 'Status',
  history: 'History',
  schedule: 'Schedule',
  config: 'Config',
  advanced: 'Advanced',
};
const ROUTE_NAMES = Object.keys(ROUTES);

function routeFromHash() {
  const raw = location.hash.replace(/^#/, '').toLowerCase();
  return ROUTES[raw] ? raw : 'status';
}

// Hash routing keeps refresh, back/forward, and the installed start_url on the
// same screen. Panels are hidden rather than removed so each screen keeps its
// state (the status slider, scroll position, later the schedule draft).
export function initTabbar() {
  const tabs = [...document.querySelectorAll('.tab')];
  const tabbar = document.querySelector('.tabbar');

  function apply(route) {
    for (const name of ROUTE_NAMES) $(`panel-${name}`).hidden = name !== route;
    for (const tab of tabs) {
      const selected = tab.dataset.route === route;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    document.title = `${ROUTES[route]} — ChelEVSE`;
  }

  function render() {
    const route = routeFromHash();
    if (location.hash !== `#${route}`) history.replaceState(null, '', `#${route}`);
    apply(route);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const route = tab.dataset.route;
      if (location.hash === `#${route}`) apply(route);
      else location.hash = route;
    });
  }

  // Manual activation: arrows/Home/End move focus only, Enter or Space selects.
  // Activating on focus would push a history entry for every arrow key.
  tabbar.addEventListener('keydown', (e) => {
    const index = tabs.indexOf(document.activeElement);
    if (index === -1) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    tabs[next].focus();
  });

  addEventListener('hashchange', render);
  render();
}
