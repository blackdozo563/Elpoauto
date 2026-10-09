import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './fixtures.js';
import { Engine } from '../lib/engine.js';
import { fidelity } from '../lib/fidelity.js';
import { readJson } from '../lib/storage.js';

const built = f => {
  const e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
  e.commit(e.preview(f.project, {}).token);
  return e;
};
const edit = (f, change) => { const draft = readJson(f.draftFile).value; change(draft); fs.writeFileSync(f.draftFile, JSON.stringify(draft)); };

test('fidélité : un montage ELPO part sur l’export ELPO', () => {
  const f = fixture();
  try {
    const [r] = built(f).fidelity([f.project]);
    assert.equal(r.engine, 'elpo'); assert.deepEqual(r.reasons, []); assert.equal(r.empty, false);
  } finally { f.cleanup(); }
});
test('fidélité : titres, filtres, rotation et pistes superposées partent via CapCut', () => {
  const f = fixture();
  try {
    const e = built(f);
    edit(f, d => {
      d.tracks.push({ type: 'text', segments: [{ id: 't1', material_id: 'txt' }] });
      d.materials.effects = [{ id: 'flt', type: 'filter' }];
      const v = d.tracks.find(t => t.type === 'video');
      v.segments[0].extra_material_refs.push('flt');
      v.segments[1].clip.rotation = 12;
      d.tracks.push({ type: 'video', segments: [{ ...v.segments[0], id: 'overlay' }] });
    });
    const [r] = e.fidelity([f.project]);
    assert.equal(r.engine, 'capcut');
    for (const reason of ['textes ou titres', 'filtres', 'rotation', 'pistes vidéo superposées']) assert.ok(r.reasons.includes(reason), reason);
  } finally { f.cleanup(); }
});
test('fidélité : timeline vide ignorée, projet illisible confié à CapCut', () => {
  const f = fixture();
  try {
    const e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    assert.deepEqual(e.fidelity([f.project])[0], { project: f.project, engine: null, empty: true, reasons: [], notes: [] });
    fs.writeFileSync(f.draftFile, '{ chiffré');
    assert.deepEqual(e.fidelity([f.project])[0].reasons, ['format non lu par ELPO']);
    assert.throws(() => e.fidelity('x'), err => err.code === 'BATCH_SIZE');
  } finally { f.cleanup(); }
});
test('fidélité : approximations signalées sans changer de moteur', () => {
  const raw = { tracks: [{ type: 'video', segments: [{ material_id: 'v', extra_material_refs: ['tr', 'cv'], clip: { scale: { x: 1.1, y: 1.1 }, rotation: 0, alpha: 1 } }] },
    { type: 'audio', segments: [{ material_id: 'a', extra_material_refs: ['fade'] }] }],
    materials: { videos: [{ id: 'v', type: 'photo' }], transitions: [{ id: 'tr' }], canvases: [{ id: 'cv', type: 'canvas_color', blur: 0, image: '' }], audio_fades: [{ id: 'fade', fade_in_duration: 500000 }] } };
  const r = fidelity(raw);
  assert.equal(r.engine, 'elpo');
  assert.deepEqual(r.notes, ['transitions rendues par des équivalents FFmpeg', 'fondus audio non reproduits']);
  raw.materials.canvases[0].type = 'canvas_blur';
  assert.deepEqual(fidelity(raw).reasons, ['fond flou ou image de fond']);
});
