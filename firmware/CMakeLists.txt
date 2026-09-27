# Piano Ball firmware - plain ESP-IDF project (also built by PlatformIO, see platformio.ini).
#   idf.py set-target esp32c6 && idf.py build flash monitor
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
set(PROJECT_VER "1.0.0")
project(piano_ball)
