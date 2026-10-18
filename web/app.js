// ChelEVSE PWA — vanilla ES module, no build step.
// Boot order matters: local firebase-config.js is imported dynamically first so a
// missing config yields a friendly screen instead of a blank page or SDK noise.

const $ = (id) => document.getElementById(id);
const setText = (el, text) => {
  if (el && el.textContent !== text) el.textContent = text;
};

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

const STATES = {
  charging: { label: 'Charging', color: '#38d996' },
  ready: { label: 'Ready', color: '#58a6ff' },
  connected: { label: 'Connected', color: '#e0b45c' },
  sleeping: { label: 'Sleeping', color: '#93a0b4' },
  disabled: { label: 'Disabled', color: '#f26d5f' },
  unknown: { label: 'Unknown', color: '#98a1b0' },
};

const CMD_TEXT = {
  pause: { busy: () => 'Pausing…', done: () => 'Paused.' },
  resume: { busy: () => 'Resuming…', done: () => 'Resumed.' },
  set_current: { busy: (a) => `Setting current to ${a} A…`, done: (a) => `Current set to ${a} A.` },
};

// Filled in by main() once the SDK modules load.
let auth, db;
let getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut;
let getFirestore, doc, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot;

// App state.
let status = null; // latest status/current contents
let ampsPrefilled = false; // slider seeded from the charger once per session
let netOnline = navigator.onLine;
let netCached = false;
let unsubStatus = null;
let unsubCmds = null;
let ticker = null;
let resultTimer = null;
let shownResultId = null;

// ---------- helpers ----------

const fmtK = (v) =>
  v == null || Number.isNaN(v)
    ? '—'
    : v >= 100
      ? v.toFixed(0)
      : v >= 10
        ? v.toFixed(1)
        : v.toFixed(2);

function relTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function ageMs() {
  const ts = status && status.updated_at;
  return ts && typeof ts.toMillis === 'function' ? Date.now() - ts.toMillis() : Infinity;
}

// ---------- rendering ----------

function renderStatus() {
  const key = status && STATES[status.state_label] ? status.state_label : 'unknown';
  const state = STATES[key];
  document.documentElement.style.setProperty('--state', state.color);
  setText($('state-label'), state.label);
  $('state-badge').classList.toggle('pulse', key === 'charging');

  setText($('power'), status && status.power != null ? fmtK(status.power / 1000) : '—');
  setText($('fig-amp'), status && status.amp != null ? String(Math.round(status.amp)) : '—');
  setText($('fig-volt'), status && status.voltage ? `at ${Math.round(status.voltage)} V` : '');
  setText(
    $('fig-session'),
    status && status.session_energy != null ? fmtK(status.session_energy / 1000) : '—',
  );
  setText($('fig-total'), status && status.total_energy != null ? fmtK(status.total_energy) : '—');
  setText($('fig-temp'), status && status.temp_c != null ? String(Math.round(status.temp_c)) : '—');

  const charging = key === 'charging';
  $('pause').classList.toggle('primary', charging);
  $('resume').classList.toggle('primary', !charging);

  if (!ampsPrefilled && status && status.amp > 0) {
    setAmps(Math.min(48, Math.max(6, Math.round(status.amp))));
    ampsPrefilled = true;
  }
  renderFreshness();
}

function renderFreshness() {
  if (!status) {
    setText($('updated'), 'waiting for data');
    $('banner').hidden = true;
    return;
  }
  setText($('updated'), `updated ${relTime(ageMs())}`);
  $('banner').hidden = !(status.charger_online === false || ageMs() > 60000);
}

function renderNet() {
  const mode = !netOnline ? 'offline' : netCached ? 'cached' : 'live';
  $('net').dataset.net = mode;
  setText($('net'), mode === 'live' ? 'Live' : mode === 'cached' ? 'Cached' : 'Offline');
}

function setBusy(busy) {
  for (const el of [$('pause'), $('resume'), $('amps'), $('apply')]) el.disabled = busy;
}

function renderCommands(cmds) {
  const fb = $('feedback');
  const pending = cmds.find((c) => c.status === 'pending');
  setBusy(Boolean(pending));
  if (pending) {
    const t = CMD_TEXT[pending.type] || CMD_TEXT.resume;
    fb.className = 'feedback busy';
    setText(fb, t.busy(pending.amps));
    return;
  }
  const latest = cmds[0];
  const created =
    latest && latest.created_at && typeof latest.created_at.toMillis === 'function'
      ? latest.created_at.toMillis()
      : 0;
  if (!latest || !created || Date.now() - created > 5 * 60000) {
    fb.className = 'feedback';
    setText(fb, '');
    return;
  }
  const t = CMD_TEXT[latest.type] || { busy: () => 'Working…', done: () => 'Done.' };
  if (latest.status === 'acked') {
    if (shownResultId === latest.id) return;
    shownResultId = latest.id;
    fb.className = 'feedback ok';
    setText(fb, t.done(latest.amps));
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      if (shownResultId === latest.id) {
        fb.className = 'feedback';
        setText(fb, '');
      }
    }, 6000);
  } else if (latest.status === 'failed') {
    shownResultId = latest.id;
    fb.className = 'feedback err';
    setText(fb, `Failed: ${latest.error || 'command was not applied'}`);
  } else {
    fb.className = 'feedback';
    setText(fb, '');
  }
}

// ---------- actions ----------

async function sendCommand(payload) {
  setBusy(true); // optimistic; the commands listener keeps this set until the bridge acks
  try {
    await addDoc(collection(db, 'commands'), payload);
  } catch {
    setBusy(false);
    const fb = $('feedback');
    fb.className = 'feedback err';
    setText(fb, 'Could not send — check your connection and try again.');
  }
}

function setAmps(v) {
  $('amps').value = v;
  paintSlider();
}

function paintSlider() {
  const v = Number($('amps').value);
  setText($('amps-out'), `${v} A`);
  $('amps').style.setProperty('--fill', `${((v - 6) / 42) * 100}%`);
}

function signInError(code) {
  const map = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-login-credentials': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/invalid-email': 'That email address does not look valid.',
    'auth/network-request-failed': 'Network error — check your connection and try again.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  };
  return map[code] || 'Sign-in failed. Try again.';
}

// ---------- session lifecycle ----------

function enterApp() {
  $('signin').hidden = true;
  $('app').hidden = false;

  unsubStatus = onSnapshot(
    doc(db, 'status', 'current'),
    (snap) => {
      netCached = snap.metadata.fromCache;
      renderNet();
      status = snap.exists() ? snap.data() : null;
      renderStatus();
    },
    () => {
      status = null;
      renderStatus();
    },
  );
  unsubCmds = onSnapshot(
    query(collection(db, 'commands'), orderBy('created_at', 'desc'), limit(3)),
    (snap) => renderCommands(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => {},
  );
  clearInterval(ticker);
  ticker = setInterval(renderFreshness, 1000);
  paintSlider();
  renderNet();
}

function leaveApp() {
  $('app').hidden = true;
  $('signin').hidden = false;
  if (unsubStatus) unsubStatus();
  if (unsubCmds) unsubCmds();
  unsubStatus = unsubCmds = null;
  clearInterval(ticker);
  status = null;
  ampsPrefilled = false;
  shownResultId = null;
  setBusy(false);
  const fb = $('feedback');
  fb.className = 'feedback';
  setText(fb, '');
  $('banner').hidden = true;
}

// ---------- boot ----------

function bootFail(title, body) {
  setText($('boot-title'), title);
  setText($('boot-body'), body);
  $('boot-error').hidden = false;
}

function wireUi() {
  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signin-btn');
    btn.disabled = true;
    setText(btn, 'Signing in…');
    setText($('signin-error'), '');
    try {
      await signInWithEmailAndPassword(auth, $('email').value.trim(), $('pass').value);
    } catch (err) {
      setText($('signin-error'), signInError(err && err.code));
    } finally {
      btn.disabled = false;
      setText(btn, 'Sign in');
    }
  });

  $('signout').addEventListener('click', () => {
    signOut(auth).catch(() => {});
  });
  $('pause').addEventListener('click', () =>
    sendCommand({ type: 'pause', created_at: serverTimestamp(), status: 'pending' }),
  );
  $('resume').addEventListener('click', () =>
    sendCommand({ type: 'resume', created_at: serverTimestamp(), status: 'pending' }),
  );
  $('apply').addEventListener('click', () =>
    sendCommand({
      type: 'set_current',
      amps: Number($('amps').value),
      created_at: serverTimestamp(),
      status: 'pending',
    }),
  );
  $('amps').addEventListener('input', paintSlider);
  addEventListener('online', () => {
    netOnline = true;
    renderNet();
  });
  addEventListener('offline', () => {
    netOnline = false;
    renderNet();
  });
}

async function main() {
  let firebaseConfig;
  try {
    ({ firebaseConfig } = await import('./firebase-config.js'));
  } catch {
    bootFail(
      'Configuration missing',
      'Copy web/firebase-config.example.js to web/firebase-config.js, fill in your Firebase project values, and reload this page.',
    );
    return;
  }
  try {
    const { initializeApp } = await import(`${SDK}/firebase-app.js`);
    ({ getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } = await import(
      `${SDK}/firebase-auth.js`
    ));
    ({ getFirestore, doc, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot } =
      await import(`${SDK}/firebase-firestore.js`));
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch {
    bootFail(
      'Could not load the app',
      'The Firebase SDK failed to load. Check your connection and reload this page.',
    );
    return;
  }
  wireUi();
  onAuthStateChanged(auth, (user) => (user ? enterApp() : leaveApp()));
}

main();
