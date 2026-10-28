import contextlib
import io
import json
import os
import tempfile
import time
import unittest
from unittest import mock

from _load import load_cli, load_monitor

mon = load_monitor()
cli = load_cli()


def run_cli(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.main(list(argv))
    return code, json.loads(out.getvalue().strip().splitlines()[-1])


class CliMonitorTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.environ["ESP32_BRINGUP_HOME"] = self.home

    def write_monitor(self, port="COM9", pid=12345, state="running", lines=250):
        log = os.path.join(self.home, "logs", "K", "x.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "w", encoding="utf-8") as f:
            for n in range(lines):
                f.write("12:00:00.000 line-%d\n" % n)
        mon.write_json_atomic(mon.paths(port)["state"], {"pid": pid, "port": port, "state": state, "log": log})
        return log

    def test_status_without_monitor(self):
        code, out = run_cli("monitor", "status", "--port", "COM9", "--json")
        self.assertEqual(code, 0)
        self.assertEqual((out["monitor"], out["alive"], out["lines"], out["flash"]), (None, False, [], None))

    def test_status_tail_and_heartbeat(self):
        self.write_monitor()
        hb = mon.paths("COM9")["hb"]
        with mock.patch.object(mon, "pid_alive", return_value=True):
            code, out = run_cli("monitor", "status", "--port", "COM9", "--json")
        self.assertTrue(out["alive"])
        self.assertEqual(len(out["lines"]), 200)
        self.assertEqual(out["lines"][-1], {"i": 249, "text": "12:00:00.000 line-249"})
        self.assertLess(time.time() - os.path.getmtime(hb), 5)

    def test_list_marks_dead(self):
        self.write_monitor(port="COM9", pid=1)
        self.write_monitor(port="COM8", pid=2)
        with mock.patch.object(mon, "pid_alive", side_effect=lambda pid: pid == 2):
            code, out = run_cli("monitor", "list", "--json")
        self.assertEqual([m["port"] for m in out["monitors"]], ["COM8"])
        self.assertEqual(mon.read_json(mon.paths("COM9")["state"])["state"], "stopped")

    def test_command_without_monitor(self):
        code, out = run_cli("monitor", "pause", "--port", "COM9", "--json")
        self.assertEqual((code, out["ok"], out["reason"]), (1, False, "not_running"))


class PausedMonitorTest(unittest.TestCase):
    def setUp(self):
        os.environ["ESP32_BRINGUP_HOME"] = tempfile.mkdtemp()
        self.calls = []

    def fake_send(self, result):
        def send(port, cmd, timeout=mon.ACK_TIMEOUT_S):
            self.calls.append(cmd)
            return result
        return send

    def running(self):
        mon.write_json_atomic(mon.paths("COM9")["state"], {"pid": 4242, "port": "COM9", "state": "running"})

    def test_paused_monitor_pauses_and_resumes(self):
        self.running()
        with mock.patch.object(mon, "send", self.fake_send({"state": "paused"})), \
                mock.patch.object(mon, "pid_alive", return_value=True):
            with mon.paused_monitor("COM9"):
                self.assertEqual(self.calls, ["pause"])
            with self.assertRaises(RuntimeError):
                with mon.paused_monitor("COM9"):
                    raise RuntimeError("probe failed")
        self.assertEqual(self.calls, ["pause", "resume", "pause", "resume"])

    def test_paused_monitor_reset_after(self):
        self.running()
        with mock.patch.object(mon, "send", self.fake_send({"state": "running"})), \
                mock.patch.object(mon, "pid_alive", return_value=True):
            with mon.paused_monitor("COM9", reset_after=True) as active:
                self.assertTrue(active)
        self.assertEqual(self.calls, ["pause", "resume", "reset"])

    def test_paused_monitor_yields_false_without_monitor(self):
        with mon.paused_monitor("COM9", reset_after=True) as active:
            self.assertFalse(active)

    def test_probe_without_reset_when_monitor_active(self):
        seen = {}

        def fake_run(argv, **kw):
            seen["argv"] = argv
            return mock.Mock(stdout="", returncode=2)
        with mock.patch.object(cli.subprocess, "run", side_effect=fake_run):
            cli.run_probe("COM9", reset=False)
        self.assertIn("--after", seen["argv"])
        self.assertIn("no-reset", seen["argv"])

    def test_paused_monitor_busy(self):
        self.running()
        with mock.patch.object(mon, "send", self.fake_send(None)), \
                mock.patch.object(mon, "pid_alive", return_value=True):
            with self.assertRaises(mon.MonitorBusy):
                with mon.paused_monitor("COM9"):
                    pass

    def test_paused_monitor_no_monitor(self):
        with mock.patch.object(mon, "send", self.fake_send(None)):
            with mon.paused_monitor("COM9"):
                pass
        self.assertEqual(self.calls, [])

    def test_paused_monitor_leaves_user_pause_alone(self):
        mon.write_json_atomic(mon.paths("COM9")["state"], {"pid": 4242, "port": "COM9", "state": "paused"})
        with mock.patch.object(mon, "send", self.fake_send({"state": "paused"})), \
                mock.patch.object(mon, "pid_alive", return_value=True):
            with mon.paused_monitor("COM9"):
                pass
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
