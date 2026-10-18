# ChelEVSE — repository rules

## Deploy to Firebase after every PR merge

A merge is not the end of a change: production must run what `main` says. After **every** PR
merges to `main`, deploy the Firebase targets that PR touched, before starting the next unit.

1. Sync: `git checkout main && git pull --ff-only origin main`.
2. Deploy only what changed, using the npm scripts:
   - `firestore.rules` changed → `npm run deploy:rules`
   - `firestore.indexes.json` changed → `npm run deploy:indexes`
   - anything under `web/` changed, or `firebase.json` hosting config changed → `npm run deploy:hosting`
   - multiple targets → `npm run deploy` (all of them) or repeat the specific scripts.
3. Record the merge commit and the deployed targets in the PR or the cycle notes.

### Deploy rules

- Deploy **from `main` only**, after the merge — never from a feature branch. Production must never
  serve an unreviewed build.
- Validate rules/indexes before releasing them: `npm run deploy:dry-run` (or the specific target
  with `--dry-run`) must compile cleanly.
- Credentials: authenticate the Firebase CLI, or set
  `GOOGLE_APPLICATION_CREDENTIALS=private/service-account.json` for a service-account deploy.
  Neither `private/` nor `.firebaserc` is ever committed.
- Project selection: `firebase.json` deliberately carries no project id. Either keep a local
  `.firebaserc` (gitignored) or export `FIREBASE_PROJECT=<project-id>` before running the scripts.
- Never use `--force`. A failed deploy is triaged (read the error, fix the cause), not bypassed.
- If a deploy fails twice, stop and report the diagnosis instead of retrying blindly.
- A deploy is a production action with owner-level impact: do not deploy during an unresolved
  review or with local uncommitted changes.
