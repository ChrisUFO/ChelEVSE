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

// The one retry-focus policy (#164). A Retry leaves with the failure it belonged
// to, and the control that had focus goes with it: the browser then drops focus
// to <body> — the top of the document, with nothing said about what just
// happened — or, when it keeps the reference, leaves it on a node that is no
// longer in the document. Both are "focus fell away", so the panel the snapshot
// refilled takes it instead. Focus that still sits on a live element is where
// the owner put it and is never stolen.
//
// This is the only implementation: every retry-carrying screen calls it (Status,
// Prices, Schedule, Charger, Advanced, and the notification card's Enable and
// Retry), so the policy cannot drift per screen.
export function focusAfterRetry(retry, panelId) {
  if (!retry || !retry.hidden) return;
  if (!focusFellAway()) return;
  const panel = $(panelId);
  if (panel) panel.focus({ preventScroll: true });
}

// The "focus fell away" test itself, shared by every caller that has to decide
// whether focus is still where the owner put it: nowhere, on <body>/<html>, or
// on a node the document no longer contains.
export function focusFellAway(active = document.activeElement) {
  return (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    // A node the document no longer contains is not somewhere the owner chose to
    // be. A DOM without `contains` cannot prove detachment, so there the
    // narrower <body>/<html> rule stands.
    (typeof document.contains === 'function' && !document.contains(active))
  );
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

// ---------- four-tab shell ----------

// Every route the hash can name, with its document title. `config` is the
// Settings list; the four routes after it are the screens its cards open, each
// one a view inside the Settings tabpanel rather than a tab of its own (#228).
const ROUTES = {
  status: 'Status',
  history: 'History',
  config: 'Settings',
  schedule: 'Charge schedule',
  prices: 'Prices and charger address',
  notifications: 'Notifications',
  charger: 'Charger',
  advanced: 'Advanced',
};
const ROUTE_NAMES = Object.keys(ROUTES);

// The routes shown inside the Settings tabpanel. Every other route owns a tab.
const SETTINGS_SCREENS = ['schedule', 'prices', 'notifications', 'charger'];

// How long a screen a card opened takes no pointer input. A tap that lands
// twice — a double tap, a jittery press — opens the screen under the finger,
// and the second tap lands on whatever control that screen puts in the same
// place: "Enable notifications", which asks for a browser permission (a
// dismiss of which counts toward the browser's auto-block), or the schedule's
// enable switch, which turns the stray tap into an unsaved draft. No spacing
// of the screen can keep its first control clear of the card: a screen
// re-opens at its own saved scroll offset, state lines wrap, and the entry
// animation itself has everything 10 px lower while the second tap arrives.
// So the opened screen takes no pointer input until it has finished arriving
// — about as long as its blocks take to rise in (0.4 s, staggered by 55 ms
// each), and the window the Dismiss guard holds against the same gesture
// (#205). Pointer only: the mark is the stylesheet's cue (`pointer-events:
// none`), which no key press or assistive activation passes through, and the
// focus hand-off below is not a pointer event either.
export const SCREEN_SETTLE_MS = 500;

// The tab a route selects: a Settings screen keeps Settings selected.
function tabOf(route) {
  return SETTINGS_SCREENS.includes(route) ? 'config' : route;
}

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
  // One-shot: the hashchange being delivered is the push a tab activation
  // made (see the tab click handler).
  let tabActivated = false;
  // Per-route restore below owns the scroll position; browser scroll
  // restoration would otherwise fight it on reload and back/forward.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  // The screen a card just opened, while it takes no pointer input
  // (SCREEN_SETTLE_MS), and the timer that ends that.
  let settling = null;
  let settleTimer = 0;

  function liftSettle() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    if (settling) settling.removeAttribute('data-settling');
    settling = null;
  }

  // Runs on every applied route change. A screen opened from the list settles;
  // any other change ends a settling screen at once, so the mark never outlives
  // the screen it belongs to and a quick return opens a window of its own.
  function settle(from, route) {
    liftSettle();
    if (from !== 'config' || !SETTINGS_SCREENS.includes(route)) return;
    const screen = $(`panel-${route}`);
    if (!screen) return;
    screen.setAttribute('data-settling', '');
    settling = screen;
    settleTimer = setTimeout(liftSettle, SCREEN_SETTLE_MS);
  }

  // Exactly one tabpanel is shown, and inside the Settings tabpanel exactly
  // one view: the list for `config`, else the screen the route names. Both are
  // set on every render, so the first render (a refresh, a direct link on
  // `#prices`, a `#schedule` saved before the move) opens that screen with
  // Settings selected, never Status.
  function showViews(route) {
    const tab = tabOf(route);
    for (const name of ROUTE_NAMES) {
      const ownTab = tabOf(name) === name;
      $(`panel-${name}`).hidden = ownTab ? name !== tab : name !== route;
    }
    $('settings-list').hidden = route !== 'config';
  }

  // The two focus hand-offs of a Settings screen (#228). Activating a card
  // hides the link that had focus, and the browser then drops focus to <body>
  // — the top of the document, with nothing said about where it landed — so
  // the screen that opened takes it instead: its region, named by its heading.
  // Coming back from a screen, the card that was opened takes focus in turn,
  // unless focus is on a tab: a tap on the Settings tab re-selects that tab,
  // and the tab pattern keeps focus there as it does for every other tab.
  //
  // Any other control a route change hides with its view gets the same
  // hand-off: the Charger screen's "Advanced console", History's "Open
  // settings", back/forward while focus sits inside the leaving screen.
  // `active` is what had focus before the views moved, so a control that is
  // still shown — a tab above all — keeps focus. The view that opened takes
  // it: a Settings screen in its region, a tab route in the selected tab,
  // which is where a tab activation that focuses the button leaves it. A tab
  // activation itself is not handed off (`tabActivated`): focus stays where
  // the tap left it.
  // Returns whether focus was placed, so a guarded leave does not move it again.
  function focusView(from, route, active, tabActivation) {
    if (from === 'config' && SETTINGS_SCREENS.includes(route)) {
      $(`panel-${route}`).focus({ preventScroll: true });
      return true;
    }
    if (
      route === 'config' &&
      SETTINGS_SCREENS.includes(from) &&
      !tabs.includes(document.activeElement)
    ) {
      $(`settings-card-${from}`).focus({ preventScroll: true });
      return true;
    }
    if (!tabActivation && from && active && active.closest('[hidden]')) {
      const opened = SETTINGS_SCREENS.includes(route)
        ? $(`panel-${route}`)
        : document.querySelector('.tab[aria-selected="true"]');
      if (!opened) return false;
      opened.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  // `active` and `tabActivation` describe the change the hash delivered; both
  // are read by render() before this hides anything. A confirmed leave passes
  // neither: it places focus its own way (guarded).
  function apply(route, active = null, tabActivation = false) {
    const from = currentRoute;
    const changed = from !== route;
    if (from && changed) {
      scrollByRoute.set(from, window.scrollY);
    }
    showViews(route);
    for (const tab of tabs) {
      const selected = tab.dataset.route === tabOf(route);
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
    if (changed) settle(from, route);
    return changed ? focusView(from, route, active, tabActivation) : false;
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
        const focused = apply(route);
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
        // had it instead, so put focus where the click would have left it —
        // unless the route change itself placed focus (a return to the list
        // lands on the card that was opened).
        if (!focused) {
          const activeTab = document.querySelector('.tab[aria-selected="true"]');
          if (activeTab) activeTab.focus({ preventScroll: true });
        }
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
    // Read before anything moves: what had focus when the hash moved, and
    // whether a tab activation moved it.
    const active = document.activeElement;
    const activated = tabActivated;
    tabActivated = false;
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
    apply(route, active, activated);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', (event) => {
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
        else {
          // A user's activation is a trusted click, and it is the tab
          // pattern's own navigation: focusView leaves it alone. Two in-panel
          // controls drive this same handler by code — the Charger screen's
          // "Advanced console" and the Prices Back control — and their clicks
          // are untrusted, so they keep the hand-off.
          tabActivated = Boolean(event && event.isTrusted);
          location.hash = route;
        }
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
