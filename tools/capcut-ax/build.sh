#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
output=dist/capcut-ax-record
bundle="$output/capcut-ax.app"
mkdir -p "$bundle/Contents/MacOS"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macos12.0 \
  tools/capcut-ax/NativeCapture.swift tools/capcut-ax/Recording.swift tools/capcut-ax/main.swift \
  -o "$bundle/Contents/MacOS/capcut-ax"
cp tools/capcut-ax/Info.plist "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"
cp tools/capcut-ax/README.md "$output/LIRE AVANT LE CYCLE MANUEL.md"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$output/capcut-ax-record-arm64.zip"
shasum -a 256 "$output/capcut-ax-record-arm64.zip" > "$output/SHA256SUMS.txt"
