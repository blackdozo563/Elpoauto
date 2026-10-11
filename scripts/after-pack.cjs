// electron-builder hook (macOS only): ad-hoc signature after the app is assembled and
// before the DMG is made. Apple Silicon refuses unsigned code; without an Apple
// Developer ID this local signature lets the app run (first launch: right-click → Ouvrir).
// The native CapCut helper (Contents/MacOS/capcut-ax) is signed first, then the app.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const helper = path.join(app, 'Contents', 'MacOS', 'capcut-ax');
  if (!fs.existsSync(helper)) throw new Error('capcut-ax absent du paquet : lance « npm run build:native » avant electron-builder (npm run dist:mac le fait).');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', helper], { stdio: 'inherit' });
  const entitlements = path.join(__dirname, '..', 'packaging', 'runtime-entitlements.plist');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
