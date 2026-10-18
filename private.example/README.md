# Private config template

Copy this directory to `private/` and fill in real values. `private/` is gitignored — it never reaches the public repo.

```bash
cp -r private.example private
cp web/firebase-config.example.js web/firebase-config.js
```

| File | What goes in it |
|---|---|
| `bridge.env` | Pi bridge agent settings (charger IP, key path, intervals) |
| `service-account.json` | Firebase Admin key: Console → Project settings → Service accounts → *Generate new private key* |
| `web/firebase-config.js` | Web app config: Console → Project settings → General → Your apps → Web app → Config |

Generate strong values where applicable, e.g. `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
