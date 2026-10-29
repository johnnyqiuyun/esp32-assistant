import io
import json
import os
import tempfile
import unittest
import urllib.error
from unittest import mock

from _load import load_cli, load_monitor

mon = load_monitor()
cli = load_cli()
import esp_ai  # noqa: E402  (scripts/ is on sys.path once the CLI is loaded)

STATE = {
    "port": "COM4", "state": "running",
    "summary": {"status": "crashed", "boots": 3, "last_reset": "0xc (RTC_SW_CPU_RST)", "errors": 1, "warnings": 0,
                "wifi": {"state": "disconnected", "ssid": "MyAP", "ip": None, "reason": 202, "rssi": -70}},
    "tail": [{"i": n, "text": "12:00:00.000 line-%d" % n} for n in range(120)],
}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def answer(content):
    return FakeResponse(json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8"))


class PromptTest(unittest.TestCase):
    def test_context_from_state_keeps_last_80_lines(self):
        ctx = esp_ai.context_from_state(STATE, board="ESP32-S3 · 16MB flash · 8MB PSRAM")
        self.assertEqual(len(ctx["lines"]), esp_ai.CONTEXT_LINES)
        self.assertEqual(ctx["lines"][-1], "line-119")
        self.assertEqual(ctx["board"], "ESP32-S3 · 16MB flash · 8MB PSRAM")

    def test_messages_mention_facts_and_language(self):
        msgs = esp_ai.build_messages(esp_ai.context_from_state(STATE, board="ESP32-S3"), lang="zh")
        self.assertEqual([m["role"] for m in msgs], ["system", "user"])
        user = msgs[1]["content"]
        for want in ("ESP32-S3", "0xc (RTC_SW_CPU_RST)", "crashed", "202", "line-119"):
            self.assertIn(want, user)
        self.assertIn("Chinese", msgs[0]["content"])
        self.assertIn("JSON", msgs[0]["content"])


class ParseTest(unittest.TestCase):
    def test_parse_plain_json(self):
        out = esp_ai.parse_answer('{"cause": "Null pointer", "steps": ["a", "b"], "confidence": "high"}')
        self.assertEqual(out, {"cause": "Null pointer", "steps": ["a", "b"], "confidence": "high"})

    def test_parse_fenced_json_with_chatter(self):
        text = 'Sure!\n```json\n{"cause": "Brown-out", "steps": ["Use a better cable"], "confidence": "medium"}\n```\nHope it helps.'
        self.assertEqual(esp_ai.parse_answer(text)["cause"], "Brown-out")

    def test_parse_thinking_block_ignored(self):
        text = '<think>{"cause": "wrong"}</think>{"cause": "right", "steps": [], "confidence": "low"}'
        self.assertEqual(esp_ai.parse_answer(text)["cause"], "right")

    def test_parse_not_json_falls_back_to_text(self):
        out = esp_ai.parse_answer("The board resets because the watchdog fires.")
        self.assertEqual(out["cause"], "The board resets because the watchdog fires.")
        self.assertEqual((out["steps"], out["confidence"]), ([], "unknown"))

    def test_parse_bad_confidence_normalised(self):
        self.assertEqual(esp_ai.parse_answer('{"cause": "x", "steps": "one step", "confidence": "很高"}')["steps"], ["one step"])
        self.assertEqual(esp_ai.parse_answer('{"cause": "x", "confidence": "很高"}')["confidence"], "unknown")


class CallTest(unittest.TestCase):
    def test_request_shape(self):
        seen = {}

        def opener(req, timeout):
            seen["url"], seen["body"], seen["auth"] = req.full_url, json.loads(req.data), req.get_header("Authorization")
            return answer('{"cause": "c", "steps": ["s"], "confidence": "high"}')
        out = esp_ai.explain(esp_ai.context_from_state(STATE, board="ESP32-S3"), api_key="KEY", model="nvidia/M", lang="en", opener=opener)
        self.assertEqual(seen["url"], "https://api.tokenfactory.nebius.com/v1/chat/completions")
        self.assertEqual(seen["body"]["model"], "nvidia/M")
        self.assertIn("max_tokens", seen["body"])
        self.assertEqual(seen["auth"], "Bearer KEY")
        self.assertEqual((out["ok"], out["cause"], out["model"]), (True, "c", "nvidia/M"))
        self.assertEqual(out["sent"]["lines"], esp_ai.CONTEXT_LINES)

    def test_no_key(self):
        out = esp_ai.explain({"board": "", "lines": []}, api_key=None, model="m", lang="en", opener=None)
        self.assertEqual((out["ok"], out["reason"]), (False, "no_key"))

    def test_bad_key(self):
        def opener(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))
        self.assertEqual(esp_ai.explain({"board": "", "lines": []}, api_key="K", model="m", lang="en", opener=opener)["reason"], "bad_key")

    def test_network_and_timeout(self):
        def offline(req, timeout):
            raise urllib.error.URLError("getaddrinfo failed")

        def slow(req, timeout):
            raise TimeoutError("timed out")
        ctx = {"board": "", "lines": []}
        self.assertEqual(esp_ai.explain(ctx, api_key="K", model="m", lang="en", opener=offline)["reason"], "network")
        self.assertEqual(esp_ai.explain(ctx, api_key="K", model="m", lang="en", opener=slow)["reason"], "timeout")


class CliExplainTest(unittest.TestCase):
    def setUp(self):
        os.environ["ESP32_BRINGUP_HOME"] = tempfile.mkdtemp()
        mon.write_json_atomic(mon.paths("COM9")["state"], STATE)

    def test_cli_no_key(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"NEBIUS_API_KEY": ""}), mock.patch("sys.stdout", out):
            code = cli.main(["explain", "--port", "COM9", "--json"])
        result = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual((code, result["reason"]), (1, "no_key"))

    def test_cli_uses_model_env_and_reports(self):
        out = io.StringIO()
        fake = mock.Mock(return_value={"ok": True, "cause": "c", "steps": [], "confidence": "low", "model": "nvidia/X", "sent": {}})
        with mock.patch.dict(os.environ, {"NEBIUS_API_KEY": "K", "ESP32_AI_MODEL": "nvidia/X"}), \
                mock.patch.object(esp_ai, "explain", fake), mock.patch("sys.stdout", out):
            code = cli.main(["explain", "--port", "COM9", "--board", "ESP32-S3", "--lang", "zh", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(fake.call_args.kwargs["model"], "nvidia/X")
        self.assertEqual(fake.call_args.kwargs["lang"], "zh")


if __name__ == "__main__":
    unittest.main()
