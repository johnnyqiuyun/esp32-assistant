"""Serial monitor and flashing internals for esp32_bringup.py (Windows only).

A monitor is a detached background process that owns one serial port, writes
every line to a log file and keeps a JSON state file the Velloc pane polls.
Other commands talk to it through a control file (pause / resume / reset /
retry / stop) and wait for its acknowledgement.
"""
import os
import re

ESP_IMAGE_MAGIC = 0xE9

_STAMP = re.compile(r"^\d\d:\d\d:\d\d\.\d{3} ")
_PANIC = re.compile(r"Guru Meditation|abort\(\) was called|panic'ed")
_RESET = re.compile(r"^rst:(0x[0-9a-fA-F]+ \([^)]*\)),boot:")
_WIFI_CONNECTED = re.compile(r"wifi:connected with ([^,\s]+)")
_WIFI_IP = re.compile(r"(?:sta ip|got ip):\s*(\d+\.\d+\.\d+\.\d+)")
_WIFI_DISCONNECTED = re.compile(r"wifi:disconnected.*?reason[:=]\s*(\d+)")
_RSSI = re.compile(r"\brssi\b\s*[:=]?\s*(-?\d+)", re.I)
_PROGRESS = re.compile(r"\((\d+)\s?%\)|\b(\d+)(?:\.\d+)?%")
_SIZE = re.compile(r"^(\d+)MB$")


def strip_stamp(line):
    """A log line without the monitor's `HH:MM:SS.mmm ` prefix."""
    return _STAMP.sub("", line, count=1)


class LiveSummary:
    """Running facts about the board, fed one log line at a time."""

    def __init__(self):
        self.seen = False
        self.crashed = False
        self.boots = 0
        self.last_reset = None
        self.last_boot_at = None
        self.errors = 0
        self.warnings = 0
        self.wifi = {"state": "unknown", "ssid": None, "ip": None, "reason": None, "rssi": None}

    def feed(self, line, now):
        text = strip_stamp(line)
        self.seen = True
        if text.startswith("ESP-ROM:"):
            self.boots += 1
            self.last_boot_at = now
            self.crashed = False
        m = _RESET.match(text)
        if m:
            self.last_reset = m.group(1)
        if _PANIC.search(text):
            self.crashed = True
        if text.startswith("E ("):
            self.errors += 1
        elif text.startswith("W ("):
            self.warnings += 1
        m = _WIFI_CONNECTED.search(text)
        if m:
            self.wifi.update(state="connected", ssid=m.group(1), reason=None)
        m = _WIFI_IP.search(text)
        if m:
            self.wifi.update(state="connected", ip=m.group(1), reason=None)
        m = _WIFI_DISCONNECTED.search(text)
        if m:
            self.wifi.update(state="disconnected", reason=int(m.group(1)), ip=None)
        m = _RSSI.search(text)
        if m:
            self.wifi["rssi"] = int(m.group(1))

    def to_dict(self):
        status = "crashed" if self.crashed else "running" if self.seen else "unknown"
        return {
            "status": status,
            "boots": self.boots,
            "last_reset": self.last_reset,
            "last_boot_at": self.last_boot_at,
            "errors": self.errors,
            "warnings": self.warnings,
            "wifi": dict(self.wifi),
        }


def check_image(path, flash_bytes):
    """(True, None) for a flashable merged image, else (False, 'missing'|'empty'|'not_esp_image'|'too_big')."""
    if not os.path.isfile(path):
        return False, "missing"
    size = os.path.getsize(path)
    if size == 0:
        return False, "empty"
    with open(path, "rb") as f:
        if f.read(1)[0] != ESP_IMAGE_MAGIC:
            return False, "not_esp_image"
    if flash_bytes is not None and size > flash_bytes:
        return False, "too_big"
    return True, None


def parse_progress(text):
    """The last progress percentage esptool printed, or None."""
    found = _PROGRESS.findall(text)
    if not found:
        return None
    a, b = found[-1]
    return int(a or b)


def flash_size_bytes(size):
    m = _SIZE.match(size or "")
    return int(m.group(1)) * 1024 * 1024 if m else None
