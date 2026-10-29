#!/usr/bin/env python3
"""ESP32-S3 bring-up helper for Claude Code and Velloc.

Finds USB serial ports that may be an ESP board, reports devices whose driver
is missing, reads the chip over the ROM bootloader, and captures the boot log.
Read-only: nothing here writes flash, eFuses or memory.

Requires: pyserial, esptool  (python -m pip install --user pyserial esptool)
"""
import argparse
import json
import os
import re
import subprocess
import sys

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial is missing. Install with:\n  %s -m pip install --user pyserial esptool" % sys.executable)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import esp_ai  # noqa: E402
import esp_monitor  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")

BRIDGES = {
    0x10C4: "cp210x",
    0x1A86: "ch34x",
    0x0403: "ftdi",
    0x303A: "espressif-usb",
}
VID_PATTERN = "VID_(10C4|1A86|0403|303A)"
PNP_QUERY = (
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.DeviceID -match '%s' -and "
    "$_.ConfigManagerErrorCode -ne 0 } | Select-Object Name,DeviceID,ConfigManagerErrorCode | "
    "ConvertTo-Json -Compress" % VID_PATTERN
)
PNP_TIMEOUT_S = 6  # below the Velloc pane's 10 s budget for a whole `ports` run


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


# ------------------------------------------------------------------ ports ---

def bridge_of(vid):
    return BRIDGES.get(vid)


def port_entry(p):
    """One listed port as a dict, or None when it is not a known USB-UART bridge."""
    if p.vid is None or bridge_of(p.vid) is None:
        return None
    return {
        "port": p.device,
        "vid": "%04X" % p.vid,
        "pid": "%04X" % p.pid,
        "bridge": bridge_of(p.vid),
        "serial": p.serial_number or None,
        "description": p.description,
    }


def parse_pnp(text):
    """PowerShell ConvertTo-Json output (object, array or nothing) -> missing-driver rows."""
    text = (text or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if isinstance(data, dict):
        data = [data]
    rows = []
    for d in data:
        m = re.search(r"VID_([0-9A-F]{4})&PID_([0-9A-F]{4})", d.get("DeviceID") or "", re.I)
        if not m or int(m.group(1), 16) not in BRIDGES:
            continue
        rows.append({
            "name": d.get("Name"),
            "vid": m.group(1).upper(),
            "pid": m.group(2).upper(),
            "error_code": d.get("ConfigManagerErrorCode"),
        })
    return rows


def missing_drivers():
    """Never fails: a driver query that cannot run must not take the port list down with it."""
    if os.name != "nt":
        return []
    try:
        p = subprocess.run(["powershell", "-NoProfile", "-Command", PNP_QUERY],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, errors="replace", timeout=PNP_TIMEOUT_S)
    except (subprocess.TimeoutExpired, OSError):
        return []
    return parse_pnp(p.stdout)


def cmd_ports(a):
    ports = [e for e in (port_entry(p) for p in list_ports.comports()) if e]
    missing = missing_drivers() if a.drivers else None
    if a.json:
        emit({"ports": ports, "missing_driver": missing})
        return 0
    if not ports:
        print("No ESP-style USB serial port found.")
    for e in ports:
        print("%-6s %-14s %s:%s  serial=%s  %s" % (e["port"], e["bridge"], e["vid"], e["pid"],
                                                    e["serial"] or "-", e["description"]))
    for m in missing or []:
        print("MISSING DRIVER: %s (%s:%s, error code %s)" % (m["name"], m["vid"], m["pid"], m["error_code"]))
    return 0


# ------------------------------------------------------------------ probe ---

PROBE_TIMEOUT_S = 30


def _field(text, pattern):
    m = re.search(pattern, text, re.M)
    return m.group(1).strip() if m else None


def parse_flash_id(text):
    """esptool `flash-id` output (v5, or v4 `Chip is` style) -> chip and flash facts; fields not found are None."""
    chip_line = _field(text, r"^(?:Chip type:|Chip is)\s*(.+)$") or ""
    m = re.match(r"(\S+)(?:\s+\(([^)]+)\))?(?:\s+\(revision\s+([^)]+)\))?", chip_line)
    features_line = _field(text, r"^Features:\s*(.+)$")
    features = [f.strip() for f in features_line.split(",")] if features_line else []
    joined = ", ".join(features)
    cpu = re.search(r"\b(\d+)MHz\b", joined)
    psram = re.search(r"PSRAM\s+(\d+MB)", joined)
    crystal = _field(text, r"^Crystal (?:frequency:|is)\s*(\d+)MHz")
    flash_type = _field(text, r"^Flash type set in eFuse:\s*(\S+)")
    return {
        "chip": m.group(1) if m else None,
        "package": m.group(2) if m else None,
        "revision": m.group(3) if m else None,
        "features": features,
        "cpu_mhz": int(cpu.group(1)) if cpu else None,
        "psram": psram.group(1) if psram else None,
        "crystal_mhz": int(crystal) if crystal else None,
        "mac": _field(text, r"^MAC:\s*([0-9a-fA-F:]{17})"),
        "flash": {
            "manufacturer": _field(text, r"^Manufacturer:\s*(\S+)"),
            "device": _field(text, r"^Device:\s*(\S+)"),
            "size": _field(text, r"^Detected flash size:\s*(\S+)"),
            "type": flash_type,
            "voltage": _field(text, r"^Flash voltage set by eFuse(?::| to)\s*(\S+)"),
        },
    }


classify_failure = esp_monitor.classify_failure


def _esptool_name(name):
    """esptool >= 5 uses dashed command names, older versions underscores."""
    try:
        import esptool
        major = int(esptool.__version__.split(".")[0])
    except Exception:
        major = 5
    return name if major >= 5 else name.replace("-", "_")


def _now_iso():
    import datetime
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def probe_result(out, exit_code, port):
    """The probe verdict. OK needs the chip, its MAC and a known flash size (design 5.4)."""
    info = parse_flash_id(out)
    tail = "\n".join(out.strip().splitlines()[-5:])
    if exit_code != 0 or not info["chip"]:
        return {"ok": False, "port": port, "reason": classify_failure(out), "detail": tail}
    if not info["mac"] or info["flash"]["size"] in (None, "Unknown"):
        return {"ok": False, "port": port, "reason": "incomplete", "detail": tail}
    return dict(ok=True, port=port, **info, probed_at=_now_iso())


def run_probe(port, reset=True):
    """esptool flash-id; with reset=False the board stays in the bootloader for the monitor to reset."""
    after = [] if reset else ["--after", _esptool_name("no-reset")]
    try:
        p = subprocess.run([sys.executable, "-m", "esptool", "--port", port] + after + [_esptool_name("flash-id")],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, errors="replace", timeout=PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {"ok": False, "port": port, "reason": "no_response",
                "detail": "esptool timed out after %ds" % PROBE_TIMEOUT_S}
    return probe_result(p.stdout, p.returncode, port)


def cmd_probe(a):
    port = a.port
    if not port:
        sys.exit("--port is required (or set ESP_PORT)")
    try:
        with esp_monitor.paused_monitor(port, reset_after=True) as monitored:
            result = run_probe(port, reset=not monitored)
    except esp_monitor.MonitorBusy:
        result = {"ok": False, "port": port, "reason": "busy", "detail": "the serial monitor did not release the port"}
    if a.json:
        emit(result)
    elif result["ok"]:
        f = result["flash"]
        print("Chip:    %s (%s) rev %s, %s MHz" % (result["chip"], result["package"], result["revision"], result["cpu_mhz"]))
        print("Flash:   %s %s %s (mfr %s dev %s)" % (f["size"], f["type"], f["voltage"], f["manufacturer"], f["device"]))
        print("PSRAM:   %s" % (result["psram"] or "none"))
        print("Crystal: %s MHz" % result["crystal_mhz"])
        print("MAC:     %s" % result["mac"])
    else:
        print("Probe failed on %s: %s\n%s" % (port, result["reason"], result["detail"]))
    return 0 if result["ok"] else 1


# -------------------------------------------------------------------- log ---

PANIC_MARKERS = ("Guru Meditation", "abort() was called", "panic")


def summarize_boot(text):
    """Key facts from an ESP32-S3 boot log (one baud rate, 115200)."""
    lines = text.splitlines()
    resets = re.findall(r"^rst:(0x[0-9a-fA-F]+ \([^)]*\)),boot:(0x[0-9a-fA-F]+ \([^)]*\))", text, re.M)
    if re.search(r"memory test fail", text, re.I):
        psram_ok = False
    elif re.search(r"memory test OK", text):
        psram_ok = True
    else:
        psram_ok = None
    return {
        "reset_reason": resets[-1][0] if resets else None,
        "boot_mode": resets[-1][1] if resets else None,
        "psram_ok": psram_ok,
        "project": _field(text, r"Project name:\s*(.+)$"),
        "idf_version": _field(text, r"ESP-IDF:\s*(\S+)"),
        "warnings": [l for l in lines if l.startswith("W (")],
        "errors": [l for l in lines if l.startswith("E (")],
        "panic": any(m in text for m in PANIC_MARKERS),
        "boots": text.count("ESP-ROM:"),
    }


def capture_log(port, seconds):
    """Reset the board via RTS and read 115200 output for `seconds`."""
    import time
    s = serial.Serial(None, 115200, timeout=0.2)
    s.port = port
    s.dtr = False  # set before open, or opening the port resets the board
    s.rts = False
    s.open()
    try:
        s.rts = True
        time.sleep(0.1)
        s.rts = False
        buf = b""
        end = time.time() + seconds
        while time.time() < end:
            buf += s.read(4096)
    finally:
        s.close()
    return buf.decode("utf-8", errors="replace")


def log_via_monitor(port, seconds):
    """With a monitor running, ask it to reset the board and read what it logs; None if it did not answer."""
    import time
    st = esp_monitor.read_json(esp_monitor.paths(port)["state"]) or {}
    log = st.get("log")
    start = os.path.getsize(log) if log and os.path.exists(log) else 0
    if esp_monitor.send(port, "reset") is None:
        return None
    time.sleep(seconds)
    with open(log, encoding="utf-8", errors="replace") as f:
        f.seek(start)
        return "\n".join(esp_monitor.strip_stamp(line) for line in f.read().splitlines())


def _monitor_running(port):
    st = esp_monitor.read_json(esp_monitor.paths(port)["state"])
    return bool(st) and st.get("state") == "running" and esp_monitor.pid_alive(st.get("pid", 0))


def cmd_log(a):
    if not a.port:
        sys.exit("--port is required (or set ESP_PORT)")
    try:
        text = log_via_monitor(a.port, a.seconds) if _monitor_running(a.port) else None
        if text is None:
            text = capture_log(a.port, a.seconds)
    except serial.SerialException as e:
        if a.json:
            emit({"ok": False, "port": a.port, "reason": classify_failure(str(e)), "detail": str(e)})
        else:
            print("busy" if classify_failure(str(e)) == "busy" else "error", str(e))
        return 1
    summary = summarize_boot(text)
    if a.json:
        emit({"lines": text.splitlines(), "summary": summary})
        return 0
    print(text)
    print("---- summary ----")
    for k, v in summary.items():
        print("%-13s %s" % (k, v))
    return 0


# ---------------------------------------------------------------- monitor ---

DETACH_FLAGS = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
MONITOR_COMMANDS = ("stop", "pause", "resume", "reset", "retry")


def open_serial(port, baud):
    s = serial.Serial(None, baud, timeout=0.2)
    s.port = port
    s.dtr = False  # set before open, or opening the port resets the board
    s.rts = False
    s.open()
    return s


def port_present(port):
    return any(p.device == port for p in list_ports.comports())


def spawn_detached(args):
    """Start this script with `args` outside the caller's console and, where allowed, outside its job."""
    exe = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    exe = exe if os.path.exists(exe) else sys.executable
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    argv = [exe, os.path.abspath(__file__)] + args
    try:
        return subprocess.Popen(argv, creationflags=DETACH_FLAGS | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kw)
    except OSError:  # the caller's job forbids breakaway (Velloc does); start inside it
        return subprocess.Popen(argv, creationflags=DETACH_FLAGS, **kw)


def tail_lines(path, n):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    first = max(0, len(lines) - n)
    return [{"i": first + k, "text": text} for k, text in enumerate(lines[first:])]


def _monitor_state(port):
    st = esp_monitor.read_json(esp_monitor.paths(port)["state"])
    alive = bool(st) and esp_monitor.pid_alive(st.get("pid", 0))
    return st, alive


def cmd_monitor(a):
    import time
    act = a.action
    if act == "list":
        found = []
        base = os.path.join(esp_monitor.home(), "monitors")
        for name in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            if not name.endswith(".json"):
                continue
            path = os.path.join(base, name)
            st = esp_monitor.read_json(path)
            if not st:
                continue
            if esp_monitor.pid_alive(st.get("pid", 0)):
                found.append(st)
            elif st.get("state") != "stopped":
                st.update(state="stopped", reason="process_gone")
                esp_monitor.write_json_atomic(path, st)
        emit({"monitors": found})
        return 0
    if not a.port:
        sys.exit("--port is required (or set ESP_PORT)")
    port = a.port
    if act == "run":
        esp_monitor.Monitor(port, a.baud, a.key or port, open_serial=open_serial, port_present=port_present,
                            heartbeat=not a.no_heartbeat).run()
        return 0
    if act == "status":
        esp_monitor.touch_heartbeat(port)
        st, alive = _monitor_state(port)
        flash = esp_monitor.read_json(esp_monitor.job_path(port))
        emit({"monitor": st, "alive": alive, "lines": tail_lines(st and st.get("log"), a.lines), "flash": flash})
        return 0
    if act == "start":
        st, alive = _monitor_state(port)
        if not (alive and st.get("state") != "stopped"):
            esp_monitor.touch_heartbeat(port)
            child = spawn_detached(["monitor", "run", "--port", port, "--baud", str(a.baud), "--key", a.key or port])
            end = time.time() + 3
            while time.time() < end:
                st = esp_monitor.read_json(esp_monitor.paths(port)["state"])
                if st and st.get("pid") == child.pid:
                    break
                time.sleep(0.1)
            alive = bool(st) and st.get("pid") == child.pid
        emit({"ok": alive, "port": port, "pid": st and st.get("pid"), "state": st and st.get("state"),
              "log": st and st.get("log")})
        return 0 if alive else 1
    st, alive = _monitor_state(port)
    if not alive:
        emit({"ok": False, "port": port, "reason": "not_running"})
        return 1
    result = esp_monitor.send(port, act)
    emit({"ok": result is not None, "port": port, "state": result and result.get("state"),
          **({} if result is not None else {"reason": "no_ack"})})
    return 0 if result is not None else 1


def cmd_reset(a):
    import time
    if not a.port:
        sys.exit("--port is required (or set ESP_PORT)")
    if _monitor_running(a.port) and esp_monitor.send(a.port, "reset") is not None:
        emit({"ok": True, "port": a.port, "via": "monitor"})
        return 0
    try:
        reset_via_serial(a.port)
    except serial.SerialException as e:
        emit({"ok": False, "port": a.port, "reason": classify_failure(str(e)), "detail": str(e)})
        return 1
    emit({"ok": True, "port": a.port, "via": "serial"})
    return 0


def reset_via_serial(port):
    import time
    s = open_serial(port, 115200)
    try:
        s.rts = True
        time.sleep(0.1)
        s.rts = False
    finally:
        s.close()


# ------------------------------------------------------------------ flash ---

FLASH_TIMEOUT_S = 30 * 60


def run_esptool_streaming(argv, on_line):
    """Run esptool, calling on_line for every line or carriage-return-separated progress update."""
    p = subprocess.Popen([sys.executable, "-m", "esptool"] + argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out, buf = [], b""
    try:
        while True:
            chunk = p.stdout.read1(256)
            if not chunk:
                break
            buf += chunk
            parts = re.split(rb"[\r\n]", buf)
            buf = parts.pop()
            for part in parts:
                if part:
                    text = part.decode("utf-8", errors="replace")
                    out.append(text)
                    on_line(text)
        if buf:
            out.append(buf.decode("utf-8", errors="replace"))
        return p.wait(timeout=FLASH_TIMEOUT_S), "\n".join(out)
    finally:
        if p.poll() is None:  # we are leaving early: never leave esptool holding the port
            p.kill()
            p.wait()


def _esptool5():
    try:
        import esptool
        return int(esptool.__version__.split(".")[0]) >= 5
    except Exception:  # noqa: BLE001
        return True


def cmd_flash(a):
    if not a.port:
        sys.exit("--port is required (or set ESP_PORT)")
    path = os.path.abspath(a.file)
    ok, why = esp_monitor.check_image(path, esp_monitor.flash_size_bytes(a.flash_size))
    if not ok:
        emit({"ok": False, "port": a.port, "file": path, "reason": "bad_image", "detail": why})
        return 1
    if not a.yes:
        emit({"ok": False, "reason": "needs_yes", "plan": {"port": a.port, "file": path, "bytes": os.path.getsize(path)}})
        return 2
    job = esp_monitor.read_json(esp_monitor.job_path(a.port))
    if job and job.get("state") == "running" and esp_monitor.pid_alive(job.get("pid", 0)):
        emit({"ok": False, "port": a.port, "reason": "already_flashing"})
        return 1
    if not a.wait:
        spawn_detached(["flash", "--port", a.port, path, "--baud", str(a.baud), "--yes", "--wait", "--json"])
        emit({"ok": True, "started": True, "job": esp_monitor.job_path(a.port)})
        return 0

    def on_line(line):
        if not a.json:
            print(line, flush=True)

    flasher = esp_monitor.FlashJob(a.port, path, a.baud, run_esptool=lambda argv, cb: run_esptool_streaming(
        argv, lambda line: (cb(line), on_line(line))), monitor_send=esp_monitor.send,
        monitor_alive=esp_monitor.monitor_active, reset_board=reset_via_serial, esptool5=_esptool5())
    result = flasher.run()
    emit({"ok": result["state"] == "done", **result})
    return 0 if result["state"] == "done" else 1


# ---------------------------------------------------------------- explain ---

def cmd_explain(a):
    if not a.port:
        sys.exit("--port is required (or set ESP_PORT)")
    state = esp_monitor.read_json(esp_monitor.paths(a.port)["state"])
    ctx = esp_ai.context_from_state(state, board=a.board)
    model = a.model or os.environ.get("ESP32_AI_MODEL") or esp_ai.DEFAULT_MODEL
    result = esp_ai.explain(ctx, api_key=esp_ai.load_key(os.environ, esp_monitor.home()), model=model, lang=a.lang)
    if a.json:
        emit(result)
    elif result["ok"]:
        print("Cause (%s, confidence %s):\n  %s" % (result["model"], result["confidence"], result["cause"]))
        for n, step in enumerate(result["steps"], 1):
            print("  %d. %s" % (n, step))
    else:
        print("AI diagnosis failed: %s %s" % (result["reason"], result.get("detail", "")))
    return 0 if result["ok"] else 1


def cmd_ai_key(a):
    """Store, check or remove the Nebius API key used by `explain`. The key itself is never printed."""
    home = esp_monitor.home()
    if a.action == "import":
        key = (os.environ.get("NEBIUS_API_KEY") or "").strip()
        if not key:
            emit({"ok": False, "reason": "no_key", "detail": "NEBIUS_API_KEY is not set in this terminal"})
            return 1
        esp_ai.save_key(home, key)
    elif a.action == "clear":
        esp_ai.clear_key(home)
    file_key = esp_ai.load_key({}, home)
    # After import, report the file: that is the copy Velloc's processes will read.
    env_key = "" if a.action == "import" else (os.environ.get("NEBIUS_API_KEY") or "").strip()
    key = env_key or file_key
    emit({"ok": bool(key), "source": "env" if env_key else "file" if file_key else None,
          "hint": ("…" + key[-4:]) if key else None, "file": os.path.join(home, esp_ai.KEY_FILE)})
    return 0 if key or a.action == "clear" else 1


# ------------------------------------------------------------------- main ---

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ports", help="list ESP-style USB serial ports (does not open them)")
    p.add_argument("--drivers", action="store_true", help="also report devices with a missing driver (Windows)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_ports)

    p = sub.add_parser("probe", help="read chip, MAC and flash via the ROM bootloader (resets the board once)")
    p.add_argument("--port", default=os.environ.get("ESP_PORT"))
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_probe)

    p = sub.add_parser("log", help="reset the board and capture its boot log (resets the board once)")
    p.add_argument("--port", default=os.environ.get("ESP_PORT"))
    p.add_argument("--seconds", type=float, default=6)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_log)

    p = sub.add_parser("monitor", help="background serial monitor: start|run|status|list|stop|pause|resume|reset|retry")
    p.add_argument("action", choices=("start", "run", "status", "list") + MONITOR_COMMANDS)
    p.add_argument("--port", default=os.environ.get("ESP_PORT"))
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--key", help="log folder name (default: the port)")
    p.add_argument("--lines", type=int, default=esp_monitor.TAIL_LINES)
    p.add_argument("--no-heartbeat", action="store_true", help="run: never exit for a missing heartbeat")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_monitor)

    p = sub.add_parser("explain", help="ask NVIDIA Nemotron on Nebius Token Factory to diagnose the board (needs NEBIUS_API_KEY)")
    p.add_argument("--port", default=os.environ.get("ESP_PORT"))
    p.add_argument("--board", default="", help="one-line board description, e.g. 'ESP32-S3 · 16MB flash · 8MB PSRAM'")
    p.add_argument("--lang", default="en", choices=sorted(esp_ai.LANGUAGES))
    p.add_argument("--model", default=None, help="default: $ESP32_AI_MODEL or %s" % esp_ai.DEFAULT_MODEL)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_explain)

    p = sub.add_parser("ai-key", help="import|status|clear the Nebius API key file used by explain")
    p.add_argument("action", choices=("import", "status", "clear"))
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_ai_key)

    p = sub.add_parser("home", help="print the data folder (monitor state, logs, flash jobs)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=lambda a: emit({"home": esp_monitor.home()}) or 0)

    p = sub.add_parser("reset", help="reset the board (through its monitor when one is running)")
    p.add_argument("--port", default=os.environ.get("ESP_PORT"))
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_reset)

    p = sub.add_parser("flash", help="WRITE a merged .bin at 0x0 (needs --yes; the only command that writes flash)")
    p.add_argument("file")
    p.add_argument("--port", default=os.environ.get("ESP_PORT"))
    p.add_argument("--baud", type=int, default=esp_monitor.FLASH_BAUD)
    p.add_argument("--flash-size", help="the board's flash size, e.g. 16MB, to refuse a larger image")
    p.add_argument("--yes", action="store_true", help="really write; without it only the plan is printed")
    p.add_argument("--wait", action="store_true", help="flash in this process and print progress")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_flash)

    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
