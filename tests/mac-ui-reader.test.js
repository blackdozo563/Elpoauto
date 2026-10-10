import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CAPCUT_UI_SCRIPT, automationFailure } from '../lib/mac-automation.js';
import { editorIsOpen, exportDialogIsOpen, exportTarget, uiSummary } from '../lib/capcut-ui.js';
import { CapcutPilot } from '../lib/capcut-pilot.js';
import { fixture } from './fixtures.js';

function element(name, children = [], extra = {}) {
  const props = { name, role: 'AXGroup', description: '', value: null, enabled: true, visible: true, position: [0, 40], size: [1200, 800], ...extra };
  return { properties: () => props, uiElements: () => children, ...Object.fromEntries(Object.entries(props).map(([key, value]) => [key, () => value])) };
}
function read(windows, extra = {}) {
  return JSON.parse(vm.runInNewContext(CAPCUT_UI_SCRIPT, {
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
