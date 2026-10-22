"""The ``charging_stopped_at`` stamp (issue #122): bridge side.

The stamp is the web cold-open anchor's source: when charging ends while the
vehicle stays plugged in, the bridge freezes the stop instant into
``status/current`` -- once per charging block, through the write policy's
forced path -- and clears it when a new block opens or the session resets.
These tests pin the stamp/clear semantics on the tracker and the write
accounting on the sink: exactly one prompt write per stop, the frozen value
never re-stamped by later writes, and payloads byte-identical until the
first stamped stop.
"""

import os
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import FakeDB  # noqa: E402
from test_mqtt import _RecordingNotifier, status_payload  # noqa: E402
from test_write_policy import WritePolicyBase, _Clock  # noqa: E402

STAMP = datetime(2026, 10, 22, 14, 0, tzinfo=UTC)


def fields(**overrides):
    """One parsed full observation, as ``StatusSink._apply`` feeds observe."""
    return bridge.parse_status(status_payload(**overrides))


class StopStampTrackerTests(unittest.TestCase):
    """The tracker's stamp state machine, driven through ``observe``."""

    def setUp(self):
        self.tracker = bridge.StatusTracker(FakeDB())

    def observe(self, **overrides):
        self.tracker.observe(fields(**overrides))

    def test_charging_stop_while_plugged_stamps_the_stop_instant(self):
        self.observe(state=1, vehicle=1, session_energy=0)
        self.observe(state=3, vehicle=1, session_energy=500, elapsed=600)
        self.assertIsNone(self.tracker.charging_stopped_at)
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.observe(state=1, vehicle=1, session_energy=500, elapsed=600)
        self.assertEqual(self.tracker.charging_stopped_at, STAMP)
        # The stamp asks the sink for its one prompt write.
        self.assertTrue(self.tracker.stamp_write_pending)

    def test_charging_stop_on_disconnect_stamps_nothing(self):
        self.observe(state=1, vehicle=1)
        self.observe(state=3, vehicle=1, session_energy=500, elapsed=600)
        self.observe(state=1, vehicle=0, session_energy=0)
        self.assertIsNone(self.tracker.charging_stopped_at)
        self.assertFalse(self.tracker.stamp_write_pending)

    def test_a_new_charging_block_clears_the_stamp(self):
        self.observe(state=1, vehicle=1)
        self.observe(state=3, vehicle=1, session_energy=500, elapsed=600)
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.observe(state=1, vehicle=1, session_energy=500, elapsed=600)
        self.assertEqual(self.tracker.charging_stopped_at, STAMP)
        # Charging resumes: the interval machinery opens a new block, which
        # voids the previous block's stamp.
        self.observe(state=3, vehicle=1, session_energy=500, elapsed=600)
        self.assertIsNone(self.tracker.charging_stopped_at)

    def test_a_session_reset_while_plugged_clears_the_stamp(self):
        self.observe(state=1, vehicle=1)
        self.observe(state=3, vehicle=1, session_energy=500, elapsed=600)
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.observe(state=1, vehicle=1, session_energy=500, elapsed=600)
        self.assertEqual(self.tracker.charging_stopped_at, STAMP)
        # Still not charging, but the counters zeroed (the vehicle left):
        # the plug-in is over. The web's hold clears on the same gate.
        self.observe(state=1, vehicle=1, session_energy=0, elapsed=0)
        self.assertIsNone(self.tracker.charging_stopped_at)

    def test_a_charging_write_with_zeroed_counters_keeps_charging_semantics(self):
        # A reset observed *while* state 3 is a baseline tick for a new
        # block, not a session reset: the interval opens, the stamp (none
        # yet) stays none, and no clear is demanded of a stamp that never
        # existed.
        self.observe(state=1, vehicle=1)
        self.observe(state=3, vehicle=1, session_energy=0, elapsed=0)
        self.assertIsNone(self.tracker.charging_stopped_at)

    def test_repeated_stops_restamp_each_block_once(self):
        self.observe(state=1, vehicle=1)
        # First block: 3 -> stopped.
        self.observe(state=3, vehicle=1, session_energy=500, elapsed=600)
        first = datetime(2026, 10, 22, 14, 0, tzinfo=UTC)
        with mock.patch("bridge._utcnow", return_value=first):
            self.observe(state=1, vehicle=1, session_energy=500, elapsed=600)
        self.assertEqual(self.tracker.charging_stopped_at, first)
        # Second block opens and stops later: a fresh stamp of its own.
        self.observe(state=3, vehicle=1, session_energy=900, elapsed=1200)
        self.assertIsNone(self.tracker.charging_stopped_at)
        second = datetime(2026, 10, 22, 16, 30, tzinfo=UTC)
        with mock.patch("bridge._utcnow", return_value=second):
            self.observe(state=1, vehicle=1, session_energy=900, elapsed=1200)
        self.assertEqual(self.tracker.charging_stopped_at, second)


class StopStampSeedTests(unittest.TestCase):
    """``seed`` adopts the stored stamp, so a restart carries it forward."""

    def seeded_tracker(self, doc):
        db = FakeDB()
        db.data["status"] = {"current": dict(doc)}
        tracker = bridge.StatusTracker(db)
        self.assertTrue(tracker.seed())
        return tracker

    def test_seed_adopts_a_stored_stamp(self):
        tracker = self.seeded_tracker(
            {
                "state": 1,
                "session_energy": 1797,
                "elapsed": 3509,
                "charging_stopped_at": STAMP,
            }
        )
        self.assertEqual(tracker.charging_stopped_at, STAMP)

    def test_seed_without_a_stamp_stays_none(self):
        tracker = self.seeded_tracker({"state": 1, "session_energy": 1797})
        self.assertIsNone(tracker.charging_stopped_at)

    def test_a_malformed_stored_stamp_is_ignored(self):
        tracker = self.seeded_tracker(
            {"state": 1, "charging_stopped_at": "2026-10-22T14:00:00Z"}
        )
        self.assertIsNone(tracker.charging_stopped_at)


class StopStampWriteTests(WritePolicyBase):
    """The stamp's write accounting through the sink and its policy."""

    def charge(self, **overrides):
        payload = {"state": 3, "vehicle": 1, "session_energy": 500, "elapsed": 50}
        payload.update(overrides)
        self.apply(**payload)

    def stop_plugged(self, **overrides):
        payload = {"state": 1, "vehicle": 1, "session_energy": 500, "elapsed": 50}
        payload.update(overrides)
        self.apply(**payload)

    def test_the_stop_transition_writes_the_stamp_promptly_inside_the_gap(self):
        self.record_write_times()
        self.charge()  # first write at t=0
        self.clock.advance(self.GAP / 2)  # deep inside the rate-limit window
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.stop_plugged()
        # One write at the apply itself: the stop's own state write,
        # promoted to a forced write so a reload right after the stop finds
        # the field. The forced flag and the state trigger are consumed by
        # the same single write.
        self.assertEqual(self.write_times, [0, self.GAP / 2])
        writes = self.writes()
        self.assertEqual(len(writes), 2)
        self.assertNotIn("charging_stopped_at", writes[0])
        self.assertEqual(writes[1]["charging_stopped_at"], STAMP)
        self.assertFalse(self.sink.policy.forced)
        self.assertFalse(self.sink.policy.triggered)
        self.assertEqual(self.db.data["status"]["current"]["charging_stopped_at"], STAMP)

    def test_later_writes_carry_the_same_stamp_never_a_new_one(self):
        self.charge()  # t=0
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.stop_plugged()
        # An idle heartbeat's full payload republishes the view: the stamp
        # rides it as the frozen literal, not a re-resolved server stamp.
        self.clock.advance(self.IDLE)
        self.tick(observe=lambda: self.stop_plugged())
        writes = self.writes()
        self.assertEqual(len(writes), 3)
        self.assertEqual(writes[-1]["charging_stopped_at"], STAMP)
        self.assertEqual(self.db.data["status"]["current"]["charging_stopped_at"], STAMP)

    def test_a_new_charge_clears_the_field_on_its_own_state_write(self):
        self.charge()  # t=0
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.stop_plugged()
        self.clock.advance(self.GAP)
        self.charge(session_energy=600, elapsed=120)  # state trigger at t=40
        writes = self.writes()
        self.assertEqual(len(writes), 3)
        self.assertEqual(writes[-1]["state"], 3)
        self.assertIsNone(writes[-1]["charging_stopped_at"])
        self.assertIsNone(self.db.data["status"]["current"].get("charging_stopped_at"))

    def test_a_session_reset_clears_the_field_on_the_next_write(self):
        self.charge()  # t=0
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.stop_plugged()
        # The unplug tick: still state 1, but the counters zeroed. No
        # discrete field moved, so the clear rides the idle heartbeat.
        self.clock.advance(self.IDLE)
        self.tick(
            observe=lambda: self.apply(
                state=1, vehicle=1, session_energy=0, elapsed=0
            )
        )
        self.assertIsNone(self.db.data["status"]["current"].get("charging_stopped_at"))

    def test_a_failed_stamp_write_retries_on_the_next_tick(self):
        self.charge()  # t=0
        self.clock.advance(self.GAP / 2)
        self.db.fail_writes = True
        with mock.patch("bridge._utcnow", return_value=STAMP):
            with self.assertRaises(RuntimeError):
                self.stop_plugged()
        self.db.fail_writes = False
        self.clock.advance(1)
        # The forced flag survived the failure: publish_pending lands it.
        self.assertTrue(self.sink.publish_pending())
        self.assertEqual(self.writes()[-1]["charging_stopped_at"], STAMP)

    def test_a_full_charge_cycle_costs_no_extra_writes(self):
        # The stamp rides the stop transition's own write: a start trigger,
        # one charging heartbeat and the stop's forced write is the whole
        # cycle -- the same three writes the pre-stamp policy produced, now
        # counted (write budget, issue #96).
        self.charge()  # t=0: first write
        self.clock.advance(self.CHARGING)  # t=20
        self.tick(
            observe=lambda: self.charge(session_energy=600, elapsed=70)
        )  # charging heartbeat
        self.clock.advance(self.GAP / 2)  # t=25: inside the gap
        with mock.patch("bridge._utcnow", return_value=STAMP):
            self.stop_plugged()  # forced stop write
        for _ in range(5):  # ticks through t=30: nothing further is owed
            self.clock.advance(1)
            self.tick()
        writes = self.writes()
        self.assertEqual([write["state"] for write in writes], [3, 3, 1])
        self.assertEqual(
            [write.get("charging_stopped_at") for write in writes],
            [None, None, STAMP],
        )
        _, by_kind = self.sink.counter.snapshot()
        self.assertEqual(by_kind.get("status"), 3)

    def test_payloads_before_the_first_stamp_stay_byte_identical(self):
        # The field enters the accumulated view only when there is a stamp
        # (or a stamp to clear): an idle-only timeline never carries it.
        self.apply(total_energy=100)  # t=0
        self.clock.advance(self.IDLE)
        self.tick(observe=lambda: self.apply(total_energy=101))
        for write in self.writes():
            self.assertNotIn("charging_stopped_at", write)


class RestartCarriesStampTests(unittest.TestCase):
    """A bridge restart must neither clobber nor freeze the stored stamp."""

    def setUp(self):
        self.db = FakeDB()
        self.db.data["status"] = {
            "current": {
                "state": 1,
                "session_energy": 1797,
                "elapsed": 3509,
                "total_energy": 100.0,
                "charging_stopped_at": STAMP,
            }
        }
        self.tracker = bridge.StatusTracker(self.db)
        self.assertTrue(self.tracker.seed())
        self.clock = _Clock()
        self.sink = bridge.StatusSink(
            self.db,
            self.tracker,
            _RecordingNotifier(),
            policy=bridge.WritePolicy(
                bridge.WritePolicyConfig(10.0, 20.0, 100.0), clock=self.clock
            ),
        )

    def apply(self, **overrides):
        payload = status_payload(vehicle=1, **overrides)
        self.sink.apply_status(bridge.parse_status(payload), "http")

    def writes(self):
        return [
            write[3]
            for write in self.db.writes
            if write[1] == "status" and write[2] == "current"
        ]

    def test_the_first_write_of_a_restart_carries_the_stored_stamp(self):
        # The plugged-in-complete document a cold open lands on: the new
        # process's first write keeps the stamp a reload needs.
        self.apply(state=1, session_energy=1797, elapsed=3509, total_energy=100.0)
        (write,) = self.writes()
        self.assertEqual(write["charging_stopped_at"], STAMP)
        self.assertEqual(self.db.data["status"]["current"]["charging_stopped_at"], STAMP)

    def test_the_reset_after_a_restart_clears_the_stored_stamp(self):
        self.apply(state=1, session_energy=0, elapsed=0, total_energy=100.0)
        (write,) = self.writes()
        self.assertIsNone(write["charging_stopped_at"])
        self.assertIsNone(self.db.data["status"]["current"].get("charging_stopped_at"))


class FailedBootSeedTests(unittest.TestCase):
    """A boot seed that fails and retries after live ticks (issue #122).

    The boot seed can lose its Firestore read (a deploy restart racing
    network/DNS); the status loop retries it on later ticks, by which time
    live applies have already established the state machine. The retry must
    still adopt the stored stamp -- the sink's merge gate opens only once
    the tracker holds one -- or no later clear could ever reach the
    document and the dead plug-in's stamp survives until the next stop.
    """

    def setUp(self):
        self.db = FakeDB()
        self.db.data["status"] = {
            "current": {
                "state": 1,
                "session_energy": 1797,
                "elapsed": 3509,
                "total_energy": 100.0,
                "charging_stopped_at": STAMP,
            }
        }
        self.db.fail_reads = True
        self.tracker = bridge.StatusTracker(self.db)
        self.assertFalse(self.tracker.seed())  # the boot read fails
        self.db.fail_reads = False
        self.clock = _Clock()
        self.sink = bridge.StatusSink(
            self.db,
            self.tracker,
            _RecordingNotifier(),
            policy=bridge.WritePolicy(
                bridge.WritePolicyConfig(10.0, 20.0, 100.0), clock=self.clock
            ),
        )

    def apply(self, **overrides):
        payload = status_payload(**overrides)
        self.sink.apply_status(bridge.parse_status(payload), "http")

    def reseed(self):
        # The status loop's retry, on a later tick.
        self.sink.maybe_seed()
        self.assertTrue(self.tracker.seeded)

    def writes(self):
        return [
            write[3]
            for write in self.db.writes
            if write[1] == "status" and write[2] == "current"
        ]

    def test_the_retry_seed_after_live_ticks_adopts_the_stored_stamp(self):
        self.apply(
            state=1, vehicle=1, session_energy=1797, elapsed=3509, total_energy=100.0
        )
        # The pre-adoption write could not carry the field; the document
        # keeps its stamp through it.
        self.assertNotIn("charging_stopped_at", self.writes()[0])
        self.reseed()
        self.assertEqual(self.tracker.charging_stopped_at, STAMP)
        self.assertTrue(self.tracker.stamp_adopted)

    def test_the_reset_after_a_failed_boot_seed_clears_the_document(self):
        # Live tick, retry seed, then the plug-in ends (the unplug tick:
        # the counters zeroed). Without adoption the clear is mute -- the
        # payload omits the field and the dead stamp survives in the
        # document -- voiding the restart-safety guarantee of §5.
        self.apply(
            state=1, vehicle=1, session_energy=1797, elapsed=3509, total_energy=100.0
        )
        self.reseed()
        self.clock.advance(10.0)  # the vehicle trigger needs the gap open
        self.apply(
            state=1, vehicle=0, session_energy=0, elapsed=0, total_energy=100.0
        )
        self.assertIsNone(self.db.data["status"]["current"].get("charging_stopped_at"))

    def test_a_retry_seed_never_overwrites_the_tracker_s_own_stamp(self):
        # The no-resurrect guard: this process stamped its own stop (16:30,
        # newer than the stored 14:00) while still unseeded, and that
        # write failed; the retry seed must not rewind the live view to
        # the document's older stamp.
        self.apply(
            state=3, vehicle=1, session_energy=500, elapsed=600, total_energy=100.0
        )
        self.db.fail_writes = True
        fresh = datetime(2026, 10, 22, 16, 30, tzinfo=UTC)
        with mock.patch("bridge._utcnow", return_value=fresh):
            with self.assertRaises(RuntimeError):
                self.apply(
                    state=1,
                    vehicle=1,
                    session_energy=500,
                    elapsed=600,
                    total_energy=100.0,
                )
        self.db.fail_writes = False
        self.assertEqual(self.tracker.charging_stopped_at, fresh)
        self.reseed()
        self.assertEqual(self.tracker.charging_stopped_at, fresh)


if __name__ == "__main__":
    unittest.main()
