#!/usr/bin/env bash
# Runs on an Android emulator in CI: install the APK, start it, and check that the idler's
# Node.js server comes up inside the app and answers as the Android build. Saves a screenshot
# and the app's log next to the APKs.
set -euo pipefail

PKG=com.meztking.steammasteridler
OUT=android/app/build/outputs/apk/release
APK=$(ls "$OUT"/*-x86_64.apk)

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true
adb logcat -c
adb shell am start -n "$PKG/.MainActivity"

# the server logs "GUI running at http://127.0.0.1:<port>" once it's listening
PORT=""
for _ in $(seq 1 90); do
  PORT=$(adb logcat -d -s SteamMasterIdler-node:I | grep -o 'GUI running at http://127.0.0.1:[0-9]*' | head -1 | grep -o '[0-9]*$' || true)
  [ -n "$PORT" ] && break
  sleep 2
done
if [ -z "$PORT" ]; then
  echo "The idler server never started. App log:"
  adb logcat -d | grep -iE "SteamMasterIdler|AndroidRuntime|nodejs|FATAL" | tail -150
  exit 1
fi
echo "Idler server is listening on port $PORT inside the app"

adb forward tcp:39999 tcp:"$PORT"
STATE=$(curl -s http://127.0.0.1:39999/api/state)
echo "${STATE:0:300}"
echo "$STATE" | grep -q '"mobile":true' || { echo "server did not report the Android build"; exit 1; }
echo "$STATE" | grep -q '"status":"loggedOut"' || { echo "unexpected login state"; exit 1; }

# dismiss the battery-optimisation prompt so the screenshot shows the app
sleep 4
adb shell input keyevent KEYCODE_BACK || true
sleep 3
adb exec-out screencap -p > "$OUT/android-smoke-screenshot.png"
adb logcat -d -s SteamMasterIdler:* SteamMasterIdler-node:* AndroidRuntime:E > "$OUT/android-smoke-logcat.txt" || true
echo "Smoke test passed"
