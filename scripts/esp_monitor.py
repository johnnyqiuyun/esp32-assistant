"""Serial monitor and flashing internals for esp32_bringup.py (Windows only).

A monitor is a detached background process that owns one serial port, writes
every line to a log file and keeps a JSON state file the Velloc pane polls.
Other commands talk to it through a control file (pause / resume / reset /
retry / stop) and wait for its acknowledgement.
"""
import json
import os
import re
import time

import serial

ESP_IMAGE_MAGIC = 0xE9
ACK_TIMEOUT_S = 3
CTL_POLL_S = 0.2
HEARTBEAT_TIMEOUT_S = 600
REOPEN_INTERVAL_S = 1
LOG_ROTATE_BYTES = 5_000_000
LOG_KEEP_FILES = 50
TAIL_LINES = 200
FLASH_BAUD = 460800
_BUSY_MARKERS = ("PermissionError", "Access is denied", "拒绝访问")

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


# ------------------------------------------------------------ data files ---

def home():
    return os.environ.get("ESP32_BRINGUP_HOME") or os.path.join(os.environ.get("LOCALAPPDATA", "."), "esp32s3-bringup")


def paths(port):
    base = os.path.join(home(), "monitors")
    return {k: os.path.join(base, port + ext) for k, ext in (("state", ".json"), ("ctl", ".ctl"), ("hb", ".hb"))}


def log_dir(key):
    return os.path.join(home(), "logs", key)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def touch_heartbeat(port):
    hb = paths(port)["hb"]
    os.makedirs(os.path.dirname(hb), exist_ok=True)
    with open(hb, "a"):
        pass
    os.utime(hb)


def send(port, cmd, timeout=ACK_TIMEOUT_S):
    """Ask the monitor on `port` to pause|resume|reset|retry|stop; its state once acknowledged, or None."""
    p = paths(port)
    cid = time.time_ns() // 1000
    write_json_atomic(p["ctl"], {"cmd": cmd, "id": cid})
    end = time.time() + timeout
    while time.time() < end:
        state = read_json(p["state"])
        if state and state.get("ack") == cid:
            return state
        time.sleep(0.05)
    return None


def pid_alive(pid):
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _is_busy(exc):
    return isinstance(exc, PermissionError) or any(m in str(exc) for m in _BUSY_MARKERS)


# --------------------------------------------------------------- monitor ---

class Monitor:
    """Owns one serial port: reads it into a log file and obeys the control file.

    States: running; paused (port released on request); waiting (port vanished,
    reopened when it is back); busy (another program holds it, not retried
    until `retry` or an unplug and replug); stopped.
    """

    def __init__(self, port, baud, key, *, open_serial, port_present, clock=time.time, sleep=time.sleep):
        self.port, self.baud, self.key = port, baud, key
        self.open_serial, self.port_present = open_serial, port_present
        self.clock, self.sleep = clock, sleep
        self.p = paths(port)
        self.ser = None
        self.state = "starting"
        self.reason = None
        self.ack = None
        self.handled = None
        self.lines = 0
        self.partial = b""
        self.summary = LiveSummary()
        self.last_attempt = None
        self.gone_since_busy = False
        self.started_at = clock()
        self.log_path = None
        touch_heartbeat(port)
        self._new_log()

    # -- log files
    def _new_log(self):
        d = log_dir(self.key)
        os.makedirs(d, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self.clock()))
        n = 0
        while True:
            path = os.path.join(d, "%s%s.log" % (stamp, "" if n == 0 else "-%03d" % n))
            if not os.path.exists(path):
                break
            n += 1
        self.log_path = path
        open(path, "a", encoding="utf-8").close()
        files = sorted(f for f in os.listdir(d) if f.endswith(".log"))
        for old in files[:max(0, len(files) - LOG_KEEP_FILES)]:
            try:
                os.remove(os.path.join(d, old))
            except OSError:
                pass

    def _write_lines(self, texts):
        now = self.clock()
        stamp = time.strftime("%H:%M:%S", time.localtime(now)) + ".%03d " % int((now % 1) * 1000)
        with open(self.log_path, "a", encoding="utf-8") as f:
            for text in texts:
                line = stamp + text
                f.write(line + "\n")
                self.summary.feed(line, now)
                self.lines += 1
        if os.path.getsize(self.log_path) >= LOG_ROTATE_BYTES:
            self._new_log()

    # -- serial
    def _try_open(self):
        self.last_attempt = self.clock()
        try:
            self.ser = self.open_serial(self.port, self.baud)
        except Exception as exc:  # noqa: BLE001 - every open failure is classified
            self.ser = None
            if _is_busy(exc):
                self.state, self.reason, self.gone_since_busy = "busy", str(exc), False
            else:
                self.state, self.reason = "waiting", str(exc)
            return
        self.state, self.reason = "running", None

    def _close(self):
        if self.ser is not None:
            try:
                self.ser.close()
            except Exception:  # noqa: BLE001
                pass
        self.ser = None

    def _read(self):
        try:
            data = self.ser.read(4096)
        except (serial.SerialException, OSError) as exc:
            self._close()
            self.state, self.reason, self.last_attempt = "waiting", str(exc), self.clock()
            return
        if not data:
            return
        *complete, self.partial = (self.partial + data).split(b"\n")
        if complete:
            self._write_lines([c.rstrip(b"\r").decode("utf-8", errors="replace") for c in complete])

    # -- control
    def _control(self):
        ctl = read_json(self.p["ctl"])
        if not ctl or ctl.get("id") == self.handled:
            return True
        self.handled = ctl.get("id")
        cmd = ctl.get("cmd")
        if cmd == "pause":
            self._close()
            self.state, self.reason = "paused", None
        elif cmd in ("resume", "retry") and self.state in ("paused", "busy", "waiting"):
            self._try_open()
        elif cmd == "reset" and self.ser is not None:
            self.ser.rts = True
            self.sleep(0.1)
            self.ser.rts = False
        elif cmd == "stop":
            self._close()
            self.state, self.reason = "stopped", None
        self.ack = self.handled
        return cmd != "stop"

    def _heartbeat_ok(self):
        try:
            return self.clock() - os.path.getmtime(self.p["hb"]) <= HEARTBEAT_TIMEOUT_S
        except OSError:
            return False

    def _publish(self):
        write_json_atomic(self.p["state"], {
            "pid": os.getpid(), "port": self.port, "baud": self.baud, "key": self.key,
            "state": self.state, "reason": self.reason, "log": self.log_path,
            "startedAt": self.started_at, "updatedAt": self.clock(), "ack": self.ack,
            "lines": self.lines, "summary": self.summary.to_dict(),
        })

    def step(self):
        """One round of control, I/O and bookkeeping. False means the monitor should exit."""
        alive = self._control()
        if alive and not self._heartbeat_ok():
            self._close()
            self.state, self.reason, alive = "stopped", "no_heartbeat", False
        if alive:
            if self.state == "starting":
                self._try_open()
            elif self.state == "running":
                self._read()
            elif self.state == "waiting":
                if self.clock() - (self.last_attempt or 0) >= REOPEN_INTERVAL_S and self.port_present(self.port):
                    self._try_open()
            elif self.state == "busy":
                if not self.port_present(self.port):
                    self.gone_since_busy = True
                elif self.gone_since_busy:
                    self._try_open()
        self._publish()
        return alive

    def run(self):
        while self.step():
            if self.state != "running":
                self.sleep(CTL_POLL_S)
