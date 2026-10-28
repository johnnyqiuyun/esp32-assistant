import unittest

from _load import fixture, load_cli

cli = load_cli()


class ParseFlashIdTest(unittest.TestCase):
    def test_parse_flash_id_ok(self):
        info = cli.parse_flash_id(fixture("flash_id_ok.txt"))
        self.assertEqual(info["chip"], "ESP32-S3")
        self.assertEqual(info["package"], "QFN56")
        self.assertEqual(info["revision"], "v0.2")
        self.assertEqual(info["features"], ["Wi-Fi", "BT 5 (LE)", "Dual Core + LP Core", "240MHz",
                                            "Embedded PSRAM 8MB (AP_3v3)"])
        self.assertEqual(info["cpu_mhz"], 240)
        self.assertEqual(info["psram"], "8MB")
        self.assertEqual(info["crystal_mhz"], 40)
        self.assertEqual(info["mac"], "74:4d:bd:9d:b5:44")
        self.assertEqual(info["flash"], {"manufacturer": "c8", "device": "4018", "size": "16MB",
                                         "type": "quad", "voltage": "3.3V"})

    def test_parse_flash_id_no_psram(self):
        text = fixture("flash_id_ok.txt").replace(
            "Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz, Embedded PSRAM 8MB (AP_3v3)",
            "Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz")
        info = cli.parse_flash_id(text)
        self.assertIsNone(info["psram"])
        self.assertEqual(info["chip"], "ESP32-S3")
        self.assertEqual(info["flash"]["size"], "16MB")


class ClassifyTest(unittest.TestCase):
    def test_classify_busy_english(self):
        self.assertEqual(cli.classify_failure(
            "could not open port 'COM4': PermissionError(13, 'Access is denied.', None, 5)"), "busy")

    def test_classify_busy_chinese(self):
        self.assertEqual(cli.classify_failure(
            "could not open port 'COM4': PermissionError(13, '拒绝访问。', None, 5)"), "busy")

    def test_classify_no_response(self):
        self.assertEqual(cli.classify_failure(
            "A fatal error occurred: Failed to connect to Espressif device: No serial data received."),
            "no_response")

    def test_classify_other(self):
        self.assertEqual(cli.classify_failure("something unexpected"), "error")


if __name__ == "__main__":
    unittest.main()
