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

// Read only CapCut's accessible windows. The HUD belongs to ELPO and is excluded.
// Some CapCut builds expose fewer controls: callers then stop with a diagnostic
// rather than send keys to an unidentified page.
export const CAPCUT_UI_SCRIPT = `
const se = Application('System Events');
const process = se.processes.byName('CapCut');
const get = (e, key, fallback = null) => { try { return e[key](); } catch { return fallback; } };
const result = { windows: [], truncated: false, timedOut: false };
const deadline = Date.now() + 12000;
const expired = () => { if (Date.now() < deadline) return false; result.truncated = true; result.timedOut = true; return true; };
// Read a property record in one Apple event when available, instead of one
// Apple event per field. Older/partial accessibility objects retain the fallback.
const properties = e => { try { return e.properties() || {}; } catch { return {}; } };
const field = (e, p, key, fallback = null) => Object.prototype.hasOwnProperty.call(p, key) ? p[key] : get(e, key, fallback);
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
  const queue = [{ e: w, depth: 0, p }];
  const deferred = [];
  let i = 0;
  while (i < queue.length || deferred.length) {
    if (expired()) break;
    if (count >= 700) { result.truncated = true; break; }
    if (i === queue.length) queue.push(...deferred.splice(0, 700 - count));
    const { e, depth, p: cached } = queue[i++];
    if (depth > 12) { result.truncated = true; continue; }
    const props = cached || properties(e);
    if (field(e, props, 'visible', true) === false) continue;
    count++;
    const value = field(e, props, 'value');
    window.nodes.push({ role: field(e, props, 'role', ''), name: field(e, props, 'name', ''), description: field(e, props, 'description', ''),
      value: typeof value === 'string' ? value : null, enabled: field(e, props, 'enabled', true), visible: true,
      position: field(e, props, 'position'), size: field(e, props, 'size') });
    if (window.frame && (window.frame.width < 400 || window.frame.height < 300)) break;
    if (expired()) break;
    let children = []; try { children = e.uiElements(); } catch {}
    // Read siblings before descendants. Very large lists are deferred so that
    // hundreds of media entries do not displace a neighbouring export sheet.
    if (depth >= 12) { if (children.length) result.truncated = true; continue; }
    const target = children.length > 50 ? deferred : queue;
    const room = target === deferred ? 700 - deferred.length : 700 - count - (queue.length - i);
    if (children.length > room) result.truncated = true;
    for (const child of children.slice(0, Math.max(0, room))) target.push({ e: child, depth: depth + 1 });
  }
  if (expired() || count >= 700) break;
}
JSON.stringify(result);`;

// Export is a modal AXSheet in the recorded CapCut 9 journey. Read sheets
// before the editor's media/timeline tree, using only recorded identifiers.
export const CAPCUT_EXPORT_UI_SCRIPT = `
const process = Application('System Events').processes.byName('CapCut');
const get = (e, key, fallback = null) => { try { return e[key](); } catch { return fallback; } };
const result = { windows: [], truncated: false, timedOut: false, focused: 'export', complete: false };
const deadline = Date.now() + 20000;
const expired = () => { if (Date.now() < deadline) return false; result.truncated = true; result.timedOut = true; return true; };
const fold = s => typeof s === 'string' ? s.normalize('NFC').trim().toLowerCase() : '';
const output = s => typeof s === 'string' && /^\\/.+\\.(mp4|mov|m4v)$/i.test(s.trim());
const labels = n => [n.name, n.description, n.value].map(fold);
const has = (n, id) => labels(n).includes(id);
const positioned = n => n.position?.length === 2 && n.position.every(Number.isFinite) && n.size?.length === 2 && n.size.every(v => Number.isFinite(v) && v > 0);
const inside = (n, f) => !f || (n.position[0] + n.size[0] / 2 > f.x && n.position[0] + n.size[0] / 2 < f.x + f.width && n.position[1] + n.size[1] / 2 > f.y && n.position[1] + n.size[1] / 2 < f.y + f.height);
const complete = w => w.nodes.some(n => has(n, 'exportdialog')) &&
  w.nodes.some(n => has(n, 'exportokbtn') && n.role === 'AXButton' && n.enabled !== false && positioned(n) && inside(n, w.frame)) &&
  w.nodes.some(n => [n.name, n.description, n.value].some(output));
let count = 0;
for (const w of process.windows()) {
  if (expired()) break;
  const position = get(w, 'position'), size = get(w, 'size');
  const window = { title: get(w, 'name', ''), nodes: [], frame: position && size ? { x: position[0], y: position[1], width: size[0], height: size[1] } : null };
  result.windows.push(window);
  if (size && (size[0] < 400 || size[1] < 300)) continue;
  // Inspect the first usable window only: never authorize a click from an
  // export sheet in a background window.
  let sheets = []; try { sheets = w.sheets(); } catch {}
  const queue = (sheets.length ? sheets : [w]).map(e => ({ e, depth: 0, cache: {} }));
  while (queue.length) {
    if (expired()) break;
    if (count >= 700) { result.truncated = true; break; }
    const { e, depth, cache } = queue.shift();
    if (depth > 12) { result.truncated = true; continue; }
    const field = (key, fallback = null) => Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : get(e, key, fallback);
    if (field('visible', true) === false) continue;
    count++;
    const n = { name: field('name', ''), description: field('description', ''), role: field('role', ''), value: field('value'), visible: true };
    if (typeof n.value !== 'string') n.value = null;
    // Geometry is needed for the real export button, not for hundreds of
    // unrelated controls. No inferred screen coordinates are added.
    if (has(n, 'exportokbtn')) {
      n.enabled = field('enabled', true); n.position = field('position'); n.size = field('size');
    }
    window.nodes.push(n);
    if (complete(window)) { result.complete = true; break; }
    if (expired()) break;
    let children = []; try { children = e.uiElements(); } catch {}
    if (!children.length) continue;
    if (depth === 12) { if (children.length) result.truncated = true; continue; }
    // Collection attributes are one Apple event per column, not one per child.
    // If a column is unsupported, individual reads retain the same semantics.
    const columns = {};
    for (const key of ['name', 'description', 'role', 'value', 'visible']) {
      if (expired()) break;
      try { const values = e.uiElements[key](); if (Array.isArray(values) && values.length === children.length) columns[key] = values; } catch {}
    }
    const entries = children.map((child, i) => ({ e: child, depth: depth + 1, cache: Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, values[i]])) }));
    const rank = entry => entry.cache.role === 'AXSheet' || has(entry.cache, 'exportdialog') ? 0 :
      has(entry.cache, 'exportokbtn') || has(entry.cache, 'exportpathinput') || [entry.cache.name, entry.cache.description, entry.cache.value].some(output) ? 1 : 2;
    entries.sort((a, b) => rank(a) - rank(b));
    const room = 700 - count - queue.length;
    if (entries.length > room) result.truncated = true;
    queue.unshift(...entries.slice(0, Math.max(0, room)));
  }
  break;
}
JSON.stringify(result);`;

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
    readUi: async ({ purpose } = {}) => JSON.parse(await jxa(purpose === 'export' ? CAPCUT_EXPORT_UI_SCRIPT : CAPCUT_UI_SCRIPT, 30000)),
    windowFrame: async () => JSON.parse(await jxa(`${MAIN_WINDOW} const p = w.position(), s = w.size(); JSON.stringify({ x:p[0], y:p[1], width:s[0], height:s[1] });`)),
    restoreWindow: async frame => {
      if (!validFrame(frame)) throw new Error('Dimensions de calibrage CapCut invalides : vise à nouveau la cible.');
      await jxa(`${MAIN_WINDOW} w.position = [${frame.x}, ${frame.y}]; w.size = [${frame.width}, ${frame.height}]; 'ok';`);
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
