import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(_HERE, "fixtures")


def load_cli():
    path = os.path.join(_HERE, "..", "scripts", "esp32_bringup.py")
    spec = importlib.util.spec_from_file_location("esp32_bringup", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


def load_monitor():
    import sys
    scripts = os.path.join(_HERE, "..", "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    path = os.path.join(scripts, "esp_monitor.py")
    spec = importlib.util.spec_from_file_location("esp_monitor", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["esp_monitor"] = mod
    spec.loader.exec_module(mod)
    return mod
