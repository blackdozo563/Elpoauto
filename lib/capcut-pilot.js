// CapCut pilot: exports projects with CapCut itself, one after another.
// Cycle per project: quit CapCut → put the project first in "Projects" → launch CapCut →
// open the first tile → export → wait for a complete file → close the dialog → quit.
// Every UI action goes through `actions`, so the sequence is testable without a Mac.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { atomicWrite, digest, readJson } from './storage.js';
import { check } from './errors.js';
import { resolveMediaPath } from './render.js';

export const DEFAULT_PILOT = {
  tile: null,            // {x, y} screen point of the first project tile on CapCut's home
  exportButton: null,    // {x, y} of "Export" in CapCut's export window; null = press Return
  openWith: 'double',    // 'double' click or 'single' click on the tile
  launchSeconds: 12, openSeconds: 8, dialogSeconds: 3, stableSeconds: 4, timeoutMinutes: 60, quitSeconds: 25,
  closeKeys: ['escape'], // keys pressed when the export is complete (closes "Export finished")
  missing: 'skip',       // media missing: 'skip' the project, or 'continue' (dismiss the relink sheet)
};
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Pilotage arrêté.'), { code: 'CANCELLED' })); }, { once: true });
});

// CapCut sorts "Projects" by last modification: bump only the timestamps, CapCut being closed.
export function bumpProject(root, project, now = Date.now()) {
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
  atomicWrite(metaFile, Buffer.from(JSON.stringify(nextMeta)), fs.statSync(metaFile).mode & 0o777);
  if (index) atomicWrite(indexFile, Buffer.from(JSON.stringify(nextIndex)), fs.statSync(indexFile).mode & 0o777);
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
export function newExports(dir, since, known) {
  return listVideos(dir).filter(f => !known.has(f)).filter(f => { try { return fs.statSync(f).mtimeMs >= since - 2000; } catch { return false; } });
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
  constructor({ root, actions, settings = {} }) {
    super(); this.root = root; this.actions = actions; this.settings = { ...DEFAULT_PILOT, ...settings }; this.jobs = []; this.controller = null; this.log = [];
  }
  list() { return this.jobs.map(j => ({ ...j })); }
  note(text, job = null) {
    const line = { at: Date.now(), text, project: job?.name || null };
    this.log.push(line); this.log = this.log.slice(-300); this.emit('log', line);
  }
  changed() { this.emit('update', this.list()); }
  stop() { this.controller?.abort(); }
  async run(projects, { exportDir, test = false } = {}) {
    check(!this.controller, 'PILOT_BUSY', 'Un pilotage CapCut est déjà en cours.');
    check(this.settings.tile, 'PILOT_CALIBRATION', 'Calibre d’abord la position de la première vignette de projet dans CapCut.');
    check(exportDir && fs.existsSync(exportDir), 'EXPORT_DIR', 'Indique le dossier où CapCut enregistre ses exports.');
    check(await this.actions.accessibility(), 'ACCESSIBILITY', 'Autorise ElpoAiAutoCapcut dans Réglages Système → Confidentialité et sécurité → Accessibilité.');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.jobs = (test ? projects.slice(0, 1) : projects).map(p => ({ id: randomUUID(), project: p.path, name: p.name, status: 'queued', stage: 'En attente', progress: 0, output: null, error: null }));
    this.changed();
    try {
      for (const job of this.jobs) {
        if (signal.aborted) { job.status = 'cancelled'; job.stage = 'Annulé'; continue; }
        try { await this.exportOne(job, exportDir, signal); }
        catch (e) {
          Object.assign(job, e.code === 'CANCELLED' ? { status: 'cancelled', stage: 'Annulé' } : { status: 'failed', stage: 'Échec', error: e.message });
          this.note(`Échec : ${e.message}`, job);
          // Leave CapCut in a known state before the next project.
          try { await this.quit(job, new AbortController().signal); } catch { /* reported below if it persists */ }
        }
        this.changed();
      }
    } finally { this.controller = null; this.emit('idle', this.list()); }
    return this.list();
  }
  step(job, stage, progress) { job.stage = stage; job.progress = progress; this.note(stage, job); this.changed(); }
  async quit(job, signal) {
    if (!(await this.actions.isRunning())) return;
    this.note('Fermeture de CapCut', job);
    await this.actions.quit();
    for (let t = 0; t < this.settings.quitSeconds * 2; t++) { if (!(await this.actions.isRunning())) return; await wait(500, signal); }
    throw Object.assign(new Error('CapCut ne s’est pas fermé. Une fenêtre attend peut-être une réponse : ferme-la puis relance le lot.'), { code: 'CAPCUT_STUCK' });
  }
  async exportOne(job, exportDir, signal) {
    const s = this.settings;
    job.status = 'running';
    this.step(job, 'Fermeture de CapCut', 0.03); await this.quit(job, signal);
    const missing = missingMedia(job.project);
    if (missing.length) {
      check(s.missing === 'continue', 'MEDIA_MISSING', `${missing.length} média(s) introuvable(s) (${missing.slice(0, 3).join(', ')}) : relie-les dans CapCut ou autorise l’export malgré tout dans Réglages.`);
      this.note(`${missing.length} média(s) manquant(s) : la fenêtre « Relier des fichiers » sera fermée`, job);
    }
    this.step(job, 'Placement en tête de la liste des projets', 0.06); bumpProject(this.root, job.project);
    this.step(job, 'Lancement de CapCut', 0.1); await this.actions.launch(); await wait(s.launchSeconds * 1000, signal);
    check(await this.actions.isRunning(), 'CAPCUT_LAUNCH', 'CapCut ne s’est pas lancé.');
    this.step(job, 'Ouverture du projet', 0.16); await this.actions.activate(); await this.actions.click(s.tile, s.openWith === 'double'); await wait(s.openSeconds * 1000, signal);
    if (missing.length) { await this.actions.key('escape'); await wait(1500, signal); }
    const known = new Set(listVideos(exportDir)), since = Date.now();
    this.step(job, 'Ouverture de la fenêtre d’export', 0.22); await this.actions.activate(); await this.actions.shortcut('e', ['command']); await wait(s.dialogSeconds * 1000, signal);
    this.step(job, 'Lancement de l’export', 0.26);
    if (s.exportButton) await this.actions.click(s.exportButton, false); else await this.actions.key('return');
    // The file is done when it stops growing and its duration can be read.
    const deadline = Date.now() + s.timeoutMinutes * 60000;
    let file = null, lastSize = -1, stableSince = 0;
    while (Date.now() < deadline) {
      await wait(1000, signal);
      file ||= newExports(exportDir, since, known)[0] || null;
      if (!file) { job.stage = 'Export en cours dans CapCut'; this.changed(); continue; }
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size !== lastSize) { lastSize = size; stableSince = Date.now(); job.stage = `Export en cours · ${(size / 1e6).toFixed(1)} Mo`; job.progress = Math.min(0.9, 0.3 + size / 4e9); this.changed(); continue; }
      if (size > 0 && Date.now() - stableSince >= s.stableSeconds * 1000 && await this.actions.playable(file)) break;
    }
    check(file && Date.now() < deadline, 'EXPORT_TIMEOUT', 'Aucun fichier d’export terminé dans le délai. Vérifie le dossier d’export de CapCut.');
    job.output = file;
    this.step(job, 'Fermeture de la fenêtre « Export terminé »', 0.94);
    for (const k of s.closeKeys) { await this.actions.activate(); await this.actions.key(k); await wait(800, signal); }
    this.step(job, 'Retour à la liste des projets', 0.97); await this.quit(job, signal);
    Object.assign(job, { status: 'done', stage: 'Terminé', progress: 1 }); this.note(`Exporté : ${path.basename(file)}`, job);
  }
}
