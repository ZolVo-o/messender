#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"

cp "$ROOT_DIR/public/index.html" "$ROOT_DIR/public/manifest.json" "$ROOT_DIR/public/icon-192.svg" "$ROOT_DIR/public/icon-512.svg" "$ANDROID_DIR/www/"
npm install --no-save --prefix "$ANDROID_DIR" nitron@2.0.2
(
  cd "$ANDROID_DIR"
  node patch-nitron-template.mjs
  npx nitron build
)

echo "APK собран: $ANDROID_DIR/dist/app.apk"
