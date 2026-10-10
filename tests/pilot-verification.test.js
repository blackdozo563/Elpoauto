import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fixture } from './fixtures.js';
import { CapcutPilot, snapshotExports, newExports, encodingBytes } from '../lib/capcut-pilot.js';
import { homeIsOpen, projectIsOpen, exportDialogIsOpen, controlPoint, exportIsRunning, exportTarget, targetMatches, EXPORT_BUTTON, draftTiles, pointOnDraft, uiSummary, draftTileFor, draftTitles } from '../lib/capcut-ui.js';
import { CAPCUT_UI_SCRIPT } from '../lib/mac-automation.js';

const node = (name, extra = {}) => ({ name, role: 'AXStaticText', ...extra });
const snapshot = (names, title = 'CapCut') => ({ windows: [{ title, nodes: names.map(n => typeof n === 'string' ? node(n) : n) }] });
const home = snapshot(['Accueil', 'Projets', 'Créer un projet', 'Test ELPO']);
const editor = snapshot(['Test ELPO', 'Exporter', 'Médias']);
const dialog = snapshot(['Test ELPO', 'Exporter', 'Résolution', 'Format']);

function setup(options = {}) {
  const f = fixture(), log = [];
  const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
  let page = 'studio', open = false, partialReads = 0;
  const homePoint = { x: 40, y: 90 }, tile = { x: 200, y: 250 };
  const frame = { x: 0, y: 0, width: 640, height: 480 };
  const actions = {
    accessibility: async () => true, isRunning: async () => open,
    assertClosed: () => assert.equal(open, false),
    launch: async () => { open = true; log.push('launch'); },
    activate: async () => {}, quit: async () => { open = false; log.push('quit'); },
    restoreWindow: async value => { log.push(['restore', value]); },
    windowFrame: async () => options.badFrame ? { ...frame, width: 800 } : frame,
    readUi: async readOptions => {
      if (options.unreadable) throw new Error('Accessibilité refusée');
      if (page === 'studio') return snapshot([node('Accueil', { role: 'AXButton', position: [20, 80], size: [40, 20] }), 'Studio de conceptions', 'Inspiration']);
      if (page === 'home') return options.home || home;
      if (page === 'editor') return options.editorUi || (options.wrongProject ? snapshot(['Autre projet', 'Exporter', 'Médias']) : editor);
      // Une lecture partielle (délai atteint dans macOS) ne prouve rien : le pilote
      // doit relire au lieu de déclarer la feuille absente.
      if (options.partialReads && partialReads < options.partialReads) {
        partialReads++;
        return { windows: [{ title: 'CapCut', nodes: [] }], timedOut: true, truncated: true, nodesRead: 0 };
      }
      // La sonde ne voit rien, seule une lecture approfondie trouve la feuille.
      if (options.deepOnly && !(readOptions?.maxNodes > 700)) return { windows: [{ title: 'CapCut', nodes: [] }] };
      if (options.noDialog) return editor;
      return typeof options.sheetFor === 'function' ? options.sheetFor(exportDir) : (options.sheet || dialog);
    },
    click: async (point, double) => {
      log.push(['click', point, double]);
      if (point.x === 1028 && point.y === 755 && !options.noFile) fs.writeFileSync(path.join(options.writeDir || exportDir, 'Test ELPO(1).mp4'), 'test video');
      if (point.x === homePoint.x && point.y === homePoint.y) page = 'home';
      else if (point.x === tile.x && point.y === tile.y && !options.stuckHome && !options.home) page = 'editor';
      else if (options.draftPoint && point.x === options.draftPoint.x && point.y === options.draftPoint.y) page = 'editor';
      else if (options.exportOpenPoint && !options.exportClickBroken && point.x === options.exportOpenPoint.x && point.y === options.exportOpenPoint.y) page = 'dialog';
      else if (options.home) page = 'studio';
    },
    shortcut: async () => { log.push('shortcut'); page = 'dialog'; },
    key: async key => {
      log.push(key);
      if (key === 'return' && options.encodeFirst) {
        const temp = path.join(exportDir, '.__capcut_export_temp_folder_1791601342__');
        fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, '1fcfdfb9.mp4'), 'x'.repeat(1000));
        setTimeout(() => { fs.renameSync(path.join(temp, '1fcfdfb9.mp4'), path.join(exportDir, 'Test ELPO.mp4')); }, options.encodeFirst);
      } else if (key === 'return' && !options.noFile) fs.writeFileSync(path.join(options.writeDir || exportDir, 'Test ELPO.mp4'), 'test video');
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

// Relevé réel CapCut 9 (macOS, français) : éditeur ouvert sur TESTO, feuille d'export affichée,
// bulle EditPilot (petite fenêtre sans titre) listée en premier.
const ax = (description, extra = {}) => ({ role: 'AXStaticText', name: '', description, ...extra });
const bubble = { title: '', frame: { x: 1185, y: 734, width: 183, height: 88 }, nodes: [{ role: 'AXWindow', name: '', description: 'dialogue' }] };
const editorNodes = [
  ax('MainWindowTitleBarExportBtn', { position: [1272, 97], size: [77, 22] }), ax('root_Multimédia'), ax('PlayerPlayBtn'),
  ax('MainMultiTimelineLayout'), ax('MainTimeLineRoot'), { role: 'AXButton', name: '', description: 'Bouton de fermeture' },
];
const sheetNodes = target => [
  { role: 'AXSheet', name: '', description: 'feuille' }, ax('ExportFileNameInput'), ax('ExportPathInput'),
  ax(target, { name: target }), ax('ExportSharpnessInput'), ax('ExportFormatInput'),
  { role: 'AXButton', name: 'automationcancel', description: '', position: [912, 741], size: [72, 28] },
  { role: 'AXButton', name: 'ExportOkBtn', description: '', position: [992, 741], size: [72, 28] }, ax('ExportOkBtn'), ax('ExportDialog'),
];
const capcut = nodes => ({ windows: [bubble, { title: 'CapCut', frame: { x: 80, y: 90, width: 1280, height: 720 }, nodes }] });

test('interface CapCut 9 réelle : éditeur et feuille d’export reconnus malgré la bulle EditPilot', () => {
  const realEditor = capcut(editorNodes);
  const realSheet = capcut([...editorNodes, ...sheetNodes('/Users/macbook/Desktop/TESTO(1).mp4')]);
  assert.equal(homeIsOpen(realEditor), false);
  assert.equal(projectIsOpen(realEditor, 'TESTO'), true);
  assert.equal(exportDialogIsOpen(realEditor), false);
  assert.equal(exportDialogIsOpen(realSheet), true);
  assert.deepEqual(controlPoint(realSheet, EXPORT_BUTTON), { x: 1028, y: 755 });
  assert.equal(exportTarget(realSheet), '/Users/macbook/Desktop/TESTO(1).mp4');
  assert.equal(targetMatches('/Users/macbook/Desktop/TESTO(1).mp4', 'TESTO'), true);
  assert.equal(targetMatches('/Users/macbook/Desktop/TESTO.mov', 'testo'), true);
  assert.equal(targetMatches('/Users/macbook/Desktop/TESTO(1).mp4', 'TEST'), false);
  assert.equal(targetMatches('/Users/macbook/Desktop/TESTO 2.mp4', 'TESTO'), false);
  // La bulle seule ne doit jamais être prise pour la page pilotée.
  assert.equal(projectIsOpen({ windows: [bubble] }, 'TESTO'), false);
});

test('pilote : la feuille d’export confirme le projet, clique ExportOkBtn et donne le vrai dossier de sortie', async () => {
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-desktop-'));
  const target = path.join(desktop, 'Test ELPO(1).mp4');
  const s = setup({ sheet: { windows: [{ title: 'CapCut', nodes: [...editorNodes, ...sheetNodes(target), ax('Test ELPO')] }] }, writeDir: desktop });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.output, target);
    assert.ok(s.log.filter(Array.isArray).some(v => v[0] === 'click' && v[1].x === 1028 && v[1].y === 755), 'clic sur ExportOkBtn');
    assert.ok(!s.log.includes('return'));
    assert.ok(s.pilot.log.some(l => /surveillance de ce dossier/.test(l.text)));
  } finally { s.f.cleanup(); fs.rmSync(desktop, { recursive: true, force: true }); }
});

test('pilote : la feuille d’export annonce un autre projet, aucun export envoyé', async () => {
  const s = setup({ sheet: { windows: [{ title: 'CapCut', nodes: [...editorNodes, ...sheetNodes('/tmp/Autre projet.mp4'), ax('Test ELPO')] }] } });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /au lieu de « Test ELPO »/);
    assert.ok(!s.log.includes('return'));
    assert.ok(!s.log.filter(Array.isArray).some(v => v[0] === 'click' && v[1].x === 1028));
  } finally { s.f.cleanup(); }
});

// Accueil CapCut 9 réel : vignettes HomePageDraft avec leur position (fenêtre 1280×720 en (80, 90)).
const draft = (x, y) => ({ role: 'AXStaticText', name: '', description: 'HomePageDraft', position: [x, y], size: [174, 100] });
const homeWith = drafts => ({ windows: [{ title: 'CapCut', frame: { x: 80, y: 90, width: 1280, height: 720 }, nodes: [
  { role: 'AXStaticText', name: 'Accueil', description: 'Accueil', position: [100, 210], size: [80, 20] },
  { role: 'AXStaticText', name: 'Studio de conceptions', description: 'Studio de conceptions', position: [100, 330], size: [160, 20] },
  { role: 'AXStaticText', name: 'HomePageStartProjectName', description: 'HomePageStartProjectDesp', position: [250, 120], size: [1000, 130] },
  ...drafts] }] });

test('accueil CapCut 9 : la première vignette est la plus haute puis la plus à gauche, hors fenêtre ignorée', () => {
  const ui = homeWith([draft(500, 600), draft(300, 600), draft(300, 600), draft(300, 900)]);
  assert.deepEqual(draftTiles(ui), [{ x: 387, y: 650 }, { x: 587, y: 650 }]);
  assert.deepEqual(draftTiles(homeWith([draft(300, 850), draft(500, 850)])), [], 'rangée « Projets » sous la partie visible');
  assert.equal(pointOnDraft(homeWith([draft(300, 600)]), { x: 350, y: 640 }), true);
  assert.equal(pointOnDraft(homeWith([draft(300, 600)]), { x: 180, y: 340 }), false, 'Studio de conceptions n’est pas une vignette');
  assert.match(uiSummary(homeWith([draft(300, 600)])), /\[accueil\]/);
  assert.match(uiSummary(snapshot(['Studio de conceptions', 'Inspiration'])), /page non reconnue/);
});

test('pilote : ouvre la vraie première vignette HomePageDraft au lieu du point calibré', async () => {
  const s = setup({ home: homeWith([draft(500, 600), draft(300, 600)]), draftPoint: { x: 387, y: 650 } });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    const clicks = s.log.filter(Array.isArray).filter(v => v[0] === 'click');
    assert.deepEqual(clicks[1], ['click', { x: 387, y: 650 }, true]);
    assert.ok(!clicks.some(v => v[1].x === 200 && v[1].y === 250), 'point calibré non utilisé');
  } finally { s.f.cleanup(); }
});

test('pilote : vignettes hors de vue et point calibré hors vignette, aucun clic à l’aveugle', async () => {
  const s = setup({ home: homeWith([draft(300, 850), draft(500, 850)]) });
  try {
    const [job, pending] = await s.pilot.run([...s.projects, ...s.projects], { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /rangée « Projets »/);
    assert.equal(pending.status, 'cancelled');
    assert.ok(!s.log.filter(Array.isArray).some(v => v[0] === 'click' && v[2] === true), 'aucun double-clic');
    assert.ok(!s.log.includes('shortcut'));
  } finally { s.f.cleanup(); }
});

// Parcours réel enregistré (capcut-parcours.sh), Accueil CapCut 9 dans une fenêtre 1424×798 en (8, 34).
const st = (name, description, x, y, w, h) => ({ role: 'AXStaticText', name, description, position: [x - w / 2, y - h / 2], size: [w, h] });
const REAL_FRAME = { x: 8, y: 34, width: 1424, height: 798 };
const START = st('HomePageStartProjectName', 'HomePageStartProjectDesp', 834, 150, 174, 27);
// Étape 1 : juste après le lancement, rangée « Projets » coupée par le bas, aucun titre exposé.
const launchHome = { windows: [{ title: 'CapCut', frame: REAL_FRAME, nodes: [START,
  ...[315, 461, 607, 753, 899, 1045, 1191].map(x => st('', 'HomePageDraft', x, 819, 134, 174))] }] };
// Étape 2 : rangée visible, titres exposés ; CapCut donne au nœud « 0604 » le cadre de la vignette « 0920 (1) »
// et omet la vignette 461 de la liste HomePageDraft.
const T = n => `HomePageDraftTitle:${n}`;
const scrolledHome = { windows: [{ title: 'CapCut', frame: REAL_FRAME, nodes: [START,
  st('', 'HomePageDraft', 315, 548, 134, 174), st(T('TESTO'), T('TESTO'), 272, 620, 38, 14), st(T('TESTO'), T('TESTO'), 272, 620, 38, 14),
  st(T('0604'), T('0604'), 415, 620, 31, 14), st(T('0604'), T('0604'), 607, 548, 134, 174),
  st(T('0920 (1)'), T('0920 (1)'), 569, 620, 48, 14), st('', 'HomePageDraft', 753, 548, 134, 174),
  st(T('0713'), T('0713'), 705, 620, 27, 14), st('', 'HomePageDraft', 315, 726, 134, 174),
  st(T('0114'), T('0114'), 267, 798, 27, 14),
] }] };

test('accueil CapCut 9 réel : après lancement, la première vignette coupée est visée dans sa partie visible', () => {
  assert.equal(homeIsOpen(launchHome), true);
  assert.equal(draftTileFor(launchHome, 'TESTO'), undefined, 'aucun titre exposé au lancement');
  const [first] = draftTiles(launchHome);
  assert.deepEqual(first, { x: 315, y: 777 });
  assert.ok(first.y < REAL_FRAME.y + REAL_FRAME.height, 'clic dans la fenêtre');
});

test('accueil CapCut 9 réel : vignette visée par le nom exact, sans se fier au cadre erroné de « 0604 »', () => {
  assert.deepEqual(draftTileFor(scrolledHome, 'TESTO'), { x: 273, y: 543 });
  const p0604 = draftTileFor(scrolledHome, '0604');
  assert.ok(p0604.x > 394 && p0604.x < 528, 'dans la colonne de 0604 (vignette 461), pas sur 0920 (1)');
  assert.ok(Math.abs(draftTileFor(scrolledHome, '0920 (1)').x - 607) < 67);
  assert.equal(draftTileFor(scrolledHome, 'TEST'), null);
  assert.deepEqual(draftTileFor(scrolledHome, '0114'), { x: 274, y: 721 }, 'deuxième rangée, visible');
  assert.equal(draftTileFor(scrolledHome, '0114 (1)'), null, 'titre non exposé');
  assert.deepEqual(draftTitles(scrolledHome), ['testo', '0604', '0920 (1)', '0713', '0114']);
});

test('pilote : ouvre la vignette du projet par son nom, même si elle n’est pas la première', async () => {
  const home = { windows: [{ title: 'CapCut', frame: REAL_FRAME, nodes: [START,
    st('', 'HomePageDraft', 315, 548, 134, 174), st(T('Autre'), T('Autre'), 272, 620, 38, 14),
    st('', 'HomePageDraft', 461, 548, 134, 174), st(T('Test ELPO'), T('Test ELPO'), 418, 620, 38, 14)] }] };
  const s = setup({ home, draftPoint: { x: 419, y: 543 } });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(s.log.filter(Array.isArray).filter(v => v[0] === 'click')[1], ['click', { x: 419, y: 543 }, true]);
  } finally { s.f.cleanup(); }
});

test('pilote : vignette du projet absente de l’accueil, aucun clic sur un autre projet', async () => {
  const s = setup({ home: scrolledHome, draftPoint: { x: 273, y: 543 } });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /« Test ELPO » n’est pas visible.*testo, 0604/);
    assert.ok(!s.log.filter(Array.isArray).some(v => v[0] === 'click' && v[2] === true), 'aucun double-clic');
  } finally { s.f.cleanup(); }
});

test('export CapCut 9 réel : l’encodage dans le dossier caché du Bureau est suivi', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-encode-'));
  try {
    assert.equal(encodingBytes(dir, Date.now()), 0);
    const temp = path.join(dir, '.__capcut_export_temp_folder_1791601342__'); fs.mkdirSync(temp);
    fs.writeFileSync(path.join(temp, '1fcfdfb9-3603-4e80-ae36-a3b75fe024a5.mp4'), Buffer.alloc(4096));
    assert.equal(encodingBytes(dir, Date.now()), 4096);
    assert.deepEqual(newExports(dir, Date.now(), new Set()), [], 'le fichier temporaire n’est pas un export terminé');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pilote : export long encodé dans le dossier caché, aucune fausse erreur de démarrage', async () => {
  const s = setup({ encodeFirst: 2500 });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(path.basename(job.output), 'Test ELPO.mp4');
  } finally { s.f.cleanup(); }
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
  window.size = () => [640, 480];
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

// ── Ouverture de la feuille d’export ─────────────────────────────────────────────
// CapCut 9 expose son propre bouton « Exporter » (MainWindowTitleBarExportBtn) : le
// cliquer ne dépend ni de ⌘E, ni de la disposition du clavier, ni du focus.
const exportOpenEditor = () => snapshot(['Test ELPO', 'Médias', ax('MainWindowTitleBarExportBtn', { position: [1272, 97], size: [77, 22] })]);
// Feuille réelle : chemin annoncé dans le dossier d’export surveillé + ExportOkBtn.
const sheetIn = dir => ({ windows: [{ title: 'CapCut', nodes: [...editorNodes, ...sheetNodes(path.join(dir, 'Test ELPO.mp4'))] }] });
const EXPORT_OPEN_POINT = { x: 1310.5, y: 108 };

test('pilote : le bouton « Exporter » de CapCut est cliqué, ⌘E n’est pas envoyé', async () => {
  const s = setup({ editorUi: exportOpenEditor(), exportOpenPoint: EXPORT_OPEN_POINT, sheetFor: sheetIn });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.ok(s.log.filter(Array.isArray).some(v => v[0] === 'click' && v[1].x === EXPORT_OPEN_POINT.x && v[1].y === EXPORT_OPEN_POINT.y), 'clic sur le bouton réel');
    assert.ok(!s.log.includes('shortcut'), '⌘E ne doit pas être envoyé');
    assert.ok(!s.log.includes('return'), 'clic sur ExportOkBtn, pas sur Entrée');
  } finally { s.f.cleanup(); }
});

test('pilote : ⌘E en repli quand le clic sur le bouton « Exporter » n’ouvre pas la feuille', async () => {
  const s = setup({ editorUi: exportOpenEditor(), exportOpenPoint: EXPORT_OPEN_POINT, exportClickBroken: true, sheetFor: sheetIn });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.ok(s.log.includes('shortcut'), 'repli sur ⌘E');
    assert.ok(s.pilot.log.some(l => /nouvel essai par raccourci ⌘E/.test(l.text)));
  } finally { s.f.cleanup(); }
});

test('pilote : une seule lecture partielle ne déclare pas la feuille absente', async () => {
  const s = setup({ partialReads: 1, sheetFor: sheetIn });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.ok(!s.log.includes('return'), 'ExportOkBtn cliqué après la relecture');
  } finally { s.f.cleanup(); }
});

test('pilote : lecture approfondie quand la sonde ne voit aucun identifiant de feuille', async () => {
  const s = setup({ deepOnly: true, sheetFor: sheetIn });
  try {
    const [job] = await s.pilot.run(s.projects, { exportDir: s.exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.ok(s.pilot.log.some(l => /lecture approfondie/.test(l.text)));
    // La lecture qui a trouvé la feuille sert aussi à lire le bouton et le chemin.
    assert.ok(!s.log.includes('return'), 'ExportOkBtn lu par la même lecture approfondie');
  } finally { s.f.cleanup(); }
});

test('pilote : feuille jamais lisible, aucun Entrée et identifiants vus dans l’erreur', async () => {
  const s = setup({ partialReads: 99 });
  try {
    const [job, pending] = await s.pilot.run([...s.projects, ...s.projects], { exportDir: s.exportDir });
    assert.equal(job.status, 'failed'); assert.match(job.error, /fenêtre de réglages d’export/);
    assert.match(job.error, /Contrôles lus :/);
    assert.equal(pending.status, 'cancelled');
    assert.ok(!s.log.includes('return')); assert.ok(!s.log.includes('quit'));
  } finally { s.f.cleanup(); }
});
