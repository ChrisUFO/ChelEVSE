// Firebase web app config — copy to web/firebase-config.js and fill in.
// Firebase Console → Project settings → General → Your apps → Web app → SDK setup and configuration → Config.
// These values are not secrets (access is enforced by Firebase Auth + security rules),
// but the real file is kept out of the public repo.
export const firebaseConfig = {
  apiKey: 'AIza...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project-id',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '1234567890',
  appId: '1:1234567890:web:abcdef',
};

// Web Push certificate (VAPID) public key — Firebase Console → Project
// settings → Cloud Messaging → Web Push certificates. Required for the
// notification opt-in. This is a public key, not a secret. Leave it as the
// placeholder to keep notifications disabled with a clear explanation.
export const vapidKey = '<public Web Push key>';
