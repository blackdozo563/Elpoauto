// Export fidelity: can the ELPO render (FFmpeg) reproduce this timeline as CapCut would?
// ELPO renders the first video track (photos, videos, zoom and position keyframes, speed),
// transitions (FFmpeg equivalents) and the audio tracks. Everything else is rendered by CapCut only,
// so the automatic engine sends those projects to the CapCut pilot.
import { loadProject } from './projects.js';

const TRACKS = { text: 'textes ou titres', sticker: 'stickers', effect: 'effets', filter: 'filtres', adjust: 'réglages de couleur' };
const MOVES = new Set(['KFTypeScaleX', 'KFTypeScaleY', 'KFTypePositionX', 'KFTypePositionY']);
const FULL_CROP = { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 };
const fullCrop = m => !m?.crop || Object.entries(FULL_CROP).every(([k, v]) => m.crop[k] === undefined || Math.abs(Number(m.crop[k]) - v) < 1e-6);
const variableSpeed = m => Number(m?.mode || 0) !== 0 || !!m?.curve_speed;

// reasons: what ELPO would lose (→ CapCut). notes: approximations that do not change the engine.
export function fidelity(raw) {
  const reasons = new Set(), notes = new Set(), index = new Map();
  for (const [key, list] of Object.entries(raw?.materials || {})) if (Array.isArray(list)) for (const m of list) if (m?.id) index.set(m.id, { key, m });
  const filled = (Array.isArray(raw?.tracks) ? raw.tracks : []).filter(t => Array.isArray(t?.segments) && t.segments.length);
  const video = filled.filter(t => t.type === 'video');
  if (!video.length) return { engine: null, empty: true, reasons: [], notes: [] };
  if (video.length > 1) reasons.add('pistes vidéo superposées');
  for (const t of filled) if (!['video', 'audio'].includes(t.type)) reasons.add(TRACKS[t.type] || `piste « ${t.type} »`);
  for (const s of video.flatMap(t => t.segments)) {
    const clip = s?.clip || {};
    if (Number(clip.rotation)) reasons.add('rotation');
    if (Number.isFinite(clip.alpha) && clip.alpha < 1) reasons.add('opacité');
    if (clip.flip?.horizontal || clip.flip?.vertical) reasons.add('effet miroir');
    if (clip.scale && Number(clip.scale.x ?? 1) !== Number(clip.scale.y ?? 1)) reasons.add('image étirée');
    if (s?.reverse) reasons.add('lecture inversée');
    if ((s?.common_keyframes || []).some(k => k?.property_type && !MOVES.has(k.property_type) && (k.keyframe_list || []).length)) reasons.add('images clés autres que zoom et position');
    if (!fullCrop(index.get(s?.material_id)?.m)) reasons.add('recadrage');
    for (const id of s?.extra_material_refs || []) {
      const ref = index.get(id);
      if (!ref) continue;
      const { key, m } = ref;
      if (key === 'video_effects') reasons.add('effets');
      else if (key === 'effects') reasons.add(m.type === 'filter' ? 'filtres' : 'réglages de couleur');
      else if (key === 'material_animations' && (m.animations || []).length) reasons.add('animations d’entrée ou de sortie');
      else if (key === 'masks' || key === 'common_mask') reasons.add('masques');
      else if (key === 'chromas') reasons.add('incrustation sur fond vert');
      else if (key === 'canvases' && (m.type === 'canvas_blur' || m.type === 'canvas_image' || Number(m.blur) > 0 || m.image)) reasons.add('fond flou ou image de fond');
      else if (key === 'speeds' && variableSpeed(m)) reasons.add('vitesse variable');
      else if (key === 'transitions') notes.add('transitions rendues par des équivalents FFmpeg');
    }
  }
  for (const s of filled.filter(t => t.type === 'audio').flatMap(t => t.segments)) {
    for (const id of s?.extra_material_refs || []) {
      const ref = index.get(id);
      if (!ref) continue;
      if (ref.key === 'audio_effects') reasons.add('effets audio');
      else if (ref.key === 'speeds' && variableSpeed(ref.m)) reasons.add('vitesse variable');
      else if (ref.key === 'audio_fades' && (Number(ref.m.fade_in_duration) > 0 || Number(ref.m.fade_out_duration) > 0)) notes.add('fondus audio non reproduits');
    }
  }
  return { engine: reasons.size ? 'capcut' : 'elpo', empty: false, reasons: [...reasons], notes: [...notes] };
}

// A project ELPO cannot read is exported by CapCut, which can.
export function projectFidelity(root, project) {
  try { return { project, ...fidelity(loadProject(root, project).raw) }; }
  catch { return { project, engine: 'capcut', empty: false, reasons: ['format non lu par ELPO'], notes: [] }; }
}
