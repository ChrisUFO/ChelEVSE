# Private config template

Copy the templates to their real (gitignored) paths and fill in values. Nothing here is a secret
until you put real values in it; `private/` and `web/firebase-config.js` never reach the public
repo.

```bash
cp -r private.example private
cp private/bridge.env.example private/bridge.env
cp private/acl.txt.example private/acl.txt
cp web/firebase-config.example.js web/firebase-config.js
chmod 600 private/bridge.env private/acl.txt
```

| Template                                       | Real path                      | What goes in it                                                                                               |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `private.example/bridge.env.example`           | `private/bridge.env`           | Pi bridge settings: `CHARGER_HOST`, `FIREBASE_SERVICE_ACCOUNT`, optional poll intervals                       |
| `private.example/acl.txt.example`              | `private/acl.txt`              | Access allowlist — one Google account email per line; synced to Firestore `users/{uid}` grants by `pi/acl.py` |
| `private.example/service-account.json.example` | `private/service-account.json` | Firebase Admin key: Console → Project settings → Service accounts → _Generate new private key_                |
| `web/firebase-config.example.js`               | `web/firebase-config.js`       | Web app config + Web Push VAPID public key (Console → Cloud Messaging → Web Push certificates)                |
| (none — create it)                             | `.firebaserc`                  | Optional default project id (`{"projects":{"default":"<project-id>"}}`); `FIREBASE_PROJECT` overrides it      |

Bridge key roles: Cloud Datastore User, Firebase Authentication Viewer, Firebase Cloud Messaging API Admin. A separate
deploy key (Firebase Admin + Cloud Datastore Index Admin) avoids giving the Pi deploy rights; the deploy guard compares
its `project_id` with the target project and blocks a mismatch. `service-account.json.example` is a reference
placeholder — the real key replaces `private/service-account.json`.

After the Pi is installed, sync the allowlist with the installer's venv:

```bash
/opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py
```

Each person must sign in once before they can be granted (their Auth user must exist to resolve the uid). Full setup
steps, including the console work and the deploy commands, are in [../docs/DEPLOY.md](../docs/DEPLOY.md).
