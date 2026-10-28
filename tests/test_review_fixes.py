"""Regression tests for the phase-2 final review findings."""
import os
import tempfile
import time
import unittest
from unittest import mock

import serial

from _load import load_monitor

mon = load_monitor()


def merged_image(path, chip=9, size=0x9000, table=b"\xaa\x50"):
    data = bytearray(size)
    data[0] = 0xE9
    data[12] = chip
    if size > 0x8001:
        data[0x8000:0x8002] = table
    with open(path, "wb") as f:
        f.write(data)
    return path


class WriteJsonRetryTest(unittest.TestCase):
    """C1: os.replace onto a file a reader holds open fails on Windows."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ["ESP32_BRINGUP_HOME"] = self.home
        self.real_replace = os.replace

    def test_write_json_retries_permission_error(self):
        calls = []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 1:
                raise PermissionError(13, "Access is denied")
            return self.real_replace(src, dst)
        path = os.path.join(self.home, "x.json")
        with mock.patch.object(mon.os, "replace", side_effect=flaky):
            mon.write_json_atomic(path, {"a": 1})
        self.assertEqual(mon.read_json(path), {"a": 1})
        self.assertEqual(len(calls), 2)

    def test_monitor_step_survives_publish_failure(self):
        class Quiet:
            def read(self, n):
                return b""

            def close(self):
                pass
        m = mon.Monitor("COM9", 115200, "K", open_serial=lambda p, b: Quiet(), port_present=lambda p: True,
                        sleep=lambda s: None)
        with mock.patch.object(mon.os, "replace", side_effect=PermissionError(13, "Access is denied")):
            self.assertTrue(m.step())

    def test_flash_job_survives_save_failure(self):
        path = merged_image(os.path.join(self.home, "fw.bin"))

        def esptool(argv, on_line):
            with mock.patch.object(mon.os, "replace", side_effect=PermissionError(13, "Access is denied")):
                on_line("(50 %)")
            return 0, "(100 %)"
        job = mon.FlashJob("COM9", path, 460800, run_esptool=esptool, monitor_send=lambda p, c: {"state": "x"},
                           monitor_alive=lambda p: False, reset_board=lambda p: None)
        self.assertEqual(job.run()["state"], "done")


class StreamingKillTest(unittest.TestCase):
    """C1: an exception while reading esptool's output must not leave esptool running on the port."""

    def test_child_killed_when_callback_raises(self):
        from _load import load_cli
        cli = load_cli()
        proc = mock.Mock()
        proc.stdout.read1.side_effect = [b"(10 %)\n", b""]
        proc.poll.return_value = None
        with mock.patch.object(cli.subprocess, "Popen", return_value=proc):
            with self.assertRaises(RuntimeError):
                cli.run_esptool_streaming(["x"], lambda line: (_ for _ in ()).throw(RuntimeError("boom")))
        proc.kill.assert_called_once()


class FlashJobHeartbeatTest(unittest.TestCase):
    """I1: the job file carries updatedAt so a dead job can be told from a running one."""

    def test_job_file_has_updated_at(self):
        os.environ["ESP32_BRINGUP_HOME"] = tempfile.mkdtemp()
        seen = []

        def esptool(argv, on_line):
            on_line("(10 %)")
            seen.append(mon.read_json(mon.job_path("COM9"))["updatedAt"])
            return 0, ""
        mon.FlashJob("COM9", "x.bin", 460800, run_esptool=esptool, monitor_send=lambda p, c: None,
                     monitor_alive=lambda p: False, reset_board=lambda p: None).run()
        self.assertIsNotNone(seen[0])
        self.assertLess(abs(seen[0] - time.time()), 60)


class BusyClassificationTest(unittest.TestCase):
    """I3: only 'access denied' means another program holds the port."""

    def test_device_not_functioning_is_not_busy(self):
        exc = serial.SerialException(
            "could not open port 'COM9': PermissionError(13, 'A device attached to the system is not functioning.', None, 31)")
        self.assertFalse(mon._is_busy(exc))

    def test_access_denied_is_busy(self):
        self.assertTrue(mon._is_busy(serial.SerialException(
            "could not open port 'COM9': PermissionError(13, '拒绝访问。', None, 5)")))
        self.assertTrue(mon._is_busy(PermissionError(13, "Access is denied.")))


class ImageCheckTest(unittest.TestCase):
    """I4: only a merged image for an ESP32-S3 may be written at 0x0."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "fw.bin")

    def test_merged_s3_image_ok(self):
        self.assertEqual(mon.check_image(merged_image(self.path), 16 * 1024 * 1024), (True, None))

    def test_wrong_chip(self):
        self.assertEqual(mon.check_image(merged_image(self.path, chip=0), None), (False, "wrong_chip"))

    def test_app_only_image_is_not_merged(self):
        self.assertEqual(mon.check_image(merged_image(self.path, size=0x4000), None), (False, "not_merged"))
        self.assertEqual(mon.check_image(merged_image(self.path, table=b"\xff\xff"), None), (False, "not_merged"))


if __name__ == "__main__":
    unittest.main()
