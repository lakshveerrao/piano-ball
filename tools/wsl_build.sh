#!/usr/bin/env bash
# Build the firmware inside WSL2 (Ubuntu), where Windows antivirus doesn't block the toolchain.
#   wsl -d Ubuntu-26.04 -- bash /mnt/c/Users/ADMIN/piano-ball/tools/wsl_build.sh [status]
# Output binaries are copied back to firmware/.pio-wsl/ for flashing from Windows (tools/flash.ps1).
set -u
SRC=/mnt/c/Users/ADMIN/piano-ball
DST=~/piano-ball
PIO=~/pio-venv/bin/pio
LOG=$DST/build.log

if [ "${1:-}" = "status" ]; then
  [ -f "$LOG" ] || { echo "no build yet"; exit 0; }
  echo "steps: $(grep -cE '^(Compiling|Archiving|Linking)' "$LOG")"
  grep -E 'RAM:|Flash:|SUCCESS|FAILED| error:' "$LOG" | tail -8
  tail -2 "$LOG"
  exit 0
fi

mkdir -p "$DST"
# sync sources (keep the WSL build cache in $DST/firmware/.pio)
(cd "$SRC" && tar --exclude=firmware/.pio --exclude=firmware/.pio-wsl --exclude=firmware/sdkconfig.ball \
  --exclude=firmware/managed_components --exclude=firmware/dependencies.lock -cf - firmware web) | tar -xf - -C "$DST"
cd "$DST/firmware"
# sdkconfig.ball is generated from sdkconfig.defaults; regenerate it when the defaults change
[ sdkconfig.defaults -nt sdkconfig.ball ] && rm -f sdkconfig.ball
"$PIO" run -j "$(nproc)" > "$LOG" 2>&1
rc=$?
grep -E 'RAM:|Flash:|SUCCESS|FAILED| error:' "$LOG" | tail -8
if [ $rc -eq 0 ]; then
  out="$SRC/firmware/.pio-wsl"
  mkdir -p "$out"
  cp .pio/build/ball/bootloader.bin .pio/build/ball/partitions.bin .pio/build/ball/firmware.bin "$out/"
  ls -la "$out"
fi
exit $rc
