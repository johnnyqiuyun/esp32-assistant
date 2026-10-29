# Watchdog demo firmware (ESP-IDF)

Prints a few sensor lines, then hangs in a busy loop; the task watchdog (3 s) resets the chip, and it
starts over. Used to show the pane's "keeps restarting" verdict and the AI diagnosis.

Build with ESP-IDF 5.3 or newer (the board's current firmware was built with v6.0.2):

```
idf.py set-target esp32s3
idf.py build
idf.py merge-bin
```

`merge-bin` writes `build/merged-binary.bin`. Flash it from Velloc:

```
/esp32 flash <full path>\build\merged-binary.bin COM4
```

To restore the original firmware afterwards: `/esp32 flash J:\2_MY_WORK\ESP32\esp32s3-bringup\backup\COM4-current-4MB.bin COM4`.
