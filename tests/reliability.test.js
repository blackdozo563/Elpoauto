import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { bumpProject } from '../lib/capcut-pilot.js';
import { listBackups, restore } from '../lib/storage.js';
import { ExportQueue } from '../lib/export-queue.js';
import { renderPlan } from '../lib/render.js';
import { Engine } from '../lib/engine.js';

test('pilote : sauvegarde des horodatages et restauration exacte', () => {
  const f = fixture();
  try {
    const before = [f.metaFile, f.indexFile].map(p => fs.readFileSync(p));
    const result = bumpProject(f.root, f.project, 123456, { backupDir: f.backupDir, guard: () => {} });
    assert.equal(result.files, 2);
    assert.equal(listBackups(f.backupDir, f.root)[0].status, 'committed');
    restore({ root: f.root, backupDir: f.backupDir, backupId: result.backupId });
    [f.metaFile, f.indexFile].forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i]));
  } finally { f.cleanup(); }
});

test('pilote : interruption entre les deux écritures rétablit les deux fichiers', () => {
  const f = fixture();
  try {
    const before = [f.metaFile, f.indexFile].map(p => fs.readFileSync(p));
    let calls = 0;
    assert.throws(() => bumpProject(f.root, f.project, 123456, { backupDir: f.backupDir,
      guard: () => { if (++calls === 3) throw new Error('Interruption simulée'); } }), /Interruption simulée/);
    [f.metaFile, f.indexFile].forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i]));
    assert.equal(listBackups(f.backupDir, f.root)[0].status, 'rolled-back');
    assert.equal(fs.existsSync(path.join(f.root, '.elpo-autocapcut.lock')), false);
  } finally { f.cleanup(); }
});

test('export : dossier temporaire indisponible devient un échec visible', async () => {
  const f = fixture();
  try {
    const queue = new ExportQueue({ plan: () => assert.fail('Plan non appelé'), tool: {}, tmp: path.join(f.temp, 'absent') });
    const done = new Promise(resolve => queue.once('idle', resolve));
    queue.add([{ path: f.project, name: 'Test' }], { outputDir: f.temp });
    const [job] = await done;
    assert.equal(job.status, 'failed'); assert.match(job.error, /ENOENT/);
    assert.equal(queue.active(), false);
  } finally { f.cleanup(); }
});

test('export : fichier existant préservé et annulation finale sans publication', async () => {
  const f = fixture();
  try {
    const engine = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    engine.commit(engine.preview(f.project, {}).token);
    const outputDir = path.join(f.temp, 'exports'); fs.mkdirSync(outputDir);
    const existing = path.join(outputDir, 'Test.mp4'); fs.writeFileSync(existing, 'original');
    const queue = new ExportQueue({ plan: async p => renderPlan(f.root, p), tool: { filters: {}, encoders: { libx264: true } }, tmp: f.temp });
    queue.spawn = async (job, step) => { fs.writeFileSync(step.output, 'rendered'); };
    let done = new Promise(resolve => queue.once('idle', resolve));
    queue.add([{ path: f.project, name: 'Test' }], { outputDir });
    const [job] = await done;
    assert.equal(job.status, 'done', job.error);
    assert.equal(path.basename(job.output), 'Test (2).mp4');
    assert.equal(fs.readFileSync(existing, 'utf8'), 'original');
    assert.equal(fs.readFileSync(job.output, 'utf8'), 'rendered');
    assert.deepEqual(fs.readdirSync(outputDir).filter(p => p.startsWith('.elpo-')), []);
    queue.spawn = async (job, step) => { fs.writeFileSync(step.output, 'rendered'); queue.cancel(job.id); };
    done = new Promise(resolve => queue.once('idle', resolve));
    queue.add([{ path: f.project, name: 'Cancelled' }], { outputDir });
    const jobs = await done;
    assert.equal(jobs.at(-1).status, 'cancelled');
    assert.equal(fs.existsSync(path.join(outputDir, 'Cancelled.mp4')), false);
  } finally { f.cleanup(); }
});
