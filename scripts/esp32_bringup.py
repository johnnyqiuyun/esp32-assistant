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
    data = json.loads(text)
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
    if os.name != "nt":
        return []
    p = subprocess.run(["powershell", "-NoProfile", "-Command", PNP_QUERY],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       text=True, errors="replace", timeout=30)
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


# ------------------------------------------------------------------- main ---

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ports", help="list ESP-style USB serial ports (does not open them)")
    p.add_argument("--drivers", action="store_true", help="also report devices with a missing driver (Windows)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_ports)

    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
