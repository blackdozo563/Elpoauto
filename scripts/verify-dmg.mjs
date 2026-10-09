// CI-only native verification. No change to the packaged application's behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

assert.equal(process.platform, 'darwin', 'DMG validation requires macOS');
assert.equal(process.arch, 'arm64', 'Native startup validation requires Apple Silicon');
const dmg = path.resolve(process.argv[2]);
const expected = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-dmg-'));
const mount = path.join(scratch, 'volume'); fs.mkdirSync(mount);
const report = { version: expected.version, architecture: process.arch, checks: [] };
const command = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000, ...options });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let mounted = false, child, socket;
let nativeLog = '';
try {
  command('/usr/bin/hdiutil', ['verify', dmg]);
  command('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount]); mounted = true;
  const apps = fs.readdirSync(mount).filter(name => name.endsWith('.app'));
  assert.equal(apps.length, 1, 'Exactly one application must be present');
  const app = path.join(mount, apps[0]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  report.checks.push('DMG integrity and deep strict code signature');
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  assert.equal(plist.CFBundleIdentifier, expected.build.appId);
  assert.equal(plist.CFBundleShortVersionString, expected.version);
  assert(plist.NSAppleEventsUsageDescription?.length, 'Apple Events usage description missing');
  assert.equal(plist.NSAppleEventsUsageDescription, expected.build.mac.extendInfo.NSAppleEventsUsageDescription);
  const iconName = plist.CFBundleIconFile.endsWith('.icns') ? plist.CFBundleIconFile : `${plist.CFBundleIconFile}.icns`;
  assert.deepEqual(fs.readFileSync(path.join(app, 'Contents/Resources', iconName)), fs.readFileSync(new URL('../packaging/icon.icns', import.meta.url)));
  report.checks.push('Bundle identity, version, Apple Events description and exact icon');
  const entitlements = command('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  const entitlementPath = path.join(scratch, 'entitlements.plist'); fs.writeFileSync(entitlementPath, entitlements);
  const ent = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlementPath]));
  assert.equal(ent['com.apple.security.automation.apple-events'], true);
  assert.equal(ent['com.apple.security.cs.allow-jit'], true);
  report.checks.push('Apple Events and JIT signature entitlements');
  const executable = path.join(app, 'Contents/MacOS', plist.CFBundleExecutable);
  assert.equal(command('/usr/bin/lipo', ['-archs', executable]).trim(), 'arm64');
  report.checks.push('arm64 executable');

  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--enable-logging=stderr'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError;
  child.on('error', e => { spawnError = e; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { nativeLog = (nativeLog + bytes).slice(-24000); });
  const deadline = Date.now() + 45000;
  let page;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Native application exited early:\n${nativeLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      page = (await response.json()).find(p => p.type === 'page' && p.url.startsWith('file:') && p.url.endsWith('/renderer/index.html'));
      if (page?.webSocketDebuggerUrl) break;
    } catch { /* inspector is not ready yet */ }
    await delay(250);
  }
  assert(page?.webSocketDebuggerUrl, `Application window did not load:\n${nativeLog}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Renderer IPC readiness timed out')); }, 15000);
    pending.set(id, message => { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.enable' }));
  let result;
  while (Date.now() < deadline) {
    result = await evaluate(`(async () => {
      if (document.readyState !== 'complete' || !window.elpo?.status) return null;
      const status = await window.elpo.status();
      return { ready: document.readyState, buttons: document.querySelectorAll('button').length, status };
    })()`);
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    if (result.result?.value) break;
    await delay(250);
  }
  const state = result.result?.value;
  assert(state && state.buttons > 20, 'Packaged interface did not render');
  assert.equal(state.status.ok, true, 'Preload to main IPC failed');
  assert.equal(state.status.result.version, expected.version);
  assert.equal(state.status.result.platform, 'darwin');
  await delay(1000);
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.equal(child.exitCode, null, `Application exited after startup:\n${nativeLog}`);
  report.checks.push('Native launch, rendered interface, preload and main-process IPC');
  report.capcut = 'CapCut 9.3.0 and user calibration not exercised on CI';
  fs.writeFileSync(path.join(path.dirname(dmg), 'dmg-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(nativeLog);
  throw error;
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(100);
    if (child.exitCode === null) { child.kill('SIGKILL'); await delay(200); }
  }
  if (mounted) command('/usr/bin/hdiutil', ['detach', mount]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
