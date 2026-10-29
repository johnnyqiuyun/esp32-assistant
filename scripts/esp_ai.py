"""AI diagnosis: ask an NVIDIA Nemotron model on Nebius Token Factory why the board misbehaves.

Only the facts below are sent, and only when the person asks: the board description, the
monitor's summary (status, boots, last reset reason, error/warning counts, Wi-Fi state) and
the last CONTEXT_LINES lines of the serial log. Standard library only (urllib).
"""
import json
import os
import re
import time
import urllib.error
import urllib.request

BASE_URL = "https://api.tokenfactory.nebius.com/v1"  # Nebius Token Factory, OpenAI-compatible
DEFAULT_MODEL = "nvidia/Nemotron-3_5-Lightning"
CONTEXT_LINES = 80
MAX_TOKENS = 900
REASONING_EFFORT = "none"
TIMEOUT_S = 60
CONFIDENCE = ("high", "medium", "low")

_STAMP = re.compile(r"^\d\d:\d\d:\d\d\.\d{3} ")
_JUNK = re.compile("[\x00-\x08\x0b-\x1f\x7f\ufffd]")  # reset garbage in older logs
_THINK = re.compile(r"<think>.*?</think>", re.S)
_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)

SYSTEM = (
    "You are an expert ESP32-S3 firmware engineer (ESP-IDF and Arduino). You are given facts about a board "
    "and the end of its serial log. Find the most likely root cause of any problem (crash, reboot loop, "
    "watchdog, brown-out, Wi-Fi failure, missing firmware, download mode) and how to fix it. Quote the log "
    "line that proves it. Be concrete and brief.\n"
    "Rules: 'boots seen: 0' and 'last reset: None' only mean monitoring started after the board booted; they "
    "are not a problem. A log that only repeats the program's own prints, with no errors, warnings, panics or "
    "resets, means the program is running: say it looks healthy, describe what it is doing, and suggest at "
    "most a useful check. Never suggest to re-flash, erase or change the partition table unless the log shows "
    "missing or invalid firmware. Do not invent problems the facts do not show.\n"
    "Reply with JSON only, no other text: "
    '{"cause": "<one or two sentences>", "steps": ["<fix step>", "..."], "confidence": "high|medium|low"}. '
    "At most 4 steps. Write cause and steps in %s."
)
LANGUAGES = {"zh": "Simplified Chinese", "en": "English"}


KEY_FILE = "nebius-api-key"  # in the data folder (%LOCALAPPDATA%\esp32s3-bringup, private to the Windows user)


def load_key(env, home):
    """The Nebius API key: NEBIUS_API_KEY if set, else the key file.

    Velloc does not pass NEBIUS_API_KEY on to the processes a mod starts, so `ai-key import`
    copies it into the key file once, from a normal terminal.
    """
    if env.get("NEBIUS_API_KEY"):
        return env["NEBIUS_API_KEY"].strip()
    try:
        with open(os.path.join(home, KEY_FILE), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def save_key(home, key):
    os.makedirs(home, exist_ok=True)
    with open(os.path.join(home, KEY_FILE), "w", encoding="utf-8") as f:
        f.write(key.strip())


def clear_key(home):
    try:
        os.remove(os.path.join(home, KEY_FILE))
    except OSError:
        pass


def context_from_state(state, board=""):
    """The facts sent to the model, from a monitor state file."""
    state = state or {}
    lines = [_JUNK.sub("", _STAMP.sub("", item.get("text", ""), count=1)) for item in (state.get("tail") or [])]
    return {"board": board or "", "monitor": state.get("state"), "summary": state.get("summary") or {},
            "lines": lines[-CONTEXT_LINES:]}


def build_messages(ctx, lang="en"):
    s = ctx.get("summary") or {}
    wifi = s.get("wifi") or {}
    facts = [
        "Board: %s" % (ctx.get("board") or "ESP32-S3"),
        "Monitor state: %s" % ctx.get("monitor"),
        "Program status: %s; boots seen: %s; last reset: %s" % (s.get("status"), s.get("boots"), s.get("last_reset")),
        "Errors: %s; warnings: %s" % (s.get("errors"), s.get("warnings")),
        "Wi-Fi: state %s, ssid %s, ip %s, disconnect reason %s, rssi %s" % (
            wifi.get("state"), wifi.get("ssid"), wifi.get("ip"), wifi.get("reason"), wifi.get("rssi")),
        "",
        "Last %d serial log lines:" % len(ctx.get("lines") or []),
        "\n".join(ctx.get("lines") or []) or "(no output)",
    ]
    return [
        {"role": "system", "content": SYSTEM % LANGUAGES.get(lang, "English")},
        {"role": "user", "content": "\n".join(facts)},
    ]


def _repair(candidate):
    """Fix the small JSON slips small models make: a stray quote after a list, trailing commas."""
    candidate = re.sub(r'\]\s*"\s*,', "],", candidate)
    return re.sub(r",\s*([}\]])", r"\1", candidate)


def parse_answer(text):
    """The model's reply as {cause, steps, confidence}; tolerant of fences, chatter and think blocks."""
    text = _THINK.sub("", text or "").strip()
    candidates = [m.group(1) for m in _FENCE.finditer(text)]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            data = json.loads(_repair(candidate))
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("cause"):
            steps = data.get("steps") or []
            if isinstance(steps, str):
                steps = [steps]
            confidence = str(data.get("confidence", "")).lower()
            return {"cause": str(data["cause"]).strip(), "steps": [str(x).strip() for x in steps if str(x).strip()],
                    "confidence": confidence if confidence in CONFIDENCE else "unknown"}
    return {"cause": text, "steps": [], "confidence": "unknown"}


def explain(ctx, *, api_key, model, lang, opener=urllib.request.urlopen, base_url=BASE_URL, timeout=TIMEOUT_S):
    """Ask the model; always returns a dict with `ok`, and `reason` when not ok."""
    if not api_key:
        return {"ok": False, "reason": "no_key"}
    # reasoning_effort "none": with any thinking, Nemotron 3.5 Lightning writes its reasoning into the reply
    # and runs out of tokens before the JSON (measured 2026-10-29: none 2.2 s with JSON, low 5.9 s cut off).
    body = json.dumps({"model": model, "messages": build_messages(ctx, lang), "temperature": 0.2,
                       "max_tokens": MAX_TOKENS, "reasoning_effort": REASONING_EFFORT}).encode("utf-8")
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    started = time.time()
    try:
        with opener(req, timeout=timeout) as resp:
            reply = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        reason = "bad_key" if e.code in (401, 403) else "bad_model" if e.code == 404 else "server"
        return {"ok": False, "reason": reason, "detail": "HTTP %s" % e.code, "model": model}
    except (TimeoutError, OSError) as e:
        is_timeout = isinstance(e, TimeoutError) or "timed out" in str(e)
        if isinstance(e, urllib.error.URLError) and not is_timeout:
            return {"ok": False, "reason": "network", "detail": str(e.reason), "model": model}
        return {"ok": False, "reason": "timeout" if is_timeout else "network", "detail": str(e), "model": model}
    except ValueError as e:
        return {"ok": False, "reason": "server", "detail": "bad reply: %s" % e, "model": model}
    try:
        content = reply["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return {"ok": False, "reason": "server", "detail": "no answer in reply", "model": model}
    return dict(ok=True, model=model, **parse_answer(content), seconds=round(time.time() - started, 1),
                sent={"lines": len(ctx.get("lines") or []), "summary": True, "board": bool(ctx.get("board"))})
