"""The charger command transport: one serialised HTTP session, HTTP and MQTT.

Extracted from ``bridge.py`` (behavior-preserving move): ``ChargerTransport``
(the process's one locked charger Session), the command-application paths
(direct HTTP, MQTT override with firmware confirmation, MQTT RAPI
transactions) and the confirmation matchers they wait on. The MQTT-ready
gate ``mqtt_command_ready`` lives here too — ``command_loop`` imports it.
"""

import json
import threading

import requests

from charger_host import HTTP_TIMEOUT
from mqtt_source import MqttPublishError
from parsing import CommandError
from schedule import _require_ok


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)



# EVSE states a paused charger reports: 8.2.3 pauses into 254; 255 is the
# firmware's own "disabled" code kept for completeness. A held current shows
# 1/2/3, so this is what separates a pause from a hold.
PAUSED_STATES = frozenset({254, 255})
MIN_AMPS, MAX_AMPS = 6, 48
# Command types the bridge applies; anything else fails before a transport is
# chosen.
COMMAND_TYPES = frozenset({"pause", "resume", "set_current", "rapi"})
class ChargerTransport:
    """The process's one charger Session, serialised by a lock.

    ``requests.Session`` is not documented as thread-safe, and the ESP32 gateway
    is the constrained side of the link: four loops sharing one session and its
    keep-alive pool (capped at two sockets) is cheaper than four sessions. The
    lock is not free: ``HTTP_TIMEOUT`` is the connect/read timeout given to each
    request, and Requests applies it per socket operation rather than as a
    deadline for the whole call. Name resolution is not covered by it, and a
    response that trickles in under the read timeout can keep the call — and the
    lock — held past that value, so there is no strict total-duration bound.
    Other loops' charger calls (commands included) wait for the lock rather than
    fail; Firestore work and the notifier stay outside it.
    """

    def __init__(self, session):
        self._session = session
        self._lock = threading.Lock()

    def get(self, url, **kwargs):
        with self._lock:
            return self._session.get(url, **kwargs)

    def post(self, url, **kwargs):
        with self._lock:
            return self._session.post(url, **kwargs)

    def delete(self, url, **kwargs):
        with self._lock:
            return self._session.delete(url, **kwargs)


def _require_command_ok(resp):
    """``_require_ok`` for a command's HTTP reply, labelled with its transport.

    Only called after a request was sent, so ``transport: "http"`` really names
    the path that carried it. Validation failures are raised before this point
    and keep ``transport`` unset.
    """
    try:
        _require_ok(resp)
    except CommandError as exc:
        exc.transport = "http"
        raise


def _rapi_result(resp):
    """RAPI reply's ret value, or the raw text when the body is not JSON."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text.strip() or None
    return body.get("ret") if isinstance(body, dict) else None


def _command_amps(cmd):
    """Validated, firmware-clamped amps; CommandError when absent/invalid."""
    try:
        return max(MIN_AMPS, min(MAX_AMPS, int(cmd.get("amps"))))
    except (TypeError, ValueError):
        raise CommandError("missing or invalid amps")


def _command_rapi(cmd):
    """The validated RAPI command string, or CommandError."""
    command = cmd.get("command")
    if (
        not isinstance(command, str)
        or not command.startswith("$")
        or len(command) > 32
    ):
        raise CommandError("invalid rapi")
    return command


def mqtt_command_ready(source):
    """True when MQTT may carry a command: connected **and** subscribed."""
    return bool(source is not None and getattr(source, "ready", False))


def _apply_command_http(transport, host, auth, cmd):
    """The existing HTTP path: fallback, and the only path with MQTT off."""
    ctype = cmd.get("type")
    if ctype == "pause":
        resp = transport.post(
            f"{host.base}/override",
            json={"state": "disabled"},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_command_ok(resp)
        return {}
    if ctype == "resume":
        # Clear the manual override; the firmware scheduler takes over again.
        resp = transport.delete(f"{host.base}/override", auth=auth, timeout=HTTP_TIMEOUT)
        if not 200 <= resp.status_code < 300:
            # v5.1.5 answers 500 "Failed to release manual override" when there
            # is nothing to release. The intended end state already holds, so
            # confirm it rather than reporting a spurious failure.
            try:
                status = transport.get(
                    f"{host.base}/status", auth=auth, timeout=HTTP_TIMEOUT
                )
                status.raise_for_status()
                body = status.json()
                if isinstance(body, dict) and body.get("manual_override") == 0:
                    log("resume: no manual override to release; treating as acked")
                    return {}
            except (requests.RequestException, ValueError):
                pass
        _require_command_ok(resp)
        return {}
    if ctype == "set_current":
        amps = _command_amps(cmd)
        resp = transport.post(
            f"{host.base}/override",
            json={"state": "active", "charge_current": amps, "max_current": amps},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_command_ok(resp)
        return {}
    if ctype == "rapi":
        command = _command_rapi(cmd)
        resp = transport.post(
            f"{host.base}/rapi",
            data={"rapi": command, "json": 1},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_command_ok(resp)
        result = _rapi_result(resp)
        log(f"rapi {command}: ret={result!r}")
        return {"result": result}
    raise CommandError("unsupported type")


def _as_int(value):
    """int(value) for numeric-ish input, else None (never raises)."""
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _paused(status):
    """Does this status view show a paused (disabled) charger?

    Firmware 8.2.3 pauses into EVSE ``state`` 254 and reports ``manual_override``
    1; it never reports 255 for a pause. ``manual_override`` alone is 1 for
    *any* override (a hold included), so it only counts together with a
    non-charging EVSE state: a held current still shows ready/connected/
    charging, and a sleeping charger with no override reports the same 254 with
    ``manual_override`` 0. The HTTP ``/status`` reply also carries ``status: "disabled"``, which
    the MQTT status topics do not, so it is accepted when present.
    """
    if not isinstance(status, dict):
        return False
    if status.get("status") == "disabled":
        return True
    return (
        _as_int(status.get("manual_override")) == 1
        and _as_int(status.get("state")) in PAUSED_STATES
    )


def _setpoint_matches(status, amps):
    """Does a status view show ``manual_override`` holding ``amps``?

    The EVSE clamps above its own configured maximum, so a command beyond it
    (``amps`` > ``max_current``) is confirmed by ``pilot`` sitting at that
    maximum rather than at the commanded value. ``max_current`` comes from the
    raw ``/status`` reply: firmware 8.2.3 carries it there (live on the test
    charger: ``pilot`` 16 with ``max_current`` 16, the soft limit), while
    ``/config`` spells the pair ``max_current_soft``/``max_current_hard`` and
    never a bare ``max_current``.
    """
    if _as_int(status.get("manual_override")) != 1:
        return False
    pilot = _as_int(status.get("pilot"))
    if pilot == amps:
        return True
    cap = _as_int(status.get("max_current"))
    return cap is not None and pilot == cap and amps > cap


def _override_confirms(ctype, amps, view):
    """Does an acknowledged override view reflect ``ctype`` / ``amps``?

    The retained ``<base>/override`` document is authoritative: ``null`` is
    auto, ``disabled`` is paused, ``active`` carries the held current. The raw
    status seed is the fallback for the moment before the retained copy lands
    (``manual_override`` 0 = auto, 1 = any override, ``pilot`` = held setpoint).
    Firmware v8.2.3 publishes ``manual_override`` but does not distinguish
    active from disabled with it, hence the override document and ``_paused``.
    """
    override = view.get("override") or {}
    status = view.get("status") or {}
    state = override.get("state")
    # Once the retained document has been seen it is authoritative; the status
    # seed is only a fallback for the moment before it lands (state is None).
    if ctype == "pause":
        if state == "disabled":
            return True
        return state is None and _paused(status)
    if ctype == "resume":
        # "null" is the firmware's auto state (observed on 8.2.3).
        if state in ("null", "auto", "clear"):
            return True
        return state is None and _as_int(status.get("manual_override")) == 0
    # set_current: confirm from the commanded field, not `max_current`, so a
    # firmware that normalises the latter cannot make every hold time out.
    # A document that names no current at all confirms nothing: it cannot tell
    # an applied hold from a lost publish. The read-only /status reconcile in
    # `_apply_override_mqtt` is the second opinion for that shape.
    if state == "active":
        current = override.get("charge_current", override.get("max_current"))
        return current is not None and _as_int(current) == amps
    return state is None and _setpoint_matches(status, amps)


def _status_confirms(ctype, amps, status):
    """The same predicate against a plain HTTP ``/status`` reply."""
    if not isinstance(status, dict):
        return False
    if ctype == "pause":
        return _paused(status)
    if ctype == "resume":
        return _as_int(status.get("manual_override")) == 0
    return _setpoint_matches(status, amps)


def _apply_override_mqtt(transport, host, auth, source, ctype, cmd, confirm_sec):
    """Publish one override command and wait for the firmware to reflect it."""
    if ctype == "pause":
        amps = None
        payload = {"state": "disabled"}
    elif ctype == "resume":
        amps = None
        payload = "clear"
    else:
        amps = _command_amps(cmd)
        payload = {"state": "active", "charge_current": amps, "max_current": amps}
    try:
        source.publish(
            "override/set", json.dumps(payload) if isinstance(payload, dict) else payload
        )
    except MqttPublishError as exc:
        # The client refused the message, so nothing was delivered and the HTTP
        # fallback cannot double-apply. An *accepted* publish never falls back.
        log(f"command transport: http (mqtt publish failed: {exc})")
        return _apply_command_http(transport, host, auth, cmd)
    try:
        confirmed = source.wait_for_state(
            lambda view: _override_confirms(ctype, amps, view), confirm_sec
        )
    except Exception as exc:  # never re-apply because an ack wait crashed
        raise CommandError(
            f"mqtt acknowledgement failed ({exc.__class__.__name__}: {exc})",
            transport="mqtt",
        ) from exc
    if confirmed:
        return {"transport": "mqtt"}
    # The command may have applied while its broadcast was lost. Reconcile
    # read-only over HTTP (the command itself is never re-applied).
    try:
        resp = transport.get(f"{host.base}/status", auth=auth, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        status = resp.json()
    except (requests.RequestException, ValueError):
        status = None
    if _status_confirms(ctype, amps, status):
        log(f"{ctype}: mqtt confirmation missed; confirmed by status reconcile")
        return {"transport": "mqtt"}
    raise CommandError(
        f"no confirmation within {confirm_sec:g}s "
        f"(manual_override/state did not reflect {ctype})",
        transport="mqtt",
    )


def _apply_rapi_mqtt(transport, host, auth, source, cmd, confirm_sec):
    """Publish one RAPI command and map the next rapi/out reply."""
    command = _command_rapi(cmd)
    parts = command.split(None, 1)
    head = parts[0]
    params = parts[1].strip() if len(parts) > 1 else ""
    try:
        reply = source.rapi_transaction(f"rapi/in/{head}", params, confirm_sec)
    except MqttPublishError as exc:
        log(f"command transport: http (mqtt publish failed: {exc})")
        return _apply_command_http(transport, host, auth, cmd)
    except Exception as exc:  # never re-publish because an ack wait crashed
        raise CommandError(
            f"mqtt rapi failed ({exc.__class__.__name__}: {exc})",
            transport="mqtt",
        ) from exc
    if reply is None:
        raise CommandError(
            f"no rapi/out within {confirm_sec:g}s", transport="mqtt"
        )
    text = str(reply).strip()
    if text.startswith("$OK"):
        log(f"rapi {command}: ret={text!r}")
        return {"result": text, "transport": "mqtt"}
    raise CommandError(
        f"rapi {command} failed: {text or 'empty reply'}", transport="mqtt"
    )


def apply_command(transport, host, auth, cmd, source=None, confirm_sec=None):
    """Apply one command document; return extra fields for the command doc.

    MQTT carries the command only while ``source.ready`` (connected and
    subscribed) at the moment it is picked up; otherwise the existing HTTP path
    runs unchanged. A command accepted by the MQTT client is never re-applied
    over HTTP — a missing confirmation fails it instead. The returned
    ``transport`` names the path that carried the command; the HTTP path leaves
    it out, as it always has, and the loop supplies the default. Failures carry
    their transport on ``CommandError.transport`` — unset when the command was
    rejected before anything was sent.
    """
    ctype = cmd.get("type")
    if ctype not in COMMAND_TYPES:
        raise CommandError("unsupported type")
    if confirm_sec is None:
        import bridge  # seam: tests patch bridge.COMMAND_CONFIRM_SEC (PLAN.md facade rule)

        confirm_sec = bridge.COMMAND_CONFIRM_SEC
    else:
        confirm_sec = float(confirm_sec)
    if mqtt_command_ready(source):
        if ctype == "rapi":
            return _apply_rapi_mqtt(
                transport, host, auth, source, cmd, confirm_sec
            )
        return _apply_override_mqtt(
            transport, host, auth, source, ctype, cmd, confirm_sec
        )
    return _apply_command_http(transport, host, auth, cmd)

