// macOS implementation of the CapCut pilot actions (System Events + CoreGraphics).
// Posting clicks and keys requires the Accessibility permission for ElpoAiAutoCapcut.
import { execFile, execFileSync } from 'node:child_process';
import { validFrame } from './capcut-ui.js';

export const CAPCUT_ID = 'com.lemon.lvoverseas';
const exec = (file, args, timeout = 20000) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout }, (error, stdout, stderr) => error ? reject(Object.assign(new Error(String(stderr || error.message).trim()), { code: error.code, signal: error.signal })) : resolve(String(stdout).trim())));
const osa = script => exec('/usr/bin/osascript', ['-e', script]);
const jxa = script => exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
const KEYS = { return: 36, enter: 76, escape: 53, tab: 48, space: 49 };

// Read only CapCut's accessible windows. The HUD belongs to ELPO and is excluded.
// Some CapCut builds expose fewer controls: callers then stop with a diagnostic
// rather than send keys to an unidentified page.
export const CAPCUT_UI_SCRIPT = `
const se = Application('System Events');
const process = se.processes.byName('CapCut');
const get = (e, key, fallback = null) => { try { return e[key](); } catch { return fallback; } };
const result = { windows: [], truncated: false };
let count = 0;
for (const w of process.windows()) {
  const position = get(w, 'position'), size = get(w, 'size');
  const window = { title: get(w, 'name', ''), nodes: [], frame: position && size ? { x: position[0], y: position[1], width: size[0], height: size[1] } : null };
  const walk = (e, depth) => {
    if (depth > 12 || count >= 700) { result.truncated = true; return; }
    if (get(e, 'visible', true) === false) return;
    count++;
    const value = get(e, 'value');
    window.nodes.push({ role: get(e, 'role', ''), name: get(e, 'name', ''), description: get(e, 'description', ''),
      value: typeof value === 'string' ? value : null, enabled: get(e, 'enabled', true), visible: true,
      position: get(e, 'position'), size: get(e, 'size') });
    let children = []; try { children = e.uiElements(); } catch {}
    for (const child of children) walk(child, depth + 1);
  };
  walk(w, 0); result.windows.push(window);
}
JSON.stringify(result);`;

export function macActions({ ffprobe = null, trusted = () => true } = {}) {
  return {
    accessibility: async () => { if (!trusted()) return false; try { return (await osa('tell application "System Events" to get UI elements enabled')) === 'true'; } catch { return false; } },
    isRunning: async () => {
      try { await exec('/usr/bin/pgrep', ['-x', 'CapCut']); return true; }
      catch (e) { if (e.code === 1) return false; throw Object.assign(new Error('Impossible de vérifier la fermeture de CapCut.'), { code: 'PROCESS_UNKNOWN' }); }
    },
    assertClosed: () => {
      try { execFileSync('/usr/bin/pgrep', ['-x', 'CapCut'], { stdio: 'ignore', timeout: 5000 }); }
      catch (e) { if (e.status === 1) return; throw Object.assign(new Error('Impossible de vérifier la fermeture de CapCut.'), { code: 'PROCESS_UNKNOWN' }); }
      throw Object.assign(new Error('CapCut est ouvert : aucune écriture autorisée.'), { code: 'CAPCUT_OPEN' });
    },
    launch: () => exec('/usr/bin/open', ['-b', CAPCUT_ID]),
    readUi: async () => JSON.parse(await jxa(CAPCUT_UI_SCRIPT)),
    windowFrame: async () => JSON.parse(await jxa(`const w = Application('System Events').processes.byName('CapCut').windows()[0]; const p = w.position(), s = w.size(); JSON.stringify({ x:p[0], y:p[1], width:s[0], height:s[1] });`)),
    restoreWindow: async frame => {
      if (!validFrame(frame)) throw new Error('Dimensions de calibrage CapCut invalides : vise à nouveau la cible.');
      await jxa(`const w = Application('System Events').processes.byName('CapCut').windows()[0]; w.position = [${frame.x}, ${frame.y}]; w.size = [${frame.width}, ${frame.height}]; 'ok';`);
    },
    activate: () => osa(`tell application id "${CAPCUT_ID}" to activate`),
    quit: () => osa(`tell application id "${CAPCUT_ID}" to quit`).catch(() => null),
    key: name => osa(`tell application "System Events" to key code ${KEYS[name] ?? KEYS.return}`),
    shortcut: (letter, mods = ['command']) => osa(`tell application "System Events" to keystroke "${String(letter).replace(/[^a-z0-9]/gi, '').slice(0, 1)}" using {${mods.map(m => `${m} down`).join(', ')}}`),
    click: ({ x, y }, double = false) => jxa(`ObjC.import('CoreGraphics'); ObjC.import('Foundation');
      const p = $.CGPointMake(${Number(x)}, ${Number(y)});
      const post = (type, n) => { const e = $.CGEventCreateMouseEvent(null, type, p, $.kCGMouseButtonLeft); $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, n); $.CGEventPost($.kCGHIDEventTap, e); };
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, $.kCGMouseButtonLeft)); delay(0.15);
      post($.kCGEventLeftMouseDown, 1); post($.kCGEventLeftMouseUp, 1);
      ${double ? 'delay(0.08); post($.kCGEventLeftMouseDown, 2); post($.kCGEventLeftMouseUp, 2);' : ''} 'ok'`),
    playable: async file => {
      if (!ffprobe) return true;
      try { return Number(await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])) > 0; } catch { return false; }
    },
  };
}
