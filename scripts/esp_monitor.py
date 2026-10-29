"""Serial monitor and flashing internals for esp32_bringup.py (Windows only).

A monitor is a detached background process that owns one serial port, writes
every line to a log file and keeps a JSON state file the Velloc pane polls.
Other commands talk to it through a control file (pause / resume / reset /
retry / stop) and wait for its acknowledgement.
"""
import collections
import contextlib
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


# Control characters and undecodable bytes; a reset leaves "\xff\x00\xff" in front of the ROM banner.
_JUNK = re.compile("[\x00-\x08\x0b-\x1f\x7f�]")


def clean_line(text):
    return _JUNK.sub("", text)


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
        text = clean_line(strip_stamp(line))
        self.seen = True
        if "ESP-ROM:" in text:
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


ESP32S3_CHIP_ID = 9  # byte 12 of the image header (extended header chip_id)
PARTITION_TABLE_OFFSET = 0x8000
PARTITION_MAGIC = b"\xaa\x50"


def check_image(path, flash_bytes):
    """(True, None) for a merged ESP32-S3 image that may be written at 0x0, else (False, reason):
    'missing' | 'empty' | 'not_esp_image' | 'wrong_chip' | 'not_merged' | 'too_big'.

    A merged image starts with the bootloader (magic 0xE9, chip id 9) and has the partition
    table at 0x8000; an app-only .bin (also 0xE9) written at 0x0 would leave the board unbootable.
    """
    if not os.path.isfile(path):
        return False, "missing"
    size = os.path.getsize(path)
    if size == 0:
        return False, "empty"
    with open(path, "rb") as f:
        header = f.read(16)
        f.seek(PARTITION_TABLE_OFFSET)
        table = f.read(2)
    if header[0] != ESP_IMAGE_MAGIC:
        return False, "not_esp_image"
    if len(header) < 13 or header[12] != ESP32S3_CHIP_ID:
        return False, "wrong_chip"
    if table != PARTITION_MAGIC:
        return False, "not_merged"
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


def job_path(port):
    return os.path.join(home(), "jobs", port + ".flash.json")


def log_dir(key):
    return os.path.join(home(), "logs", key)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


REPLACE_TRIES = 10


def write_json_atomic(path, obj):
    """Write via a temp file and replace. On Windows the replace fails while a reader has the
    target open, so it is retried for a moment; the last failure propagates."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    for attempt in range(REPLACE_TRIES):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == REPLACE_TRIES - 1:
                raise
            time.sleep(0.02)


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


_WINERROR = re.compile(r"PermissionError\(13, .*, None, (\d+)\)")


def _is_busy(exc):
    """Another program holds the port: Windows error 5 (access denied). Other open errors, such as
    31 right after a USB port re-enumerates, are transient and retried instead."""
    winerror = getattr(exc, "winerror", None)
    if winerror is None:
        m = _WINERROR.search(str(exc))
        winerror = int(m.group(1)) if m else None
    if winerror is not None:
        return winerror == 5
    return isinstance(exc, PermissionError) or any(m in str(exc) for m in _BUSY_MARKERS)


def classify_failure(text):
    """esptool output of a failed run -> 'busy' | 'no_response' | 'error'."""
    if "could not open port" in text and any(m in text for m in _BUSY_MARKERS):
        return "busy"
    if "Failed to connect" in text or "No serial data received" in text:
        return "no_response"
    return "error"


# --------------------------------------------------------------- monitor ---

class Monitor:
    """Owns one serial port: reads it into a log file and obeys the control file.

    States: running; paused (port released on request); waiting (port vanished,
    reopened when it is back); busy (another program holds it, not retried
    until `retry` or an unplug and replug); stopped.
    """

    def __init__(self, port, baud, key, *, open_serial, port_present, clock=time.time, sleep=time.sleep,
                 heartbeat=True):
        self.port, self.baud, self.key = port, baud, key
        self.open_serial, self.port_present = open_serial, port_present
        self.clock, self.sleep = clock, sleep
        self.heartbeat = heartbeat  # False when Velloc owns the process and ends it with the session
        self.tail = collections.deque(maxlen=TAIL_LINES)
        self.p = paths(port)
        self.ser = None
        self.state = "starting"
        self.reason = None
        self.ack = None
        self.handled = (read_json(self.p["ctl"]) or {}).get("id")  # a command left by an earlier run is not ours
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
                self.tail.append({"i": self.lines, "text": line})
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
            self._write_lines([clean_line(c.decode("utf-8", errors="replace")) for c in complete])

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
        try:
            self._write_state()
        except OSError:
            pass  # a reader held the file through every retry; the next step publishes again

    def _write_state(self):
        write_json_atomic(self.p["state"], {
            "pid": os.getpid(), "port": self.port, "baud": self.baud, "key": self.key,
            "state": self.state, "reason": self.reason, "log": self.log_path,
            "startedAt": self.started_at, "updatedAt": self.clock(), "ack": self.ack,
            "lines": self.lines, "tail": list(self.tail), "summary": self.summary.to_dict(),
        })

    def step(self):
        """One round of control, I/O and bookkeeping. False means the monitor should exit."""
        alive = self._control()
        if alive and self.heartbeat and not self._heartbeat_ok():
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


class MonitorBusy(Exception):
    """The port's monitor is alive but did not release the port in time."""


def monitor_active(port):
    """A live monitor on `port` that holds (or is waiting to hold) the port."""
    st = read_json(paths(port)["state"])
    return bool(st) and st.get("state") in ("running", "waiting") and pid_alive(st.get("pid", 0))


@contextlib.contextmanager
def paused_monitor(port, reset_after=False):
    """Take the port from its running monitor for the block, then give it back; yields whether one was paused.

    With `reset_after`, the monitor resets the board once it has the port again, so
    the boot banner lands in the log. A monitor the user paused, or one that is
    busy or stopped, is left alone.
    """
    if not monitor_active(port):
        yield False
        return
    if send(port, "pause") is None:
        raise MonitorBusy(port)
    try:
        yield True
    finally:
        send(port, "resume")
        if reset_after:
            send(port, "reset")


# ----------------------------------------------------------------- flash ---

class FlashJob:
    """Write a merged image at 0x0, keeping the job file current for the pane.

    A running monitor is paused first and, whatever happens, resumed and asked to
    reset the board afterwards (esptool runs with --after no-reset, so the monitor
    sees the new firmware's boot banner). Without a monitor, `reset_board` resets it.
    """

    def __init__(self, port, file, baud, *, run_esptool, monitor_send, monitor_alive, reset_board,
                 esptool5=True, clock=time.time):
        self.port, self.file, self.baud = port, file, baud
        self.run_esptool, self.monitor_send = run_esptool, monitor_send
        self.monitor_alive, self.reset_board = monitor_alive, reset_board
        self.esptool5, self.clock = esptool5, clock
        self.job = {"pid": os.getpid(), "port": port, "file": file,
                    "bytes": os.path.getsize(file) if os.path.exists(file) else None,
                    "state": "running", "percent": 0, "startedAt": clock(), "finishedAt": None,
                    "reason": None, "detail": None}

    def _save(self, **changes):
        """Never raises: losing one progress update must not abort a flash in progress."""
        self.job.update(changes, updatedAt=self.clock())
        try:
            write_json_atomic(job_path(self.port), self.job)
        except OSError:
            pass

    def _on_line(self, line):
        pct = parse_progress(line)
        if pct is not None and pct != self.job["percent"]:
            self._save(percent=pct)

    def run(self):
        self._save()
        had_monitor = self.monitor_alive(self.port)
        if had_monitor and self.monitor_send(self.port, "pause") is None:
            self._save(state="failed", reason="busy", detail="the serial monitor did not release the port",
                       finishedAt=self.clock())
            return self.job
        name = (lambda s: s) if self.esptool5 else (lambda s: s.replace("-", "_"))
        argv = ["--port", self.port, "--baud", str(self.baud), "--after", name("no-reset"),
                name("write-flash"), "0x0", self.file]
        try:
            code, out = self.run_esptool(argv, self._on_line)
            if code == 0:
                self._save(state="done", percent=100, finishedAt=self.clock())
            else:
                tail = "\n".join(out.strip().splitlines()[-5:])
                self._save(state="failed", reason=classify_failure(out), detail=tail, finishedAt=self.clock())
        except Exception as exc:  # noqa: BLE001 - the job file must always end
            self._save(state="failed", reason="error", detail=str(exc), finishedAt=self.clock())
        finally:
            if had_monitor:
                self.monitor_send(self.port, "resume")
                self.monitor_send(self.port, "reset")
            else:
                try:
                    self.reset_board(self.port)
                except Exception:  # noqa: BLE001 - a failed reset must not hide the result
                    pass
        return self.job
