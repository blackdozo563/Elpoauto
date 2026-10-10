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

// Read Qt's complete accessibility tree, including AXTitle, as in projetx.
// Values are passed through argv; no user text is interpolated into AppleScript.
const CLEAN_UI = `
on clean(v)
  if v is missing value then return ""
  try
    set t to v as text
    set AppleScript's text item delimiters to {tab, linefeed, return}
    set parts to text items of t
    set AppleScript's text item delimiters to " "
    set t to parts as text
    set AppleScript's text item delimiters to ""
    return t
  on error
    set AppleScript's text item delimiters to ""
    return ""
  end try
end clean`;
export const CAPCUT_UI_APPLESCRIPT = `${CLEAN_UI}
on run argv
  set bid to item 1 of argv
  set maxEls to (item 2 of argv) as integer
  set out to ""
  tell application "System Events"
    set p to first application process whose bundle identifier is bid
    set windowCount to count of windows of p
    repeat with wi from 1 to windowCount
      set w to window wi of p
      set nm to ""
      set sr to ""
      set ps to {0, 0}
      set sz to {0, 0}
      try
        set nm to my clean(name of w)
        set sr to my clean(subrole of w)
        set ps to position of w
        set sz to size of w
      end try
      set out to out & "W" & tab & wi & tab & nm & tab & sr & tab & (item 1 of ps) & tab & (item 2 of ps) & tab & (item 1 of sz) & tab & (item 2 of sz) & linefeed
      set els to entire contents of w
      set n to count of els
      if n > maxEls then
        set n to maxEls
        set out to out & "T" & linefeed
      end if
      repeat with ei from 1 to n
        set e to item ei of els
        set r to ""
        try
          set r to role of e
        end try
        if r is in {"AXButton", "AXStaticText", "AXTextField", "AXProgressIndicator", "AXGroup", "AXLink", "AXImage", "AXRadioButton", "AXCheckBox", "AXHeading", "AXTab", "AXMenuButton"} then
          set nm to ""
          set ds to ""
          set tt to ""
          set vl to ""
          set en to "true"
          set ps to {0, 0}
          set sz to {0, 0}
          try
            set nm to my clean(name of e)
          end try
          try
            set ds to my clean(description of e)
          end try
          try
            set tt to my clean(title of e)
          end try
          try
            set vl to my clean(value of e)
          end try
          try
            if enabled of e is false then set en to "false"
          end try
          try
            set ps to position of e
            set sz to size of e
          end try
          set out to out & "E" & tab & wi & tab & ei & tab & r & tab & nm & tab & ds & tab & tt & tab & vl & tab & en & tab & (item 1 of ps) & tab & (item 2 of ps) & tab & (item 1 of sz) & tab & (item 2 of sz) & linefeed
        end if
      end repeat
    end repeat
  end tell
  return out
end run`;

export function parseCapcutUi(text) {
  const result = { windows: [], truncated: false }, windows = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const c = line.split('\t');
    if (c[0] === 'T') result.truncated = true;
    if (c[0] === 'W' && c.length >= 8) {
      const w = { index: Number(c[1]), title: c[2], subrole: c[3], frame: { x: Number(c[4]), y: Number(c[5]), width: Number(c[6]), height: Number(c[7]) }, nodes: [] };
      windows.set(c[1], w); result.windows.push(w);
    }
    if (c[0] === 'E' && c.length >= 13 && windows.has(c[1])) windows.get(c[1]).nodes.push({
      index: Number(c[2]), role: c[3], name: c[4], description: c[5], title: c[6], value: c[7], enabled: c[8] !== 'false',
      position: [Number(c[9]), Number(c[10])], size: [Number(c[11]), Number(c[12])],
    });
  }
  return result;
}

export const CAPCUT_SCROLL_APPLESCRIPT = `${CLEAN_UI}
on run argv
  set bid to item 1 of argv
  set wi to (item 2 of argv) as integer
  set ei to (item 3 of argv) as integer
  set expected to item 4 of argv
  tell application "System Events"
    set p to first application process whose bundle identifier is bid
    set els to entire contents of window wi of p
    set e to item ei of els
    set labels to {}
    try
      set end of labels to my clean(name of e)
    end try
    try
      set end of labels to my clean(title of e)
    end try
    try
      set end of labels to my clean(value of e)
    end try
    if labels does not contain expected then error "La vignette a changé pendant sa recherche."
    try
      perform action "AXScrollToVisible" of e
      return "revealed"
    on error
      return "unsupported"
    end try
  end tell
end run`;

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
    readUi: async () => parseCapcutUi(await exec('/usr/bin/osascript', ['-e', CAPCUT_UI_APPLESCRIPT, CAPCUT_ID, '2500'], 45000)),
    revealProject: async target => exec('/usr/bin/osascript', ['-e', CAPCUT_SCROLL_APPLESCRIPT, CAPCUT_ID, String(target.windowIndex), String(target.index), target.label]),
    scrollAt: ({ x, y }, lines) => {
      if (![x, y, lines].every(Number.isFinite) || !Number.isInteger(lines) || Math.abs(lines) > 10) throw new Error('Défilement CapCut invalide.');
      return jxa(`ObjC.import('CoreGraphics');
        const p = $.CGPointMake(${x}, ${y});
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, $.kCGMouseButtonLeft)); delay(0.15);
        $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitLine, 1, ${lines}, 0, 0)); 'ok';`);
    },
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
