#!/usr/bin/env bash
# One-time WSL setup without sudo: Ubuntu's python3 lacks ensurepip, so venvs are created
# --without-pip and pip is bootstrapped from bootstrap.pypa.io.
set -eu
mkvenv() {
  [ -x "$1/bin/pip" ] && return
  rm -rf "$1"
  python3 -m venv --without-pip "$1"
  curl -sSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  "$1/bin/python" /tmp/get-pip.py -q
}
mkvenv ~/pio-venv
~/pio-venv/bin/pip install -q platformio
mkdir -p ~/.platformio
mkvenv ~/.platformio/penv          # PlatformIO's own env (it can't create it here)
~/.platformio/penv/bin/pip install -q platformio
~/pio-venv/bin/pio --version
