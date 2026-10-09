import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const repair = new URL('../scripts/repair_bundle.sh', import.meta.url).pathname;
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-bundle-')), app = path.join(temp, 'ElpoAiAutoCapcut.app');
  const buddy = path.join(temp, 'plist-buddy');
  fs.writeFileSync(buddy, `#!/usr/bin/env python3
import sys,plistlib
cmd,fn=sys.argv[2],sys.argv[3]
with open(fn,'rb') as f:p=plistlib.load(f)
action,key,*tail=cmd.split(' ');key=key.removeprefix(':')
if action=='Print':print(p[key]);sys.exit(0)
if action=='Delete':p.pop(key,None)
elif action=='Add':p[key]=' '.join(tail[1:])
else:sys.exit(1)
with open(fn,'wb') as f:plistlib.dump(p,f)
`, { mode: 0o755 });
  for (const suffix of [null, '', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const name = suffix === null ? 'TryAIToday AutoCapCut' : 'TryAIToday AutoCapCut Helper' + suffix;
    const dir = suffix === null ? app : path.join(app, 'Contents/Frameworks', name + '.app');
    fs.mkdirSync(path.join(dir, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Contents/MacOS', name), 'executable-bytes-' + name, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleName</key><string>${name}</string></dict></plist>`);
  }
  return { temp, app, buddy, run: () => execFileSync('bash', ['-euc', 'source "$1"; elpo_repair_bundle "$2"; elpo_set_string "$2/Contents/Info.plist" CFBundleName ElpoAiAutoCapcut; elpo_set_string "$2/Contents/Info.plist" CFBundleDisplayName ElpoAiAutoCapcut', 'test', repair, app], { env: { ...process.env, PLIST_BUDDY: buddy }, encoding: 'utf8', stdio: 'pipe' }), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}
test('bundle : noms et chemins de tous les helpers correspondent au nom Electron', () => {
  const f = fixture();
  try {
    f.run();
    for (const suffix of [null, '', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
      const name = suffix === null ? 'ElpoAiAutoCapcut' : 'ElpoAiAutoCapcut Helper' + suffix;
      const dir = suffix === null ? f.app : path.join(f.app, 'Contents/Frameworks', name + '.app');
      const exe = path.join(dir, 'Contents/MacOS', name);
      assert.ok(fs.statSync(exe).mode & 0o111);
      const old = suffix === null ? 'TryAIToday AutoCapCut' : 'TryAIToday AutoCapCut Helper' + suffix;
      assert.equal(fs.readFileSync(exe, 'utf8'), 'executable-bytes-' + old);
      const plist = JSON.parse(execFileSync('python3', ['-c', 'import sys,plistlib,json;print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', path.join(dir, 'Contents/Info.plist')], { encoding: 'utf8' }));
      assert.equal(plist.CFBundleExecutable, name); assert.equal(plist.CFBundleName, name);
      if (suffix !== null) assert.match(plist.CFBundleIdentifier, /^com\.elpo\.ai\.autocapcut\.helper(?:\.(Renderer|GPU|Plugin))?$/);
    }
    assert.equal(fs.existsSync(path.join(f.app, 'Contents/MacOS/TryAIToday AutoCapCut')), false);
  } finally { f.cleanup(); }
});
test('bundle incomplet : refus avant tout renommage de l’exécutable principal', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.app, 'Contents/Frameworks/TryAIToday AutoCapCut Helper (GPU).app'), { recursive: true });
    assert.throws(() => f.run(), /Composant Electron absent/);
    assert.ok(fs.existsSync(path.join(f.app, 'Contents/MacOS/TryAIToday AutoCapCut')));
    assert.equal(fs.existsSync(path.join(f.app, 'Contents/MacOS/ElpoAiAutoCapcut')), false);
  } finally { f.cleanup(); }
});
