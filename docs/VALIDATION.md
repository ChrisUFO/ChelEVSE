# Validating a deployment

An end-to-end checklist for a deployed ChelEVSE stack: Firebase project, PWA,
Pi bridge, charger. Every item states what to do, what you should observe, and
the evidence to keep. Record results in the log at the end (or in the PR/issue
that closes the rollout).

Use it after a fresh deploy ([DEPLOY.md](DEPLOY.md)), after a release that
touches `pi/` or the web shell, and once on site for the human checks in §9.

## 0. Preconditions

- The deployment is complete: rules, indexes and hosting are released; the Pi
  service is `active`; the tester's account is allowlisted.
- Two Google accounts are available: the owner (granted) and a second account
  (not granted), for the access checks.
- The phone has the app open at least once (installed to the home screen for the
  push checks); a laptop is useful for the DevTools offline/network checks and
  the Firebase console.
- **Safety:** the app writes real commands to a real charger. Use read-only RAPI
  commands (`$GS`) unless you intend to change a setting, never hand-edit the
  firmware schedule while the bridge owns it, and do not run the schedule
  round-trip on a car that must keep charging.

Evidence types used below: a screenshot, a `journalctl` line, a Firestore
document (console or a `firebase` query), a command document id, or the output
of a shell command.

## 1. Failure modes (`ARCHITECTURE.md`)

Each row of the architecture's failure-mode table, with a way to trigger it.

| #    | Failure                           | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Expected observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence to capture                                                                                                       |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Pi offline                        | `sudo systemctl stop chelevse-bridge` and leave it stopped                                                                                                                                                                                                                                                                                                                                                                                                                                           | After ~60 s the status screen banner reads **"Bridge offline — showing last known values"**; values and the session clock stay put.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Screenshot (banner + `updated …` age), `systemctl is-active` output                                                       |
| 1.2  | Charger unreachable               | Power off the charger (or block the Pi's route to it) while the bridge runs                                                                                                                                                                                                                                                                                                                                                                                                                          | Within one status tick `charger_online` becomes `false`; banner reads **"Charger offline — showing last known values"** (not "Bridge offline"). The bridge logs the outage once (`charger offline (<reason>)`) and keeps retrying; later failed polls only refresh the status document, so no further journal lines appear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Screenshot of the banner, the `charger offline (…)` journal line carrying `No route to host` / HTTP status                |
| 1.3  | Firebase blip                     | Disable the Pi's internet (unplug uplink / `sudo ip link set … down`) for ~2 min, then restore                                                                                                                                                                                                                                                                                                                                                                                                       | Journal lines only; status resumes on the next tick without a restart; history deltas are not double-counted and no negative delta appears.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Journal excerpt before/after, `history/<date>.kwh` unchanged across the outage                                            |
| 1.4  | PWA offline (open app)            | DevTools → Network → Offline (or airplane mode) with the app already loaded                                                                                                                                                                                                                                                                                                                                                                                                                          | Header badge changes **Live → Offline**; the last snapshot stays on screen; the banner appears after ~60 s. Tab switches still work from the shell cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Screenshot, DevTools Network tab showing cache hits for `app.js`/`js/*`                                                   |
| 1.5  | PWA offline (cold reload)         | Reload the page while still offline                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Expected limitation:** the boot card appears ("Configuration missing" / failed to load), because `firebase-config.js` and the Firebase SDK are deliberately network-only. The app works offline only while it is already loaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Screenshot; note that reloading online recovers                                                                           |
| 1.6  | Stale shell after deploy          | Deploy a shell change, then reopen the app without clearing data                                                                                                                                                                                                                                                                                                                                                                                                                                     | New shell loads (no-cache on `index.html`, `sw.js`, `firebase-config.js`); if an old tab keeps old modules, close/reopen it. If shell files changed without bumping `CACHE` in `web/sw.js`, the old shell can persist — that is the bug to file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Deployed commit SHA, `sw.js` cache name, screenshot of the new UI                                                         |
| 1.7  | Index still building              | Run `npm run deploy:indexes`, then open **Advanced** (the scrollback query) before the build finishes                                                                                                                                                                                                                                                                                                                                                                                                | The screen explains that the index is still being built instead of showing a generic error; once the console reports the index **Ready**, a reload lists the recent commands. The same screen after the build is checked in §3.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Screenshot of the in-progress notice, Firestore index state (`Ready`), reload screenshot                                  |
| 1.8  | Gateway HTTP blackholed (no MQTT) | Keep the charger powered and on the LAN but drop only its HTTP (bridge with `MQTT_ENABLED=false`): `sudo iptables -A OUTPUT -d <charger-ip> -p tcp --dport 80 -j DROP`, wait ~2 min, then `sudo iptables -D OUTPUT -d <charger-ip> -p tcp --dport 80 -j DROP`                                                                                                                                                                                                                                        | With no usable MQTT link (`MQTT_ENABLED=false`, or the charger gone from the broker too): after `WATCHDOG_FAILURES` failed polls (~30 s) `status/health.state` is `unhealthy`, `http_ok: false`, `last_action: "alert"`, `last_transport: null`, `attempts_last_hour: 0`; the journal shows `watchdog: probe failed (…)`, `watchdog: unhealthy after 3 failed polls …` and `watchdog: alert (…)`; one `Recovery failed — power cycle may be required` push arrives and **no** restart appears. With a live MQTT link the same drop restarts the gateway over MQTT (M.12) instead. Once the drop is removed the next poll pushes `Charger recovered` and `state` returns to `healthy`.                                                                                                                                                                                            | Before/after `status/health`, journal `watchdog:` lines, screenshot of the push                                           |
| 1.9  | Gateway stall (restart path)      | Opportunistic: the charger's known failure mode is a gateway that stalls after a charge session (or reproduce on a bench charger)                                                                                                                                                                                                                                                                                                                                                                    | When the stall is intermittent — a `/status` probe answers while normal polls fail — the journal shows `watchdog: restart_gateway -> POST /restart device=gateway (failures=3 http_ok=True controller_ok=True charging=False)` and `watchdog: restart device=gateway via http -> HTTP 200`, `status/health.last_action` is `restart_gateway` with `last_transport: "http"`, and one `Charger gateway unresponsive — restart attempted` push arrives. A second stall inside `WATCHDOG_COOLDOWN_SEC` logs `cooldown after the last attempt (600s)` and sends no `POST`. If the gateway goes dark after the accepted restart (no `/status` answer at all), exactly one `Recovery failed — power cycle may be required` push follows while `status/health` keeps `last_action: restart_gateway` / `last_transport: "http"` / `last_result: HTTP 200` and flips `http_ok` to `false`. | Journal excerpt, `status/health` (`last_attempt_at`, `last_result`, `attempts_last_hour`, `http_ok`), push screenshot     |
| 1.10 | Charging guard blocks a restart   | Scripted, because a live trigger cannot separate the poll from the probe: run `pi/.venv/bin/python -m unittest discover -s pi/tests -k test_charging_blocks_the_restart_until_configured -v` (`pi/tests/test_bridge.py`). Its loop feeds three failed polls, then a usable `/status` probe, against a last known `state: 3` with `WATCHDOG_RESTART_WHILE_CHARGING` unset. (Blackholing all charger HTTP as in §1.8 cannot reach this guard — the probe fails too and §1.8's unreachable alert wins.) | The scripted run passes, asserting `status/health.state` is `unhealthy` with `http_ok: true` (the probe answered), `reason` containing `charging in progress; WATCHDOG_RESTART_WHILE_CHARGING is off` and repeating it as `last_result`, `last_action: "none"`, `last_attempt_at: null`, `attempts_last_hour: 0`, and **no** `POST /restart` in the recorded session. The pushes are `Charger offline` then `Charger unresponsive — restart blocked while charging (set WATCHDOG_RESTART_WHILE_CHARGING=true to allow)`, which names `WATCHDOG_RESTART_WHILE_CHARGING` and is **not** `Recovery failed — power cycle may be required`. On a live charger the same path logs `watchdog: none (charging in progress; …)` and leaves the session uninterrupted.                                                                                                                     | `unittest` output, plus (live, opportunistic) the `status/health` document, `watchdog:` journal lines and push screenshot |
| 1.11 | Watchdog disabled                 | Set `WATCHDOG_ENABLED=false` in `bridge.env`, `sudo systemctl restart chelevse-bridge`, blackhole the gateway HTTP for ~2 min, then restore                                                                                                                                                                                                                                                                                                                                                          | The journal shows the usual `charger offline (…)` line but **no** `watchdog:` activity lines (the one-time `watchdog: enabled=…` settings echo at startup still appears), and there is no probe, health or restart activity; the only push from the outage is `Charger offline` (plus any independent charging-edge notification), and restoring the gateway returns the status document to online without a generic `Charger recovered` push; `status/health` is untouched — same `updated_at` as before the restart, or absent if it was never written.                                                                                                                                                                                                                                                                                                                        | Journal excerpt, `status/health` before/after                                                                             |

Restore the bridge and charger before continuing:

```bash
sudo systemctl start chelevse-bridge
systemctl is-active chelevse-bridge
sudo journalctl -u chelevse-bridge -n 20 --no-pager
```

## 2. Status pipeline

With the car plugged in (or simulated by the charger's state) and the bridge
healthy, check every value the status screen renders.

| #    | Field                    | Expected observation                                                                                                                     | Evidence                                           |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 2.1  | Header badge             | **Live** while Firestore pushes arrive; **Cached** for a cache-only snapshot; **Offline** with no network.                               | Screenshot of each state                           |
| 2.2  | State                    | Badge/label matches the charger (`charging`, `connected`, `sleeping`, …); the badge pulses while charging.                               | Screenshot, `status/current.state` + `state_label` |
| 2.3  | Power, current, voltage  | `power` in kW, live current in A, `at NNN V` under it; values track the car's draw (e.g. ramping on start).                              | Screenshot before/after a current change           |
| 2.4  | Session energy + elapsed | Session kWh climbs; the elapsed clock ticks every second. Pressing **Stop** freezes the clock until the charger reports a new state.     | Two screenshots 1 min apart; `elapsed` field       |
| 2.5  | Lifetime total           | `total_energy` (kWh) matches the charger's own lifetime counter.                                                                         | Screenshot vs charger's built-in UI                |
| 2.6  | Temperatures             | Mean `temp_c` plus `temp1`–`temp3`; absent sensors show `—` rather than 0.                                                               | Screenshot; `status/current.temp*`                 |
| 2.7  | Setpoint (pilot)         | `pilot` amps shown; it is the limit, not the live draw.                                                                                  | Screenshot; `status/current.pilot`                 |
| 2.8  | Device name              | Header shows `status/config.hostname`; falls back to **ChelEVSE** when the config has none.                                              | Screenshot; `status/config.hostname`               |
| 2.9  | Schedule badge           | Hidden outside a window; inside one it reads **"Scheduled HH:MM–HH:MM"** (or "Scheduled window" when the id cannot be resolved).         | Screenshot inside and outside a window             |
| 2.10 | Cost                     | Hidden until a rate is saved; after **Config → App settings** (rate + currency) the session tile shows `energy × rate` in that currency. | Screenshots before/after saving the rate           |

`status/current` should also carry `updated_at` moving every `STATUS_INTERVAL`
(default 10 s), and `schedule: {in_window, active_rule_id}` once a schedule
exists. With MQTT enabled the cadence follows the charger's publishes instead —
see [MQTT transport](#mqtt-transport-issue-44).

### MQTT transport (issue #44)

Run these with `MQTT_ENABLED=true` and the charger publishing to the broker (the
setup is in [DEPLOY.md §10.1](DEPLOY.md#101-mqtt-status-transport-optional)).
Each row can be reverted with the bridge flag or the charger's `mqtt_enabled`.

| #    | Check                            | How                                                                                                                                                                                              | Expected observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                   |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| M.1  | Flag off is unchanged            | Start with `MQTT_ENABLED=false`; watch a minute of journal                                                                                                                                       | `mqtt: disabled (HTTP status polling)`, no `status source:` lines, `status/current.updated_at` every 10 s, `status/health` has no `source` field                                                                                                                                                                                                                                                                                                                                                                                                                                      | Journal excerpt, `status/current.updated_at`                               |
| M.2  | Broker refuses anonymous         | `mosquitto_sub -h <pi-host> -t 'test/#' -C 1 -W 2`                                                                                                                                               | `Connection error: Connection Refused: not authorised.`; an authenticated publish/subscribe round-trips                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Terminal output                                                            |
| M.3  | Charger is connected             | `GET http://<charger>/status`                                                                                                                                                                    | `mqtt_connected: 1`, `mqtt_status: connected`; `/config` shows `mqtt_enabled: true`, the server/port/topic/user, and `mqtt_pass` redacted                                                                                                                                                                                                                                                                                                                                                                                                                                             | Endpoints' output                                                          |
| M.4  | Topics match the document        | `mosquitto_sub -h <pi-host> -u <mqtt-user> -P "$MQTT_PASS" -v -t 'chelevse/#' -t 'openevse/announce/#'` then compare with `status/current`                                                       | Status fields, retained `config`/`override`/`schedule`, and the announce message. `amp` in the topic is mA (÷1000 = `amp`), `temp1`–`temp3` are 10ths of °C (÷10 = `tempN`), `session_elapsed` is `elapsed`; absent sensors stay `null`; the document holds only curated fields (no `comm_*`, `ipaddress`, `mqtt_connected`)                                                                                                                                                                                                                                                          | Topic sample, `status/current`                                             |
| M.5  | Event-driven latency             | Start or stop a charge (or change the setpoint)                                                                                                                                                  | `status/current` reflects the change within ~5 s, well before the 10 s poll would have — including `state`, `state_label` and a fresh `updated_at`                                                                                                                                                                                                                                                                                                                                                                                                                                    | Before/after `updated_at`, journal `status source: mqtt`                   |
| M.6  | Reconciliation only              | Watch a few minutes while MQTT is connected                                                                                                                                                      | Journal shows no 10 s `/status` churn; a reconcile happens about once a minute. `chelevse/config_version` rising (a charger setting change) produces exactly one `config synced` line                                                                                                                                                                                                                                                                                                                                                                                                 | Journal excerpt, `chelevse/config_version`                                 |
| M.7  | Fallback is automatic            | `sudo systemctl stop mosquitto`, wait for the next tick, then `sudo systemctl start mosquitto`                                                                                                   | One `status source: http (mqtt disconnected after N messages)`, 10 s polls resume, `status/health.source` is `http` and `mqtt_connected` `false`; on reconnect one `status source: mqtt (mqtt connected)` and the health fields flip back                                                                                                                                                                                                                                                                                                                                             | Journal lines, `status/health` before/during/after                         |
| M.8  | No duplicate transitions         | Run a charge start/stop with both sources live (§1.9-style reconcile during an edge)                                                                                                             | Exactly one `Charging started` / `Charging stopped` push, one `sessions/*` doc for the plug-in event, and `history/<date>.kwh` increases by that session's energy (no double count)                                                                                                                                                                                                                                                                                                                                                                                                   | Push screenshots, session doc, history doc                                 |
| M.9  | Real outage still shows          | Power the charger off for ~2 min while the broker stays up                                                                                                                                       | `charger offline (…)` once and `charger_online: false` in `status/current`. `mqtt_connected` is `true` only until the broker's keepalive expires and the retained Last Will fires, then reads `false` with `mqtt_announced: false` (the M.11 flip). It clears on the charger's return: the first snapshot or reconcile writes `charger_online: true` and `mqtt_connected` back to `true`                                                                                                                                                                                              | Journal line, `status/current`, `status/health`                            |
| M.10 | Watchdog input unchanged         | Stop mosquitto for ~2 min                                                                                                                                                                        | No watchdog restart from the MQTT outage alone; the failure streak (and `status/health.reason`) only moves on failed **HTTP** polls                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Journal `watchdog:` lines, `status/health`                                 |
| M.11 | LWT marks the gateway gone       | Power the charger off (or disconnect only the gateway's Wi-Fi) while the broker and the Pi stay up, then `mosquitto_sub -h <pi-host> -u <mqtt-user> -P "$MQTT_PASS" -t 'openevse/announce/#' -v` | Within one status tick of the broker's keepalive expiry the Last Will publishes `{"state": "disconnected"}`; the journal logs `mqtt gateway announced disconnected` and `status source: http (mqtt connected, gateway announced disconnected)`; `status/health.mqtt_connected` is `false`, `mqtt_announced: false` and `mqtt_last_lwt_at` is set. On the charger's return it publishes `{"state": "connected"}`, the source flips back to `mqtt` once and `mqtt_announced` is `true`                                                                                                  | Journal lines, `status/health` before/during/after, `mosquitto_sub` output |
| M.12 | MQTT restart when HTTP is wedged | With the charger powered and on the broker, blackhole only its HTTP as in §1.8, wait for `WATCHDOG_FAILURES` failed reconciles, then remove the drop                                             | The journal shows `watchdog: unhealthy after 3 failed polls (… mqtt_ready=True)`, `watchdog: restart_gateway -> mqtt restart device=gateway (… mqtt_ready=True)` and `watchdog: restart device=gateway via mqtt -> MQTT published`; `mosquitto_sub -t 'chelevse/#'` captures one `restart` payload `{"device": "gateway"}` and **no** `POST /restart` appears in the charger's access log. `status/health.last_action` is `restart_gateway`, `last_transport: "mqtt"`, `last_result: MQTT published`; the first successful `/status` poll after the reboot pushes `Charger recovered` | Journal excerpt, `status/health`, `mosquitto_sub` capture                  |
| M.13 | Both transports down             | Power the charger off and leave it off through `WATCHDOG_FAILURES` failed polls (~3 min under MQTT)                                                                                              | After the Last Will fires the health fields read `mqtt_connected: false`/`mqtt_announced: false`; the watchdog decides `alert` — **no** MQTT publish and no `POST /restart` — and one `Recovery failed — power cycle may be required` push arrives. The attempt fields still show M.12's restart (see the attempt-history note below); guard blocks (charging, cooldown, cap) never publish even with MQTT ready                                                                                                                                                                      | Journal, `status/health`, `mosquitto_sub` capture, push screenshot         |

Restore the broker and the charger before continuing.

Notes:

- **Config retry (M.6).** A `/config` fetch that fails while the broker is
  healthy is retried with a bounded backoff (5 s doubling to 60 s): the journal
  shows `config sync failed (…); retrying in Ns` then `config synced`, with no
  new `config_version`. A version change during the backoff retries at once.
- **After a rollback (M.1).** `status/health.source`/`mqtt_connected`/
  `mqtt_announced`/`mqtt_last_lwt_at` keep their last MQTT values while the flag
  is off (the HTTP-only path does not write them); do not read them as live
  transport state after `MQTT_ENABLED=false`.
- **MQTT restart is fire-and-forget (M.12).** The publish is QoS 0 and is not
  retained: the firmware restarts on receipt and drops its broker session. Only
  the next successful `/status` poll proves recovery, and a publish the client
  rejects is recorded as `failed (…)` (the attempt and its cooldown still
  count).
- **Attempt history persists (M.13).** The attempt fields report the last
  attempt for the life of the process and a recovery does not clear them. Run
  straight after M.12, the both-transports-down episode reads
  `reason: charger unreachable over HTTP and MQTT` with `http_ok: false`, while
  `last_action` stays `restart_gateway`, `last_transport: "mqtt"`,
  `last_result: "MQTT published"`, `attempts_last_hour: 1` and
  `last_attempt_at` is set — no new attempt is recorded, so read the current
  episode from `reason`/`http_ok` and the journal. Restart the bridge first if
  you want the fresh-process values (`last_action: "alert"`,
  `last_transport: null`, `attempts_last_hour: 0`).

### Watchdog health (`status/health`)

The bridge writes this document on watchdog transitions and restart attempts
only (not every tick), so a healthy charger shows it once per bridge start:

| Field                | Expected while healthy                                                                                                               | Expected while unhealthy                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `state`              | `healthy`                                                                                                                            | `unhealthy`                                                                                     |
| `reason`             | `status polls succeeding`                                                                                                            | the decision's explanation (`cooldown after the last attempt (600s)`, …)                        |
| `http_ok`            | `true`                                                                                                                               | `true` only when the probe answered with a usable `/status` reply                               |
| `controller_ok`      | `true`; `false` if `/status` still reports a dropped `rapi_connected`/`evse_connected` or a frozen `comm_success`                    | `false` when `rapi_connected`/`evse_connected` drop or `comm_success` freezes                   |
| `last_attempt_at`    | `null` or the last attempt                                                                                                           | the last restart attempt (timestamp)                                                            |
| `attempts_last_hour` | attempts in the trailing hour (`0`–`N`); a recovery inside that hour keeps its count, so it does not mean restarts are happening now | restart attempts in the trailing hour (never above `WATCHDOG_MAX_PER_HOUR`)                     |
| `last_action`        | `null` or the last action                                                                                                            | `restart_gateway`, `restart_evse`, `alert` or `none` (a guard blocked it)                       |
| `last_transport`     | `null` or the last attempt's path                                                                                                    | `"http"` or `"mqtt"` (the path the last attempt used); `null` when nothing was attempted        |
| `last_result`        | `null` or the outcome                                                                                                                | `HTTP 200` / `MQTT published` / `failed (…)`, or the guard's explanation when nothing was tried |
| `mqtt_announced`     | `true` (the gateway announcing itself), `null` before the first announcement                                                         | `false` after the broker published the gateway's Last Will                                      |
| `mqtt_last_lwt_at`   | `null` or when the Last Will last fired                                                                                              | the Last Will timestamp                                                                         |

A `state: "unhealthy"` that never clears, with `http_ok: false` and
`mqtt_connected: false` throughout, means the charger is reachable over neither
transport (power, Wi-Fi, or credential problem): the watchdog cannot recover
that remotely. See the bridge README's
[Watchdog section](../pi/README.md#watchdog-charger-health).

## 3. Commands

Commands are asynchronous: the app writes `commands/{id}` with
`status: "pending"`, the bridge applies it, then writes `acked` or `failed`
(with `transport: "mqtt"|"http"`). The status screen disables the controls
while a command is pending. The checks below describe the HTTP shape; with
`MQTT_ENABLED=true` and a ready source the same commands travel over MQTT —
see [§3.7](#37-commands-over-mqtt-issue-46) for the transport-specific checks.

### 3.1 Pause (stop)

- **Do:** with the car charging, tap **Stop**.
- **Expect:** feedback "Sending stop…", controls disabled; within a few seconds
  the charger stops (state leaves `3`), feedback "Stop command applied.", and
  the command document is `status: "acked"`.
- **Evidence:** command doc id/status, journal line
  `command <id> acked: pause`, screenshot of the stopped state.

### 3.2 Resume (auto)

- **Do:** tap **Auto**.
- **Expect:** bridge sends `DELETE /override`; the charger returns to its normal
  (scheduled/auto) behaviour; "Auto command applied."; doc `acked`.
- **Evidence:** command doc, screenshot, journal line.

### 3.3 Set current (hold)

- **Do:** tap **Hold**, move the slider (6–48 A), tap **Apply**.
- **Expect:** the charger holds at that current (`charge_current`/`max_current`);
  feedback "Current set to N A."; doc `acked` with `amps: N`. The slider
  prefills from `pilot` (the limit), not the live draw.
- **Evidence:** command doc with `amps`, screenshot showing the new setpoint.

### 3.4 RAPI console — valid

- **Do:** **Advanced**, enter `$GS` (read-only: get state), tap **Send**.
- **Expect:** the confirmation gate appears with the command echoed and the
  warning ("Send this command?"); confirming sends it; the scrollback row shows
  chip **Acked** and the charger's `ret` as the result. Sending again in the same
  visit skips the gate; leaving and re-entering **Advanced** re-arms it.
- **Evidence:** screenshot of the gate and the acked row, command doc with
  `type: "rapi"`, `command: "$GS"`, `result`.

### 3.5 RAPI console — invalid / failed

- **Do:** enter an invalid shape, e.g. `$GSX` or a command over 32 characters.
- **Expect:** an inline error ("Use $ followed by 1–2 letters or digits…" / the
  length limit), no command document is written, nothing reaches the charger.
- **Do (failed ack):** with the charger unreachable, send `$GS` (or stop the
  charger and tap **Stop**).
- **Expect:** the row shows chip **Failed** with the reason (HTTP status/body
  snippet or connection error); the status screen shows
  "Failed: …"; the bridge journal records the failure.
- **Evidence:** screenshots, command doc `status: "failed"` + `error`, journal
  line.

### 3.6 Scrollback

- **Do:** send a few RAPI commands of both outcomes.
- **Expect:** **Advanced** lists the 20 most recent `rapi` commands, newest
  first, each with a relative timestamp, a status chip and its result/error.
  This is the query that needs the composite index — while the index builds the
  screen says it is still being built (see DEPLOY.md §8).
- **Evidence:** screenshot of the scrollback; Firestore index state.

### 3.7 Commands over MQTT (issue #46)

Run these with `MQTT_ENABLED=true` and the bridge's source ready (the charger
connected to the broker and `<MQTT_TOPIC>/#` granted). The journal records
`command transport: mqtt (mqtt connected and subscribed)` on the first MQTT
command and `command transport: http (mqtt unavailable before publish)` after a
fallback. Each command document carries `transport: "mqtt"|"http"` once it
settles.

| #   | Check                           | How                                                                                                                                                                                                          | Expected observation                                                                                                                                                                                                                                                                                                                          | Evidence                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C.1 | Pause over MQTT                 | With the car charging, tap **Stop**                                                                                                                                                                          | Journal shows no `POST /override`; `<base>/override/set` carries `{"state":"disabled"}`; the retained `<base>/override` becomes `{"state":"disabled",…}`; the command doc is `acked` with `transport: "mqtt"`; the charger stops within ~5 s                                                                                                  | Command doc, journal, `mosquitto_sub -t '<topic>/override'`  |
| C.2 | Resume over MQTT                | Tap **Auto** after a pause                                                                                                                                                                                   | `<base>/override/set` carries `clear`; the retained document returns to `{"state":"null"}`; doc `acked`, `transport: "mqtt"`; the charger returns to its normal behaviour. With no override to clear the command still acks at once (no 500 path needed)                                                                                      | Command doc, retained override, journal                      |
| C.3 | Set current over MQTT           | Tap **Hold**, pick a current (6–48 A), apply                                                                                                                                                                 | `<base>/override/set` carries `{"state":"active","charge_current":N,"max_current":N}`; the retained document shows the same `N`; `GET /status` shows `manual_override: 1`, `pilot` at `N` (or at the EVSE's own `max_current` when `N` is above it — the clamp), and its `max_current` field is present; doc `acked` with `transport: "mqtt"` | Command doc, retained override, `GET /status`, status screen |
| C.4 | RAPI over MQTT — valid          | **Advanced**, send `$GS` (and `$FS 20` for a command with a parameter)                                                                                                                                       | Topics are `<base>/rapi/in/$GS` with an empty payload and `<base>/rapi/in/$FS` with payload `20`; the next `<base>/rapi/out` is `$OK…`; doc `acked` with `result` = the reply and `transport: "mqtt"`                                                                                                                                         | Command docs, `mosquitto_sub -t '<topic>/rapi/out'`          |
| C.5 | RAPI over MQTT — `$NK`          | Send an invalid RAPI command the firmware rejects (e.g. `$XX 20`)                                                                                                                                            | `<base>/rapi/out` is `$NK^…`; doc `failed` with the reply in `error`, `transport: "mqtt"`; no HTTP `/rapi` call                                                                                                                                                                                                                               | Command doc, journal                                         |
| C.6 | Fallback when MQTT is not ready | `sudo systemctl stop mosquitto`, wait until the journal logs `status source: http (mqtt disconnected …)`, then tap **Stop** (or send `$GS`)                                                                  | One `command transport: http (mqtt unavailable before publish)`; the existing HTTP request applies the command; doc `acked`/`failed` as before with `transport: "http"`; no MQTT publish is attempted. Restart mosquitto afterwards                                                                                                           | Journal, command doc                                         |
| C.7 | No double-apply on a drop       | Start a pause and stop mosquitto as soon as the publish appears under `mosquitto_sub -t '<topic>/override/set'` (or when the retained `<topic>/override` document updates), before the acknowledgement lands | The bridge does **not** send `POST/DELETE /override`: it reads `/status` once, acks if the status already shows the override, otherwise marks the command `failed` with `no confirmation within 5s (…)`. One publish only, one command document — never two charger actions                                                                   | Journal (no `POST`/`DELETE /override`), command doc          |
| C.8 | Flag off is unchanged           | `MQTT_ENABLED=false`, restart the bridge, apply each command type                                                                                                                                            | `mqtt: disabled (HTTP status polling)` at startup; commands use HTTP exactly as before and record `transport: "http"`; no MQTT publish                                                                                                                                                                                                        | Journal, command docs                                        |

Notes:

- **Override confirmation.** The retained `<base>/override` document is the
  acknowledgement: `{"state":"null"}` is auto, `"disabled"` is paused and
  `"active"` carries the held current. The status `manual_override` field is `1`
  for _either_ override, so a pause that only checks it could accept a hold; the
  status fallback therefore requires `manual_override: 1` **and** a non-charging
  EVSE state (`254` sleeping / `255` disabled). Live 8.2.3 pauses into
  `state 254` with `manual_override 1` (`255` is not observed); a sleeping
  charger with no override reports the same `254` with `manual_override 0`. The
  HTTP `/status` reply additionally spells the same state as `status: "disabled"`.
  A retained document with `state: "active"` but **no** current field confirms
  nothing — it cannot tell an applied hold from a lost publish — so the
  read-only `/status` reconcile decides.
- **Clamp confirmation.** A hold above the EVSE's own limit is confirmed by
  `pilot` sitting at `max_current` rather than at the commanded value. Firmware
  8.2.3 reports `max_current` in `/status` (live on the test charger: `pilot`
  16 with `max_current` 16, the soft limit), and `GET /config` spells the pair
  `max_current_soft`/`max_current_hard` without a bare `max_current` — so
  `/status` is the field's only source. C.3 pins it.
- **RAPI serialisation.** Replies have no correlation id. Only one RAPI command
  is in flight at a time and the first reply after its publish is its answer; a
  missing reply is `failed (no rapi/out within 5s)` (covered by
  `pi/tests/test_mqtt_commands.py`), never retried over HTTP. A timed-out
  transaction holds the RAPI lock for a 2 s quarantine so a late reply is
  retired rather than settling the next command.
- **Transport field.** `transport` names the path that carried the request, so a
  refused MQTT publish that falls back and then fails over HTTP records
  `"http"`. A command rejected before any send (validation, unsupported type)
  records no transport at all.

## 4. Schedule round-trip

The app owns `schedule/current`; the bridge validates and mirrors it into the
charger's own scheduler. Use a window that starts a few minutes from now if you
want to watch it apply.

1. **Create and save.** Add a rule (e.g. Mon–Fri, 22:00–06:00, 24 A), enable
   scheduling, tap **Save**.
   - Expect: "Saving…" then **"Saved."**; the Firestore document has exactly
     `{enabled, rules: [{id, days, start, end, amps}]}`; the bridge journal shows
     `schedule synced: N events (P posted), removed M`.
2. **Firmware.** `GET http://<charger>/schedule` (or the charger's own UI) shows
   the two events per rule: an `active` event at `start` and a `disabled` event
   at `end`, with Sunday→Monday day shifting for an overnight window.
3. **Plan.** `GET http://<charger>/schedule/plan` and `status/current.schedule`
   agree: during the window `in_window: true` and `active_rule_id` names the
   saved rule; outside it, `in_window: false` and `active_rule_id: null`.
   An empty `[]` response (no events configured) is normal: it publishes
   `{in_window: false, active_rule_id: null}` and the journal shows no
   `schedule plan failed` line.
4. **Badge.** The status screen shows the scheduled window while it is active,
   and hides the badge afterwards.
5. **Edit.** Change the start time/amps and save; the bridge re-syncs (journal
   digest change) and only the changed firmware events are posted.
6. **Disable.** Turn the schedule off and save; the bridge clears the firmware
   schedule (`removed M`) and the charger stops enforcing windows. Turning it
   back on restores them.
7. **Clear.** With scheduling on, delete every rule and save; the firmware
   schedule is cleared the same way.
8. **Validation.** `start == end` is rejected in the UI and a 21st rule is
   refused (the cap is 20). Overlapping or touching windows are not blocked by
   the rules or the app: the bridge skips the later rule by id and logs
   `schedule: skipped rule <id> (overlaps another rule)`, so check that line
   after saving a deliberate overlap.
9. **Offline.** With the device offline, saving is blocked
   ("You're offline — reconnect to save."); a remote edit made on another
   device while this one has unsaved edits raises the remote-change notice.

Evidence: the saved document, the `/schedule` events and `/schedule/plan`
payloads, the journal sync lines, screenshots of the badge and the feedback
states.

Note: firmware v5.1.5 has no per-event current, so `amps` is stored but not
applied — the charger uses its configured limit. The bridge logs this once per
changed sync; that log line is expected, not a failure.

## 5. Notifications

Push is delivered by the plain service worker (`web/sw.js`): FCM sends a
notification-only message, the worker receives a raw `push` event and either
shows the system notification or forwards a `chelevse-push` message to the
visible page for an in-app toast.

| #    | Check                         | Expected observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                          |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 5.1  | Opt-in card (before)          | **Config** shows "Get charging alerts" with **Enable** when permission is `default`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Screenshot                                                        |
| 5.2  | Enable                        | Permission prompt; after allowing, the card reads "Notifications are on — This device is registered for alerts…"; `fcmTokens/{token}` exists with `{uid, created_at}`.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Screenshot, token doc id (do not paste the token publicly)        |
| 5.3  | Background, app closed        | Close/swipe the app away (not force-stop), trigger a transition (start or stop a charge, or power the charger off). The OS notification appears: title **ChelEVSE**, body `Charging started` / `Charging stopped` / `Charger offline`.                                                                                                                                                                                                                                                                                                                                                                            | Screenshot of the notification shade                              |
| 5.4  | Foreground, exactly one toast | With the app visible, trigger the same transition. Exactly one in-app toast appears for ~6 s and **no** OS notification is posted (the worker sees a visible client).                                                                                                                                                                                                                                                                                                                                                                                                                                             | Screen recording or before/after screenshots of the shade         |
| 5.5  | Notification click            | Tap the notification with the app backgrounded: the existing app window is focused (no duplicate tab). With the app not running: the app opens at the notification's URL.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Screen recording; tab/window count                                |
| 5.6  | Permission denied             | Block notifications for the site: the card reads "Notifications are blocked" with recovery instructions; no registration attempt loops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Screenshot                                                        |
| 5.7  | Push not configured           | With the placeholder `vapidKey`: the card reads "Push isn't configured" and no token error appears.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Screenshot                                                        |
| 5.8  | Token pruning (dead token)    | Clear the site's data (drops the push subscription) while remaining signed in elsewhere; trigger a transition. The bridge logs `pruned fcm token` and the old `fcmTokens` doc is gone; the device receives no further pushes.                                                                                                                                                                                                                                                                                                                                                                                     | Journal line, `fcmTokens` document list                           |
| 5.9  | Token release on sign-out     | Sign out: the token document is deleted (count drops) and no pushes arrive while signed out. Re-enabling after sign-in recreates it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Firestore token docs before/after, screenshot of the sign-in card |
| 5.10 | Resubscription recovery       | After a browser-rotated subscription (`pushsubscriptionchange`), an open page re-acquires and re-saves the token; the next app load does the same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `fcmTokens.created_at` updated; no error in the notification card |
| 5.11 | Watchdog alerts, one per edge | With notifications enabled, run the §1.8 HTTP blackhole: exactly one `Recovery failed — power cycle may be required` push for the whole outage (not one per failed poll), then one `Charger recovered` when the drop is removed. A restart path (§1.9) sends `Charger gateway unresponsive — restart attempted` instead, and a further stall inside the cooldown sends nothing; if the gateway stays dark after that restart, exactly one `Recovery failed — power cycle may be required` follows. A guard-blocked episode (§1.10) sends `Charger unresponsive — restart blocked (…)` and never the failure body. | Screenshots of each push, journal `watchdog:` lines               |

Exactly one notification per transition is the rule: the bridge computes edges
from its pre-tick state, and the page dedupes the worker message against the
SDK's defensive `onMessage` (5 s window).

## 6. Allowlist and access

| #   | Check                | Expected observation                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                       |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 6.1 | Granted account      | Owner signs in → status screen loads, header **Live**, no access banner.                                                                                                                                                                                                                                                                                                     | Screenshot                                                     |
| 6.2 | Ungranted account    | Second Google account signs in → **"You're not on the list"** screen with the sign-out control; the only Firestore read is the account's own grant check (it returns no grant), no status/history/command listeners start, and the tab bar is not reachable.                                                                                                                 | Screenshot, network log                                        |
| 6.3 | Revoked account      | Remove the second account from `private/acl.txt`, run `pi/.venv/bin/python pi/acl.py --prune` (on the Pi: `/opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py --prune`). Expect `…, 1 pruned, …`; the `users/{uid}` grant and that uid's `fcmTokens` docs are deleted. On that device the next snapshot lands on the no-access screen and the app releases its token. | acl.py output, before/after grant and token counts, screenshot |
| 6.4 | Sign-out             | Sign out → sign-in card; this device's token document is deleted; no pushes arrive while signed out.                                                                                                                                                                                                                                                                         | Firestore token docs, screenshot                               |
| 6.5 | Sign-in failure copy | Popup closed/cancelled → an error on the sign-in card, button re-enabled; no partial app access.                                                                                                                                                                                                                                                                             | Screenshot                                                     |

A grant needs an existing Auth user: an address that has never signed in fails
with `must sign in once first` until it does (DEPLOY.md §9).

## 7. Offline behavior

| #   | Check                  | Expected observation                                                                                                                                                                       | Evidence                           |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 7.1 | Shell from cache       | Offline with the app already loaded: tab switches still render; the shell modules come from the service-worker cache.                                                                      | Screenshot, DevTools cache entries |
| 7.2 | Status freshness       | Offline or stale: header **Offline**/**Cached**, and the banner distinguishes **"Charger offline"** (fresh writes, `charger_online: false`) from **"Bridge offline"** (no write for 60 s). | Screenshots of both banners        |
| 7.3 | History — cached       | Load **History** online, go offline, revisit: the chart/sessions render with "Showing cached daily energy — reconnect to refresh." (and the sessions equivalent).                          | Screenshot                         |
| 7.4 | History — offline miss | Offline on a fresh app with no cached rows: "You're offline — history isn't available." / "You're offline — sessions aren't available."                                                    | Screenshot                         |
| 7.5 | History — empty        | A deployment with no `history` docs yet: "No history yet — Daily totals appear once the charger logs a day."; the sessions section shows its empty state.                                  | Screenshot                         |
| 7.6 | Cold start offline     | Reload while offline: the boot card explains the app could not load (config/SDK are network-only). This is the documented limitation from §1.5.                                            | Screenshot                         |

## 8. Security

| #   | Check                       | How                                                                                                                                                 | Expected                                                                                                                                            | Evidence        |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 8.1 | Rules test suite            | `npm run test:rules` (needs Java; uses the Firestore emulator and `--project demo-chelevse`)                                                        | All tests pass: ungranted users denied reads/writes, command schema enforced, schedule container rules, settings shape, own-token-only `fcmTokens`. | Test output     |
| 8.2 | Unauthorized read (manual)  | Signed in as the ungranted account, read `status/current` (console/SDK)                                                                             | `permission-denied`; no data returned.                                                                                                              | Error output    |
| 8.3 | Unauthorized write (manual) | As the ungranted account, attempt a `commands` create or `settings/current` write                                                                   | `permission-denied`; no document created.                                                                                                           | Error output    |
| 8.4 | Deploy guard — mismatch     | `GOOGLE_APPLICATION_CREDENTIALS=private.example/service-account.json.example FIREBASE_PROJECT=<project-id> node scripts/check-firebase-project.mjs` | Prints `✖ deploy blocked: target project "<project-id>" does not match the service-account key's project …` and exits non-zero; no deploy can run.  | Terminal output |
| 8.5 | Deploy guard — match        | `GOOGLE_APPLICATION_CREDENTIALS=private/service-account.json FIREBASE_PROJECT=<project-id> node scripts/check-firebase-project.mjs`                 | Prints `✔ deploy guard: <project-id> …`.                                                                                                            | Terminal output |
| 8.6 | Bridge-only writes          | Attempt a `status/current` write as the owner from the web SDK                                                                                      | `permission-denied`; only the Admin SDK (bridge) writes status/history/commands' lifecycle.                                                         | Error output    |

## 9. Human checks (on site)

These need physical access and are the acceptance items from issues #18/#19.
Do them last; each is a single observation plus evidence.

- [ ] **Reboot survival (at the Pi).** `sudo reboot`; after it returns,
      `systemctl is-active chelevse-bridge` prints `active`, and
      `sudo journalctl -u chelevse-bridge -b --no-pager | tail -20` shows a fresh
      `bridge started` with no `error`/`failed`/traceback lines. Status writes
      resume within one poll interval.
- [ ] **Real charging session (at the car).** Plug in and start a charge:
      `status/current.state` is `3`, `session_energy` climbs, `updated_at` moves,
      and the journal shows normal ticks with no repeated errors.
- [ ] **Session record.** Stop the charge or unplug. Within one status tick a
      `sessions/{epoch}` document exists with `{started_at, ended_at, wh, elapsed}`;
      `history/<today>.kwh` increases by the session energy; the journal logs
      `session recorded: <epoch> (<wh> Wh)`.
- [ ] **Record math.** `started_at` is within a few seconds of
      `ended_at - elapsed`, and `wh` is positive. A pause/resume during the
      plug-in event merges into the same session document (no double count).
- [ ] **Schedule enforcement (at the charger).** A window starting a few minutes
      out turns charging on when it starts and off when it ends, with the app
      badge showing the active window. `amps` is not applied on firmware
      v5.1.5 — the charger uses its configured limit; the bridge logs that once.

## 10. Evidence log

| Area                 | Result | Evidence (link/path/line) | Tester | Date |
| -------------------- | ------ | ------------------------- | ------ | ---- |
| Failure modes (§1)   |        |                           |        |      |
| Status pipeline (§2) |        |                           |        |      |
| Commands (§3)        |        |                           |        |      |
| Schedule (§4)        |        |                           |        |      |
| Notifications (§5)   |        |                           |        |      |
| Allowlist (§6)       |        |                           |        |      |
| Offline (§7)         |        |                           |        |      |
| Security (§8)        |        |                           |        |      |
| On-site (§9)         |        |                           |        |      |

A release is validated when every row is filled in, or the exception is
recorded with a reason and a follow-up issue.
