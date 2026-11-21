#!/usr/bin/env python3
"""One-time repair for legacy under-recorded session ``wh`` (#195).

Sessions written before the bridge accumulated every counter epoch's
per-tick deltas into ``wh`` can carry the last epoch's cumulative beside an
energy-complete interval list — `wh` 15956 against a list summing 48038.
The web's guard (`web/js/cost.js` `sessionIntervalsValid`) refuses to price
such a list, so the session falls back to pro-rating a bounded undercount.
This tool repairs exactly those documents: it sets `wh` to the interval sum
when the sum exceeds `wh` by more than the guard's own `max(250 Wh, 2%)`
band (decision logic in `session_wh_repair.py`), and touches nothing else.

Owner-run maintenance, dry-run by default; `--apply` is the only write mode
and writes only the `wh` field of the documents the criteria select. The
decision is idempotent: once `wh` equals the interval sum the document
reconciles (`|sum - wh| == 0`), so a rerun classifies it `reconcile` and
writes nothing. Every other shape — intervals short, no intervals, unusable
intervals, already reconciling — is reported and left alone. Deliberately
not an automatic backfill: detection-only reconciliation (#161) is the
standing policy; this is the one-time cleanup of the pre-#195 documents.

Credentials resolve the way the bridge's tooling does —
`GOOGLE_APPLICATION_CREDENTIALS` (the deploy guard's variable), else
`FIREBASE_SERVICE_ACCOUNT` from the environment or `private/bridge.env`
(the bridge's `cfg` semantics, real environment winning, relative paths
anchored at the repo root), else `private/service-account.json` (the deploy
guard's default). Run on the Pi with the venv that has google-cloud-firestore:

    pi/.venv/bin/python pi/repair_session_wh.py            # dry run (default)
    pi/.venv/bin/python pi/repair_session_wh.py --apply
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from session_wh_repair import (  # noqa: E402
    BAD_WH,
    INTERVALS_SHORT,
    NO_INTERVALS,
    RECONCILE,
    REPAIR,
    UNUSABLE_INTERVALS,
    classify_session,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE_ENV = REPO_ROOT / "private" / "bridge.env"
DEFAULT_KEY = REPO_ROOT / "private" / "service-account.json"
SESSIONS = "sessions"

EXPECTED_KEY_PATHS = (
    "  1. $GOOGLE_APPLICATION_CREDENTIALS (absolute, or relative to the "
    "working directory)",
    "  2. $FIREBASE_SERVICE_ACCOUNT, from the environment or "
    f"{BRIDGE_ENV.relative_to(REPO_ROOT)} (relative paths resolve from the "
    "repo root)",
    f"  3. {DEFAULT_KEY.relative_to(REPO_ROOT)} (the deploy guard's default)",
)


def parse_args(argv):
    """--dry-run is the default; --apply must be explicit and exclusive."""
    parser = argparse.ArgumentParser(
        prog="repair_session_wh.py",
        description=(
            "One-time repair of legacy under-recorded session wh (#195): "
            "sets wh to the interval sum when the sum exceeds wh by more "
            "than max(250 Wh, 2%). Dry-run by default; --apply writes only "
            "the wh field of the selected documents."
        ),
        epilog="Idempotent: repaired documents reconcile and are skipped on rerun.",
        allow_abbrev=False,
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="classify and print the plan without writing (the default)",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        default=False,
        help="write the repaired wh field (and nothing else) to Firestore",
    )
    return parser.parse_args(argv)


def load_env_file(path):
    """KEY=VALUE lines; blanks, comments and lines without '=' skipped.

    The same semantics as ``bridge.load_env_file``, kept local so this
    script does not import the whole bridge.
    """
    values = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    return values


def resolve_service_account_key(environ):
    """The service-account key path (the deploy-guard default when unset).

    Real environment first, then ``private/bridge.env`` — the bridge's own
    precedence — with the deploy guard's variable and default on either
    side: GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT,
    private/service-account.json.
    """
    file_env = load_env_file(BRIDGE_ENV)

    def cfg(name):
        return environ.get(name) or file_env.get(name)

    key_path = (
        environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or cfg("FIREBASE_SERVICE_ACCOUNT")
        or str(DEFAULT_KEY)
    )
    key_file = Path(key_path)
    if not key_file.is_absolute():
        # GOOGLE_APPLICATION_CREDENTIALS is conventionally working-directory
        # relative; FIREBASE_SERVICE_ACCOUNT is repo-root relative (the
        # bridge anchors it there). Try both, in that order of preference.
        candidates = [key_file, REPO_ROOT / key_file]
        key_file = next(
            (candidate for candidate in candidates if candidate.is_file()),
            candidates[0],
        )
    return key_file


def make_client(key_file):
    """A google-cloud-firestore client for the key's own project."""
    from google.cloud import firestore
    from google.oauth2 import service_account

    try:
        key = json.loads(key_file.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"cannot read service-account key {key_file}: {error}"
        ) from None
    if not key.get("project_id"):
        raise RuntimeError(f"no project_id in service-account key: {key_file}")
    credentials = service_account.Credentials.from_service_account_file(str(key_file))
    return firestore.Client(project=key["project_id"], credentials=credentials)


def fail_no_credentials(apply):
    """Print the exact paths the key is expected at; a non-zero exit."""
    print(
        "repair_session_wh: no service-account key - Firestore is unreachable.",
        file=sys.stderr,
    )
    if apply:
        print(
            "--apply refused: writes require explicit credentials.",
            file=sys.stderr,
        )
    print("Expected the key at one of:", file=sys.stderr)
    for line in EXPECTED_KEY_PATHS:
        print(line, file=sys.stderr)
    return 1


def collect(db):
    """Classify every sessions document, id-sorted for a stable report."""
    rows = []
    for snapshot in db.collection(SESSIONS).stream():
        decision = classify_session(snapshot.to_dict() or {})
        rows.append((snapshot.id, decision))
    rows.sort(key=lambda row: row[0])
    return rows


def print_report(rows):
    """The table: every classification but reconcile, with its figures."""
    shown = [row for row in rows if row[1].classification != RECONCILE]
    if not shown:
        print(f"no {SESSIONS} document diverges; nothing to repair.")
        return
    header = (
        f"{'session':<20} {'class':<20} {'wh':>12} {'interval sum':>13} "
        f"{'proposed wh':>12}"
    )
    print(header)
    print("-" * len(header))
    for doc_id, decision in shown:
        wh = f"{decision.wh:.1f}" if decision.wh is not None else "n/a"
        total = (
            f"{decision.interval_sum:.1f}"
            if decision.interval_sum is not None
            else "n/a"
        )
        proposed = (
            f"{decision.repaired_wh:.1f}" if decision.repaired_wh is not None else "-"
        )
        print(
            f"{doc_id:<20} {decision.classification:<20} {wh:>12} {total:>13} "
            f"{proposed:>12}"
        )


def print_summary(rows):
    counts = {}
    for _, decision in rows:
        counts[decision.classification] = counts.get(decision.classification, 0) + 1
    skipped = ", ".join(
        f"{counts.get(name, 0)} {name}"
        for name in (
            RECONCILE,
            INTERVALS_SHORT,
            NO_INTERVALS,
            UNUSABLE_INTERVALS,
            BAD_WH,
        )
    )
    print(
        f"summary: {counts.get(REPAIR, 0)} repaired, "
        f"{len(rows) - counts.get(REPAIR, 0)} skipped ({skipped})"
    )


def apply_repairs(db, rows):
    """Write only the wh field of each repair document; log every write."""
    failures = 0
    for doc_id, decision in rows:
        if decision.classification != REPAIR:
            continue
        try:
            # A single-field update: every other field — intervals included —
            # is untouched, and no document is ever replaced.
            db.collection(SESSIONS).document(doc_id).update(
                {"wh": decision.repaired_wh}
            )
        except Exception as error:  # noqa: BLE001 — report and keep going
            failures += 1
            print(f"FAILED sessions/{doc_id}: {error}")
            continue
        print(
            f"applied sessions/{doc_id}: wh {decision.wh:.1f} -> "
            f"{decision.repaired_wh:.1f}"
        )
    return failures


def main(argv=None):
    args = parse_args(argv)
    key_file = resolve_service_account_key(dict(os.environ))
    if not key_file.is_file():
        return fail_no_credentials(apply=args.apply)
    try:
        db = make_client(key_file)
    except RuntimeError as error:
        print(f"repair_session_wh: {error}", file=sys.stderr)
        return 1

    mode = (
        "APPLY - writing only the wh field of 'repair' rows"
        if args.apply
        else "DRY RUN - no writes"
    )
    print(mode)
    print(f"project {db.project} / collection {SESSIONS} / key {key_file}")
    print()

    rows = collect(db)
    print_report(rows)
    print()
    failures = 0
    if args.apply:
        failures = apply_repairs(db, rows)
        if failures:
            print(f"\n{failures} write(s) failed")
    else:
        print("dry run: no writes. Re-run with --apply to write the proposed wh.")
    print()
    print_summary(rows)
    return 1 if args.apply and failures else 0


if __name__ == "__main__":
    sys.exit(main())
