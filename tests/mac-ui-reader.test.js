import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { CAPCUT_UI_SCRIPT, capcutUiScript, automationFailure } from '../lib/mac-automation.js';
import { editorIsOpen, exportDialogIsOpen, exportDialogWindow, exportOkPoint, exportTarget, uiIdentifiers, uiSummary } from '../lib/capcut-ui.js';
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

// ── CapCut 9 réel : éditeur chargé, feuille d’export ouverte ──────────────────────
// Un projet réel expose des milliers de nœuds dans la timeline. Chaque événement
// Apple vers CapCut coûte quelques dizaines de millisecondes : c’est ce coût, et non
// le nombre de nœuds, qui faisait expirer la lecture avant d’atteindre la feuille.
const EVENT_MS = 18;
function fakeClock() { let now = 0; return { now: () => now, advance: ms => { now += ms; } }; }
function ax(name, description, children, extra, clk) {
  const props = { name, description, role: 'AXStaticText', value: null, enabled: true, visible: true, position: null, size: null, ...(extra || {}) };
  const node = { properties: () => { clk.advance(EVENT_MS); return props; }, uiElements: () => { clk.advance(EVENT_MS); return children || []; } };
  for (const [key, value] of Object.entries(props)) node[key] = () => { clk.advance(EVENT_MS); return value; };
  return node;
}
function axWindow(title, children, sheets, frame, clk) {
  const props = { name: title, description: '', role: 'AXWindow', value: null, enabled: true, visible: true, position: [frame.x, frame.y], size: [frame.width, frame.height] };
  const w = { properties: () => { clk.advance(EVENT_MS); return props; }, uiElements: () => { clk.advance(EVENT_MS); return children || []; } };
  if (sheets) w.sheets = () => { clk.advance(EVENT_MS); return sheets; };
  return w;
}
const EXPORT_TARGET = '/Users/macbook/Desktop/TESTO(1).mp4';
const editSheet = clk => ax('', 'feuille', [
  ax('', 'ExportFileNameInput', [], { role: 'AXTextField' }, clk), ax('', 'ExportPathInput', [], { role: 'AXTextField' }, clk),
  ax(EXPORT_TARGET, '', [], { value: EXPORT_TARGET }, clk), ax('', 'ExportFormatInput', [], {}, clk),
  ax('automationcancel', '', [], { role: 'AXButton', position: [912, 741], size: [72, 28] }, clk),
  ax('ExportOkBtn', '', [], { role: 'AXButton', position: [992, 741], size: [72, 28] }, clk),
  ax('', 'ExportOkBtn', [], {}, clk), ax('', 'ExportDialog', [], {}, clk),
], { role: 'AXSheet' }, clk);
const editorBody = clk => [
  ax('', 'MainWindowTitleBar', [ax('MainWindowTitleBarExportBtn', '', [], { position: [1272, 97], size: [77, 22] }, clk)], {}, clk),
  ax('', 'root_Multimédia', Array.from({ length: 400 }, (_, i) => ax(`média ${i}`, '', [], {}, clk)), {}, clk),
  ax('MainMultiTimelineLayout', '', [ax('MainTimeLineRoot', '',
    Array.from({ length: 20 }, (_, t) => ax(`piste ${t}`, '', Array.from({ length: 60 }, (_, c) => ax(`plan ${t}-${c}`, '', [], {}, clk)), {}, clk)), {}, clk)], {}, clk),
];
// La bulle EditPilot, listée en premier par System Events, comme dans le relevé réel.
const pilotBubble = clk => axWindow('', [ax('', 'dialogue', [], { role: 'AXWindow' }, clk)], null, { x: 1185, y: 734, width: 183, height: 88 }, clk);
const editorFrame = { x: 80, y: 90, width: 1280, height: 720 };
function readEditor(script, { sheetVia }) {
  const clk = fakeClock(), body = editorBody(clk), sheet = editSheet(clk);
  if (sheetVia === 'child') body.push(sheet);
  const windows = [pilotBubble(clk), axWindow('CapCut', body, sheetVia === 'sheets' ? [sheet] : null, editorFrame, clk)];
  const at = clk.now();
  const ui = JSON.parse(vm.runInNewContext(script, { Application: () => ({ processes: { byName: () => ({ windows: () => windows }) } }), Date: clk }));
  return { ui, ms: clk.now() - at };
}

test('lecture macOS : la feuille d’export exposée par « sheets » est lue avant la timeline', () => {
  // Mode de panne réel : System Events ne liste la feuille d’export que parmi les
  // « sheets » de la fenêtre. La lecture qui ne descend que dans uiElements expire
  // dans la timeline et rend « CapCut [éditeur] · lecture partielle ».
  const { ui, ms } = readEditor(CAPCUT_UI_SCRIPT, { sheetVia: 'sheets' });
  assert.equal(exportDialogIsOpen(ui), true);
  assert.equal(ui.timedOut, false, 'la lecture ne doit plus expirer');
  assert.match(uiSummary(ui), /feuille d’export/);
  assert.ok(ms < 6000, `lecture trop lente : ${ms} ms simulés`);
  assert.deepEqual(exportOkPoint(ui), { x: 1028, y: 755 });
  assert.equal(exportTarget(ui), EXPORT_TARGET);
});

test('lecture macOS : feuille enfant AXSheet derrière un chutier de 400 médias', () => {
  const { ui } = readEditor(CAPCUT_UI_SCRIPT, { sheetVia: 'child' });
  assert.equal(exportDialogIsOpen(ui), true);
  assert.equal(ui.timedOut, false);
  assert.equal(uiSummary(ui).includes('lecture partielle'), false, uiSummary(ui));
  assert.equal(exportTarget(ui), EXPORT_TARGET);
});

test('lecture macOS : une feuille modale exclut tous les panneaux de l’éditeur', () => {
  const { ui } = readEditor(CAPCUT_UI_SCRIPT, { sheetVia: 'sheets' });
  assert.equal(ui.modalOnly, true);
  assert.ok(ui.nodesRead < 20, `budget de lecture : ${ui.nodesRead} contrôles`);
  assert.ok(!uiIdentifiers(ui, 100).includes('mainwindowtitlebarexportbtn'));
});

test('lecture macOS : la sonde s’arrête au premier identifiant de la feuille', () => {
  const probe = capcutUiScript({ stop: ['exportdialog', 'exportokbtn', 'exportfilenameinput', 'exportpathinput'], deadlineMs: 6000 });
  const { ui, ms } = readEditor(probe, { sheetVia: 'child' });
  assert.equal(ui.found, true);
  assert.equal(exportDialogIsOpen(ui), true);
  assert.ok(ms < 3000, `sonde trop lente : ${ms} ms simulés`);
  // Une sonde n’est pas une lecture complète : elle ne donne pas le bouton à cliquer.
  assert.equal(exportTarget(ui), null);
});

test('interface CapCut : la feuille est cherchée dans toutes les fenêtres, pas seulement la première', () => {
  const sheetWindow = { title: 'Export', frame: { x: 300, y: 200, width: 700, height: 500 }, nodes: [{ role: 'AXStaticText', name: '', description: 'ExportDialog' }] };
  const editorOnly = { title: 'CapCut', frame: editorFrame, nodes: [{ role: 'AXStaticText', name: '', description: 'MainTimeLineRoot' }] };
  const ui = { windows: [editorOnly, sheetWindow] };
  assert.equal(exportDialogIsOpen(ui), true);
  assert.equal(exportDialogWindow(ui), sheetWindow);
  // La petite bulle flottante n’est jamais prise pour la feuille.
  assert.equal(exportDialogIsOpen({ windows: [{ title: '', frame: { x: 0, y: 0, width: 183, height: 88 }, nodes: [{ description: 'ExportDialog' }] }] }), false);
});

test('diagnostic macOS : les identifiants vus sont listés pour un échec', () => {
  const { ui } = readEditor(capcutUiScript({ stop: ['identifiant-inexistant'], deadlineMs: 400, maxNodes: 40, branchNodes: 12 }), { sheetVia: 'child' });
  const ids = uiIdentifiers(ui);
  assert.ok(ids.includes('feuille'), ids.join(', '));
  assert.ok(ids.length <= 24);
  assert.ok(uiIdentifiers({ windows: [] }).length === 0);
});

test('relevé du 10 octobre : les descendants de la feuille passent avant les voisins de l’éditeur', () => {
  // The actual capture contains AXSheet but no descendants after 25 s / 75 nodes.
  // It is a flat partial snapshot, not a complete tree: descendant fixtures below
  // reproduce the queue defect using previously known CapCut identifiers.
  const observed = JSON.parse(fs.readFileSync(new URL('./fixtures/capcut-modal-partial.json', import.meta.url)));
  assert.equal(observed.ui.timedOut, true);
  assert.equal(observed.ui.nodesRead, 75);
  assert.equal(exportDialogIsOpen(observed.ui), false);
  const [root, modal] = observed.ui.windows[0].nodes;
  assert.equal(modal.role, 'AXSheet');
  const clk = fakeClock();
  const fields = Array.from({ length: 65 }, () => ax('', '', [], {}, clk));
  fields.push(ax('ExportOkBtn', '', [], { role: 'AXButton', position: [992, 741], size: [72, 28] }, clk));
  fields.push(ax('', 'ExportPathInput', [], { role: 'AXTextField', value: EXPORT_TARGET }, clk));
  const sheet = ax(modal.name, modal.description, fields, modal, clk);
  const editor = ax('', 'root_Multimédia', [], {}, clk);
  editor.properties = () => assert.fail('un panneau de l’éditeur a été lu avant les descendants de la feuille');
  const w = axWindow(root.name, [sheet, ...Array(75).fill(editor)], null, observed.ui.windows[0].frame, clk);
  const ui = JSON.parse(vm.runInNewContext(capcutUiScript({ deadlineMs: 25000, branchNodes: 20 }), {
    Application: () => ({ processes: { byName: () => ({ windows: () => [w] }) } }), Date: clk,
  }));
  assert.equal(ui.modalOnly, true);
  assert.equal(ui.modalChildren, 67);
  assert.equal(ui.timedOut, false);
  assert.equal(ui.truncated, false);
  assert.deepEqual(exportOkPoint(ui), { x: 1028, y: 755 });
  assert.equal(exportTarget(ui), EXPORT_TARGET);
});

test('pilote : une limite de contrôles ne confirme pas la disparition du bouton final', async () => {
  const f = fixture();
  try {
    const partial = { windows: [{ title: 'CapCut', frame: editorFrame, nodes: [
      { role: 'AXTextField', description: 'ExportPathInput', value: EXPORT_TARGET },
    ] }], timedOut: false, truncated: true };
    const pilot = new CapcutPilot({ root: f.root, actions: { readUi: async () => partial } });
    assert.equal(await pilot.exportAccepted(() => null, undefined, 1), 'incertain');
  } finally { f.cleanup(); }
});
