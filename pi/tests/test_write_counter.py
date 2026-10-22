"""Write-counter tests (issue #96): the write budget made verifiable.

No broker, charger, Firestore or FCM is touched: the write sites run against
the in-memory fakes with injected counters and clocks, so every rolling
window boundary, dedupe interval and tripwire crossing is tested at exact
simulated times.
"""

import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import FakeDB, FakeResponse, FakeSession  # noqa: E402
from test_mqtt import _RecordingNotifier, _StopAfter, status_payload  # noqa: E402
from test_write_policy import _Clock  # noqa: E402

try:
    from google.api_core import exceptions as google_exceptions
except ImportError:  # pragma: no cover - the venv always has firebase-admin
    google_exceptions = None


def quota_429():
    """The direct form: google's ResourceExhausted with code 429."""
    return google_exceptions.ResourceExhausted("429 Quota exceeded.")


def quota_retry_error():
    """The journal's form: the SDK's RetryError wrapping the 429.

    ``RetryError: Timeout of 60.0s exceeded, last exception: 429 Quota
    exceeded.`` is how the quota outage actually surfaced (issue #91).
    """
    return google_exceptions.RetryError(
        "Timeout of 60.0s exceeded, last exception: 429 Quota exceeded.",
        quota_429(),
    )


class _Code429(Exception):
    """Any exception shaped like google's: a 429 status code."""

    code = 429


class QuotaExceededTests(unittest.TestCase):
    """The failure detector: both quota forms, and nothing else."""

    @unittest.skipIf(google_exceptions is None, "google.api_core missing")
    def test_the_direct_resource_exhausted_form_counts(self):
        self.assertTrue(bridge.quota_exceeded(quota_429()))

    @unittest.skipIf(google_exceptions is None, "google.api_core missing")
    def test_the_retry_error_wrapped_form_counts(self):
        self.assertTrue(bridge.quota_exceeded(quota_retry_error()))

    def test_a_code_429_exception_counts(self):
        self.assertTrue(bridge.quota_exceeded(_Code429("anything")))

    def test_a_quota_shaped_message_counts_without_the_sdk_classes(self):
        self.assertTrue(bridge.quota_exceeded(RuntimeError("429 Quota exceeded.")))
        self.assertTrue(bridge.quota_exceeded(RuntimeError("RESOURCE_EXHAUSTED")))

    def test_other_failures_do_not_count(self):
        for exc in (
            RuntimeError("write failed"),
            TimeoutError("network broken"),
            ValueError("429 Wh is a plausible session"),
            google_exceptions.RetryError(
                "Timeout of 60.0s exceeded, last exception: ConnectionError.",
                ConnectionError("network broken"),
            )
            if google_exceptions is not None
            else RuntimeError("network broken"),
        ):
            with self.subTest(exc=exc):
                self.assertFalse(bridge.quota_exceeded(exc))

    def test_the_cause_chain_is_bounded(self):
        exc = RuntimeError("outer")
        head = exc
        for _ in range(20):  # a pathological cycle of wrappers
            head.__cause__ = RuntimeError("wrapper")
            head = head.__cause__
        head.__cause__ = exc
        self.assertFalse(bridge.quota_exceeded(exc))


class CounterBase(unittest.TestCase):
    def setUp(self):
        self.clock = _Clock()
        self.counter = bridge.WriteCounter(clock=self.clock)
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def quota_lines(self):
        return [line for line in self.logs if "quota exceeded" in line]

    def warning_lines(self):
        return [line for line in self.logs if "write budget warning" in line]


class WriteCounterCountingTests(CounterBase):
    def test_each_kind_counts_into_its_own_bucket(self):
        for kind in bridge.WRITE_KINDS:
            self.counter.record(kind)
        total, by_kind = self.counter.snapshot()
        self.assertEqual(total, len(bridge.WRITE_KINDS))
        self.assertEqual(by_kind, dict.fromkeys(bridge.WRITE_KINDS, 1))

    def test_an_unknown_kind_fails_loudly(self):
        with self.assertRaises(KeyError):
            self.counter.record("nonsense")

    def test_the_rolling_window_drops_a_write_25_hours_old(self):
        self.counter.record("status")
        self.clock.advance(25 * 3600)
        self.counter.record("history")
        total, by_kind = self.counter.snapshot()
        self.assertEqual(total, 1)
        self.assertEqual(by_kind["status"], 0)
        self.assertEqual(by_kind["history"], 1)

    def test_a_write_exactly_24_hours_old_has_aged_out(self):
        self.counter.record("status")
        self.clock.advance(bridge.WRITE_WINDOW_SEC)
        total, _by_kind = self.counter.snapshot()
        self.assertEqual(total, 0)

    def test_the_summary_renders_the_expected_shape(self):
        self.assertEqual(
            self.counter.summary(),
            "firestore writes: 0 in 24h "
            "(status=0 history=0 session=0 config=0 command=0 health=0 fcm=0)",
        )
        self.counter.record("status")
        self.counter.record("status")
        self.counter.record("history")
        self.assertEqual(
            self.counter.summary(),
            "firestore writes: 3 in 24h "
            "(status=2 history=1 session=0 config=0 command=0 health=0 fcm=0)",
        )


class SummaryIntervalTests(CounterBase):
    def test_the_first_summary_logs_at_once_then_once_per_interval(self):
        self.assertTrue(self.counter.maybe_summary())
        self.clock.advance(bridge.WRITE_SUMMARY_INTERVAL - 1)
        self.assertFalse(self.counter.maybe_summary())
        self.clock.advance(1)
        self.assertTrue(self.counter.maybe_summary())
        summaries = [
            line for line in self.logs if line.startswith("firestore writes:")
        ]
        self.assertEqual(len(summaries), 2)

    def test_the_summary_reports_the_windowed_counts(self):
        self.counter.record("status")
        self.counter.maybe_summary()
        self.assertIn("firestore writes: 1 in 24h (status=1 ", self.logs[-1])


class TripwireTests(CounterBase):
    def test_the_tripwire_fires_once_at_ten_thousand(self):
        self.assertEqual(self.counter.warning_at, bridge.WRITE_BUDGET_WARNING_AT)
        for _ in range(bridge.WRITE_BUDGET_WARNING_AT):
            self.counter.record("status")
        self.assertEqual(
            self.warning_lines(),
            [
                "write budget warning: 10000 writes in 24h "
                "— 50% of the free-tier quota"
            ],
        )
        # More writes in the same stretch stay silent.
        self.counter.record("status")
        self.counter.record("history")
        self.assertEqual(len(self.warning_lines()), 1)

    def test_below_the_threshold_never_warns(self):
        for _ in range(bridge.WRITE_BUDGET_WARNING_AT - 1):
            self.counter.record("status")
        self.assertEqual(self.warning_lines(), [])

    def test_the_tripwire_rearms_only_below_the_threshold_and_refires(self):
        for _ in range(bridge.WRITE_BUDGET_WARNING_AT):
            self.counter.record("status")
        self.assertEqual(len(self.warning_lines()), 1)
        # The window rolls everything out; the next stretch above the
        # threshold is a new crossing and warns again.
        self.clock.advance(bridge.WRITE_WINDOW_SEC + 1)
        self.counter.record("status")
        self.assertEqual(self.counter.snapshot()[0], 1)
        for _ in range(bridge.WRITE_BUDGET_WARNING_AT - 1):
            self.counter.record("status")
        self.assertEqual(len(self.warning_lines()), 2)


class QuotaFailureLogTests(CounterBase):
    def test_a_quota_failure_logs_the_distinct_line(self):
        self.assertTrue(self.counter.note_failure(quota_retry_error()))
        self.assertEqual(
            self.quota_lines(),
            [
                "firestore write quota exceeded (RESOURCE_EXHAUSTED) "
                "— writes paused until the daily reset"
            ],
        )

    def test_the_direct_form_logs_the_same_line(self):
        self.counter.note_failure(quota_429())
        self.assertEqual(len(self.quota_lines()), 1)

    def test_a_second_failure_inside_the_interval_does_not_relog(self):
        self.counter.note_failure(quota_retry_error())
        self.clock.advance(bridge.WRITE_SUMMARY_INTERVAL - 1)
        self.assertTrue(self.counter.note_failure(quota_429()))
        self.assertEqual(len(self.quota_lines()), 1)
        # After the interval, one line again.
        self.clock.advance(1)
        self.assertTrue(self.counter.note_failure(quota_retry_error()))
        self.assertEqual(len(self.quota_lines()), 2)

    def test_a_non_quota_failure_logs_nothing_and_reports_false(self):
        self.assertFalse(self.counter.note_failure(RuntimeError("write failed")))
        self.assertEqual(self.quota_lines(), [])


class CountedHelperTests(CounterBase):
    def test_a_successful_write_is_counted(self):
        result = self.counter.counted("status", lambda: "written")
        self.assertEqual(result, "written")
        total, by_kind = self.counter.snapshot()
        self.assertEqual(total, 1)
        self.assertEqual(by_kind["status"], 1)

    def test_a_failed_write_reraises_untouched_and_is_not_counted(self):
        boom = quota_retry_error()
        with self.assertRaises(type(boom)) as caught:
            self.counter.counted("status", mock.Mock(side_effect=boom))
        self.assertIs(caught.exception, boom)
        self.assertEqual(self.counter.snapshot()[0], 0)
        self.assertEqual(len(self.quota_lines()), 1)


class WriteSiteTests(unittest.TestCase):
    """Every write path records its own kind on success."""

    def setUp(self):
        self.db = FakeDB()
        self.clock = _Clock()
        self.counter = bridge.WriteCounter(clock=self.clock)
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def kinds(self):
        return self.counter.snapshot()[1]

    def test_a_status_publish_counts_status(self):
        sink = self.sink()
        sink.apply_status(bridge.parse_status(status_payload(total_energy=100)), "http")
        self.assertEqual(self.kinds()["status"], 1)

    def test_the_offline_edge_counts_status(self):
        sink = self.sink()
        sink.apply_status(bridge.parse_status(status_payload(total_energy=100)), "http")
        sink.apply_offline("gone")
        self.assertEqual(self.kinds()["status"], 2)

    def sink(self):
        tracker = bridge.StatusTracker(self.db, counter=self.counter)
        tracker.seeded = True
        tracker.has_state = True
        tracker.state = 1
        tracker.previous_state = 1
        tracker.charger_online = True
        return bridge.StatusSink(
            self.db,
            tracker,
            _RecordingNotifier(),
            policy=bridge.WritePolicy(
                bridge.WritePolicyConfig(10.0, 20.0, 100.0), clock=self.clock
            ),
            counter=self.counter,
        )

    def test_a_history_flush_write_counts_history(self):
        accumulator = bridge.HistoryAccumulator(self.db, counter=self.counter)
        accumulator.observe(1.5, bridge._localnow())
        self.assertTrue(accumulator.flush("test"))
        self.assertEqual(self.kinds()["history"], 1)

    def test_a_failed_history_flush_counts_nothing(self):
        self.db.fail_writes = True
        accumulator = bridge.HistoryAccumulator(self.db, counter=self.counter)
        accumulator.observe(1.5, bridge._localnow())
        self.assertFalse(accumulator.flush("test"))
        self.assertEqual(self.kinds()["history"], 0)

    def test_a_session_write_counts_session(self):
        tracker = bridge.StatusTracker(self.db, counter=self.counter)
        moment = datetime(2026, 10, 22, tzinfo=UTC)
        tracker._write_session(
            "s1", {"started_at": moment, "ended_at": moment, "wh": 100.0, "elapsed": 1}
        )
        self.assertEqual(self.kinds()["session"], 1)

    def test_a_config_sync_counts_config(self):
        transport = bridge.ChargerTransport(
            FakeSession([FakeResponse(200, {"firmware": "master"})])
        )
        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.config_loop(
                self.db,
                bridge.ChargerHost("charger"),
                None,
                transport,
                60,
                counter=self.counter,
            )
        self.assertEqual(self.kinds()["config"], 1)

    def test_an_acked_command_counts_command(self):
        self.run_one_command([FakeResponse(200)])
        self.assertEqual(self.kinds()["command"], 1)

    def test_a_stale_command_counts_command(self):
        self.run_one_command([])
        self.assertEqual(self.db.data["commands"]["a"]["status"], "failed")
        self.assertEqual(self.kinds()["command"], 1)

    def run_one_command(self, responses):
        command = {
            "status": "pending",
            "type": "pause",
            "created_at": datetime.now(UTC)
            - timedelta(seconds=bridge.COMMAND_MAX_AGE + 1),
        }
        self.db = FakeDB({"commands": {"a": command}})
        transport = bridge.ChargerTransport(FakeSession(responses))
        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.command_loop(
                self.db,
                bridge.ChargerHost("charger"),
                None,
                transport,
                0,
                None,
                None,
                self.counter,
            )

    def test_a_transport_health_write_counts_health(self):
        bridge.write_transport_health(
            self.db, "mqtt", True, counter=self.counter
        )
        self.assertEqual(self.kinds()["health"], 1)

    def test_a_watchdog_health_write_counts_health(self):
        watchdog = bridge.Watchdog(
            self.db,
            bridge.ChargerHost("charger"),
            None,
            bridge.ChargerTransport(FakeSession()),
            _RecordingNotifier(),
            bridge.WatchdogConfig(enabled=False),
            counter=self.counter,
        )
        watchdog.write_health(True, True)
        self.assertEqual(self.kinds()["health"], 1)

    def test_a_pruned_fcm_token_counts_fcm(self):
        self.db = FakeDB({"fcmTokens": {"dead": {"token": "dead"}}})

        def fake_send(message):
            raise bridge.messaging.UnregisteredError("gone")

        with mock.patch.object(bridge.messaging, "send", side_effect=fake_send):
            bridge.notify(self.db, "Charging stopped", counter=self.counter)
        self.assertEqual(set(self.db.data["fcmTokens"]), set())
        self.assertEqual(self.kinds()["fcm"], 1)


def timedelta_secs(seconds):
    from datetime import timedelta

    return timedelta(seconds=seconds)


class HealthExposureTests(unittest.TestCase):
    """writes_24h rides the existing health writes; the counter adds none."""

    def setUp(self):
        self.db = FakeDB()
        self.clock = _Clock()
        self.counter = bridge.WriteCounter(clock=self.clock)
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def health_writes(self):
        return [w for w in self.db.writes if w[:3] == ("set", "status", "health")]

    def test_the_transport_health_merge_carries_the_counts(self):
        self.counter.record("status")
        self.counter.record("status")
        self.counter.record("history")
        bridge.write_transport_health(
            self.db, "http", False, counter=self.counter
        )
        (write,) = self.health_writes()
        self.assertEqual(write[3]["writes_24h"], 3)
        self.assertEqual(write[3]["writes_by_kind"]["status"], 2)
        self.assertEqual(write[3]["writes_by_kind"]["history"], 1)
        self.assertEqual(write[4], True)  # merge semantics kept

    def test_the_watchdog_health_merge_carries_the_counts(self):
        for _ in range(4):
            self.counter.record("status")
        watchdog = bridge.Watchdog(
            self.db,
            bridge.ChargerHost("charger"),
            None,
            bridge.ChargerTransport(FakeSession()),
            _RecordingNotifier(),
            bridge.WatchdogConfig(enabled=False),
            counter=self.counter,
        )
        watchdog.write_health(False, True)
        (write,) = self.health_writes()
        self.assertEqual(write[3]["writes_24h"], 4)
        self.assertEqual(write[3]["writes_by_kind"]["status"], 4)

    def test_the_counter_itself_never_writes(self):
        # A day of records and summaries -- every counter surface -- against
        # a live FakeDB: the only Firestore writes are the ones the write
        # sites made, and here there are none.
        tracker = bridge.StatusTracker(self.db, counter=self.counter)
        tracker.seeded = True
        sink = bridge.StatusSink(
            self.db,
            tracker,
            _RecordingNotifier(),
            policy=bridge.WritePolicy(
                bridge.WritePolicyConfig(10.0, 20.0, 100.0), clock=self.clock
            ),
            counter=self.counter,
        )
        sink.apply_status(bridge.parse_status(status_payload(total_energy=100)), "http")
        before = len(self.db.writes)
        for minute in range(24 * 60):
            self.clock.advance(60)
            self.counter.record("status")
            self.counter.maybe_summary()
            self.counter.snapshot()
            self.counter.health_fields()
        self.assertEqual(len(self.db.writes), before)
        self.assertNotIn("db", vars(self.counter))


class SiteQuotaFailureTests(unittest.TestCase):
    """A quota failure at a real write site: the distinct line, deduped."""

    def setUp(self):
        self.db = FakeDB()
        self.clock = _Clock()
        self.counter = bridge.WriteCounter(clock=self.clock)
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def quota_lines(self):
        return [line for line in self.logs if "quota exceeded" in line]

    def test_a_quota_failed_session_write_keeps_pending_and_logs_the_line(self):
        tracker = bridge.StatusTracker(self.db, counter=self.counter)
        self.db.write_error = quota_retry_error()
        moment = datetime(2026, 10, 22, tzinfo=UTC)
        tracker._write_session(
            "s1", {"started_at": moment, "ended_at": moment, "wh": 100.0, "elapsed": 1}
        )
        self.assertIsNotNone(tracker.pending_session)
        self.assertEqual(
            self.quota_lines(),
            [
                "firestore write quota exceeded (RESOURCE_EXHAUSTED) "
                "— writes paused until the daily reset"
            ],
        )
        # The detail log keeps its own line too.
        self.assertTrue(any("session write failed" in line for line in self.logs))

    def test_the_quota_line_is_deduped_across_sites_within_the_interval(self):
        tracker = bridge.StatusTracker(self.db, counter=self.counter)
        moment = datetime(2026, 10, 22, tzinfo=UTC)
        record = {"started_at": moment, "ended_at": moment, "wh": 1.0, "elapsed": 1}
        self.db.write_error = quota_retry_error()
        tracker._write_session("s1", record)
        accumulator = bridge.HistoryAccumulator(self.db, counter=self.counter)
        accumulator.observe(1.5, bridge._localnow())
        self.assertFalse(accumulator.flush("test"))
        self.assertEqual(len(self.quota_lines()), 1)
        # After the interval, the next quota failure says so again.
        self.db.write_error = quota_429()
        self.clock.advance(bridge.WRITE_SUMMARY_INTERVAL)
        tracker._write_session("s2", record)
        self.assertEqual(len(self.quota_lines()), 2)

    def test_a_non_quota_failed_session_write_keeps_pending_without_the_line(self):
        tracker = bridge.StatusTracker(self.db, counter=self.counter)
        self.db.fail_writes = True
        moment = datetime(2026, 10, 22, tzinfo=UTC)
        tracker._write_session(
            "s1", {"started_at": moment, "ended_at": moment, "wh": 100.0, "elapsed": 1}
        )
        self.assertIsNotNone(tracker.pending_session)
        self.assertEqual(self.quota_lines(), [])
        self.assertEqual(self.counter.snapshot()[0], 0)


class RunWiringTests(unittest.TestCase):
    """run() threads one counter through every write site."""

    def test_one_counter_reaches_tracker_notifier_watchdog_and_loops(self):
        db = FakeDB()
        loops = {}
        holder = {}

        def spy(name):
            def record(*args, **kwargs):
                loops[name] = args

            return record

        def status_loop_spy(
            db,
            host,
            auth,
            transport,
            interval,
            tracker,
            notifier,
            watchdog,
            mqtt=None,
            reconcile_interval=None,
            sink=None,
        ):
            loops["status"] = ()
            holder["sink"] = sink.counter
            holder["notifier"] = notifier.counter
            holder["tracker"] = tracker.counter
            holder["watchdog"] = watchdog.counter

        with mock.patch.object(
            bridge, "status_loop", side_effect=status_loop_spy
        ), mock.patch.object(
            bridge, "config_loop", side_effect=spy("config")
        ), mock.patch.object(
            bridge, "settings_loop", side_effect=spy("settings")
        ), mock.patch.object(
            bridge, "schedule_loop", side_effect=spy("schedule")
        ), mock.patch.object(
            bridge, "command_loop", side_effect=spy("command")
        ):
            bridge.run(
                db,
                bridge.ChargerHost("charger"),
                None,
                (10, 60, 60, 300, 5, 60),
                object(),
                bridge.WatchdogConfig(enabled=False),
            )
        sink_counter = holder["sink"]
        self.assertIsInstance(sink_counter, bridge.WriteCounter)
        # One instance, shared by every write site run() builds or calls.
        self.assertIs(holder["notifier"], sink_counter)
        self.assertIs(holder["tracker"], sink_counter)
        self.assertIs(holder["watchdog"], sink_counter)
        self.assertIs(loops["config"][-1], sink_counter)
        self.assertIs(loops["command"][-1], sink_counter)


if __name__ == "__main__":
    unittest.main()
