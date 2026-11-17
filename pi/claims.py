"""Charger claim arbitration: the one authoritative "why isn't it charging?".

The OpenEVSE gateway (ESP32 firmware >= 4.1.5) resolves every claim -- manual
pause, schedule, boost, limit, error, solar divert, OCPP, ... -- itself, and
answers the resolved arbitration at ``GET /claims/target``. That answer is the
only authoritative source for the reason line (#159): the gateway names the
winning client id per property, and this module maps those ids to a bounded
seven-token vocabulary. The ids are treated as opaque names (priorities are
compile-time and version-dependent; never hardcode an order).

Retained MQTT documents (``<base>/claim``, ``<base>/limit``, ``<base>/boost``)
are **supporting evidence, never an answer**: they carry no authoritative
freshness, so they enrich the ``detail`` of a reason the gateway already gave
(boost remaining, limit type/value) and corroborate it, but can never change
the reason. The retained ``<base>/schedule`` event list is not evidence and is
not ingested: the ``schedule`` reason's active rule id comes from the schedule
loop's ``/schedule/plan`` window, a fresher source than a retained document.
When the authoritative target is unavailable -- firmware below 4.1.5 answers
404, the fetch can fail, the bridge may have just started -- the derived reason
is ``unknown``: no retained document may yield a confident reason on its own
(fail-closed).

The reason vocabulary and its precedence (each step is decided only when the
ones above it could not):

1. no authoritative target available -> ``unknown``;
2. charger offline -> ``unknown``;
3. a ``claims.state`` winner, mapped by client id: manual 65537 ->
   ``manual_override``, timer/schedule 65540 -> ``schedule``, boost 65539 ->
   ``boost``, limit 65542 -> ``current_limit``, error 65543 / shaper 65548 /
   temp_throttle 65549 -> ``safety``; every other id (divert 65538, ocpp
   65545, rfid 65546, mqtt 65547, an unknown future id) -> ``unknown``;
4. no state winner but the ``charge_current``/``max_current`` winner is the
   limit client -> ``current_limit``;
5. no winner at all and the vehicle is known disconnected -> ``not_connected``;
6. otherwise ``None`` -- charging/ready with no restriction; the web hides the
   line.

Nothing here does I/O. :class:`ClaimsObservations` is the shared state (a
lock and whole-dict swaps, the :class:`health.LiveObservations` pattern): the
status loop hands it the latest applied observation (vehicle, state,
``claims_version``), the schedule loop the active window, the MQTT source the
retained evidence documents, and the claims loop reads one consistent
snapshot beside its own fetch. The trigger :class:`threading.Event` it owns is
how those loops wake the claims loop between its safety cadences.
"""

import threading

from parsing import as_int

# The gateway's claim client ids (``claims.cpp``): opaque names, mapped to the
# firmware's own words for the document and the journal. Priorities live in
# the gateway, not here.
CLAIM_CLIENTS = {
    65537: "manual",
    65538: "divert",
    65539: "boost",
    65540: "timer",
    65542: "limit",
    65543: "error",
    65545: "ocpp",
    65546: "rfid",
    65547: "mqtt",
    65548: "shaper",
    65549: "temp_throttle",
}
# ``claims.state`` winner -> reason token. Every id without an entry derives
# ``unknown`` (an unmapped winner is a restriction this vocabulary cannot
# name, never "no restriction").
STATE_CLIENT_REASONS = {
    65537: "manual_override",
    65539: "boost",
    65540: "schedule",
    65542: "current_limit",
    65543: "safety",
    65548: "safety",
    65549: "safety",
}
LIMIT_CLIENT = 65542
# The resolved target's own state words (``properties.state``).
TARGET_STATES = ("active", "disabled", "none")
LIMIT_TYPES = ("time", "energy", "soc", "range")

# The projection's content fields: everything a merge write carries that a
# change test compares (``checked_at``/``updated_at`` are write stamps, and
# :func:`comparable` additionally drops the one moving evidence value).
CONTENT_FIELDS = (
    "reachable",
    "source",
    "reason",
    "winner_state",
    "winner_current",
    "detail",
)
# Write stamps, never part of the change test.
STAMP_FIELDS = ("checked_at", "updated_at")


def client_name(client_id):
    """The firmware's own word for a claim client id (never empty)."""
    name = CLAIM_CLIENTS.get(client_id)
    return name if name is not None else str(client_id)


def normalize_target(payload):
    """``GET /claims/target`` JSON -> the subset the derivation reads.

    Returns None when the payload is not the claims contract at all -- not an
    object, no ``properties`` object -- which the caller records as
    unsupported rather than guessing. ``claims`` is the part the derivation
    reads; the ``properties`` subset alongside it is deliberate shape-pinning,
    not projection: the state/currents/auto_release are validated (coerced or
    None) here and nowhere else, so a contract drift surfaces at
    normalization, once -- nothing downstream reads them. Everything inside
    is tolerated: an absent ``claims`` object is no winners, an absent key
    never wins, an unknown state word is None, ids and currents coerce to
    int or None, and a non-boolean ``auto_release`` is None.
    """
    if not isinstance(payload, dict):
        return None
    properties = payload.get("properties")
    if not isinstance(properties, dict):
        return None
    claims = payload.get("claims")
    if claims is None:
        claims = {}
    if not isinstance(claims, dict):
        return None
    state = properties.get("state")
    auto_release = properties.get("auto_release")
    return {
        "state": state if state in TARGET_STATES else None,
        "charge_current": as_int(properties.get("charge_current")),
        "max_current": as_int(properties.get("max_current")),
        "auto_release": auto_release if isinstance(auto_release, bool) else None,
        "claims": {
            name: as_int(claims.get(name))
            for name in ("state", "charge_current", "max_current")
        },
    }


def _detail(reason, evidence, schedule):
    """The evidence enrichment for a derived reason (never a reason itself).

    Only the documents that plausibly explain the reason are carried, and
    only the fields that are stable enough to compare: the boost countdown
    (``remaining``) moves on its own, so :func:`comparable` drops it and a
    ticking boost costs no per-poll write. Absent or malformed evidence
    simply leaves the key out -- detail is enrichment, never a requirement.
    """
    detail = {}
    evidence = evidence if isinstance(evidence, dict) else {}
    if reason == "manual_override" and isinstance(evidence.get("claim"), dict):
        detail["claim"] = dict(evidence["claim"])
    if reason == "current_limit" and isinstance(evidence.get("limit"), dict):
        detail["limit"] = dict(evidence["limit"])
    if reason == "boost" and isinstance(evidence.get("boost"), dict):
        detail["boost"] = dict(evidence["boost"])
    if reason == "schedule":
        window = schedule if isinstance(schedule, dict) else {}
        rule_id = window.get("active_rule_id")
        if isinstance(rule_id, str) and rule_id and len(rule_id) <= RULE_ID_MAX:
            detail["schedule_rule_id"] = rule_id
    return detail


def derive_reason(target, observations):
    """The authoritative reason for the charger not charging, as a dict.

    ``{reason, winner_state, winner_current, detail}``: ``reason`` is one of
    the seven tokens or None (no restriction -- the web hides the line);
    ``winner_state``/``winner_current`` name the gateway's winning claim
    clients (the firmware's own words, e.g. ``"manual"``, ``"limit"``) or
    None; ``detail`` is the retained-evidence enrichment. ``target`` is
    :func:`normalize_target`'s result or None (no authoritative answer);
    ``observations`` is a :class:`ClaimsObservations` snapshot (``vehicle``,
    ``evidence``, ``schedule``; ``charger_online`` may be merged in by the
    caller). Pure: no I/O, and the retained evidence can enter only through
    ``detail`` -- structurally incapable of moving ``reason``.
    """
    observations = observations if isinstance(observations, dict) else {}
    derived = {
        "reason": None,
        "winner_state": None,
        "winner_current": None,
        "detail": {},
    }
    # 1. No authoritative target: retained evidence never yields a confident
    #    reason, whatever it claims.
    if target is None:
        derived["reason"] = "unknown"
        return derived
    # 2. The charger is offline: its last arbitration is stale, not current.
    if observations.get("charger_online") is False:
        derived["reason"] = "unknown"
        return derived
    claims = target["claims"]
    state_winner = claims.get("state")
    current_winners = (claims.get("charge_current"), claims.get("max_current"))
    # The current winner the document names: the restriction when it is the
    # limit client, otherwise the first current claim that wins.
    current_winner = claims.get("charge_current")
    if current_winner is None:
        current_winner = claims.get("max_current")
    if LIMIT_CLIENT in current_winners:
        current_winner = LIMIT_CLIENT
    derived["winner_current"] = (
        client_name(current_winner) if current_winner is not None else None
    )
    # 3. The state winner decides, mapped by id; an unmapped winner is a
    #    restriction this vocabulary cannot name.
    if state_winner is not None:
        derived["reason"] = STATE_CLIENT_REASONS.get(state_winner, "unknown")
        derived["winner_state"] = client_name(state_winner)
    # 4. No state winner, but the limit client holds a current: the cap is
    #    the restriction.
    elif LIMIT_CLIENT in current_winners:
        derived["reason"] = "current_limit"
    else:
        # ``vehicle`` is the raw status fact; coerce once, and an unknown
        # value (non-numeric, a bool) stays unknown -- never a guess.
        vehicle = as_int(observations.get("vehicle"))
        # 5. No winner at all and the vehicle is known disconnected: the
        #    charger has no restriction to name. An unknown vehicle never
        #    guesses "not connected".
        if (
            state_winner is None
            and current_winner is None
            and vehicle is not None
            and vehicle != 1
        ):
            derived["reason"] = "not_connected"
        # 6. Otherwise None: charging/ready with no restriction.
    derived["detail"] = _detail(
        derived["reason"], observations.get("evidence"), observations.get("schedule")
    )
    return derived


def project(target, observations):
    """The ``status/claims`` content for one authoritative observation.

    Everything the document carries except the write stamps; the caller adds
    ``checked_at``/``updated_at`` and compares :func:`comparable` of this
    against the last written content, so a steady charger costs zero writes.
    """
    return {"reachable": True, "source": "http", **derive_reason(target, observations)}


def comparable(content):
    """The change test's stability view of a claims projection.

    Drops the write stamps and the boost countdown: the gateway re-serves an
    identical ``/claims/target`` and the broker redelivers an identical
    retained boost on every reconnect, and a value that moves on its own
    (``detail.boost.remaining`` ticks down while a boost runs) must not turn
    each poll into a write. The written document still carries both: the
    stamps record the observation that produced the last write, and the
    remaining value is the honest "as of that write" fact.
    """
    if not isinstance(content, dict):
        return content
    stable = {key: value for key, value in content.items() if key not in STAMP_FIELDS}
    detail = stable.get("detail")
    if isinstance(detail, dict) and isinstance(detail.get("boost"), dict):
        boost = {
            key: value for key, value in detail["boost"].items() if key != "remaining"
        }
        stable["detail"] = {**detail, "boost": boost}
    return stable


# --- Retained evidence: defensive parsers -------------------------------------


def parse_claim(value):
    """The retained ``<base>/claim`` document -> the claim subset, or None.

    ``{"state": "null"}`` is the idle charger (no claim held); anything that
    is not an object with a recognised state word is not evidence.
    """
    if not isinstance(value, dict):
        return None
    state = value.get("state")
    if state == "null":
        return None
    if state not in ("active", "disabled"):
        return None
    subset = {"state": state}
    priority = as_int(value.get("priority"))
    if priority is not None:
        subset["priority"] = priority
    for key in ("charge_current", "max_current"):
        current = as_int(value.get(key))
        if current is not None:
            subset[key] = current
    auto_release = value.get("auto_release")
    if isinstance(auto_release, bool):
        subset["auto_release"] = auto_release
    return subset


def parse_limit(value):
    """The retained ``<base>/limit`` document -> ``{type, value}``, or None."""
    if not isinstance(value, dict) or value.get("type") not in LIMIT_TYPES:
        return None
    amount = as_int(value.get("value"))
    if amount is None:
        return None
    subset = {"type": value["type"], "value": amount}
    auto_release = value.get("auto_release")
    if isinstance(auto_release, bool):
        subset["auto_release"] = auto_release
    return subset


# A boost's ``type`` is a firmware word ("time"/"energy") and ``started`` an
# ISO-8601 timestamp: caps turn the two only-unbounded strings in the
# retained-evidence path into bounded ones, so a hostile retained document
# cannot ride ``detail`` over Firestore's ~1 MiB write limit (drop-the-key,
# the same semantics as ``as_int``'s int64 bound). Both are an order of
# magnitude beyond anything the firmware writes.
BOOST_TYPE_MAX = 32
BOOST_STARTED_MAX = 64

# The schedule window's rule id is owner-authored (the local
# ``schedule/current`` document mirrored through the schedule loop), not
# retained evidence -- but it rides ``detail`` into the same merge write,
# so it gets the same treatment: an oversized id cannot be allowed to
# cross Firestore's ~1 MiB write limit, because a claims write that
# cannot land is retried on every later trigger (the loop never advances
# past a failed write). Drop-the-key, the boost-cap semantics;
# ``status/current``'s schedule window keeps carrying the id verbatim.
RULE_ID_MAX = 64


def parse_boost(value):
    """The retained ``<base>/boost`` document -> the boost subset, or None.

    ``{}`` is idle (no boost running). A running boost carries at least its
    type; ``remaining`` and ``started`` are kept when present. Both strings
    are length-bounded: a ``type`` past its cap is not a firmware word, so
    the document is not evidence at all, and an oversized ``started`` is
    dropped while the bounded fields stay.
    """
    if not isinstance(value, dict) or not value:
        return None
    boost_type = value.get("type")
    if (
        not isinstance(boost_type, str)
        or not boost_type
        or len(boost_type) > BOOST_TYPE_MAX
    ):
        return None
    subset = {"type": boost_type}
    amount = as_int(value.get("value"))
    if amount is not None:
        subset["value"] = amount
    remaining = as_int(value.get("remaining"))
    if remaining is not None:
        subset["remaining"] = remaining
    started = value.get("started")
    if isinstance(started, str) and len(started) <= BOOST_STARTED_MAX:
        subset["started"] = started
    return subset


# The retained evidence topic leaves and their defensive parsers. The
# retained ``<base>/schedule`` event list is deliberately absent: nothing
# consumes it (the ``schedule`` reason's rule id comes from the schedule
# loop's window, :meth:`ClaimsObservations.note_schedule`), so a delivery of
# it is not evidence at all.
EVIDENCE_PARSERS = {
    "claim": parse_claim,
    "limit": parse_limit,
    "boost": parse_boost,
}


class ClaimsObservations:
    """The latest facts the claims projection reads, and its wake-up trigger.

    One lock and whole-value swaps, the :class:`health.LiveObservations`
    pattern: a reader sees one loop's complete fact set, never a half-written
    mix. The status loop notes every applied observation (``vehicle``,
    ``state``, ``state_label``, and the raw ``/status`` reply's
    ``claims_version``), the schedule loop the active window, and the MQTT
    source each retained evidence document as it arrives. ``trigger`` is the
    event those loops set to fetch the authoritative target between the
    safety cadences (#159).
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.trigger = threading.Event()
        self._facts = {
            "vehicle": None,
            "state": None,
            "state_label": None,
            "claims_version": None,
            "evidence": {},
            "schedule": None,
        }

    def wake(self):
        """Ask the claims loop to fetch now (set its trigger event)."""
        self.trigger.set()

    def note_status(self, fields, payload=None):
        """Record one applied observation; True when the claims loop wakes.

        ``fields`` is the parsed status (full or partial -- only the keys it
        carries are merged, so an MQTT burst's fields never null the rest);
        ``payload`` is the raw ``/status`` reply when there is one, and is the
        only source of ``claims_version`` (older firmware omits it, which
        simply leaves the fact unknown). Returns True when this observation
        moved a claims-relevant fact: the ``claims_version`` counter or a
        ``state``/``state_label`` transition -- the two immediacy triggers.
        """
        fields = fields if isinstance(fields, dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            facts = self._facts
            updates = {}
            wake = False
            for key in ("vehicle", "state", "state_label"):
                if key in fields:
                    if fields[key] != facts[key] and key != "vehicle":
                        wake = True
                    updates[key] = fields[key]
            if "claims_version" in payload:
                version = payload["claims_version"]
                if version != facts["claims_version"]:
                    wake = True
                updates["claims_version"] = version
            if updates:
                self._facts = {**facts, **updates}
            return wake

    def note_evidence(self, leaf, value):
        """Record one retained evidence document (``on_evidence`` callback).

        The value is the decoded topic payload; a leaf that is not evidence,
        or a payload that does not parse, is ignored -- and a leaf that goes
        unparseable drops its previous value rather than keeping a stale one.
        """
        parser = EVIDENCE_PARSERS.get(leaf)
        if parser is None:
            return
        parsed = parser(value)
        with self._lock:
            evidence = dict(self._facts["evidence"])
            if parsed is None:
                evidence.pop(leaf, None)
            else:
                evidence[leaf] = parsed
            self._facts = {**self._facts, "evidence": evidence}

    def note_schedule(self, window):
        """Record the schedule loop's active window (``schedule_state``)."""
        with self._lock:
            self._facts = {
                **self._facts,
                "schedule": dict(window) if isinstance(window, dict) else None,
            }

    def snapshot(self):
        """One consistent view of the latest facts (a shallow copy)."""
        with self._lock:
            facts = self._facts
            return {
                "vehicle": facts["vehicle"],
                "state": facts["state"],
                "state_label": facts["state_label"],
                "claims_version": facts["claims_version"],
                "evidence": dict(facts["evidence"]),
                "schedule": (
                    dict(facts["schedule"]) if facts["schedule"] is not None else None
                ),
            }
