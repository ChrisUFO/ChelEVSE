"""Charger health: the advisory rule table and the three-fact classifier.

The gateway's ``GET /notifications`` returns every *live* advisory it evaluates
(acked ones included), but only three facts are honest about each entry:

- **severity** is the firmware's own rating of the condition, copied verbatim --
  liveness never rewrites it (a cleared ground fault stays ``critical``);
- **acked** is the firmware's mute flag, persisted in the gateway's config
  region (erased by a firmware-version change);
- **liveness** must be recomputed here, because the firmware's ``sticky`` field
  is a literal per-rule constant, not a liveness signal: every counter-derived
  advisory (``fault.*``, ``wear.*``) ships ``sticky:false``.

So an entry classifies as

- ``acknowledged`` -- the owner muted it (wins over everything);
- ``active`` -- a live signal the bridge already polls corroborates the rule's
  own raise predicate (a present fault state, the ``$GE`` settings booleans, the
  sensor temperatures, the ``$GL`` relay-thermal level);
- ``historical`` -- a record: the predicate is counter/lifetime-derived, the
  corroborating surface is not exposed, or the firmware's gate for that rule
  family is still closed.

``corroborated`` states the liveness fact on its own, independent of the ack: an
acknowledged advisory whose condition is still present reports both.

:func:`alert_plan` is the one push this project sends about charger health
(#158, D9): one body per newly observed ``critical`` unacknowledged advisory,
deduped on a persisted watermark (D3). It replaces the old "Charging started" /
"Charging stopped" pushes; watchdog and offline pushes live in the watchdog and
the status sink and are untouched.

Nothing here does I/O. The module also carries :class:`LiveObservations`, the one
piece of shared state (a lock and whole-dict swaps) through which the status loop
hands its latest observation and the config loop the config view it wrote to the
notifications loop -- one charger poll per family, no extra GET (D6).

Firmware facts this table mirrors (``notifications_rules.cpp`` @ ``11c84b20``):

- ``safety.*`` raise from the ``$GE`` settings word (``$GL``/VFLAGS in
  ``/status.flags`` is volatile and corroborates nothing), and every safety ack
  is tokened on that word -- changing any check voids the mute. ``/config``
  carries the same five booleans (``app_config.cpp``), so they are the bridge's
  equivalent input.
- ``fault.*`` raise from the latched controller counters (``$GF``) and are
  tokened on the count, so a later trip unmutes a previously acked advisory.
  The counter itself is a lifetime record: only the controller state proves the
  fault is present *now*.
- ``thermal.relay_thermal`` and every ``wear.*`` rule are skipped wholesale until
  ``$GL`` answers; ``/config`` omits the relay block until then (absent is not
  zero).
- ``thermal.high_temp`` is silent with no valid sensor and is raised within
  ``NOTIFICATION_HIGH_TEMP_MARGIN_C`` of the controller's panic temperature.
"""

import threading

from parsing import _is_number, as_int

# The five safety checks the firmware folds into one settings-flags word. The
# order is this module's token order (see ``settings_token``); ``/config``
# exposes them as booleans once the controller has answered.
SAFETY_CHECKS = (
    "ground_check",
    "relay_check",
    "diode_check",
    "vent_check",
    "temp_check",
)
SAFETY_IDS = {f"safety.{check}": check for check in SAFETY_CHECKS}

# ``fault.*``: a live proof that the fault is present *now* is the controller
# state, not the counter (on this charger ``fault.no_ground`` is live with
# ``state 2`` and ``nogndcount 7`` -- a cleared trip kept for the record).
FAULT_STATES = {
    "fault.gfci_tripped": 6,
    "fault.no_ground": 7,
    "fault.stuck_relay": 8,
}
FAULT_COUNTERS = {
    "fault.gfci_tripped": "gfcicount",
    "fault.no_ground": "nogndcount",
    "fault.stuck_relay": "stuckcount",
}
# Counter-backed wear: the counter is both the record the rule reads and the
# firmware's own ack token, so a further event voids an ack.
WEAR_COUNTERS = {
    "wear.relay_cold_open": "relay_cold_open_count",
    "wear.stuck_relay_recovery": "relay_stuck_recovery_count",
}
# The ``$GL`` relay-health block is emitted as a whole once the controller
# answers, so these consumed keys being present is the family's gate.
RELAY_HEALTH_KEYS = (
    "relay_life_pct",
    "relay_cold_open_count",
    "relay_transit_drift_warning",
    "relay_thermal_warning_level",
    "relay_stuck_recovery_count",
)
# The projection's counter order, and the fault-counter names ``parse_status``
# carries in the raw ``/status`` reply.
COUNTER_FIELDS = ("nogndcount", "gfcicount", "stuckcount")
# The projection's top-level content fields: everything a merge write carries
# that a change test compares (``checked_at``/``updated_at`` are write stamps).
# ``ack_command`` is a bridge-build capability fact, not an observation: it is
# constant for the life of the process (a bridge that can acknowledge over
# HTTP, D4), so it never moves the change test after the one write that adds
# it to an older stored document.
CONTENT_FIELDS = (
    "reachable",
    "source",
    "gates",
    "counters",
    "advisories",
    "alerted",
    "ack_command",
)
# ``over_temp_shutdown`` is only emitted on D9+ controllers and defaults to 72
# (``app_config.cpp``); the advisory starts 5 °C below the panic temperature
# (``NOTIFICATION_HIGH_TEMP_MARGIN_C``).
DEFAULT_PANIC_C = 72
HIGH_TEMP_MARGIN_C = 5
# ``relay_thermal_warning_level``: 0 none/not available, 1 watch, 2 warn. Only a
# level at or above 1 is a claim the firmware raised the advisory on.
RELAY_THERMAL_WATCH = 1


def _flag(value):
    """A tri-state boolean from a JSON-ish value (True/False/1/0), else None."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    return None


def gates(config):
    """The two firmware gates, as the projection reports them.

    The gateway evaluates its rules from caches that can still be unknown and
    stays silent while they are: the safety rules from the ``$GE`` settings word
    (``settings_flags == 0`` until it answers) and every ``$GL`` rule (``wear.*``,
    ``thermal.relay_thermal``) until the relay block arrives. Silence under an
    open gate means "health incomplete", never "no faults" -- an empty advisory
    list is only evidence of health when both gates are closed *false*.
    """
    config = config if isinstance(config, dict) else {}
    return {
        "settings_known": all(
            _flag(config.get(check)) is not None for check in SAFETY_CHECKS
        ),
        "relay_health_known": all(
            config.get(key) is not None for key in RELAY_HEALTH_KEYS
        ),
    }


def counter_view(counters):
    """The three latched fault counters, absent/unknown as None."""
    counters = counters if isinstance(counters, dict) else {}
    return {name: as_int(counters.get(name)) for name in COUNTER_FIELDS}


def settings_token(config):
    """The five safety booleans as one token -- the firmware's ack token.

    ``1`` is a check enabled and ``0`` disabled, in :data:`SAFETY_CHECKS` order.
    None when the gate is closed: an unknown settings word is not "all enabled".
    """
    config = config if isinstance(config, dict) else {}
    flags = [_flag(config.get(check)) for check in SAFETY_CHECKS]
    if any(flag is None for flag in flags):
        return None
    return "".join("1" if flag else "0" for flag in flags)


def _high_temp(config, temps):
    """Whether a valid sensor sits within the advisory's margin of panic."""
    valid = [temp for temp in temps if _is_number(temp)]
    if not valid:
        return False
    panic = as_int(config.get("over_temp_shutdown"))
    if panic is None or panic <= 0:
        panic = DEFAULT_PANIC_C
    return max(valid) >= panic - HIGH_TEMP_MARGIN_C


def _corroborated(advisory_id, facts):
    """Whether a live signal corroborates this advisory right now."""
    config = facts.get("config")
    config = config if isinstance(config, dict) else {}
    check = SAFETY_IDS.get(advisory_id)
    if check is not None:
        # A safety advisory is raised when the check is *disabled*.
        return _flag(config.get(check)) is False
    if advisory_id in FAULT_STATES:
        # The counter is a record; the controller state is the live proof.
        return as_int(facts.get("state")) == FAULT_STATES[advisory_id]
    if advisory_id == "thermal.high_temp":
        return _high_temp(config, facts.get("temps") or ())
    if advisory_id == "thermal.relay_thermal":
        level = as_int(config.get("relay_thermal_warning_level"))
        return level is not None and level >= RELAY_THERMAL_WATCH
    # thermal.throttling exposes no live signal at all, and every wear.* rule is
    # a lifetime record by definition.
    return False


def classify(advisory, facts):
    """``(classification, corroborated)`` for one live advisory.

    ``acknowledged`` wins over the other two: a mute is the owner's decision and
    outranks both the severity and the liveness fact (which is still reported).
    """
    corroborated = _corroborated(advisory.get("id"), facts)
    if advisory.get("acked"):
        return "acknowledged", corroborated
    return ("active" if corroborated else "historical"), corroborated


def counter_token(advisory, facts):
    """The value that voids an ack for this advisory (the alert watermark's token).

    It mirrors the firmware's own rule token wherever the firmware has one, so a
    bridge-side watermark moves exactly when the firmware would unmute:

    - ``safety.*`` -- the five settings booleans together (the ``$GE`` word);
    - ``fault.*`` -- the controller counter (a new trip moves it);
    - ``wear.relay_cold_open`` / ``wear.stuck_relay_recovery`` -- their counters;
    - ``thermal.relay_thermal`` -- the ``$GL`` level (1 watch, 2 warn; the level,
      not the continuously moving thermal index, is the firmware's token);
    - ``wear.relay_life`` -- the severity step (``notifications_rules.cpp``:
      "Token is the severity step, not the percentage: ordinary wear ticking
      20 -> 19 must not void an ack");
    - everything else -- ``first_seen`` (the firmware's token is the constant
      0, so a re-raise is the only change there is).
    """
    advisory_id = advisory.get("id")
    config = facts.get("config")
    config = config if isinstance(config, dict) else {}
    counters = facts.get("counters")
    counters = counters if isinstance(counters, dict) else {}
    if advisory_id in SAFETY_IDS:
        return settings_token(config)
    if advisory_id in FAULT_COUNTERS:
        return as_int(counters.get(FAULT_COUNTERS[advisory_id]))
    if advisory_id in WEAR_COUNTERS:
        return config.get(WEAR_COUNTERS[advisory_id])
    if advisory_id == "thermal.relay_thermal":
        return as_int(config.get("relay_thermal_warning_level"))
    if advisory_id == "wear.relay_life":
        return advisory.get("severity")
    return advisory.get("first_seen")


def project(notifications, facts, first_observed, observed_at, alerted):
    """Project the live ring into ``status/notifications``' content.

    ``notifications`` is :func:`parsing.parse_notifications`' list; ``facts`` is
    a :class:`LiveObservations` snapshot; ``first_observed`` maps
    ``(id, counter_token)`` to the epoch second this bridge first saw that
    advisory state. Returns ``(content, first_observed)``: the content is every
    field of the document except the write stamps, ``last_seen`` included (the
    change test compares :func:`comparable` of it, which drops that moving
    field), and the map is the input plus whatever this observation added,
    pruned to the current ring, so a re-raised advisory is a new observation.

    The advisory list mirrors the gateway's ring exactly -- an entry that left it
    is gone, no synthetic history -- and keeps the ring's own order.
    """
    entries = []
    observed = {}
    for advisory in notifications or []:
        token = counter_token(advisory, facts)
        key = (advisory.get("id"), token)
        stamp = first_observed.get(key, observed_at)
        observed[key] = stamp
        classification, corroborated = classify(advisory, facts)
        entries.append(
            {
                "id": advisory.get("id"),
                "category": advisory.get("category"),
                "severity": advisory.get("severity"),
                "firmware_sticky": advisory.get("firmware_sticky"),
                "acked": advisory.get("acked"),
                "first_seen": advisory.get("first_seen"),
                "last_seen": advisory.get("last_seen"),
                "classification": classification,
                "corroborated": corroborated,
                "counter_token": token,
                "first_observed": stamp,
            }
        )
    content = {
        "reachable": True,
        "source": "http",
        "gates": gates(facts.get("config")),
        "counters": counter_view(facts.get("counters")),
        "advisories": entries,
        "alerted": dict(alerted or {}),
        # A bridge-build capability fact for the web (issue #159: the ack
        # control must fail closed against an older bridge that cannot
        # acknowledge over HTTP): additive, absent on documents written by
        # those older bridges, so ``=== true`` is the gate.
        "ack_command": True,
    }
    return content, observed


def comparable(content):
    """The change test's stability view of a projection.

    The gateway re-stamps ``last_seen`` on **every** evaluation pass (~5 s) for
    every live advisory, so the raw projection differs on every poll while
    nothing about the charger's health has changed. Comparing this view -- the
    content with each entry's ``last_seen`` dropped -- keeps a steady state at
    zero writes, while every real change still writes: an ack flip, a
    counter/token move, an advisory added or removed, a gate, counter or
    reachability/source transition (``first_seen``, ``acked``, ``severity``,
    ``classification`` and ``corroborated`` all stay in the view).

    ``last_seen`` itself stays in the written document: it is the honest "still
    seen at" fact, refreshed by whichever poll does write.
    """
    if not isinstance(content, dict):
        return content
    stable = dict(content)
    entries = stable.get("advisories")
    if isinstance(entries, list):
        stable["advisories"] = [
            {key: value for key, value in entry.items() if key != "last_seen"}
            if isinstance(entry, dict)
            else entry
            for entry in entries
        ]
    return stable


# --- The one alert (issue #158, D9) ------------------------------------------
# Human names for the firmware's rule ids, mirroring the web's table
# (``web/js/health.js`` NAMES) so a push and the Health card name a condition the
# same way. Duplicated rather than shared: the two runtimes share no module (an
# ES module in the browser, Python on the Pi), and the table is the firmware's
# bounded 15-id rule set -- a newer rule falls back to its id's tail.
RULE_NAMES = {
    "safety.ground_check": "Ground check",
    "safety.relay_check": "Relay check",
    "safety.diode_check": "Diode check",
    "safety.vent_check": "Vent check",
    "safety.temp_check": "Temperature check",
    "fault.gfci_tripped": "GFCI tripped",
    "fault.no_ground": "No ground",
    "fault.stuck_relay": "Stuck relay",
    "thermal.high_temp": "High temperature",
    "thermal.relay_thermal": "Relay temperature",
    "thermal.throttling": "Throttling",
    "wear.relay_life": "Relay life",
    "wear.relay_cold_open": "Relay cold open",
    "wear.relay_transit_drift": "Relay transit drift",
    "wear.stuck_relay_recovery": "Stuck relay recovery",
}
# Only the firmware's own top rating alerts: anything it rated below ``critical``
# stays on the Health card and in the journal, never on a push.
ALERT_SEVERITY = "critical"


def rule_name(advisory_id):
    """The English name of one firmware rule id (never empty)."""
    if not isinstance(advisory_id, str) or not advisory_id:
        return "Advisory"
    name = RULE_NAMES.get(advisory_id)
    if name:
        return name
    tail = advisory_id.rsplit(".", 1)[-1].replace("_", " ").strip()
    return tail[:1].upper() + tail[1:] if tail else "Advisory"


def watermark_key(advisory_id, counter_token):
    """The alert watermark's one string key for an advisory (D3).

    D3's key is ``(id, counter_token)``; a Firestore map key is a string, so the
    pair renders as ``<id>|<token>`` (``fault.no_ground|7``). ``|`` cannot occur
    in a firmware rule id, and the token is a counter, the settings word, a
    severity step or ``first_seen``, so the rendering is unambiguous.
    """
    return f"{advisory_id}|{counter_token}"


def alert_body(entry):
    """The push body for one projected advisory entry.

    The severity is the firmware's own, but liveness is not: a counter-derived
    advisory keeps ``critical`` after the condition cleared, so the body calls it
    *recorded* instead of claiming a live emergency, and only a corroborated
    (``active``) entry may say the condition is present now.
    """
    name = rule_name(entry.get("id"))
    if entry.get("classification") == "active":
        return f"Charger health: {name} active now — see Health."
    return f"Charger health: {name} recorded — see Health. Not a live fault."


def alert_plan(advisories, alerted, observed_at):
    """Which advisories owe one push, and the watermark to persist beside it.

    Pure (no I/O). The caller writes the returned map in the same
    ``status/notifications`` pass that persists the projection, so the push and
    its dedupe watermark cannot drift; a restart that seeds the written map
    sends nothing.

    One push per advisory the firmware rated ``critical``, that is not
    acknowledged, and whose D3 watermark key is absent. Everything else is
    silent: a repeated poll, an acknowledged entry, a rating below ``critical``,
    and an advisory this bridge already alerted all leave the map as it is.

    An entry whose token is unknown (``None``: the counter, settings word or
    ``first_seen`` this key is built from has not been observed yet) is
    *undecidable*, not actionable: it pushes nothing this pass and the map is
    left whole, because a state without a stable key cannot be deduped and the
    seeded keys this pass cannot re-derive must survive it. The first pass with
    the facts decides -- once, on the real key -- so a cold observation window
    delays an alert instead of duplicating it.

    On a pass that can key every entry, the returned map keeps only the current
    ring's keys, so it stays bounded by the ring (the firmware's own 15 ids)
    instead of growing for the life of the bridge; an undecided pass (above)
    carries the map forward whole, so keys the ring no longer lists can linger
    until the first pass with the facts, which prunes them. That pruning never
    costs an alert: a re-raise is a *new* key by construction (D3 -- a new trip
    moves the counter, a new settings word voids the ack), so a key can only
    reappear with its own push.
    """
    known = alerted if isinstance(alerted, dict) else {}
    messages = []
    ring = []
    undecided = False
    for entry in advisories or []:
        if not isinstance(entry, dict):
            continue
        token = entry.get("counter_token")
        if token is None:
            undecided = True
            continue
        key = watermark_key(entry.get("id"), token)
        ring.append(key)
        if key in known or entry.get("acked"):
            continue
        if entry.get("severity") != ALERT_SEVERITY:
            continue
        messages.append({"key": key, "body": alert_body(entry)})
    if undecided:
        # No key of this ring can be called stale: the undecidable entry's
        # seeded key is still the one its facts will produce, and deleting it
        # here would re-alert on the next pass.
        watermark = dict(known)
    else:
        watermark = {key: known[key] for key in ring if key in known}
    for message in messages:
        watermark[message["key"]] = observed_at
    return messages, watermark


class LiveObservations:
    """The latest live observations the health projection reads (D6).

    Everything the classifier needs is already fetched by other loops -- the
    status loop's ``/status`` reply (controller state, sensor temperatures, the
    ``$GF`` fault counters) and the config loop's ``/config`` view (the five
    safety booleans, the panic threshold, the ``$GL`` relay block) -- so the
    health loop reads them here rather than polling the charger again, and
    ``status/current`` keeps its curated field set untouched.

    One lock and whole-dict swaps: a reader sees one loop's complete
    observation, never a half-written mix. Values are replaced, never mutated,
    so a snapshot can hand out shallow copies safely.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._facts = {
            "state": None,
            "temps": (None, None, None),
            "counters": {},
            "config": None,
        }

    def note_status(self, fields, counters):
        """Record one applied ``/status`` observation.

        ``fields`` is the parsed status (``parse_status``); ``counters`` is
        ``parse_fault_counters`` of the same raw reply. Only what the classifier
        reads is kept.
        """
        with self._lock:
            self._facts = {
                **self._facts,
                "state": fields.get("state"),
                "temps": (
                    fields.get("temp1"),
                    fields.get("temp2"),
                    fields.get("temp3"),
                ),
                "counters": dict(counters or {}),
            }

    def note_config(self, view):
        """Record the config view the config loop just wrote to ``status/config``."""
        with self._lock:
            self._facts = {**self._facts, "config": dict(view or {})}

    def snapshot(self):
        """One consistent view of the latest observations (a shallow copy)."""
        with self._lock:
            facts = self._facts
            config = facts["config"]
            return {
                "state": facts["state"],
                "temps": facts["temps"],
                "counters": dict(facts["counters"]),
                "config": dict(config) if config is not None else None,
            }
