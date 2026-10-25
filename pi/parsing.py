"""Charger status parsing and interval arithmetic.

Extracted from ``bridge.py`` (behavior-preserving move): ``CommandError``,
the ``/status`` JSON parsers (full and partial MQTT snapshot), the numeric
coercion helpers, and the charging-interval clock/step-allowance arithmetic
the session tracker attributes energy with.
"""

import time

from firebase_admin import firestore



STATE_LABELS = {
    1: "ready",
    2: "connected",
    3: "charging",
    254: "sleeping",
    255: "disabled",
}
# Plausibility ceiling for one interval-attribution step, as a power: a step can
# only carry the energy the charger could have delivered in the time that passed
# between the two readings. The charger's own ceiling is 48 A (MAX_AMPS) at ~240 V
# ≈ 11.5 kW, so 25 kW is more than twice what it can draw and still rejects a
# corrupt counter jump; using power × elapsed time (rather than a fixed Wh cap)
# keeps a legitimate step after a long outage — 20 kWh is ~1.7 h of full-power
# charging, not an impossible instant jump. The floor absorbs sub-second gaps and
# clock resolution so two ticks that land together cannot reject a real step.
MAX_INTERVAL_POWER_W = 25000.0
INTERVAL_STEP_FLOOR_WH = 50.0
class CommandError(ValueError):
    """Command document cannot be applied to the charger.

    ``transport`` names the path that produced the failure (``"mqtt"`` or
    ``"http"``), so the command document can record it. It is None when the
    failure was decided before a transport was chosen.
    """

    def __init__(self, message, transport=None):
        super().__init__(message)
        self.transport = transport


def parse_status(data):
    """OpenEVSE /status JSON -> fields for the status/current document."""
    state = data.get("state")
    # Absent temperature sensors read 0 (or a negative sentinel); ignore them.
    raw_temps = [data.get(k) for k in ("temp1", "temp2", "temp3")]
    temps = [t for t in raw_temps if isinstance(t, (int, float)) and t > 0]
    return {
        "state": state,
        "state_label": STATE_LABELS.get(state, "unknown"),
        "amp": _amps(data.get("amp")),
        "voltage": data.get("voltage"),
        "power": data.get("power"),
        "session_energy": data.get("session_energy"),
        "total_energy": data.get("total_energy"),
        "elapsed": data.get("elapsed"),
        "vehicle": data.get("vehicle"),
        "temp_c": round(sum(temps) / len(temps) / 10, 1) if temps else None,
        "temp1": _sensor_temp(data.get("temp1")),
        "temp2": _sensor_temp(data.get("temp2")),
        "temp3": _sensor_temp(data.get("temp3")),
        "pilot": _pilot(data.get("pilot")),
        "charger_online": True,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }


# parse_status outputs that keep the raw key's name.
_SNAPSHOT_FIELDS = (
    "state",
    "amp",
    "voltage",
    "power",
    "session_energy",
    "total_energy",
    "elapsed",
    "vehicle",
    "pilot",
    "temp1",
    "temp2",
    "temp3",
)
_SNAPSHOT_TEMPS = ("temp1", "temp2", "temp3")


def parse_snapshot(data):
    """parse_status for an MQTT snapshot, which may carry only changed fields.

    A snapshot is the last ``/status`` seed merged with the fields of one
    burst, so before that seed it holds only what changed (``{"amp": …}``).
    Parsing it as a full reply would merge ``None`` over every field the burst
    did not carry, so only the fields the snapshot actually has are emitted.
    ``charger_online`` and ``updated_at`` are transport facts — a snapshot
    proves the charger is publishing — and are always set.
    """
    fields = parse_status(data)
    parsed = {
        "charger_online": fields["charger_online"],
        "updated_at": fields["updated_at"],
    }
    for key in _SNAPSHOT_FIELDS:
        if key in data:
            parsed[key] = fields[key]
    if "state" in data:
        parsed["state_label"] = fields["state_label"]
    if any(key in data for key in _SNAPSHOT_TEMPS):
        parsed["temp_c"] = fields["temp_c"]
    return parsed


def _is_number(value):
    """True for int/float but not bool (bool is a subclass of int)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _sensor_temp(value):
    """Raw tenths-of-°C reading -> °C, or None for absent-sensor sentinels."""
    if _is_number(value) and value > 0:
        return round(value / 10, 1)
    return None


def _amps(value):
    """OpenEVSE reports charge current in milliamps; the contract is amps."""
    if _is_number(value) and value >= 0:
        return round(value / 1000, 2)
    return None


def _pilot(value):
    """Pilot setpoint in amps, or None when the charger reports nothing."""
    if _is_number(value) and value >= 0:
        return value
    return None


def _interval_clock():
    """Seconds on the clock the charging-interval gap is measured with.

    ``CLOCK_BOOTTIME`` advances across suspend, which is what the gap needs:
    ``time.monotonic()`` stops while the Pi sleeps, so a charge that suspends
    mid-session would report a shorter gap than the time actually elapsed and
    the time-aware step allowance could judge a legitimate step impossible.
    Linux provides it; the monotonic fallback keeps every other platform (and a
    test run without the constant) working, simply excluding suspend there.
    """
    if hasattr(time, "CLOCK_BOOTTIME"):
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    return time.monotonic()


def _interval_step_allowance(gap):
    """Energy one attribution step may carry, given seconds since the last one.

    A step is measured between two charging readings, so the charger could have
    delivered ``MAX_INTERVAL_POWER_W × gap`` in between; the floor covers clock
    resolution and sub-second gaps, so two ticks that land together cannot
    reject a real step. Callers pass only a measured gap: an unknown one has
    nothing to judge (see ``_track_interval``).
    """
    if not _is_number(gap) or gap <= 0:
        return INTERVAL_STEP_FLOOR_WH
    return MAX_INTERVAL_POWER_W * float(gap) / 3600.0 + INTERVAL_STEP_FLOOR_WH


def _gap_seconds(gap):
    """The observation gap for a journal line."""
    if not _is_number(gap) or gap < 0:
        return "no earlier reading"
    return f"{float(gap):.0f} s"


