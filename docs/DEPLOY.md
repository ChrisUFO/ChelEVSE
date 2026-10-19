# Deploying ChelEVSE

A top-to-bottom runbook for standing up a fresh deployment: a Firebase project
(Firestore, Hosting, Auth), the Pi bridge, and the PWA. Follow it in order — each
section leaves something the next one needs.

Everything below is a placeholder you replace locally. `private/`,
`web/firebase-config.js` and `.firebaserc` are gitignored, so real values never
reach the public repo.

| Placeholder           | Meaning                                                         |
| --------------------- | --------------------------------------------------------------- |
| `<project-id>`        | Your Firebase project id (globally unique, e.g. `my-chelevse`)  |
| `<owner@example.com>` | Google account that owns the deployment (the first allowlisted) |
| `<repo-url>`          | Clone URL of this repository                                    |
| `<pi-host>`           | The Pi's LAN hostname or IP                                     |
| `<your-domain>`       | Optional custom domain, e.g. `charge.example.com`               |

## 1. Prerequisites

| Tool           | Version / notes                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Node.js        | 20 or newer (the Firebase CLI is a dev dependency and needs Node 20+)                                     |
| npm            | ships with Node                                                                                           |
| Java           | 21 LTS (the Firestore emulator needs Java 11+) — only for `npm run test:rules`                            |
| Python         | 3.13 on the Pi (the reference deployment; 3.11+ works — the bridge needs `requests` and `firebase-admin`) |
| rsync          | on the Pi; `pi/install.sh` refuses to run without it                                                      |
| git            | to clone the repo (and to run `npm run prepare`'s hooks)                                                  |
| A Raspberry Pi | Raspberry Pi OS Bookworm, wired or wireless on the charger's LAN                                          |

From the repo root:

```bash
npm install
npx firebase --version
java -version
```

`npm install` also points git at `.githooks/` (formatting hooks) and installs
Prettier. No build step exists for the app: Hosting serves `web/` as-is.

## 2. Create the Firebase project

1. Open the [Firebase console](https://console.firebase.google.com/) and choose
   **Add project**. Pick a memorable id — it becomes `<project-id>` everywhere.
2. Google Analytics is optional; the app does not use it.

The free (Spark) plan covers a household deployment, but creating the Firestore
database may require **Blaze** (pay-as-you-go) in some projects/regions. If the
console asks you to upgrade at the next step, enable billing — the free daily
quota still applies and a single household stays far below it.

## 3. Firestore

**Build → Firestore Database → Create database.**

- Choose **Native mode** (not Datastore mode).
- Choose a location. **This is permanent** — pick the region closest to the Pi
  and do not plan to move it later.
- Start in **production mode**; the rules in this repo replace the default
  deny-all rules at deploy time.

The app and the bridge both expect the database created this way. The bridge
uses the Admin SDK (rules bypassed); the PWA is constrained by `firestore.rules`.

## 4. Authentication

1. **Build → Authentication → Get started.**
2. **Sign-in method → Google → Enable**, pick a project support email, save.
3. **Settings → Authorized domains** must list every hostname the app is served
   from:
   - `<project-id>.web.app`
   - `<project-id>.firebaseapp.com`
   - `localhost` (development)
   - `<your-domain>` once the optional custom domain is attached
   - `<project-id>.firebaseapp.com`/`web.app` preview channels, if you use them

Anyone can authenticate; data access is controlled by the allowlist (§9).

## 5. Register the web app and copy its config

1. **Project settings → General → Your apps → Web (`</>`).**
2. Register the app (nickname only; no Hosting setup needed here).
3. Copy the `firebaseConfig` object from **SDK setup and configuration**.
4. Put it in `web/firebase-config.js`:

   ```bash
   cp web/firebase-config.example.js web/firebase-config.js
   ```

   Fill in `apiKey`, `authDomain`, `projectId`, `storageBucket`,
   `messagingSenderId`, `appId`. These values are not secrets (Auth + rules
   enforce access), but the real file stays out of the public repo.

5. **Generate the Web Push certificate:** **Project settings → Cloud Messaging
   → Web Push certificates → Generate key pair**. Copy the public key into the
   `vapidKey` export in `web/firebase-config.js`.

   Leaving the `<public Web Push key>` placeholder disables the notification
   opt-in with a clear in-app message (the card says push isn't configured); it
   does not break the rest of the app.

## 6. Local configuration

### Copy the templates

```bash
cp -r private.example private
cp private/bridge.env.example private/bridge.env
cp private/acl.txt.example private/acl.txt
cp web/firebase-config.example.js web/firebase-config.js
chmod 600 private/bridge.env private/acl.txt
```

`private/service-account.json.example` is reference only — the real key from §7
replaces it. Every template maps to exactly one real file:

| Template                                       | Real path                      | Purpose                                                              |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `private.example/bridge.env.example`           | `private/bridge.env`           | Charger host, key path, poll intervals (read by systemd + `acl.py`)  |
| `private.example/acl.txt.example`              | `private/acl.txt`              | Allowlist, one Google email per line; synced to `users/{uid}` grants |
| `private.example/service-account.json.example` | `private/service-account.json` | Bridge Admin SDK key (§7)                                            |
| `web/firebase-config.example.js`               | `web/firebase-config.js`       | Web app config + `vapidKey` (§5)                                     |
| — (create it)                                  | `.firebaserc`                  | Optional default project id for the guard and the CLI                |

`private/bridge.env` must at minimum set the charger and the key:

```bash
CHARGER_HOST=192.168.0.145
FIREBASE_SERVICE_ACCOUNT=private/service-account.json
```

Optional: `CHARGER_USER`/`CHARGER_PASS` if the charger has HTTP Basic auth set,
and `STATUS_INTERVAL`, `CONFIG_INTERVAL`, `SCHEDULE_INTERVAL`,
`SCHEDULE_RECONCILE_INTERVAL`, `COMMAND_INTERVAL` (see `pi/README.md`). Relative
key paths resolve from the repo root.

`private/acl.txt` is a plain list — comments and blank lines ignored:

```text
# one Google account per line
<owner@example.com>
```

### Select the project

The deploy scripts pass `--project "$FIREBASE_PROJECT"`, so export it in every
shell that deploys:

```bash
export FIREBASE_PROJECT=<project-id>
```

Alternatively create `.firebaserc` (gitignored) for the CLI and the guard:

```json
{
  "projects": { "default": "<project-id>" }
}
```

`FIREBASE_PROJECT` wins when both are present.

### The deploy guard

`scripts/check-firebase-project.mjs` runs as the `predeploy*` hook of every
`npm run deploy*` script. It refuses to deploy when the target project and the
service-account key belong to different projects — the failure mode it prevents
is shipping another app's rules or hosting into this project (or the reverse).

- **Target:** `FIREBASE_PROJECT`, else `.firebaserc` → `projects.default`.
- **Key:** `GOOGLE_APPLICATION_CREDENTIALS`, else `private/service-account.json`.
- A missing key prints a warning and continues (the Firebase CLI's own auth then
  decides); a mismatched key blocks the deploy with an explanation.
- `--force` is not a fix. Correct the target or the key.

Check it by hand before the first deploy:

```bash
GOOGLE_APPLICATION_CREDENTIALS=private/service-account.json \
  FIREBASE_PROJECT=<project-id> node scripts/check-firebase-project.mjs
```

Expected: `✔ deploy guard: <project-id> (key ... belongs to <project-id>)`.

## 7. Service accounts

Two keys are involved. A second key on the same service account works for both
jobs, but a dedicated deploy account is what keeps the Pi from holding deploy
permissions.

| Key                                                    | Used by                        | Roles                                                                                    |
| ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `private/service-account.json`                         | Pi bridge + `pi/acl.py`        | Cloud Datastore User, Firebase Authentication Viewer, Firebase Cloud Messaging API Admin |
| `private/deploy-service-account.json` (or a CLI login) | `npm run deploy:*` + the guard | Firebase Admin, Cloud Datastore Index Admin                                              |

Create the bridge key:

1. **Project settings → Service accounts → Generate new private key.** Save the
   JSON as `private/service-account.json`.
2. **IAM & Admin → IAM**: find that service account and grant the three roles
   above (Cloud Datastore User `roles/datastore.user`, Firebase Authentication
   Viewer `roles/firebaseauth.viewer`, Firebase Cloud Messaging API Admin
   `roles/firebasecloudmessaging.admin`). Or bind them with `gcloud`:

   ```bash
   gcloud projects add-iam-policy-binding <project-id> \
     --member="serviceAccount:<name>@<project-id>.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   ```

3. Create the deploy credentials the same way — a dedicated service account with
   Firebase Admin (`roles/firebase.admin`) and Cloud Datastore Index Admin
   (`roles/datastore.indexAdmin`) — and save its key as
   `private/deploy-service-account.json`.

If you would rather not keep a deploy key on disk, use `npx firebase login`
instead and set only `GOOGLE_APPLICATION_CREDENTIALS` when you want the guard to
verify a key (see §6). The guard is happy with either.

```bash
chmod 600 private/*.json
```

## 8. Deploy

From `main` on a clean tree, with `FIREBASE_PROJECT` and (optionally)
`GOOGLE_APPLICATION_CREDENTIALS` exported:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=private/deploy-service-account.json

# Compiles rules and validates the release without publishing anything.
npm run deploy:dry-run

# Security rules (required before the app can read anything).
npm run deploy:rules

# Firestore indexes (one composite index; see the build-delay note).
npm run deploy:indexes

# The PWA at https://<project-id>.web.app
npm run deploy:hosting
```

`npm run deploy` runs all three targets at once. The `deploy:*` scripts require
`FIREBASE_PROJECT` to be exported even when `.firebaserc` exists.

What gets published:

| Target  | Source                   | Notes                                                                                         |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| Rules   | `firestore.rules`        | Compile errors abort the deploy and name the failing line                                     |
| Indexes | `firestore.indexes.json` | One composite index: `commands` (`type` ASC, `created_at` DESC)                               |
| Hosting | `web/`                   | SPA rewrite to `index.html`; `no-cache` and `Cross-Origin-Opener-Policy` headers on all paths |

Verify the release:

```bash
curl -sSI https://<project-id>.web.app/ | grep -Ei 'HTTP/|cache-control|cross-origin-opener-policy'
```

Expect `200`, `cache-control: no-cache, max-age=0, must-revalidate` and
`cross-origin-opener-policy: same-origin-allow-popups` (the popup sign-in needs
the last one). Then open the URL: the sign-in card appears, not a blank page.

### Index build delay

`npm run deploy:indexes` starts a build; it is not queryable until Firestore
reports it **Ready** (usually minutes, occasionally longer). Until then the
Advanced console's recent-commands query fails with `failed-precondition` and
the screen explains that the index is still building. Nothing is broken; reload
once the console shows the index as enabled.

## 9. First sign-in and the allowlist

The allowlist is the only authorization layer, and a grant needs an existing
Firebase Auth user — so **the owner must sign in once before the first grant**.

1. Open `https://<project-id>.web.app`, sign in with Google, allow the popup.
   With no grant yet you land on **"You're not on the list"** — expected.
2. Add the account to `private/acl.txt`.
3. Run the sync (uses `private/bridge.env` + the bridge key):

   ```bash
   # Repo-local venv (no Pi needed):
   python3 -m venv pi/.venv
   pi/.venv/bin/pip install -r pi/requirements.txt
   pi/.venv/bin/python pi/acl.py
   ```

   On the Pi after §10, use the installer's venv instead:

   ```bash
   /opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py
   ```

4. Expect one line per address and a clean summary:

   ```text
   ok <owner@example.com> -> <uid>
   1 granted, 0 failed
   ```

   `failed <email>: must sign in once first (then rerun)` means step 1 has not
   happened for that account (or the address is mistyped). Fix it and rerun.

5. Reload the app (or tap retry on the blocked screen). The status tab loads and
   the header shows **Live**.

Add more people the same way: they sign in once, then the owner adds their
address and reruns `pi/acl.py`. To revoke, remove the address and run
`pi/.venv/bin/python pi/acl.py --prune` — the grant and that account's FCM
tokens are deleted, so revocation also stops push notifications. `--prune`
skips itself if any listed address failed to grant (a typo must not revoke the
real user); `--force-prune` overrides that.

## 10. The Pi

On the Pi, from a clone of the repo:

```bash
sudo apt update && sudo apt install -y git python3-venv rsync
git clone <repo-url> ~/ChelEVSE
cd ~/ChelEVSE
cp -r private.example private
cp private/bridge.env.example private/bridge.env
cp private/acl.txt.example private/acl.txt
# edit private/bridge.env (charger IP, key path)
# place private/service-account.json (the real key) and private/acl.txt
chmod 600 private/bridge.env private/service-account.json private/acl.txt
sudo bash pi/install.sh
```

The installer is idempotent: it preflights `private/bridge.env` and the key
named by `FIREBASE_SERVICE_ACCOUNT`, rsyncs `pi/` and `private/` to
`/opt/chelevse`, builds `/opt/chelevse/pi/.venv`, installs the systemd unit, and
enables + restarts `chelevse-bridge`. Re-run it after every merge that touches
`pi/` — never edit `/opt/chelevse` by hand.

Verify:

```bash
systemctl is-enabled chelevse-bridge   # enabled
systemctl is-active chelevse-bridge    # active
systemctl status chelevse-bridge --no-pager
sudo journalctl -u chelevse-bridge -n 50 --no-pager
```

Expect `active (running)`, a `bridge started` line, and no `error`, `failed`, or
traceback lines. Within one status interval, Firestore `status/current` gains an
`updated_at` and the app's status screen fills in. `schedule/current missing;
firmware schedule left untouched` is normal until a schedule is saved in the
app.

Reboot survival (also listed in `docs/VALIDATION.md`):

```bash
sudo reboot
# after it comes back
systemctl is-active chelevse-bridge
sudo journalctl -u chelevse-bridge -b --no-pager | tail -20
```

Expect `active` and a fresh `bridge started` line with no errors.

## 11. Custom domain (optional)

1. **Hosting → Add custom domain**, enter `<your-domain>`.
2. Create the DNS records the console shows at your DNS provider:
   - `CNAME <subdomain> → <project-id>.web.app` (DNS-only if you use Cloudflare
     proxying — the proxy can break certificate issuance)
   - `TXT _acme-challenge.<subdomain>` with the token shown, for the certificate
3. Wait for the certificate to provision, then check:

   ```bash
   curl -sSI https://<your-domain>/ | head -5
   ```

4. Add `<your-domain>` to **Authentication → Settings → Authorized domains**.
   Without it, Google sign-in fails with `auth/unauthorized-domain` even though
   Hosting serves the app.

## 12. Troubleshooting

| Symptom                                                                            | Likely cause                                                                 | Fix                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run deploy:rules` fails with a rules compile error                            | Syntax or type error in `firestore.rules` (line number is printed)           | Fix the rule. `npm run test:rules` loads the same rules into the emulator and reports the same error; retry the deploy.                                                                               |
| Advanced says a Firestore index "is still being built" / recent commands are empty | The composite index is still building (or `deploy:indexes` has not run)      | Wait for **Ready** under Firestore → Indexes, then reload the app. No redeploy is needed.                                                                                                             |
| `auth/unauthorized-domain` or a popup that closes with no error                    | The hostname is not an authorized Auth domain, or the COOP header is missing | Add the domain under Auth → Settings → Authorized domains and deploy Hosting (the header comes from `firebase.json`).                                                                                 |
| Sign-in popup blocked, or sign-in works in Chrome but not the installed PWA        | Popup blocked; the redirect fallback is unreliable in installed PWAs         | Allow popups for the site and use the popup path. `Cross-Origin-Opener-Policy: same-origin-allow-popups` must be deployed.                                                                            |
| `acl.py` prints `must sign in once first`                                          | The account has never authenticated, so no uid exists                        | Sign in once at the app URL, then rerun `pi/acl.py`.                                                                                                                                                  |
| Grant applied but the app still says "You're not on the list"                      | Stale access check / wrong account                                           | Reload the app (or tap retry); confirm `users/{uid}.allowed == true` and that you are signed in as the listed address.                                                                                |
| Firestore creation asks for billing / `PERMISSION_DENIED` on writes                | Blaze not enabled, or the database is in Datastore mode                      | Enable billing and create a **Native mode** database. The location is permanent.                                                                                                                      |
| Bridge journal: `No route to host` / `ConnectionError` to the charger              | The charger is off, on another network, or `CHARGER_HOST` is wrong           | Ping the charger from the Pi; fix `private/bridge.env` and rerun `sudo bash pi/install.sh`.                                                                                                           |
| App banner says "Bridge offline" (not "Charger offline")                           | No status write for over 60 s — the Pi or its Firebase access is down        | `systemctl is-active chelevse-bridge`; `journalctl -u chelevse-bridge -n 50`.                                                                                                                         |
| App banner says "Charger offline" while the Pi is healthy                          | The charger stopped answering a poll (`charger_online: false`)               | Check the charger's power/Wi-Fi. The Pi keeps retrying at the poll interval; the banner clears on the first good poll.                                                                                |
| Deployed changes do not appear in the browser                                      | Service-worker shell cache (cache-first), or an open tab keeps old modules   | Close/reopen the tab (a reload fetches the new shell: `index.html`, `sw.js` and `firebase-config.js` are `no-cache`). If you changed shell files, bump `CACHE` in `web/sw.js` as part of that change. |
| Notification opt-in says push isn't configured                                     | `vapidKey` is still the placeholder                                          | Generate the Web Push certificate (§5) and put the key in `web/firebase-config.js`, then redeploy Hosting.                                                                                            |

Next: check the deployment against [VALIDATION.md](VALIDATION.md).
