"""Validated environment configuration.

Extracted from ``bridge.py`` (behavior-preserving move): the boolean/numeric
env parsers and the NamedTuple configs — watchdog, MQTT, write-policy,
history — plus the ``*_config`` / ``*_config_or_exit`` loaders ``main()``
fills them from. The raw ``cfg()`` lookup itself stays in the composition
root (it reads the import-time env file) and is reached through the call-time
seam below.
"""

import math
import sys
from typing import NamedTuple

from mqtt_source import DEFAULT_ANNOUNCE_TOPIC

from history_accumulator import HISTORY_FLUSH_SEC
from write_policy import (
    CHARGING_HEARTBEAT_SEC,
    HEARTBEAT_INTERVAL,
    WRITE_MIN_GAP_SEC,
    WritePolicyConfig,
)


def cfg(name, default=None):
    # seam: cfg lives in bridge (env-file side effect); resolved at call time
    import bridge  # lazy, call-time only
    return bridge.cfg(name, default)



# --- MQTT status source (issue #44) ----------------------------------------
# MQTT is opt-in; with the flag off every cadence and write is unchanged.
DEFAULT_MQTT_TOPIC = "chelevse"
DEFAULT_MQTT_CLIENT_ID = "chelevse-bridge"
# Status reconciliation over HTTP while MQTT is healthy (staleness cover).
MQTT_RECONCILE_SEC = 60
_TRUE_ENV = frozenset({"1", "true", "yes", "on"})
_FALSE_ENV = frozenset({"0", "false", "no", "off"})
class WatchdogConfig(NamedTuple):
    """Validated watchdog settings; ``watchdog_config()`` fills them from env."""

    enabled: bool = True
    threshold: int = 3
    cooldown: float = 600.0
    max_per_hour: int = 3
    restart_while_charging: bool = False


def _env_bool(name, default):
    """Parse one boolean env var; anything unparseable is a loud config error."""
    raw = cfg(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _TRUE_ENV:
        return True
    if value in _FALSE_ENV:
        return False
    raise ValueError(f"{name} must be a boolean (true/false), got {raw!r}.")


def _env_finite(name, default, parse):
    """Parse one numeric env var; unparseable or non-finite values are loud errors.

    ``nan``/``inf`` must never reach a comparison: against ``nan`` every elapsed
    time reads as "long enough", which would silently disable a cooldown.
    """
    raw = cfg(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = parse(raw.strip())
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number, got {raw!r}.") from None
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite, got {raw!r}.")
    return value


def watchdog_config():
    """Watchdog settings from the environment; bad values raise ValueError."""
    threshold = _env_finite("WATCHDOG_FAILURES", 3, int)
    cooldown = _env_finite("WATCHDOG_COOLDOWN_SEC", 600.0, float)
    max_per_hour = _env_finite("WATCHDOG_MAX_PER_HOUR", 3, int)
    if threshold < 1:
        raise ValueError("WATCHDOG_FAILURES must be at least 1.")
    if cooldown < 0:
        raise ValueError("WATCHDOG_COOLDOWN_SEC must be zero or more.")
    if max_per_hour < 1:
        raise ValueError("WATCHDOG_MAX_PER_HOUR must be at least 1.")
    return WatchdogConfig(
        enabled=_env_bool("WATCHDOG_ENABLED", True),
        threshold=threshold,
        cooldown=cooldown,
        max_per_hour=max_per_hour,
        restart_while_charging=_env_bool("WATCHDOG_RESTART_WHILE_CHARGING", False),
    )


def watchdog_config_or_exit():
    """Watchdog settings for ``main()``: a bad value stops the bridge by name."""
    try:
        return watchdog_config()
    except ValueError as exc:
        sys.exit(str(exc))


class MqttConfig(NamedTuple):
    """Validated MQTT settings; ``mqtt_config()`` fills them from env."""

    enabled: bool = False
    host: str = ""
    port: int = 1883
    user: str = ""
    password: str = ""
    topic: str = DEFAULT_MQTT_TOPIC
    reconcile_sec: float = MQTT_RECONCILE_SEC
    client_id: str = DEFAULT_MQTT_CLIENT_ID
    announce_topic: str = DEFAULT_ANNOUNCE_TOPIC


def mqtt_config():
    """MQTT settings from the environment; bad values raise ValueError."""
    enabled = _env_bool("MQTT_ENABLED", False)
    host = (cfg("MQTT_HOST") or "").strip()
    port = _env_finite("MQTT_PORT", 1883, int)
    reconcile_sec = _env_finite("MQTT_RECONCILE_SEC", MQTT_RECONCILE_SEC, float)
    topic = (cfg("MQTT_TOPIC") or DEFAULT_MQTT_TOPIC).strip().strip("/")
    client_id = (cfg("MQTT_CLIENT_ID") or "").strip() or DEFAULT_MQTT_CLIENT_ID
    announce_topic = (
        cfg("MQTT_ANNOUNCE_TOPIC") or ""
    ).strip() or DEFAULT_ANNOUNCE_TOPIC
    if not 1 <= port <= 65535:
        raise ValueError(f"MQTT_PORT must be 1-65535, got {port}.")
    if reconcile_sec <= 0:
        raise ValueError(f"MQTT_RECONCILE_SEC must be above zero, got {reconcile_sec}.")
    if not topic:
        raise ValueError("MQTT_TOPIC must not be blank.")
    if enabled and not host:
        raise ValueError("MQTT_HOST is required when MQTT_ENABLED is true.")
    return MqttConfig(
        enabled=enabled,
        host=host,
        port=port,
        user=cfg("MQTT_USER") or "",
        password=cfg("MQTT_PASS") or "",
        topic=topic,
        reconcile_sec=reconcile_sec,
        client_id=client_id,
        announce_topic=announce_topic,
    )


def mqtt_config_or_exit():
    """MQTT settings for ``main()``: a bad value stops the bridge by name."""
    try:
        return mqtt_config()
    except ValueError as exc:
        sys.exit(str(exc))


def write_policy_config():
    """Write-policy tunables from the environment; bad values raise ValueError.

    Non-finite and non-positive values are equally rejected: against ``nan``
    every cadence comparison reads "not due yet", which would silently
    freeze all status writes, while a negative period is always due and
    would write on every scheduler tick.
    """
    tunables = (
        ("WRITE_MIN_GAP_SEC", WRITE_MIN_GAP_SEC),
        ("CHARGING_HEARTBEAT_SEC", CHARGING_HEARTBEAT_SEC),
        ("HEARTBEAT_INTERVAL", HEARTBEAT_INTERVAL),
    )
    values = []
    for name, default in tunables:
        value = _env_finite(name, default, float)
        if value <= 0:
            raise ValueError(f"{name} must be above zero, got {value:g}.")
        values.append(value)
    return WritePolicyConfig(*values)


def write_policy_config_or_exit():
    """Write-policy tunables for ``main()``: a bad value stops the bridge by name."""
    try:
        return write_policy_config()
    except ValueError as exc:
        sys.exit(str(exc))


class HistoryConfig(NamedTuple):
    """Validated history-accumulator tunables; ``main()`` fills them from env."""

    flush_sec: float = HISTORY_FLUSH_SEC


def history_config():
    """History flush tunable from the environment; bad values raise ValueError.

    The same rejection rationale as the write-policy tunables: ``nan`` makes
    every interval comparison read "not due yet" (freezing history writes),
    and a non-positive period is always due.
    """
    flush_sec = _env_finite("HISTORY_FLUSH_SEC", HISTORY_FLUSH_SEC, float)
    if flush_sec <= 0:
        raise ValueError(f"HISTORY_FLUSH_SEC must be above zero, got {flush_sec:g}.")
    return HistoryConfig(flush_sec=flush_sec)


def history_config_or_exit():
    """History flush tunable for ``main()``: a bad value stops the bridge by name."""
    try:
        return history_config()
    except ValueError as exc:
        sys.exit(str(exc))


