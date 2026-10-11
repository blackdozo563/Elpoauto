#!/bin/bash
# Native helper shipped inside ElpoAiAutoCapcut.app as Contents/MacOS/capcut-ax
# (copied there by electron-builder, see "extraFiles" in package.json). It runs as a
# child of the app, so macOS applies the app's own Accessibility permission to it.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p build/native
xcrun swiftc -swift-version 5 -O -target arm64-apple-macos12.0 \
  tools/capcut-ax/NativeCapture.swift tools/capcut-ax/Recording.swift tools/capcut-ax/Driver.swift tools/capcut-ax/main.swift \
  -o build/native/capcut-ax
codesign --force --sign - build/native/capcut-ax
# Pure checks (target names, allow-listed buttons, click zone): no CapCut, no event.
build/native/capcut-ax --self-test
