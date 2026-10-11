// CapCut pilot: exports projects with CapCut itself, one after another.
// Cycle per project (CapCut 9.3.0, recorded on 11 Oct 2026):
//   quit CapCut → project placed first on the home page → launch CapCut → home
//   → double-click the project's tile → editor → « Exporter » (title bar) → export settings
//   → the sheet announces the right project → AXPress on ExportOkBtn → progress view
//   → the announced MP4 appears, stable and readable by FFprobe → « Fermer » → quit.
// Every look at CapCut is a native snapshot (lib/capcut-native.js) classified by
// lib/capcut-screen.js; every step waits for the screen it expects, and stops with
// what CapCut really shows otherwise. Nothing is aimed by hand, nothing is calibrated.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { digest, readJson, transact, listBackups, atomicWrite } from './storage.js';
import { check } from './errors.js';
import { resolveMediaPath } from './render.js';
import { canonicalRoot, canonicalProject } from './projects.js';
import { requireClosed } from './engine.js';
import { readScreen, chooseTile, describeScreen, targetMatches, center } from './capcut-screen.js';

export const DEFAULT_PILOT = {
  version: 2,
  exportDir: null,     // folder chosen once in ELPO, so that macOS lets ELPO read CapCut's exports
  launchSeconds: 45,   // longest wait for CapCut's home page after launching it
  openSeconds: 30,     // longest wait for the editor after opening a project
  dialogSeconds: 15,   // longest wait for the export settings after the editor's « Exporter »
  startSeconds: 30,    // longest wait for CapCut's progress view after the final « Exporter »
  stableSeconds: 2,    // the exported file keeps its size this long before FFprobe reads it
  stallMinutes: 5,     // no progress and no file for this long: the export is declared stuck
  timeoutMinutes: 180, // longest export of one project
  fileGraceSeconds: 120, // after CapCut's end panel, longest wait for the file to appear
  quitSeconds: 25,
  pollMs: 500,         // between two reads while waiting for a page
  monitorMs: 1500,     // between two reads while CapCut encodes
};

// Errors after which the next project cannot be started safely: the lot stops and
// CapCut is left as it is, so that the user sees what went wrong.
export const STOP_LOT = ['CAPCUT_HOME', 'CAPCUT_TILE', 'PROJECT_NOT_OPEN', 'EXPORT_DIALOG', 'EXPORT_NOT_STARTED', 'EXPORT_DIR',
  'CAPCUT_UI', 'CAPCUT_STUCK', 'CAPCUT_UNCERTAIN', 'CAPCUT_STOPPED', 'EXPORT_STALLED', 'EXPORT_INTERRUPTED', 'EXPORT_FAILED',
  'EXPORT_TIMEOUT', 'EXPORT_FILE_MISSING', 'NATIVE_MISSING', 'ACCESSIBILITY'];

const cancelled = () => Object.assign(new Error('Pilotage arrêté.'), { code: 'CANCELLED' });
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const aborted = () => { clearTimeout(t); reject(cancelled()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
  if (signal?.aborted) aborted();
  else signal?.addEventListener('abort', aborted, { once: true });
});

// CapCut sorts "Projets" by last modification: bump only the timestamps, CapCut being closed.
export function bumpProject(root, project, now = Date.now(), { backupDir = path.join(root, '.elpo-pilot-backups'), guard = requireClosed } = {}) {
  root = canonicalRoot(root); project = canonicalProject(root, project);
  const metaFile = path.join(project, 'draft_meta_info.json'), indexFile = path.join(root, 'root_meta_info.json');
  check(path.dirname(project) === root && fs.existsSync(metaFile), 'PROJECT_PATH', 'Projet introuvable dans le dossier choisi.');
  const us = now * 1000;
  const meta = readJson(metaFile);
  const nextMeta = { ...meta.value, tm_draft_modified: us };
  let index = null, nextIndex = null;
  if (fs.existsSync(indexFile)) {
    index = readJson(indexFile);
    check(Array.isArray(index.value.all_draft_store), 'INDEX_FORMAT', 'Index global CapCut non reconnu.');
    nextIndex = structuredClone(index.value);
    const id = meta.value.draft_id;
    const hits = nextIndex.all_draft_store.filter(e => (typeof e.draft_fold_path === 'string' && path.resolve(e.draft_fold_path) === project) || (id && e.draft_id === id));
    check(hits.length === 1, 'INDEX_MATCH', 'Impossible d’identifier ce projet de manière unique dans l’index CapCut.');
    hits[0].tm_draft_modified = us;
  }
  // Re-check right before writing: nothing else may have touched the files.
  check(digest(fs.readFileSync(metaFile)) === meta.hash && (!index || digest(fs.readFileSync(indexFile)) === index.hash), 'PROJECT_CHANGED', 'Le projet a changé pendant la préparation.');
  check(!listBackups(backupDir, root).some(b => ['pending', 'recovery-required', 'restore-pending'].includes(b.status)), 'RECOVERY_PENDING', 'Récupère l’opération interrompue avant de lancer le pilotage.');
  const changes = [{ path: metaFile, expectedHash: meta.hash, bytes: Buffer.from(JSON.stringify(nextMeta)) }];
  if (index) changes.push({ path: indexFile, expectedHash: index.hash, bytes: Buffer.from(JSON.stringify(nextIndex)) });
  return transact({ root, project, backupDir, projectName: meta.value.draft_name || path.basename(project), changes, guard });
}

const VIDEO = /\.(mp4|mov|m4v)$/i;
// CapCut may export into the chosen folder or a sub-folder of it: look one level down.
export function listVideos(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && VIDEO.test(entry.name)) out.push(full);
    else if (entry.isDirectory()) { try { for (const n of fs.readdirSync(full)) if (!n.startsWith('.') && VIDEO.test(n)) out.push(path.join(full, n)); } catch { /* unreadable folder */ } }
  }
  return out;
}
// The exported files of `name` in `folder` (CapCut writes "<name>.mp4", or "<name>(1).mp4"
// when that file already exists), with what they looked like.
export function outputsOf(folder, name) {
  const found = new Map();
  let entries = [];
  try { entries = fs.readdirSync(folder); } catch { return found; }
  for (const entry of entries) {
    if (entry.startsWith('.') || !VIDEO.test(entry) || !targetMatches(entry, name)) continue;
    try { const st = fs.statSync(path.join(folder, entry)); if (st.isFile()) found.set(path.join(folder, entry), { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }); } catch { /* moved meanwhile */ }
  }
  return found;
}
// The file written by this export: the announced one or a sibling of the same
// project, new or changed since the click, not empty. Latest first.
export function exportedFile(folder, target, name, before, since) {
  const now = outputsOf(folder, name);
  try { const st = fs.statSync(target); if (st.isFile()) now.set(target, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }); } catch { /* not written yet */ }
  const fresh = [...now].filter(([file, st]) => {
    const prior = before.get(file);
    const changed = !prior || prior.size !== st.size || prior.mtimeMs !== st.mtimeMs || prior.ino !== st.ino;
    return changed && st.size > 0 && st.mtimeMs >= since - 2000;
  }).sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
  return fresh[0]?.[0] || null;
}
// CapCut 9 opens a "Relier des fichiers multimédia" sheet when imported media are missing:
// detect it before opening, from the project's media list.
export function missingMedia(project) {
  const meta = readJson(path.join(project, 'draft_meta_info.json')).value;
  const missing = [];
  for (const group of Array.isArray(meta.draft_materials) ? meta.draft_materials : []) for (const m of Array.isArray(group?.value) ? group.value : []) {
    const file = resolveMediaPath(m?.file_Path || m?.path, project);
    if (file && !fs.existsSync(file)) missing.push(path.basename(file));
  }
  return [...new Set(missing)];
}
// Duration of the timeline in seconds, from the project files, or null.
export function projectSeconds(project) {
  try { const us = Number(readJson(path.join(project, 'draft_meta_info.json')).value.tm_duration); return us > 0 ? us / 1e6 : null; } catch { return null; }
}
const readable = folder => { try { fs.readdirSync(folder); return true; } catch { return false; } };
const samePath = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };

export class CapcutPilot extends EventEmitter {
  constructor({ root, actions, driver, settings = {}, backupDir = path.join(root, '.elpo-pilot-backups') }) {
    super(); this.root = canonicalRoot(root); this.backupDir = backupDir; this.actions = actions; this.driver = driver;
    this.settings = { ...DEFAULT_PILOT, ...settings }; this.jobs = []; this.controller = null; this.log = [];
  }
  list() { return this.jobs.map(j => ({ ...j })); }
  note(text, job = null) {
    const line = { at: Date.now(), text, project: job?.name || null };
    this.log.push(line); this.log = this.log.slice(-300); this.emit('log', line);
  }
  changed() { this.emit('update', this.list()); }
  stop() { this.controller?.abort(); }
  // Pause (e.g. the user moved the mouse): the next CapCut action waits for resume(); stop() still cancels.
  pause(reason = 'Pilotage en pause.') {
    if (!this.controller || this.paused) return false;
    this.paused = true; this.note(reason); this.emit('paused', { paused: true, reason }); return true;
  }
  resume() {
    if (!this.paused) return false;
    this.paused = false; const release = this.release; this.release = null; release?.();
    this.note('Reprise du pilotage.'); this.emit('paused', { paused: false }); return true;
  }
  async gate(signal) {
    if (signal.aborted) throw cancelled();
    while (this.paused) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) { reject(cancelled()); return; }
        const aborted = () => { this.release = null; reject(cancelled()); };
        this.release = () => { signal.removeEventListener('abort', aborted); resolve(); };
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
    if (signal.aborted) throw cancelled();
  }
  async run(projects, { exportDir, test = false } = {}) {
    check(!this.controller, 'PILOT_BUSY', 'Un pilotage CapCut est déjà en cours.');
    // Reserved before the first await: a second run() started meanwhile is refused.
    const controller = new AbortController();
    this.controller = controller;
    try {
      check(this.driver?.available?.(), 'NATIVE_MISSING', 'L’outil natif capcut-ax est absent de l’application : réinstalle ElpoAiAutoCapcut depuis le DMG.');
      check(exportDir && fs.existsSync(exportDir), 'EXPORT_DIR', 'Indique le dossier où CapCut enregistre ses exports (Réglages → Pilotage de CapCut).');
      check(await this.actions.accessibility(), 'ACCESSIBILITY', 'Autorise ElpoAiAutoCapcut dans Réglages Système → Confidentialité et sécurité → Accessibilité.');
    } catch (error) { this.controller = null; throw error; }
    const signal = controller.signal;
    this.exportDir = exportDir;
    // Set once ELPO has launched CapCut itself: only then may it force CapCut to quit.
    // A CapCut the user had open before the run is only ever asked politely.
    this.launched = false;
    this.jobs = (test ? projects.slice(0, 1) : projects).map(p => ({ id: randomUUID(), project: p.path, name: p.name, status: 'queued', stage: 'En attente', progress: 0, output: null, error: null }));
    this.changed();
    try {
      for (const job of this.jobs) {
        if (signal.aborted) { job.status = 'cancelled'; job.stage = 'Annulé'; continue; }
        try { await this.exportOne(job, signal); }
        catch (e) {
          // The video was exported and verified: a problem while closing CapCut does not
          // turn it into a failure (exportOne already marked it done).
          if (!e.exported) {
            Object.assign(job, e.code === 'CANCELLED' ? { status: 'cancelled', stage: 'Annulé' } : { status: 'failed', stage: 'Échec', error: e.message });
            this.note(e.code === 'CANCELLED' ? 'Pilotage arrêté.' : `Échec : ${e.message}`, job);
          }
          if (STOP_LOT.includes(e.code)) {
            for (const pending of this.jobs.filter(j => j.status === 'queued')) Object.assign(pending, { status: 'cancelled', stage: 'Non lancé : pilotage interrompu' });
            this.changed(); break;
          }
          // Leave CapCut in a known state before the next project.
          if (!e.exported && e.code !== 'CANCELLED') { try { await this.quit(job, new AbortController().signal, { force: this.launched }); } catch { /* reported below if it persists */ } }
        }
        this.changed();
      }
    } finally {
      this.controller = null;
      if (this.paused) { this.paused = false; this.release = null; this.emit('paused', { paused: false }); }
      this.emit('idle', this.list());
    }
    return this.list();
  }
  step(job, stage, progress) { job.stage = stage; job.progress = progress; this.note(stage, job); this.changed(); }

  // ---- Looking at CapCut ---------------------------------------------------------
  async look(scope = 'all') {
    let snapshot;
    try { snapshot = await this.driver.snapshot({ scope }); }
    catch (e) { throw Object.assign(new Error(`Lecture native de CapCut impossible : ${e.message}`), { code: e.code === 'NATIVE_MISSING' ? 'NATIVE_MISSING' : 'CAPCUT_UI', cause: e }); }
    return readScreen(snapshot);
  }
  // Waits for one of `wanted`. A partial read or a busy CapCut proves nothing: it is
  // read again. An unexpected dialog seen on three complete reads stops the wait.
  async waitFor(wanted, seconds, signal, { code, message, scope = 'all', reliable = false } = {}) {
    const end = Date.now() + Math.max(0, seconds) * 1000;
    let last = null, strange = 0;
    for (;;) {
      await this.gate(signal);
      const screen = await this.look(scope);
      last = screen;
      if (wanted.includes(screen.screen) && (!reliable || screen.reliable)) return screen;
      if (screen.screen === 'not-running') throw Object.assign(new Error('CapCut s’est fermé pendant le pilotage.'), { code: 'CAPCUT_STOPPED' });
      if (screen.screen === 'no-access') throw Object.assign(new Error('macOS refuse l’accès : autorise ElpoAiAutoCapcut dans Accessibilité.'), { code: 'ACCESSIBILITY' });
      strange = screen.screen === 'sheet' && screen.reliable ? strange + 1 : 0;
      if (strange >= 3 || Date.now() >= end) break;
      await wait(this.settings.pollMs, signal);
    }
    check(false, code, `${message} CapCut affiche : ${describeScreen(last)}.`);
  }
  // Two reads of the home page that agree, so that a tile still moving after the launch
  // is never clicked at its former place.
  async settledHome(job, signal, seconds = this.settings.launchSeconds) {
    let previous = null, end = 0;
    for (;;) {
      const home = await this.waitFor(['home'], seconds, signal, { code: 'CAPCUT_HOME', message: 'L’accueil de CapCut n’est pas apparu.', reliable: true });
      const pick = chooseTile(home, job.name, { allowFirst: true });
      if (previous) {
        const same = pick.point && previous.point ? Math.abs(pick.point.x - previous.point.x) <= 2 && Math.abs(pick.point.y - previous.point.y) <= 2 : !pick.point && !previous.point;
        if (same || Date.now() >= end) return pick;
      } else end = Date.now() + 10000;
      previous = pick;
      await wait(Math.max(this.settings.pollMs, 400), signal);
    }
  }
  // Double-click on the project's tile, then the editor. When a complete read still
  // shows the home page well after the double-click, it was not received: the tile is
  // read again and double-clicked once more. Never while CapCut may be opening it.
  async openProject(job, signal) {
    const s = this.settings;
    let pick = await this.settledHome(job, signal);
    for (let attempt = 1; ; attempt++) {
      check(pick.point, 'CAPCUT_TILE', pick.reason);
      if (attempt === 1) this.note(pick.method === 'title' ? `Vignette « ${job.name} » reconnue par son nom` : 'Noms des vignettes non exposés par CapCut : première vignette (projet placé en tête), identité vérifiée sur la feuille d’export', job);
      await this.gate(signal);
      await this.act(() => this.driver.click({ ...pick.point, double: true, expect: 'HomePageDraft' }), 'CAPCUT_TILE');
      // A large project can keep the home page on screen while it loads: the second
      // double-click waits long enough not to land on a project being opened.
      const end = Date.now() + s.openSeconds * 1000, retryAt = Date.now() + Math.min(12000, s.openSeconds * 400);
      let homeSince = 0;
      for (;;) {
        await wait(s.pollMs, signal);
        const screen = await this.look('all');
        if (screen.screen === 'editor' && screen.reliable) return screen;
        if (screen.screen === 'not-running') throw Object.assign(new Error('CapCut s’est fermé pendant l’ouverture du projet.'), { code: 'CAPCUT_STOPPED' });
        homeSince = screen.screen === 'home' && screen.reliable ? homeSince || Date.now() : 0;
        if (attempt === 1 && homeSince && Date.now() >= retryAt && Date.now() - homeSince >= 1500) {
          this.note('L’accueil est toujours affiché : double-clic non reçu, nouvel essai unique sur la vignette relue.', job);
          pick = await this.settledHome(job, signal, 5);
          break;
        }
        check(Date.now() < end, 'PROJECT_NOT_OPEN', `Le projet « ${job.name} » ne s’est pas ouvert dans l’éditeur. Aucun export envoyé. CapCut affiche : ${describeScreen(screen)}.`);
      }
    }
  }
  // The editor's « Exporter » (a text in CapCut's title bar, without AXPress): one
  // click, and a second one only if the editor still shows no sheet well after it.
  async openExportSettings(job, signal, editor) {
    const s = this.settings;
    for (let attempt = 1; ; attempt++) {
      check(editor.exportButton, 'EXPORT_DIALOG', 'Le bouton « Exporter » de l’éditeur CapCut n’est pas exposé. Aucun export envoyé.');
      await this.gate(signal);
      await this.act(() => this.driver.click({ ...center(editor.exportButton), expect: 'MainWindowTitleBarExportBtn' }), 'EXPORT_DIALOG');
      const end = Date.now() + s.dialogSeconds * 1000, retryAt = Date.now() + Math.min(6000, s.dialogSeconds * 400);
      for (;;) {
        await wait(s.pollMs, signal);
        const screen = await this.look('sheet');
        if (screen.screen === 'export-settings' && screen.reliable) return screen;
        if (screen.screen === 'not-running') throw Object.assign(new Error('CapCut s’est fermé à l’ouverture des réglages d’export.'), { code: 'CAPCUT_STOPPED' });
        if (attempt === 1 && screen.screen === 'no-sheet' && screen.reliable && Date.now() >= retryAt) {
          const again = await this.look('all');
          if (again.screen === 'editor' && again.reliable) {
            this.note('Aucune feuille d’export après le clic : nouvel essai unique sur « Exporter ».', job);
            editor = again;
            break;
          }
        }
        check(Date.now() < end, 'EXPORT_DIALOG', `Les réglages d’export de CapCut ne sont pas apparus. Aucun export envoyé. CapCut affiche : ${describeScreen(screen)}.`);
      }
    }
  }
  // One native command. A refusal means nothing was sent; a failure after something
  // was sent leaves CapCut in an uncertain state, which stops the lot. A click refused
  // because CapCut was not in front (or busy answering) is tried once more after
  // bringing CapCut to the front.
  async act(command, code) {
    const run = () => command().catch(e => { throw Object.assign(new Error(e.message), { code: e.code === 'NATIVE_MISSING' ? 'NATIVE_MISSING' : 'CAPCUT_UI' }); });
    let result = await run();
    if (!result?.ok && !result?.commandAttempted && ['NOT_FRONTMOST', 'HIT_TEST_FAILED', 'HIT_OTHER_APP'].includes(result?.code)) {
      this.note(`${result.message} Nouvel essai après avoir remis CapCut au premier plan.`);
      try { await this.actions.activate?.(); } catch { /* the helper checks the front app itself */ }
      await wait(600);
      result = await run();
    }
    if (result?.ok) return result;
    const attempted = !!result?.commandAttempted;
    throw Object.assign(new Error(result?.message || 'Réponse inattendue de l’outil natif.'), { code: attempted ? 'CAPCUT_UNCERTAIN' : code, native: result?.code || null });
  }

  // ---- Closing CapCut --------------------------------------------------------------
  async waitClosed(seconds, signal) {
    const end = Date.now() + Math.max(0, seconds) * 1000;
    for (;;) {
      if (!(await this.actions.isRunning())) return true;
      if (Date.now() >= end) return false;
      await wait(Math.min(500, this.settings.pollMs * 4), signal);
    }
  }
  // A polite quit first. CapCut refuses to quit while a sheet is open (its end-of-export
  // panel, or the export settings): when ELPO launched CapCut itself (`force`), it closes
  // that sheet by its own button, asks again, and as a last resort terminates CapCut,
  // protecting the project files (forceClose).
  async quit(job, signal, { force = false } = {}) {
    if (!(await this.actions.isRunning())) return;
    const grace = Math.min(10, this.settings.quitSeconds);
    this.note('Fermeture de CapCut', job);
    await this.actions.quit();
    if (await this.waitClosed(force ? grace : this.settings.quitSeconds, signal)) return;
    if (force) {
      this.note('CapCut refuse de se fermer : une fenêtre le retient. ELPO la ferme puis redemande.', job);
      await this.dismiss(job);
      await this.actions.quit();
      if (await this.waitClosed(grace, signal)) return;
      if (this.actions.forceQuit) { await this.forceClose(job, signal); return; }
    }
    throw Object.assign(new Error('CapCut ne s’est pas fermé. Une fenêtre attend peut-être une réponse : ferme-la puis relance le lot.'), { code: 'CAPCUT_STUCK' });
  }
  // Closes the export sheet by its own button: « Fermer » at the end of an export,
  // « Annuler » of the settings (no export running then). Never the progress view.
  async dismiss(job) {
    let screen = null;
    try { screen = await this.look('sheet'); } catch (e) { this.note(`Feuille CapCut illisible à la fermeture (${e.message}) : fermeture forcée si nécessaire`, job); return; }
    // An export still encoding is never cut short by a forced quit.
    if (screen.screen === 'exporting') throw Object.assign(new Error('CapCut exporte encore : il n’est pas fermé. Attends la fin de l’export ou arrête-le dans CapCut.'), { code: 'CAPCUT_STUCK' });
    try {
      this.note(`À la fermeture, CapCut affiche : ${describeScreen(screen)}`, job);
      const label = screen.screen === 'export-done' ? 'automationcloseBtn' : screen.screen === 'export-settings' ? 'automationcancel' : null;
      if (label) { const r = await this.driver.press({ label, ...(label === 'automationcloseBtn' ? { mouse: true } : {}) }); if (!r?.ok) this.note(`Fermeture de la feuille refusée : ${r?.message}`, job); }
    } catch (e) { this.note(`Feuille CapCut illisible à la fermeture (${e.message}) : fermeture forcée si nécessaire`, job); }
  }
  // Terminating CapCut must not cost the project. CapCut's draft files are copied once
  // CapCut has stopped writing them; after it is gone, any file left unreadable is put
  // back from that copy. Files CapCut wrote correctly are left as they are.
  async forceClose(job, signal) {
    const project = job?.project;
    const files = [
      ...(project ? ['draft_info.json', 'draft_content.json', 'draft_meta_info.json'].map(n => path.join(project, n)) : []),
      path.join(this.root, 'root_meta_info.json'),
    ].filter(f => fs.existsSync(f));
    const stamp = () => files.map(f => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; } }).join('|');
    const quietMs = Math.min(2000, this.settings.quitSeconds * 1000), end = Date.now() + 10000;
    let last = stamp(), quietSince = Date.now();
    while (Date.now() - quietSince < quietMs && Date.now() < end) {
      await wait(250, signal);
      const now = stamp(); if (now !== last) { last = now; quietSince = Date.now(); }
    }
    const saved = new Map();
    for (const f of files) {
      try { const bytes = fs.readFileSync(f); JSON.parse(bytes.toString('utf8')); saved.set(f, { bytes, mode: fs.statSync(f).mode & 0o777 }); } catch { /* not a valid copy to keep */ }
    }
    this.note('Fermeture forcée de CapCut : les fichiers du projet sont protégés', job);
    const grace = Math.min(5, this.settings.quitSeconds);
    await this.actions.forceQuit(false);
    if (!(await this.waitClosed(grace, signal))) { await this.actions.forceQuit(true); }
    if (!(await this.waitClosed(grace, signal))) throw Object.assign(new Error('CapCut ne répond plus et n’a pas pu être fermé, même de force. Quitte-le (⌥⌘Échap) puis relance le lot.'), { code: 'CAPCUT_STUCK' });
    for (const [f, { bytes, mode }] of saved) {
      let fine = false;
      try { JSON.parse(fs.readFileSync(f, 'utf8')); fine = true; } catch { /* missing or cut short */ }
      if (!fine) { atomicWrite(f, bytes, mode); this.note(`${path.basename(f)} rétabli après la fermeture forcée`, job); }
    }
  }

  // ---- One project -------------------------------------------------------------------
  async exportOne(job, signal) {
    const s = this.settings;
    job.status = 'running';
    this.step(job, 'Fermeture de CapCut', 0.03); await this.quit(job, signal, { force: this.launched });
    const missing = missingMedia(job.project);
    check(!missing.length, 'MEDIA_MISSING', `${missing.length} média(s) introuvable(s) (${missing.slice(0, 3).join(', ')}) : relie-les dans CapCut, puis relance ce projet.`);
    this.step(job, 'Projet placé en tête de l’accueil CapCut', 0.06);
    bumpProject(this.root, job.project, Date.now(), { backupDir: this.backupDir, guard: this.actions.assertClosed || (() => {}) });
    await this.gate(signal);

    this.step(job, 'Lancement de CapCut', 0.1);
    await this.actions.launch(); this.launched = true;
    this.step(job, 'Ouverture du projet', 0.14);
    const editor = await this.openProject(job, signal);
    const expected = editor.durationSeconds ?? projectSeconds(job.project);
    if (expected) this.note(`Durée de la timeline : ${expected.toFixed(1)} s`, job);

    this.step(job, 'Ouverture des réglages d’export', 0.2);
    const sheet = await this.openExportSettings(job, signal, editor);

    // The sheet announces the exact file: it confirms the project (CapCut's editor
    // window does not show its name) and the folder actually written to.
    check(sheet.target, 'PROJECT_NOT_OPEN', `Le chemin de sortie de la feuille d’export est illisible (${sheet.targets.length} lu(s)) : le projet ne peut pas être confirmé. Aucun export envoyé.`);
    check(targetMatches(sheet.target, job.name), 'PROJECT_NOT_OPEN', `CapCut s’apprête à exporter « ${path.basename(sheet.target)} » au lieu de « ${job.name} ». Aucun export envoyé.`);
    const folder = path.dirname(sheet.target);
    check(readable(folder), 'EXPORT_DIR', `ELPO ne peut pas lire « ${folder} », où CapCut va écrire la vidéo : choisis ce dossier dans Réglages → Dossier d’export de CapCut. Aucun export envoyé.`);
    if (this.exportDir && !samePath(folder, this.exportDir)) this.note(`CapCut exporte dans « ${folder} » (et non « ${this.exportDir} ») : ce dossier est surveillé`, job);
    const before = outputsOf(folder, job.name);
    this.note(`Fichier annoncé par CapCut : ${sheet.target}`, job);

    await this.gate(signal);
    this.step(job, 'Lancement de l’export', 0.26);
    const since = Date.now();
    await this.pressExport(job);
    await this.confirmStart(job, signal, { folder, target: sheet.target, before, since });

    const file = await this.follow(job, signal, { folder, target: sheet.target, before, since, expected });
    job.output = file;
    this.note(`Fichier exporté et vérifié : ${path.basename(file)}`, job);
    // From here the video exists: whatever happens while closing CapCut, the job is done.
    try {
      this.step(job, 'Fermeture du panneau de fin d’export', 0.95);
      await this.closeDonePanel(job, signal);
      this.step(job, 'Fermeture de CapCut', 0.97); await this.quit(job, signal, { force: true });
    } catch (e) {
      const stopped = e.code === 'CANCELLED';
      Object.assign(job, { status: 'done', progress: 1, error: null, warning: stopped ? null : e.message,
        stage: stopped ? 'Exporté · pilotage arrêté avant la fermeture de CapCut' : 'Exporté · CapCut n’a pas pu être fermé' });
      this.note(stopped ? `Exporté : ${path.basename(file)} (pilotage arrêté avant la fermeture de CapCut)` : `Exporté : ${path.basename(file)}, mais ${e.message}`, job);
      this.changed();
      throw Object.assign(e, { exported: true });
    }
    Object.assign(job, { status: 'done', stage: 'Terminé', progress: 1 }); this.note(`Exporté : ${path.basename(file)}`, job);
  }

  // Native mouse command on the final Exporter: AXPress reports success without
  // effect on the real Mac. A refusal sends nothing; uncertainty only starts observation.
  async pressExport(job) {
    let result;
    try { result = await this.driver.press({ label: 'ExportOkBtn', expectName: job.name, mouse: true }); }
    catch (e) { throw Object.assign(new Error(e.message), { code: e.code === 'NATIVE_MISSING' ? 'NATIVE_MISSING' : 'CAPCUT_UI' }); }
    if (result?.ok) { this.note('Clic souris unique sur « Exporter » natif : démarrage à confirmer', job); return; }
    if (result?.commandAttempted) { this.note(`Commande envoyée, réponse incertaine (${result.message}) : vérification de son effet, sans nouvel envoi`, job); return; }
    const identity = ['TARGET_MISMATCH', 'TARGET_UNREADABLE', 'NAME_REQUIRED'].includes(result?.code);
    throw Object.assign(new Error(`${result?.message || 'Réponse inattendue de l’outil natif.'}`), { code: identity ? 'PROJECT_NOT_OPEN' : 'EXPORT_NOT_STARTED', native: result?.code || null });
  }

  // CapCut accepted the export when its sheet switches to the progress view (or to the
  // end panel for a very short video), or when the file appears. If the settings view
  // is still there, stop after the deadline. Never resend a final export command:
  // neither an API response nor unchanged settings proves that it was not received.
  async confirmStart(job, signal, { folder, target, before, since }) {
    const end = Date.now() + Math.max(1, this.settings.startSeconds) * 1000;
    let last = null;
    for (;;) {
      await wait(this.settings.pollMs, signal);
      if (exportedFile(folder, target, job.name, before, since)) return;
      let screen = null;
      try { screen = await this.look('sheet'); } catch (e) { if (e.code === 'NATIVE_MISSING') throw e; }
      last = screen || last;
      if (screen && ['exporting', 'export-done'].includes(screen.screen)) {
        this.note(screen.screen === 'exporting' ? `Export démarré dans CapCut${screen.percent != null ? ` (${screen.percent} %)` : ''}` : 'CapCut affiche déjà la fin de l’export', job);
        return;
      }
      if (screen?.screen === 'not-running') throw Object.assign(new Error('CapCut s’est fermé juste après « Exporter ».'), { code: 'CAPCUT_STOPPED' });
      if (Date.now() >= end) break;
    }
    check(false, 'EXPORT_NOT_STARTED', `CapCut n’a pas commencé l’export après ${this.settings.startSeconds} s. CapCut affiche : ${describeScreen(last)}.`);
  }

  // Following the export until the file is final. CapCut's percentage (ExportProgress)
  // only feeds the display and the stall detection: the end is the announced MP4,
  // present, unchanged for a moment and readable by FFprobe with the project's duration.
  // Without FFprobe, CapCut's own end panel plus a stable file decide.
  async follow(job, signal, { folder, target, before, since, expected }) {
    const s = this.settings;
    const deadline = since + s.timeoutMinutes * 60000;
    let lastChange = Date.now(), percent = null, doneAt = 0, file = null, size = -1, stableSince = 0, strange = 0, gone = 0, readFailures = 0, warned = false;
    const noSheet = screen => screen?.reliable && ['no-sheet', 'editor', 'home'].includes(screen.screen);
    const show = (stage, progress) => { job.stage = stage; if (progress != null) job.progress = progress; this.changed(); };
    for (;;) {
      check(Date.now() < deadline, 'EXPORT_TIMEOUT', `Export plus long que ${s.timeoutMinutes} min : arrêt de la surveillance. CapCut continue peut-être.`);
      await wait(s.monitorMs, signal);
      let screen = null;
      try { screen = await this.look('sheet'); readFailures = 0; }
      catch (e) { if (e.code === 'NATIVE_MISSING') throw e; if (++readFailures === 1) this.note(`Lecture de CapCut impossible pendant l’encodage (${e.message}) : surveillance du fichier`, job); }
      if (screen?.screen === 'exporting' && screen.percent != null && screen.percent !== percent) {
        percent = screen.percent; lastChange = Date.now();
        show(`Export CapCut · ${Math.round(percent)} %`, 0.28 + 0.62 * percent / 100);
      }
      if (screen?.screen === 'export-done' && !doneAt) { doneAt = Date.now(); this.note('CapCut affiche la fin de l’export', job); show('CapCut a terminé · vérification du fichier', 0.92); }
      if (screen?.screen === 'not-running') throw Object.assign(new Error('CapCut s’est fermé pendant l’export.'), { code: 'CAPCUT_STOPPED' });
      strange = screen?.screen === 'sheet' && screen.reliable ? strange + 1 : 0;
      check(strange < 3, 'EXPORT_FAILED', `CapCut affiche une fenêtre inattendue pendant l’export : ${describeScreen(screen)}.`);
      // The sheet gone without the end panel and without file: the export was cancelled.
      gone = !doneAt && !file && noSheet(screen) ? gone + 1 : 0;
      check(gone < 3, 'EXPORT_INTERRUPTED', 'La feuille d’export de CapCut s’est fermée sans fin d’export ni fichier : export annulé ou interrompu dans CapCut.');

      const found = exportedFile(folder, target, job.name, before, since);
      if (found && found !== file) { file = found; this.note(`Fichier d’export apparu : ${found}`, job); }
      if (file) {
        let now = -1;
        try { now = fs.statSync(file).size; } catch { file = null; continue; }
        if (now !== size) { size = now; stableSince = Date.now(); lastChange = Date.now(); if (percent == null && !doneAt) show(`Export en cours · ${(now / 1e6).toFixed(1)} Mo`, 0.6); }
        if (size > 0 && (Date.now() - stableSince >= s.stableSeconds * 1000)) {
          const seconds = this.actions.duration ? await this.actions.duration(file) : null;
          const late = doneAt && Date.now() - doneAt > s.fileGraceSeconds * 1000;
          if (seconds === null) { if (doneAt) return file; }
          else if (seconds > 0 && (!expected || seconds >= expected - Math.max(2, expected * 0.03))) return file;
          // CapCut says it is over and the file no longer changes: a readable video of
          // another length is delivered with a note; an unreadable one is an error.
          else if (seconds > 0 && late) { this.note(`Durée exportée ${seconds.toFixed(1)} s pour une timeline de ${expected.toFixed(1)} s : vérifie la plage d’export dans CapCut`, job); return file; }
          else if (late) check(false, 'EXPORT_FAILED', `CapCut a terminé, mais FFprobe ne lit pas « ${path.basename(file)} » : fichier incomplet ou corrompu.`);
          else if (!warned) { warned = true; this.note(`Fichier pas encore complet pour FFprobe (${seconds ? `${seconds.toFixed(1)} s` : 'durée illisible'}${expected ? `, attendu ${expected.toFixed(1)} s` : ''}) : attente`, job); }
        }
      }
      check(!(doneAt && !file && Date.now() - doneAt > s.fileGraceSeconds * 1000), 'EXPORT_FILE_MISSING', `CapCut a terminé l’export mais aucun fichier n’est apparu à « ${target} ».`);
      // Stuck only when CapCut can be read and shows no progress: an unreadable CapCut is
      // left to the overall time limit.
      check(doneAt || readFailures > 0 || Date.now() - lastChange < s.stallMinutes * 60000, 'EXPORT_STALLED', `Aucune progression ni écriture depuis ${s.stallMinutes} min${percent != null ? ` (bloqué à ${percent} %)` : ''}. CapCut est laissé tel quel.`);
    }
  }

  // « Fermer » of the end panel: CapCut cannot quit while it is open.
  async closeDonePanel(job, signal) {
    const confirmEditor = async () => {
      await this.waitFor(['editor'], 15, signal, { code: 'CAPCUT_STUCK', message: 'Le panneau de fin d’export ne s’est pas fermé avec retour à l’éditeur.', scope: 'all', reliable: true });
      this.note('Éditeur CapCut confirmé après fermeture du panneau final', job);
    };
    let screen = await this.look('sheet').catch(() => null);
    const end = Date.now() + 30000;
    while (screen?.screen !== 'export-done' && Date.now() < end) {
      if (screen?.reliable && ['no-sheet', 'editor', 'home'].includes(screen.screen)) { await confirmEditor(); return; }
      await wait(this.settings.pollMs, signal);
      screen = await this.look('sheet').catch(() => null);
    }
    if (screen?.screen !== 'export-done') { this.note(`Panneau de fin d’export introuvable : ${describeScreen(screen)}`, job); return; }
    const result = await this.driver.press({ label: 'automationcloseBtn', mouse: true });
    this.note(result?.ok ? 'Clic souris natif sur « Fermer » : retour à l’éditeur à confirmer' : `« Fermer » : ${result?.message}`, job);
    if (result?.ok || result?.commandAttempted) await confirmEditor().catch(e => { if (e.code === 'CANCELLED') throw e; this.note(e.message, job); });
  }
}
