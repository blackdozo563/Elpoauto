#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
output="${1:-dist/capcut-ax-prototype}"
bundle="$output/CapCut AX Prototype.app"
mkdir -p "$bundle/Contents/MacOS"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macos12.0 \
  prototype/capcut-ax/Report.swift prototype/capcut-ax/Accessibility.swift \
  prototype/capcut-ax/Media.swift prototype/capcut-ax/Runner.swift prototype/capcut-ax/main.swift \
  -o "$bundle/Contents/MacOS/CapCutAXPrototype"
cp prototype/capcut-ax/Info.plist "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"
cp prototype/capcut-ax/README.md "$output/LIRE AVANT LE TEST.md"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$output/CapCut-AX-Prototype-arm64.zip"
shasum -a 256 "$output/CapCut-AX-Prototype-arm64.zip" > "$output/SHA256SUMS.txt"
