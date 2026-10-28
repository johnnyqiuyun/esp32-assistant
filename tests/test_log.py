import unittest

from _load import fixture, load_cli

cli = load_cli()


class SummarizeBootTest(unittest.TestCase):
    def test_summary_ok(self):
        s = cli.summarize_boot(fixture("boot_ok.txt"))
        self.assertEqual(s["reset_reason"], "0x1 (POWERON)")
        self.assertEqual(s["boot_mode"], "0x8 (SPI_FAST_FLASH_BOOT)")
        self.assertIs(s["psram_ok"], True)
        self.assertEqual(s["project"], "Code")
        self.assertEqual(s["idf_version"], "v6.0.2")
        self.assertEqual(len(s["warnings"]), 1)
        self.assertIn("Detected size(16384k)", s["warnings"][0])
        self.assertEqual(s["errors"], [])
        self.assertIs(s["panic"], False)
        self.assertEqual(s["boots"], 1)

    def test_summary_panic_reboot(self):
        text = fixture("boot_ok.txt") + (
            "Guru Meditation Error: Core  0 panic'ed (LoadProhibited).\n"
            "ESP-ROM:esp32s3-20210327\n"
            "rst:0xc (RTC_SW_CPU_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)\n")
        s = cli.summarize_boot(text)
        self.assertIs(s["panic"], True)
        self.assertEqual(s["boots"], 2)
        self.assertEqual(s["reset_reason"], "0xc (RTC_SW_CPU_RST)")

    def test_summary_psram_fail(self):
        text = fixture("boot_ok.txt").replace(
            "I (993) esp_psram: SPI SRAM memory test OK",
            "E (993) esp_psram: SPI SRAM memory test fail")
        s = cli.summarize_boot(text)
        self.assertIs(s["psram_ok"], False)
        self.assertTrue(any("memory test fail" in e for e in s["errors"]))

    def test_summary_empty(self):
        s = cli.summarize_boot("")
        for key in ("reset_reason", "boot_mode", "psram_ok", "project", "idf_version"):
            self.assertIsNone(s[key], key)
        self.assertEqual(s["boots"], 0)
        self.assertIs(s["panic"], False)


if __name__ == "__main__":
    unittest.main()
