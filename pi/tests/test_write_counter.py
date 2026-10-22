"""Write-counter tests (issue #96): the write budget made verifiable.

No broker, charger, Firestore or FCM is touched: the write sites run against
the in-memory fakes with injected counters and clocks, so every rolling
window boundary, dedupe interval and tripwire crossing is tested at exact
simulated times.
"""

import inspect
import sys
import threading
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

import bridge  # noqa: E402
from fakes import FakeDB, FakeResponse, FakeSession  # noqa: E402
from test_mqtt import (  # noqa: E402
    _RecordingNotifier,
    _StopAfter,
    _StubMqtt,
    status_payload,
)
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


class _TickSensitiveStop(_StopAfter):
    """A stop stand-in that exercises its wait interval arithmetically.

    ``threading.Event.wait(timeout)`` on an unset event computes
    ``now + timeout`` — the operation that raised TypeError live when the
    write counter was bound into ``tick``. The stock ``_StopAfter`` ignores
    the interval entirely and would mask exactly that.
    """

    def wait(self, interval):
        time.monotonic() + interval  # TypeError unless the interval is a number
        return super().wait(interval)


def capture_run_wiring():
    """Run ``run()`` with every thread start captured, none executed.

    Returns ``(threads, command)``: each thread carries ``target`` and
    ``bound`` — the target's REAL signature bound with the exact args and
    kwargs ``run()`` passed, defaults applied — and ``command`` is the same
    binding for the directly called ``command_loop``. A mis-shaped call
    raises TypeError here, and a mis-mapped one shows up in the bound
    arguments, which is what the wiring tests assert.
    """
    threads = []
    command = {}
    real_command_loop = bridge.command_loop

    class RecordingThread:
        def __init__(self, target, args=(), kwargs=None, **_thread_options):
            self.target = target
            self.bound = inspect.signature(target).bind(*args, **(kwargs or {}))
            self.bound.apply_defaults()
            threads.append(self)

        def start(self):
            pass

    def record_command(*args, **kwargs):
        bound = inspect.signature(real_command_loop).bind(*args, **kwargs)
        bound.apply_defaults()
        command["bound"] = bound

    with mock.patch.object(
        bridge.threading, "Thread", RecordingThread
    ), mock.patch.object(bridge, "command_loop", side_effect=record_command):
        bridge.run(
            FakeDB(),
            bridge.ChargerHost("charger"),
            None,
            (10, 60, 60, 300, 5, 60),
            object(),
            bridge.WatchdogConfig(enabled=False),
        )
    return threads, command["bound"]


class RunWiringTests(unittest.TestCase):
    """run() threads one counter through every write site — bound, not positional.

    The shipped form of this suite asserted ``args[-1] is counter``: true
    positionally while that positional actually landed in ``tick``, so the
    mis-binding passed CI. Here every loop call is bound against its real
    signature and the parameter each value lands in is asserted.
    """

    def setUp(self):
        self.threads, self.command = capture_run_wiring()

    def loops(self):
        return {t.target.__name__: t.bound.arguments for t in self.threads}

    def shared_counter(self):
        return self.loops()["status_loop"]["sink"].counter

    def test_run_starts_exactly_the_four_poller_threads(self):
        self.assertEqual(
            set(self.loops()),
            {"status_loop", "config_loop", "settings_loop", "schedule_loop"},
        )
        self.assertEqual(self.command.arguments["interval"], 5)

    def test_config_counter_binds_by_name_and_tick_stays_a_number(self):
        config = self.loops()["config_loop"]
        # The shipped bug: the 9th positional landed in tick (a WriteCounter
        # where seconds belong) and counter fell to its None default.
        self.assertIsInstance(config["tick"], (int, float))
        self.assertIs(config["counter"], self.shared_counter())

    def test_one_counter_reaches_tracker_notifier_watchdog_and_loops(self):
        status = self.loops()["status_loop"]
        shared = self.shared_counter()
        self.assertIsInstance(shared, bridge.WriteCounter)
        self.assertIs(status["tracker"].counter, shared)
        self.assertIs(status["notifier"].counter, shared)
        self.assertIs(status["watchdog"].counter, shared)
        self.assertIs(self.loops()["config_loop"]["counter"], shared)
        self.assertIs(self.command.arguments["counter"], shared)
        self.assertIs(self.command.arguments["sink"], status["sink"])

    def test_each_loop_binds_its_expected_parameters(self):
        loops = self.loops()
        self.assertEqual(
            (
                loops["status_loop"]["interval"],
                loops["config_loop"]["interval"],
                loops["schedule_loop"]["interval"],
                loops["settings_loop"]["interval"],
            ),
            (10, 60, 60, 60),
        )
        self.assertEqual(
            loops["config_loop"]["initial_delay"], bridge.CONFIG_INITIAL_DELAY
        )
        self.assertIsNone(loops["config_loop"]["mqtt"])
        self.assertIsNone(loops["config_loop"]["config_event"])
        self.assertEqual(loops["schedule_loop"]["reconcile_interval"], 300)
        self.assertEqual(
            loops["schedule_loop"]["initial_delay"], bridge.SCHEDULE_INITIAL_DELAY
        )
        self.assertIs(loops["schedule_loop"]["sink"], loops["status_loop"]["sink"])
        self.assertEqual(
            loops["settings_loop"]["bootstrap"], bridge.DEFAULT_CHARGER_HOST
        )
        self.assertIsNone(self.command.arguments["source"])


class ConfigLoopOutageSurvivalTests(unittest.TestCase):
    """The live PR #107 crash as a smoke: charger outage -> config
    ReadTimeout -> bounded retry -> the MQTT-mode tail ``_stop.wait(tick)``.

    run() bound the counter into ``tick``, so the first failed sync ended
    the config thread in TypeError (journal, 02:12 MDT). The loop here runs
    with exactly the ``tick`` and ``counter`` ``run()`` wires.
    """

    def test_a_failed_first_mqtt_sync_survives_the_tail_wait(self):
        logs = []
        calls = []

        class UnreachableSession:
            def get(self, _url, **_kwargs):
                calls.append(1)
                raise requests.ReadTimeout("charger unreachable")

        threads, _command = capture_run_wiring()
        (config,) = [t for t in threads if t.target is bridge.config_loop]
        tick = config.bound.arguments["tick"]
        counter = config.bound.arguments["counter"]
        self.assertIsInstance(tick, (int, float))

        event = threading.Event()
        event.set()  # a config_version arrived: the sync is owed now
        with mock.patch.object(bridge, "log", logs.append), mock.patch.object(
            bridge, "_stop", _TickSensitiveStop(1)
        ):
            # Returning normally is the assertion: the failure cycle,
            # tail wait included, completes instead of raising TypeError.
            bridge.config_loop(
                FakeDB(),
                bridge.ChargerHost("charger"),
                None,
                bridge.ChargerTransport(UnreachableSession()),
                60,
                0,
                _StubMqtt(),
                event,
                tick=tick,
                counter=counter,
            )
        self.assertEqual(len(calls), 1)  # one fetch, then the retry backoff
        self.assertFalse(event.is_set())  # the trigger was consumed
        self.assertTrue(
            any("config sync failed (ReadTimeout)" in line for line in logs)
        )
        self.assertEqual(counter.snapshot()[0], 0)  # no write happened to count


if __name__ == "__main__":
    unittest.main()
