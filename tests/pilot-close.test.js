// Closing CapCut after an export. Real-world failure fixed in 0.6.4: the export finished,
// then CapCut kept its "export finished" panel open, refused to quit, the job was marked
// failed although the video existed, and every following project failed the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { CapcutPilot } from '../lib/capcut-pilot.js';
import { closePoint } from '../lib/capcut-ui.js';

const FAST = { tile: { x: 10, y: 10 }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, stableSeconds: 0, quitSeconds: 1 };

// A CapCut that shows a modal panel after each export. While it is up, quit is ignored.
// `panel` decides what dismisses it: 'escape' (first Escape works), 'click' (only the
// panel's close button), or 'never' (only a forced quit ends CapCut).
function stubbornCapcut(exportDir, { panel = 'click', killable = true, corrupt = null, open = false } = {}) {
  const log = []; let running = open, modal = false, n = 0;
  const panelUi = { windows: [{ title: 'CapCut', frame: { x: 0, y: 0, width: 1200, height: 800 }, nodes: [
    { role: 'AXStaticText', name: 'MainWindowTitleBarExportBtn', description: '', position: [1000, 20], size: [70, 22] },
    { role: 'AXButton', name: '', description: 'ExportSuccessCloseBtn', position: [800, 300], size: [40, 40] },
  ] }] };
  const actions = {
    accessibility: async () => true, isRunning: async () => running,
    launch: async () => { log.push('launch'); running = true; }, activate: async () => {},
    quit: async () => { log.push(modal ? 'quit refusé' : 'quit'); if (!modal) running = false; },
    forceQuit: async hard => {
      log.push(hard ? 'kill' : 'term');
      if (corrupt) fs.writeFileSync(corrupt, '{"cut');
      if (killable || hard) { running = false; modal = false; }
    },
    click: async (p, double) => { log.push(`click ${p.x},${p.y}${double ? ' double' : ''}`); if (modal && panel === 'click' && p.x === 820 && p.y === 320) modal = false; },
    shortcut: async () => log.push('⌘E'),
    key: async k => {
      log.push(`key ${k}`);
      if (k === 'return') { n++; fs.writeFileSync(path.join(exportDir, `Test ELPO${n > 1 ? `(${n - 1})` : ''}.mp4`), 'x'.repeat(1000)); modal = true; }
      if (k === 'escape' && modal && panel === 'escape') modal = false;
    },
    playable: async () => true,
  };
  return { log, actions, panelUi, setReadUi: () => { actions.readUi = async () => panelUi; } };
}

test('fermeture : le panneau « export terminé » est fermé par son bouton, puis CapCut quitte', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const c = stubbornCapcut(exportDir, { panel: 'click' });
    const pilot = new CapcutPilot({ root: f.root, actions: c.actions, settings: FAST });
    // The interface becomes readable once the export is written (the pre-export UI
    // checks are covered elsewhere): only the closing reads it here.
    const key = c.actions.key; c.actions.key = async k => { await key(k); if (k === 'return') c.setReadUi(); };
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.stage, 'Terminé');
    assert.ok(c.log.includes('click 820,320'), c.log.join(' / '));
    assert.ok(!c.log.includes('term') && !c.log.includes('kill'), 'aucune fermeture forcée nécessaire');
    assert.equal(c.log.at(-1), 'quit');
    assert.ok(pilot.log.some(l => /ExportSuccessCloseBtn/i.test(l.text)), 'les identifiants du panneau sont journalisés');
  } finally { f.cleanup(); }
});

test('fermeture : CapCut qui ne quitte jamais est fermé de force, le lot continue', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const c = stubbornCapcut(exportDir, { panel: 'never' });
    const pilot = new CapcutPilot({ root: f.root, actions: c.actions, settings: FAST });
    const jobs = await pilot.run([{ path: f.project, name: 'Test ELPO' }, { path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.deepEqual(jobs.map(j => j.status), ['done', 'done'], jobs.map(j => j.error).join(' / '));
    assert.equal(c.log.filter(l => l === 'term').length, 2);
    assert.equal(c.log.filter(l => l === 'launch').length, 2, 'le second projet est bien ouvert');
    assert.equal(fs.readdirSync(exportDir).filter(n => n.endsWith('.mp4')).length, 2);
  } finally { f.cleanup(); }
});

test('fermeture forcée : un fichier du projet abîmé par l’arrêt est rétabli', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const c = stubbornCapcut(exportDir, { panel: 'never', corrupt: f.draftFile });
    const before = fs.readFileSync(f.draftFile, 'utf8');
    const pilot = new CapcutPilot({ root: f.root, actions: c.actions, settings: FAST });
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(fs.readFileSync(f.draftFile, 'utf8'), before);
    assert.ok(pilot.log.some(l => /rétabli/.test(l.text)));
  } finally { f.cleanup(); }
});

test('fermeture : une vidéo exportée reste « terminée » même si CapCut ne peut pas être fermé', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const c = stubbornCapcut(exportDir, { panel: 'never', killable: false });
    c.actions.forceQuit = async hard => { c.log.push(hard ? 'kill' : 'term'); };
    const pilot = new CapcutPilot({ root: f.root, actions: c.actions, settings: FAST });
    const jobs = await pilot.run([{ path: f.project, name: 'Test ELPO' }, { path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(jobs[0].status, 'done');
    assert.match(jobs[0].output, /Test ELPO\.mp4$/);
    assert.match(jobs[0].warning, /même de force/);
    assert.equal(jobs[1].status, 'cancelled', 'le lot s’arrête au lieu d’échouer projet après projet');
    assert.equal(c.log.filter(l => l === 'launch').length, 1);
  } finally { f.cleanup(); }
});

test('fermeture : un CapCut ouvert par l’utilisateur avant le lot n’est jamais fermé de force', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const c = stubbornCapcut(exportDir, { panel: 'never', open: true });
    // The user's CapCut is busy with a modal of its own.
    c.actions.quit = async () => { c.log.push('quit refusé'); };
    const pilot = new CapcutPilot({ root: f.root, actions: c.actions, settings: FAST });
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /ne s’est pas fermé/);
    assert.ok(!c.log.includes('term') && !c.log.includes('kill'));
  } finally { f.cleanup(); }
});

test('closePoint : ne vise jamais un bouton qui lance un export', () => {
  const win = nodes => ({ windows: [{ title: 'CapCut', frame: { x: 0, y: 0, width: 1200, height: 800 }, nodes }] });
  assert.equal(closePoint(win([{ role: 'AXButton', description: 'ExportOkBtn', position: [0, 0], size: [10, 10] }])), null);
  assert.deepEqual(closePoint(win([
    { role: 'AXStaticText', name: 'Fermer', position: [100, 100], size: [20, 20] },
    { role: 'AXButton', description: 'ExportDoneBtn', position: [200, 200], size: [20, 20] },
  ])), { x: 210, y: 210 }, 'un identifiant de bouton passe avant un simple texte');
  assert.deepEqual(closePoint(win([{ role: 'AXButton', name: 'Terminé', position: [0, 0], size: [40, 20] }])), { x: 20, y: 10 });
});
