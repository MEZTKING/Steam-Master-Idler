#!/usr/bin/env bash
# Gets everything the Android build needs that isn't checked in:
#  - app/libnode/: the Node.js runtime for Android (libnode.so + headers) from nodejs-mobile, via npm
#  - app/src/main/assets/nodejs-project.zip: the idler (src/, public/, production node_modules)
# Run from anywhere: android/prepare.sh
set -euo pipefail

NODEJS_MOBILE_VERSION=18.20.4
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) Node.js runtime
if [ ! -f "$HERE/app/libnode/bin/arm64-v8a/libnode.so" ]; then
  echo "Fetching nodejs-mobile $NODEJS_MOBILE_VERSION…"
  (cd "$TMP" && npm pack --silent "nodejs-mobile-react-native@$NODEJS_MOBILE_VERSION" >/dev/null)
  tar -xzf "$TMP/nodejs-mobile-react-native-$NODEJS_MOBILE_VERSION.tgz" -C "$TMP" package/android/libnode
  rm -rf "$HERE/app/libnode"
  mv "$TMP/package/android/libnode" "$HERE/app/libnode"
fi

# 2) The idler itself, with only what it needs at runtime
echo "Packing the idler…"
PROJ="$TMP/nodejs-project"
mkdir -p "$PROJ"
cp -R "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$PROJ/"
(cd "$PROJ" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -rf "$PROJ/node_modules/koffi" "$PROJ/package-lock.json"   # koffi is only for "idle through the Steam app" on Windows
mkdir -p "$HERE/app/src/main/assets"
rm -f "$HERE/app/src/main/assets/nodejs-project.zip"
(cd "$PROJ" && python3 -m zipfile -c "$HERE/app/src/main/assets/nodejs-project.zip" src public node_modules package.json)
echo "Done: $(du -h "$HERE/app/src/main/assets/nodejs-project.zip" | cut -f1) idler, libnode for: $(ls "$HERE/app/libnode/bin" | tr '\n' ' ')"
