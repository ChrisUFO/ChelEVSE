// Small shared UI helpers: DOM lookup and the header network badge.

export const $ = (id) => document.getElementById(id);

export const setText = (el, text) => {
  if (el && el.textContent !== text) el.textContent = text;
};

let netOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
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

// Own-property check: inherited names (#constructor, #__proto__, #toString)
// must not be mistaken for routes, or every panel stays hidden.
export function routeFor(hash) {
  const raw = String(hash == null ? '' : hash)
    .replace(/^#/, '')
    .toLowerCase();
  return Object.hasOwn(ROUTES, raw) ? raw : 'status';
}

// Hash routing keeps refresh, back/forward, and the installed start_url on the
// same screen. Panels are hidden rather than removed so each screen keeps its
// control state; the document scroll position is saved per route and restored
// when that route is shown again (first visits start at the top).
export function initTabbar() {
  const tabs = [...document.querySelectorAll('.tab')];
  const tabbar = document.querySelector('.tabbar');
  const scrollByRoute = new Map();
  let currentRoute = null;
  // Per-route restore below owns the scroll position; browser scroll
  // restoration would otherwise fight it on reload and back/forward.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function apply(route) {
    const changed = currentRoute !== route;
    if (currentRoute && changed) {
      scrollByRoute.set(currentRoute, window.scrollY);
    }
    for (const name of ROUTE_NAMES) $(`panel-${name}`).hidden = name !== route;
    for (const tab of tabs) {
      const selected = tab.dataset.route === route;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    document.title = `${ROUTES[route]} — ChelEVSE`;
    currentRoute = route;
    // Re-clicking the selected tab must not jump back to an older offset.
    if (changed) window.scrollTo(0, scrollByRoute.get(route) ?? 0);
  }

  function render() {
    const route = routeFor(location.hash);
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
