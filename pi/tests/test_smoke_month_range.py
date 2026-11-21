"""Offline tests for ``smoke_month_range.py`` (#208).

Everything except the live Firestore calls, exactly the split the smoke's
pure-helper structure exists for: month bounds (December/January rollover
both directions), the client-side control scan, the string-probe
classification (a server-style rejection is a finding, never a crash), the
DocumentReference-form equality (real ``FakeCollection.document()``
bounds -- ``FakeQuery`` unwraps reference ``__name__`` bounds since the
phase-4a fix), the production-path verdicts through ``bridge._month_totals``
itself (reference bounds since the same fix), the boundary spot-checks, the
verdict/summary composition, the CLI contract and the credentials refusals.
Every scenario also pins the zero-writes invariant (#161): ``FakeDB.writes``
stays empty.
"""

import argparse
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
import smoke_month_range as smoke  # noqa: E402
from fakes import FakeCollection, FakeDB, FakeDocument, FakeQuery  # noqa: E402


class RefDB(FakeDB):
    """FakeDB with the ``project`` attribute the smoke's header reads."""

    project = "chelevse-test"


class _RejectingCollection(FakeCollection):
    """Production's documented contract: ``__name__`` bounds must be
    references. A plain-string bound raises the server's own refusal at
    query construction -- inside the smoke's classification try."""

    def where(self, filter=None):
        if (
            filter is not None
            and filter.field_path == "__name__"
            and not isinstance(filter.value, FakeDocument)
        ):
            raise ValueError("__key__ filter value must be a Key")
        return FakeQuery(self._db, self.name).where(filter=filter)


class RejectingDB(FakeDB):
    """FakeDB enforcing production's reference-only ``__name__`` contract."""

    project = "chelevse-test"

    def collection(self, name):
        return _RejectingCollection(self, name)


class _LeakyRange:
    """A query that ignores its filters and returns every document; chainable
    because the smoke builds its ranges as ``where().where()``."""

    def __init__(self, db, name):
        self._rows = FakeQuery(db, name).stream()

    def where(self, filter=None):
        return self

    def stream(self):
        return self._rows


class _LeakyCollection(FakeCollection):
    """Every range leaks: the previous month's range includes the boundary
    document, the shape a non-exclusive upper bound would produce."""

    def where(self, filter=None):
        return _LeakyRange(self._db, self.name)


class LeakyDB(FakeDB):
    project = "chelevse-test"

    def collection(self, name):
        return _LeakyCollection(self, name)


class _ExplodingDB:
    """A client whose every stream raises: read failures FAIL, not crash."""

    def collection(self, name):
        return self

    def document(self, doc_id):
        return FakeDocument(self, "history", doc_id)

    def where(self, filter=None):
        return self

    def stream(self):
        raise RuntimeError("transport exploded")


def history_db(kwh_by_day, cls=RefDB):
    """A fake with the given history documents, ``{day: raw kwh}``.

    Only ``kwh`` is seeded: every reader under test (control scan, range
    read, ``_month_totals``) touches exactly that field.
    """
    return cls({"history": {day: {"kwh": kwh} for day, kwh in kwh_by_day.items()}})


NOVEMBER = {
    "2026-10-31": 5.0,
    "2026-11-01": 8.2,
    "2026-11-02": 9.0,
    "2026-12-01": 40.0,
}
NOVEMBER_CONTROL = {"2026-11-01": 8.2, "2026-11-02": 9.0}


class MonthBoundsTests(unittest.TestCase):
    """``month_bounds``: first day to first day, December into January."""

    def test_a_mid_month_day_collapses_to_the_first_day(self):
        self.assertEqual(
            smoke.month_bounds(date(2026, 11, 20)),
            (date(2026, 11, 1), date(2026, 12, 1)),
        )

    def test_december_rolls_into_january_of_the_next_year(self):
        self.assertEqual(
            smoke.month_bounds(date(2026, 12, 31)),
            (date(2026, 12, 1), date(2027, 1, 1)),
        )

    def test_a_datetime_is_collapsed_to_its_date(self):
        self.assertEqual(
            smoke.month_bounds(datetime(2026, 12, 15, 10, 30)),
            (date(2026, 12, 1), date(2027, 1, 1)),
        )


class DefaultMonthsTests(unittest.TestCase):
    """The default months: current + previous, January back into December."""

    def test_the_default_is_the_previous_then_current_month(self):
        self.assertEqual(
            smoke.default_months(date(2026, 11, 21)), [(2026, 10), (2026, 11)]
        )

    def test_january_rolls_back_into_december_of_the_previous_year(self):
        self.assertEqual(
            smoke.default_months(date(2027, 1, 3)), [(2026, 12), (2027, 1)]
        )


class ControlScanTests(unittest.TestCase):
    """The independent control: pure string filtering, the bridge's kwh
    rule (numeric only, bool excluded), skipped docs noted."""

    def test_keeps_exactly_the_ids_in_range_with_the_documented_bounds(self):
        db = history_db({**NOVEMBER, "2026-11-30": 3})
        docs, skipped = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        # Lower bound inclusive, upper exclusive, ints read as floats.
        self.assertEqual(
            docs, {"2026-11-01": 8.2, "2026-11-02": 9.0, "2026-11-30": 3.0}
        )
        self.assertEqual(skipped, [])

    def test_non_numeric_kwh_is_noted_and_skipped(self):
        db = history_db(
            {
                "2026-11-01": 8.2,
                "2026-11-02": "8.2",
                "2026-11-03": None,
                "2026-11-04": True,
            }
        )
        docs, skipped = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        self.assertEqual(docs, {"2026-11-01": 8.2})
        self.assertEqual(skipped, ["2026-11-02", "2026-11-03", "2026-11-04"])


class StringProbeTests(unittest.TestCase):
    """The #207 string-bound probe: matched / rejected / mismatch, and a
    rejection is classified, never fatal."""

    def test_a_match_against_the_control_reports_the_count(self):
        db = history_db(NOVEMBER)
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        self.assertEqual(
            smoke.probe_string_form(db, "2026-11-01", "2026-12-01", control),
            {"outcome": "matched", "detail": "matched control (2 docs)"},
        )

    def test_a_server_style_rejection_is_classified_not_fatal(self):
        db = history_db(NOVEMBER, cls=RejectingDB)
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        verdict = smoke.probe_string_form(db, "2026-11-01", "2026-12-01", control)
        self.assertEqual(verdict["outcome"], "rejected")
        self.assertIn("ValueError", verdict["detail"])
        self.assertIn("__key__ filter value must be a Key", verdict["detail"])

    def test_a_mismatch_names_extra_missing_and_differing_values(self):
        detail = smoke.describe_mismatch(
            {"2026-11-01": 8.2, "2026-11-02": 9.0, "2026-11-03": 1.0},
            {"2026-11-01": 8.2, "2026-11-02": 9.5, "2026-11-04": 2.0},
        )
        self.assertIn("3 docs vs control 3", detail)
        self.assertIn("extra ['2026-11-03']", detail)
        self.assertIn("missing ['2026-11-04']", detail)
        self.assertIn("2026-11-02 9.0!=9.5", detail)


class RefFormTests(unittest.TestCase):
    """The documented DocumentReference-bound form: equality with the
    control, the same kwh rule, failures FAIL without raising."""

    def test_reference_bounds_select_exactly_the_control(self):
        db = history_db(NOVEMBER)
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        docs, skipped = smoke.range_docs(
            smoke.ref_form(db.collection("history"), "2026-11-01", "2026-12-01")
        )
        self.assertEqual(docs, control)
        self.assertEqual(skipped, [])
        self.assertEqual(
            smoke.verify_ref_form(db, "2026-11-01", "2026-12-01", control),
            {"ok": True, "detail": "equals control (2 docs)"},
        )

    def test_range_reads_apply_the_same_non_numeric_kwh_rule(self):
        db = history_db({"2026-11-01": 8.2, "2026-11-02": "x", "2026-12-01": 40.0})
        docs, skipped = smoke.range_docs(
            smoke.ref_form(db.collection("history"), "2026-11-01", "2026-12-01")
        )
        self.assertEqual(docs, {"2026-11-01": 8.2})
        self.assertEqual(skipped, ["2026-11-02"])

    def test_extra_documents_fail_the_check(self):
        db = history_db(NOVEMBER, cls=LeakyDB)
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        verdict = smoke.verify_ref_form(db, "2026-11-01", "2026-12-01", control)
        self.assertFalse(verdict["ok"])
        self.assertIn("MISMATCH 4 docs vs control 2", verdict["detail"])
        self.assertIn("extra ['2026-10-31', '2026-12-01']", verdict["detail"])

    def test_a_read_failure_fails_the_check_without_raising(self):
        verdict = smoke.verify_ref_form(
            _ExplodingDB(), "2026-11-01", "2026-12-01", NOVEMBER_CONTROL
        )
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["detail"], "RuntimeError: transport exploded")


class ProductionPathTests(unittest.TestCase):
    """``bridge._month_totals`` itself, through the smoke's stub sink."""

    def test_the_control_sum_comes_back_with_zero_pending(self):
        # The fixed bridge sends reference bounds; FakeQuery unwraps their
        # ids, so the plain fake and the live server agree with it.
        db = history_db(NOVEMBER)
        expected = 8.2 + 9.0
        verdict = smoke.verify_production(bridge, db, 2026, 11, expected)
        self.assertTrue(verdict["ok"])
        self.assertIn("== control sum", verdict["detail"])
        self.assertEqual(db.writes, [])

    def test_reference_bounds_pass_the_servers_string_rejection(self):
        # RejectingDB enforces the live contract found on 2026-11-21: the
        # #207 string form raises "__key__ filter value must be a Key".
        # The fixed production path sends DocumentReference bounds, so it
        # returns the control sum where the pre-fix path returned None.
        db = history_db(NOVEMBER, cls=RejectingDB)
        out = io.StringIO()
        with redirect_stdout(out):
            verdict = smoke.verify_production(bridge, db, 2026, 11, 17.2)
        self.assertTrue(verdict["ok"])
        self.assertIn("== control sum", verdict["detail"])
        self.assertEqual(db.writes, [])

    def test_a_swallowed_read_failure_is_reported_as_a_fail(self):
        out = io.StringIO()
        with redirect_stdout(out):  # _month_totals journals its failure line
            verdict = smoke.verify_production(bridge, _ExplodingDB(), 2026, 11, 17.2)
        self.assertEqual(
            verdict,
            {
                "ok": False,
                "detail": "returned None (month read failed - journal line above)",
            },
        )

    def test_a_wrong_sum_or_pending_fails(self):
        db = history_db(NOVEMBER)
        verdict = smoke.verify_production(bridge, db, 2026, 11, 999.0)
        self.assertFalse(verdict["ok"])
        self.assertIn("expected (999.0, 0.0)", verdict["detail"])


class BoundaryTests(unittest.TestCase):
    """The spot-checks: inclusive lower bound, exclusive upper bound,
    skipped loudly when the boundary document is absent."""

    def test_both_bounds_pass_when_the_first_day_document_exists(self):
        db = history_db(NOVEMBER)
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        verdict = smoke.boundary_checks(db, "2026-11-01", "2026-12-01", control)
        self.assertEqual(verdict["status"], "pass")
        self.assertIn("2026-10-01 range excludes history/2026-11-01", verdict["detail"])
        self.assertIn("upper bound exclusive", verdict["detail"])
        self.assertIn("own range includes it", verdict["detail"])
        self.assertIn("lower bound inclusive", verdict["detail"])

    def test_januarys_previous_month_reaches_back_into_december(self):
        db = history_db({"2026-12-31": 5.0, "2027-01-01": 8.2})
        control, _ = smoke.scan_control(db, "2027-01-01", "2027-02-01")
        verdict = smoke.boundary_checks(db, "2027-01-01", "2027-02-01", control)
        self.assertEqual(verdict["status"], "pass")
        self.assertIn("2026-12-01 range excludes history/2027-01-01", verdict["detail"])

    def test_no_first_day_document_skips_loudly(self):
        db = history_db({"2026-11-02": 9.0})
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        self.assertEqual(
            smoke.boundary_checks(db, "2026-11-01", "2026-12-01", control),
            {
                "status": "skipped",
                "detail": "no history/2026-11-01 document - bounds not exercised",
            },
        )

    def test_a_leaky_upper_bound_fails_the_check(self):
        db = history_db(NOVEMBER, cls=LeakyDB)
        control, _ = smoke.scan_control(db, "2026-11-01", "2026-12-01")
        verdict = smoke.boundary_checks(db, "2026-11-01", "2026-12-01", control)
        self.assertEqual(verdict["status"], "fail")
        self.assertIn("INCLUDES history/2026-11-01", verdict["detail"])
        self.assertIn("upper bound not exclusive", verdict["detail"])


class RunMonthTests(unittest.TestCase):
    """The five checks composed per month; the gates and only the gates."""

    def test_a_green_fake_month_passes_every_gate_without_writes(self):
        db = history_db(NOVEMBER)
        out = io.StringIO()
        with redirect_stdout(out):
            result = smoke.run_month(db, bridge, 2026, 11)
        self.assertTrue(result["ok"])
        self.assertEqual(result["label"], "2026-11")
        self.assertEqual(result["control"]["count"], 2)
        self.assertAlmostEqual(result["control"]["sum"], 8.2 + 9.0)
        self.assertEqual(result["string_probe"]["outcome"], "matched")
        self.assertTrue(result["ref_form"]["ok"])
        self.assertTrue(result["production"]["ok"])
        self.assertEqual(result["boundary"]["status"], "pass")
        self.assertEqual(smoke.failing_checks(result), [])
        self.assertEqual(db.writes, [])

    def test_a_string_probe_rejection_is_a_finding_not_a_failure(self):
        # RejectingDB raises on the #207 string form -- the live 2026-11-21
        # outcome -- while the fixed production path sends reference bounds
        # and passes; the probe's rejection never gates the month.
        db = history_db(NOVEMBER, cls=RejectingDB)
        out = io.StringIO()
        with redirect_stdout(out):
            result = smoke.run_month(db, bridge, 2026, 11)
        self.assertTrue(result["ok"])
        self.assertEqual(result["string_probe"]["outcome"], "rejected")
        self.assertTrue(result["ref_form"]["ok"])
        self.assertTrue(result["production"]["ok"])
        self.assertEqual(result["boundary"]["status"], "pass")
        self.assertEqual(smoke.failing_checks(result), [])
        self.assertEqual(db.writes, [])

    def test_a_month_without_history_documents_fails_on_the_control_gate(self):
        # Empty evidence is no evidence: the vacuous ref-form and production
        # agreements must not carry the month.
        db = history_db({"2026-12-01": 40.0})
        out = io.StringIO()
        with redirect_stdout(out):
            result = smoke.run_month(db, bridge, 2026, 11)
        self.assertFalse(result["ok"])
        self.assertFalse(result["control"]["ok"])
        self.assertEqual(result["boundary"]["status"], "skipped")
        self.assertEqual(smoke.failing_checks(result), ["control empty"])


def green_month(label):
    """A result dict shaped like run_month's, for summary composition."""
    return {
        "label": label,
        "start_id": f"{label}-01",
        "next_id": f"{label}-28",
        "control": {"ok": True, "count": 2, "sum": 17.2, "skipped": []},
        "string_probe": {"outcome": "rejected", "detail": "rejected (...)"},
        "ref_form": {"ok": True, "detail": "equals control (2 docs)"},
        "production": {"ok": True, "detail": "archive 17.200 kWh == control sum"},
        "boundary": {"status": "pass", "detail": "..."},
        "ok": True,
    }


class SummaryTests(unittest.TestCase):
    """Verdict composition, the evidence summary line, exit-code mapping."""

    NOW = datetime(2026, 11, 21, 9, 30, tzinfo=timezone.utc)

    def test_print_summary_line_carries_date_project_and_months(self):
        out = io.StringIO()
        with redirect_stdout(out):
            passed = smoke.print_summary(
                [green_month("2026-10"), green_month("2026-11")],
                "chelevse-test",
                now=self.NOW,
            )
        self.assertTrue(passed)
        text = out.getvalue()
        self.assertIn("SMOKE PASS", text)
        self.assertIn("2026-11-21 09:30 +0000", text)
        self.assertIn("project chelevse-test", text)
        self.assertIn("months 2026-10, 2026-11", text)

    def test_any_failed_month_fails_and_names_its_checks(self):
        results = [green_month("2026-10")]
        failed = green_month("2026-11")
        failed["production"] = {
            "ok": False,
            "detail": "returned None (month read failed - journal line above)",
        }
        failed["boundary"] = {"status": "fail", "detail": "..."}
        failed["ok"] = False
        results.append(failed)
        out = io.StringIO()
        with redirect_stdout(out):
            passed = smoke.print_summary(results, "chelevse-test", now=self.NOW)
        self.assertFalse(passed)
        text = out.getvalue()
        self.assertIn("SMOKE FAIL", text)
        self.assertIn("2026-11: production path, boundary spot-checks", text)

    def test_failing_checks_lists_only_the_gates_in_report_order(self):
        result = green_month("2026-11")
        self.assertEqual(smoke.failing_checks(result), [])
        result["control"]["ok"] = False
        result["ref_form"]["ok"] = False
        result["production"]["ok"] = False
        result["boundary"] = {"status": "fail", "detail": "..."}
        self.assertEqual(
            smoke.failing_checks(result),
            ["control empty", "ref form", "production path", "boundary spot-checks"],
        )

    def test_a_skipped_boundary_check_does_not_fail_the_month(self):
        result = green_month("2026-03")  # a month with no first-day doc
        result["boundary"] = {"status": "skipped", "detail": "..."}
        result["ok"] = (
            result["control"]["ok"]
            and result["ref_form"]["ok"]
            and result["production"]["ok"]
            and result["boundary"]["status"] != "fail"
        )
        self.assertTrue(result["ok"])
        self.assertEqual(smoke.failing_checks(result), [])


class ArgumentContract(unittest.TestCase):
    """``--month YYYY-MM`` repeatable; malformed input exits 2."""

    def test_a_calendar_month_parses_to_year_and_month(self):
        self.assertEqual(smoke.parse_month("2026-01"), (2026, 1))
        self.assertEqual(smoke.parse_month("2026-12"), (2026, 12))

    def test_only_real_calendar_months_parse(self):
        for bad in ("2026-00", "2026-13", "2026-1", "2026/11", "november", "202611"):
            with self.subTest(value=bad):
                with self.assertRaises(argparse.ArgumentTypeError):
                    smoke.parse_month(bad)

    def test_the_flag_is_repeatable_and_defaults_to_none(self):
        self.assertEqual(
            smoke.parse_args(["--month", "2026-10", "--month", "2026-11"]).months,
            [(2026, 10), (2026, 11)],
        )
        self.assertIsNone(smoke.parse_args([]).months)

    def test_malformed_months_exit_2(self):
        for bad in ("2026-13", "2026-1", "november"):
            with self.subTest(value=bad), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    smoke.parse_args(["--month", bad])
                self.assertEqual(raised.exception.code, 2)

    def test_abbreviated_flags_exit_2(self):
        with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
            smoke.parse_args(["--mont", "2026-11"])
        self.assertEqual(raised.exception.code, 2)


class CliContract(unittest.TestCase):
    """main() end to end against the fake client, plus the refusals."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.key = self.write_key("service-account.json")
        # A hermetic bridge.env: the real private/bridge.env must not leak
        # FIREBASE_SERVICE_ACCOUNT into these tests.
        self.quiet_env = self.dir / "bridge.env"

    def write_key(self, name, project="chelevse-test"):
        path = self.dir / name
        path.write_text(json.dumps({"project_id": project}))
        return path

    def run_main(self, argv, db, environ=None, key=None, client=None):
        out, err = io.StringIO(), io.StringIO()
        make = client if client is not None else mock.MagicMock(return_value=db)
        with (
            mock.patch.dict(os.environ, environ or {}, clear=True),
            mock.patch.object(smoke, "BRIDGE_ENV", self.quiet_env),
            mock.patch.object(
                smoke, "resolve_service_account_key", return_value=key or self.key
            ),
            mock.patch.object(smoke, "make_client", make),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            code = smoke.main(argv)
        return code, out.getvalue(), err.getvalue(), make

    def test_a_green_fake_month_exits_0_with_the_evidence_line(self):
        db = history_db(NOVEMBER)
        code, out, _, client = self.run_main(["--month", "2026-11"], db)
        self.assertEqual(code, 0)
        self.assertEqual(db.writes, [])
        self.assertIn("project chelevse-test", out)
        self.assertIn("reads only, never writes", out)
        self.assertIn("months 2026-11 (local)", out)
        self.assertIn("SMOKE PASS", out)
        client.assert_called_once_with(self.key)

    def test_requested_months_are_deduplicated_and_sorted(self):
        db = history_db(NOVEMBER)
        code, out, _, _ = self.run_main(
            ["--month", "2026-11", "--month", "2026-10", "--month", "2026-11"], db
        )
        self.assertEqual(code, 0)
        self.assertIn("months 2026-10, 2026-11 (local)", out)

    def test_an_empty_month_exits_1(self):
        db = history_db({"2026-12-01": 40.0})
        code, out, _, _ = self.run_main(["--month", "2026-11"], db)
        self.assertEqual(code, 1)
        self.assertIn("SMOKE FAIL", out)
        self.assertIn("2026-11: control empty", out)

    def test_a_missing_key_refuses_before_any_client(self):
        guard = mock.MagicMock(side_effect=AssertionError("client built"))
        db = history_db(NOVEMBER)
        missing = self.key.parent / "absent.json"
        code, _, err, client = self.run_main(
            ["--month", "2026-11"], db, key=missing, client=guard
        )
        self.assertEqual(code, 1)
        self.assertIn("no service-account key", err)
        self.assertIn("service-account.json", err)  # platform-neutral form
        client.assert_not_called()

    def test_differing_credential_projects_refuse_before_any_client(self):
        gac = self.write_key("deploy.json", "deploy-proj")
        fsa = self.write_key("bridge.json", "bridge-proj")
        guard = mock.MagicMock(side_effect=AssertionError("client built"))
        db = history_db(NOVEMBER)
        environ = {
            "GOOGLE_APPLICATION_CREDENTIALS": str(gac),
            "FIREBASE_SERVICE_ACCOUNT": str(fsa),
        }
        code, _, err, client = self.run_main(
            ["--month", "2026-11"], db, environ=environ, client=guard
        )
        self.assertEqual(code, 1)
        self.assertIn(str(gac), err)
        self.assertIn(str(fsa), err)
        self.assertIn("deploy-proj", err)
        self.assertIn("bridge-proj", err)
        self.assertIn("unset GOOGLE_APPLICATION_CREDENTIALS", err)
        client.assert_not_called()


class ReadOnlyContract(unittest.TestCase):
    """The module's own source pins the read-only guarantee (#161)."""

    def test_the_smoke_source_contains_no_firestore_write_calls(self):
        source = Path(smoke.__file__).read_text()
        for call in (".set(", ".update(", ".delete("):
            with self.subTest(call=call):
                self.assertNotIn(call, source)


if __name__ == "__main__":
    unittest.main()
