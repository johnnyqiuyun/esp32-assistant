# Builds the four demo images as merged .bin files (flash at 0x0 with `esp32_bringup.py flash` or `/esp32 flash`).
# Needs arduino-cli with the esp32:esp32 core. Output: demo-firmware\bin\demo-<scenario>.merged.bin
# Not 'Stop': arduino-cli prints compiler notes on stderr, which PowerShell 5.1 would turn into errors.
# Success is judged by $LASTEXITCODE below.
param([string[]]$Only)  # e.g. -Only healthy; default: all four
$ErrorActionPreference = 'Continue'
$cli = (Get-Command arduino-cli -ErrorAction SilentlyContinue).Source
if (-not $cli) { $cli = 'C:\Program Files\Arduino CLI\arduino-cli.exe' }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sketch = Join-Path $here 'esp32s3-demo'
$out = Join-Path $here 'bin'
New-Item -ItemType Directory -Force $out | Out-Null
# ESP32-S3 N16R8 (16 MB flash, octal PSRAM); Serial on UART0 (the CP2102N port)
$fqbn = 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,CDCOnBoot=default'
$scenarios = @('healthy', 'crash', 'wifi', 'watchdog')
for ($n = 0; $n -lt $scenarios.Count; $n++) {
  $name = $scenarios[$n]
  if ($Only -and $name -notin $Only) { continue }
  $build = Join-Path $env:TEMP "esp32s3-demo-build-$name"
  & $cli compile --fqbn $fqbn --build-property "compiler.cpp.extra_flags=-DDEMO_SCENARIO=$n" --output-dir $build $sketch
  if ($LASTEXITCODE -ne 0) { throw "build failed: $name" }
  # The merged image is padded with 0xFF to the full 16 MB; drop the padding so flashing takes seconds, not a minute.
  $bytes = [IO.File]::ReadAllBytes((Join-Path $build 'esp32s3-demo.ino.merged.bin'))
  $end = $bytes.Length
  while ($end -gt 0 -and $bytes[$end - 1] -eq 0xFF) { $end-- }
  $end = [int]([math]::Ceiling($end / 4096) * 4096)  # whole 4 KB flash sectors
  [IO.File]::WriteAllBytes((Join-Path $out "demo-$name.merged.bin"), $bytes[0..($end - 1)])
  Write-Host "built demo-$name.merged.bin"
}
Get-ChildItem $out | Select-Object Name, Length
