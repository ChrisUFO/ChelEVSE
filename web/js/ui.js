// Small shared UI helpers: DOM lookup/building and the header network badge.

import { DAY_NAMES } from './schedule.js';

export const $ = (id) => document.getElementById(id);

export const setText = (node, text) => {
  if (node && node.textContent !== text) node.textContent = text;
};

// The smallest DOM builder every screen shares: a tag, an optional class and
// an optional text child.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Toggle one weekday in an editor's `days` array: the result keeps the array
// sorted and unique, the shared edit idiom of both day-chip editors.
export function toggleDay(days, day) {
  if (days.includes(day)) return days.filter((value) => value !== day);
  return [...days, day].sort((a, b) => a - b);
}

// The weekday-chip group both editors render: a role=group of DAY_NAMES
// buttons bound to a live `days` array. Options:
//   className   the group element's class
//   chipClass   each chip's class
//   describeId  the group's aria-describedby (its error line's id)
//   label       the group's aria-label, or null when a later paint owns it
//   getDays     live read of the bound days array
//   pressed     (day) => whether a chip starts aria-pressed, or null for never
//   chipLabel   (day) => a per-chip aria-label, or null for none
//   dataDay     whether each chip carries data-day (for repaint lookups)
//   onToggle    (day, nextDays, chip) — applies the edit and repaints
export function buildDayPicker({
  className,
  chipClass,
  describeId,
  label = null,
  getDays,
  pressed = null,
  chipLabel = null,
  dataDay = false,
  onToggle,
}) {
  const group = el('div', className);
  group.setAttribute('role', 'group');
  if (label) group.setAttribute('aria-label', label);
  group.setAttribute('aria-describedby', describeId);
  DAY_NAMES.forEach((name, day) => {
    const chip = el('button', chipClass, name);
    chip.type = 'button';
    if (dataDay) chip.dataset.day = String(day);
    if (pressed) chip.setAttribute('aria-pressed', String(pressed(day)));
    if (chipLabel) chip.setAttribute('aria-label', chipLabel(day));
    chip.addEventListener('click', () => {
      onToggle(day, toggleDay(getDays(), day), chip);
    });
    group.append(chip);
  });
  return group;
}

let netOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
let netCached = false;

function paintNet() {
  const mode = !netOnline ? 'offline' : netCached ? 'cached' : 'live';
  const badge = $('net');
  if (!badge) return;
  badge.dataset.net = mode;
  setText(badge, mode === 'live' ? 'Live' : mode === 'cached' ? 'Syncing…' : 'Offline');
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
//
// `confirmLeave(from, to)` lets a screen hold a route change for a
// confirmation: when the hook returns a promise, the change waits for it — a
// truthy resolution applies the pending route, anything else (a falsy
// resolution or a rejection) keeps the current route. Any other return (or
// no hook) navigates immediately, as before.
//
// A tab click asks before the hash moves, so a Stay answer touches no history
// entry at all. A hashchange the router did not make (back/forward, a typed
// URL) can only be held after the fact: Stay rewrites that entry back with
// replaceState. Rewriting a *pushed* entry instead of never pushing it would
// strand a dead Back press — adjacent entries with the same fragment fire
// popstate only, and this router listens to hashchange.
export function initTabbar({ onRoute, confirmLeave } = {}) {
  const tabs = [...document.querySelectorAll('.tab')];
  const tabbar = document.querySelector('.tabbar');
  const scrollByRoute = new Map();
  let currentRoute = null;
  // The route a confirmation dialog is deciding on. While it is set nothing
  // applies. A held traversal has already moved the hash (the dialog must
  // snap it back on stay); a held click has not moved it yet (the push
  // happens only if the answer is leave). Any further hash movement snaps
  // back to currentRoute — the route still on screen, whose leave the
  // dialog is deciding — until the dialog is answered. During a held
  // click that snap-back rewrites the external move's entry, stranding
  // one later Back-or-Forward press between identical fragments (the
  // direction follows the external move; the cost the router note above
  // names); accepted so the URL keeps naming currentRoute.
  let pendingLeave = null;
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
    // Route entry hook: screens use it to start/stop clocks and lazily load
    // one-shot data. Re-clicking the active tab is not a new entry.
    if (changed && onRoute) onRoute(route);
  }

  function restoreHash() {
    if (location.hash !== `#${currentRoute}`) history.replaceState(null, '', `#${currentRoute}`);
  }

  // The guard's question, shared by both entry points. Returns the promise to
  // wait for, or null when the change may apply immediately (no hook, a
  // non-promise return, or no route change to ask about).
  function askLeave(route) {
    if (!confirmLeave || currentRoute === null || currentRoute === route) return null;
    const decision = confirmLeave(currentRoute, route);
    return decision && typeof decision.then === 'function' ? decision : null;
  }

  // Hold `route` for the dialog's answer. `hashMoved` says whether the hash
  // already names `route` (a held traversal — the router did not make the
  // move and cannot undo it, because a hashchange does not report direction);
  // a held click's push is deferred to the leave answer instead.
  function guarded(route, decision, hashMoved) {
    pendingLeave = route;
    decision.then(
      (leave) => {
        if (pendingLeave !== route) return;
        pendingLeave = null;
        if (!leave) {
          // Stay. A held traversal snaps its entry back; a held click has
          // nothing to undo — no entry was pushed, so Back keeps working.
          if (hashMoved) restoreHash();
          return;
        }
        apply(route);
        if (hashMoved) {
          // The hash may have drifted while the dialog was open (another move
          // was snapped back), so pin it to the route that now applies.
          history.replaceState(null, '', `#${route}`);
        } else {
          // The held click's own push, now that the answer is leave. The
          // hashchange it fires re-renders a no-op: the route already
          // applies, so the guard is not asked again.
          location.hash = route;
        }
        // A direct click leaves focus on the newly selected tab; the dialog
        // had it instead, so put focus where the click would have left it.
        const activeTab = document.querySelector('.tab[aria-selected="true"]');
        if (activeTab) activeTab.focus({ preventScroll: true });
      },
      () => {
        if (pendingLeave !== route) return;
        pendingLeave = null;
        if (hashMoved) restoreHash();
      },
    );
  }

  function render() {
    const route = routeFor(location.hash);
    if (pendingLeave !== null) {
      // An open dialog owns the pending navigation; nothing else moves.
      // A held click moved nothing itself — but a hashchange only fires
      // because the hash moved, so whatever landed here was an external
      // move (back/forward, a typed URL), and its entry is snapped back
      // to currentRoute — the route still on screen, whose leave the
      // dialog is deciding (one dead-press cost, noted at pendingLeave
      // above).
      restoreHash();
      return;
    }
    if (location.hash !== `#${route}`) history.replaceState(null, '', `#${route}`);
    const decision = askLeave(route);
    if (decision) {
      guarded(route, decision, true);
      return;
    }
    apply(route);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      // An open confirmation dialog owns the pending navigation, whether the
      // hash moved (a held traversal) or not (a held click): a re-click must
      // not shortcut past the unanswered dialog.
      if (pendingLeave !== null) return;
      const route = tab.dataset.route;
      if (location.hash === `#${route}`) apply(route);
      else {
        // Ask before pushing. Pushing first and rewriting the entry on Stay
        // would leave two adjacent entries with the current route's fragment
        // — the next Back press fires popstate only, and appears dead.
        const decision = askLeave(route);
        if (decision) guarded(route, decision, false);
        else location.hash = route;
      }
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
