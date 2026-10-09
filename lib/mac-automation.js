// macOS implementation of the CapCut pilot actions (System Events + CoreGraphics).
// Posting clicks and keys requires the Accessibility permission for ElpoAiAutoCapcut.
import { execFile } from 'node:child_process';

export const CAPCUT_ID = 'com.lemon.lvoverseas';
const exec = (file, args, timeout = 20000) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout).trim())));
const osa = script => exec('/usr/bin/osascript', ['-e', script]);
const jxa = script => exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
const KEYS = { return: 36, enter: 76, escape: 53, tab: 48, space: 49 };

export function macActions({ ffprobe = null, trusted = () => true } = {}) {
  return {
    accessibility: async () => { if (!trusted()) return false; try { return (await osa('tell application "System Events" to get UI elements enabled')) === 'true'; } catch { return false; } },
    isRunning: async () => { try { await exec('/usr/bin/pgrep', ['-x', 'CapCut']); return true; } catch { return false; } },
    launch: () => exec('/usr/bin/open', ['-b', CAPCUT_ID]),
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
