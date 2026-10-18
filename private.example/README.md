# Private config template

Copy this directory to `private/` and fill in real values. `private/` is gitignored — it never reaches the public repo.

```bash
cp -r private.example private
cp web/firebase-config.example.js web/firebase-config.js
```

| File                     | What goes in it                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `bridge.env`             | Pi bridge agent settings (charger IP, key path, intervals)                                                    |
| `acl.txt`                | Access allowlist — one Google account email per line; synced to Firestore `users/{uid}` grants by `pi/acl.py` |
| `service-account.json`   | Firebase Admin key: Console → Project settings → Service accounts → _Generate new private key_                |
| `web/firebase-config.js` | Web app config + Web Push VAPID public key (Console → Cloud Messaging → Web Push certificates)                |

Generate strong values where applicable, e.g. `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
