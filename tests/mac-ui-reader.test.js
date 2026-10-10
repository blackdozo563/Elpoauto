import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CAPCUT_UI_SCRIPT, CAPCUT_EXPORT_UI_SCRIPT, automationFailure } from '../lib/mac-automation.js';
import { editorIsOpen, exportDialogIsOpen, exportTarget, uiSummary } from '../lib/capcut-ui.js';
import { CapcutPilot } from '../lib/capcut-pilot.js';
import { fixture } from './fixtures.js';

function element(name, children = [], extra = {}) {
  const props = { name, role: 'AXGroup', description: '', value: null, enabled: true, visible: true, position: [0, 40], size: [1200, 800], ...extra };
  return { properties: () => props, uiElements: () => children, ...Object.fromEntries(Object.entries(props).map(([key, value]) => [key, () => value])) };
}
function read(windows, extra = {}, script = CAPCUT_UI_SCRIPT) {
  return JSON.parse(vm.runInNewContext(script, {
    Application: () => ({ processes: { byName: () => ({ windows: () => windows }) } }), ...extra,
  }));
}

test('lecture macOS : propriétés groupées, sans un appel par attribut', () => {
  const button = element('MainWindowTitleBarExportBtn', [], { role: 'AXButton' });
  for (const key of ['role', 'name', 'description', 'value', 'enabled', 'visible', 'position', 'size']) {
    button[key] = () => assert.fail(`appel individuel inutile : ${key}`);
  }
  const ui = read([element('CapCut', [button])]);
  assert.equal(editorIsOpen(ui), true);
  assert.equal(ui.truncated, false);
});

function exportSheet(target = '/Users/macbook/Desktop/TESTO.mp4') {
  return element('', [element('ExportPathInput'), element(target), element('ExportOkBtn', [], { role: 'AXButton', position: [992, 741], size: [72, 28] }), element('ExportDialog')], { role: 'AXSheet' });
}

test('lecture export : feuille macOS lue avant toute la timeline de l’éditeur', () => {
  const w = element('CapCut');
  w.sheets = () => [exportSheet()];
  w.uiElements = () => assert.fail('le corps de l’éditeur ne doit pas être parcouru');
  const ui = read([element('', [], { size: [183, 88] }), w], {}, CAPCUT_EXPORT_UI_SCRIPT);
  assert.equal(ui.complete, true);
  assert.equal(ui.timedOut, false);
  assert.equal(exportDialogIsOpen(ui), true);
  assert.equal(exportTarget(ui), '/Users/macbook/Desktop/TESTO.mp4');
});

test('lecture export : feuille imbriquée priorisée grâce aux attributs de collection', () => {
  const expensive = element('médias');
  expensive.name = () => assert.fail('les médias ne doivent pas être parcourus');
  const children = [expensive, exportSheet()];
  const w = element('CapCut', children);
  for (const key of ['name', 'description', 'role', 'value', 'visible']) {
    Object.defineProperty(w.uiElements, key, { value: () => children.map(child => child.properties()[key]) });
  }
  const ui = read([w], {}, CAPCUT_EXPORT_UI_SCRIPT);
  assert.equal(ui.complete, true);
  assert.equal(exportDialogIsOpen(ui), true);
});

test('lecture export : une feuille en arrière-plan ne confirme jamais le clic', () => {
  const front = element('CapCut', [element('MainTimeLineRoot')]);
  const background = element('CapCut'); background.sheets = () => [exportSheet()];
  const ui = read([front, background], {}, CAPCUT_EXPORT_UI_SCRIPT);
  assert.equal(ui.complete, false);
  assert.equal(exportDialogIsOpen(ui), false);
});

test('lecture export : bouton invisible ignoré et chemin manquant non confirmé', () => {
  const button = element('ExportOkBtn', [], { role: 'AXButton', visible: false, position: [992, 741], size: [72, 28] });
  const w = element('CapCut'); w.sheets = () => [element('ExportDialog', [button, element('/tmp/TESTO.mp4')], { role: 'AXSheet' })];
  let ui = read([w], {}, CAPCUT_EXPORT_UI_SCRIPT);
  assert.equal(ui.complete, false); assert.equal(exportDialogIsOpen(ui), false);
  w.sheets = () => [element('ExportDialog', [element('ExportOkBtn', [], { role: 'AXButton', position: [992, 741], size: [72, 28] })], { role: 'AXSheet' })];
  ui = read([w], {}, CAPCUT_EXPORT_UI_SCRIPT);
  assert.equal(ui.complete, false); assert.equal(exportTarget(ui), null);
});

test('pilote : les deux vérifications d’export demandent le relevé dédié', async () => {
  const f = fixture();
  const options = [];
  try {
    const ui = read([Object.assign(element('CapCut'), { sheets: () => [exportSheet()] })], {}, CAPCUT_EXPORT_UI_SCRIPT);
    const pilot = new CapcutPilot({ root: f.root, actions: { readUi: async value => { options.push(value); return ui; } } });
    const signal = new AbortController().signal;
    await pilot.verifyUi(exportDialogIsOpen, 0, signal, 'EXPORT_DIALOG', 'non confirmé');
    await pilot.verifyUi(exportDialogIsOpen, 0, signal, 'EXPORT_DIALOG', 'non confirmé');
    assert.deepEqual(options, [{ purpose: 'export' }, { purpose: 'export' }]);
  } finally { f.cleanup(); }
});

test('pilote : identifiants présents mais relevé d’export incomplet, aucune confirmation', async () => {
  const f = fixture();
  try {
    const w = element('CapCut');
    w.sheets = () => [element('ExportDialog', [element('ExportOkBtn', [], { role: 'AXButton', enabled: false, position: [992, 741], size: [72, 28] }), element('/tmp/TESTO.mp4')], { role: 'AXSheet' })];
    const ui = read([w], {}, CAPCUT_EXPORT_UI_SCRIPT);
    assert.equal(exportDialogIsOpen(ui), true);
    assert.equal(ui.complete, false);
    const pilot = new CapcutPilot({ root: f.root, actions: { readUi: async () => ui } });
    await assert.rejects(pilot.verifyUi(exportDialogIsOpen, 0, new AbortController().signal, 'EXPORT_DIALOG', 'Aucun clic Exporter envoyé.'), { code: 'EXPORT_DIALOG' });
  } finally { f.cleanup(); }
});

test('lecture macOS : repli conservé si le groupe de propriétés est indisponible', () => {
  const button = element('MainWindowTitleBarExportBtn', [], { role: 'AXButton' });
  button.properties = () => { throw new Error('propriétés indisponibles'); };
  assert.equal(editorIsOpen(read([element('CapCut', [button])])), true);
});

test('lecture macOS : la timeline profonde ne masque pas les contrôles de la feuille d’export', () => {
  const media = element('conteneur', Array.from({ length: 900 }, (_, i) => element(`élément ${i}`)));
  const sheet = element('ExportDialog', [element('ExportOkBtn', [], { role: 'AXButton' }), element('', [], { value: '/Users/a/Desktop/Test ELPO.mp4' })]);
  const ui = read([element('CapCut', [media, sheet])]);
  assert.equal(exportDialogIsOpen(ui), true);
  assert.equal(exportTarget(ui), '/Users/a/Desktop/Test ELPO.mp4');
  assert.equal(ui.truncated, true);
  assert(ui.windows[0].nodes.length <= 700);
});

test('lecture macOS : la bulle EditPilot ne consomme pas la lecture de l’éditeur', () => {
  const ignored = element('invisible');
  ignored.properties = () => assert.fail('la bulle ne doit pas être parcourue');
  const ui = read([element('', [ignored], { size: [183, 88] }), element('CapCut', [element('MainTimelineRoot')])]);
  assert.equal(ui.windows[0].nodes.length, 1);
  assert.equal(editorIsOpen(ui), true);
});

test('lecture macOS : limite de temps interne, JSON partiel valide et diagnostic explicite', () => {
  let now = 0;
  const w = element('CapCut', [element('MainTimelineRoot')]);
  const props = w.properties;
  w.properties = () => { now += 13000; return props(); };
  const ui = read([w], { Date: { now: () => now } });
  assert.equal(ui.timedOut, true);
  assert.equal(ui.truncated, true);
  assert.equal(editorIsOpen(ui), false);
  assert.match(uiSummary(ui), /lecture partielle.*délai/);
});

test('diagnostic macOS : délai, autorisation et erreur sans stderr distingués sans recopier le script', () => {
  const timeout = automationFailure({ killed: true, signal: 'SIGTERM', message: 'Command failed: SECRET_SCRIPT' }, '', 30000);
  assert.equal(timeout.code, 'MAC_TIMEOUT');
  assert.match(timeout.message, /30 secondes/);
  assert.doesNotMatch(timeout.message, /SECRET_SCRIPT/);
  const denied = automationFailure({ code: 1 }, 'Not authorized to send Apple events (-1743)', 20000);
  assert.equal(denied.code, 'MAC_PERMISSION');
  const unknown = automationFailure({ code: 1, message: 'Command failed: SECRET_SCRIPT' }, '', 20000);
  assert.equal(unknown.code, 1);
  assert.doesNotMatch(unknown.message, /SECRET_SCRIPT|autorisation/);
});

test('pilote : délai de lecture conservé comme erreur bloquante, sans accuser les autorisations', async () => {
  const f = fixture();
  try {
    const cause = automationFailure({ killed: true, signal: 'SIGTERM' }, '', 30000);
    const pilot = new CapcutPilot({ root: f.root, actions: { readUi: async () => { throw cause; } } });
    await assert.rejects(pilot.readUi(), error => {
      assert.equal(error.code, 'CAPCUT_UI');
      assert.equal(error.cause, cause);
      assert.match(error.message, /lecture de l’interface a dépassé le délai/);
      assert.doesNotMatch(error.message, /Vérifie les autorisations/);
      return true;
    });
  } finally { f.cleanup(); }
});
