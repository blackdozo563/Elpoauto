import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { Engine, catalog } from '../lib/engine.js';
import { readJson } from '../lib/storage.js';

function secondProject(f) {
  const project = path.join(f.root, 'second'); fs.cpSync(f.project, project, { recursive: true });
  const id = randomUUID();
  f.write(path.join(project, 'draft_content.json'), { ...f.raw, id });
  f.write(path.join(project, 'draft_meta_info.json'), { ...f.meta, draft_id: id, draft_fold_path: project, draft_name: 'Second' });
  const index = readJson(f.indexFile).value;
  index.all_draft_store.push({ draft_id: id, draft_fold_path: project, tm_duration: 0 }); f.write(f.indexFile, index);
  return project;
}
test('lot : deux projets générés sans conflit avec notre propre index global', () => {
  const f = fixture();
  try {
    const second = secondProject(f), e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    const previews = e.batchPreview([f.project, second], { placement: 'even' });
    assert(previews.every(p => p.ok));
    const results = e.batchCommit(previews.map(p => p.token));
    assert(results.every(p => p.ok), JSON.stringify(results));
    assert.equal(readJson(path.join(second, 'draft_content.json')).value.duration, 30000000);
    const index = readJson(f.indexFile).value;
    assert.equal(index.all_draft_store.find(p => p.draft_fold_path === f.project).tm_duration, 30000000);
    assert.equal(index.all_draft_store.find(p => p.draft_fold_path === second).tm_duration, 30000000);
    assert.equal(index.all_draft_store.find(p => p.draft_id === 'other').tm_duration, 12);
  } finally { f.cleanup(); }
});
test('lot : une modification externe de l’index bloque les deux écritures', () => {
  const f = fixture();
  try {
    const second = secondProject(f), e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    const previews = e.batchPreview([f.project, second], { placement: 'even' });
    const index = readJson(f.indexFile).value; index.all_draft_store[1].tm_duration = 99; f.write(f.indexFile, index);
    const results = e.batchCommit(previews.map(p => p.token));
    assert(results.every(p => !p.ok && p.error.code === 'PROJECT_CHANGED'));
    assert.equal(readJson(f.draftFile).value.duration, 0);
    assert.equal(readJson(path.join(second, 'draft_content.json')).value.duration, 0);
    assert.equal(readJson(f.indexFile).value.all_draft_store[1].tm_duration, 99);
  } finally { f.cleanup(); }
});
test('bibliothèque : copie disponible préférée ; ressource disparue bloque le commit', () => {
  const f = fixture();
  try {
    const resource = path.join(f.temp, 'transition'); fs.mkdirSync(resource);
    f.raw.materials.transitions = [{ id: 'T1', effect_id: 'E', path: '/missing-resource' }, { id: 'T2', effect_id: 'E', path: resource }]; f.write(f.draftFile, f.raw);
    assert.equal(catalog(f.root)[0].available, true); assert.equal(catalog(f.root)[0].clip.path, resource);
    const e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    const preview = e.preview(f.project, { transitionIds: ['E'] }); fs.rmSync(resource, { recursive: true });
    assert.throws(() => e.commit(preview.token), x => x.code === 'TRANSITION_RESOURCE');
    assert.equal(readJson(f.draftFile).value.duration, 0);
  } finally { f.cleanup(); }
});
