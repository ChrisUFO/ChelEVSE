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

The repair is era-bounded to that charter: only sessions whose `ended_at`
is strictly before `--before` (default `2026-11-20T18:41:52Z`, the instant
the Pi restarted onto the #195 bridge) are eligible, and a document with no
parseable `ended_at` — a live session, or anything the bridge has not
closed — is skipped with one closed at or after the bound, as `after-bound`,
never written. The bound is the second fence, not the only one: sessions
closed by the post-fix bridge reconcile by construction (the first fence),
but the same-plug-in "reset-to-exactly-0" resume documented in
ARCHITECTURE §4 legitimately has an interval list that exceeds `wh` — there
`wh` is the better figure — and only the era bound keeps the tool off it.
Same-day pre-fix closes before the restart instant remain eligible.

Credentials resolve the way the bridge's tooling does —
`GOOGLE_APPLICATION_CREDENTIALS` (the deploy guard's variable), else
`FIREBASE_SERVICE_ACCOUNT` from the environment or `private/bridge.env`
(the bridge's `cfg` semantics, real environment winning, relative paths
anchored at the repo root), else `private/service-account.json` (the deploy
guard's default). When both `GOOGLE_APPLICATION_CREDENTIALS` and the
bridge's `FIREBASE_SERVICE_ACCOUNT` resolve to keys whose `project_id`s
differ, the tool refuses to run at all — in dry-run too — because the
exported deploy variable would silently retarget it to another project
(the deploy guard's own cross-check, `scripts/check-firebase-project.mjs`);
unset `GOOGLE_APPLICATION_CREDENTIALS` or point it at the bridge key.
Run on the Pi with the venv that has google-cloud-firestore:

    pi/.venv/bin/python pi/repair_session_wh.py            # dry run (default)
    pi/.venv/bin/python pi/repair_session_wh.py --apply
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from session_wh_repair import (  # noqa: E402
    AFTER_BOUND,
    BAD_WH,
    INTERVALS_SHORT,
    NO_INTERVALS,
    RECONCILE,
    REPAIR,
    UNUSABLE_INTERVALS,
    classify_session,
    parse_before,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE_ENV = REPO_ROOT / "private" / "bridge.env"
DEFAULT_KEY = REPO_ROOT / "private" / "service-account.json"
SESSIONS = "sessions"

# The default era bound: the instant the Pi restarted onto the #195 bridge.
# Documents closed strictly before it are the tool's charter (the pre-#195
# undercounts, same-day pre-fix closes included); documents closed at or
# after it — or still open — are after-bound and never written, which keeps
# the tool off the post-#195 reset-to-exactly-0 resume corner
# (ARCHITECTURE §4) where wh is the better figure.
DEFAULT_BEFORE = "2026-11-20T18:41:52Z"

EXPECTED_KEY_PATHS = (
    "  1. $GOOGLE_APPLICATION_CREDENTIALS (absolute, or relative to the "
    "working directory)",
    "  2. $FIREBASE_SERVICE_ACCOUNT, from the environment or "
    f"{BRIDGE_ENV.relative_to(REPO_ROOT)} (relative paths resolve from the "
    "repo root)",
    f"  3. {DEFAULT_KEY.relative_to(REPO_ROOT)} (the deploy guard's default)",
)


def _before_timestamp(value):
    """argparse type: an ISO-8601 instant as epoch milliseconds."""
    ms = parse_before(value)
    if ms is None:
        raise argparse.ArgumentTypeError(f"not an ISO-8601 timestamp: {value!r}")
    return ms


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
    parser.add_argument(
        "--before",
        metavar="ISO-8601",
        type=_before_timestamp,
        default=_before_timestamp(DEFAULT_BEFORE),
        help=(
            "repair only sessions whose ended_at is strictly before this "
            f"instant (default: {DEFAULT_BEFORE}, the instant the Pi "
            "restarted onto the #195 bridge). Sessions with no parseable "
            "ended_at - live ones included - and sessions closed at or "
            "after the bound are skipped as 'after-bound' and never "
            "written: post-#195 the same-plug-in reset-to-exactly-0 resume "
            "(ARCHITECTURE §4) legitimately exceeds wh, and there wh is the "
            "better figure. Same-day pre-fix closes before the bound stay "
            "eligible."
        ),
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


def _resolve_key_file(key_path):
    """Anchor a possibly-relative key path: the working directory first,
    then the repo root (the bridge anchors FIREBASE_SERVICE_ACCOUNT there;
    GOOGLE_APPLICATION_CREDENTIALS is conventionally CWD-relative)."""
    key_file = Path(key_path)
    if key_file.is_absolute():
        return key_file
    candidates = [key_file, REPO_ROOT / key_file]
    return next(
        (candidate for candidate in candidates if candidate.is_file()),
        candidates[0],
    )


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
    return _resolve_key_file(key_path)


def _key_project_id(key_file):
    """The key file's ``project_id``, or None when the key is unreadable."""
    try:
        key = json.loads(key_file.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(key, dict):
        return None
    project = key.get("project_id")
    return project if isinstance(project, str) and project else None


def project_mismatch(environ):
    """The GAC-vs-bridge-key clash, when both name different projects.

    GOOGLE_APPLICATION_CREDENTIALS silently wins the precedence above, so a
    deploy key exported for the web tooling would retarget this repair to
    another project without a word. When both it and the bridge's
    FIREBASE_SERVICE_ACCOUNT resolve to readable keys whose project_ids
    differ, return ``(gac_path, fsa_path, gac_project, fsa_project)``;
    anything else — either variable unset, either key unreadable, the same
    file, or the same project — is None and the normal resolution stands
    (the cross-check the deploy guard performs,
    ``scripts/check-firebase-project.mjs``).
    """
    file_env = load_env_file(BRIDGE_ENV)
    gac = environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    fsa = environ.get("FIREBASE_SERVICE_ACCOUNT") or file_env.get(
        "FIREBASE_SERVICE_ACCOUNT"
    )
    if not gac or not fsa:
        return None
    gac_file = _resolve_key_file(gac)
    fsa_file = _resolve_key_file(fsa)
    if str(gac_file) == str(fsa_file):
        return None
    gac_project = _key_project_id(gac_file)
    fsa_project = _key_project_id(fsa_file)
    if gac_project is None or fsa_project is None or gac_project == fsa_project:
        return None
    return gac_file, fsa_file, gac_project, fsa_project


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


def fail_project_mismatch(mismatch):
    """The refusal: both paths, both projects, the remedy; a non-zero exit."""
    gac_file, fsa_file, gac_project, fsa_project = mismatch
    print(
        "repair_session_wh: refusing to run - the credential variables "
        "point at two projects.",
        file=sys.stderr,
    )
    print(
        f"  GOOGLE_APPLICATION_CREDENTIALS: {gac_file} (project {gac_project})",
        file=sys.stderr,
    )
    print(
        f"  FIREBASE_SERVICE_ACCOUNT:       {fsa_file} (project {fsa_project})",
        file=sys.stderr,
    )
    print(
        "unset GOOGLE_APPLICATION_CREDENTIALS or point it at the bridge key.",
        file=sys.stderr,
    )
    return 1


def collect(db, before=None):
    """Classify every sessions document, id-sorted for a stable report."""
    rows = []
    for snapshot in db.collection(SESSIONS).stream():
        decision = classify_session(snapshot.to_dict() or {}, before)
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
            AFTER_BOUND,
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
    mismatch = project_mismatch(dict(os.environ))
    if mismatch is not None:
        return fail_project_mismatch(mismatch)
    key_file = resolve_service_account_key(dict(os.environ))
    if not key_file.is_file():
        return fail_no_credentials(apply=args.apply)
    try:
        db = make_client(key_file)
    except RuntimeError as error:
        print(f"repair_session_wh: {error}", file=sys.stderr)
        return 1

    bound = datetime.fromtimestamp(args.before / 1000.0, tz=timezone.utc)
    mode = (
        "APPLY - writing only the wh field of 'repair' rows"
        if args.apply
        else "DRY RUN - no writes"
    )
    print(mode)
    print(f"project {db.project} / collection {SESSIONS} / key {key_file}")
    print(f"era bound: sessions ended strictly before {bound.isoformat()}")
    print()

    rows = collect(db, args.before)
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
