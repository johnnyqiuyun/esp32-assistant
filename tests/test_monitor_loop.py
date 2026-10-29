import json
import os
import tempfile
import time
import unittest

import serial

from _load import load_monitor

mon = load_monitor()
PORT = "COM9"


class FakeSerial:
    def __init__(self, chunks=()):
        self.chunks = list(chunks)
        self.rts_log = []
        self.closed = False

    def read(self, n):
        if not self.chunks:
            return b""
        item = self.chunks.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    @property
    def rts(self):
        return self.rts_log[-1] if self.rts_log else False

    @rts.setter
    def rts(self, value):
        self.rts_log.append(value)

    def close(self):
        self.closed = True


class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t


class MonitorLoopTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ["ESP32_BRINGUP_HOME"] = self.home
        self.clock = Clock()
        self.opened = []
        self.present = True
        self.open_error = None
        self.next_serial = FakeSerial()

    def open_serial(self, port, baud):
        self.opened.append((port, baud))
        if self.open_error is not None:
            raise self.open_error
        return self.next_serial

    def make(self):
        return mon.Monitor(PORT, 115200, "KEY", open_serial=self.open_serial,
                           port_present=lambda port: self.present, clock=self.clock, sleep=lambda s: None)

    def state(self):
        return mon.read_json(mon.paths(PORT)["state"])

    def command(self, cmd, cid):
        mon.write_json_atomic(mon.paths(PORT)["ctl"], {"cmd": cmd, "id": cid})

    def log_lines(self):
        with open(self.state()["log"], encoding="utf-8") as f:
            return [mon.strip_stamp(line.rstrip("\n")) for line in f]

    def test_opens_without_reset(self):
        self.next_serial = FakeSerial([b"a\n", b"b\n"])
        m = self.make()
        for _ in range(4):
            m.step()
        self.assertEqual(self.opened, [(PORT, 115200)])
        self.assertNotIn(True, self.next_serial.rts_log)
        self.assertEqual(self.state()["state"], "running")

    def test_writes_stamped_lines(self):
        self.next_serial = FakeSerial([b"hello\r\nwor", b"ld\n"])
        m = self.make()
        for _ in range(3):
            m.step()
        self.assertEqual(self.log_lines(), ["hello", "world"])
        with open(self.state()["log"], encoding="utf-8") as f:
            self.assertRegex(f.readline(), r"^\d\d:\d\d:\d\d\.\d{3} hello$")
        self.assertEqual(self.state()["lines"], 2)

    def test_pause_resume_releases_port(self):
        m = self.make()
        m.step()
        self.command("pause", 7)
        m.step()
        self.assertTrue(self.next_serial.closed)
        self.assertEqual((self.state()["state"], self.state()["ack"]), ("paused", 7))
        self.next_serial = FakeSerial()
        self.command("resume", 8)
        m.step()
        self.assertEqual((self.state()["state"], self.state()["ack"]), ("running", 8))
        self.assertEqual(len(self.opened), 2)

    def test_reset_pulses_rts(self):
        m = self.make()
        m.step()
        self.command("reset", 1)
        m.step()
        self.assertEqual(self.next_serial.rts_log, [True, False])
        self.assertFalse(self.next_serial.closed)

    def test_stop_exits(self):
        m = self.make()
        m.step()
        self.command("stop", 1)
        self.assertFalse(m.step())
        self.assertEqual(self.state()["state"], "stopped")
        self.assertTrue(self.next_serial.closed)

    def test_port_disappears_then_reopens(self):
        first = FakeSerial([serial.SerialException("ClearCommError failed")])
        self.next_serial = first
        m = self.make()
        m.step()
        m.step()
        self.assertEqual(self.state()["state"], "waiting")
        self.present = False
        self.clock.t += 5
        m.step()
        self.assertEqual(len(self.opened), 1)
        self.present = True
        self.next_serial = FakeSerial([b"back\n"])
        self.clock.t += mon.REOPEN_INTERVAL_S
        m.step()
        m.step()
        self.assertEqual(self.state()["state"], "running")
        self.assertEqual(len(self.opened), 2)
        self.assertNotIn(True, first.rts_log + self.next_serial.rts_log)

    def test_busy_does_not_retry(self):
        self.open_error = PermissionError(13, "Access is denied.")
        m = self.make()
        for _ in range(10):
            m.step()
            self.clock.t += 2
        self.assertEqual(self.state()["state"], "busy")
        self.assertEqual(len(self.opened), 1)

    def test_busy_from_serial_exception_text(self):
        self.open_error = serial.SerialException("could not open port 'COM9': PermissionError(13, '拒绝访问。', None, 5)")
        m = self.make()
        m.step()
        self.assertEqual(self.state()["state"], "busy")

    def test_retry_after_busy(self):
        self.open_error = PermissionError(13, "Access is denied.")
        m = self.make()
        m.step()
        self.open_error = None
        self.command("retry", 3)
        m.step()
        self.assertEqual(self.state()["state"], "running")
        self.assertEqual(len(self.opened), 2)

    def test_busy_then_unplug_replug_reopens(self):
        self.open_error = PermissionError(13, "Access is denied.")
        m = self.make()
        m.step()
        self.present = False
        self.clock.t += 2
        m.step()
        self.open_error = None
        self.present = True
        self.clock.t += 2
        m.step()
        self.assertEqual(self.state()["state"], "running")
        self.assertEqual(len(self.opened), 2)

    def test_heartbeat_timeout_exits(self):
        m = self.make()
        m.step()
        old = self.clock.t - (mon.HEARTBEAT_TIMEOUT_S + 1)
        os.utime(mon.paths(PORT)["hb"], (old, old))
        self.assertFalse(m.step())
        self.assertEqual((self.state()["state"], self.state()["reason"]), ("stopped", "no_heartbeat"))
        self.assertTrue(self.next_serial.closed)

    def test_summary_in_state(self):
        self.next_serial = FakeSerial([b"ESP-ROM:esp32s3-20210327\n"])
        m = self.make()
        m.step()
        m.step()
        self.assertEqual(self.state()["summary"]["boots"], 1)

    def test_log_rotation(self):
        saved = mon.LOG_ROTATE_BYTES, mon.LOG_KEEP_FILES
        try:
            mon.LOG_ROTATE_BYTES = 100
            self.next_serial = FakeSerial([b"x" * 40 + b"\n"] * 8)
            m = self.make()
            for _ in range(9):
                m.step()
            logdir = mon.log_dir("KEY")
            self.assertGreaterEqual(len(os.listdir(logdir)), 2)
            mon.LOG_KEEP_FILES = 2
            self.next_serial.chunks = [b"x" * 40 + b"\n"] * 8
            for _ in range(9):
                m.step()
            self.assertLessEqual(len(os.listdir(logdir)), 2)
        finally:
            mon.LOG_ROTATE_BYTES, mon.LOG_KEEP_FILES = saved

    def test_ignores_stale_control_on_start(self):
        self.command("stop", 99)
        m = self.make()
        self.assertTrue(m.step())
        self.assertEqual(self.state()["state"], "running")

    def test_reset_garbage_is_cleaned_and_boot_counted(self):
        # Seen on COM4 after every reset: "\xff\x00\xffESP-ROM:esp32s3-20210327" on one line.
        self.next_serial = FakeSerial([b"Rebooting...\r\n\xff\x00\xffESP-ROM:esp32s3-20210327\r\nrst:0xc (RTC_SW_CPU_RST),boot:0x8\r\n"])
        m = self.make()
        m.step()
        m.step()
        self.assertEqual(self.log_lines(), ["Rebooting...", "ESP-ROM:esp32s3-20210327", "rst:0xc (RTC_SW_CPU_RST),boot:0x8"])
        self.assertEqual(self.state()["summary"]["boots"], 1)
        self.assertNotIn("\x00", json.dumps(self.state()["tail"]))

    def test_tail_in_state(self):
        saved = mon.TAIL_LINES
        try:
            mon.TAIL_LINES = 3
            self.next_serial = FakeSerial([b"a\nb\nc\nd\ne\n"])
            m = self.make()
            m.step()
            m.step()
            tail = self.state()["tail"]
            self.assertEqual([(x["i"], mon.strip_stamp(x["text"])) for x in tail], [(2, "c"), (3, "d"), (4, "e")])
        finally:
            mon.TAIL_LINES = saved

    def test_no_heartbeat_mode_ignores_stale_heartbeat(self):
        m = mon.Monitor(PORT, 115200, "KEY", open_serial=self.open_serial, port_present=lambda port: True,
                        clock=self.clock, sleep=lambda s: None, heartbeat=False)
        m.step()
        old = self.clock.t - (mon.HEARTBEAT_TIMEOUT_S + 100)
        os.utime(mon.paths(PORT)["hb"], (old, old))
        self.assertTrue(m.step())
        self.assertEqual(self.state()["state"], "running")

    def test_send_times_out_when_no_monitor(self):
        self.assertIsNone(mon.send(PORT, "pause", timeout=0.3))

    def test_read_json_corrupt(self):
        path = os.path.join(self.home, "bad.json")
        with open(path, "w") as f:
            f.write("{")
        self.assertIsNone(mon.read_json(path))
        self.assertIsNone(mon.read_json(os.path.join(self.home, "none.json")))


if __name__ == "__main__":
    unittest.main()
