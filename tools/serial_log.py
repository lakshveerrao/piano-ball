"""Print the ball's USB serial log for a few seconds.
   python tools/serial_log.py COM17 [seconds]"""
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM17"
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10
with serial.Serial(port, 115200, timeout=0.2) as s:
    end = time.time() + seconds
    while time.time() < end:
        line = s.readline()
        if line:
            print(line.decode("utf-8", "replace").rstrip())
