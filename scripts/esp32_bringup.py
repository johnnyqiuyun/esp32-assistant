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


def classify_failure(text):
    if "could not open port" in text and any(s in text for s in ("PermissionError", "Access is denied", "拒绝访问")):
        return "busy"
    if "Failed to connect" in text or "No serial data received" in text:
        return "no_response"
    return "error"


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


def cmd_probe(a):
    port = a.port
    if not port:
        sys.exit("--port is required (or set ESP_PORT)")
    try:
        p = subprocess.run([sys.executable, "-m", "esptool", "--port", port, _esptool_name("flash-id")],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, errors="replace", timeout=PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        result = {"ok": False, "port": port, "reason": "no_response",
                  "detail": "esptool timed out after %ds" % PROBE_TIMEOUT_S}
    else:
        result = probe_result(p.stdout, p.returncode, port)
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


def cmd_log(a):
    if not a.port:
        sys.exit("--port is required (or set ESP_PORT)")
    try:
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

    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
