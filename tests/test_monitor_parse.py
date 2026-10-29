import os
import tempfile
import unittest

from _load import load_monitor

mon = load_monitor()
STAMP = "12:00:00.000 "


def feed(summary, *lines, now=1000.0):
    for line in lines:
        summary.feed(STAMP + line, now)


class LiveSummaryTest(unittest.TestCase):
    def test_summary_boot_and_wifi(self):
        s = mon.LiveSummary()
        feed(s, "ESP-ROM:esp32s3-20210327",
             "rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)",
             "I (900) wifi:connected with MyAP, aid = 1, channel 6, BW20, bssid = aa:bb:cc:dd:ee:ff",
             "I (1500) esp_netif_handlers: sta ip: 192.168.1.23, mask: 255.255.255.0, gw: 192.168.1.1",
             "RSSI: -58")
        d = s.to_dict()
        self.assertEqual(d["boots"], 1)
        self.assertEqual(d["last_reset"], "0x1 (POWERON)")
        self.assertEqual(d["status"], "running")
        self.assertEqual(d["last_boot_at"], 1000.0)
        self.assertEqual(d["wifi"], {"state": "connected", "ssid": "MyAP", "ip": "192.168.1.23",
                                     "reason": None, "rssi": -58})

    def test_summary_disconnect(self):
        s = mon.LiveSummary()
        feed(s, "I (900) wifi:connected with MyAP, aid = 1, channel 6",
             "I (1500) esp_netif_handlers: sta ip: 192.168.1.23, mask: 255.255.255.0",
             "I (9000) wifi:disconnected, ssid: MyAP, reason: 201")
        w = s.to_dict()["wifi"]
        self.assertEqual((w["state"], w["reason"], w["ip"]), ("disconnected", 201, None))

    def test_summary_crash_then_reboot(self):
        s = mon.LiveSummary()
        feed(s, "ESP-ROM:esp32s3-20210327", "rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)",
             "Guru Meditation Error: Core  0 panic'ed (LoadProhibited).")
        self.assertEqual(s.to_dict()["status"], "crashed")
        feed(s, "ESP-ROM:esp32s3-20210327", "rst:0xc (RTC_SW_CPU_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)")
        d = s.to_dict()
        self.assertEqual((d["status"], d["boots"], d["last_reset"]), ("running", 2, "0xc (RTC_SW_CPU_RST)"))

    def test_summary_boot_banner_after_garbage(self):
        s = mon.LiveSummary()
        feed(s, "�\x00�ESP-ROM:esp32s3-20210327")
        self.assertEqual(s.to_dict()["boots"], 1)

    def test_summary_counts(self):
        s = mon.LiveSummary()
        feed(s, "E (1) x: y", "W (1) x: y", "W (2) x: y")
        d = s.to_dict()
        self.assertEqual((d["errors"], d["warnings"]), (1, 2))

    def test_summary_user_rssi_positive(self):
        s = mon.LiveSummary()
        feed(s, "RSSI: 3 ")
        self.assertEqual(s.to_dict()["wifi"]["rssi"], 3)

    def test_summary_empty(self):
        d = mon.LiveSummary().to_dict()
        self.assertEqual((d["status"], d["boots"], d["wifi"]["state"]), ("unknown", 0, "unknown"))

    def test_strip_stamp(self):
        self.assertEqual(mon.strip_stamp("12:34:56.789 hello"), "hello")
        self.assertEqual(mon.strip_stamp("hello"), "hello")


class ImageTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def make(self, data):
        path = os.path.join(self.dir, "fw.bin")
        with open(path, "wb") as f:
            f.write(data)
        return path

    def merged(self):
        data = bytearray(0x9000)
        data[0], data[12] = 0xE9, 9
        data[0x8000:0x8002] = b"\xaa\x50"
        return self.make(bytes(data))

    def test_check_image_ok(self):
        self.assertEqual(mon.check_image(self.merged(), 4194304), (True, None))

    def test_check_image_missing(self):
        self.assertEqual(mon.check_image(os.path.join(self.dir, "nope.bin"), None), (False, "missing"))

    def test_check_image_empty(self):
        self.assertEqual(mon.check_image(self.make(b""), None), (False, "empty"))

    def test_check_image_not_esp_image(self):
        self.assertEqual(mon.check_image(self.make(b"\x7fELF" + b"\0" * 100), None), (False, "not_esp_image"))

    def test_check_image_too_big(self):
        path = self.merged()
        self.assertEqual(mon.check_image(path, 512), (False, "too_big"))
        self.assertEqual(mon.check_image(path, None), (True, None))


class ParseTest(unittest.TestCase):
    def test_parse_progress(self):
        self.assertEqual(mon.parse_progress("Writing at 0x00010000 [=====>   ] 12.3% 655360/5242880 bytes..."), 12)
        self.assertEqual(mon.parse_progress("Writing at 0x00010000... (12 %)"), 12)
        self.assertEqual(mon.parse_progress("(10 %)\n(55 %)"), 55)
        self.assertIsNone(mon.parse_progress("Connecting...."))

    def test_parse_progress_esptool_5_6_real(self):
        line = "Writing at 0x0006e338 ===========>                    39.3% 256.00kB/651.92kB [6s] "
        self.assertEqual(mon.parse_progress(line), 39)

    def test_flash_size_bytes(self):
        self.assertEqual(mon.flash_size_bytes("16MB"), 16777216)
        self.assertEqual(mon.flash_size_bytes("4MB"), 4194304)
        self.assertIsNone(mon.flash_size_bytes(None))
        self.assertIsNone(mon.flash_size_bytes("Unknown"))


if __name__ == "__main__":
    unittest.main()
