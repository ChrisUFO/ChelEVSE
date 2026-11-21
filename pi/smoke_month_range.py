#!/usr/bin/env python3
"""Read-only live-Firestore smoke: the month documentId range query (#208).

``bridge._month_totals`` (PR #207, the month side of #161) reads a month of
``history/{YYYY-MM-DD}`` documents with a ``__name__`` range query -- the
repo's first Python Admin SDK documentId range. It is verified only against
``FakeQuery``, which implements the semantics the author assumed; the
production precedent is the *web* store's ``documentId()`` range
(``web/js/store.js:340``), a different SDK whose bounds conversion the
Python SDK does not perform. The Python ``FieldFilter`` sends a string
bound verbatim (``string_value``; ``FieldFilter._to_pb`` does no
conversion, and the SDK's only string-to-reference conversion is the
positional-args ``in`` path), while production Firestore requires
*reference* values for ``__name__`` comparisons and rejects strings with
``InvalidArgument: __key__ filter value must be a Key``
(googleapis/python-firestore#153, maintainer-confirmed;
googleapis/google-cloud-go#4151, closed 2026-10 with the same contract).
"Silently empty" outcomes are emulator-only; production raises at the
first ``stream()`` iteration -- which ``_month_totals``'s ``except``
swallows into one journal line per day, so #207 deployed as-is would
disable month reconciliation without a sound. This smoke settles the
question against the live project before the Pi's checkout moves onto it.

Per month (``--month YYYY-MM``, repeatable; default the current and the
previous local month) it runs five checks. The module's only Firestore
calls are ``stream()`` reads over ``history`` -- reconciliation's
zero-writes invariant (#161) -- and it contains no
set/update/delete-style write call at all (pinned by
``test_smoke_month_range.py``):

  1. control       a full ``history`` stream filtered client-side by pure
                   string comparison -- independent of the query machinery
                   under test. Must be non-empty: a month with zero history
                   documents FAILs, because empty evidence is no evidence.
                   In-range documents whose ``kwh`` is not numeric are
                   noted and skipped, the same rule ``_month_totals``
                   applies when summing.
  2. string probe  the exact filter chain merged in #207 (string bounds).
                   Informational by design -- both outcomes are findings --
                   so it never gates the verdict. Expected on production:
                   ``rejected (InvalidArgument: __key__ ...)``.
  3. ref form      the documented form: ``FieldFilter("__name__", ">=",
                   coll.document(start))`` and ``("<",
                   coll.document(next))``. Must equal the control exactly;
                   any exception FAILs. Ordering is byte-lexicographic on
                   the id within the collection, so no ``order_by`` is
                   needed (the server appends implicit ``__name__``
                   ordering) and no composite index applies.
  4. production    ``bridge._month_totals`` itself (imported deliberately
                   -- the one whole-bridge import) against the live client
                   must return ``(archive, 0.0)`` with ``archive`` equal to
                   the control's sum (1e-9). A stub sink pins pending
                   energy to 0.0; the instant is day 15 noon of the month,
                   pure wall-clock -- the function reads only ``.date()``
                   and does month arithmetic. Pre-fix (string bounds
                   rejected server-side) the function's ``except``
                   swallows the rejection and returns None; that is
                   reported as a production-path FAIL -- the run's
                   evidence, not a crash.
  5. boundaries    when the month's first-day document exists: the
                   previous month's ref-form range must EXCLUDE it (upper
                   bound exclusive) and the month's own ref-form range must
                   INCLUDE it (lower bound inclusive). Without that
                   document the bounds are not exercised at all; the check
                   says so and skips.

Exit 0 only when every month passes 1, 3 and 4 (and no boundary check
failed); the string probe never gates. The summary line carries the date,
project and months -- it is the PR evidence for #208. Decision rule
(issue #208): string form matches control -> note only; rejected -> fix
``_month_totals`` to DocumentReference bounds, align ``FakeQuery``, then
re-run this smoke.

Credentials resolve exactly like ``repair_session_wh.py``:
``GOOGLE_APPLICATION_CREDENTIALS`` (the deploy guard's variable), else
``FIREBASE_SERVICE_ACCOUNT`` from the environment or ``private/bridge.env``
(the bridge's ``cfg`` semantics, real environment winning, relative paths
anchored at the repo root), else ``private/service-account.json`` (the
deploy guard's default). When both ``GOOGLE_APPLICATION_CREDENTIALS`` and
the bridge's ``FIREBASE_SERVICE_ACCOUNT`` resolve to keys whose
``project_id``s differ, the smoke refuses to run at all -- the exported
deploy variable would silently retarget it to another project (the deploy
guard's own cross-check, ``scripts/check-firebase-project.mjs``); unset
``GOOGLE_APPLICATION_CREDENTIALS`` or point it at the bridge key.

Run on the Pi with the venv that has google-cloud-firestore, from a
worktree checkout (never the running service's own checkout):

    pi/.venv/bin/python pi/smoke_month_range.py
    pi/.venv/bin/python pi/smoke_month_range.py --month 2026-11 --month 2026-10
"""

import argparse
import json
import os
import re
import sys
import threading
import types
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from firebase_admin import firestore  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE_ENV = REPO_ROOT / "private" / "bridge.env"
DEFAULT_KEY = REPO_ROOT / "private" / "service-account.json"
HISTORY = "history"

# The production-path float tolerance: the same server documents read twice
# should be bit-identical, but the sum's order is not guaranteed, so the
# comparison allows the epsilon float summation order can cost.
TOLERANCE = 1e-9

EXPECTED_KEY_PATHS = (
    "  1. $GOOGLE_APPLICATION_CREDENTIALS (absolute, or relative to the "
    "working directory)",
    "  2. $FIREBASE_SERVICE_ACCOUNT, from the environment or "
    f"{BRIDGE_ENV.relative_to(REPO_ROOT)} (relative paths resolve from the "
    "repo root)",
    f"  3. {DEFAULT_KEY.relative_to(REPO_ROOT)} (the deploy guard's default)",
)


# -- pure helpers (unit-tested offline) --------------------------------------


def month_bounds(day):
    """(first day of ``day``'s month, first day of the next month).

    The same arithmetic ``_month_totals`` uses, December rolling into
    January of the next year. A datetime is accepted and collapsed to its
    date: the callers work in whole days.
    """
    if isinstance(day, datetime):
        day = day.date()
    start = day.replace(day=1)
    following = (
        start.replace(year=start.year + 1, month=1)
        if start.month == 12
        else start.replace(month=start.month + 1)
    )
    return start, following


def kwh_of(snapshot):
    """The snapshot's numeric ``kwh`` as a float, else None.

    The bridge's own rule (``_is_number``): int/float but not bool, and no
    value at all when the document carries none -- so the control, the
    range reads and ``_month_totals``'s sum all count the same documents.
    """
    data = snapshot.to_dict()
    kwh = data.get("kwh") if isinstance(data, dict) else None
    if isinstance(kwh, (int, float)) and not isinstance(kwh, bool):
        return float(kwh)
    return None


def scan_control(db, start_id, next_id):
    """The independent control: ``{id: kwh}`` for ids in [start_id, next_id).

    A full ``history`` stream filtered client-side by pure string
    comparison -- no query machinery involved, so the control cannot
    inherit the bug under test. Returns ``(docs, skipped)``: in-range
    documents whose ``kwh`` is not numeric are skipped and noted, exactly
    as the summing code skips them.
    """
    docs, skipped = {}, []
    for snapshot in db.collection(HISTORY).stream():
        if not start_id <= snapshot.id < next_id:
            continue
        kwh = kwh_of(snapshot)
        if kwh is None:
            skipped.append(snapshot.id)
        else:
            docs[snapshot.id] = kwh
    return docs, sorted(skipped)


def range_docs(query):
    """``({id: kwh}, [skipped ids])`` from one already-built range query.

    The same ``kwh`` rule as the control, so equality comparisons are
    apples-to-apples against both the control and ``_month_totals``.
    """
    docs, skipped = {}, []
    for snapshot in query.stream():
        kwh = kwh_of(snapshot)
        if kwh is None:
            skipped.append(snapshot.id)
        else:
            docs[snapshot.id] = kwh
    return docs, sorted(skipped)


def string_form(coll, start_id, next_id):
    """The query exactly as merged in #207: plain string bounds."""
    return coll.where(filter=firestore.FieldFilter("__name__", ">=", start_id)).where(
        filter=firestore.FieldFilter("__name__", "<", next_id)
    )


def ref_form(coll, start_id, next_id):
    """The documented form: DocumentReference bounds from the collection."""
    return coll.where(
        filter=firestore.FieldFilter("__name__", ">=", coll.document(start_id))
    ).where(filter=firestore.FieldFilter("__name__", "<", coll.document(next_id)))


def describe_mismatch(docs, control):
    """Why a query result differs from the control, compactly."""
    extra = sorted(set(docs) - set(control))
    missing = sorted(set(control) - set(docs))
    differing = sorted(
        f"{day} {docs[day]!r}!={control[day]!r}"
        for day in set(docs) & set(control)
        if docs[day] != control[day]
    )
    parts = [f"{len(docs)} docs vs control {len(control)}"]
    if extra:
        parts.append(f"extra {extra}")
    if missing:
        parts.append(f"missing {missing}")
    if differing:
        parts.append(f"values {differing}")
    return "MISMATCH " + "; ".join(parts)


def probe_string_form(db, start_id, next_id, control):
    """Run the #207 string-bound form and classify; never raise.

    The live outcome is the issue's question, so both a rejection and a
    match are findings -- this check never gates the smoke's verdict.
    """
    try:
        docs, _skipped = range_docs(
            string_form(db.collection(HISTORY), start_id, next_id)
        )
    except Exception as error:  # noqa: BLE001 - classification, not handling
        return {
            "outcome": "rejected",
            "detail": f"rejected ({error.__class__.__name__}: {error})",
        }
    if docs == control:
        return {
            "outcome": "matched",
            "detail": f"matched control ({len(docs)} docs)",
        }
    return {"outcome": "mismatch", "detail": describe_mismatch(docs, control)}


def verify_ref_form(db, start_id, next_id, control):
    """The documented form must equal the control exactly, or FAIL."""
    try:
        docs, _skipped = range_docs(ref_form(db.collection(HISTORY), start_id, next_id))
    except Exception as error:  # noqa: BLE001 - the FAIL verdict, not a crash
        return {"ok": False, "detail": f"{error.__class__.__name__}: {error}"}
    if docs == control:
        return {"ok": True, "detail": f"equals control ({len(docs)} docs)"}
    return {"ok": False, "detail": describe_mismatch(docs, control)}


class StubSink:
    """The sink surface ``_month_totals`` touches, pinned to zero pending.

    The apply lock (held across the read for the flush-race reason the
    production code documents) and the tracker's still-pending-per-day
    getter. The smoke asserts the archive side -- Firestore; pending energy
    is local state by definition, so 0.0 makes the expected tuple
    ``(archive, 0.0)``.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.tracker = types.SimpleNamespace(
            history=types.SimpleNamespace(pending_for_day=lambda day: 0.0)
        )


def verify_production(bridge_mod, db, year, month, control_sum):
    """``bridge._month_totals`` itself must return the control's sum.

    Day 15 noon of the month, pure wall-clock: the function reads only
    ``.date()`` and does month arithmetic. A read failure inside the
    function lands in its ``except`` and comes back as None (one journal
    line above) -- reported as the FAIL it is, never a crash of this run.
    """
    now_local = datetime(year, month, 15, 12, 0, 0)
    result = bridge_mod._month_totals(db, StubSink(), now_local)
    if result is None:
        return {
            "ok": False,
            "detail": "returned None (month read failed - journal line above)",
        }
    archive, pending = result
    if pending == 0.0 and abs(archive - control_sum) <= TOLERANCE:
        return {
            "ok": True,
            "detail": f"archive {archive:.3f} kWh == control sum",
        }
    return {
        "ok": False,
        "detail": f"returned ({archive!r}, {pending!r}); expected "
        f"({control_sum!r}, 0.0)",
    }


def boundary_checks(db, start_id, next_id, control):
    """Lower bound inclusive, upper bound exclusive -- when exercised.

    Both spot-checks hinge on the month's first-day document existing: it
    is the document the lower bound must include and the previous month's
    upper bound must exclude. Without it the bounds are not exercised at
    all -- say so and skip rather than pass vacuously.
    """
    if start_id not in control:
        return {
            "status": "skipped",
            "detail": f"no history/{start_id} document - bounds not exercised",
        }
    previous_start = (
        (date.fromisoformat(start_id) - timedelta(days=1)).replace(day=1).isoformat()
    )
    try:
        previous_docs, _ = range_docs(
            ref_form(db.collection(HISTORY), previous_start, start_id)
        )
        this_docs, _ = range_docs(ref_form(db.collection(HISTORY), start_id, next_id))
    except Exception as error:  # noqa: BLE001 - the FAIL verdict, not a crash
        return {"status": "fail", "detail": f"{error.__class__.__name__}: {error}"}
    excluded = start_id not in previous_docs
    included = start_id in this_docs
    if excluded and included:
        return {
            "status": "pass",
            "detail": f"{previous_start} range excludes history/{start_id} "
            f"(upper bound exclusive); own range includes it (lower bound "
            "inclusive)",
        }
    findings = []
    if not excluded:
        findings.append(
            f"previous range [{previous_start}, {start_id}) INCLUDES "
            f"history/{start_id} - upper bound not exclusive"
        )
    if not included:
        findings.append(
            f"own range [{start_id}, {next_id}) EXCLUDES history/{start_id} "
            "- lower bound not inclusive"
        )
    return {"status": "fail", "detail": "; ".join(findings)}


def run_month(db, bridge_mod, year, month):
    """The five checks for one month, as a result dict; never raises.

    Month gates: control non-empty, ref form equals control, production
    path agrees, and no boundary check failed (a failed assertion about
    the bounds is a finding; a skipped one is not -- the bounds were never
    exercised). The string probe is informational: both its outcomes are
    legitimate findings and it never gates.
    """
    start, following = month_bounds(date(year, month, 1))
    start_id, next_id = start.isoformat(), following.isoformat()
    control, skipped = scan_control(db, start_id, next_id)
    control_sum = sum(control.values())
    result = {
        "label": f"{year:04d}-{month:02d}",
        "start_id": start_id,
        "next_id": next_id,
        "control": {
            "ok": bool(control),
            "count": len(control),
            "sum": control_sum,
            "skipped": skipped,
        },
        "string_probe": probe_string_form(db, start_id, next_id, control),
        "ref_form": verify_ref_form(db, start_id, next_id, control),
        "production": verify_production(bridge_mod, db, year, month, control_sum),
        "boundary": boundary_checks(db, start_id, next_id, control),
    }
    result["ok"] = (
        result["control"]["ok"]
        and result["ref_form"]["ok"]
        and result["production"]["ok"]
        and result["boundary"]["status"] != "fail"
    )
    return result


def failing_checks(result):
    """The month's gating checks that failed, in report order.

    The string probe is absent by construction: it never gates.
    """
    failed = []
    if not result["control"]["ok"]:
        failed.append("control empty")
    if not result["ref_form"]["ok"]:
        failed.append("ref form")
    if not result["production"]["ok"]:
        failed.append("production path")
    if result["boundary"]["status"] == "fail":
        failed.append("boundary spot-checks")
    return failed


def print_month(result):
    """One month's header line and five-check table."""
    control = result["control"]
    if control["ok"]:
        skipped = ""
        if control["skipped"]:
            skipped = (
                f" ({len(control['skipped'])} in-range docs with non-numeric "
                f"kwh noted, not counted: {control['skipped']})"
            )
        print(
            f"month {result['label']}: control {control['count']} "
            f"document(s), archive sum {control['sum']:.3f} kWh{skipped}"
        )
        control_detail = (
            f"{control['count']} document(s) from a full history scan, "
            "filtered client-side"
        )
    else:
        print(
            f"month {result['label']}: control EMPTY - no history document "
            f"in [{result['start_id']}, {result['next_id']}) (empty "
            "evidence is no evidence)"
        )
        control_detail = "no document in range"
    probe = result["string_probe"]
    rows = (
        ("control", "OK" if control["ok"] else "FAIL", control_detail),
        ("string probe (#207)", probe["outcome"].upper(), probe["detail"]),
        (
            "ref form (documented)",
            "OK" if result["ref_form"]["ok"] else "FAIL",
            result["ref_form"]["detail"],
        ),
        (
            "production path",
            "OK" if result["production"]["ok"] else "FAIL",
            result["production"]["detail"],
        ),
        (
            "boundary spot-checks",
            result["boundary"]["status"].upper(),
            result["boundary"]["detail"],
        ),
    )
    for name, verdict, detail in rows:
        print(f"  {name:<24} {verdict:<9} {detail}")
    verdict = "PASS" if result["ok"] else "FAIL"
    print(f"  -> month {result['label']}: {verdict}")


def print_summary(results, project, now=None):
    """The failing checks and the final evidence line; returns pass/fail.

    The summary line carries the date, project and months: it is what the
    PR body quotes as #208's evidence.
    """
    now = now or datetime.now().astimezone()
    passed = all(result["ok"] for result in results)
    months = ", ".join(result["label"] for result in results)
    for result in results:
        failed = failing_checks(result)
        if failed:
            print(f"  {result['label']}: " + ", ".join(failed))
    verdict = "SMOKE PASS" if passed else "SMOKE FAIL"
    print(
        f"{verdict} ({now.strftime('%Y-%m-%d %H:%M %z')}, project {project}, "
        f"months {months})"
    )
    return passed


# -- CLI ---------------------------------------------------------------------


def parse_month(value):
    """argparse type: a calendar month as ``YYYY-MM`` -> ``(year, month)``."""
    if not re.fullmatch(r"\d{4}-\d{2}", value):
        raise argparse.ArgumentTypeError(f"not a YYYY-MM month: {value!r}")
    year, month = int(value[:4]), int(value[5:])
    if not 1 <= month <= 12:
        raise argparse.ArgumentTypeError(f"not a calendar month: {value!r}")
    return year, month


def default_months(today=None):
    """The current and the previous local month, chronological order.

    January rolls back into December of the previous year -- the same
    rollover ``month_bounds`` owns going forward.
    """
    today = today or date.today()
    this = (today.year, today.month)
    previous = (
        (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    )
    return [previous, this]


def parse_args(argv):
    """``--month YYYY-MM`` repeatable; defaults to current + previous."""
    parser = argparse.ArgumentParser(
        prog="smoke_month_range.py",
        description=(
            "Read-only live-Firestore smoke (#208): the month documentId "
            "range query of bridge._month_totals verified against an "
            "independent client-side control, one set of checks per month."
        ),
        epilog=(
            "Reads only (history stream); never writes. Exit 0 only when "
            "every month's control is non-empty, the DocumentReference form "
            "equals the control, and the production path agrees."
        ),
        allow_abbrev=False,
    )
    parser.add_argument(
        "--month",
        metavar="YYYY-MM",
        type=parse_month,
        action="append",
        dest="months",
        help="a month to verify, repeatable (default: the current and the "
        "previous local months)",
    )
    return parser.parse_args(argv)


# -- credentials resolution (mirrors repair_session_wh.py) --------------------


def load_env_file(path):
    """KEY=VALUE lines; blanks, comments and lines without '=' skipped.

    The same semantics as ``bridge.load_env_file`` and
    ``repair_session_wh.py``, kept local so the credentials phase runs
    before the bridge import.
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

    Real environment first, then ``private/bridge.env`` -- the bridge's own
    precedence -- with the deploy guard's variable and default on either
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
    deploy key exported for the web tooling would retarget this smoke to
    another project without a word. When both it and the bridge's
    FIREBASE_SERVICE_ACCOUNT resolve to readable keys whose project_ids
    differ, return ``(gac_path, fsa_path, gac_project, fsa_project)``;
    anything else is None and the normal resolution stands (the cross-check
    the deploy guard performs, ``scripts/check-firebase-project.mjs``).
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
    from google.cloud import firestore as firestore_client
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
    return firestore_client.Client(project=key["project_id"], credentials=credentials)


def fail_no_credentials():
    """Print the exact paths the key is expected at; a non-zero exit."""
    print(
        "smoke_month_range: no service-account key - Firestore is unreachable.",
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
        "smoke_month_range: refusing to run - the credential variables "
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


def load_bridge():
    """Import the production bridge (``pi/`` is already on ``sys.path``).

    Deliberately the whole bridge, and deliberately late: the
    production-path check asserts ``bridge._month_totals`` itself against
    the live client rather than a re-implementation, while the module's
    helpers and the credentials phase stay independent of it.
    """
    import bridge

    return bridge


def main(argv=None):
    args = parse_args(argv)
    mismatch = project_mismatch(dict(os.environ))
    if mismatch is not None:
        return fail_project_mismatch(mismatch)
    key_file = resolve_service_account_key(dict(os.environ))
    if not key_file.is_file():
        return fail_no_credentials()
    try:
        db = make_client(key_file)
    except RuntimeError as error:
        print(f"smoke_month_range: {error}", file=sys.stderr)
        return 1
    bridge_mod = load_bridge()

    months = sorted(set(args.months)) if args.months else default_months()
    labels = ", ".join(f"{year:04d}-{month:02d}" for year, month in months)
    print("smoke_month_range (#208): month documentId range vs live Firestore")
    print(
        f"{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')} / "
        f"project {db.project} / collection {HISTORY} / key {key_file}"
    )
    print(f"months {labels} (local); reads only, never writes")
    print()

    results = [run_month(db, bridge_mod, year, month) for year, month in months]
    for result in results:
        print_month(result)
        print()
    passed = print_summary(results, db.project)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
