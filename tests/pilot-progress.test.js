// Following CapCut's own export percentage (0.6.4). Before, the interface reader threw
// away every numeric value — a progress bar's value included — so ELPO never saw how far
// CapCut was and could not tell when the export was over.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { CapcutPilot } from '../lib/capcut-pilot.js';
import { exportTracker, progressReadings, exportFinishedShown } from '../lib/capcut-ui.js';
import { capcutUiScript } from '../lib/mac-automation.js';

const frame = { x: 0, y: 0, width: 1200, height: 800 };
const win = (nodes, title = 'CapCut') => ({ windows: [{ title, frame, nodes }], timedOut: false, truncated: false });
const zoom = { role: 'AXStaticText', name: '100%', position: [50, 760], size: [40, 16] };
const bar = (value, max) => ({ role: 'AXProgressIndicator', name: '', description: '', value, ...(max ? { max } : {}), position: [400, 400], size: [300, 6] });
const pctText = text => ({ role: 'AXStaticText', name: text, position: [560, 380], size: [40, 16] });

test('progression : la barre de CapCut donne le pourcentage, 100 % termine', () => {
  const t = exportTracker(win([zoom]));
  assert.deepEqual(t.update(win([zoom, bar(12, 100)])), { percent: 12, done: null });
  assert.deepEqual(t.update(win([zoom, bar(0.5, 1)])), { percent: 50, done: null }, 'valeur 0…1 comprise');
  assert.equal(t.update(win([zoom, bar(100, 100)])).done, '100 %');
});

test('progression : un « 100% » déjà affiché avant l’export (zoom) n’est jamais pris pour la fin', () => {
  const t = exportTracker(win([zoom]));
  assert.deepEqual(t.update(win([zoom])), { percent: null, done: null });
  assert.deepEqual(t.update(win([zoom])), { percent: null, done: null });
});

test('progression : un texte « 45% » qui avance est suivi, puis la fin est reconnue', () => {
  const t = exportTracker(win([zoom]));
  assert.equal(t.update(win([zoom, pctText('3%')])).percent, 3);
  assert.equal(t.update(win([zoom, pctText('45 %')])).percent, 45);
  assert.equal(t.update(win([zoom, pctText('100%')])).done, '100 %');
});

test('progression : le panneau « Exportation terminée » termine même sans 100 %', () => {
  const t = exportTracker(win([zoom]));
  t.update(win([zoom, bar(97, 100)]));
  const r = t.update(win([zoom, { role: 'AXStaticText', name: 'Exportation terminée', position: [500, 300], size: [200, 20] }]));
  assert.equal(r.done, 'fenêtre de fin');
  assert.ok(exportFinishedShown(win([{ role: 'AXStaticText', name: 'Export completed', position: [1, 1], size: [1, 1] }])));
});

test('progression : une barre disparue n’est conclue qu’après deux lectures complètes', () => {
  const t = exportTracker(win([zoom]));
  t.update(win([zoom, bar(80, 100)]));
  assert.equal(t.update({ ...win([zoom]), timedOut: true }).done, null, 'lecture interrompue : rien n’est conclu');
  assert.equal(t.update({ ...win([zoom]), truncated: true }).done, null, 'limite de contrôles atteinte : rien n’est conclu');
  assert.equal(t.update(win([zoom])).done, null);
  assert.equal(t.update(win([zoom])).done, 'progression disparue');
});

test('progression : progressReadings ignore les petites fenêtres flottantes', () => {
  const ui = { windows: [{ title: '', frame: { x: 0, y: 0, width: 183, height: 88 }, nodes: [bar(50, 100)] }] };
  assert.deepEqual(progressReadings(ui), []);
});

test('lecture macOS : les valeurs numériques (barre de progression) sont conservées', () => {
  const script = capcutUiScript({ progress: true });
  assert.match(script, /typeof value === 'number'/);
  assert.match(script, /AXMaxValue/);
  assert.match(script, /const PROGRESS = true;/);
});

// End to end: CapCut shows 10 %, 30 %, 55 %, 100 %, writes the video only at the very end
// (it encodes elsewhere, then moves it), then keeps its "export finished" panel open,
// which blocks a polite quit until its close button is clicked.
test('pilote : suit le pourcentage de CapCut, trouve le fichier à 100 % et ferme le panneau de fin', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const log = []; let running = false, modal = false, step = -1;
    const steps = [10, 30, 55, 100]; // the first read confirms the click was received
    const editor = [{ role: 'AXStaticText', name: 'MainWindowTitleBarExportBtn', position: [1000, 20], size: [70, 22] }, zoom];
    const actions = {
      accessibility: async () => true, isRunning: async () => running,
      launch: async () => { log.push('launch'); running = true; }, activate: async () => {},
      quit: async () => { log.push(modal ? 'quit refusé' : 'quit'); if (!modal) running = false; },
      click: async p => { log.push(`click ${p.x},${p.y}`); if (modal && p.x === 620 && p.y === 520) modal = false; },
      shortcut: async () => log.push('⌘E'),
      key: async k => { log.push(`key ${k}`); if (k === 'return' && step < 0) { step = 0; actions.readUi = readUi; } },
      playable: async () => true,
    };
    const readUi = async () => {
      if (step < 0) return win(editor);
      if (step < steps.length) {
        const pct = steps[step++];
        if (pct === 100) {
          fs.writeFileSync(path.join(exportDir, 'Test ELPO.mp4'), 'x'.repeat(5000));
          modal = true;
        }
        return win([...editor, bar(pct, 100), pctText(`${pct}%`)]);
      }
      return win([...editor, { role: 'AXStaticText', name: 'Exportation terminée', position: [500, 300], size: [200, 20] },
        { role: 'AXButton', name: 'Fermer', position: [600, 500], size: [40, 40] }]);
    };
    const pilot = new CapcutPilot({ root: f.root, actions, settings: { tile: { x: 10, y: 10 }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, stableSeconds: 0, quitSeconds: 1 } });
    const stages = []; pilot.on('update', jobs => stages.push(jobs[0]?.stage));
    const [job] = await pilot.run([{ path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.stage, 'Terminé');
    assert.match(job.output, /Test ELPO\.mp4$/);
    assert.ok(stages.includes('Export CapCut · 30 %') && stages.includes('Export CapCut · 55 %'), stages.join(' | '));
    assert.ok(pilot.log.some(l => /fin de l’export \(100 %\)/.test(l.text)), pilot.log.map(l => l.text).join('\n'));
    assert.ok(log.includes('click 620,520'), 'le bouton « Fermer » du panneau de fin est cliqué : ' + log.join(' / '));
    assert.equal(log.at(-1), 'quit');
    assert.ok(!running);
  } finally { f.cleanup(); }
});

// Reproduces the real CapCut 9 screens (captures of 10 Oct 2026): the "Exporter-TESTO"
// sheet does not close when the export starts. It switches to « Exportation » with
// « 50.3% », a thin bar and « Annuler », and the « Exporter » button disappears. At the
// end it shows a share panel (« La vidéo est enregistrée sur ton bureau… », TikTok,
// YouTube, « Ouvrir le dossier », « Fermer », « Partager ») that keeps CapCut from
// quitting until « Fermer » is clicked. Return is never sent on the progress view (it
// could hit « Annuler »); « Annuler », « Partager » and TikTok are never clicked.
test('pilote : feuille CapCut 9 réelle — réglages, « 50.3% », panneau de partage, « Fermer »', async () => {
  const f = fixture();
  try {
    const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
    const target = path.join(exportDir, 'TESTO.mp4');
    const log = []; let running = false, sheet = 'none', reads = 0;
    const inspector = { role: 'AXStaticText', name: '100%', position: [1900, 330], size: [60, 20] };
    const settingsView = () => [
      { role: 'AXGroup', name: 'ExportDialog', position: [500, 175], size: [1000, 920] },
      { role: 'AXStaticText', name: 'Exporter-TESTO', position: [510, 190], size: [120, 20] },
      { role: 'AXTextField', name: 'ExportPathInput', value: target, position: [1144, 390], size: [290, 28] },
      { role: 'AXButton', name: 'Annuler', position: [1267, 1037], size: [100, 40] },
      { role: 'AXButton', name: 'ExportOkBtn', position: [1378, 1037], size: [100, 40] },
      inspector,
    ];
    const pcts = ['0.4%', '12.0%', '50.3%', '88.9%'];
    const progressView = () => [
      { role: 'AXGroup', name: 'ExportDialog', position: [175, 5], size: [1400, 1350] },
      { role: 'AXStaticText', name: 'Exportation', position: [905, 145], size: [170, 30] },
      { role: 'AXStaticText', name: pcts[Math.min(reads, pcts.length - 1)], position: [210, 1228], size: [60, 22] },
      { role: 'AXButton', name: 'Annuler', position: [1405, 1287], size: [140, 46] },
      inspector,
    ];
    const sharePanel = () => [
      { role: 'AXGroup', name: 'ExportDialog', position: [66, 18], size: [1440, 1265] },
      { role: 'AXStaticText', name: 'La vidéo est enregistrée sur ton bureau ou ton ordinateur portable. Tu peux la partager dès maintenant.', position: [656, 150], size: [700, 110] },
      { role: 'AXButton', name: 'TikTok', position: [656, 292], size: [386, 72] },
      { role: 'AXButton', name: 'YouTube', position: [1058, 292], size: [386, 72] },
      { role: 'AXButton', name: 'Connexion', position: [656, 572], size: [110, 28] },
      { role: 'AXButton', name: 'Ouvrir le dossier', position: [98, 1208], size: [225, 44] },
      { role: 'AXButton', name: 'Fermer', position: [1170, 1208], size: [144, 44] },
      { role: 'AXButton', name: 'Partager', position: [1330, 1208], size: [144, 44] },
      inspector,
    ];
    const ui = nodes => ({ windows: [{ title: 'TESTO', frame: { x: 0, y: 0, width: 2000, height: 1390 }, nodes }], timedOut: false, truncated: false });
    const actions = {
      accessibility: async () => true, isRunning: async () => running,
      launch: async () => { log.push('launch'); running = true; }, activate: async () => {},
      quit: async () => { log.push(sheet === 'none' ? 'quit' : 'quit refusé'); if (sheet === 'none') running = false; },
      shortcut: async () => { log.push('⌘E'); sheet = 'settings'; },
      click: async p => {
        log.push(`click ${p.x},${p.y}`);
        if (sheet === 'settings' && p.x === 1428 && p.y === 1057) { sheet = 'progress'; actions.readUi = readUi; }
        else if (sheet === 'share' && p.x === 1242 && p.y === 1230) sheet = 'none'; // « Fermer »
      },
      // Escape does not reach the share panel: only its « Fermer » closes it.
      key: async k => { log.push(`key ${k}`); if (k === 'escape' && sheet === 'settings') sheet = 'none'; },
      playable: async () => true,
    };
    const readUi = async () => {
      if (sheet === 'progress') {
        reads++;
        if (reads > pcts.length) { fs.writeFileSync(target, 'x'.repeat(4000)); sheet = 'share'; }
      }
      return ui(sheet === 'progress' ? progressView() : sheet === 'settings' ? settingsView() : sheet === 'share' ? sharePanel() : []);
    };
    const pilot = new CapcutPilot({ root: f.root, actions, settings: { tile: { x: 10, y: 10 }, exportButton: { x: 1428, y: 1057 }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, stableSeconds: 0, quitSeconds: 1 } });
    const stages = []; pilot.on('update', jobs => stages.push(jobs[0]?.stage));
    const [job] = await pilot.run([{ path: f.project, name: 'TESTO' }], { exportDir });
    const notes = pilot.log.map(l => l.text).join('\n');
    assert.equal(job.status, 'done', `${job.error}\n${notes}`);
    assert.equal(job.output, target);
    assert.ok(!log.includes('key return'), 'aucune touche Entrée sur la vue de progression : ' + log.join(' / '));
    assert.ok(!log.includes('click 1475,1310'), '« Annuler » jamais cliqué');
    assert.ok(stages.includes('Export CapCut · 50 %'), stages.join(' | '));
    assert.match(notes, /Export démarré dans CapCut \((vue de progression|progression)\)/);
    assert.match(notes, /fin de l’export \(fenêtre de fin\)/);
    assert.match(notes, /Fichier exporté et vérifié[\s\S]*clic sur « Fermer » en \(1242, 1230\)/, '« Fermer » seulement après le fichier vérifié');
    for (const never of ['click 1402,1230', 'click 849,328', 'click 1251,328', 'click 211,1230']) assert.ok(!log.includes(never), `jamais : ${never} — ${log.join(' / ')}`);
    assert.ok(!log.includes('quit refusé'), 'CapCut quitte du premier coup : ' + log.join(' / '));
    assert.equal(log.at(-1), 'quit');
  } finally { f.cleanup(); }
});

test('panneau de fin CapCut 9 : « Fermer » visé, jamais « Partager »', async () => {
  const { finishedClosePoint } = await import('../lib/capcut-ui.js');
  const panel = nodes => ({ windows: [{ title: 'TESTO', frame: { x: 0, y: 0, width: 1700, height: 1360 }, nodes }] });
  const text = { role: 'AXStaticText', name: 'La vidéo est enregistrée sur ton bureau ou ton ordinateur portable.', position: [656, 150], size: [700, 60] };
  const fermer = { role: 'AXButton', name: 'Fermer', position: [1170, 1208], size: [144, 44] };
  const partager = { role: 'AXButton', name: 'Partager', position: [1330, 1208], size: [144, 44] };
  assert.deepEqual(finishedClosePoint(panel([text, partager, fermer])), { x: 1242, y: 1230 });
  assert.equal(finishedClosePoint(panel([text, partager])), null, 'sans « Fermer », rien n’est cliqué');
  assert.equal(finishedClosePoint(panel([fermer, partager])), null, 'hors panneau de fin, « Fermer » n’est pas visé');
  assert.ok(exportFinishedShown(panel([text])));
});
