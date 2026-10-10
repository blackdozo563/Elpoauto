// CapCut pilot: exports projects with CapCut itself, one after another.
// Cycle per project: quit CapCut → put the project first in "Projects" → launch CapCut →
// open the first tile → export → wait for a complete file → close the dialog → quit.
// Every UI action goes through `actions`, so the sequence is testable without a Mac.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { digest, readJson, transact, listBackups, atomicWrite } from './storage.js';
import { check } from './errors.js';
import { resolveMediaPath } from './render.js';
import { canonicalRoot, canonicalProject } from './projects.js';
import { requireClosed } from './engine.js';
import { controlPoint, homeIsOpen, editorIsOpen, projectIsOpen, exportDialogIsOpen, exportIsRunning, uiSummary, uiIdentifiers, validFrame, exportTarget, targetMatches, exportOkPoint, exportOpenPoint, draftTiles, placedDrafts, pointOnDraft, draftTileFor, draftTitles, closePoint, exportTracker, exportSettingsShown, finishedClosePoint } from './capcut-ui.js';

export const DEFAULT_PILOT = {
  tile: null,            // {x, y} screen point of the first project tile on CapCut's home
  home: null,            // fallback when CapCut does not expose the Home control
  frames: {},           // window geometry recorded when aiming each target
  exportButton: null,    // {x, y} of "Export" in CapCut's export window; null = press Return
  openWith: 'double',    // 'double' click or 'single' click on the tile
  // dialogSeconds must cover CapCut building its export sheet AND one interface read:
  // a read of a real editor takes seconds, so a 3 s budget allowed exactly one
  // (partial) attempt and failed on it.
  launchSeconds: 12, openSeconds: 8, dialogSeconds: 10, stableSeconds: 4, startSeconds: 90, timeoutMinutes: 60, quitSeconds: 25,
  closeKeys: ['escape'], // keys pressed when the export is complete (closes "Export finished")
  missing: 'skip',       // media missing: 'skip' the project, or 'continue' (dismiss the relink sheet)
};

// Automation identifiers of CapCut 9's export sheet: the probe read stops as soon as
// one of them is seen, so waiting for the sheet costs about a second per attempt.
export const EXPORT_SHEET_IDS = ['exportdialog', 'exportokbtn', 'exportfilenameinput', 'exportpathinput'];
// Last-resort read: wider node budget and longer deadline, used only when the probe
// found no sheet identifier at all.
export const DEEP_READ = { deadlineMs: 25000, maxNodes: 1500, branchNodes: 200 };
// A read that ran out of time, or saw no window at all, proves nothing about what is
// NOT on screen: "the sheet is gone" may only be concluded from a read that completed.
const conclusive = ui => !!ui && !ui.timedOut && Array.isArray(ui.windows) && ui.windows.length > 0;
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const aborted = () => { clearTimeout(t); reject(Object.assign(new Error('Pilotage arrêté.'), { code: 'CANCELLED' })); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
  if (signal?.aborted) aborted();
  else signal?.addEventListener('abort', aborted, { once: true });
});

// CapCut sorts "Projects" by last modification: bump only the timestamps, CapCut being closed.
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
// CapCut 9 encodes into a hidden folder of the export directory
// (".__capcut_export_temp_folder_<n>__/<uuid>.mp4", recorded on a real export) and only
// moves the finished file to "<project>.mp4" at the end. Returns the size in bytes of the
// file being encoded there since `since`, or 0.
const ENCODING_DIR = /^\.__capcut_export_temp_folder_\d+__$/;
export function encodingBytes(dir, since) {
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ENCODING_DIR.test(entry.name)) continue;
      const folder = path.join(dir, entry.name);
      for (const name of fs.readdirSync(folder)) {
        if (!VIDEO.test(name)) continue;
        try { const st = fs.statSync(path.join(folder, name)); if (st.mtimeMs >= since - 2000) bytes = Math.max(bytes, st.size); } catch { /* moved meanwhile */ }
      }
    }
  } catch { /* unreadable export folder */ }
  return bytes;
}
export function newExports(dir, since, known) {
  return listVideos(dir).filter(f => {
    try {
      const stat = fs.statSync(f), before = known.get?.(f);
      const changed = !known.has(f) || (before && ['size', 'mtimeMs', 'ctimeMs', 'ino'].some(k => before[k] !== stat[k]));
      return changed && stat.mtimeMs >= since - 2000;
    } catch { return false; }
  });
}
// Wider search, used once CapCut says the export is over: any video written since
// `since`, up to three folders down, CapCut's hidden encoding folders excepted.
export function recentVideos(dir, since, depth = 3) {
  const out = [];
  const walk = (d, level) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isFile() && VIDEO.test(e.name)) { try { const st = fs.statSync(full); if (st.mtimeMs >= since - 2000) out.push({ full, at: st.mtimeMs }); } catch { /* moved meanwhile */ } }
      else if (e.isDirectory() && level < depth) walk(full, level + 1);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.at - a.at).map(v => v.full);
}
export function snapshotExports(dir) {
  return new Map(listVideos(dir).flatMap(f => { try { return [[f, fs.statSync(f)]]; } catch { return []; } }));
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

export class CapcutPilot extends EventEmitter {
  constructor({ root, actions, settings = {}, backupDir = path.join(root, '.elpo-pilot-backups') }) {
    super(); this.root = canonicalRoot(root); this.backupDir = backupDir; this.actions = actions; this.settings = { ...DEFAULT_PILOT, ...settings }; this.jobs = []; this.controller = null; this.log = [];
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
    check(!signal.aborted, 'CANCELLED', 'Pilotage arrêté.');
    while (this.paused) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) { reject(Object.assign(new Error('Pilotage arrêté.'), { code: 'CANCELLED' })); return; }
        const aborted = () => { this.release = null; reject(Object.assign(new Error('Pilotage arrêté.'), { code: 'CANCELLED' })); };
        this.release = () => { signal.removeEventListener('abort', aborted); resolve(); };
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
    check(!signal.aborted, 'CANCELLED', 'Pilotage arrêté.');
  }
  async run(projects, { exportDir, test = false } = {}) {
    check(!this.controller, 'PILOT_BUSY', 'Un pilotage CapCut est déjà en cours.');
    // Reserved before the first await: a second run() started meanwhile is refused.
    const controller = new AbortController();
    this.controller = controller;
    try {
      check(this.settings.tile, 'PILOT_CALIBRATION', 'Vise d’abord la première vignette de projet de l’accueil CapCut (Réglages, bouton « Viser »).');
      check(exportDir && fs.existsSync(exportDir), 'EXPORT_DIR', 'Indique le dossier où CapCut enregistre ses exports.');
      check(await this.actions.accessibility(), 'ACCESSIBILITY', 'Autorise ElpoAiAutoCapcut dans Réglages Système → Confidentialité et sécurité → Accessibilité.');
    } catch (error) { this.controller = null; throw error; }
    const signal = controller.signal;
    // Set once ELPO has launched CapCut itself: only then may it force CapCut to quit.
    // A CapCut the user had open before the run is only ever asked politely.
    this.launched = false;
    this.jobs = (test ? projects.slice(0, 1) : projects).map(p => ({ id: randomUUID(), project: p.path, name: p.name, status: 'queued', stage: 'En attente', progress: 0, output: null, error: null }));
    this.changed();
    try {
      for (const job of this.jobs) {
        if (signal.aborted) { job.status = 'cancelled'; job.stage = 'Annulé'; continue; }
        try { await this.exportOne(job, exportDir, signal); }
        catch (e) {
          // The video was exported and verified: a problem while closing CapCut does not
          // turn it into a failure (exportOne already marked it done).
          if (!e.exported) {
            Object.assign(job, e.code === 'CANCELLED' ? { status: 'cancelled', stage: 'Annulé' } : { status: 'failed', stage: 'Échec', error: e.message });
            this.note(`Échec : ${e.message}`, job);
          }
          // CAPCUT_STUCK: CapCut cannot be closed, so the next project could not be
          // opened either; stop instead of failing every remaining project the same way.
          if (['CAPCUT_HOME', 'CAPCUT_TILE', 'CAPCUT_WINDOW', 'PROJECT_NOT_OPEN', 'EXPORT_DIALOG', 'EXPORT_NOT_STARTED', 'CAPCUT_UI', 'CAPCUT_STUCK'].includes(e.code)) {
            // Preserve the visible problem for the user; do not quit or start
            // another project when the current UI could not be identified.
            for (const pending of this.jobs.filter(j => j.status === 'queued')) Object.assign(pending, { status: 'cancelled', stage: 'Non lancé : pilotage interrompu' });
            this.changed(); break;
          }
          // Leave CapCut in a known state before the next project.
          if (!e.exported) { try { await this.quit(job, new AbortController().signal, { force: this.launched }); } catch { /* reported below if it persists */ } }
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
  async readUi(options = null) {
    try { return await this.actions.readUi(options || undefined); }
    catch (e) {
      const hint = e.code === 'MAC_TIMEOUT'
        ? 'La lecture de l’interface a dépassé le délai : CapCut ou System Events ne répond pas assez vite. Aucun clic ni raccourci supplémentaire envoyé.'
        : e.code === 'MAC_PERMISSION'
          ? 'macOS a refusé l’accès. Vérifie les autorisations Accessibilité et Automatisation pour ELPO.'
          : 'La lecture a échoué ; les autorisations ne sont pas nécessairement en cause.';
      throw Object.assign(new Error(`Interface CapCut illisible : ${e.message}. ${hint}`), { code: 'CAPCUT_UI', cause: e });
    }
  }
  async verifyUi(predicate, seconds, signal, code, message, readOptions = null, maxAttempts = Infinity) {
    // Legacy injected adapters are retained for headless sequence tests. The
    // production macOS adapter always supplies readUi and enforces these checks.
    if (!this.actions.readUi) return;
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    const limit = Math.max(1, maxAttempts);
    let ui, attempts = 0;
    do {
      await this.gate(signal);
      ui = await this.readUi(readOptions);
      attempts++;
      if (predicate(ui)) return ui;
      if (attempts >= limit) break;
      // An incomplete read (macOS ran out of time or of node budget) proves nothing:
      // never fail on a single partial snapshot, read again. Two full attempts are
      // always made, whatever the budget, because one read can outlast it.
      const partial = !!(ui?.timedOut || ui?.truncated);
      if (Date.now() >= deadline && (attempts >= 2 || !partial)) break;
      await wait(500, signal);
    } while (true);
    check(false, code, `${message} Fenêtre détectée : ${uiSummary(ui)} Contrôles lus : ${uiIdentifiers(ui).join(', ') || 'aucun'}.`);
  }
  // Confirmation of CapCut's export settings, as a ladder of reads:
  // 1. probe — stops at the first sheet identifier, so waiting costs about a second;
  // 2. deep read — wider node budget and longer deadline, for a build whose sheet sits
  //    deeper than the default walk.
  // Giving up after one partial read is what reported "dialog not confirmed" while the
  // sheet was in fact on screen. The options that worked are kept in `sheetRead`: every
  // later read of the sheet must use them, or a narrower read would lose it again.
  async confirmExportSheet(job, seconds, signal, message) {
    const probe = { stop: EXPORT_SHEET_IDS };
    try {
      const ui = await this.verifyUi(exportDialogIsOpen, seconds, signal, 'EXPORT_DIALOG', message, probe);
      this.sheetRead = null;
      return ui;
    } catch (error) {
      if (error.code !== 'EXPORT_DIALOG') throw error;
      this.note('Feuille d’export absente de la première lecture : lecture approfondie de l’interface', job);
      // Two attempts at most: one deep read already lasts about 25 seconds.
      const ui = await this.verifyUi(exportDialogIsOpen, 1, signal, 'EXPORT_DIALOG', message, DEEP_READ, 2);
      this.sheetRead = DEEP_READ;
      return ui;
    }
  }
  // Did CapCut accept the export? `progress` reports what the filesystem already
  // shows — the announced file, or CapCut's hidden temp folder.
  // CapCut 9 does NOT close its export sheet when the export starts: the same
  // "Exporter-<projet>" sheet switches to a progress view (« Exportation », « 50.3% »,
  // a bar and « Annuler »), and the « Exporter » button (ExportOkBtn) disappears. So a
  // sheet still open proves nothing; the settings view still showing does. The read
  // goes past the sheet's identifiers (no stop) so that the percentage is reached.
  // Returns which signal proved it, 'incertain' when no complete read could tell, or
  // null only when a complete read still shows the « Exporter » button.
  async exportAccepted(progress, signal, seconds, tracker = null) {
    const end = Date.now() + Math.max(1, seconds) * 1000;
    let settingsStillShown = false;
    for (;;) {
      const seen = progress();
      if (seen) return seen;
      if (!this.actions.readUi) return null;
      let ui = null;
      try { ui = await this.readUi({ ...(this.sheetRead || {}), stop: [], progress: true, deadlineMs: 8000 }); }
      catch (e) { if (e.code === 'CANCELLED') throw e; }
      if (ui && exportIsRunning(ui)) return 'progression';
      if (ui && tracker && tracker.update(ui).percent != null) return 'progression';
      if (conclusive(ui)) {
        settingsStillShown = exportSettingsShown(ui);
        if (!settingsStillShown) return exportDialogIsOpen(ui) ? 'vue de progression' : 'feuille fermée';
      }
      if (Date.now() >= end) return settingsStillShown ? null : 'incertain';
      await wait(1500, signal);
    }
  }
  async restoreFrame(target) {
    const frame = this.settings.frames?.[target];
    if (!this.actions.restoreWindow || !frame) return;
    try {
      check(validFrame(frame), 'CAPCUT_WINDOW', 'Calibrage de fenêtre invalide.');
      await this.actions.restoreWindow(frame);
      const actual = await this.actions.windowFrame();
      check(validFrame(actual) && ['x', 'y', 'width', 'height'].every(k => Math.abs(frame[k] - actual[k]) <= 3), 'CAPCUT_WINDOW', 'CapCut n’a pas repris la taille et la position du calibrage. Quitte le plein écran et vise à nouveau la cible.');
    } catch (e) { throw Object.assign(new Error(e.message), { code: 'CAPCUT_WINDOW' }); }
  }
  async waitClosed(seconds, signal) {
    const end = Date.now() + Math.max(0, seconds) * 1000;
    for (;;) {
      if (!(await this.actions.isRunning())) return true;
      if (Date.now() >= end) return false;
      await wait(500, signal);
    }
  }
  // Closing CapCut. A polite quit first. CapCut refuses to quit while a modal panel is
  // open — its "export finished" panel is one, and Escape does not always reach it —
  // which is what left CapCut open after every successful export. When ELPO launched
  // CapCut itself (`force`), it then dismisses the panel, asks again, and as a last
  // resort terminates CapCut, protecting the project files (forceClose).
  async quit(job, signal, { force = false } = {}) {
    if (!(await this.actions.isRunning())) return;
    const grace = Math.min(10, this.settings.quitSeconds);
    this.note('Fermeture de CapCut', job);
    await this.actions.quit();
    if (await this.waitClosed(force ? grace : this.settings.quitSeconds, signal)) return;
    if (force) {
      this.note('CapCut refuse de se fermer : une fenêtre (fin d’export ?) le retient. ELPO la ferme puis redemande.', job);
      await this.dismiss(job, signal);
      await this.actions.quit();
      if (await this.waitClosed(grace, signal)) return;
      if (this.actions.forceQuit) { await this.forceClose(job, signal); return; }
    }
    throw Object.assign(new Error('CapCut ne s’est pas fermé. Une fenêtre attend peut-être une réponse : ferme-la puis relance le lot.'), { code: 'CAPCUT_STUCK' });
  }
  // Escape, then a click on a close/done control when CapCut exposes one. The windows
  // and identifiers seen are written to the log: they name the panel for a later fix.
  async dismiss(job, signal) {
    await this.actions.activate(); await wait(400, signal);
    await this.actions.key('escape'); await wait(800, signal);
    if (!this.actions.readUi || !(await this.actions.isRunning())) return;
    try {
      const ui = await this.readUi();
      this.note(`À la fermeture, CapCut affiche : ${uiSummary(ui)} · contrôles : ${uiIdentifiers(ui).join(', ') || 'aucun'}`, job);
      const p = closePoint(ui);
      if (p) {
        this.note(`Clic sur le bouton de fermeture en (${p.x}, ${p.y})`, job);
        await this.actions.activate(); await wait(300, signal);
        await this.actions.click(p, false); await wait(800, signal);
      }
    } catch (e) {
      if (e.code === 'CANCELLED') throw e;
      this.note(`Interface illisible à la fermeture (${e.message}) : fermeture forcée si nécessaire`, job);
    }
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
    this.note('Fermeture forcée de CapCut : l’export est terminé et vérifié, les fichiers du projet sont protégés', job);
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
  async exportOne(job, exportDir, signal) {
    const s = this.settings;
    job.status = 'running'; this.sheetRead = null;
    this.step(job, 'Fermeture de CapCut', 0.03); await this.quit(job, signal, { force: this.launched });
    const missing = missingMedia(job.project);
    if (missing.length) {
      check(s.missing === 'continue', 'MEDIA_MISSING', `${missing.length} média(s) introuvable(s) (${missing.slice(0, 3).join(', ')}) : relie-les dans CapCut ou autorise l’export malgré tout dans Réglages.`);
      this.note(`${missing.length} média(s) manquant(s) : la fenêtre « Relier des fichiers » sera fermée`, job);
    }
    this.step(job, 'Placement en tête de la liste des projets', 0.06);
    bumpProject(this.root, job.project, Date.now(), { backupDir: this.backupDir, guard: this.actions.assertClosed || (() => {}) });
    await this.gate(signal);
    this.step(job, 'Lancement de CapCut', 0.1); await this.actions.launch(); this.launched = true; await wait(s.launchSeconds * 1000, signal);
    check(await this.actions.isRunning(), 'CAPCUT_LAUNCH', 'CapCut ne s’est pas lancé.');
    await this.gate(signal);
    await this.restoreFrame('tile');
    let tile = s.tile;
    if (this.actions.readUi) {
      this.step(job, 'Retour sur Accueil et vérification des projets', 0.12);
      await this.actions.activate();
      const ui = await this.readUi();
      if (!homeIsOpen(ui)) {
        const home = controlPoint(ui, ['accueil', 'home']) || s.home;
        check(home, 'CAPCUT_HOME', 'Le bouton Accueil de CapCut est introuvable. Vise le bouton « Accueil » dans les réglages ELPO.');
        if (!controlPoint(ui, ['accueil', 'home'])) await this.restoreFrame('home');
        await this.actions.click(home, false);
      }
      let homeUi = await this.verifyUi(homeIsOpen, s.openSeconds, signal, 'CAPCUT_HOME', 'CapCut n’affiche pas la liste des projets de l’accueil. Aucun export envoyé.');
      // CapCut 9 exposes each project tile (HomePageDraft) with its position: aim at
      // the real first tile. Otherwise reuse the geometry of the calibration.
      if (!draftTiles(homeUi).length) { await this.restoreFrame('tile'); homeUi = await this.readUi(); }
      const tiles = draftTiles(homeUi), named = draftTileFor(homeUi, job.name);
      if (named !== undefined) {
        // Tile titles are exposed: open this project by name, never another one.
        check(named, 'CAPCUT_TILE', `La vignette du projet « ${job.name} » n’est pas visible sur l’accueil CapCut (projets visibles : ${draftTitles(homeUi).slice(0, 6).join(', ') || 'aucun'}). Agrandis la fenêtre CapCut (sans plein écran). Aucun clic envoyé.`);
        tile = named;
        this.note(`Vignette « ${job.name} » trouvée en (${tile.x}, ${tile.y})`, job);
      } else if (tiles.length) {
        tile = tiles[0];
        this.note(`Première vignette de projet trouvée en (${tile.x}, ${tile.y})`, job);
      } else if (placedDrafts(homeUi).length) {
        // Tiles are exposed but none is visible: never click blindly (the calibrated point
        // may land on « Studio de conceptions »).
        check(pointOnDraft(homeUi, s.tile), 'CAPCUT_TILE',
          'La rangée « Projets » de l’accueil CapCut n’est pas visible : agrandis la fenêtre CapCut (sans plein écran) jusqu’à voir les vignettes de projets. Aucun clic envoyé.');
      }
      await this.gate(signal);
    }
    this.step(job, 'Ouverture du projet', 0.16); await this.actions.activate(); await this.actions.click(tile, s.openWith === 'double'); await wait(s.openSeconds * 1000, signal);
    if (missing.length) { await this.actions.key('escape'); await wait(1500, signal); }
    const opened = await this.verifyUi(ui => projectIsOpen(ui, job.name), s.openSeconds, signal, 'PROJECT_NOT_OPEN', `Le projet « ${job.name} » n’est pas confirmé dans l’éditeur. Vise à nouveau la première vignette sur l’accueil CapCut. Aucun export envoyé.`);
    this.note(editorIsOpen(opened) ? 'Éditeur CapCut confirmé ; identité du projet à vérifier dans la feuille d’export' : `Projet ouvert confirmé : ${job.name}`, job);
    await this.gate(signal);
    this.step(job, 'Ouverture de la fenêtre d’export', 0.22); await this.actions.activate();
    // `activate` returns before CapCut is actually frontmost: a click sent too early
    // lands on whatever was in front. Give it a moment before aiming at its button.
    await wait(600, signal);
    // CapCut 9 exposes its own Export button (MainWindowTitleBarExportBtn): clicking it
    // does not depend on ⌘E being bound, on the keyboard layout, or on where the focus
    // is. ⌘E stays as the fallback when that button is not exposed.
    const openButton = exportOpenPoint(opened);
    const ways = [
      openButton && { how: `clic sur le bouton « Exporter » de CapCut en (${openButton.x}, ${openButton.y})`, open: () => this.actions.click(openButton, false) },
      { how: 'raccourci ⌘E', open: () => this.actions.shortcut('e', ['command']) },
    ].filter(Boolean);
    const notConfirmed = 'La fenêtre de réglages d’export de CapCut n’est pas confirmée. Aucun clic Exporter envoyé.';
    for (const [index, way] of ways.entries()) {
      if (index) this.note(`Feuille d’export non confirmée par ${ways[index - 1].how} : nouvel essai par ${way.how}`, job);
      await way.open();
      await wait(Math.min(1500, s.dialogSeconds * 1000), signal);
      const last = index === ways.length - 1;
      try {
        // The deep read is the last resort: only the final attempt pays for it.
        if (last) await this.confirmExportSheet(job, s.dialogSeconds, signal, notConfirmed);
        else await this.verifyUi(exportDialogIsOpen, s.dialogSeconds, signal, 'EXPORT_DIALOG', notConfirmed, { stop: EXPORT_SHEET_IDS });
        break;
      } catch (e) { if (last) throw e; }
    }
    await this.gate(signal);
    await this.restoreFrame('exportButton');
    // Read again for the details: the Export button's frame and the announced output
    // path are needed, and a probe stops at the first identifier it sees. It uses the
    // same read options that found the sheet, or a narrower read would lose it again.
    const sheet = await this.verifyUi(exportDialogIsOpen, s.dialogSeconds, signal, 'EXPORT_DIALOG', 'La fenêtre d’export n’est plus confirmée après restauration du calibrage. Aucun clic Exporter envoyé.', this.sheetRead);
    // CapCut 9 shows the exact output file on its export sheet: it confirms the project
    // (the editor window does not expose its name) and the folder actually written to.
    const target = sheet ? exportTarget(sheet) : null;
    // Automation identifiers confirm the editor, not its project: require the
    // output path before sending Export when no named editor was confirmed.
    check((!editorIsOpen(opened) && !editorIsOpen(sheet)) || target, 'PROJECT_NOT_OPEN', `Le chemin de sortie de CapCut est illisible : le projet « ${job.name} » ne peut pas être confirmé. Aucun export envoyé.`);
    if (target) {
      check(targetMatches(target, job.name), 'PROJECT_NOT_OPEN', `CapCut s’apprête à exporter « ${path.basename(target)} » au lieu de « ${job.name} ». Aucun export envoyé.`);
      const folder = path.dirname(target);
      if (path.resolve(folder) !== path.resolve(exportDir) && fs.existsSync(folder)) {
        this.note(`CapCut exporte vers « ${folder} » (et non « ${exportDir} ») : surveillance de ce dossier`, job);
        exportDir = folder;
      }
    }
    const known = snapshotExports(exportDir), since = Date.now();
    // CapCut announces the exact file it is about to write. Watching that path is the
    // reliable signal: scanning the folder alone misses the export as soon as CapCut
    // writes outside it, or deeper than the scan goes.
    const announced = () => {
      if (!target) return null;
      try {
        const stat = fs.statSync(target), before = known.get(target);
        const changed = !known.has(target) || ['size', 'mtimeMs', 'ctimeMs', 'ino'].some(k => before[k] !== stat[k]);
        return changed && stat.mtimeMs >= since - 2000 ? target : null;
      } catch { return null; }
    };
    // What the filesystem already tells us, cheapest first.
    const progress = () => (newExports(exportDir, since, known)[0] || announced()) ? 'fichier'
      : (encodingBytes(exportDir, since) > 0 ? 'encodage' : null);
    this.step(job, 'Lancement de l’export', 0.26);
    // Prefer CapCut's own "ExportOkBtn" position, then the calibrated point, then Return.
    const okButton = (sheet && exportOkPoint(sheet)) || s.exportButton;
    if (target) this.note(`Fichier annoncé par CapCut : ${target}`, job);
    if (okButton) this.note(`Clic sur « Exporter » de la feuille en (${okButton.x}, ${okButton.y})`, job);
    else this.note('Aucun bouton « Exporter » lisible dans la feuille : ELPO appuie sur Entrée (viser le bouton dans Réglages est plus sûr)', job);
    // CapCut only receives the click when it is frontmost, and the interface reads
    // that precede this point last tens of seconds: nothing guarantees the focus is
    // still on CapCut. Every other click of the sequence is preceded by activate();
    // this one — the click that actually starts the export — was not.
    const sendExport = async byKey => {
      await this.actions.activate(); await wait(600, signal);
      if (byKey || !okButton) await this.actions.key('return'); else await this.actions.click(okButton, false);
    };
    // Whatever shows a percentage on the sheet before the click (zoom, volume…) is the
    // baseline: only a percentage that appears or moves afterwards is CapCut's export.
    const tracker = exportTracker(sheet);
    await sendExport(false);
    // Verify the click was received instead of waiting blindly for a file. When CapCut
    // accepts an export it replaces the sheet with its progress window, so a sheet
    // still open a few seconds later means the click did not land.
    const confirmSeconds = Math.min(12, Math.max(3, Math.round(s.startSeconds / 6)));
    const accepted = await this.exportAccepted(progress, signal, confirmSeconds, tracker);
    if (!accepted) {
      // Only here is Return safe: the settings view, whose default button is
      // « Exporter », is still on screen. On the progress view Return could hit
      // « Annuler » and stop the export, so it is never sent once the view changed.
      this.note('Le bouton « Exporter » est toujours affiché après le clic : il n’a pas été reçu. Nouvel essai par la touche Entrée', job);
      await sendExport(true);
    } else if (accepted === 'incertain') {
      this.note('Démarrage de l’export non confirmé par l’interface : ELPO surveille la progression et le fichier, sans renvoyer de touche', job);
    } else {
      this.note(`Export démarré dans CapCut (${accepted})`, job);
    }
    // Following the export. CapCut is asked every few seconds how far it is: its own
    // percentage is what says the export is over (100 %, or its "export finished"
    // panel). The file on disk confirms it: found where CapCut announced it, complete
    // and readable by FFmpeg. Without a readable percentage the file alone decides,
    // as before (stable size + readable duration).
    const deadline = Date.now() + s.timeoutMinutes * 60000;
    const startDeadline = Date.now() + s.startSeconds * 1000;
    const progressRead = { ...(this.sheetRead || {}), stop: [], progress: true, deadlineMs: 8000 };
    let file = null, lastSize = -1, stableSince = 0, started = false, nextUiCheck = 0, warnedUnplayable = false, uiFailures = 0;
    let percent = null, done = null, doneAt = 0;
    const show = (stage, progress) => { job.stage = stage; if (progress != null) job.progress = progress; this.changed(); };
    while (Date.now() < deadline) {
      await wait(1000, signal);
      if (!file) {
        file = newExports(exportDir, since, known)[0] || announced();
        if (file) this.note(`Fichier d’export apparu : ${file}`, job);
      }
      if (this.actions.readUi && !done && Date.now() >= nextUiCheck) {
        let ui = null;
        // While CapCut encodes it can answer System Events slowly: a failed read proves
        // nothing about the export, so it is noted once and the watch goes on.
        try { ui = await this.readUi(progressRead); uiFailures = 0; }
        catch (e) { if (e.code === 'CANCELLED') throw e; if (++uiFailures === 1) this.note(`Lecture de la progression CapCut impossible : ${e.message}`, job); }
        if (ui) {
          const r = tracker.update(ui);
          if (r.percent != null) {
            started = true;
            if (percent == null) this.note(`Progression de l’export CapCut suivie : ${Math.round(r.percent)} %`, job);
            percent = r.percent;
            show(`Export CapCut · ${Math.round(percent)} %`, 0.28 + 0.62 * percent / 100);
          } else if (!started && conclusive(ui) && !exportDialogIsOpen(ui)) {
            // A sheet that is gone is CapCut's own signal that the export is running.
            started = true;
          }
          // "progression disparue" alone is weak (a read may simply have missed the
          // bar): it ends the wait only once the file confirms it below.
          if (r.done) {
            done = r.done; doneAt = Date.now();
            this.note(`CapCut indique la fin de l’export (${done})`, job);
          }
        }
        nextUiCheck = Date.now() + (uiFailures ? 10000 : 2000);
      }
      if (!file && done) {
        // CapCut moves the finished video into place at the very end: look for it where
        // it was announced, then anywhere under the export folder.
        file = announced() || newExports(exportDir, since, known)[0] || recentVideos(exportDir, since)[0] || null;
        if (file) this.note(`Fichier d’export trouvé après la fin annoncée par CapCut : ${file}`, job);
      }
      if (!file) {
        const encoding = encodingBytes(exportDir, since);
        if (encoding > 0) started = true;
        if (done && done !== 'progression disparue') {
          check(Date.now() - doneAt < 120000, 'EXPORT_FILE_MISSING', `CapCut a terminé l’export mais aucun fichier n’a été trouvé${target ? ` à « ${target} »` : ''} ni dans « ${exportDir} ». Vérifie le dossier d’export choisi dans CapCut.`);
          show('CapCut a terminé · recherche du fichier exporté', 0.92);
          continue;
        }
        if (done === 'progression disparue') { done = null; nextUiCheck = 0; }
        check(started || Date.now() < startDeadline, 'EXPORT_NOT_STARTED', `Aucun fichier détecté dans « ${exportDir} »${target ? ` ni à « ${target} »` : ''} et aucun encodage confirmé après ${s.startSeconds} s, et la feuille d’export CapCut est toujours affichée. Vérifie le bouton Exporter et le dossier de sortie de CapCut.`);
        if (percent == null) {
          if (encoding > 0) show(`Encodage dans CapCut · ${(encoding / 1e6).toFixed(1)} Mo`, Math.min(0.9, 0.3 + encoding / 4e9));
          else show(started ? 'Export en cours dans CapCut · attente du fichier' : 'Attente du démarrage de l’export CapCut');
        }
        continue;
      }
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size !== lastSize) {
        lastSize = size; stableSince = Date.now();
        if (percent == null) show(`Export en cours · ${(size / 1e6).toFixed(1)} Mo`, Math.min(0.9, 0.3 + size / 4e9));
        continue;
      }
      // When CapCut said it is done, the file is final: one stable second is enough.
      // While CapCut still shows a percentage below 100, it is not done: wait for it
      // (a stable, readable file for 30 s still wins, in case the percentage read was
      // not CapCut's).
      const still = percent != null && percent < 99.5 && !done;
      const need = done ? 1000 : still ? 30000 : s.stableSeconds * 1000;
      if (size > 0 && Date.now() - stableSince >= need) {
        if (await this.actions.playable(file)) break;
        // FFmpeg cannot read the duration: say so instead of waiting in silence.
        if (!warnedUnplayable) { warnedUnplayable = true; this.note(`Fichier trouvé mais sa durée est illisible pour FFmpeg : ${path.basename(file)} — ELPO réessaie`, job); }
      }
    }
    check(file && Date.now() < deadline, 'EXPORT_TIMEOUT', 'Aucun fichier d’export terminé dans le délai. Vérifie le dossier d’export de CapCut.');
    job.output = file;
    this.note(`Fichier exporté et vérifié : ${path.basename(file)}`, job);
    // From here the video exists: whatever happens while closing CapCut, the job is done.
    try {
      await this.gate(signal);
      this.step(job, 'Fermeture de la fenêtre « Export terminé »', 0.94);
      // CapCut 9 ends the export on a share panel inside its export sheet (« La vidéo est
      // enregistrée sur ton bureau… », « Fermer », « Partager »), which keeps it from
      // quitting. Its « Fermer » is clicked — only now, with the video verified on disk.
      // The panel can show up a moment after the file: a few reads are allowed.
      if (this.actions.readUi) {
        for (let attempt = 0; attempt < 4; attempt++) {
          let ui = null;
          try { ui = await this.readUi({ ...(this.sheetRead || {}), stop: [], deadlineMs: 8000 }); }
          catch (e) { if (e.code === 'CANCELLED') throw e; }
          const fermer = ui && finishedClosePoint(ui);
          if (fermer) {
            this.note(`Panneau de fin d’export CapCut : clic sur « Fermer » en (${fermer.x}, ${fermer.y})`, job);
            await this.actions.activate(); await wait(400, signal);
            await this.actions.click(fermer, false); await wait(1000, signal);
            break;
          }
          if (attempt === 3) this.note(`Panneau de fin d’export introuvable : ${ui ? uiSummary(ui) : 'interface illisible'} · contrôles : ${ui ? uiIdentifiers(ui).join(', ') || 'aucun' : '-'}`, job);
          else await wait(1500, signal);
        }
      }
      for (const k of s.closeKeys) { await this.actions.activate(); await this.actions.key(k); await wait(800, signal); }
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
}
