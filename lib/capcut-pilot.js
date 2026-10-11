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
import { canonicalRoot, canonicalProject, loadProject } from './projects.js';
import { requireClosed } from './engine.js';

export const DEFAULT_PILOT = {
  tile: null,            // ancien réglage d’interface, ignoré par le pilote natif
  home: null,            // fallback when CapCut does not expose the Home control
  frames: {},           // window geometry recorded when aiming each target
  exportButton: null,    // ancien réglage d’interface, ignoré par le pilote natif
  openWith: 'double',    // 'double' click or 'single' click on the tile
  // dialogSeconds must cover CapCut building its export sheet AND one interface read:
  // a read of a real editor takes seconds, so a 3 s budget allowed exactly one
  // (partial) attempt and failed on it.
  launchSeconds: 12, openSeconds: 8, dialogSeconds: 10, stableSeconds: 4, startSeconds: 90, timeoutMinutes: 60, quitSeconds: 25,
  closeKeys: ['escape'], // keys pressed when the export is complete (closes "Export finished")
  missing: 'skip',       // media missing: 'skip' the project, or 'continue' (dismiss the relink sheet)
};

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
      check(this.actions.state && this.actions.pressExport, 'AX_BINARY', 'Le pilote natif capcut-ax est requis.');
      check(this.actions.probeAvailable?.(), 'FFPROBE_REQUIRED', 'ffprobe est requis pour vérifier la durée du MP4.');
      check(exportDir && fs.existsSync(exportDir), 'EXPORT_DIR', 'Indique le dossier où CapCut enregistre ses exports.');
      check(await this.actions.accessibility(), 'ACCESSIBILITY', 'Autorise ElpoAiAutoCapcut et son outil capcut-ax dans Réglages Système → Confidentialité et sécurité → Accessibilité.');
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
          if (e.code !== 'CANCELLED') {
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
  async observe(signal) {
    const snapshot = await this.actions.state(signal);
    const key = `${snapshot.complete}:${snapshot.state?.page || 'unknown'}`;
    this.evidence?.push({ at: Date.now(), command: 'state', complete: snapshot.complete,
      state: snapshot.state, ms: snapshot.ms, incompleteReasons: snapshot.incompleteReasons,
      ...(this.lastStateKey !== key ? { snapshot } : {}) });
    this.lastState = snapshot; this.lastStateKey = key;
    return snapshot;
  }
  async expected(page, seconds, signal, accept = () => false) {
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    let snapshot;
    do {
      await this.gate(signal);
      snapshot = await this.observe(signal);
      if ((snapshot.complete === true && snapshot.state?.page === page) || accept(snapshot)) return snapshot;
      if (Date.now() >= deadline) break;
      await wait(this.settings.pollMs ?? 250, signal);
    } while (true);
    throw Object.assign(new Error(`État natif « ${page} » non confirmé sous ${seconds} s. Dernier état : ${snapshot?.state?.page || 'unknown'}. Aucune action supplémentaire.`), { code: 'AX_STATE_TIMEOUT', evidence: snapshot });
  }
  async action(label, fn, signal) {
    await this.gate(signal);
    const result = await fn();
    this.evidence?.push({ at: Date.now(), command: label, result });
    return result;
  }
  saveEvidence(job, failure = null) {
    try {
      const dir = path.join(this.backupDir, 'capcut-native-reports'); fs.mkdirSync(dir, { recursive: true });
      job.report = path.join(dir, `${job.id}.json`);
      atomicWrite(job.report, Buffer.from(JSON.stringify({ schema: 1, job: { name: job.name, status: job.status, output: job.output },
        error: failure ? { code: failure.code, message: failure.message, evidence: failure.evidence } : null,
        functionalProof: job.status === 'done' && !failure, exportValidated: !!job.output,
        lastNativeState: this.lastState, events: this.evidence || [] }, null, 2)));
      this.note(`Rapport natif : ${job.report}`, job);
    } catch (error) { this.note(`Rapport natif impossible à écrire : ${error.message}`, job); }
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
    if (!(await this.actions.isRunning())) return;
    try {
      const snapshot = await this.observe(signal);
      if (snapshot.complete === true && snapshot.state?.page === 'done') {
        await this.action('close-done', () => this.actions.closeDone(signal), signal);
        await this.expected('editor', this.settings.dialogSeconds, signal);
      }
    } catch (error) {
      if (error.code === 'CANCELLED') throw error;
      this.note(`Fermeture native non confirmée : ${error.message}`, job);
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
    const s = this.settings; this.evidence = []; this.lastState = null; this.lastStateKey = null; job.status = 'running';
    try {
      // Existing shutdown and project protections are preserved.
      this.step(job, 'Fermeture de CapCut', 0.03);
      await this.quit(job, signal, { force: this.launched });
      const missing = missingMedia(job.project);
      check(!missing.length, 'MEDIA_MISSING', `Média(s) introuvable(s) : ${missing.slice(0,3).join(', ')}. Relie-les avant le test natif.`);
      let loaded;
      try { loaded = loadProject(this.root, job.project); } catch { /* native-only CapCut projects may be opaque to the montage engine */ }
      const metadata = readJson(path.join(job.project, 'draft_meta_info.json')).value;
      const expectedDuration = Number(loaded?.raw?.duration > 0 ? loaded.raw.duration : metadata.tm_duration) / 1e6;
      check(Number.isFinite(expectedDuration) && expectedDuration > 0, 'PROJECT_DURATION', 'Durée de la timeline inconnue : aucune validation approximative du MP4.');
      this.evidence.push({ expectedDuration, project: job.name });
      await this.gate(signal);
      this.step(job, 'Placement en tête de la liste des projets', 0.06);
      bumpProject(this.root, job.project, Date.now(), { backupDir: this.backupDir, guard: this.actions.assertClosed || requireClosed });
      this.step(job, 'Lancement de CapCut', 0.1);
      await this.action('launch', () => this.actions.launch(), signal); this.launched = true;
      await this.expected('home', Math.max(1, s.launchSeconds + s.openSeconds), signal);
      this.step(job, 'Ouverture du projet', 0.16);
      await this.action('open-project', () => this.actions.openProject(job.name, signal), signal);
      await this.expected('editor', Math.max(1, s.openSeconds), signal);
      this.step(job, 'Ouverture de la fenêtre d’export', 0.22);
      await this.action('open-export', () => this.actions.openExport(signal), signal);
      const settings = await this.expected('export-settings', Math.max(1, s.dialogSeconds), signal);
      const target = settings.state.outputPath;
      check(typeof target === 'string' && target.toLowerCase().endsWith('.mp4'), 'AX_OUTPUT', 'Fichier MP4 annoncé illisible.');
      const normalize = value => value.normalize('NFC');
      const stem = path.basename(target, path.extname(target)).replace(/\s*\(\d+\)$/u, '');
      check(normalize(stem) === normalize(job.name), 'AX_IDENTITY', 'Le fichier annoncé appartient à un autre projet.');
      check(normalize(fs.realpathSync(path.dirname(target))) === normalize(fs.realpathSync(exportDir)), 'AX_OUTPUT', 'Le dossier de sortie de CapCut diffère du dossier demandé.');
      check(!fs.existsSync(target), 'AX_OUTPUT_EXISTS', 'Le fichier annoncé existe déjà. Aucun remplacement ni deuxième export envoyé.');
      const appeared = () => {
        try { const st = fs.lstatSync(target); return st.isFile() && !st.isSymbolicLink() && st.size > 0; } catch { return false; }
      };
      this.note(`Fichier annoncé par CapCut : ${target}`, job);
      this.step(job, 'Lancement de l’export natif', 0.26);
      // Consumed before the RPC: a timeout may hide a successful AXPress.
      this.evidence.push({ command: 'press-export-attempt', at: Date.now(), target });
      this.saveEvidence(job);
      const sent = await this.action('press-export', () => this.actions.pressExport(job.name, exportDir, signal), signal);
      check(normalize(sent.outputPath || '') === normalize(target), 'AX_OUTPUT_CHANGED', 'Le fichier annoncé a changé pendant la commande. Aucun nouvel essai.');
      await this.expected('encoding', Math.max(1, s.startSeconds), signal, snapshot =>
        appeared() || (snapshot.complete === true && snapshot.state?.page === 'done'));
      this.step(job, 'Encodage dans CapCut · attente du MP4 final', 0.3);
      const deadline = Date.now() + s.timeoutMinutes * 60000;
      let validation = null, lastProbeError = null;
      while (Date.now() < deadline) {
        await this.gate(signal);
        if (appeared()) {
          const before = fs.statSync(target);
          try {
            const probe = await this.actions.probeDuration(target, signal);
            const after = fs.statSync(target);
            const tolerance = Math.max(0.1, 2 / (Number(loaded?.raw?.fps) || 30));
            check(probe.video && Number.isFinite(probe.duration) && probe.duration > 0 && Math.abs(probe.duration - expectedDuration) <= tolerance,
              'EXPORT_DURATION', `Durée MP4 incohérente : ${probe.duration} s au lieu de ${expectedDuration} s.`);
            check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino, 'EXPORT_CHANGED', 'Le MP4 a changé pendant ffprobe.');
            validation = { expectedDuration, actualDuration: probe.duration, tolerance, bytes: after.size, method: 'ffprobe', target }; break;
          } catch (error) {
            if (signal.aborted) throw Object.assign(error, { code: 'CANCELLED' });
            lastProbeError = error;
            if (error.code === 'EXPORT_DURATION') throw error;
          }
        }
        const snapshot = await this.observe(signal);
        const percent = snapshot.complete && snapshot.state?.page === 'encoding' ? snapshot.state.percent : null;
        if (Number.isFinite(percent)) {
          job.stage = `Export CapCut · ${percent} %`; job.progress = 0.3 + 0.6 * percent / 100; this.changed();
        }
        // Percent and the result panel are never evidence of a complete MP4.
        await wait(this.settings.pollMs ?? 500, signal);
      }
      check(validation, 'EXPORT_TIMEOUT', `Le MP4 annoncé n’est pas validé dans le délai.${lastProbeError ? ' ' + lastProbeError.message : ''}`);
      job.output = target; this.evidence.push({ validation });
      this.step(job, 'Fermeture du résultat d’export', 0.94);
      await this.expected('done', Math.max(1,s.dialogSeconds), signal);
      await this.action('close-done', () => this.actions.closeDone(signal), signal);
      await this.expected('editor', Math.max(1,s.dialogSeconds), signal);
      this.step(job, 'Fermeture de CapCut', 0.97);
      await this.quit(job, signal, { force: true });
      Object.assign(job, { status: 'done', stage: 'Terminé', progress: 1 });
      this.note(`Exporté et durée vérifiée : ${path.basename(target)}`, job); this.saveEvidence(job);
    } catch (error) {
      if (job.output) {
        Object.assign(job, { status: 'done', stage: 'Exporté · fermeture non confirmée', progress: 1, warning: error.message });
        error.exported = true;
      }
      this.saveEvidence(job, error); throw error;
    }
  }
}
