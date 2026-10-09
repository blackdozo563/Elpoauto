import { check } from './errors.js';

// Editorial suggestions only: punctuation, pauses, and a target duration.
export function groupCues(cues, totalUs, targetSeconds = 6) {
  check(Number.isSafeInteger(totalUs) && totalUs > 0 && Number.isFinite(targetSeconds) && targetSeconds >= 2 && targetSeconds <= 30, 'SYNC_DURATION', 'Durée audio ou cible de scènes invalide.');
  check(cues.length > 0 && cues.every((c, i) => Number.isSafeInteger(c.startUs) && c.startUs >= 0 && c.endUs > c.startUs && c.endUs <= totalUs && (!i || c.startUs >= cues[i - 1].endUs)), 'SYNC_CUES', 'Les repères SRT doivent tenir dans la voix off, sans chevauchement.');
  const scenes = []; let start = 0, texts = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], next = cues[i + 1]; texts.push(c.text);
    const end = next ? next.startUs : totalUs, duration = (end - start) / 1e6;
    const sentence = /[.!?…][”"’')\]]*$/.test(c.text.trim());
    if (!next || duration >= targetSeconds * 1.8 || (duration >= targetSeconds * .55 && (sentence || next.startUs - c.endUs >= 450000)) || duration >= targetSeconds && /[,;:]$/.test(c.text.trim())) {
      scenes.push({ file: '', start: start / 1e6, end: end / 1e6, text: texts.join(' ') }); start = end; texts = [];
    }
  }
  return { version: 1, scenes };
}

export function boundary(plan, index, seconds) {
  const rows = plan.scenes;
  check(index > 0 && index < rows.length && Number.isFinite(seconds) && seconds > rows[index - 1].start && seconds < rows[index].end, 'SYNC_BOUNDARY', 'Le raccord doit rester entre le début de la scène précédente et la fin de celle-ci.');
  rows[index - 1].end = seconds; rows[index].start = seconds;
}
export function merge(plan, index) {
  check(index >= 0 && index + 1 < plan.scenes.length, 'SYNC_MERGE', 'Choisis une scène ayant une suivante.');
  const a = plan.scenes[index], b = plan.scenes[index + 1];
  plan.scenes.splice(index, 2, { ...a, end: b.end, text: [a.text, b.text].filter(Boolean).join(' ') });
}
export function split(plan, index, seconds) {
  const a = plan.scenes[index];
  check(a && Number.isFinite(seconds) && seconds > a.start && seconds < a.end, 'SYNC_SPLIT', 'La coupure doit être à l’intérieur de la scène.');
  // Keep text intact for review; do not invent a word-level alignment.
  plan.scenes.splice(index, 1, { ...a, end: seconds }, { ...a, start: seconds, text: '' });
}
export function clipAt(clips, seconds) {
  const t = Math.round(seconds * 1e6);
  return clips.find(c => t >= c.startUs && t < c.endUs) || null;
}
