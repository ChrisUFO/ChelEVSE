import { test } from 'node:test';
import assert from 'node:assert/strict';

// The Health card's dismissal records (#205), driven with no DOM: what one
// account's Dismiss writes, what survives a reload, and every way the store
// refuses to turn a broken or refusing localStorage into a broken card. What a
// record hides is health.js's rule (test/web/health.test.js); this file pins
// that the records are kept per account, in one shape, and never lost by a
// storage failure inside the page that made them.
import { DISMISSALS_KEY, createDismissalStore } from '../../web/js/health-dismissals.js';

// A localStorage-compatible adapter over a Map (the notification-session
// convention), counting writes so "nothing written" is a real assertion.
function memoryStorage() {
  const map = new Map();
  const storage = {
    sets: 0,
    removes: 0,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      storage.sets += 1;
      map.set(key, String(value));
    },
    removeItem: (key) => {
      storage.removes += 1;
      map.delete(key);
    },
  };
  return storage;
}

// A store on a fixed clock, so every record's stamp is the one expected.
const T0 = 1794876000000;
function store(storage = memoryStorage(), extra = {}) {
  let clock = T0;
  const dismissals = createDismissalStore({ storage, now: () => clock, ...extra });
  return { dismissals, storage, tick: (ms = 1000) => (clock += ms) };
}

// What the key holds, as the next page load would read it.
const persisted = (storage) => JSON.parse(storage.getItem(DISMISSALS_KEY) ?? 'null');

// An advisory as the projection hands it to `dismiss`: the three parts of a
// dismissal's key (#205). `recorded` is one the charger did not report as
// present when dismissed, `active` one it did.
const recorded = (id, severity) => ({ id, severity, reportedPresent: false });
const active = (id, severity) => ({ id, severity, reportedPresent: true });

test('a dismissal is written at once and read back by a later store', () => {
  const { dismissals, storage } = store();
  const record = dismissals.dismiss('uid-a', active('fault.no_ground', 'critical'));

  // The record carries the two facts a row must still match to stay hidden —
  // the severity it hid, and that the charger reported it as present — and the
  // stamp of the click.
  assert.deepEqual(record, { severity: 'critical', dismissedAt: T0, reportedPresent: true });
  assert.deepEqual(persisted(storage), {
    'uid-a': {
      'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: true },
    },
  });
  assert.deepEqual(dismissals.read('uid-a'), { 'fault.no_ground': record });

  // A reload: a new store over the same storage sees exactly what was written.
  const reloaded = createDismissalStore({ storage });
  assert.deepEqual(reloaded.read('uid-a'), {
    'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: true },
  });

  // A second page (another tab) writing its own account is a read-modify-write
  // of the one key: the first account's record survives it. The page has its
  // own clock.
  const later = createDismissalStore({ storage, now: () => T0 + 1000 });
  later.dismiss('uid-b', recorded('thermal.high_temp', 'warning'));
  assert.deepEqual(persisted(storage), {
    'uid-a': {
      'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: true },
    },
    'uid-b': {
      'thermal.high_temp': { severity: 'warning', dismissedAt: T0 + 1000, reportedPresent: false },
    },
  });
});

test('records are scoped per account', () => {
  const { dismissals, storage } = store();
  dismissals.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  dismissals.dismiss('uid-b', recorded('thermal.high_temp', 'warning'));

  assert.deepEqual(Object.keys(dismissals.read('uid-a')), ['fault.no_ground']);
  assert.deepEqual(Object.keys(dismissals.read('uid-b')), ['thermal.high_temp']);
  // An account with no record reads empty — never another account's.
  assert.deepEqual(dismissals.read('uid-c'), {});
  assert.deepEqual(persisted(storage), {
    'uid-a': {
      'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false },
    },
    'uid-b': {
      'thermal.high_temp': { severity: 'warning', dismissedAt: T0, reportedPresent: false },
    },
  });
});

test('an unreadable or wrong-shaped store reads as empty, never throws', () => {
  const storage = memoryStorage();
  for (const raw of ['not json', '', 'null', '42', '"text"', '[]', '{"uid-a": []}']) {
    storage.setItem(DISMISSALS_KEY, raw);
    assert.deepEqual(store(storage).dismissals.read('uid-a'), {}, raw);
  }

  // Per record: anything not in the stored shape is dropped on its own, and
  // the well-formed record beside it is kept. That includes a record with no
  // present fact, or one that is not a boolean: the field has no fallback.
  storage.setItem(
    DISMISSALS_KEY,
    JSON.stringify({
      'uid-a': {
        'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false }, // kept
        'safety.vent_check': { severity: 'warning' }, // no stamp
        'thermal.high_temp': { dismissedAt: T0 }, // no severity
        'wear.relay_life': { severity: 3, dismissedAt: T0 }, // severity not a string
        'fault.stuck_relay': { severity: 'critical', dismissedAt: 'yesterday' },
        'fault.gfci_tripped': { severity: 'info', dismissedAt: Number.NaN }, // not finite
        'wear.relay_cold_open': { severity: 'info', dismissedAt: Infinity },
        'wear.relay_transit_drift': { severity: 'info', dismissedAt: T0 }, // no present fact
        'wear.stuck_relay_recovery': { severity: 'info', dismissedAt: T0, reportedPresent: 'no' },
        'safety.ground_check': 'critical', // not a record object
        'safety.diode_check': null,
        'safety.relay_check': ['critical', T0],
      },
    }),
  );
  const dismissals = createDismissalStore({ storage });
  assert.deepEqual(dismissals.read('uid-a'), {
    'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false },
  });

  // A non-object store is not merged into either: the next write replaces it.
  storage.setItem(DISMISSALS_KEY, 'garbage');
  const { dismissals: writer } = store(storage);
  writer.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  assert.deepEqual(Object.keys(persisted(storage)), ['uid-a']);
});

test('a record says whether the charger reported the advisory as present', () => {
  // The third part of a dismissal's key (health.js's rule), kept from the row
  // the screen hands over — `true` for a live condition, `false` for a record
  // — and read back by a later store.
  const { dismissals, storage } = store();
  const live = dismissals.dismiss('uid-a', active('fault.no_ground', 'critical'));
  const standing = dismissals.dismiss('uid-a', recorded('thermal.high_temp', 'warning'));
  assert.equal(live.reportedPresent, true);
  assert.equal(standing.reportedPresent, false);
  assert.deepEqual(createDismissalStore({ storage }).read('uid-a'), {
    'fault.no_ground': live,
    'thermal.high_temp': standing,
  });

  // Required, with no fallback. This record shape is unreleased, so there is
  // no earlier one to read a record without the fact back from: whichever way
  // it is missing, the entry is wrong-shaped and dropped, and its row lists.
  storage.setItem(
    DISMISSALS_KEY,
    JSON.stringify({
      'uid-a': {
        'fault.no_ground': { severity: 'critical', dismissedAt: T0 }, // the fact is missing
        'thermal.high_temp': { severity: 'warning', dismissedAt: T0, reportedPresent: 'false' },
        'wear.relay_life': { severity: 'info', dismissedAt: T0, reportedPresent: null },
      },
    }),
  );
  const reloaded = createDismissalStore({ storage });
  assert.deepEqual(reloaded.read('uid-a'), {}, 'none of them is a record');

  // `replace` drops one rather than persisting it, beside a well-formed one.
  assert.deepEqual(
    reloaded.replace('uid-a', {
      'fault.no_ground': { severity: 'critical', dismissedAt: T0 },
      'thermal.high_temp': standing,
    }),
    { 'thermal.high_temp': standing },
  );
  assert.deepEqual(Object.keys(persisted(storage)['uid-a']), ['thermal.high_temp']);

  // And the fact is part of what makes a record the same: with only it
  // changed, the screen's map is not the stored one, and is written.
  const written = storage.sets;
  dismissals.replace('uid-a', {
    'thermal.high_temp': { ...standing, reportedPresent: true },
  });
  assert.equal(storage.sets, written + 1);
  assert.deepEqual(persisted(storage)['uid-a']['thermal.high_temp'].reportedPresent, true);
});

test('dismissing the same advisory again overwrites its record', () => {
  const { dismissals, tick } = store();
  dismissals.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  tick(5000);
  const again = dismissals.dismiss('uid-a', recorded('fault.no_ground', 'warning'));

  assert.equal(again.dismissedAt, T0 + 5000);
  assert.deepEqual(dismissals.read('uid-a'), {
    'fault.no_ground': { severity: 'warning', dismissedAt: T0 + 5000, reportedPresent: false },
  });
});

test('replace stores a map health.js already pruned, and only when it changed', () => {
  const { dismissals, storage } = store();
  dismissals.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  dismissals.dismiss('uid-a', recorded('thermal.high_temp', 'warning'));
  const written = storage.sets;

  // The screen hands the projection's map back on every usable report; an
  // equal one must not cost a write.
  dismissals.replace('uid-a', dismissals.read('uid-a'));
  assert.equal(storage.sets, written, 'an unchanged map writes nothing');

  const record = dismissals.read('uid-a')['thermal.high_temp'];
  assert.deepEqual(dismissals.replace('uid-a', { 'thermal.high_temp': record }), {
    'thermal.high_temp': record,
  });
  assert.equal(storage.sets, written + 1);
  assert.deepEqual(persisted(storage), {
    'uid-a': {
      'thermal.high_temp': { severity: 'warning', dismissedAt: T0, reportedPresent: false },
    },
  });

  // An empty map retires the account — only that account. Another one's entry
  // stays until its own last record goes, and the key goes with the last of
  // them, so the store never grows a tombstone.
  const other = createDismissalStore({ storage, now: () => T0 });
  other.dismiss('uid-b', recorded('thermal.high_temp', 'warning'));
  assert.deepEqual(dismissals.replace('uid-a', {}), {});
  assert.deepEqual(Object.keys(persisted(storage)), ['uid-b'], 'the other account stays');

  assert.deepEqual(other.replace('uid-b', {}), {});
  assert.equal(storage.getItem(DISMISSALS_KEY), null, 'no account left: no key');

  // Records outside the stored shape are dropped rather than persisted.
  dismissals.replace('uid-a', {
    'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false },
    'safety.vent_check': { severity: 'warning' }, // no stamp
    'safety.temp_check': { severity: 'warning', dismissedAt: T0 }, // no present fact
  });
  assert.deepEqual(Object.keys(persisted(storage)['uid-a']), ['fault.no_ground']);
});

test('a refused write still hides the row for this page', () => {
  // A storage that reads but refuses to write, until it doesn't.
  const map = new Map();
  let refused = true;
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (refused) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  };
  const { dismissals } = store(storage);

  dismissals.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  // Storage never took it, but this page reads the record it just wrote.
  assert.equal(map.size, 0);
  assert.deepEqual(dismissals.read('uid-a'), {
    'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false },
  });

  // A second dismissal rides the same in-memory copy.
  dismissals.dismiss('uid-a', recorded('thermal.high_temp', 'warning'));
  assert.deepEqual(Object.keys(dismissals.read('uid-a')), ['fault.no_ground', 'thermal.high_temp']);
  assert.equal(map.size, 0);

  // When storage accepts a write again, the account's whole map lands — the
  // records the refusals hid are not lost by the next successful one.
  refused = false;
  dismissals.dismiss('uid-a', recorded('wear.relay_life', 'info'));
  assert.deepEqual(Object.keys(JSON.parse(map.get(DISMISSALS_KEY))['uid-a']), [
    'fault.no_ground',
    'thermal.high_temp',
    'wear.relay_life',
  ]);

  // Storage took that one, so the page reads storage again from here: another
  // page's change to the account is no longer hidden behind a refused copy.
  createDismissalStore({ storage, now: () => T0 }).replace('uid-a', {});
  assert.equal(map.size, 0);
  assert.deepEqual(dismissals.read('uid-a'), {});
});

test('a store that cannot be read yields empty', () => {
  const storage = memoryStorage();
  storage.getItem = () => {
    throw new Error('SecurityError');
  };
  // Nothing is read, and nothing throws into the render that asked.
  assert.deepEqual(store(storage).dismissals.read('uid-a'), {});

  // Writing still keeps the in-memory copy: the read failure is not also a
  // hide that silently does nothing.
  const { dismissals } = store(storage);
  dismissals.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  assert.deepEqual(Object.keys(dismissals.read('uid-a')), ['fault.no_ground']);
});

test('a page whose write storage took reads storage again and sees another page’s change', () => {
  // Two tabs of one account share the key — the app sets that up on purpose.
  // Tab A dismissed an advisory and storage took it; while A sat in the
  // background the charger cleared it and tab B's next report retired the
  // record; the charger then raised it again at the same severity.
  const storage = memoryStorage();
  const tabA = createDismissalStore({ storage, now: () => T0 });
  const tabB = createDismissalStore({ storage, now: () => T0 });
  tabA.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  assert.deepEqual(Object.keys(persisted(storage)['uid-a']), ['fault.no_ground']);

  // Tab B's report no longer lists it: the screen hands the projection's
  // pruned — here empty — map back, which retires the account's entry.
  assert.deepEqual(tabB.replace('uid-a', {}), {});
  assert.equal(storage.getItem(DISMISSALS_KEY), null);

  // Tab A reads that, not a copy of the write it made before: its copy still
  // holds the record, and answering from it would hide an advisory the
  // charger lists again.
  assert.deepEqual(tabB.read('uid-a'), {});
  assert.deepEqual(tabA.read('uid-a'), {}, 'the retirement reaches tab A');
});

test('a page’s next dismissal starts from storage and cannot undo another page’s', () => {
  // The same two tabs: A dismissed one advisory and B another, then A dismisses
  // a third. A dismissal rewrites the account's whole map, so it starts from
  // what storage holds now — B's record included. From the map A itself wrote
  // two changes ago it would drop B's record, and that advisory would list
  // again in both tabs.
  const storage = memoryStorage();
  const tabA = createDismissalStore({ storage, now: () => T0 });
  const tabB = createDismissalStore({ storage, now: () => T0 });
  tabA.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  tabB.dismiss('uid-a', recorded('thermal.high_temp', 'warning'));

  tabA.dismiss('uid-a', recorded('wear.relay_life', 'info'));

  const expected = ['fault.no_ground', 'thermal.high_temp', 'wear.relay_life'];
  assert.deepEqual(Object.keys(persisted(storage)['uid-a']), expected);
  assert.deepEqual(Object.keys(tabA.read('uid-a')), expected);
  assert.deepEqual(Object.keys(tabB.read('uid-a')), expected);
});

test('without an account nothing is read or written', () => {
  const { dismissals, storage } = store();
  storage.setItem(
    DISMISSALS_KEY,
    JSON.stringify({
      'uid-a': {
        'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false },
      },
    }),
  );
  const sets = storage.sets;

  assert.deepEqual(dismissals.read(''), {});
  assert.deepEqual(dismissals.read(null), {});
  assert.deepEqual(dismissals.read(undefined), {});
  assert.equal(dismissals.dismiss('', { id: 'fault.no_ground', severity: 'critical' }), null);
  assert.deepEqual(
    dismissals.replace('', { 'fault.no_ground': { severity: 'a', dismissedAt: 1 } }),
    {},
  );
  assert.equal(storage.sets, sets, 'a dismissed-without-account click writes nothing');
  assert.equal(persisted(storage)['uid-a']['fault.no_ground'].severity, 'critical');
});

test('without any storage the records last for the page only', () => {
  const { dismissals } = store(null);
  dismissals.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  assert.deepEqual(dismissals.read('uid-a'), {
    'fault.no_ground': { severity: 'critical', dismissedAt: T0, reportedPresent: false },
  });
  assert.deepEqual(dismissals.replace('uid-a', {}), {});
  assert.deepEqual(dismissals.read('uid-a'), {});
});

test('an advisory with no usable id, severity or present fact records nothing', () => {
  const { dismissals, storage } = store();
  for (const advisory of [
    null,
    undefined,
    {},
    { id: 'fault.no_ground' },
    { severity: 'critical' },
    { id: 7, severity: 'critical' },
    { id: 'fault.no_ground', severity: 3 },
    { id: 'fault.no_ground', severity: 'critical' }, // no present fact
    { id: 'fault.no_ground', severity: 'critical', reportedPresent: 'false' },
  ]) {
    assert.equal(dismissals.dismiss('uid-a', advisory), null, JSON.stringify(advisory));
  }
  assert.equal(storage.sets, 0);
  assert.deepEqual(dismissals.read('uid-a'), {});
});

test('a refused remove is swallowed and the key name is configurable', () => {
  const storage = memoryStorage();
  assert.equal(DISMISSALS_KEY, 'chelevse.healthDismissals');
  storage.setItem('other.key', JSON.stringify({ 'uid-a': {} }));
  const custom = createDismissalStore({ storage, key: 'other.key', now: () => T0 });
  custom.dismiss('uid-a', recorded('fault.no_ground', 'critical'));
  assert.ok(storage.getItem('other.key').includes('fault.no_ground'));
  assert.equal(storage.getItem(DISMISSALS_KEY), null, 'the default key is untouched');

  storage.removeItem = () => {
    throw new Error('SecurityError');
  };
  assert.deepEqual(custom.replace('uid-a', {}), {});
  assert.deepEqual(custom.read('uid-a'), {}, 'the refused remove leaves the copy answering');
});

test('an id or account spelled like a prototype key stays an own key', () => {
  // The JSON is this origin's to write, but a hand-edited store must not be
  // able to turn a read into a different object's prototype.
  const storage = memoryStorage();
  storage.setItem(
    DISMISSALS_KEY,
    '{"__proto__": {"polluted": true}, "uid-a": {"__proto__": {"severity": "critical", "dismissedAt": 1, "reportedPresent": false}}}',
  );
  const dismissals = createDismissalStore({ storage });
  const records = dismissals.read('uid-a');
  assert.equal(Object.hasOwn(records, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(records), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(records.__proto__, {
    severity: 'critical',
    dismissedAt: 1,
    reportedPresent: false,
  });

  // And a write does not leak one back out.
  dismissals.dismiss('constructor', recorded('__proto__', 'info'));
  const stored = persisted(storage);
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal(Object.hasOwn(stored, '__proto__'), true, 'the own key is preserved as written');
});
