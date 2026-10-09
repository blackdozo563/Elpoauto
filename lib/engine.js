import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, EditError } from './errors.js';
import { canonicalRoot, canonicalProject, listProjects, loadProject, mediaPool } from './projects.js';
import { digest, jsonBytes, readJson, transact, listBackups, restore, recoverLock } from './storage.js';
import { parseTimecode, parseScenes, parseSrt, parseTimestampList, planScenes, expandVideos } from './planner.js';
import { cloneVideoSegment, cloneAudioSegment, makeVisualMaterial, makeAudioMaterial, makeVideoTrack, makeAudioTrack, auxAll, cloneSegmentWithAux } from './template.js';
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
  project = p.project;
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

// Native CapCut resources are never invented: they are harvested from the user's
// own projects, where CapCut already downloaded them, and cloned with fresh ids.
export const FAVORITES_PROJECT = /favori|favorite/i;
const KINDS = { transition: 'Transition', effect: 'Effet', filter: 'Filtre' };
const HINTS = { transition: 'Télécharge et utilise cette transition dans CapCut.', effect: 'Applique cet effet dans CapCut, puis ferme le projet.', filter: 'Applique ce filtre dans CapCut, puis ferme le projet.' };
const availableResource = m => typeof m?.path === 'string' && path.isAbsolute(m.path) && fs.existsSync(m.path);
// Library of native resources. A resource can be reusable on a clip (extra_material_refs)
// and/or on its own track spanning the video; both patterns are copied from real projects.
export function harvest(root) {
  const lib = { transition: new Map(), effect: new Map(), filter: new Map() };
  const entry = (kind, m, projectName, favorite) => {
    let e = lib[kind].get(m.effect_id);
    if (!e) {
      const resource = availableResource(m);
      e = { id: m.effect_id, kind, name: String(m.name || KINDS[kind]), category: String(m.category_name || ''), available: !!resource,
        reason: resource ? '' : `Ressource locale absente ou impossible à vérifier. ${HINTS[kind]}`, favorite: false, sources: [], clip: null, track: null };
      lib[kind].set(m.effect_id, e);
    }
    if (!e.available && availableResource(m)) {
      Object.assign(e, { available: true, reason: '', name: String(m.name || KINDS[kind]), clip: null, track: null });
    }
    if (favorite) e.favorite = true;
    if (!e.sources.includes(projectName) && e.sources.length < 5) e.sources.push(projectName);
    return e;
  };
  for (const p of listProjects(root)) {
    let raw;
    try { raw = loadProject(root, p.path).raw; } catch { continue; }
    const favorite = FAVORITES_PROJECT.test(p.name);
    const mats = key => (Array.isArray(raw.materials[key]) ? raw.materials[key] : []).filter(m => m && typeof m.effect_id === 'string' && m.effect_id && typeof m.id === 'string');
    for (const t of mats('transitions')) { const e = entry('transition', t, p.name, favorite); if (!e.available || availableResource(t)) e.clip ||= t; }
    const clipRefs = new Set(raw.tracks.filter(t => t?.type === 'video').flatMap(t => (t.segments || []).flatMap(s => s?.extra_material_refs || [])));
    const effects = new Map(mats('video_effects').map(m => [m.id, m]));
    const filters = new Map(mats('effects').filter(m => m.type === 'filter').map(m => [m.id, m]));
    for (const [kind, pool] of [['effect', effects], ['filter', filters]]) {
      for (const m of pool.values()) if (clipRefs.has(m.id)) { const e = entry(kind, m, p.name, favorite); if (!e.available || availableResource(m)) e.clip ||= m; }
      const trackType = kind === 'effect' ? 'effect' : 'filter';
      let aux = null;
      for (const track of raw.tracks.filter(t => t?.type === trackType && Array.isArray(t.segments))) {
        for (const segment of track.segments) {
          const m = pool.get(segment?.material_id);
          if (!m) continue;
          const e = entry(kind, m, p.name, favorite);
          if (!e.track && (!e.available || availableResource(m))) {
            aux ||= auxAll(raw);
            const { segments, ...shell } = track;
            e.track = { track: shell, segment, material: m, aux: new Map((segment.extra_material_refs || []).filter(id => aux.has(id)).map(id => [id, aux.get(id)])) };
          }
        }
      }
    }
  }
  const sorted = map => [...map.values()].sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name, 'fr'));
  return { transitions: sorted(lib.transition), effects: sorted(lib.effect), filters: sorted(lib.filter) };
}
export const publicEntry = ({ clip, track, ...info }) => ({ ...info, clip: !!clip, track: !!track });
export const catalog = root => harvest(root).transitions;
export const effectsCatalog = root => harvest(root).effects;

export const MOTIONS = ['none', 'in', 'out', 'alternate', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'kenburns'];
const KENBURNS = ['in', 'pan-right', 'out', 'pan-left', 'pan-up', 'pan-down'];
// Scale and position (half-canvas units, y up) at the start and end of a scene.
export function motionFor(kind, sceneIndex, amount) {
  if (kind === 'alternate') kind = sceneIndex % 2 === 0 ? 'in' : 'out';
  if (kind === 'kenburns') kind = KENBURNS[sceneIndex % KENBURNS.length];
  const big = 1 + amount, p = +(amount * 0.9).toFixed(6);
  return {
    in: { s: [1, big], x: [0, 0], y: [0, 0] }, out: { s: [big, 1], x: [0, 0], y: [0, 0] },
    'pan-left': { s: [big, big], x: [p, -p], y: [0, 0] }, 'pan-right': { s: [big, big], x: [-p, p], y: [0, 0] },
    'pan-up': { s: [big, big], x: [0, 0], y: [-p, p] }, 'pan-down': { s: [big, big], x: [0, 0], y: [p, -p] },
  }[kind] || null;
}
// Deterministic order: same project, same choices, same result.
export function seededOrder(count, size, seedText) {
  let seed = 2166136261;
  for (const ch of String(seedText)) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const next = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const out = [];
  for (let i = 0; i < count; i++) {
    let pick = Math.floor(next() * size);
    if (size > 1 && i && pick === out[i - 1]) pick = (pick + 1 + Math.floor(next() * (size - 1))) % size;
    out.push(pick);
  }
  return out;
}

export function prepare(root, project, options = {}) {
  const p = loadProject(root, project); validSchema(p.raw);
  project = p.project;
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
  let music = null;
  if (options.musicPath) {
    music = audios.find(a => a.path === options.musicPath);
    check(music, 'MUSIC_SELECT', 'La musique choisie n’est plus dans le chutier.');
    check(music.path !== audio.path, 'MUSIC_SAME', 'La musique de fond doit être différente de la voix off.');
    check(Number.isSafeInteger(music.durationUs) && music.durationUs >= 1e6, 'MUSIC_DURATION', 'Durée de la musique absente ou inférieure à une seconde.');
  }
  const musicVolume = options.musicVolume ?? 0.2;
  check(Number.isFinite(musicVolume) && musicVolume > 0 && musicVolume <= 1, 'MUSIC_VOLUME', 'Volume de musique attendu : plus de 0 et au maximum 100 %.');
  const used = new Map([audio, ...(music ? [music] : []), ...plan.map(p => p.item)].map(m => [m.path, m]));
  const fingerprints = [];
  for (const m of used.values()) {
    check(fs.existsSync(m.path), 'MEDIA_MISSING', `Fichier introuvable : ${m.name}.`);
    const stat = fs.statSync(m.path);
    check(stat.isFile() && stat.size > 0, 'MEDIA_FILE', `Média vide ou invalide : ${m.name}.`);
    if (m.type !== 'audio') check(Number.isFinite(m.width) && m.width > 0 && Number.isFinite(m.height) && m.height > 0, 'MEDIA_DIMENSIONS', `Dimensions du visuel absentes : ${m.name}. Réimporte-le dans CapCut.`);
    fingerprints.push({ path: m.path, size: stat.size, mtime: stat.mtimeMs, realpath: fs.realpathSync(m.path) });
  }
  const motion = options.motion || 'none';
  check(MOTIONS.includes(motion), 'MOTION', 'Mouvement inconnu.');
  const amount = options.amount ?? 0.06;
  check(Number.isFinite(amount) && amount >= 0 && amount <= 0.25, 'MOTION_AMOUNT', 'Le zoom doit être compris entre 0 et 25 %.');
  const volume = options.videoVolume ?? 0;
  check(Number.isFinite(volume) && volume >= 0 && volume <= 1, 'VOLUME', 'Volume vidéo invalide.');
  let transitionIds = options.transitionIds || [];
  check(Array.isArray(transitionIds) && transitionIds.length <= 40 && transitionIds.every(x => typeof x === 'string'), 'TRANSITION_IDS', 'Sélection de transitions invalide.');
  const transitionSeconds = options.transitionSeconds ?? 0.5;
  check(Number.isFinite(transitionSeconds) && transitionSeconds > 0 && transitionSeconds <= 3, 'TRANSITION_DURATION', 'Durée de transition attendue : plus de 0 et au maximum 3 secondes.');
  const transitionOrder = options.transitionOrder || 'cycle';
  check(['cycle', 'shuffle'].includes(transitionOrder), 'TRANSITION_ORDER', 'Ordre des transitions inconnu.');
  const scopes = ['all', 'alternate', 'first', 'last', 'global'];
  const wanted = (key, max) => {
    const ids = options[key] || [];
    check(Array.isArray(ids) && ids.length <= max && ids.every(x => typeof x === 'string'), 'LIBRARY_IDS', 'Sélection de la bibliothèque invalide.');
    return ids;
  };
  let effectIds = wanted('effectIds', 20), filterIds = wanted('filterIds', 20);
  const effectScope = options.effectScope || 'all', filterScope = options.filterScope || 'global';
  check(scopes.includes(effectScope) && scopes.includes(filterScope), 'EFFECT_SCOPE', 'Portée des effets ou des filtres inconnue.');
  const favorites = options.favorites || {};
  const harvested = transitionIds.length || effectIds.length || filterIds.length || Object.values(favorites).some(Boolean) ? harvest(root) : { transitions: [], effects: [], filters: [] };
  // "Mes favoris": favourites first; transitions fall back to every available one.
  const starred = options.starred || {};
  const auto = (list, fallback) => { const stars = new Set(starred[list === harvested.transitions ? 'transitions' : list === harvested.effects ? 'effects' : 'filters'] || []); const fav = list.filter(e => (e.favorite || stars.has(e.id)) && e.available); return (fav.length ? fav : fallback ? list.filter(e => e.available) : []).map(e => e.id); };
  if (favorites.transitions && !transitionIds.length) transitionIds = auto(harvested.transitions, true);
  if (favorites.effects && !effectIds.length) effectIds = auto(harvested.effects, false);
  if (favorites.filters && !filterIds.length) filterIds = auto(harvested.filters, false);
  const transitions = transitionIds.map(id => harvested.transitions.find(t => t.id === id)).filter(Boolean);
  check(new Set(transitionIds).size === transitions.length && transitions.every(t => t.available && t.clip), 'TRANSITION_RESOURCE', 'Une transition sélectionnée est absente ou sa ressource locale est indisponible.');
  const pick = (ids, list, scope, label) => {
    const chosen = ids.map(id => list.find(e => e.id === id)).filter(Boolean);
    check(new Set(ids).size === chosen.length && chosen.every(e => e.available), 'EFFECT_RESOURCE', `${label} sélectionné est absent ou sa ressource locale est indisponible.`);
    const missing = chosen.find(e => !(scope === 'global' ? e.track : e.clip));
    check(!missing, 'EFFECT_PATTERN', `${missing?.name} : ${scope === 'global' ? 'utilisé seulement sur des clips dans CapCut. Choisis une portée par scène.' : 'utilisé seulement sur toute la vidéo dans CapCut. Choisis « Toute la vidéo ».'}`);
    return chosen;
  };
  const effects = pick(effectIds, harvested.effects, effectScope, 'Un effet');
  const filters = pick(filterIds, harvested.filters, filterScope, 'Un filtre');
  const resources = [...new Set([...transitions, ...effects, ...filters].flatMap(e => [e.clip?.path, e.track?.material?.path]).filter(Boolean))].map(file => {
    const stat = fs.statSync(file);
    return { path: file, size: stat.size, mtime: stat.mtimeMs, realpath: fs.realpathSync(file) };
  });
  const seed = p.meta.value.draft_id || p.raw.id || project;
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
  if (music) warnings.push(`Musique de fond : ${music.name} à ${Math.round(musicVolume * 100)} %${music.durationUs < audio.durationUs ? ', répétée pour couvrir la voix off' : ', coupée à la fin de la voix off'}.`);
  if (/^pan|kenburns/.test(motion)) warnings.push('Panoramiques : positions écrites en keyframes. Vérifie le cadrage dans ta version de CapCut.');
  if (effects.length || filters.length) warnings.push(`Bibliothèque CapCut : ${[...effects, ...filters].map(e => e.name).join(', ')}. Rejoués par CapCut ; l’export ELPO ne reproduit ni effets ni filtres.`);
  if (transitions.length && favorites.transitions && !options.transitionIds?.length) warnings.push(`Transitions : ${transitions.some(t => t.favorite || (starred.transitions || []).includes(t.id)) ? 'tes favoris' : 'aucun favori, toutes les transitions disponibles'} (${transitions.length}).`);
  warnings.push('Raccords alignés sur les images du projet : un horaire peut être arrondi d’une demi-image.');
  warnings.push('Format JSON reconnu ; rendu et compatibilité avec ta version précise de CapCut à confirmer sur Mac.');
  const draft = buildDraft(p.raw, { audio, plan, clips, motion, amount, volume, transitions, transitionSeconds, transitionOrder, effects, effectScope, filters, filterScope, music, musicVolume, seed });
  const imported = flow ? [...new Map(plan.map(s => [s.item.path, s.item])).values()] : [];
  const changes = changesFor(p, draft, imported);
  const sourceHashes = [ ...p.entries, p.meta, ...(p.index ? [p.index] : []), ...(p.tpEntry ? [p.tpEntry] : []) ].map(e => ({ path: e.path, hash: e.hash }));
  const clipCounts = new Map();
  for (const c of clips) clipCounts.set(c.index, (clipCounts.get(c.index) || 0) + 1);
  const rows = plan.map(s => ({ index: s.index + 1, name: s.item.name, path: s.item.path, type: s.item.type,
    startUs: s.startUs, endUs: s.endUs, durationUs: s.durationUs, sourceUs: s.item.durationUs || null,
    sourceInUs: s.sourceInUs || 0, clips: clipCounts.get(s.index),
    text: s.text || captions.filter(c => c.startUs < s.endUs && c.endUs > s.startUs).map(c => c.text).join(' ') }));
  const token = digest(jsonBytes({ sourceHashes, fingerprints, resources, options }));
  return { draft, changes, fingerprints, resources, sourceHashes, root: p.root, project, token,
    report: { token, name: p.meta.value.draft_name || path.basename(project), scenes: plan.length, clips: clips.length, durationUs: audio.durationUs,
      audioPath: audio.path, playbackClips: clips.map(c => ({ path: c.item.path, type: c.item.type, startUs: c.startUs, endUs: c.endUs, sourceStartUs: c.sourceStartUs, scene: c.index + 1 })),
      fps: p.raw.fps, canvas: p.raw.canvas_config, audio: audio.name, warnings, rows,
      transitions: transitions.length, effects: effects.length, filters: filters.length, music: music?.name || null, motion,
      captions: captions.length, filesToWrite: changes.map(c => path.relative(p.root, c.path)) } };
}

const keyframes = (property_type, durationUs, from, to) => ({ id: capcutUuid(), material_id: '', property_type,
  keyframe_list: [[0, from], [durationUs, to]].map(([time_offset, value]) => ({ id: capcutUuid(), curveType: 'Line', time_offset,
    left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 }, values: [value], string_value: '', graphID: '' })) });
const lerp = (pair, f) => +(pair[0] + (pair[1] - pair[0]) * f).toFixed(9);

function buildDraft(raw, { audio, plan, clips, motion, amount, volume, transitions, transitionSeconds, transitionOrder = 'cycle', effects = [], effectScope = 'all', filters = [], filterScope = 'global', music = null, musicVolume = 0.2, seed = '' }) {
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
    const m = motion !== 'none' && amount > 0 ? motionFor(motion, c.index, amount) : null;
    if (m) {
      // Fractions are scene-relative, so repeated clips of one scene move continuously.
      const scene = plan[c.index], f0 = (c.startUs - scene.startUs) / scene.durationUs, f1 = (c.endUs - scene.startUs) / scene.durationUs;
      segment.common_keyframes = ['KFTypeScaleX', 'KFTypeScaleY'].map(k => keyframes(k, c.durationUs, lerp(m.s, f0), lerp(m.s, f1)));
      if (m.x[0] || m.x[1]) segment.common_keyframes.push(keyframes('KFTypePositionX', c.durationUs, lerp(m.x, f0), lerp(m.x, f1)));
      if (m.y[0] || m.y[1]) segment.common_keyframes.push(keyframes('KFTypePositionY', c.durationUs, lerp(m.y, f0), lerp(m.y, f1)));
    }
    appendAux(aux); vt.segments.push(segment);
  }
  const extraTracks = [];
  for (const [list, scope, key] of [[effects, effectScope, 'video_effects'], [filters, filterScope, 'effects']]) {
    if (!list.length) continue;
    out.materials[key] ||= [];
    const selected = plan.map(s => s.index).filter(i => scope === 'all' || scope === 'global' || (scope === 'alternate' && i % 2 === 0) || (scope === 'first' && i === 0) || (scope === 'last' && i === plan.length - 1));
    const chosenFor = new Map(selected.map((scene, k) => [scene, list[k % list.length]]));
    if (scope !== 'global') {
      for (const [i, c] of clips.entries()) {
        const chosen = chosenFor.get(c.index);
        if (!chosen) continue;
        const mat = { ...structuredClone(chosen.clip), id: capcutUuid() };
        out.materials[key].push(mat); vt.segments[i].extra_material_refs.push(mat.id);
      }
      continue;
    }
    // Whole video: one span when a single item is chosen, otherwise one span per scene.
    const spans = list.length === 1 ? [{ item: list[0], startUs: 0, durationUs: audio.durationUs }] : plan.map(s => ({ item: chosenFor.get(s.index), startUs: s.startUs, durationUs: s.durationUs }));
    const shell = structuredClone(list[0].track.track);
    const track = { ...shell, id: capcutUuid(), segments: [] };
    for (const span of spans) {
      const mat = { ...structuredClone(span.item.track.material), id: capcutUuid() };
      out.materials[key].push(mat);
      const { segment, aux } = cloneSegmentWithAux(span.item.track.segment, span.item.track.aux);
      segment.material_id = mat.id; segment.target_timerange = { start: span.startUs, duration: span.durationUs };
      segment.render_index = track.segments.length;
      appendAux(aux); track.segments.push(segment);
    }
    extraTracks.push(track);
  }
  if (transitions.length) {
    const order = transitionOrder === 'shuffle' ? seededOrder(plan.length, transitions.length, seed) : null;
    for (let i = 0; i < vt.segments.length - 1; i++) {
      if (clips[i].index === clips[i + 1].index) continue;
      const boundary = clips[i].index;
      const chosen = transitions[order ? order[boundary] : boundary % transitions.length];
      const duration = Math.min(Math.round(transitionSeconds * 1e6), Math.floor(clips[i].durationUs / 2), Math.floor(clips[i + 1].durationUs / 2));
      check(duration >= Math.floor(1e6 / raw.fps), 'TRANSITION_TOO_SHORT', 'Une scène est trop courte pour la transition choisie.');
      const mat = { ...structuredClone(chosen.clip), id: capcutUuid(), duration };
      out.materials.transitions.push(mat); vt.segments[i].extra_material_refs.push(mat.id);
    }
  }
  const { segment, aux } = cloneAudioSegment(raw, { materialId: am.id, startUs: 0, durationUs: audio.durationUs });
  appendAux(aux); at.segments.push(segment);
  // Keep all existing empty tracks; append explicit generated tracks.
  out.tracks.push(vt, at, ...extraTracks); out.duration = audio.durationUs;
  if (music) {
    let mm = out.materials.audios.find(m => m.path === music.path);
    if (!mm) { mm = makeAudioMaterial(music); out.materials.audios.push(mm); }
    const mt = makeAudioTrack();
    // Loop whole passes of the music; the last pass is trimmed at the end of the voice.
    for (let start = 0; start < audio.durationUs; start += music.durationUs) {
      const durationUs = Math.min(music.durationUs, audio.durationUs - start);
      const piece = cloneAudioSegment(raw, { materialId: mm.id, startUs: start, durationUs });
      piece.segment.volume = musicVolume; piece.segment.last_nonzero_volume = musicVolume; piece.segment.render_index = mt.segments.length;
      appendAux(piece.aux); mt.segments.push(piece.segment);
    }
    check(mt.segments.length <= 2000, 'MUSIC_LOOPS', 'Musique trop courte pour cette voix off.');
    out.tracks.push(mt);
  }
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

export const VOICE = /voix|voice|narrat|vo[-_ .]|_vo\b|^vo\b|speech|parole|lecture/;
const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function pickAudio(audios, rule = { mode: 'longest' }) {
  const usable = audios.filter(a => Number.isSafeInteger(a.durationUs) && a.durationUs > 0);
  const longest = list => list.reduce((best, a) => !best || a.durationUs > best.durationUs ? a : best, null);
  if (rule.mode === 'single') return usable.length === 1 ? usable[0] : null;
  // Auto: a name that says "voice", otherwise the only audio; never guess between several.
  if (rule.mode === 'auto') { const named = usable.filter(a => VOICE.test(fold(a.name))); return named.length ? longest(named) : usable.length === 1 ? usable[0] : null; }
  if (rule.mode === 'name') {
    const needle = fold(rule.pattern || '').trim();
    return needle ? longest(usable.filter(a => fold(a.name).includes(needle))) : null;
  }
  return longest(usable);
}

export class Engine {
  constructor({ root, backupDir, guard = requireClosed, visualFolders = {} }) {
    this.root = canonicalRoot(root); this.backupDir = backupDir; this.guard = guard; this.pending = null;
    this.visualFolders = new Map(Object.entries(visualFolders).flatMap(([project, folder]) => {
      if (typeof folder !== 'string') return [];
      try { return [[canonicalProject(this.root, project), folder]]; } catch { return []; }
    }));
  }
  inspect(project) {
    project = canonicalProject(this.root, project);
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
    project = loadProject(this.root, project).project;
    const scanned = folder === null ? null : scanFlowFolder(folder);
    this.pending = null;
    if (scanned) this.visualFolders.set(project, scanned.folder); else this.visualFolders.delete(project);
    return this.inspect(project);
  }
  preview(project, options) {
    this.pending = null;
    project = canonicalProject(this.root, project);
    check(!listBackups(this.backupDir, this.root).some(b => ['pending', 'recovery-required', 'restore-pending'].includes(b.status)), 'RECOVERY_PENDING', 'Une opération interrompue doit être récupérée avant de générer un nouveau montage.');
    this.pending = prepare(this.root, project, { ...options, visualFolder: this.visualFolders.get(project) || null }); return this.pending.report;
  }
  commit(token) {
    const p = this.pending;
    check(p && p.token === token, 'PREVIEW_REQUIRED', 'Analyse le projet avant de générer le montage.');
    this.pending = null;
    return this.write(p);
  }
  // Batch: every project gets the same checks as a single build, one transaction each.
  batchPreview(projects, options = {}, rules = {}) {
    this.batch = new Map();
    check(Array.isArray(projects) && projects.length > 0 && projects.length <= 200 && projects.every(x => typeof x === 'string'), 'BATCH_SIZE', 'Sélectionne entre 1 et 200 projets.');
    check(!listBackups(this.backupDir, this.root).some(b => ['pending', 'recovery-required', 'restore-pending'].includes(b.status)), 'RECOVERY_PENDING', 'Une opération interrompue doit être récupérée avant de générer un nouveau montage.');
    const { scenesText, srtText, timestampsText, audioPath, musicPath, ...shared } = options;
    const placement = shared.placement || 'auto';
    check(['auto', 'even', 'timecode'].includes(placement), 'PLACEMENT', 'En lot, le placement est automatique, par ordre naturel ou par horaires dans les noms.');
    return projects.map(project => {
      let name = path.basename(project);
      try {
        project = canonicalProject(this.root, project);
        const info = this.inspect(project); name = info.name;
        check(!info.flowError, 'FLOW_FOLDER', info.flowError);
        check(!info.nonempty, 'NONEMPTY_TIMELINE', 'Timeline déjà remplie : projet ignoré.');
        const voice = pickAudio(info.audios, rules.voice || { mode: 'auto' });
        check(voice, 'AUDIO_SELECT', info.audios.length > 1 ? 'Plusieurs audios et aucun nom de voix off reconnu : choisis la règle « Nom contenant… » ou « le plus long ».' : 'Voix off introuvable avec la règle choisie.');
        const music = rules.music?.mode === 'name' ? pickAudio(info.audios.filter(a => a.path !== voice.path), rules.music, null) : null;
        const prepared = prepare(this.root, project, { ...shared, placement: placement === 'auto' ? info.suggestedPlacement : placement,
          audioPath: voice.path, musicPath: music?.path, visualFolder: this.visualFolders.get(project) || null });
        this.batch.set(project, prepared);
        const r = prepared.report;
        return { project, name, ok: true, token: r.token, scenes: r.scenes, clips: r.clips, durationUs: r.durationUs, audio: r.audio, music: r.music, warnings: r.warnings };
      } catch (e) { return { project, name, ok: false, error: { code: e.code || 'ERROR', message: e.message } }; }
    });
  }
  batchCommit(tokens) {
    check(this.batch?.size && Array.isArray(tokens), 'PREVIEW_REQUIRED', 'Prépare le lot avant de générer.');
    const jobs = [...this.batch.values()].filter(p => tokens.includes(p.token));
    this.batch = null;
    const results = [];
    const indexPath = path.join(this.root, 'root_meta_info.json');
    const indexSources = jobs.flatMap(p => p.sourceHashes.filter(s => s.path === indexPath));
    const baseline = indexSources[0]?.hash;
    check(indexSources.every(s => s.hash === baseline), 'PROJECT_CHANGED', 'L’index a changé pendant la préparation du lot. Relance l’analyse.');
    let expectedIndexHash = baseline;
    for (const p of jobs) {
      try {
        const indexChange = p.changes.find(c => c.path === indexPath);
        if (indexChange) {
          const current = readJson(indexPath);
          check(current.hash === expectedIndexHash, 'PROJECT_CHANGED', 'L’index a été modifié en dehors du lot. Relance l’analyse.');
          const planned = JSON.parse(indexChange.bytes.toString('utf8'));
          const meta = JSON.parse(p.changes.find(c => c.path === path.join(p.project, 'draft_meta_info.json')).bytes.toString('utf8'));
          const matches = index => index.all_draft_store.filter(e => (typeof e.draft_fold_path === 'string' && path.resolve(e.draft_fold_path) === p.project) || (meta.draft_id && e.draft_id === meta.draft_id));
          const oldEntry = matches(planned), newEntry = matches(current.value);
          check(oldEntry.length === 1 && newEntry.length === 1, 'INDEX_MATCH', 'Entrée de projet ambiguë dans l’index du lot.');
          // Rebase only this project's two intended fields on our previous commit.
          // Every external change is still rejected by the full SHA256 check above.
          newEntry[0].tm_duration = oldEntry[0].tm_duration;
          newEntry[0].tm_draft_modified = oldEntry[0].tm_draft_modified;
          indexChange.expectedHash = current.hash; indexChange.bytes = jsonBytes(current.value);
          p.sourceHashes.find(s => s.path === indexPath).hash = current.hash;
        }
        results.push({ project: p.project, name: p.report.name, ok: true, ...this.write(p) });
        if (indexChange) expectedIndexHash = digest(indexChange.bytes);
      }
      catch (e) {
        results.push({ project: p.project, name: p.report.name, ok: false, error: { code: e.code || 'ERROR', message: e.message } });
        // An interrupted write must be recovered before touching anything else.
        if (['RECOVERY_REQUIRED', 'CAPCUT_OPEN', 'PROCESS_UNKNOWN', 'PLATFORM', 'LOCKED'].includes(e.code)) {
          for (const rest of jobs.slice(results.length)) results.push({ project: rest.project, name: rest.report.name, ok: false, error: { code: 'SKIPPED', message: 'Non traité : le lot a été arrêté.' } });
          break;
        }
      }
    }
    return results;
  }
  overview() {
    const built = new Set(listBackups(this.backupDir, this.root).filter(b => b.status === 'committed').map(b => b.project));
    return listProjects(this.root).map(p => {
      const cover = ['draft_cover.jpg', 'draft_cover.png'].map(n => path.join(p.path, n)).find(f => fs.existsSync(f)) || null;
      const base = { path: p.path, name: p.name, mtime: p.mtime, cover, visualFolder: this.visualFolders.get(p.path) || null, elpo: built.has(p.path) };
      try {
        const { raw, meta } = loadProject(this.root, p.path);
        const pool = (() => { try { return mediaPool(meta.value); } catch { return []; } })();
        const segments = raw.tracks.reduce((n, t) => n + (t.segments?.length || 0), 0);
        return { ...base, readable: true, fps: raw.fps, canvas: raw.canvas_config, durationUs: Number.isFinite(raw.duration) ? raw.duration : 0,
          segments, nonempty: segments > 0, visuals: pool.filter(m => m.type !== 'audio').length, audios: pool.filter(m => m.type === 'audio').length };
      } catch (e) { return { ...base, readable: false, error: e.message }; }
    });
  }
  write(p) {
    this.guard();
    for (const resource of p.resources || []) {
      check(fs.existsSync(resource.path), 'TRANSITION_RESOURCE', 'Une ressource de style a disparu depuis l’aperçu. Relance l’analyse.');
      const stat = fs.statSync(resource.path);
      check(stat.size === resource.size && stat.mtimeMs === resource.mtime && fs.realpathSync(resource.path) === resource.realpath,
        'TRANSITION_RESOURCE', 'Une ressource de style a changé depuis l’aperçu. Relance l’analyse.');
    }
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
