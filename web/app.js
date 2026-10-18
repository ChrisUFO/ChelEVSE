// Boot only: load Firebase, wire the sign-in/out shell, then hand control to
// the auth lifecycle. Screen rendering lives in js/screens/.

import { initFirebase } from './js/firebase.js';
import { signInErrorMessage, signInWithEmail, signOutUser, subscribeAuth } from './js/auth.js';
import { startStore, stopStore } from './js/store.js';
import { $, initNetwork, setCached, setText } from './js/ui.js';
import {
  enterStatus,
  initStatus,
  leaveStatus,
  showCommands,
  showStatus,
  showStatusError,
} from './js/screens/status.js';

function bootFail(title, body) {
  setText($('boot-title'), title);
  setText($('boot-body'), body);
  $('boot-error').hidden = false;
}

function enterApp() {
  $('signin').hidden = true;
  $('app').hidden = false;
  startStore({
    onStatus: (snap) => {
      if (!snap) {
        showStatusError();
        return;
      }
      setCached(snap.metadata.fromCache);
      showStatus(snap);
    },
    onCommands: showCommands,
  });
  enterStatus();
}

function leaveApp() {
  $('app').hidden = true;
  $('signin').hidden = false;
  stopStore();
  leaveStatus();
}

function wireUi() {
  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signin-btn');
    btn.disabled = true;
    setText(btn, 'Signing in…');
    setText($('signin-error'), '');
    try {
      await signInWithEmail($('email').value.trim(), $('pass').value);
    } catch (err) {
      setText($('signin-error'), signInErrorMessage(err && err.code));
    } finally {
      btn.disabled = false;
      setText(btn, 'Sign in');
    }
  });

  $('signout').addEventListener('click', signOutUser);
  initNetwork();
}

async function main() {
  try {
    await initFirebase();
  } catch (err) {
    if (err && err.kind === 'config') {
      bootFail(
        'Configuration missing',
        'Copy web/firebase-config.example.js to web/firebase-config.js, fill in your Firebase project values, and reload this page.',
      );
    } else {
      bootFail(
        'Could not load the app',
        'The Firebase SDK failed to load. Check your connection and reload this page.',
      );
    }
    return;
  }
  initStatus();
  wireUi();
  subscribeAuth((user) => (user ? enterApp() : leaveApp()));
}

main();
