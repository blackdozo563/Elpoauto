// macOS implementation of the CapCut pilot actions (System Events + CoreGraphics).
// Posting clicks and keys requires the Accessibility permission for ElpoAiAutoCapcut.
import { execFile, execFileSync } from 'node:child_process';
import { validFrame } from './capcut-ui.js';

export const CAPCUT_ID = 'com.lemon.lvoverseas';
export function automationFailure(error, stderr, timeout) {
  if (error.killed && error.signal) return Object.assign(new Error(`La commande macOS n’a pas répondu dans le délai de ${timeout / 1000} secondes.`), { code: 'MAC_TIMEOUT', signal: error.signal, cause: error });
  const detail = String(stderr || '').trim();
  const denied = /-1743|-25211|not authorized|not allowed|pas autorisé|non autorisé/i.test(detail);
  return Object.assign(new Error(detail || `La commande macOS a échoué (code ${error.code ?? 'inconnu'}${error.signal ? `, signal ${error.signal}` : ''}).`), { code: denied ? 'MAC_PERMISSION' : error.code, signal: error.signal, cause: error });
}
const exec = (file, args, timeout = 20000) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout }, (error, stdout, stderr) => error ? reject(automationFailure(error, stderr, timeout)) : resolve(String(stdout).trim())));
const osa = script => exec('/usr/bin/osascript', ['-e', script]);
const jxa = (script, timeout) => exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], timeout);
const KEYS = { return: 36, enter: 76, escape: 53, tab: 48, space: 49 };
const foldId = value => String(value ?? '').normalize('NFC').trim().toLowerCase();

// Read only CapCut's accessible windows. The HUD belongs to ELPO and is excluded.
// Some CapCut builds expose fewer controls: callers then stop with a diagnostic
// rather than send keys to an unidentified page.
//
// Why the walk is ordered the way it is (real capture, CapCut 9 / macOS):
// the export settings are an AXSheet attached to the editor window, while the
// timeline (`MainTimeLineRoot`) holds thousands of nodes. A plain breadth-first
// walk that reaches the timeline first spends its whole budget there and returns a
// snapshot WITHOUT the sheet, so the export dialog can never be confirmed even when
// it is open on screen. Hence three rules: sheets are read before the rest of the
// window, the known giant containers are never descended into, and every top-level
// branch gets its own node budget so one panel cannot starve the others.
//
// `stop` turns the read into a cheap probe: the walk ends as soon as one of those
// automation identifiers is seen, which is what the export-dialog polling needs.
const uiScript = ({ stop = [], progress = false, deadlineMs = 12000, maxNodes = 700, branchNodes = 70 } = {}) => `
const se = Application('System Events');
const process = se.processes.byName('CapCut');
const get = (e, key, fallback = null) => { try { return e[key](); } catch { return fallback; } };
const STOP = ${JSON.stringify((Array.isArray(stop) ? stop : []).map(foldId).filter(Boolean))};
const DEADLINE_MS = ${Math.max(500, Number(deadlineMs) || 12000)};
const MAX_NODES = ${Math.max(20, Math.floor(Number(maxNodes) || 700))};
const BRANCH_NODES = ${Math.max(5, Math.floor(Number(branchNodes) || 70))};
const PROGRESS = ${progress ? 'true' : 'false'};
const PRUNE = ['maintimelineroot', 'mainmultitimelinelayout'];
const result = { windows: [], truncated: false, timedOut: false, found: false, nodesRead: 0, pruned: 0, cappedBranches: 0, modalOnly: false };
const deadline = Date.now() + DEADLINE_MS;
const expired = () => { if (Date.now() < deadline) return false; result.truncated = true; result.timedOut = true; return true; };
// Read a property record in one Apple event when available, instead of one
// Apple event per field. Older/partial accessibility objects retain the fallback.
const properties = e => { try { return e.properties() || {}; } catch { return {}; } };
const field = (e, p, key, fallback = null) => Object.prototype.hasOwnProperty.call(p, key) ? p[key] : get(e, key, fallback);
const fold = v => String(v == null ? '' : v).normalize('NFC').trim().toLocaleLowerCase();
const ids = (name, description) => [fold(name), fold(description)].filter(Boolean);
const wanted = (name, description) => STOP.length > 0 && ids(name, description).some(s => STOP.indexOf(s) >= 0);
let count = 0;
const windows = [];
for (const w of process.windows()) {
  if (expired()) break;
  const p = properties(w), position = field(w, p, 'position'), size = field(w, p, 'size');
  const window = { title: field(w, p, 'name', ''), nodes: [], frame: position && size ? { x: position[0], y: position[1], width: size[0], height: size[1] } : null };
  result.windows.push(window);
  windows.push({ w, window, p });
}
// Keep System Events' front-window order. A small floating EditPilot window
// does not consume the traversal budget of the actual editor.
for (const { w, window, p } of windows) {
  const queue = [{ e: w, depth: 0, p, branch: -1 }];
  const deferred = [];
  const used = {};
  let i = 0;
  while (i < queue.length || deferred.length) {
    if (result.found || expired()) break;
    if (count >= MAX_NODES) { result.truncated = true; break; }
    if (i === queue.length) queue.push(...deferred.splice(0, MAX_NODES - count));
    const item = queue[i++];
    const e = item.e, depth = item.depth, cached = item.p, branch = item.branch;
    if (depth > 12) { result.truncated = true; continue; }
    // Budget check BEFORE reading the element: a panel with 400 media entries must
    // not cost 400 Apple events to be told it is already over its share.
    if (!result.modalOnly && branch >= 0 && used[branch] >= BRANCH_NODES) { result.truncated = true; if (!used['c' + branch]) { used['c' + branch] = 1; result.cappedBranches++; } continue; }
    const props = cached || properties(e);
    if (field(e, props, 'visible', true) === false) continue;
    count++; result.nodesRead = count;
    if (branch >= 0) used[branch] = (used[branch] || 0) + 1;
    const name = field(e, props, 'name', ''), description = field(e, props, 'description', '');
    const value = field(e, props, 'value'), role = field(e, props, 'role', '');
    // Numbers are kept: a progress bar's value IS CapCut's export percentage. Dropping
    // non-string values is what made ELPO blind to the export's progress.
    const node = { role: role, name: name, description: description,
      value: typeof value === 'string' || (typeof value === 'number' && isFinite(value)) ? value : null, enabled: field(e, props, 'enabled', true), visible: true,
      position: field(e, props, 'position'), size: field(e, props, 'size') };
    if (role === 'AXProgressIndicator') {
      try { const max = e.attributes.byName('AXMaxValue').value(); if (typeof max === 'number' && isFinite(max)) node.max = max; } catch {}
    }
    window.nodes.push(node);
    // Real diagnostic, 2026-10-10: AXSheet was read second, then 73 editor
    // controls consumed 25 seconds before any sheet descendant was reached.
    // Prepending a sheet to a breadth-first queue does NOT prioritize its subtree.
    // Once a modal sheet is found, discard the pending editor branches entirely.
    if (role === 'AXSheet' && !result.modalOnly) {
      result.modalOnly = true;
      queue.splice(i); deferred.length = 0;
      window.nodes = window.nodes.filter(n => n === node || n.role === 'AXWindow');
    }
    if (wanted(name, description)) { result.found = true; break; }
    // Progress probe: CapCut's export progress bar ends the read as soon as it is seen.
    if (PROGRESS && role === 'AXProgressIndicator' && typeof node.value === 'number') { result.found = true; break; }
    if (window.frame && (window.frame.width < 400 || window.frame.height < 300)) break;
    if (expired()) break;
    let children = [];
    const sheets = depth === 0 ? (get(e, 'sheets', []) || []) : [];
    if (ids(name, description).some(s => PRUNE.indexOf(s) >= 0)) result.pruned++;
    else if (sheets.length) children = sheets;
    else { try { children = e.uiElements(); } catch {} }
    // System Events exposes a window's sheets separately: CapCut's export settings are
    // one of them, so they are read before the editor's own content.
    if (role === 'AXSheet') result.modalChildren = children.length;
    // Read siblings before descendants. Very large lists are deferred so that
    // hundreds of media entries do not displace a neighbouring export sheet.
    if (depth >= 12) { if (children.length) result.truncated = true; continue; }
    const target = !result.modalOnly && children.length > 50 ? deferred : queue;
    const room = target === deferred ? MAX_NODES - deferred.length : MAX_NODES - count - (queue.length - i);
    if (children.length > room) result.truncated = true;
    const keep = Math.max(0, Math.min(children.length, room));
    for (let k = 0; k < keep; k++) target.push({ e: children[k], depth: depth + 1, branch: depth === 0 ? k : branch });
  }
  if (result.modalOnly || result.found || expired() || count >= MAX_NODES) break;
}
JSON.stringify(result);`;

// Default full read; kept as a constant because the tests evaluate it verbatim.
export const CAPCUT_UI_SCRIPT = uiScript();
export { uiScript as capcutUiScript };

// The window to position is CapCut's largest one: the EditPilot bubble (a small untitled
// window) is often listed first while a project is open.
const MAIN_WINDOW = `const w = Application('System Events').processes.byName('CapCut').windows().reduce((a, b) => { const s = x => { try { const v = x.size(); return v[0] * v[1]; } catch (_) { return 0; } }; return s(b) > s(a) ? b : a; });`;

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
    // `options.stop` (automation identifiers) makes this a cheap probe: the walk ends
    // as soon as one of them is seen, so polling for the export sheet costs about a
    // second instead of a full traversal. `deadlineMs`/`maxNodes`/`branchNodes` widen
    // the read when the control really does sit deeper than the default walk.
    readUi: async options => {
      const o = options && typeof options === 'object' ? options : {};
      const probe = Array.isArray(o.stop) && o.stop.length > 0;
      const script = uiScript(probe ? { deadlineMs: 6000, ...o } : o);
      // The command must outlive the script's own deadline, or macOS is killed
      // mid-read and the caller sees a timeout instead of the partial snapshot.
      const deadline = Number(o.deadlineMs) || (probe ? 6000 : 12000);
      return JSON.parse(await jxa(script, Math.max(30000, deadline + 15000)));
    },
    windowFrame: async () => JSON.parse(await jxa(`${MAIN_WINDOW} const p = w.position(), s = w.size(); JSON.stringify({ x:p[0], y:p[1], width:s[0], height:s[1] });`)),
    restoreWindow: async frame => {
      if (!validFrame(frame)) throw new Error('Dimensions de calibrage CapCut invalides : vise à nouveau la cible.');
      await jxa(`${MAIN_WINDOW} w.position = [${frame.x}, ${frame.y}]; w.size = [${frame.width}, ${frame.height}]; 'ok';`);
    },
    activate: () => osa(`tell application id "${CAPCUT_ID}" to activate`),
    // A polite quit. While CapCut shows a modal panel (e.g. "export finished") it refuses
    // to quit and the Apple event would block until osascript is killed: the request is
    // sent without waiting for an answer, and the caller polls the process instead.
    quit: () => osa(`ignoring application responses\ntell application id "${CAPCUT_ID}" to quit\nend ignoring`).catch(() => null),
    // Last resort once the export is verified: SIGTERM, then SIGKILL when `hard`.
    // pkill exits with 1 when no CapCut process is left, which is the goal.
    forceQuit: async (hard = false) => {
      try { await exec('/usr/bin/pkill', [hard ? '-KILL' : '-TERM', '-x', 'CapCut'], 5000); }
      catch (e) { if (e.code !== 1) throw e; }
    },
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
