import { check } from './errors.js';

const natural = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const us = seconds => Math.round(seconds * 1e6);
export const basename = name => String(name || '').split(/[\\/]/).pop();

// Bare digits are sequence numbers, NEVER timestamps. Explicit separators required.
export function parseTimecode(name) {
  let stem = basename(name).replace(/\.[^.]+$/, '').replace(/[-_]\d{8,}$/, '');
  const numbered = stem.match(/^\d{3,6}_(\d{2,}-\d{2}-\d{2}[,.]\d{3})(?:[_-]v\d+)?$/);
  if (numbered) return parseTimestampText(numbered[1]);
  const parts = stem.split(/[-_]/);
  if (!parts.every(x => /^\d+$/.test(x))) return null;
  let h = 0, m = 0, s = 0, ms = 0;
  if (parts.length === 2) [m, s] = parts.map(Number);
  else if (parts.length === 3 && parts[2].length === 3) [m, s, ms] = parts.map(Number);
  else if (parts.length === 3) [h, m, s] = parts.map(Number);
  else if (parts.length === 4 && parts[3].length === 3) [h, m, s, ms] = parts.map(Number);
  else return null;
  if (s >= 60 || ((parts.length === 4 || (parts.length === 3 && parts[2].length !== 3)) && m >= 60) || ms >= 1000) return null;
  const result = us(h * 3600 + m * 60 + s + ms / 1000);
  return Number.isSafeInteger(result) ? result : null;
}

export function parseTimestampText(text) {
  const s = String(text).trim();
  if (/^\d+(?:\.\d{1,6})?$/.test(s)) { const n = us(Number(s)); return Number.isSafeInteger(n) ? n : null; }
  const m = s.match(/^(\d{2,})[:-](\d{2})[:-](\d{2})(?:[,.](\d{3}))?$/);
  if (m) { if (+m[2] >= 60 || +m[3] >= 60) return null; const n = us(+m[1] * 3600 + +m[2] * 60 + +m[3] + +(m[4] || 0) / 1000); return Number.isSafeInteger(n) ? n : null; }
  return parseTimecode(s + '.png');
}

export function parseTimestampList(text) {
  const lines = String(text).trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  check(lines.length > 0 && lines.length <= 10000, 'TIMESTAMP_LIST', 'La liste d’horaires doit contenir entre 1 et 10 000 lignes.');
  const times = lines.map(parseTimestampText);
  check(times.every(t => t !== null), 'TIMESTAMP_LIST', 'Un horaire est invalide. Utilise HH:MM:SS,mmm ou des secondes décimales.');
  return times;
}

export function parseScenes(text) {
  let obj;
  try { obj = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { check(false, 'SCENES_JSON', 'Le fichier de scènes doit être un JSON valide.'); }
  check(obj && obj.version === 1 && Array.isArray(obj.scenes) && obj.scenes.length > 0 && obj.scenes.length <= 10000,
    'SCENES_SCHEMA', 'Format attendu : version 1 et liste scenes non vide (maximum 10 000).');
  return obj;
}

export function parseSrt(text) {
  const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/);
  const result = [];
  const pattern = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*$/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    const match = i >= 0 ? lines[i].match(pattern) : null;
    check(match && lines.slice(i + 1).join('\n').trim(), 'SRT_INVALID', 'Un bloc SRT est vide ou possède un horaire invalide.');
    const n = match.slice(1).map(Number);
    check(n[1] < 60 && n[2] < 60 && n[5] < 60 && n[6] < 60, 'SRT_INVALID', 'Minutes ou secondes SRT invalides.');
    const startUs = us(n[0] * 3600 + n[1] * 60 + n[2] + n[3] / 1000);
    const endUs = us(n[4] * 3600 + n[5] * 60 + n[6] + n[7] / 1000);
    check(endUs > startUs && (!result.length || startUs >= result.at(-1).endUs), 'SRT_OVERLAP', 'Le SRT contient des horaires inversés ou des passages qui se chevauchent.');
    result.push({ startUs, endUs, text: lines.slice(i + 1).join('\n').trim() });
  }
  check(result.length > 0 && result.length <= 50000, 'SRT_SIZE', 'Le SRT est vide ou trop volumineux.');
  return result;
}

export function planScenes(items, totalUs, { placement = 'even', fps = 30, scenes = null, captions = [], timestamps = [] } = {}) {
  check(items.length > 0 && items.length <= 10000, 'MEDIA_COUNT', 'Il faut entre 1 et 10 000 visuels.');
  check(Number.isSafeInteger(totalUs) && totalUs > 0, 'AUDIO_DURATION', 'La durée de la voix off doit être connue et positive.');
  check(Number.isFinite(fps) && fps >= 1 && fps <= 120, 'FPS', 'Fréquence du projet invalide (1 à 120 images/s).');
  const frame = 1e6 / fps;
  const snap = t => Math.round(Math.round(t / frame) * frame);
  let plan;
  if (placement === 'even') {
    const sorted = [...items].sort((a, b) => natural.compare(a.name, b.name));
    check(totalUs / sorted.length >= frame, 'TOO_MANY_CLIPS', 'Trop de scènes pour cette durée audio.');
    plan = sorted.map((item, i) => ({ item, startUs: snap(totalUs * i / sorted.length), endUs: i === sorted.length - 1 ? totalUs : snap(totalUs * (i + 1) / sorted.length), text: '' }));
  } else if (placement === 'timecode') {
    const parsed = items.map(item => ({ item, startUs: parseTimecode(item.name) }));
    check(parsed.every(p => p.startUs !== null), 'TIMECODE_MISSING', 'Chaque visuel doit avoir un horaire explicite. Aucun fichier ne sera ignoré.', parsed.filter(p => p.startUs === null).map(p => p.item.name));
    parsed.sort((a, b) => a.startUs - b.startUs);
    check(parsed[0].startUs === 0, 'START_NOT_ZERO', 'Le premier visuel doit commencer à 0-00.');
    check(parsed.every((p, i) => p.startUs < totalUs && (i === 0 || p.startUs > parsed[i - 1].startUs)), 'TIMECODE_RANGE', 'Les horaires doivent être uniques et situés avant la fin de la voix off.');
    plan = parsed.map((p, i) => ({ ...p, startUs: snap(p.startUs), endUs: i + 1 < parsed.length ? snap(parsed[i + 1].startUs) : totalUs, text: '' }));
  } else if (placement === 'srt' || placement === 'timestamps') {
    const times = placement === 'srt' ? captions.map(c => c.startUs) : timestamps;
    check(times.length === items.length, 'TIMING_COUNT', `Il faut exactement un ${placement === 'srt' ? 'bloc SRT' : 'horaire'} par visuel : ${times.length} repères pour ${items.length} fichiers.`);
    check(times.length > 0 && times.every((t, i) => Number.isSafeInteger(t) && t >= 0 && t < totalUs && (!i || t > times[i - 1])), 'TIMING_RANGE', 'Les horaires doivent être croissants, uniques et situés avant la fin audio.');
    if (placement === 'timestamps') check(times[0] === 0, 'START_NOT_ZERO', 'Le premier horaire doit être zéro.');
    const sorted = [...items].sort((a, b) => natural.compare(a.name, b.name));
    plan = sorted.map((item, i) => ({ item, startUs: i === 0 ? 0 : snap(times[i]), endUs: i === sorted.length - 1 ? totalUs : snap(times[i + 1]), text: placement === 'srt' ? captions[i].text : '' }));
  } else if (placement === 'scenes') {
    check(scenes?.version === 1 && Array.isArray(scenes.scenes) && scenes.scenes.length > 0 && scenes.scenes.length <= 10000, 'SCENES_REQUIRED', 'Charge un fichier de scènes version 1.');
    const byReference = new Map();
    for (const item of items) for (const key of new Set([item.name, item.path])) { const list = byReference.get(key) || []; list.push(item); byReference.set(key, list); }
    plan = scenes.scenes.map((s, i) => {
      check(typeof s.file === 'string' && s.file.length > 0 && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start,
        'SCENE_INVALID', `Scène ${i + 1} invalide : file, start et end sont requis ; temps en secondes.`);
      const matches = byReference.get(s.file) || [];
      check(matches.length === 1, 'SCENE_MEDIA', `Scène ${i + 1} : média absent ou ambigu : ${s.file}.`);
      check(s.sourceIn === undefined || Number.isFinite(s.sourceIn) && s.sourceIn >= 0, 'SOURCE_IN', `Scène ${i + 1} : point d’entrée source invalide.`);
      return { sourceInUs: us(s.sourceIn || 0), item: matches[0], startUs: us(s.start), endUs: us(s.end), text: typeof s.text === 'string' ? s.text : '' };
    });
    check(plan[0].startUs === 0 && plan.at(-1).endUs === totalUs && plan.every((p, i) => p.endUs <= totalUs && (!i || p.startUs === plan[i - 1].endUs)),
      'SCENES_COVERAGE', 'Les scènes doivent se suivre sans trou ni chevauchement, de 0 jusqu’à la durée exacte de la voix off.');
    plan = plan.map((p, i) => ({ ...p, startUs: snap(p.startUs), endUs: i === plan.length - 1 ? totalUs : snap(p.endUs) }));
  } else check(false, 'PLACEMENT', 'Mode de placement inconnu.');
  check(plan.every(p => p.endUs - p.startUs >= Math.floor(frame)), 'SCENE_TOO_SHORT', 'Une scène est plus courte qu’une image du projet après alignement des horaires.');
  return plan.map((p, index) => ({ ...p, index, durationUs: p.endUs - p.startUs }));
}

export function expandVideos(plan, { videoPolicy = 'reject', fps = 30 } = {}) {
  check(['reject', 'repeat'].includes(videoPolicy), 'VIDEO_POLICY', 'Politique vidéo inconnue.');
  const frame = 1e6 / fps;
  const output = [];
  for (const scene of plan) {
    if (scene.item.type === 'photo') { output.push({ ...scene, sourceStartUs: 0, sourceDurationUs: scene.durationUs }); continue; }
    const sourceInUs = scene.sourceInUs || 0;
    check(Number.isSafeInteger(sourceInUs) && sourceInUs >= 0, 'SOURCE_IN', 'Point d’entrée source invalide.');
    const sourceUs = scene.item.durationUs - sourceInUs;
    check(Number.isSafeInteger(sourceUs) && sourceUs >= frame, 'VIDEO_DURATION', `Durée vidéo absente ou trop courte : ${scene.item.name}.`);
    const full = Math.floor(sourceUs / frame);
    const cap = Math.round(full * frame);
    if (scene.durationUs <= sourceUs) { output.push({ ...scene, sourceStartUs: sourceInUs, sourceDurationUs: scene.durationUs }); continue; }
    check(videoPolicy === 'repeat', 'VIDEO_TOO_SHORT', `${scene.item.name} : source ${(sourceUs / 1e6).toFixed(2)} s, scène ${(scene.durationUs / 1e6).toFixed(2)} s. Choisis la répétition ou change le média.`);
    let startUs = scene.startUs;
    // Split into nearly equal frame-aligned pieces. No tiny final fragment.
    const count = Math.ceil(scene.durationUs / Math.min(sourceUs, cap));
    check(count <= 5000 && output.length + count <= 20000, 'REPEAT_LIMIT', 'Trop de répétitions. Choisis une source plus longue.');
    for (let i = 0; i < count; i++) {
      const endUs = i === count - 1 ? scene.endUs : scene.startUs + Math.round(Math.round(scene.durationUs * (i + 1) / count / frame) * frame);
      const durationUs = endUs - startUs;
      check(durationUs >= Math.floor(frame) && durationUs <= sourceUs, 'VIDEO_SPLIT', 'Impossible de répartir cette vidéo sans dépasser sa source.');
      output.push({ ...scene, startUs, endUs, durationUs, sourceStartUs: sourceInUs, sourceDurationUs: durationUs, repetition: i + 1, repetitions: count });
      startUs = endUs;
    }
  }
  check(output.length <= 20000, 'CLIP_LIMIT', 'Maximum 20 000 clips.');
  return output;
}
