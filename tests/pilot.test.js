import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { CapcutPilot, bumpProject, missingMedia, listVideos } from '../lib/capcut-pilot.js';
import { readJson } from '../lib/storage.js';

function fakeActions(exportDir, { subfolder = false } = {}) {
  const log = []; let open = true;
  return { log, actions: {
    accessibility: async () => true, isRunning: async () => open,
    quit: async () => { log.push('quit'); open = false; }, launch: async () => { log.push('launch'); open = true; }, activate: async () => {},
    click: async (p, double) => log.push(`click ${p.x},${p.y}${double ? ' double' : ''}`),
    shortcut: async (k, m) => log.push(`shortcut ${m.join('+')}+${k}`),
    key: async k => { log.push(`key ${k}`); if (k === 'return') { const dir = subfolder ? path.join(exportDir, 'Projet') : exportDir; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'Test ELPO.mov'), 'x'.repeat(1000)); } },
    playable: async () => true } };
}
test('pilote : projet en tête de liste, export, fermeture, retour à la liste', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const { log, actions } = fakeActions(exportDir, { subfolder: true });
    const pilot = new CapcutPilot({ root: f.root, actions, settings: { tile: { x: 400, y: 300 }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, stableSeconds: 0, quitSeconds: 1 } });
    const before = Date.now();
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'done', job.error); assert.match(job.output, /Projet\/Test ELPO\.mov$/);
    assert.deepEqual(log, ['quit', 'launch', 'click 400,300 double', 'shortcut command+e', 'key return', 'key escape', 'quit']);
    assert.ok(readJson(f.metaFile).value.tm_draft_modified >= before * 1000);
    assert.ok(readJson(f.indexFile).value.all_draft_store[0].tm_draft_modified >= before * 1000);
    assert.equal(readJson(f.indexFile).value.all_draft_store[1].tm_duration, 12);
  } finally { f.cleanup(); }
});
test('pilote : médias manquants détectés avant d’ouvrir CapCut', async () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.items[0].file_Path);
    assert.deepEqual(missingMedia(f.project), ['scene-1.png']);
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const { log, actions } = fakeActions(exportDir);
    const pilot = new CapcutPilot({ root: f.root, actions, settings: { tile: { x: 1, y: 1 }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, stableSeconds: 0, quitSeconds: 1 } });
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /introuvable/); assert.ok(!log.includes('launch'));
    pilot.settings.missing = 'continue'; log.length = 0;
    const [again] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(again.status, 'done', again.error); assert.deepEqual(log.slice(1, 3), ['click 1,1 double', 'key escape']);
    assert.equal(listVideos(exportDir).length, 1);
  } finally { f.cleanup(); }
});
test('pilote : calibrage requis et projet hors dossier refusé', async () => {
  const f = fixture();
  try {
    const pilot = new CapcutPilot({ root: f.root, actions: fakeActions(f.temp).actions });
    await assert.rejects(pilot.run([{ path: f.project, name: 'x' }], { exportDir: f.temp }), e => e.code === 'PILOT_CALIBRATION');
    assert.throws(() => bumpProject(f.root, f.temp), e => e.code === 'PROJECT_PATH');
  } finally { f.cleanup(); }
});
