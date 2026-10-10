// CapCut pilot: exports projects with CapCut itself, one after another.
// Cycle per project: quit CapCut → put the project first in "Projects" → launch CapCut →
// open the first tile → export → wait for a complete file → close the dialog → quit.
// Every UI action goes through `actions`, so the sequence is testable without a Mac.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { digest, readJson, transact, listBackups } from './storage.js';
import { check } from './errors.js';
import { resolveMediaPath } from './render.js';
import { canonicalRoot, canonicalProject } from './projects.js';
import { requireClosed } from './engine.js';
import { controlPoint, homeIsOpen, editorIsOpen, projectIsOpen, exportDialogIsOpen, exportIsRunning, uiSummary, uiIdentifiers, validFrame, exportTarget, targetMatches, exportOkPoint, exportOpenPoint, draftTiles, placedDrafts, pointOnDraft, draftTileFor, draftTitles } from './capcut-ui.js';

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
    this.jobs = (test ? projects.slice(0, 1) : projects).map(p => ({ id: randomUUID(), project: p.path, name: p.name, status: 'queued', stage: 'En attente', progress: 0, output: null, error: null }));
    this.changed();
    try {
      for (const job of this.jobs) {
        if (signal.aborted) { job.status = 'cancelled'; job.stage = 'Annulé'; continue; }
        try { await this.exportOne(job, exportDir, signal); }
        catch (e) {
          Object.assign(job, e.code === 'CANCELLED' ? { status: 'cancelled', stage: 'Annulé' } : { status: 'failed', stage: 'Échec', error: e.message });
          this.note(`Échec : ${e.message}`, job);
          if (['CAPCUT_HOME', 'CAPCUT_TILE', 'CAPCUT_WINDOW', 'PROJECT_NOT_OPEN', 'EXPORT_DIALOG', 'EXPORT_NOT_STARTED', 'CAPCUT_UI'].includes(e.code)) {
            // Preserve the visible problem for the user; do not quit or start
            // another project when the current UI could not be identified.
            for (const pending of this.jobs.filter(j => j.status === 'queued')) Object.assign(pending, { status: 'cancelled', stage: 'Non lancé : pilotage interrompu' });
            this.changed(); break;
          }
          // Leave CapCut in a known state before the next project.
          try { await this.quit(job, new AbortController().signal); } catch { /* reported below if it persists */ }
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
  async quit(job, signal) {
    if (!(await this.actions.isRunning())) return;
    this.note('Fermeture de CapCut', job);
    await this.actions.quit();
    for (let t = 0; t < this.settings.quitSeconds * 2; t++) { if (!(await this.actions.isRunning())) return; await wait(500, signal); }
    throw Object.assign(new Error('CapCut ne s’est pas fermé. Une fenêtre attend peut-être une réponse : ferme-la puis relance le lot.'), { code: 'CAPCUT_STUCK' });
  }
  async exportOne(job, exportDir, signal) {
    const s = this.settings;
    job.status = 'running'; this.sheetRead = null;
    this.step(job, 'Fermeture de CapCut', 0.03); await this.quit(job, signal);
    const missing = missingMedia(job.project);
    if (missing.length) {
      check(s.missing === 'continue', 'MEDIA_MISSING', `${missing.length} média(s) introuvable(s) (${missing.slice(0, 3).join(', ')}) : relie-les dans CapCut ou autorise l’export malgré tout dans Réglages.`);
      this.note(`${missing.length} média(s) manquant(s) : la fenêtre « Relier des fichiers » sera fermée`, job);
    }
    this.step(job, 'Placement en tête de la liste des projets', 0.06);
    bumpProject(this.root, job.project, Date.now(), { backupDir: this.backupDir, guard: this.actions.assertClosed || (() => {}) });
    await this.gate(signal);
    this.step(job, 'Lancement de CapCut', 0.1); await this.actions.launch(); await wait(s.launchSeconds * 1000, signal);
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
    this.step(job, 'Lancement de l’export', 0.26);
    // Prefer CapCut's own "ExportOkBtn" position, then the calibrated point, then Return.
    const okButton = (sheet && exportOkPoint(sheet)) || s.exportButton;
    if (!okButton) this.note('Aucun bouton « Exporter » lisible dans la feuille : ELPO appuie sur Entrée (viser le bouton dans Réglages est plus sûr)', job);
    if (okButton) await this.actions.click(okButton, false); else await this.actions.key('return');
    // The file is done when it stops growing and its duration can be read.
    const deadline = Date.now() + s.timeoutMinutes * 60000;
    const startDeadline = Date.now() + s.startSeconds * 1000;
    let file = null, lastSize = -1, stableSince = 0, started = false, nextUiCheck = 0;
    while (Date.now() < deadline) {
      await wait(1000, signal);
      file ||= newExports(exportDir, since, known)[0] || null;
      if (!file) {
        const encoding = encodingBytes(exportDir, since);
        if (encoding > 0) {
          started = true;
          job.stage = `Encodage dans CapCut · ${(encoding / 1e6).toFixed(1)} Mo`; job.progress = Math.min(0.9, 0.3 + encoding / 4e9); this.changed(); continue;
        }
        if (this.actions.readUi && Date.now() >= nextUiCheck) {
          started ||= exportIsRunning(await this.readUi()); nextUiCheck = Date.now() + 5000;
        }
        check(started || Date.now() < startDeadline, 'EXPORT_NOT_STARTED', `Aucun fichier détecté dans « ${exportDir} » et aucun encodage confirmé après ${s.startSeconds} s. Vérifie le bouton Exporter et le dossier de sortie de CapCut.`);
        job.stage = started ? 'Export en cours dans CapCut · attente du fichier' : 'Attente du démarrage de l’export CapCut'; this.changed(); continue;
      }
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size !== lastSize) { lastSize = size; stableSince = Date.now(); job.stage = `Export en cours · ${(size / 1e6).toFixed(1)} Mo`; job.progress = Math.min(0.9, 0.3 + size / 4e9); this.changed(); continue; }
      if (size > 0 && Date.now() - stableSince >= s.stableSeconds * 1000 && await this.actions.playable(file)) break;
    }
    check(file && Date.now() < deadline, 'EXPORT_TIMEOUT', 'Aucun fichier d’export terminé dans le délai. Vérifie le dossier d’export de CapCut.');
    job.output = file;
    await this.gate(signal);
    this.step(job, 'Fermeture de la fenêtre « Export terminé »', 0.94);
    for (const k of s.closeKeys) { await this.actions.activate(); await this.actions.key(k); await wait(800, signal); }
    this.step(job, 'Retour à la liste des projets', 0.97); await this.quit(job, signal);
    Object.assign(job, { status: 'done', stage: 'Terminé', progress: 1 }); this.note(`Exporté : ${path.basename(file)}`, job);
  }
}
