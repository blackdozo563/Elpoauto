import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fixture } from './fixtures.js';
import { CapcutPilot, snapshotExports, newExports } from '../lib/capcut-pilot.js';
import { homeIsOpen, projectIsOpen, exportDialogIsOpen, controlPoint, exportIsRunning } from '../lib/capcut-ui.js';
import { CAPCUT_UI_SCRIPT } from '../lib/mac-automation.js';

const node = (name, extra = {}) => ({ name, role: 'AXStaticText', ...extra });
const snapshot = (names, title = 'CapCut') => ({ windows: [{ title, nodes: names.map(n => typeof n === 'string' ? node(n) : n) }] });
const home = snapshot(['Accueil', 'Projets', 'Créer un projet', 'Test ELPO']);
const editor = snapshot(['Test ELPO', 'Exporter', 'Médias']);
const dialog = snapshot(['Test ELPO', 'Exporter', 'Résolution', 'Format']);

function setup(options = {}) {
  const f = fixture(), log = [];
  const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
  let page = 'studio', open = false;
  const homePoint = { x: 40, y: 90 }, tile = { x: 200, y: 250 };
  const frame = { x: 0, y: 0, width: 640, height: 480 };
  const actions = {
    accessibility: async () => true, isRunning: async () => open,
    assertClosed: () => assert.equal(open, false),
    launch: async () => { open = true; log.push('launch'); },
    activate: async () => {}, quit: async () => { open = false; log.push('quit'); },
    restoreWindow: async value => { log.push(['restore', value]); },
    windowFrame: async () => options.badFrame ? { ...frame, width: 800 } : frame,
    readUi: async () => {
      if (options.unreadable) throw new Error('Accessibilité refusée');
      if (page === 'studio') return snapshot([node('Accueil', { role: 'AXButton', position: [20, 80], size: [40, 20] }), 'Studio de conceptions', 'Inspiration']);
      if (page === 'home') return home;
      if (page === 'editor') return options.wrongProject ? snapshot(['Autre projet', 'Exporter', 'Médias']) : editor;
      return options.noDialog ? editor : dialog;
    },
    click: async (point, double) => {
      log.push(['click', point, double]);
      if (point.x === homePoint.x && point.y === homePoint.y) page = 'home';
      else if (point.x === tile.x && point.y === tile.y && !options.stuckHome) page = 'editor';
    },
    shortcut: async () => { log.push('shortcut'); page = 'dialog'; },
    key: async key => {
      log.push(key);
      if (key === 'return' && !options.noFile) fs.writeFileSync(path.join(exportDir, 'Test ELPO.mp4'), 'test video');
    },
    playable: async () => true,
  };
  const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions, settings: {
    tile, frames: { tile: frame }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, stableSeconds: 0, startSeconds: 0, closeKeys: [],
  } });
  return { f, pilot, actions, log, exportDir, projects: [{ path: f.project, name: 'Test ELPO' }] };
}

test('interface CapCut : la présence du projet sur l’accueil ne confirme pas son ouverture', () => {
  assert.equal(homeIsOpen(home), true);
  assert.equal(projectIsOpen(home, 'Test ELPO'), false);
  assert.equal(projectIsOpen(editor, 'Test ELPO'), true);
  assert.equal(projectIsOpen(snapshot(['Test ELPO 2', 'Exporter']), 'Test ELPO'), false);
  assert.equal(projectIsOpen(snapshot(['Exporter'], 'CapCut - Test ELPO'), 'Test ELPO'), true);
  assert.equal(projectIsOpen(snapshot(['Test ELPO', 'Inspiration', 'Créer un projet']), 'Test ELPO'), false);
  assert.equal(projectIsOpen({ windows: [...snapshot(['Studio de conceptions']).windows, ...editor.windows] }, 'Test ELPO'), false);
});

test('interface CapCut 9 réelle : l’accueil est reconnu par ses identifiants d’automatisation', () => {
  // Snapshot relevé sur CapCut 9 (macOS, français), accueil ouvert, 7 projets.
  const text = (name, description) => ({ role: 'AXStaticText', name, description });
  const real = { windows: [{ title: 'CapCut', nodes: [
    text('', 'AccountLogoutBtn'), text('Accueil', 'Accueil'), text('Studio de vidéos', 'Studio de vidéos'),
    text('Studio de conceptions', 'Studio de conceptions'), text('Bibliothèque', 'Bibliothèque'), text('Espaces', 'Espaces'),
    text('HomePageStartProjectName', 'HomePageStartProjectDesp'),
    { role: 'AXButton', name: 'automationrecycleBinBtnSmall', description: '' },
    ...Array.from({ length: 7 }, () => text('', 'HomePageDraft')),
  ] }] };
  assert.equal(homeIsOpen(real), true);
  assert.equal(projectIsOpen(real, 'Test ELPO'), false);
  assert.equal(homeIsOpen(snapshot(['Accueil', 'Studio de conceptions', 'Inspiration'])), false);
  assert.equal(homeIsOpen({ windows: [...snapshot(['Studio de conceptions']).windows, ...real.windows] }), false);
});

test('interface CapCut : le bouton de l’éditeur ne suffit pas à confirmer le dialogue d’export', () => {
  assert.equal(exportDialogIsOpen(editor), false);
  assert.equal(exportDialogIsOpen(dialog), true);
  assert.equal(exportIsRunning(dialog), false);
  assert.equal(exportIsRunning(snapshot(['Exportation', node('Progression', { role: 'AXProgressIndicator' })])), true);
  assert.equal(exportIsRunning(snapshot(['Exporter', 'Médias', node('Chargement audio', { role: 'AXProgressIndicator' })])), false);
  assert.deepEqual(controlPoint(snapshot([node('Accueil', { position: [20, 80], size: [40, 20] })]), ['accueil']), { x: 40, y: 90 });
});

test('lecture JXA : collecte des fenêtres CapCut et exclusion des éléments invisibles', () => {
  const element = (name, children = [], visible = true) => ({ name: () => name, role: () => 'AXStaticText', description: () => '', value: () => name,
    position: () => [20, 80], size: () => [40, 20], enabled: () => true, visible: () => visible, uiElements: () => children });
  const window = element('CapCut', [element('Accueil'), element('Invisible', [], false)]);
  const ui = JSON.parse(vm.runInNewContext(CAPCUT_UI_SCRIPT, { Application: () => ({ processes: { byName: name => {
    assert.equal(name, 'CapCut'); return { windows: () => [window] };
  } } }) }));
  assert.deepEqual(ui.windows[0].nodes.map(n => n.name), ['CapCut', 'Accueil']);
  assert.equal(ui.truncated, false);
});

test('pilote : retour depuis le Studio IA, fenêtre calibrée, projet et dialogue confirmés avant export', async () => {
  const s = setup();
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    const clicks = s.log.filter(Array.isArray).filter(v => v[0] === 'click');
    assert.deepEqual(clicks, [['click', { x: 40, y: 90 }, false], ['click', { x: 200, y: 250 }, true]]);
    assert(s.log.indexOf('shortcut') > s.log.indexOf(clicks[1]));
    assert.ok(s.log.filter(Array.isArray).some(v => v[0] === 'restore'));
  } finally { s.f.cleanup(); }
});

for (const [title, options, error] of [
  ['accueil inchangé après le clic', { stuckHome: true }, /n’est pas confirmé dans l’éditeur/],
  ['mauvais projet ouvert', { wrongProject: true }, /n’est pas confirmé dans l’éditeur/],
  ['fenêtre déplacée malgré la restauration', { badFrame: true }, /taille et la position/],
  ['interface inaccessible', { unreadable: true }, /Interface CapCut illisible/],
]) test(`pilote : ${title}, aucune commande d’export et lot interrompu`, async () => {
  const s = setup(options);
  try {
    const [job, pending] = await s.pilot.run([...s.projects, ...s.projects], { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, error);
    assert.equal(pending.status, 'cancelled');
    assert.ok(!s.log.includes('shortcut')); assert.ok(!s.log.includes('return'));
    assert.ok(!s.log.includes('quit'), 'fenêtre conservée pour le diagnostic');
  } finally { s.f.cleanup(); }
});

test('pilote : dialogue d’export absent, aucun appui sur Entrée', async () => {
  const s = setup({ noDialog: true });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /fenêtre de réglages d’export/);
    assert.ok(!s.log.includes('return')); assert.ok(!s.log.includes('quit'));
  } finally { s.f.cleanup(); }
});

test('pilote : cible Accueil calibrée utilisée si son libellé est inaccessible', async () => {
  const s = setup();
  try {
    s.pilot.settings.home = { x: 40, y: 90 };
    s.pilot.settings.frames.home = s.pilot.settings.frames.tile;
    const read = s.actions.readUi;
    s.actions.readUi = async () => {
      const ui = await read();
      return ui.windows[0].nodes.some(n => n.name === 'Studio de conceptions') ? snapshot(['Studio de conceptions']) : ui;
    };
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.ok(s.log.filter(Array.isArray).some(v => v[0] === 'click' && v[1].x === 40));
  } finally { s.f.cleanup(); }
});

test('pilote : encodage confirmé sans fichier immédiat ne déclenche pas l’erreur de démarrage', async () => {
  const s = setup({ noFile: true });
  try {
    let encoding = false, observed = false;
    const key = s.actions.key, read = s.actions.readUi;
    s.actions.key = async value => { if (value === 'return') encoding = true; await key(value); };
    s.actions.readUi = async () => encoding ? snapshot(['Exportation', node('Progression', { role: 'AXProgressIndicator' })]) : read();
    s.pilot.on('update', jobs => {
      if (jobs[0]?.stage === 'Export en cours dans CapCut · attente du fichier') { observed = true; s.pilot.stop(); }
    });
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(observed, true); assert.equal(job.status, 'cancelled');
  } finally { s.f.cleanup(); }
});

test('pilote : aucun démarrage détecté, erreur explicite sans attendre le délai total', async () => {
  const s = setup({ noFile: true });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /Aucun fichier détecté/);
    assert.ok(!s.log.includes('quit')); assert.equal(s.pilot.controller, null);
  } finally { s.f.cleanup(); }
});

test('surveillance : un export qui remplace un fichier existant est détecté', () => {
  const s = setup();
  try {
    const file = path.join(s.exportDir, 'Test ELPO.mp4'); fs.writeFileSync(file, 'old');
    const before = snapshotExports(s.exportDir), since = Date.now();
    assert.deepEqual(newExports(s.exportDir, since, before), []);
    fs.writeFileSync(file, 'new video content');
    assert.deepEqual(newExports(s.exportDir, since, before), [file]);
  } finally { s.f.cleanup(); }
});
