// A simulated CapCut 9.3.0 for the pilot tests. Every screen it shows is a frame of the
// real recording (tests/fixtures/capcut-9.3.0-cycle.json); only the project name, the
// announced path and the percentage are substituted. Its native driver answers like
// tools/capcut-ax: same refusals, same allow-list, same name check before Exporter.
import fs from 'node:fs';
import path from 'node:path';
import { targetMatches } from '../lib/capcut-screen.js';

const recording = JSON.parse(fs.readFileSync(new URL('./fixtures/capcut-9.3.0-cycle.json', import.meta.url), 'utf8'));
export const frames = recording.frames;
const clone = o => JSON.parse(JSON.stringify(o));

export function substitute(frame, pairs) {
  const f = clone(frame);
  for (const w of f.windows || []) for (const n of w.nodes || []) for (const k of ['title', 'description', 'identifier', 'value']) {
    if (typeof n[k] === 'string') for (const [from, to] of pairs) n[k] = n[k].split(from).join(to);
  }
  return f;
}
// What `capcut-ax snapshot --scope sheet` returns: each window, and only its sheet.
export function sheetOnly(frame) {
  const f = clone(frame);
  f.scope = 'sheet';
  for (const w of f.windows || []) {
    const sheets = (w.nodes || []).filter(n => n.role === 'AXSheet').map(n => n.path);
    w.nodes = (w.nodes || []).filter(n => n.role === 'AXWindow' || sheets.some(p => n.path === p || n.path.startsWith(`${p}/`)));
  }
  return f;
}
const tileFrames = frame => frame.windows.flatMap(w => w.nodes).filter(n => n.description === 'HomePageDraft' && n.frame?.height >= 60).map(n => n.frame);
const titleFrames = frame => frame.windows.flatMap(w => w.nodes).filter(n => n.description?.startsWith('HomePageDraftTitle:')).map(n => ({ name: n.description.slice(19), frame: n.frame }));
const inside = (p, f) => p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height;

// options:
//   layout 'titles' (names exposed, PROJET-A first) | 'cut' (first row cut, no names, as after a launch)
//   firstTile           project opened by the first tile when names are hidden (default: the job's project)
//   missDoubleClicks    double-clicks on a tile that CapCut does not receive
//   missExportClicks    clicks on the editor's « Exporter » that CapCut does not receive
//   missPresses         AXPress on ExportOkBtn accepted by macOS but without effect
//   step                percentage gained per read while encoding
//   stuck               the percentage stops moving at this value
//   cancelAt            the export sheet disappears at this percentage
//   errorAt             an unknown sheet replaces the progress at this percentage
//   noFile              CapCut ends without writing the file
//   fileName            name of the written file (default: the announced one)
//   fileDelayReads      the file appears this many reads after the end panel
//   incompleteProbes    FFprobe answers 0 this many times
//   noProbe             FFprobe is not installed
//   probeSeconds        duration FFprobe reads (default 276 s, the recorded timeline: 275.7 s)
//   uncertainPress      AXPress on ExportOkBtn takes effect but answers cannotComplete
//   busyReads           reads answered "cannotComplete" after each page change
//   quitRefusedWhile    pages during which CapCut ignores a polite quit
//   unkillable          SIGTERM/SIGKILL do not end CapCut
//   open                CapCut is already open (by the user) before the lot
//   corrupt             file damaged by a forced quit
//   announceFolder      folder announced by the export sheet (default: exportDir)
export function simulatedCapcut({ exportDir, name, ...o }) {
  const log = [];
  let running = !!o.open, page = 'home', opened = null, percent = 0, busy = 0, doneReads = 0, written = null;
  let missDouble = o.missDoubleClicks || 0, missExport = o.missExportClicks || 0, missPress = o.missPresses || 0, incomplete = o.incompleteProbes || 0;
  const folder = o.announceFolder || exportDir;
  const target = () => path.join(folder, `${opened}.mp4`);
  const home = () => (o.layout === 'cut' ? frames['home-after-close'] : substitute(frames.home, [['PROJET-A', name]]));
  const go = next => { page = next; busy = o.busyReads ?? 1; };
  const finish = () => {
    page = 'done'; doneReads = 0;
    if (!o.noFile && !o.fileDelayReads) write();
  };
  const write = () => {
    const file = path.join(folder, o.fileName || `${opened}.mp4`);
    fs.writeFileSync(file, 'x'.repeat(4096)); written = file; log.push(`fichier ${path.basename(file)}`);
  };
  const frame = () => {
    if (page === 'home') return home();
    if (page === 'editor') return frames.editor;
    if (page === 'settings') return substitute(frames['export-settings'], [['/Users/demo/Desktop/PROJET-A.mp4', target()]]);
    if (page === 'exporting') return substitute(frames['exporting-start'], [['ExportProgress:38.4%', `ExportProgress:${percent.toFixed(1)}%`]]);
    if (page === 'done') return frames['export-done'];
    if (page === 'error') return substitute(frames['export-done'], [['automationcloseBtn', 'automationErrorOkBtn'], ['publish_pc_btn', 'automationErrorText'], ['automationopenFolderBtn', 'automationErrorIcon']]);
    throw new Error(page);
  };
  const advance = () => {
    if (page === 'exporting') {
      if (o.cancelAt != null && percent >= o.cancelAt) { go('editor'); return; }
      if (o.errorAt != null && percent >= o.errorAt) { page = 'error'; return; }
      if (o.stuck != null && percent >= o.stuck) return;
      percent = Math.min(100, percent + (o.step ?? 30));
      if (percent >= 97.5) finish();
    } else if (page === 'done' && !written && o.fileDelayReads && !o.noFile) {
      if (++doneReads >= o.fileDelayReads) write();
    }
  };
  const refuse = (code, message) => ({ ok: false, code, message, commandAttempted: false });
  const driver = {
    available: () => true,
    snapshot: async ({ scope = 'all' } = {}) => {
      if (!running) return { ok: false, code: 'NOT_RUNNING', trusted: true, runningInstances: 0, windows: [] };
      if (busy > 0) { busy--; return clone(frames['busy-opening']); }
      advance();
      const f = frame();
      return scope === 'sheet' ? sheetOnly(f) : clone(f);
    },
    click: async ({ x, y, double, expect }) => {
      log.push(`clic ${x},${y}${double ? ' double' : ''} ${expect}`);
      if (!running) return refuse('NOT_RUNNING', 'CapCut n’est pas ouvert.');
      if (page === 'home' && expect === 'HomePageDraft' && double) {
        if (missDouble > 0) { missDouble--; return { ok: true, commandAttempted: true }; }
        const f = home();
        const tiles = tileFrames(f), tile = tiles.find(t => inside({ x, y }, t));
        if (!tile) return { ok: true, commandAttempted: true };
        const title = titleFrames(f).find(t => inside({ x: t.frame.x + 5, y: t.frame.y + 5 }, tile));
        opened = title ? title.name : tile === tiles[0] ? (o.firstTile || name) : 'Autre projet';
        go('editor');
      } else if (page === 'editor' && expect === 'MainWindowTitleBarExportBtn') {
        if (missExport > 0) { missExport--; return { ok: true, commandAttempted: true }; }
        go('settings');
      }
      return { ok: true, commandAttempted: true };
    },
    press: async ({ label, expectName }) => {
      log.push(`press ${label}`);
      if (!['ExportOkBtn', 'automationcancel', 'automationcloseBtn'].includes(label)) return refuse('LABEL_REFUSED', `« ${label} » refusé.`);
      if (!running) return refuse('NOT_RUNNING', 'CapCut n’est pas ouvert.');
      if (label === 'ExportOkBtn') {
        if (page !== 'settings') return refuse('WRONG_VIEW', 'Pas de réglages d’export.');
        if (!targetMatches(target(), expectName)) return refuse('TARGET_MISMATCH', `CapCut s’apprête à exporter « ${path.basename(target())} ».`);
        if (missPress > 0) { missPress--; return { ok: true, commandAttempted: true, pressResult: 'success' }; }
        percent = 10; go('exporting');
        if (o.uncertainPress) return { ok: false, code: 'PRESS_UNCERTAIN', message: 'AXPress a répondu cannotComplete.', commandAttempted: true };
      } else if (label === 'automationcloseBtn') {
        if (page !== 'done') return refuse('WRONG_VIEW', 'Pas de panneau de fin.');
        go('editor');
      } else {
        if (page !== 'settings') return refuse('WRONG_VIEW', 'Pas de réglages d’export.');
        go('editor');
      }
      return { ok: true, commandAttempted: true, pressResult: 'success' };
    },
  };
  const actions = {
    accessibility: async () => o.access ?? true,
    isRunning: async () => running,
    assertClosed: () => { if (running) throw Object.assign(new Error('CapCut est ouvert.'), { code: 'CAPCUT_OPEN' }); },
    launch: async () => { log.push('launch'); running = true; opened = null; go('home'); },
    activate: async () => {},
    quit: async () => {
      if (!running) return;
      if ((o.quitRefusedWhile || ['settings', 'exporting', 'done', 'error']).includes(page)) { log.push('quit refusé'); return; }
      log.push('quit'); running = false;
    },
    forceQuit: async hard => {
      log.push(hard ? 'kill' : 'term');
      if (o.corrupt) fs.writeFileSync(o.corrupt, '{"coupé');
      if (!o.unkillable) { running = false; page = 'home'; }
    },
    duration: async () => { if (o.noProbe) return null; if (incomplete > 0) { incomplete--; return 0; } return o.probeSeconds ?? 276; },
  };
  return { log, actions, driver, state: () => ({ page, opened, percent, running, written }) };
}

export const FAST = { pollMs: 1, monitorMs: 1, launchSeconds: 2, openSeconds: 3, dialogSeconds: 2, startSeconds: 0.5, stableSeconds: 0.005,
  stallMinutes: 0.01, timeoutMinutes: 1, fileGraceSeconds: 0.2, quitSeconds: 1 };
