import json
import types
import unittest

from _load import fixture, load_cli

cli = load_cli()
SERIAL = "E4DAC533F165EE11B81F966293CD958C"


def info(**kw):
    base = dict(device="COM4", vid=0x10C4, pid=0xEA60, serial_number=SERIAL,
                description="Silicon Labs CP210x USB to UART Bridge (COM4)")
    base.update(kw)
    return types.SimpleNamespace(**base)


class PortsTest(unittest.TestCase):
    def test_bridge_of(self):
        self.assertEqual(cli.bridge_of(0x10C4), "cp210x")
        self.assertEqual(cli.bridge_of(0x1A86), "ch34x")
        self.assertEqual(cli.bridge_of(0x0403), "ftdi")
        self.assertEqual(cli.bridge_of(0x303A), "espressif-usb")
        self.assertIsNone(cli.bridge_of(0x8087))

    def test_port_entry_cp210x(self):
        self.assertEqual(cli.port_entry(info()), {
            "port": "COM4", "vid": "10C4", "pid": "EA60", "bridge": "cp210x",
            "serial": SERIAL, "description": "Silicon Labs CP210x USB to UART Bridge (COM4)"})

    def test_port_entry_unknown_vid(self):
        self.assertIsNone(cli.port_entry(info(vid=0x8087)))
        self.assertIsNone(cli.port_entry(info(vid=None, pid=None)))

    def test_port_entry_empty_serial(self):
        self.assertIsNone(cli.port_entry(info(serial_number=""))["serial"])

    def test_parse_pnp_single_object(self):
        rows = cli.parse_pnp(fixture("pnp_missing.json"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["vid"], "10C4")
        self.assertEqual(rows[0]["pid"], "EA60")
        self.assertEqual(rows[0]["error_code"], 28)
        self.assertEqual(rows[0]["name"], "CP2102N USB to UART Bridge Controller")

    def test_parse_pnp_array_and_filter(self):
        one = json.loads(fixture("pnp_missing.json"))
        other = {"Name": "Intel BT", "DeviceID": "USB\VID_8087&PID_0033\5&1", "ConfigManagerErrorCode": 28}
        rows = cli.parse_pnp(json.dumps([one, other]))
        self.assertEqual([r["vid"] for r in rows], ["10C4"])

    def test_parse_pnp_empty(self):
        self.assertEqual(cli.parse_pnp(""), [])


if __name__ == "__main__":
    unittest.main()
