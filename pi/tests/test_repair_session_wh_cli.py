"""CLI write-contract tests for ``repair_session_wh.py`` (#195).

The out-of-repo fake-Firestore smoke, ported in-repo against
``pi/tests/fakes.py``: this is a production-write tool, so its write
contract is pinned here — dry-run writes nothing, ``--apply`` touches only
the ``wh`` field through single-field ``update()`` (never ``set()``), a
rerun finds nothing to repair, and every refusal path exits non-zero
without building a client. The era bound (``--before``) and the
GAC-vs-bridge-key project refusal are pinned end to end.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import repair_session_wh as cli  # noqa: E402
from fakes import FakeDB  # noqa: E402

UTC = timezone.utc
# The default --before: the instant the Pi restarted onto the #195 bridge.
DEPLOY = datetime(2026, 11, 20, 18, 41, 52, tzinfo=UTC)
PRE_FIX_END = datetime(2026, 11, 19, 6, 30, tzinfo=UTC)  # strictly before it
POST_FIX_END = datetime(2026, 11, 20, 19, 12, tzinfo=UTC)  # after it


class RepairDB(FakeDB):
    """The fake plus the ``project`` attribute the report header reads."""

    project = "chelevse-test"


def undercount(ended_at):
    """The 15956-vs-48038 document shape, closed at ``ended_at``.

    Post-#195 this exact shape is the reset-to-exactly-0 corner (a list
    legitimately exceeding wh); pre-#195 it is the undercount the tool
    exists to repair. Only the close instant separates them.
    """
    start = ended_at - timedelta(hours=4)
    span = timedelta(minutes=30)
    return {
        "started_at": start,
        "ended_at": ended_at,
        "wh": 15956,
        "intervals": [
            {"started_at": start, "ended_at": start + span, "wh": 24019.0},
            {
                "started_at": start + timedelta(hours=2),
                "ended_at": start + timedelta(hours=2) + span,
                "wh": 24019.0,
            },
        ],
    }


def seeded_db():
    """One eligible legacy document and one post-bound lookalike."""
    return RepairDB(
        {
            "sessions": {
                "s_legacy": undercount(PRE_FIX_END),
                "s_post": undercount(POST_FIX_END),
            }
        }
    )


def write_key(directory, name="service-account.json", project="chelevse-test"):
    """A real key file on disk, so the CLI's ``is_file()`` checks pass."""
    path = Path(directory) / name
    path.write_text(json.dumps({"project_id": project}))
    return path


def run_cli(argv, db, key):
    """``main(argv)`` against the fake client; captured stdout and code."""
    out = io.StringIO()
    with (
        redirect_stdout(out),
        mock.patch.object(cli, "resolve_service_account_key", return_value=key),
        mock.patch.object(cli, "make_client", return_value=db),
    ):
        code = cli.main(argv)
    return code, out.getvalue()


class WriteContract(unittest.TestCase):
    """Dry-run writes nothing; --apply writes only wh via update(); rerun 0."""

    def setUp(self):
        self.db = seeded_db()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.key = write_key(tmp.name)

    def test_dry_run_writes_nothing(self):
        code, out = run_cli(["--dry-run"], self.db, self.key)
        self.assertEqual(code, 0)
        self.assertEqual(self.db.writes, [])
        self.assertIn("DRY RUN", out)

    def test_apply_writes_only_wh_of_eligible_documents_via_update(self):
        code, _ = run_cli(["--apply"], self.db, self.key)
        self.assertEqual(code, 0)
        self.assertTrue(self.db.writes)
        for kind, collection, doc_id, data, merge in self.db.writes:
            self.assertEqual(kind, "update", f"a {kind}() was issued")
            self.assertEqual(collection, "sessions")
            self.assertEqual(set(data), {"wh"})
            self.assertEqual(data["wh"], 48038.0)
        self.assertEqual({w[2] for w in self.db.writes}, {"s_legacy"})
        # The stored document keeps every other field exactly as it was.
        self.assertEqual(self.db.data["sessions"]["s_legacy"]["wh"], 48038.0)
        self.assertEqual(
            self.db.data["sessions"]["s_legacy"]["intervals"],
            undercount(PRE_FIX_END)["intervals"],
        )

    def test_the_post_bound_document_is_never_written_in_either_mode(self):
        for argv in ([], ["--apply"]):
            with self.subTest(mode=argv or "dry-run"):
                db = seeded_db()
                code, out = run_cli(argv, db, self.key)
                self.assertEqual(code, 0)
                self.assertNotIn("s_post", {w[2] for w in db.writes})
                self.assertEqual(db.data["sessions"]["s_post"]["wh"], 15956)
                self.assertIn("after-bound", out)
                self.assertIn("1 after-bound", out)

    def test_rerun_finds_nothing_to_repair(self):
        run_cli(["--apply"], self.db, self.key)
        after_first = list(self.db.writes)
        code, out = run_cli(["--apply"], self.db, self.key)
        self.assertEqual(code, 0)
        self.assertEqual(self.db.writes, after_first)
        self.assertIn("0 repaired", out)

    def test_missing_key_refusal_exits_1_in_both_modes(self):
        missing = self.key.parent / "absent.json"
        for argv in ([], ["--apply"]):
            with self.subTest(mode=argv or "dry-run"):
                err = io.StringIO()
                with (
                    redirect_stderr(err),
                    mock.patch.object(
                        cli, "resolve_service_account_key", return_value=missing
                    ),
                ):
                    code = cli.main(argv)
                self.assertEqual(code, 1)
                self.assertIn("no service-account key", err.getvalue())
                self.assertEqual(self.db.writes, [])

    def test_apply_refusal_names_the_apply_mode(self):
        err = io.StringIO()
        with (
            redirect_stderr(err),
            mock.patch.object(
                cli,
                "resolve_service_account_key",
                return_value=self.key.parent / "absent.json",
            ),
        ):
            code = cli.main(["--apply"])
        self.assertEqual(code, 1)
        self.assertIn("--apply refused", err.getvalue())

    def test_the_report_names_the_era_bound(self):
        _, out = run_cli([], self.db, self.key)
        self.assertIn("era bound: sessions ended strictly before", out)
        self.assertIn("2026-11-20T18:41:52", out)

    def test_the_report_shows_each_rows_ended_era(self):
        # The dry-run table is the approval gate: every row carries the
        # ended_at era the bound judged it by, n/a when the document has
        # nothing parseable (a live session).
        db = RepairDB(
            {
                "sessions": {
                    "s_legacy": undercount(PRE_FIX_END),
                    "s_post": undercount(POST_FIX_END),
                    "s_live": {
                        "started_at": POST_FIX_END - timedelta(hours=1),
                        "wh": 15956,
                        "intervals": undercount(PRE_FIX_END)["intervals"],
                    },
                }
            }
        )
        code, out = run_cli([], db, self.key)
        self.assertEqual(code, 0)
        self.assertIn(
            f"{'s_legacy':<20} {'repair':<20} {'2026-11-19 06:30Z':<17} "
            f"{'15956.0':>12} {'48038.0':>13} {'48038.0':>12}",
            out,
        )
        self.assertIn(
            f"{'s_post':<20} {'after-bound':<20} {'2026-11-20 19:12Z':<17} "
            f"{'15956.0':>12} {'n/a':>13} {'-':>12}",
            out,
        )
        self.assertIn(
            f"{'s_live':<20} {'after-bound':<20} {'n/a':<17} "
            f"{'15956.0':>12} {'n/a':>13} {'-':>12}",
            out,
        )


class ArgumentContract(unittest.TestCase):
    """argparse: the exit-2 refusals and the --before bound."""

    def test_unknown_flag_exits_2(self):
        with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
            cli.parse_args(["--wet-run"])
        self.assertEqual(raised.exception.code, 2)

    def test_abbreviated_flag_exits_2(self):
        with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
            cli.parse_args(["--app"])
        self.assertEqual(raised.exception.code, 2)

    def test_conflicting_modes_exit_2(self):
        with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
            cli.parse_args(["--dry-run", "--apply"])
        self.assertEqual(raised.exception.code, 2)

    def test_malformed_before_exits_2(self):
        with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
            cli.parse_args(["--before", "yesterday"])
        self.assertEqual(raised.exception.code, 2)

    def test_the_default_bound_is_the_deploy_instant(self):
        self.assertEqual(cli.DEFAULT_BEFORE, "2026-11-20T18:41:52Z")
        args = cli.parse_args([])
        self.assertEqual(args.before, DEPLOY.timestamp() * 1000.0)
        self.assertEqual(
            args.before, cli.parse_args(["--before", cli.DEFAULT_BEFORE]).before
        )

    def test_an_explicit_bound_parses_to_epoch_ms(self):
        args = cli.parse_args(["--before", "2026-11-01T00:00:00Z"])
        self.assertEqual(
            args.before, datetime(2026, 11, 1, tzinfo=UTC).timestamp() * 1000.0
        )


class ProjectMismatchRefusal(unittest.TestCase):
    """GAC and the bridge key naming different projects: refuse, exit 1."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        # A hermetic bridge.env: the real private/bridge.env must not leak
        # FIREBASE_SERVICE_ACCOUNT into these tests.
        self.quiet_env = Path(self.dir) / "bridge.env"

    def key(self, name, project):
        return write_key(self.dir, name, project)

    def environ(self, gac=None, fsa=None):
        env = {}
        if gac is not None:
            env["GOOGLE_APPLICATION_CREDENTIALS"] = str(gac)
        if fsa is not None:
            env["FIREBASE_SERVICE_ACCOUNT"] = str(fsa)
        return env

    def run_with_environ(self, argv, environ, db=None, client=None):
        out, err = io.StringIO(), io.StringIO()
        make = client if client is not None else mock.MagicMock(return_value=db)
        with (
            mock.patch.dict(os.environ, environ, clear=True),
            mock.patch.object(cli, "BRIDGE_ENV", self.quiet_env),
            mock.patch.object(cli, "make_client", make),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            code = cli.main(argv)
        return code, out.getvalue(), err.getvalue(), make

    def test_differing_projects_refuse_in_both_modes(self):
        gac = self.key("deploy.json", "deploy-proj")
        fsa = self.key("bridge.json", "bridge-proj")
        guard = mock.MagicMock(side_effect=AssertionError("client built"))
        for argv in ([], ["--apply"]):
            with self.subTest(mode=argv or "dry-run"):
                code, _, err, _ = self.run_with_environ(
                    argv, self.environ(gac, fsa), client=guard
                )
                self.assertEqual(code, 1)
                self.assertIn(str(gac), err)
                self.assertIn(str(fsa), err)
                self.assertIn("deploy-proj", err)
                self.assertIn("bridge-proj", err)
                self.assertIn("unset GOOGLE_APPLICATION_CREDENTIALS", err)
        guard.assert_not_called()

    def test_the_same_project_proceeds(self):
        gac = self.key("deploy.json", "chelevse-test")
        fsa = self.key("bridge.json", "chelevse-test")
        db = seeded_db()
        code, out, _, _ = self.run_with_environ([], self.environ(gac, fsa), db=db)
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN", out)
        self.assertEqual(db.writes, [])

    def test_gac_alone_still_wins_without_a_refusal(self):
        # No second key, no cross-check: the exported variable is the
        # operator's explicit choice and keeps its documented precedence.
        gac = self.key("deploy.json", "deploy-proj")
        db = seeded_db()
        code, _, _, client = self.run_with_environ([], self.environ(gac=gac), db=db)
        self.assertEqual(code, 0)
        client.assert_called_once_with(gac)

    def test_an_unreadable_bridge_key_does_not_refuse(self):
        gac = self.key("deploy.json", "deploy-proj")
        db = seeded_db()
        code, _, _, client = self.run_with_environ(
            [], self.environ(gac, self.dir / "missing.json"), db=db
        )
        self.assertEqual(code, 0)
        client.assert_called_once_with(gac)


if __name__ == "__main__":
    unittest.main()
