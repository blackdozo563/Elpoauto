import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, EditError } from './errors.js';
import { canonicalRoot, listProjects, loadProject, mediaPool } from './projects.js';
import { digest, jsonBytes, readJson, transact, listBackups, restore, recoverLock } from './storage.js';
import { parseTimecode, parseScenes, parseSrt, parseTimestampList, planScenes, expandVideos } from './planner.js';
import { cloneVideoSegment, cloneAudioSegment, makeVisualMaterial, makeAudioMaterial, makeVideoTrack, makeAudioTrack, auxAll } from './template.js';
import { capcutUuid } from './uuid.js';
import { scanFlowFolder } from './flow-folder.js';

export function capcutState(platform = process.platform) {
  check(platform === 'darwin', 'PLATFORM', 'Cette édition est prévue pour macOS.');
  try { execFileSync('/usr/bin/pgrep', ['-x', 'CapCut'], { stdio: 'ignore', timeout: 5000 }); return 'open'; }
  catch (e) { if (e.status === 1) return 'closed'; throw new EditError('PROCESS_UNKNOWN', 'Impossible de vérifier la fermeture de CapCut. Aucune écriture autorisée.'); }
}
export const requireClosed = () => check(capcutState() === 'closed', 'CAPCUT_OPEN', 'Quitte complètement CapCut avant toute écriture ou restauration.');
const materialArrays = raw => Object.entries(raw.materials || {}).filter(([, a]) => Array.isArray(a));
function validSchema(raw) {
  check(raw.tracks.every(t => t && typeof t.type === 'string' && Array.isArray(t.segments)), 'TRACK_SCHEMA', 'Une piste du projet possède un format inconnu.');
  check(raw.tracks.every(t => t.segments.length === 0), 'NONEMPTY_TIMELINE', 'La timeline doit être vide. Duplique ton projet dans CapCut, vide les pistes de la copie, puis ferme CapCut.');
  check(Number.isFinite(raw.fps) && raw.fps >= 1 && raw.fps <= 120, 'FPS', 'Fréquence du projet absente ou non reconnue.');
  check(raw.canvas_config && Number.isFinite(raw.canvas_config.width) && raw.canvas_config.width > 0 && Number.isFinite(raw.canvas_config.height) && raw.canvas_config.height > 0, 'CANVAS', 'Dimensions du projet non reconnues.');
  for (const key of ['videos', 'audios']) check(raw.materials[key] === undefined || Array.isArray(raw.materials[key]), 'MATERIAL_SCHEMA', `Format de matériaux inconnu : ${key}.`);
  const ids = materialArrays(raw).flatMap(([, a]) => a.map(m => m?.id).filter(Boolean));
  check(new Set(ids).size === ids.length, 'DUPLICATE_ID', 'Le projet possède des identifiants de matériaux en double.');
}

export function inspect(root, project, visualFolder = null) {
  const p = loadProject(root, project);
  const pool = mediaPool(p.meta.value);
  const flow = visualFolder ? scanFlowFolder(visualFolder) : null;
  const visuals = flow ? flow.visuals : pool.filter(x => x.type !== 'audio');
  const audios = pool.filter(x => x.type === 'audio');
  const allTimecodes = visuals.length > 0 && visuals.every(x => parseTimecode(x.name) !== null);
  const marks = visuals.map(x => parseTimecode(x.name));
  const suggestedPlacement = allTimecodes && marks.includes(0) && new Set(marks).size === marks.length ? 'timecode' : 'even';
  return { project, path: project, name: p.meta.value.draft_name || path.basename(project), fps: p.raw.fps, canvas: p.raw.canvas_config,
    visuals, audios, visualFolder: flow?.folder || null, ignoredFiles: flow?.ignored || 0,
    nonempty: p.raw.tracks.some(t => t.segments?.length), suggestedPlacement,
  };
}

export function catalog(root) {
  const byId = new Map();
  for (const p of listProjects(root)) {
    let raw;
    try { raw = loadProject(root, p.path).raw; } catch { continue; }
    for (const t of raw.materials.transitions || []) {
      if (!t || typeof t.effect_id !== 'string' || !t.effect_id || byId.has(t.effect_id)) continue;
      const resource = typeof t.path === 'string' && path.isAbsolute(t.path) && fs.existsSync(t.path);
      byId.set(t.effect_id, { id: t.effect_id, name: String(t.name || 'Transition'), category: String(t.category_name || ''), available: !!resource,
        reason: resource ? '' : 'Ressource locale absente ou impossible à vérifier. Télécharge et utilise cette transition dans CapCut.', template: t });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export function prepare(root, project, options = {}) {
  const p = loadProject(root, project); validSchema(p.raw);
  const pool = mediaPool(p.meta.value);
  const flow = options.visualFolder ? scanFlowFolder(options.visualFolder) : null;
  const visuals = flow ? flow.visuals : pool.filter(m => m.type !== 'audio');
  const audios = pool.filter(m => m.type === 'audio');
  const audio = audios.find(a => a.path === options.audioPath) || (audios.length === 1 && !options.audioPath ? audios[0] : null);
  check(audio, 'AUDIO_SELECT', 'Choisis explicitement la voix off dans la liste des audios.');
  check(Number.isSafeInteger(audio.durationUs) && audio.durationUs > 0, 'AUDIO_DURATION', 'La durée de la voix off est absente ou invalide.');
  const scenes = options.scenesText ? parseScenes(options.scenesText) : null;
  const captions = options.srtText ? parseSrt(options.srtText) : [];
  const timestamps = options.placement === 'timestamps' ? parseTimestampList(options.timestampsText || '') : [];
  check(!captions.length || captions.at(-1).endUs <= audio.durationUs + 1000, 'SRT_DURATION', 'Le SRT dépasse la durée de la voix off.');
  const plan = planScenes(visuals, audio.durationUs, { placement: options.placement || 'even', fps: p.raw.fps, scenes, captions, timestamps });
  const clips = expandVideos(plan, { videoPolicy: options.videoPolicy || 'reject', fps: p.raw.fps });
  const used = new Map([audio, ...plan.map(p => p.item)].map(m => [m.path, m]));
  const fingerprints = [];
  for (const m of used.values()) {
    check(fs.existsSync(m.path), 'MEDIA_MISSING', `Fichier introuvable : ${m.name}.`);
    const stat = fs.statSync(m.path);
    check(stat.isFile() && stat.size > 0, 'MEDIA_FILE', `Média vide ou invalide : ${m.name}.`);
    if (m.type !== 'audio') check(Number.isFinite(m.width) && m.width > 0 && Number.isFinite(m.height) && m.height > 0, 'MEDIA_DIMENSIONS', `Dimensions du visuel absentes : ${m.name}. Réimporte-le dans CapCut.`);
    fingerprints.push({ path: m.path, size: stat.size, mtime: stat.mtimeMs, realpath: fs.realpathSync(m.path) });
  }
  const motion = options.motion || 'none';
  check(['none', 'in', 'out', 'alternate'].includes(motion), 'MOTION', 'Mouvement inconnu.');
  const amount = options.amount ?? 0.06;
  check(Number.isFinite(amount) && amount >= 0 && amount <= 0.25, 'MOTION_AMOUNT', 'Le zoom doit être compris entre 0 et 25 %.');
  const volume = options.videoVolume ?? 0;
  check(Number.isFinite(volume) && volume >= 0 && volume <= 1, 'VOLUME', 'Volume vidéo invalide.');
  const transitionIds = options.transitionIds || [];
  check(Array.isArray(transitionIds) && transitionIds.length <= 40 && transitionIds.every(x => typeof x === 'string'), 'TRANSITION_IDS', 'Sélection de transitions invalide.');
  const transitionSeconds = options.transitionSeconds ?? 0.5;
  check(Number.isFinite(transitionSeconds) && transitionSeconds > 0 && transitionSeconds <= 3, 'TRANSITION_DURATION', 'Durée de transition attendue : plus de 0 et au maximum 3 secondes.');
  const transitions = transitionIds.length ? catalog(root).filter(t => transitionIds.includes(t.id)) : [];
  check(new Set(transitionIds).size === transitions.length && transitions.every(t => t.available), 'TRANSITION_RESOURCE', 'Une transition sélectionnée est absente ou sa ressource locale est indisponible.');
  const warnings = [];
  if (flow) warnings.push(`Images du dossier Flow : ${flow.visuals.length}. Gardez ce dossier accessible : les médias sont référencés, pas copiés.`);
  if (flow?.ignored) warnings.push(`${flow.ignored} entrée(s) hors images prises en charge, cachées ou sous-dossiers ne sont pas importées.`);
  const unused = visuals.filter(m => !used.has(m.path));
  if (unused.length) warnings.push(`${unused.length} visuel(s) non utilisés par le fichier de scènes : ${unused.map(m => m.name).slice(0, 8).join(', ')}.`);
  if (audios.length > 1) warnings.push(`Seule la voix off choisie est placée. Les ${audios.length - 1} autres audios restent dans le chutier.`);
  if (clips.length > plan.length) warnings.push(`Répétition choisie : ${plan.length} scènes deviennent ${clips.length} clips. Les transitions restent uniquement aux changements de scène.`);
  if (captions.length) warnings.push('Le SRT sert ici de repère dans l’aperçu. Cette édition ne crée pas encore de piste de captions.');
  if (options.placement === 'srt') warnings.push('Association SRT : un bloc par visuel, dans l’ordre naturel des noms. Le premier visuel commence à zéro et le dernier finit avec la voix off. Vérifie chaque association.');
  const ratio = p.raw.canvas_config.width / p.raw.canvas_config.height;
  if (plan.some(s => Math.abs(s.item.width / s.item.height / ratio - 1) > 0.03)) warnings.push('Certains visuels ont un ratio différent du projet. Contrôle leur cadrage dans CapCut.');
  warnings.push('Raccords alignés sur les images du projet : un horaire peut être arrondi d’une demi-image.');
  warnings.push('Format JSON reconnu ; rendu et compatibilité avec ta version précise de CapCut à confirmer sur Mac.');
  const draft = buildDraft(p.raw, { audio, plan, clips, motion, amount, volume, transitions, transitionSeconds });
  const imported = flow ? [...new Map(plan.map(s => [s.item.path, s.item])).values()] : [];
  const changes = changesFor(p, draft, imported);
  const sourceHashes = [ ...p.entries, p.meta, ...(p.index ? [p.index] : []), ...(p.tpEntry ? [p.tpEntry] : []) ].map(e => ({ path: e.path, hash: e.hash }));
  const clipCounts = new Map();
  for (const c of clips) clipCounts.set(c.index, (clipCounts.get(c.index) || 0) + 1);
  const rows = plan.map(s => ({ index: s.index + 1, name: s.item.name, path: s.item.path, type: s.item.type,
    startUs: s.startUs, endUs: s.endUs, durationUs: s.durationUs, sourceUs: s.item.durationUs || null,
    sourceInUs: s.sourceInUs || 0, clips: clipCounts.get(s.index),
    text: s.text || captions.filter(c => c.startUs < s.endUs && c.endUs > s.startUs).map(c => c.text).join(' ') }));
  const token = digest(jsonBytes({ sourceHashes, fingerprints, options }));
  return { draft, changes, fingerprints, sourceHashes, root: p.root, project, token,
    report: { token, name: p.meta.value.draft_name || path.basename(project), scenes: plan.length, clips: clips.length, durationUs: audio.durationUs,
      audioPath: audio.path, playbackClips: clips.map(c => ({ path: c.item.path, type: c.item.type, startUs: c.startUs, endUs: c.endUs, sourceStartUs: c.sourceStartUs, scene: c.index + 1 })),
      fps: p.raw.fps, canvas: p.raw.canvas_config, audio: audio.name, warnings, rows,
      transitions: transitions.length, captions: captions.length, filesToWrite: changes.map(c => path.relative(p.root, c.path)) } };
}

function buildDraft(raw, { audio, plan, clips, motion, amount, volume, transitions, transitionSeconds }) {
  const out = structuredClone(raw);
  for (const key of ['videos', 'audios', 'transitions']) out.materials[key] ||= [];
  const byPath = new Map((out.materials.videos || []).map(m => [m.path, m]));
  const materialIds = new Map();
  for (const { item } of plan) {
    if (materialIds.has(item.path)) continue;
    let mat = byPath.get(item.path);
    if (mat) check(mat.type === item.type && typeof mat.id === 'string', 'MATERIAL_MISMATCH', 'Le type du média importé diffère de celui du projet.');
    else { mat = makeVisualMaterial(item.type === 'photo' ? { ...item, durationUs: undefined } : item); out.materials.videos.push(mat); }
    materialIds.set(item.path, mat.id);
  }
  let am = out.materials.audios.find(m => m.path === audio.path);
  if (!am) { am = makeAudioMaterial(audio); out.materials.audios.push(am); }
  const vt = makeVideoTrack(), at = makeAudioTrack(), auxIndex = auxAll(raw);
  const appendAux = aux => { for (const { __key, ...m } of aux) (out.materials[__key] ||= []).push(m); };
  for (const [i, c] of clips.entries()) {
    const { segment, aux } = cloneVideoSegment(raw, { materialId: materialIds.get(c.item.path), startUs: c.startUs, durationUs: c.durationUs, auxIndex });
    segment.source_timerange = { start: c.sourceStartUs, duration: c.sourceDurationUs };
    segment.speed = 1; segment.is_loop = false; segment.render_index = i; segment.volume = c.item.type === 'video' ? volume : 1;
    if (volume > 0) segment.last_nonzero_volume = volume;
    if (motion !== 'none' && amount > 0) {
      const isIn = motion === 'in' || (motion === 'alternate' && c.index % 2 === 0);
      const atTime = t => 1 + amount * (isIn ? (t - plan[c.index].startUs) / plan[c.index].durationUs : 1 - (t - plan[c.index].startUs) / plan[c.index].durationUs);
      segment.common_keyframes = ['KFTypeScaleX', 'KFTypeScaleY'].map(property_type => ({ id: capcutUuid(), material_id: '', property_type,
        keyframe_list: [[0, atTime(c.startUs)], [c.durationUs, atTime(c.endUs)]].map(([time_offset, value]) => ({ id: capcutUuid(), curveType: 'Line', time_offset,
          left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 }, values: [value], string_value: '', graphID: '' })) }));
    }
    appendAux(aux); vt.segments.push(segment);
  }
  if (transitions.length) {
    for (let i = 0; i < vt.segments.length - 1; i++) {
      if (clips[i].index === clips[i + 1].index) continue;
      const boundary = clips[i].index;
      const chosen = transitions[boundary % transitions.length];
      const duration = Math.min(Math.round(transitionSeconds * 1e6), Math.floor(clips[i].durationUs / 2), Math.floor(clips[i + 1].durationUs / 2));
      check(duration >= Math.floor(1e6 / raw.fps), 'TRANSITION_TOO_SHORT', 'Une scène est trop courte pour la transition choisie.');
      const mat = { ...structuredClone(chosen.template), id: capcutUuid(), duration };
      out.materials.transitions.push(mat); vt.segments[i].extra_material_refs.push(mat.id);
    }
  }
  const { segment, aux } = cloneAudioSegment(raw, { materialId: am.id, startUs: 0, durationUs: audio.durationUs });
  appendAux(aux); at.segments.push(segment);
  // Keep all existing empty tracks; append explicit generated tracks.
  out.tracks.push(vt, at); out.duration = audio.durationUs;
  validateDraft(out, vt, at, clips);
  return out;
}

export function validateDraft(draft, vt, at, clips) {
  const all = new Map();
  for (const [, arr] of materialArrays(draft)) for (const m of arr) {
    if (!m?.id) continue;
    check(!all.has(m.id), 'DUPLICATE_ID', 'Identifiants générés en double.'); all.set(m.id, m);
  }
  let end = 0;
  for (const [i, s] of vt.segments.entries()) {
    check(s.target_timerange.start === end && s.target_timerange.duration > 0, 'TIMELINE_GAP', 'La timeline générée possède un trou ou une durée invalide.');
    end += s.target_timerange.duration;
    check(all.has(s.material_id) && s.extra_material_refs.every(id => all.has(id)), 'REF_MISSING', 'La timeline contient une référence de matériau absente.');
    if (clips[i].item.type === 'video') check(s.source_timerange.duration <= clips[i].item.durationUs, 'SOURCE_OVERFLOW', 'Une durée source vidéo a été dépassée.');
  }
  check(end === draft.duration && at.segments[0].target_timerange.duration === end, 'TIMELINE_END', 'La durée du montage et de la voix off diffèrent.');
}

function changesFor(p, draft, imported = []) {
  const bytes = jsonBytes(draft);
  const changes = p.entries.map(e => ({ path: e.path, expectedHash: e.hash, bytes }));
  const now = Date.now() * 1000;
  const meta = structuredClone(p.meta.value); meta.tm_duration = draft.duration; meta.tm_draft_modified = now;
  if (imported.length) {
    let group = meta.draft_materials.find(g => g.type === 0);
    if (!group) { group = { type: 0, value: [] }; meta.draft_materials.push(group); }
    const present = new Set(meta.draft_materials.flatMap(g => g.value.map(m => m?.file_Path || m?.path)));
    for (const item of imported) if (!present.has(item.path)) {
      group.value.push({ id: capcutUuid(), file_Path: item.path, metetype: 'photo', width: item.width, height: item.height, duration: 0 });
      present.add(item.path);
    }
  }
  changes.push({ path: p.meta.path, expectedHash: p.meta.hash, bytes: jsonBytes(meta) });
  if (p.index) {
    const index = structuredClone(p.index.value);
    check(Array.isArray(index.all_draft_store), 'INDEX_FORMAT', 'Index global CapCut non reconnu.');
    const id = p.meta.value.draft_id || p.raw.id;
    const candidates = index.all_draft_store.filter(e => (typeof e.draft_fold_path === 'string' && path.resolve(e.draft_fold_path) === p.project) || (id && e.draft_id === id));
    check(candidates.length === 1, 'INDEX_MATCH', 'Impossible d’identifier ce projet de manière unique dans l’index CapCut.');
    candidates[0].tm_duration = draft.duration; candidates[0].tm_draft_modified = now;
    changes.push({ path: p.index.path, expectedHash: p.index.hash, bytes: jsonBytes(index) });
  }
  return changes;
}

export class Engine {
  constructor({ root, backupDir, guard = requireClosed, visualFolders = {} }) {
    this.root = canonicalRoot(root); this.backupDir = backupDir; this.guard = guard; this.pending = null;
    this.visualFolders = new Map(Object.entries(visualFolders).filter(([project, folder]) => path.dirname(project) === this.root && typeof folder === 'string'));
  }
  inspect(project) {
    const folder = this.visualFolders.get(project);
    try { return inspect(this.root, project, folder); }
    catch (error) {
      if (!folder || !['FLOW_FOLDER', 'FLOW_COUNT', 'FLOW_FILE', 'IMAGE_FORMAT', 'ENOENT', 'EACCES'].includes(error.code)) throw error;
      // Keep project selection usable so a deleted or invalid folder can be replaced.
      const projectInfo = inspect(this.root, project);
      return { ...projectInfo, visuals: [], visualFolder: folder, ignoredFiles: 0, flowError: error.message };
    }
  }
  setVisualFolder(project, folder) {
    loadProject(this.root, project);
    const scanned = folder === null ? null : scanFlowFolder(folder);
    this.pending = null;
    if (scanned) this.visualFolders.set(project, scanned.folder); else this.visualFolders.delete(project);
    return this.inspect(project);
  }
  preview(project, options) {
    this.pending = null;
    check(!listBackups(this.backupDir, this.root).some(b => ['pending', 'recovery-required', 'restore-pending'].includes(b.status)), 'RECOVERY_PENDING', 'Une opération interrompue doit être récupérée avant de générer un nouveau montage.');
    this.pending = prepare(this.root, project, { ...options, visualFolder: this.visualFolders.get(project) || null }); return this.pending.report;
  }
  commit(token) {
    const p = this.pending;
    check(p && p.token === token, 'PREVIEW_REQUIRED', 'Analyse le projet avant de générer le montage.');
    this.pending = null;
    this.guard();
    for (const source of p.sourceHashes) check(digest(fs.readFileSync(source.path)) === source.hash, 'PROJECT_CHANGED', 'Le projet a changé depuis l’aperçu. Relance l’analyse.');
    for (const m of p.fingerprints) {
      const stat = fs.statSync(m.path);
      check(stat.size === m.size && stat.mtimeMs === m.mtime && fs.realpathSync(m.path) === m.realpath, 'MEDIA_CHANGED', 'Un média a changé depuis l’aperçu. Relance l’analyse.');
    }
    const r = transact({ root: this.root, backupDir: this.backupDir, project: p.project, projectName: p.report.name, changes: p.changes, guard: this.guard });
    return { ...r, scenes: p.report.scenes, clips: p.report.clips };
  }
  backups(project) { return listBackups(this.backupDir, this.root, project); }
  restore(id) { this.pending = null; return restore({ root: this.root, backupDir: this.backupDir, backupId: id, guard: this.guard }); }
  recover() { this.pending = null; recoverLock(this.root, this.guard); return this.backups(); }
  thumbnail(file) {
    check(this.pending?.report.rows.some(r => r.path === file && r.type === 'photo'), 'THUMBNAIL_PATH', 'Ce média ne fait pas partie de l’aperçu.');
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
    check(mime && fs.statSync(file).size < 6e6, 'THUMBNAIL_SIZE', 'Aperçu non disponible pour ce format ou cette taille.');
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }
}
