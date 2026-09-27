# Build (and optionally flash) the Piano Ball firmware.
#   powershell -File firmware\build.ps1            build
#   powershell -File firmware\build.ps1 upload     build + flash (ball on USB)
#
# Quirks of this Windows machine, handled here:
#  * Use the PlatformIO in ~/.platformio/penv (6.2+). An older `python -m platformio` (6.1.x)
#    is incompatible with the pioarduino platform and uninstalls it when run.
#  * ESP-IDF refuses to run under Git Bash/MSYS, so this is PowerShell.
#  * Killing pio.exe leaves its SCons python children running; they keep the build database
#    locked and every later build deadlocks. Always kill the whole tree (done below).
#  * CMake configure can print nothing for minutes, so a stall means "no compiler CPU for
#    5 minutes", not "quiet log".
param([string]$Target = "")
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
# Do NOT use the C:\pio junction as PLATFORMIO_CORE_DIR: gcc then fails to launch cc1.exe
# ("CreateProcess: No such file or directory" / "Access is denied") through ..\libexec.
Remove-Item Env:PLATFORMIO_CORE_DIR -ErrorAction SilentlyContinue
$pio = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\pio.exe"
$pioArgs = @("run", "-j", "8")
if ($Target) { $pioArgs += @("-t", $Target) }
$log = Join-Path $PSScriptRoot ".build.log"

function Stop-BuildTree {
    Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'python.exe' -and $_.CommandLine -match 'scons\.py|pio\.exe') -or
        $_.Name -match '^(pio|riscv32-esp-elf-gcc|cc1|ninja|cmake)\.exe$'
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}
function Get-BuildCpu {
    (Get-Process riscv32-esp-elf-gcc, cc1, cmake, python, ninja -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum
}

Stop-BuildTree   # leftovers from an earlier interrupted build would deadlock this one
for ($try = 1; $try -le 5; $try++) {
    $p = Start-Process -FilePath $pio -ArgumentList $pioArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $lastCpu = -1; $stallSince = Get-Date
    while (-not $p.HasExited) {
        Start-Sleep -Seconds 10
        $cpu = Get-BuildCpu
        if ($cpu -ne $lastCpu) { $lastCpu = $cpu; $stallSince = Get-Date }
        elseif (((Get-Date) - $stallSince).TotalMinutes -gt 5) {
            Write-Host "attempt $try stalled (no CPU for 5 min), restarting"
            Stop-BuildTree
            break
        }
    }
    $out = (Get-Content $log -Raw) + (Get-Content "$log.err" -Raw -ErrorAction SilentlyContinue)
    if ($out -match "\[SUCCESS\]") {
        Select-String -Path $log -Pattern "^(RAM|Flash):" | ForEach-Object { $_.Line }
        Write-Host "OK (attempt $try)"; exit 0
    }
    if ($out -match " error:" -and $out -notmatch "CreateProcess|Access is denied") {
        Select-String -Path $log, "$log.err" -Pattern " error:" | Select-Object -First 20 | ForEach-Object { $_.Line }
        exit 1
    }
}
Write-Host "gave up after 5 attempts"; exit 1
