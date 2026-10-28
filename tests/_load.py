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
