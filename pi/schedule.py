"""The firmware scheduler mirror (schedule/current <-> charger).

Extracted from ``bridge.py`` (behavior-preserving move, issue #95): rule
normalization and overlap dropping, the canonical schedule hash, the
rules -> firmware events mapping, the active-window state published into
``status/current``, and the idempotent sync that upserts changed firmware
events and deletes stale ones. The shared ``_require_ok``/``_http_reason``
charger-HTTP response checks moved down to ``transport.py`` (the module that
owns the charger HTTP session); this module imports ``_require_ok`` from there.
"""

import hashlib
import json
import math
import re

from charger_host import HTTP_TIMEOUT
from parsing import _is_number
from transport import _require_ok


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)


def _normalize_rule(raw):
    """One schedule rule -> canonical dict, or None (logged) when malformed."""
    if not isinstance(raw, dict):
        log("schedule: skipped rule (not an object)")
        return None
    rule_id = raw.get("id")
    if not (isinstance(rule_id, str) and rule_id):
        log("schedule: skipped rule (missing string id)")
        return None
    days = raw.get("days")
    if not isinstance(days, list) or not days:
        log(f"schedule: skipped rule {rule_id} (missing days)")
        return None
    clean_days = []
    for day in days:
        if not isinstance(day, int) or isinstance(day, bool) or not 0 <= day <= 6:
            log(f"schedule: skipped rule {rule_id} (day must be an integer 0-6)")
            return None
        if day not in clean_days:
            clean_days.append(day)
    start = raw.get("start")
    if not (isinstance(start, str) and TIME_RE.fullmatch(start)):
        log(f"schedule: skipped rule {rule_id} (invalid start)")
        return None
    end = raw.get("end")
    if not (isinstance(end, str) and TIME_RE.fullmatch(end)):
        log(f"schedule: skipped rule {rule_id} (invalid end)")
        return None
    if start == end:
        log(f"schedule: skipped rule {rule_id} (start equals end)")
        return None
    amps = raw.get("amps")
    if not _is_number(amps) or not math.isfinite(amps):
        log(f"schedule: skipped rule {rule_id} (amps must be a number)")
        return None
    return {
        "id": rule_id,
        "days": sorted(clean_days),
        "start": start,
        "end": end,
        "amps": amps,
    }


def _hhmm_minutes(value):
    """'HH:MM' -> minutes since midnight."""
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _rule_segments(rule):
    """(day, start, end) minute segments this rule occupies, incl. overnight spill."""
    start = _hhmm_minutes(rule["start"])
    end = _hhmm_minutes(rule["end"])
    segments = []
    for day in rule["days"]:
        if end > start:
            segments.append((day, start, end))
        else:
            # Wraps past midnight: the tail belongs to the following day. A
            # 00:00 end means the window finishes exactly at midnight.
            segments.append((day, start, 24 * 60))
            if end > 0:
                segments.append(((day + 1) % 7, 0, end))
    return segments


def _drop_overlaps(rules):
    """Keep rules with non-overlapping windows per day; log and skip clashes.

    The firmware builds a time-ordered event list and resolves equal-time
    events by order, so overlapping (or merely touching) windows make the
    effective on/off window ambiguous. Drop the later rule instead.
    """
    kept = []
    accepted = []
    for rule in rules:
        clashes = False
        for day, start, end in _rule_segments(rule):
            for other_day, other_start, other_end, _other_id in accepted:
                if day == other_day and start <= other_end and other_start <= end:
                    clashes = True
                    break
            if clashes:
                break
        if clashes:
            log(f"schedule: skipped rule {rule['id']} (overlaps another rule)")
            continue
        accepted.extend(
            (day, start, end, rule["id"]) for day, start, end in _rule_segments(rule)
        )
        kept.append(rule)
    return kept


def normalize_schedule(data):
    """schedule/current -> (enabled, canonical rules), or None when malformed.

    None means "leave the firmware exactly as it is": a doc whose enabled flag
    or rules list is malformed, or whose enabled rules are all unusable, is not
    an intentional clear.
    """
    if not isinstance(data, dict):
        log("schedule: skipped (document is not an object)")
        return None
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        log("schedule: skipped (enabled must be a boolean)")
        return None
    raw_rules = data.get("rules")
    if not isinstance(raw_rules, list):
        log("schedule: skipped (rules must be a list)")
        return None
    rules = []
    for raw in raw_rules:
        rule = _normalize_rule(raw)
        if rule is not None:
            rules.append(rule)
    # Sort before capping so event ids stay stable when rules are reordered.
    rules.sort(key=lambda rule: rule["id"])
    rules = _drop_overlaps(rules)
    if len(rules) > MAX_SCHEDULE_RULES:
        log(f"schedule: only the first {MAX_SCHEDULE_RULES} rules are synced")
        rules = rules[:MAX_SCHEDULE_RULES]
    if enabled and raw_rules and not rules:
        log("schedule: skipped (no usable rules; firmware schedule left untouched)")
        return None
    return enabled, rules


def schedule_hash(enabled, rules):
    """Canonical digest of the desired schedule, used to skip unchanged syncs."""
    payload = json.dumps({"enabled": enabled, "rules": rules}, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def schedule_events(rules):
    """Rules -> (firmware events, event id -> rule id).

    Rule index i owns event 2*i+1 (window start, active) and 2*i+2 (window end,
    disabled). Event ids are deterministic for a given rule set, so the sync is
    an idempotent upsert. End events for overnight rules (end < start) shift to
    the following firmware day.
    """
    events = []
    event_rules = {}
    for index, rule in enumerate(rules):
        on_id, off_id = 2 * index + 1, 2 * index + 2
        days = sorted(
            (FIRMWARE_DAYS[(day + 1) % 7] for day in rule["days"]),
            key=FIRMWARE_DAYS.index,
        )
        if rule["end"] < rule["start"]:
            end_days = sorted(
                (FIRMWARE_DAYS[(day + 2) % 7] for day in rule["days"]),
                key=FIRMWARE_DAYS.index,
            )
        else:
            end_days = days
        events.append(
            {
                "id": on_id,
                "state": "active",
                "time": rule["start"] + ":00",
                "days": days,
            }
        )
        events.append(
            {
                "id": off_id,
                "state": "disabled",
                "time": rule["end"] + ":00",
                "days": end_days,
            }
        )
        event_rules[on_id] = rule["id"]
        event_rules[off_id] = rule["id"]
    return events, event_rules


def schedule_state(plan, event_rules):
    """Firmware /schedule/plan -> the status/current.schedule field.

    The firmware's current_event is the event whose claim is in effect, but it
    can lag the plan by a moment after a sync. An active event is only a real
    open window when the next event (its end) is due within the event's own
    duration; otherwise the plan is still describing a window whose start is
    ahead of now (e.g. yesterday's instance). Both values come from the
    firmware -- windows are never evaluated here.
    """
    current = plan.get("current_event") if isinstance(plan, dict) else None
    if not isinstance(current, dict):
        return {"in_window": False, "active_rule_id": None}
    delay = plan.get("next_event_delay")
    duration = current.get("duration")
    in_window = bool(
        current.get("state") == "active"
        and _is_number(delay)
        and _is_number(duration)
        and 0 <= delay <= duration + SCHEDULE_JITTER_GRACE
    )
    return {
        "in_window": in_window,
        "active_rule_id": event_rules.get(current.get("id")) if in_window else None,
    }


def _log_schedule(label, resp):
    """Log one scheduler request: method/target, status and body snippet."""
    body = " ".join((resp.text or "").split())[:160]
    log(f"schedule: {label} -> HTTP {resp.status_code}" + (f" {body}" if body else ""))


def _schedule_plan(transport, host, auth):
    """GET /schedule/plan as a dict; raises on any failure."""
    resp = transport.get(
        f"{host.base}/schedule/plan", auth=auth, timeout=HTTP_TIMEOUT
    )
    # Logged only on failure (via the caller): this runs every SCHEDULE_INTERVAL.
    _require_ok(resp)
    plan = resp.json()
    # The firmware answers [] when no events exist; that is an empty plan, not
    # a malformed one. Anything else that is not an object is still an error.
    if isinstance(plan, list) and not plan:
        return {}
    if not isinstance(plan, dict):
        raise ValueError("schedule plan is not a JSON object")
    return plan


def _event_time(value):
    """Firmware times may include seconds; compare at minute precision."""
    return value[:5] if isinstance(value, str) else None


def _event_days(value):
    """Normalized weekday names for comparison (firmware order-insensitive)."""
    if not isinstance(value, list):
        return ()
    return tuple(sorted(str(day).strip().lower() for day in value if isinstance(day, str)))


def _event_matches(existing, desired):
    """True when the firmware already holds this exact event."""
    if not isinstance(existing, dict):
        return False
    return (
        existing.get("state") == desired["state"]
        and _event_time(existing.get("time")) == _event_time(desired["time"])
        and _event_days(existing.get("days")) == _event_days(desired["days"])
    )


def sync_schedule(transport, host, auth, events):
    """Upsert changed firmware events and delete stale ones.

    The firmware upserts by id and never deletes omitted events, so the current
    event list is read first. Events that already match are left untouched (a
    reconcile pass is otherwise read-mostly); every surplus id is DELETEd
    explicitly. Any request failure raises; the caller retries on the next tick.
    """
    resp = transport.get(f"{host.base}/schedule", auth=auth, timeout=HTTP_TIMEOUT)
    _log_schedule("GET /schedule", resp)
    _require_ok(resp)
    existing = resp.json()
    if not isinstance(existing, list):
        raise ValueError("GET /schedule response is not a JSON array")

    existing_by_id = {}
    for event in existing:
        if not isinstance(event, dict):
            continue
        event_id = event.get("id")
        if not isinstance(event_id, int) or isinstance(event_id, bool):
            continue
        existing_by_id[event_id] = event

    desired = {event["id"] for event in events}
    posted = 0
    for event in events:
        if _event_matches(existing_by_id.get(event["id"]), event):
            continue
        # One event per request: the firmware parses POST bodies into 1 KB.
        resp = transport.post(
            f"{host.base}/schedule", json=event, auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"POST /schedule id={event['id']}", resp)
        _require_ok(resp)
        posted += 1

    removed = 0
    for event_id in existing_by_id:
        if event_id in desired:
            continue
        resp = transport.delete(
            f"{host.base}/schedule/{event_id}", auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"DELETE /schedule/{event_id}", resp)
        _require_ok(resp)
        removed += 1
    log(
        f"schedule synced: {len(events)} events ({posted} posted), "
        f"removed {removed}"
    )
# Firmware scheduler limits: 2 events per rule, 50 events total.
MAX_SCHEDULE_RULES = 20
# Allow for the firmware's randomized window start (scheduler_start_window).
SCHEDULE_JITTER_GRACE = 10
TIME_RE = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
# Firmware weekday names, indexed by firmware day (Sunday = 0). Our rules use
# 0 = Monday ... 6 = Sunday, so our day d is firmware day (d + 1) % 7.
FIRMWARE_DAYS = (
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
)
