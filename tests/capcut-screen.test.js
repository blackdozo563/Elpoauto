// The screen reader on the real CapCut 9.3.0 recording of 11 October 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readScreen, chooseTile, targetMatches, timecodeSeconds, visiblePart, describeScreen, center } from '../lib/capcut-screen.js';
import { frames, sheetOnly, substitute } from './capcut-sim.js';

test('diagnostic réel 0.7 : AXPress accepté ne prouve pas le démarrage de l’export', () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/capcut-0.7-press-no-effect.json', import.meta.url)));
  const screen = readScreen(snapshot);
  assert.equal(snapshot.trusted, true);
  assert.equal(screen.screen, 'export-settings');
  assert.equal(screen.reliable, true);
  assert.equal(screen.okPress, true);
  assert.equal(screen.okEnabled, true);
  assert.equal(screen.target, '/Users/demo/Desktop/projet 1-30sec.mp4');
  assert.equal(screen.percent, undefined);
  assert.equal(screen.frontmost, false);
});

test('diagnostic réel corrigé : deux AXPress success au premier plan, réglages toujours affichés', () => {
  const diagnostic = JSON.parse(fs.readFileSync(new URL('./fixtures/capcut-0.7-foreground-press-no-effect.json', import.meta.url)));
  assert.equal(diagnostic.commands.length, 2);
  for (const { result } of diagnostic.commands) {
    assert.equal(result.focusedPID, result.capcutPID);
    assert.equal(result.pressResult, 'success');
    assert.equal(result.control.role, 'AXButton');
    assert.equal(result.commandAttempted, true);
    assert.deepEqual(center(result.control.frame), { x: 1028, y: 711 });
  }
  assert.equal(readScreen(diagnostic.snapshot).screen, 'export-settings');
});

test('relevé réel : chaque page du cycle est reconnue', () => {
  const expected = {
    home: 'home', 'busy-opening': 'busy', 'editor-loading': 'busy', editor: 'editor', 'busy-sheet': 'busy',
    'export-settings': 'export-settings', 'export-settings-switching': 'export-settings', 'exporting-start': 'exporting',
    'exporting-end': 'exporting', 'busy-finishing': 'busy', 'export-done': 'export-done', 'editor-after-close': 'editor', 'home-after-close': 'home',
  };
  assert.deepEqual(Object.keys(frames).sort(), Object.keys(expected).sort());
  for (const [label, screen] of Object.entries(expected)) assert.equal(readScreen(frames[label]).screen, screen, label);
});

test('relevé réel : une lecture partielle ou occupée ne prouve rien', () => {
  assert.equal(readScreen(frames['busy-opening']).reliable, false);
  assert.equal(readScreen(frames['editor-loading']).reliable, false, 'éditeur en chargement, budget de lecture dépassé');
  const switching = readScreen(frames['export-settings-switching']);
  assert.equal(switching.screen, 'export-settings');
  assert.equal(switching.reliable, false, 'feuille relue pendant son passage à la progression (invalidUIElement)');
  assert.equal(readScreen(frames['export-settings']).reliable, true);
});

test('relevé réel : accueil — vignettes, noms, et vignette ouverte par son nom', () => {
  const home = readScreen(frames.home);
  assert.equal(home.tiles.length, 21);
  assert.deepEqual(home.titles.slice(0, 3).map(t => t.name), ['PROJET-A', 'PROJET-B', '0604']);
  const pick = chooseTile(home, 'PROJET-A', { allowFirst: true });
  assert.equal(pick.method, 'title');
  assert.deepEqual(pick.tile, { x: 248, y: 415, width: 134, height: 174 });
  assert.deepEqual(pick.point, { x: 315, y: 487 }, 'au centre de la miniature, au-dessus du nom');
  assert.deepEqual(chooseTile(home, 'PROJET-B').point, { x: 461, y: 487 });
  assert.equal(chooseTile(home, '0920 (1)').method, 'title');
  assert.equal(chooseTile(home, 'projet-a').method, 'title', 'casse ignorée comme pour le nom de fichier');
});

test('relevé réel : accueil après lancement — noms masqués, première vignette seulement sur demande', () => {
  const home = readScreen(frames['home-after-close']);
  assert.equal(home.titles.length, 0, 'CapCut ne nomme pas les vignettes coupées par le bas de la fenêtre');
  assert.equal(home.tiles.length, 7);
  const refused = chooseTile(home, 'PROJET-A');
  assert.equal(refused.point, null);
  const first = chooseTile(home, 'PROJET-A', { allowFirst: true });
  assert.equal(first.method, 'first-tile');
  assert.deepEqual(first.point, { x: 315, y: 777 }, 'partie visible de la première vignette (fenêtre jusqu’à y 832)');
});

test('accueil : projet absent des noms visibles, ou en double, aucun clic', () => {
  const home = readScreen(frames.home);
  const missing = chooseTile(home, 'Inconnu', { allowFirst: true });
  assert.equal(missing.point, null);
  assert.match(missing.reason, /trie l’accueil par date de modification/);
  const twice = readScreen(substitute(frames.home, [['PROJET-B', 'PROJET-A']]));
  assert.equal(chooseTile(twice, 'PROJET-A').point, null, 'deux projets du même nom sans placement en tête');
  assert.deepEqual(chooseTile(twice, 'PROJET-A', { allowFirst: true }).point, { x: 315, y: 487 }, 'celui placé en tête par ELPO');
});

test('relevé réel : éditeur — bouton Exporter de la barre de titre et durée de la timeline', () => {
  const editor = readScreen(frames.editor);
  assert.deepEqual(editor.exportButton, { x: 1271, y: 53, width: 77, height: 22 });
  assert.deepEqual(center(editor.exportButton), { x: 1310, y: 64 });
  assert.ok(Math.abs(editor.durationSeconds - 275.73) < 0.01, 'totalProgress|00:04:35:22');
});

test('relevé réel : réglages d’export — fichier annoncé et bouton final', () => {
  const settings = readScreen(frames['export-settings']);
  assert.equal(settings.target, '/Users/demo/Desktop/PROJET-A.mp4');
  assert.equal(settings.okEnabled, true);
  assert.equal(settings.okPress, true, 'ExportOkBtn annonce AXPress : aucun clic souris');
  assert.ok(targetMatches(settings.target, 'PROJET-A'));
  assert.ok(!targetMatches(settings.target, 'PROJET-B'));
});

test('relevé réel : progression lue, jamais 100 % avant le panneau de fin', () => {
  assert.equal(readScreen(frames['exporting-start']).percent, 38.4);
  assert.equal(readScreen(frames['exporting-end']).percent, 97.4);
  const done = readScreen(frames['export-done']);
  assert.equal(done.closePress, true, '« Fermer » (automationcloseBtn) annonce AXPress');
  assert.ok(done.labels.includes('publish_pc_btn'));
});

test('lecture de la seule feuille : réglages, progression, fin, ou aucune feuille', () => {
  assert.equal(readScreen(sheetOnly(frames['export-settings'])).screen, 'export-settings');
  assert.equal(readScreen(sheetOnly(frames['exporting-end'])).percent, 97.4);
  assert.equal(readScreen(sheetOnly(frames['export-done'])).screen, 'export-done');
  const none = readScreen(sheetOnly(frames.editor));
  assert.equal(none.screen, 'no-sheet');
  assert.equal(none.reliable, true);
});

test('feuille inconnue, CapCut fermé, accès refusé', () => {
  const unknown = readScreen(substitute(frames['export-done'], [['automationcloseBtn', 'x1'], ['publish_pc_btn', 'x2'], ['automationopenFolderBtn', 'x3']]));
  assert.equal(unknown.screen, 'sheet');
  assert.match(describeScreen(unknown), /fenêtre CapCut inattendue/);
  assert.equal(readScreen({ ok: false, code: 'NOT_RUNNING', runningInstances: 0, trusted: true, windows: [] }).screen, 'not-running');
  assert.equal(readScreen({ ok: false, code: 'NO_ACCESS', trusted: false, runningInstances: 1, windows: [] }).screen, 'no-access');
});

test('noms de fichiers : « (1) » ajouté par CapCut, ou présent dans le nom du projet', () => {
  assert.ok(targetMatches('/a/TESTO.mp4', 'TESTO'));
  assert.ok(targetMatches('/a/TESTO(1).mp4', 'TESTO'));
  assert.ok(targetMatches('/a/0920 (1).mp4', '0920 (1)'));
  assert.ok(targetMatches('/a/0920 (1)(1).mp4', '0920 (1)'));
  assert.ok(!targetMatches('/a/TESTO.mp4', 'TEST'));
  assert.ok(!targetMatches('/a/TESTO.mp4', ''));
});

test('temps et zones visibles', () => {
  assert.equal(timecodeSeconds('totalProgress|00:00:05:00'), 5);
  assert.equal(timecodeSeconds('rien'), null);
  assert.equal(visiblePart({ x: 0, y: 0, width: 500, height: 500 }, { x: 480, y: 10, width: 100, height: 100 }), null, 'moins de 40 points visibles');
  assert.deepEqual(visiblePart({ x: 0, y: 0, width: 500, height: 500 }, { x: 100, y: 100, width: 100, height: 100 }), { x: 150, y: 150 });
});
