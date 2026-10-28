import contextlib
import io
import json
import os
import tempfile
import unittest

from _load import load_cli, load_monitor

mon = load_monitor()
cli = load_cli()


class FlashJobTest(unittest.TestCase):
    def setUp(self):
        os.environ["ESP32_BRINGUP_HOME"] = tempfile.mkdtemp()
        self.calls = []
        self.percents = []
        self.argv = None
        self.resets = 0

    def esptool(self, lines, code):
        def run(argv, on_line):
            self.argv = argv
            for line in lines:
                on_line(line)
                job = mon.read_json(mon.job_path("COM9"))
                self.percents.append(job["percent"])
            return code, "\n".join(lines)
        return run

    def send(self, answer=True):
        def send(port, cmd, timeout=mon.ACK_TIMEOUT_S):
            self.calls.append(cmd)
            return {"state": "running"} if answer or cmd != "pause" else None
        return send

    def job(self, run_esptool, alive=True, send=None):
        def reset_board(port):
            self.resets += 1
        return mon.FlashJob("COM9", "C:\\fw\\a.bin", 460800, run_esptool=run_esptool,
                            monitor_send=send or self.send(), monitor_alive=lambda port: alive, reset_board=reset_board)

    def test_flash_progress_and_done(self):
        result = self.job(self.esptool(["Writing at 0x0... (10 %)", "Writing at 0x8000... (55 %)", "(100 %)"], 0)).run()
        self.assertEqual(self.percents, [10, 55, 100])
        self.assertEqual((result["state"], result["percent"]), ("done", 100))
        self.assertEqual(mon.read_json(mon.job_path("COM9"))["state"], "done")

    def test_flash_pauses_and_resumes_monitor(self):
        self.job(self.esptool(["(100 %)"], 0)).run()
        self.assertEqual(self.calls, ["pause", "resume", "reset"])
        for token in ("--after", "no-reset", "write-flash", "0x0", "C:\\fw\\a.bin"):
            self.assertIn(token, self.argv)
        self.assertEqual(self.resets, 0)

    def test_flash_without_monitor_resets_board(self):
        self.job(self.esptool(["(100 %)"], 0), alive=False).run()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.resets, 1)

    def test_flash_failure_still_resumes(self):
        out = ["A fatal error occurred: Failed to connect to Espressif device: No serial data received."]
        result = self.job(self.esptool(out, 2)).run()
        self.assertEqual((result["state"], result["reason"]), ("failed", "no_response"))
        self.assertEqual(self.calls, ["pause", "resume", "reset"])

    def test_flash_pause_fails(self):
        def never(argv, on_line):
            raise AssertionError("esptool must not run")
        result = self.job(never, send=self.send(answer=False)).run()
        self.assertEqual((result["state"], result["reason"]), ("failed", "busy"))


def run_cli(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.main(list(argv))
    return code, json.loads(out.getvalue().strip().splitlines()[-1])


class FlashCliTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["ESP32_BRINGUP_HOME"] = self.dir

    def image(self, first=b"\xe9", size=0x9000):
        """A merged ESP32-S3 image layout: magic, chip id 9 at byte 12, partition table at 0x8000."""
        path = os.path.join(self.dir, "fw.bin")
        with open(path, "wb") as f:
            f.write(first)
            f.seek(12)
            f.write(b"\x09")
            f.seek(0x8000)
            f.write(b"\xaa\x50")
            f.seek(size - 1)
            f.write(b"\0")
        return path

    def test_cli_needs_yes(self):
        path = self.image()
        code, out = run_cli("flash", "--port", "COM9", path, "--json")
        self.assertEqual((code, out["ok"], out["reason"]), (2, False, "needs_yes"))
        self.assertEqual(out["plan"], {"port": "COM9", "file": path, "bytes": 0x9000})

    def test_cli_bad_image(self):
        code, out = run_cli("flash", "--port", "COM9", self.image(first=b"\x7f"), "--yes", "--json")
        self.assertEqual((code, out["reason"], out["detail"]), (1, "bad_image", "not_esp_image"))

    def test_cli_too_big(self):
        path = self.image(size=5 * 1024 * 1024)
        code, out = run_cli("flash", "--port", "COM9", path, "--yes", "--flash-size", "4MB", "--json")
        self.assertEqual((out["reason"], out["detail"]), ("bad_image", "too_big"))

    def test_cli_already_flashing(self):
        mon.write_json_atomic(mon.job_path("COM9"), {"pid": os.getpid(), "state": "running"})
        code, out = run_cli("flash", "--port", "COM9", self.image(), "--yes", "--json")
        self.assertEqual(out["reason"], "already_flashing")


if __name__ == "__main__":
    unittest.main()
