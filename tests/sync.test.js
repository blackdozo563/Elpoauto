import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupCues, boundary, split, merge, clipAt } from '../lib/sync.js';
import { parseSrt, planScenes, expandVideos } from '../lib/planner.js';
import { Engine } from '../lib/engine.js';
import { fixture } from './fixtures.js';
const srt = '1\n00:00:01,000 --> 00:00:03,000\nVoici une idée\n\n2\n00:00:03,000 --> 00:00:05,000\nqui se termine.\n\n3\n00:00:06,000 --> 00:00:08,000\nAutre idée.\n\n4\n00:00:09,000 --> 00:00:11,000\nConclusion.';
test('regroupement des phrases : couverture audio, pauses et silence initial', () => {
  const plan = groupCues(parseSrt(srt), 12000000, 6);
  assert.equal(plan.scenes[0].start, 0); assert.equal(plan.scenes.at(-1).end, 12);
  assert.equal(plan.scenes[0].text, 'Voici une idée qui se termine.');
  assert.equal(plan.scenes[0].end, 6);
  assert.ok(plan.scenes.every((s, i) => !i || s.start === plan.scenes[i - 1].end));
  assert.ok(plan.scenes.every(s => s.file === ''));
});
test('SRT dépassant la voix off et cible invalide sont refusés', () => {
  assert.throws(() => groupCues(parseSrt(srt), 10000000, 6));
  assert.throws(() => groupCues(parseSrt(srt), 12000000, NaN));
  assert.throws(() => groupCues([], 12000000));
});
test('déplacer, découper et fusionner conserve une couverture exacte', () => {
  const plan = { version: 1, scenes: [{ file: 'a', start: 0, end: 6, text: 'A' }, { file: 'b', start: 6, end: 12, text: 'B' }] };
  boundary(plan, 1, 5.123); assert.equal(plan.scenes[0].end, 5.123);
  assert.throws(() => boundary(plan, 1, 12));
  split(plan, 1, 9); assert.equal(plan.scenes[2].start, 9); assert.equal(plan.scenes[2].file, 'b'); assert.equal(plan.scenes[2].text, '');
  merge(plan, 0); assert.equal(plan.scenes[0].file, 'a'); assert.equal(plan.scenes[0].text, 'A B'); assert.equal(plan.scenes[0].end, 9);
  assert.throws(() => split(plan, 0, 9)); assert.throws(() => merge(plan, 1));
});
test('vidéo : entrée source, répétitions et sélection du clip au raccord', () => {
  const items = [{ name: 'x.mp4', path: '/x.mp4', type: 'video', durationUs: 8000000 }];
  const plan = planScenes(items, 10000000, { placement: 'scenes', scenes: { version: 1, scenes: [{ file: '/x.mp4', start: 0, end: 10, sourceIn: 3 }] } });
  assert.throws(() => expandVideos(plan));
  const clips = expandVideos(plan, { videoPolicy: 'repeat' });
  assert.equal(clips.length, 2); assert.ok(clips.every(c => c.sourceStartUs === 3000000 && c.sourceStartUs + c.sourceDurationUs <= 8000000));
  assert.equal(clipAt(clips, 5), clips[1]); assert.equal(clipAt(clips, 10), null); assert.equal(clipAt(clips, -.1), null);
  assert.throws(() => planScenes(items, 10000000, { placement: 'scenes', scenes: { version: 1, scenes: [{ file: '/x.mp4', start: 0, end: 10, sourceIn: -1 }] } }));
});
test('plan voix édité → aperçu → JSON CapCut → restauration exacte', () => {
  const f = fixture({ mac: true, mirror: true, visuals: ['scene-1.png', 'scene-2.mp4'], totalUs: 12000000 });
  try {
    const original = fs.readFileSync(f.draftFile), e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    const plan = groupCues(parseSrt(srt), 12000000, 4); merge(plan, 1); boundary(plan, 1, 5.123);
    plan.scenes.forEach((s, i) => { s.file = f.items[i].file_Path; }); plan.scenes[1].sourceIn = 2;
    const r = e.preview(f.project, { placement: 'scenes', scenesText: JSON.stringify(plan), videoPolicy: 'repeat' });
    assert.equal(r.playbackClips.length, 3); assert.equal(r.audioPath, f.items[2].file_Path);
    const result = e.commit(r.token); const draft = JSON.parse(fs.readFileSync(f.draftFile));
    const visuals = draft.tracks.find(t => t.type === 'video').segments;
    assert.deepEqual(visuals.map(s => ({ startUs: s.target_timerange.start, endUs: s.target_timerange.start + s.target_timerange.duration, sourceStartUs: s.source_timerange.start })), r.playbackClips.map(c => ({ startUs: c.startUs, endUs: c.endUs, sourceStartUs: c.sourceStartUs })));
    e.restore(result.backupId); assert.deepEqual(fs.readFileSync(f.draftFile), original);
  } finally { f.cleanup(); }
});
