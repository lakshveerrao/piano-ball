# Flash the Piano Ball firmware from Windows (binaries built by tools/wsl_build.sh or PlatformIO).
#   powershell -File tools\flash.ps1 -Port COM17
#
# ESP32-C6 native USB quirk (learned on the AiroMote boards): after writing, a normal hard reset
# leaves the chip in download mode. Booting it with a USB reset (`--before usb_reset`) works.
param(
    [string]$Port = "COM17",
    [string]$Bin = (Join-Path $PSScriptRoot "..\firmware\.pio-wsl")
)
$ErrorActionPreference = "Stop"
$py = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"   # has esptool 5.x + deps
$Bin = (Resolve-Path $Bin).Path
foreach ($f in "bootloader.bin", "partitions.bin", "firmware.bin") {
    if (-not (Test-Path (Join-Path $Bin $f))) { throw "missing $Bin\$f - build first" }
}
Write-Host "Flashing $Bin to $Port"
& $py -m esptool --chip esp32c6 --port $Port --baud 921600 --before default-reset --after no-reset `
    write-flash --flash-size 4MB `
    0x0 (Join-Path $Bin "bootloader.bin") `
    0x8000 (Join-Path $Bin "partitions.bin") `
    0x10000 (Join-Path $Bin "firmware.bin")
if ($LASTEXITCODE -ne 0) { throw "write failed" }
Start-Sleep -Seconds 1
Write-Host "Booting the app (USB reset)"
& $py -m esptool --chip esp32c6 --port $Port --before usb-reset --after hard-reset read-mac
exit $LASTEXITCODE
