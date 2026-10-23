"""Write-policy scheduler tests (issue #93): the cadence of status/current.

No broker, charger, Firestore or FCM is touched: the sinks run against the
in-memory fakes with an injected clock, so every rate limit, heartbeat and
trigger boundary is tested at exact simulated times.
"""

import os
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import FakeDB, FakeResponse, FakeSession  # noqa: E402
from test_mqtt import _RecordingNotifier, _StopAfter, status_payload  # noqa: E402


class _Clock:
    """A monotonic clock the tests advance by hand."""

    def __init__(self, start=0.0):
        self.now = float(start)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class WritePolicyBase(unittest.TestCase):
    """A sink whose policy runs on the injected clock.

    The gaps keep the production ratios at a readable scale: the charging
    heartbeat is twice the rate-limit gap, the idle heartbeat ten times.
    """

    GAP = 10.0
    CHARGING = 20.0
    IDLE = 100.0

    def setUp(self):
        self.db = FakeDB()
        self.notifier = _RecordingNotifier()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True
        # A stored baseline, as after a bridge start: the first apply of a run
        # establishes state and never notifies.
        self.tracker.has_state = True
        self.tracker.state = 1
        self.tracker.previous_state = 1
        self.tracker.charger_online = True
        self.clock = _Clock()
        self.sink = self._build_sink()

    def _build_sink(self):
        sink = bridge.StatusSink(
            self.db,
            self.tracker,
            self.notifier,
            policy=bridge.WritePolicy(
                bridge.WritePolicyConfig(self.GAP, self.CHARGING, self.IDLE),
                clock=self.clock,
            ),
        )
        return sink

    def record_write_times(self):
        """Capture the clock time of every status/current write."""
        self.write_times = []
        real_doc = self.sink.status_doc

        class _RecordingDoc:
            def set(_self, data, merge=False):
                self.write_times.append(self.clock.now)
                return real_doc.set(data, merge=merge)

        self.sink.status_doc = _RecordingDoc()

    def apply(self, source="http", **overrides):
        payload = status_payload(**overrides)
        return self.sink.apply_status(bridge.parse_status(payload), source)

    def apply_partial(self, fields):
        """A partial MQTT snapshot (only the fields one burst carried)."""
        return self.sink.apply_status(
            bridge.parse_snapshot(fields), "mqtt", complete=False
        )

    def tick(self, observe=None):
        """One scheduler pass, exactly what the status loop does per tick.

        ``observe`` stands in for the heartbeat's forced HTTP observation: it
        runs between the due decision and the publish, like the loop's forced
        reconcile, and only when the heartbeat is due.
        """
        due, watermark = self.sink.heartbeat_due()
        if due and observe is not None:
            observe()
        if due:
            self.sink.publish_heartbeat(watermark)
        self.sink.publish_pending()

    def writes(self):
        """The status/current payloads written, in order."""
        return [
            write[3]
            for write in self.db.writes
            if write[1] == "status" and write[2] == "current"
        ]


class FirstWriteTests(WritePolicyBase):
    def test_the_first_apply_publishes(self):
        # No last-written baseline: the initial write is due (issue #93).
        self.apply(total_energy=100)
        (write,) = self.writes()
        self.assertEqual(write["total_energy"], 100)
        self.assertEqual(write["state"], 1)


class RateLimitTests(WritePolicyBase):
    def test_a_1hz_snapshot_stream_writes_at_most_once_per_gap(self):
        self.record_write_times()
        # What MQTT actually delivers while charging: a snapshot per second,
        # the continuous fields creeping along. One write at the start (the
        # state transition), then heartbeats only -- never more than one
        # write per rate-limit gap.
        self.apply(state=3, session_energy=0, elapsed=0)
        for second in range(1, 2 * int(self.CHARGING) + 1):
            self.clock.advance(1)
            self.apply(
                "mqtt",
                state=3,
                session_energy=second * 10,
                elapsed=second,
                power=4400 + second,
                voltage=240 + second / 100,
                total_energy=100 + second / 360,
            )
            self.tick(
                observe=None
                if second % self.CHARGING
                else lambda second=second: self.apply(
                    state=3,
                    session_energy=second * 10,
                    elapsed=second,
                    total_energy=100 + second / 360,
                )
            )
        times = self.write_times
        self.assertEqual(times, [0, self.CHARGING, 2 * self.CHARGING])
        for earlier, later in zip(times, times[1:]):
            self.assertGreaterEqual(later - earlier, self.GAP)

    def test_elapsed_session_energy_or_temperature_alone_never_writes(self):
        self.apply(total_energy=100)
        self.assertEqual(len(self.writes()), 1)
        # Continuous-only movement of every flavour, each with its own
        # scheduler tick: none of it may produce a write.
        self.clock.advance(1)
        self.apply_partial({"elapsed": 1})
        self.tick()
        self.clock.advance(1)
        self.apply_partial({"session_energy": 500})
        self.tick()
        self.clock.advance(1)
        self.apply_partial({"temp1": 250})
        self.tick()
        self.clock.advance(1)
        self.apply(total_energy=101, power=10, voltage=241)
        self.tick()
        self.assertEqual(len(self.writes()), 1)

    def test_a_discrete_trigger_mid_heartbeat_publishes_early(self):
        self.record_write_times()
        self.apply(total_energy=100)  # first write at t=0
        self.clock.advance(self.GAP / 2)
        self.apply(state=3, session_energy=0, elapsed=0)  # trigger at t=5
        for _ in range(4):  # ticks through the deferred window
            self.clock.advance(1)
            self.tick()
        self.assertEqual(self.write_times, [0])  # never sooner than the gap
        self.clock.advance(1)  # t=10: the gap is satisfied
        self.tick()
        self.assertEqual(self.write_times, [0, self.GAP])
        # A second trigger waits out its own gap window. (The trigger stays
        # inside state 3 on purpose: a snapshot that *leaves* charging while
        # plugged in is the stop stamp's forced write (#122), which publishes
        # at the apply and is covered by the stop-stamp tests.)
        self.clock.advance(self.GAP / 2)
        self.apply("mqtt", state=3, vehicle=1)
        self.tick()
        self.assertEqual(self.write_times, [0, self.GAP])
        self.clock.advance(self.GAP / 2 + 1)
        self.tick()
        self.assertEqual(self.write_times, [0, self.GAP, 2 * self.GAP + 1])


class HeartbeatTests(WritePolicyBase):
    def test_continuous_movement_publishes_on_the_charging_heartbeat(self):
        # A 1 Hz stream while charging: the writes land on the charging
        # heartbeat cadence, carrying the freshest continuous values.
        self.apply(state=3, session_energy=0, elapsed=0)
        for second in range(1, int(self.CHARGING) + 1):
            self.clock.advance(1)
            self.apply("mqtt", state=3, session_energy=second * 10, elapsed=second)
            self.tick(
                observe=lambda second=second: self.apply(
                    state=3,
                    session_energy=second * 10,
                    elapsed=second,
                    total_energy=100 + second / 360,
                )
            )
        writes = self.writes()
        self.assertEqual([write["session_energy"] for write in writes], [0, 200])
        self.assertEqual(writes[-1]["total_energy"], 100 + self.CHARGING / 360)

    def test_continuous_movement_publishes_on_the_idle_heartbeat(self):
        self.apply(total_energy=100)
        for second in range(1, int(self.IDLE) + 1):
            self.clock.advance(1)
            self.apply("mqtt", total_energy=100 + second / 360)
            self.tick()
        self.assertEqual(len(self.writes()), 1)  # nothing until the heartbeat
        self.clock.advance(1)
        self.tick(observe=lambda: self.apply(total_energy=100 + 1 / 360))
        self.assertEqual(len(self.writes()), 2)

    def test_the_heartbeat_payload_is_complete_never_timestamp_only(self):
        self.apply(state=3, session_energy=500, elapsed=50)
        self.clock.advance(self.CHARGING)
        # The heartbeat's forced reconcile returns a full /status payload.
        self.tick(
            observe=lambda: self.apply(
                state=3,
                amp=15400,
                voltage=240,
                power=3400,
                session_energy=600,
                total_energy=100.5,
                elapsed=60,
                vehicle=1,
                temp1=247,
                pilot=32,
            )
        )
        (write,) = self.writes()[1:]
        self.assertEqual(
            set(write),
            {
                "state",
                "state_label",
                "amp",
                "voltage",
                "power",
                "session_energy",
                "total_energy",
                "elapsed",
                "vehicle",
                "temp_c",
                "temp1",
                "temp2",
                "temp3",
                "pilot",
                "charger_online",
                "updated_at",
            },
        )
        self.assertEqual(write["amp"], 15.4)
        self.assertEqual(write["temp_c"], 24.7)

    def test_a_heartbeat_without_a_fresh_observation_does_not_write(self):
        # The charger never answered and MQTT stayed silent: no apply landed
        # after the decision, so there is no write. A fresh updated_at on
        # stale values is exactly what a heartbeat must never stamp.
        self.apply(state=3, session_energy=500, elapsed=50)
        self.clock.advance(self.CHARGING)
        due, watermark = self.sink.heartbeat_due()
        self.assertTrue(due)
        self.assertFalse(self.sink.publish_heartbeat(watermark))
        self.tick()
        self.assertEqual(len(self.writes()), 1)

    def test_a_due_heartbeat_writes_even_when_the_payload_is_unchanged(self):
        self.apply(total_energy=100)
        self.assertEqual(len(self.writes()), 1)
        self.clock.advance(self.IDLE)
        # The forced reconcile returns byte-identical values; suppression
        # never skips a due heartbeat.
        self.tick(observe=lambda: self.apply(total_energy=100))
        self.assertEqual(len(self.writes()), 2)
        self.assertEqual(self.writes()[1]["total_energy"], 100)


class SuppressionTests(WritePolicyBase):
    def test_an_unchanged_trigger_set_writes_nothing(self):
        self.apply(total_energy=100)
        # An armed trigger whose candidate matches the document moves
        # nothing, so it is consumed without a write.
        self.sink.note_trigger("schedule")
        self.clock.advance(self.GAP)
        self.tick()
        self.assertEqual(len(self.writes()), 1)
        self.assertFalse(self.sink.policy.triggered)

    def test_an_unchanged_trigger_does_not_block_a_later_real_change(self):
        self.apply(total_energy=100)
        self.sink.note_trigger("schedule")
        self.clock.advance(self.GAP)
        self.tick()  # suppressed and consumed
        self.apply("mqtt", pilot=32)
        self.tick()
        self.assertEqual(len(self.writes()), 2)
        self.assertEqual(self.writes()[1]["pilot"], 32)


class ScheduleWindowTests(WritePolicyBase):
    """The active schedule window as a write-policy trigger (issue #95).

    ``note_schedule`` is the schedule loop's seam: an unchanged window arms
    nothing (zero writes), a changed one arms the trigger and lands inside
    the status write that trigger causes -- never a follow-up.
    """

    OUT = {"in_window": False, "active_rule_id": None}
    ON = {"in_window": True, "active_rule_id": "rule-a"}

    def feed(self, window):
        return self.sink.note_schedule(window)

    def test_an_unchanged_window_costs_zero_writes_over_24h(self):
        self.record_write_times()
        self.apply(total_energy=100)  # baseline write at t=0
        self.clock.advance(1)
        self.feed(self.OUT)  # first value: arms, deferred by the gap
        self.tick()
        self.assertEqual(self.write_times, [0])
        self.clock.advance(self.GAP)  # t=11: the gap opens
        self.tick()
        self.assertEqual(self.write_times, [0, self.GAP + 1])
        # 24 h of minute ticks, window unchanged. The charger is idle-silent
        # (no observation lands, so no heartbeat can write either): the only
        # writes still possible are triggers, and none may be owed.
        for _ in range(24 * 60):
            self.clock.advance(60)
            self.assertFalse(self.feed(self.OUT))
            self.tick()
        self.assertEqual(self.write_times, [0, self.GAP + 1])
        self.assertFalse(self.sink.policy.triggered)

    def test_a_window_change_publishes_exactly_once_with_the_new_value(self):
        self.apply(state=3, total_energy=100)  # written at t=0, no schedule
        self.clock.advance(self.GAP + 1)  # the rate-limit gap is open
        self.assertTrue(self.feed(self.ON))  # publishes inline, immediately
        writes = self.writes()
        self.assertEqual(len(writes), 2)
        self.assertNotIn("schedule", writes[0])
        self.assertEqual(writes[1]["schedule"], self.ON)  # same write
        self.assertFalse(self.sink.policy.triggered)  # nothing further owed
        self.clock.advance(1)
        self.tick()
        self.assertEqual(len(self.writes()), 2)  # no follow-up write

    def test_a_crossing_while_charging_publishes_before_the_heartbeat(self):
        self.record_write_times()
        self.apply(state=3, session_energy=0, elapsed=0)  # write at t=0
        # The charging heartbeat would write at t=20; the crossing is past
        # the rate-limit gap at t=11 and publishes right there.
        self.clock.advance(self.GAP + 1)
        self.assertTrue(self.feed(self.ON))
        self.assertEqual(self.write_times, [0, self.GAP + 1])
        self.assertLess(self.write_times[-1], self.CHARGING)

    def test_a_crossing_coinciding_with_another_trigger_shares_the_rate_limit(self):
        self.apply(total_energy=100)  # write at t=0
        self.clock.advance(2)
        self.apply("mqtt", pilot=32)  # a snapshot trigger, inside the gap
        self.assertFalse(self.feed(self.OUT))  # deferred with it, not past it
        self.tick()
        self.assertEqual(len(self.writes()), 1)
        self.clock.advance(self.GAP)  # t=12: the gap opens
        self.tick()
        writes = self.writes()
        self.assertEqual(len(writes), 2)  # one write serves both triggers
        self.assertEqual(writes[1]["pilot"], 32)
        self.assertEqual(writes[1]["schedule"], self.OUT)
        self.assertFalse(self.sink.policy.triggered)

    def test_the_published_payload_carries_schedule_state_of_the_new_window(self):
        # The exact shape the Status badge (screens/status.js) and the
        # Schedule screen window info (screens/schedule.js) consume: the
        # payload's schedule is precisely schedule_state(plan, rules).
        plan = {
            "current_event": {"id": 3, "state": "active", "duration": 18000},
            "next_event_delay": 600,
        }
        window = bridge.schedule_state(plan, {3: "workdays"})
        self.apply(total_energy=100)
        self.clock.advance(self.GAP + 1)
        self.feed(window)
        (write,) = self.writes()[1:]
        self.assertEqual(
            write["schedule"], {"in_window": True, "active_rule_id": "workdays"}
        )
        self.assertEqual(
            write["schedule"], bridge.schedule_state(plan, {3: "workdays"})
        )

    def test_a_window_fed_before_any_observation_rides_the_first_write(self):
        # Bridge start, charger still silent: the feed arms the trigger but
        # cannot publish (no observation yet); the first apply's write then
        # carries the window -- still one write, no follow-up.
        self.assertFalse(self.feed(self.OUT))
        self.assertTrue(self.sink.policy.triggered)
        self.apply(total_energy=100)
        (write,) = self.writes()
        self.assertEqual(write["schedule"], self.OUT)
        self.assertFalse(self.sink.policy.triggered)

    def test_a_window_overtaken_by_a_heartbeat_write_is_not_written_twice(self):
        self.apply(state=3, total_energy=100)  # write at t=0
        self.clock.advance(2)
        self.feed(self.ON)  # arms, deferred inside the gap
        self.tick()
        self.assertEqual(len(self.writes()), 1)
        # The heartbeat's forced observation lands first and its write (the
        # trigger's gap is open by then) carries the window exactly once.
        self.clock.advance(self.CHARGING - 2)  # t=20
        self.tick(observe=lambda: self.apply("mqtt", state=3, total_energy=101))
        writes = self.writes()
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[1]["schedule"], self.ON)
        self.assertFalse(self.sink.policy.triggered)  # consumed, not re-owed
        self.clock.advance(self.GAP)
        self.tick()
        self.assertEqual(len(self.writes()), 2)


class ForcedWriteTests(WritePolicyBase):
    def test_a_completed_command_forces_an_immediate_write(self):
        self.apply(total_energy=100)  # written at t=0
        self.clock.advance(2)  # well inside the rate-limit window
        self.assertTrue(self.sink.force_write())
        writes = self.writes()
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[1]["total_energy"], 100)

    def test_a_forced_write_without_an_observation_stays_armed(self):
        # Bridge just started, nothing observed, a command completes: the
        # forced flag waits for the first observation, which then publishes
        # immediately.
        self.sink.force_write()
        self.assertEqual(self.writes(), [])
        self.apply(total_energy=100)
        self.assertEqual(len(self.writes()), 1)
        self.assertFalse(self.sink.policy.forced)


class OfflineEdgeTests(WritePolicyBase):
    def test_the_offline_edge_writes_immediately_outside_the_rate_limit(self):
        self.apply(total_energy=100)  # policy write at t=0
        self.clock.advance(2)
        self.sink.apply_offline("gone")
        writes = self.writes()
        self.assertEqual(len(writes), 2)  # immediate: no gap, no heartbeat
        self.assertFalse(writes[1]["charger_online"])
        # The recovery apply arms a trigger (the offline write is in the
        # suppression baseline); it publishes once the gap allows.
        self.clock.advance(1)
        self.apply(total_energy=100)
        self.assertEqual(len(self.writes()), 2)  # still inside the gap
        self.clock.advance(self.GAP)
        self.tick()
        writes = self.writes()
        self.assertEqual(len(writes), 3)
        self.assertTrue(writes[2]["charger_online"])

    def test_a_recovery_with_unchanged_values_still_republishes_online(self):
        # The exact hole note_external closes: without the offline write in
        # the suppression baseline, a recovery whose other fields are
        # identical would read as a no-op and leave charger_online false.
        self.apply(total_energy=100, session_energy=0, elapsed=0)
        self.clock.advance(self.GAP)
        self.apply(state=3, session_energy=0, elapsed=0)  # trigger write
        self.clock.advance(1)
        self.sink.apply_offline("gone")
        self.clock.advance(self.GAP)
        self.apply("mqtt", state=3, session_energy=0, elapsed=0)
        self.tick()
        self.assertTrue(self.writes()[-1]["charger_online"])


class DiscardGuardTests(WritePolicyBase):
    """The apply-side guards the policy must not disturb (issue #93)."""

    def test_a_late_http_reconcile_cannot_rewind_a_newer_mqtt_apply(self):
        self.apply(state=3, session_energy=6000, elapsed=3600, total_energy=200)
        mark = self.sink.mqtt_generation()
        self.apply("mqtt", state=1, session_energy=6000, elapsed=3600)
        applied = self.sink.apply_status(
            bridge.parse_status(
                status_payload(state=3, session_energy=6000, elapsed=3600)
            ),
            "http",
            mqtt_mark=mark,
        )
        self.assertFalse(applied)
        self.assertEqual(self.tracker.state, 1)
        # The published view carries the MQTT outcome, not the stale reply.
        self.clock.advance(self.GAP)
        self.tick()
        self.assertEqual(self.writes()[-1]["state"], 1)

    def test_a_snapshot_at_the_reconciled_arrival_is_still_dropped(self):
        self.assertTrue(
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1, total_energy=100)),
                "http",
                arrival=2,
            )
        )
        self.assertFalse(
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1, total_energy=110)),
                "mqtt",
                arrival=2,
            )
        )
        self.assertTrue(
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1, total_energy=120)),
                "mqtt",
                arrival=3,
            )
        )
        # The applies landed in the tracker (the gate decided), and the
        # document keeps the first write: total_energy is continuous.
        self.assertEqual(self.tracker.total_energy, 120)
        self.assertEqual([write["total_energy"] for write in self.writes()], [100])


class HeartbeatPollPacingTests(WritePolicyBase):
    def test_a_failing_forced_reconcile_keeps_the_reconcile_cadence(self):
        # The pacing that keeps a due-but-failing heartbeat from re-polling
        # on every 1 s tick (which would flag a false outage).
        self.assertTrue(self.sink.heartbeat_poll_due())
        self.sink.note_heartbeat_poll()
        self.clock.advance(self.GAP)
        self.assertFalse(self.sink.heartbeat_poll_due())
        self.clock.advance(self.IDLE - self.GAP)
        self.assertTrue(self.sink.heartbeat_poll_due())


class _ForcingSink:
    """The command loop's view of the sink: records forced writes."""

    def __init__(self):
        self.forced = 0

    def force_write(self):
        self.forced += 1
        return True


class CommandForceWiringTests(unittest.TestCase):
    def command(self):
        return {
            "status": "pending",
            "type": "pause",
            "created_at": datetime.now(UTC),
        }

    def run_loop(self, responses, sink):
        db = FakeDB({"commands": {"a": self.command()}})
        session = FakeSession(responses)
        transport = bridge.ChargerTransport(session)
        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.command_loop(
                db,
                bridge.ChargerHost("charger"),
                None,
                transport,
                0,
                None,
                sink,
            )
        return db, sink

    def test_an_acked_command_forces_one_status_write(self):
        db, sink = self.run_loop([FakeResponse(200)], _ForcingSink())
        self.assertEqual(sink.forced, 1)
        self.assertEqual(db.data["commands"]["a"]["status"], "acked")

    def test_a_failed_command_does_not_force_a_status_write(self):
        # A failed command forces nothing: the app clears its clock hold
        # only when the send itself fails client-side, so a bridge-reported
        # failure holds the clock until the next heartbeat write (<=60 s
        # while charging) -- self-clearing, no status write owed.
        db, sink = self.run_loop([FakeResponse(500)], _ForcingSink())
        self.assertEqual(sink.forced, 0)
        self.assertEqual(db.data["commands"]["a"]["status"], "failed")


class _QuietMqtt:
    """The MQTT source surface the status loop reads: healthy and silent."""

    connected = True
    subscribed = True
    announced = None
    last_lwt_at = None
    snapshots = 0
    subscription = "chelevse/#"

    @property
    def mqtt_ready(self):
        return True

    def arrival_generation(self):
        return 0

    def seed_if_current(self, _generation, _payload):
        # A healthy quiet source: the generation never moved, so the raw
        # /status payload is current and the seed is accepted.
        return True


class SchedulerLoopTests(unittest.TestCase):
    """status_loop as the scheduler tick: heartbeats force the observation."""

    def setUp(self):
        self.notifier = _RecordingNotifier()
        self.clock = _Clock()
        self.policy = bridge.WritePolicy(
            bridge.WritePolicyConfig(5.0, 10.0, 100.0), clock=self.clock
        )

    def run_loop(self, data, responses, polls, on_wait=None, mqtt=None):
        db = FakeDB(data)
        tracker = bridge.StatusTracker(db)
        tracker.seed()
        sink = bridge.StatusSink(db, tracker, self.notifier, policy=self.policy)
        session = FakeSession(responses)
        transport = bridge.ChargerTransport(session)
        watchdog = bridge.Watchdog(
            db,
            bridge.ChargerHost("charger"),
            None,
            transport,
            self.notifier,
            bridge.WatchdogConfig(enabled=False),
        )
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.status_loop(
                db,
                bridge.ChargerHost("charger"),
                None,
                transport,
                10,
                tracker,
                self.notifier,
                watchdog,
                mqtt,
                3600,
                sink,
            )
        return db, session

    @staticmethod
    def current_writes(db):
        return [
            write[3]
            for write in db.writes
            if write[1] == "status" and write[2] == "current"
        ]

    def test_a_charging_heartbeat_forces_the_reconcile_and_publishes(self):
        # MQTT mode: the reconcile interval (3600 s) would never fire again,
        # yet the 10 s charging heartbeat forces a fresh GET ahead of it and
        # publishes the full payload every period.
        db, session = self.run_loop(
            {"status": {"current": {"state": 3}}},
            [
                FakeResponse(
                    200, status_payload(state=3, total_energy=100, session_energy=10)
                ),
                FakeResponse(
                    200, status_payload(state=3, total_energy=110, session_energy=20)
                ),
            ],
            polls=2,
            on_wait=lambda: self.clock.advance(11),
            mqtt=_QuietMqtt(),
        )
        # The first poll is the startup reconcile; the second is the
        # heartbeat's forced observation, not the 3600 s cadence.
        self.assertEqual(len(session.calls), 2)
        writes = self.current_writes(db)
        self.assertEqual([write["total_energy"] for write in writes], [100, 110])
        self.assertEqual(writes[-1]["session_energy"], 20)

    def test_http_only_heartbeats_publish_what_the_poll_applied(self):
        db, session = self.run_loop(
            {},
            [
                FakeResponse(200, status_payload(total_energy=100)),
                FakeResponse(200, status_payload(total_energy=110)),
            ],
            polls=2,
            on_wait=lambda: self.clock.advance(101),
        )
        self.assertEqual(len(session.calls), 2)
        writes = self.current_writes(db)
        self.assertEqual([write["total_energy"] for write in writes], [100, 110])


class PolicyEnvTests(unittest.TestCase):
    """main() parses the new tunables like the other intervals."""

    def run_main(self, env=None):
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, env or {}, clear=True
        ), mock.patch.object(
            bridge, "init_firestore", return_value=FakeDB()
        ), mock.patch.object(
            bridge, "run"
        ) as run, mock.patch.object(
            bridge, "log"
        ), mock.patch.object(
            bridge, "ChargerTransport"
        ):
            bridge.main()
        return run

    def test_defaults(self):
        run = self.run_main()
        self.assertEqual(
            run.call_args.kwargs["write_policy"],
            bridge.WritePolicyConfig(30.0, 60.0, 300.0),
        )

    def test_overrides(self):
        run = self.run_main(
            {
                "WRITE_MIN_GAP_SEC": "5",
                "CHARGING_HEARTBEAT_SEC": "61",
                "HEARTBEAT_INTERVAL": "600",
            }
        )
        self.assertEqual(
            run.call_args.kwargs["write_policy"],
            bridge.WritePolicyConfig(5.0, 61.0, 600.0),
        )

    def assert_bad_tunable_exits(self, name, raw):
        """main() must stop on a bad tunable, and only on that.

        init_firestore is patched (a missing service-account key exits
        just as loudly), so the tunable validation at the top of main()
        is the only exit source exercised, and the message must name
        the offending tunable.
        """
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, {name: raw}, clear=True
        ), mock.patch.object(
            bridge, "init_firestore", return_value=FakeDB()
        ), mock.patch.object(bridge, "run"), mock.patch.object(
            bridge, "log"
        ), mock.patch.object(
            bridge, "ChargerTransport"
        ):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
        self.assertIn(name, str(cm.exception))

    def test_unparseable_values_exit_loudly(self):
        self.assert_bad_tunable_exits("WRITE_MIN_GAP_SEC", "soon")

    def test_non_finite_values_exit_loudly(self):
        for name, raw in (
            ("WRITE_MIN_GAP_SEC", "nan"),
            ("WRITE_MIN_GAP_SEC", "inf"),
            ("CHARGING_HEARTBEAT_SEC", "nan"),
            ("CHARGING_HEARTBEAT_SEC", "inf"),
            ("HEARTBEAT_INTERVAL", "nan"),
            ("HEARTBEAT_INTERVAL", "inf"),
        ):
            with self.subTest(name=name, raw=raw):
                self.assert_bad_tunable_exits(name, raw)

    def test_non_positive_values_exit_loudly(self):
        for name, raw in (
            ("WRITE_MIN_GAP_SEC", "-1"),
            ("WRITE_MIN_GAP_SEC", "0"),
            ("CHARGING_HEARTBEAT_SEC", "-1"),
            ("HEARTBEAT_INTERVAL", "-60"),
        ):
            with self.subTest(name=name, raw=raw):
                self.assert_bad_tunable_exits(name, raw)


if __name__ == "__main__":
    unittest.main()
