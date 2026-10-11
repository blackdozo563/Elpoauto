// Closing CapCut after an export, on the screens of the real recording. CapCut 9.3.0
// refuses to quit while its export sheet is open: the pilot closes the end panel by its
// own « Fermer » (automationcloseBtn) and, only when ELPO launched CapCut itself, falls
// back to a forced close that protects the project files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { simulatedCapcut, FAST } from './capcut-sim.js';
import { CapcutPilot } from '../lib/capcut-pilot.js';

function setup(options = {}) {
  const f = fixture();
  const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
  const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', ...options });
  const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: FAST });
  return { f, exportDir, sim, pilot, two: [{ path: f.project, name: 'Test ELPO' }, { path: f.project, name: 'Test ELPO' }] };
}

test('fermeture : AXPress sans effet sur Mac — clic natif, éditeur confirmé, sortie normale', async () => {
  const { f, exportDir, sim, pilot } = setup({ requireCloseMouse: true });
  const press = sim.driver.press; const closeCalls = [];
  sim.driver.press = async args => { if (args.label === 'automationcloseBtn') closeCalls.push(args); return press(args); };
  try {
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(sim.log.slice(-2), ['press automationcloseBtn', 'quit']);
    assert.ok(!sim.log.includes('quit refusé'));
    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].mouse, true);
    assert.ok(!sim.log.includes('term') && !sim.log.includes('kill'));
    assert.ok(pilot.log.some(l => l.text.includes('Éditeur CapCut confirmé après fermeture')));
  } finally { f.cleanup(); }
});

test('fermeture : panneau resté ouvert — refermé par son bouton, sinon fermeture forcée protégée, le lot continue', async () => {
  const { f, exportDir, sim, pilot, two } = setup();
  try {
    // « Fermer » refused once: CapCut keeps its panel and ignores the polite quit.
    const press = sim.driver.press; let refused = 0;
    sim.driver.press = async args => (args.label === 'automationcloseBtn' && refused++ < 1 ? { ok: false, code: 'WRONG_VIEW', message: 'Panneau pas encore prêt.', commandAttempted: false } : press(args));
    const jobs = await pilot.run(two, { exportDir });
    assert.deepEqual(jobs.map(j => j.status), ['done', 'done'], jobs.map(j => j.error).join(' / '));
    assert.ok(sim.log.includes('quit refusé'));
    assert.equal(sim.log.filter(l => l === 'launch').length, 2, 'le second projet est bien ouvert');
  } finally { f.cleanup(); }
});

test('fermeture forcée : un fichier du projet abîmé par l’arrêt est rétabli', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', quitRefusedWhile: ['settings', 'exporting', 'done', 'error', 'editor'], corrupt: f.draftFile });
    const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: FAST });
    const before = fs.readFileSync(f.draftFile, 'utf8');
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.ok(sim.log.includes('term'));
    assert.equal(fs.readFileSync(f.draftFile, 'utf8'), before);
    assert.ok(pilot.log.some(l => /rétabli/.test(l.text)));
  } finally { f.cleanup(); }
});

test('fermeture : une vidéo exportée reste « terminée » même si CapCut ne peut pas être fermé', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', quitRefusedWhile: ['editor', 'done'], unkillable: true });
    const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: FAST });
    const jobs = await pilot.run([{ path: f.project, name: 'Test ELPO' }, { path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(jobs[0].status, 'done');
    assert.match(jobs[0].output, /Test ELPO\.mp4$/);
    assert.match(jobs[0].warning, /même de force/);
    assert.equal(jobs[1].status, 'cancelled', 'le lot s’arrête au lieu d’échouer projet après projet');
    assert.equal(sim.log.filter(l => l === 'launch').length, 1);
  } finally { f.cleanup(); }
});

test('fermeture : un CapCut ouvert par l’utilisateur avant le lot n’est jamais fermé de force', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', open: true, quitRefusedWhile: ['home', 'editor'] });
    const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: FAST });
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /ne s’est pas fermé/);
    assert.ok(!sim.log.includes('term') && !sim.log.includes('kill'));
  } finally { f.cleanup(); }
});

test('fermeture : feuille de réglages restée ouverte — refermée par « Annuler », jamais pendant un export', async () => {
  const { f, exportDir, sim, pilot } = setup({ layout: 'cut', firstTile: 'Autre projet' });
  try {
    await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(sim.state().page, 'settings', 'erreur d’identité : CapCut laissé sur la feuille');
    await pilot.quit(null, new AbortController().signal, { force: true });
    assert.ok(sim.log.includes('press automationcancel'));
    assert.equal(sim.state().running, false);
  } finally { f.cleanup(); }
});

test('fermeture : jamais de fermeture forcée pendant qu’un export encode', async () => {
  const { f, exportDir, sim, pilot } = setup({ stuck: 50 });
  try {
    const running = pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    for (let i = 0; i < 400 && sim.state().page !== 'exporting'; i++) await new Promise(r => setTimeout(r, 5));
    await assert.rejects(pilot.quit(null, new AbortController().signal, { force: true }), e => e.code === 'CAPCUT_STUCK' && /exporte encore/.test(e.message));
    assert.ok(!sim.log.includes('term') && !sim.log.includes('kill'));
    pilot.stop(); await running;
  } finally { f.cleanup(); }
});
