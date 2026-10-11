// The CapCut pilot against a CapCut 9.3.0 replayed from the real recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { simulatedCapcut, FAST } from './capcut-sim.js';
import { CapcutPilot, bumpProject, missingMedia, listVideos, exportedFile, outputsOf, DEFAULT_PILOT } from '../lib/capcut-pilot.js';
import { readJson } from '../lib/storage.js';

function setup(options = {}, settings = {}) {
  const f = fixture();
  const exportDir = path.join(f.temp, 'exports'); fs.mkdirSync(exportDir);
  const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', ...options });
  const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: { ...FAST, ...settings } });
  const projects = n => Array.from({ length: n }, () => ({ path: f.project, name: 'Test ELPO' }));
  return { f, exportDir, sim, pilot, projects };
}
const notes = pilot => pilot.log.map(l => l.text).join('\n');

test('pilote : cycle complet sur les écrans réels — vignette par son nom, Exporter, fichier vérifié, Fermer, sortie', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    const before = Date.now();
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.output, path.join(exportDir, 'Test ELPO.mp4'));
    assert.deepEqual(sim.log, ['launch', 'clic 315,487 double HomePageDraft', 'clic 1310,64 MainWindowTitleBarExportBtn',
      'press ExportOkBtn', 'fichier Test ELPO.mp4', 'press automationcloseBtn', 'quit']);
    assert.ok(readJson(f.metaFile).value.tm_draft_modified >= before * 1000, 'projet placé en tête');
    assert.ok(readJson(f.indexFile).value.all_draft_store[0].tm_draft_modified >= before * 1000);
    assert.match(notes(pilot), /Vignette « Test ELPO » reconnue par son nom/);
    assert.match(notes(pilot), /Fichier annoncé par CapCut : .*Test ELPO\.mp4/);
    assert.match(notes(pilot), /Durée de la timeline : 275\.7 s/);
    assert.match(notes(pilot), /Export démarré dans CapCut/);
  } finally { f.cleanup(); }
});

test('pilote : trois projets à la suite, CapCut fermé puis relancé entre chaque', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    const jobs = await pilot.run(projects(3), { exportDir });
    assert.deepEqual(jobs.map(j => j.status), ['done', 'done', 'done'], jobs.map(j => j.error).join(' / '));
    assert.equal(sim.log.filter(l => l === 'launch').length, 3);
    assert.equal(sim.log.filter(l => l === 'press ExportOkBtn').length, 3, 'un seul Exporter par projet');
    assert.equal(sim.log.filter(l => l === 'press automationcloseBtn').length, 3);
    assert.equal(sim.log.filter(l => l === 'quit').length, 3);
    assert.ok(!sim.log.some(l => ['term', 'kill'].includes(l)), 'aucune fermeture forcée');
  } finally { f.cleanup(); }
});

test('pilote : noms des vignettes masqués après le lancement — première vignette, identité vérifiée sur la feuille', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ layout: 'cut' });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(sim.log[1], 'clic 315,777 double HomePageDraft');
    assert.match(notes(pilot), /première vignette \(projet placé en tête\)/);
  } finally { f.cleanup(); }
});

test('pilote : un autre projet ouvert par la première vignette — aucun Exporter, lot arrêté', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ layout: 'cut', firstTile: 'Autre projet' });
  try {
    const jobs = await pilot.run(projects(2), { exportDir });
    assert.equal(jobs[0].status, 'failed');
    assert.match(jobs[0].error, /s’apprête à exporter « Autre projet\.mp4 » au lieu de « Test ELPO »/);
    assert.ok(!sim.log.includes('press ExportOkBtn'), 'aucun export envoyé');
    assert.equal(jobs[1].status, 'cancelled');
    assert.equal(sim.state().page, 'settings', 'CapCut laissé tel quel pour que tu voies le problème');
  } finally { f.cleanup(); }
});

test('pilote : double-clic non reçu — un seul nouvel essai sur la vignette relue', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ missDoubleClicks: 1 }, { openSeconds: 6 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(sim.log.filter(l => l.startsWith('clic 315,487 double')).length, 2);
    assert.match(notes(pilot), /double-clic non reçu/);
  } finally { f.cleanup(); }
});

test('pilote : projet qui ne s’ouvre jamais — erreur claire, pas de troisième clic', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ missDoubleClicks: 9 }, { openSeconds: 6 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /ne s’est pas ouvert dans l’éditeur.*CapCut affiche : accueil/);
    assert.equal(sim.log.filter(l => l.includes('double')).length, 2);
  } finally { f.cleanup(); }
});

test('pilote : clic sur « Exporter » de l’éditeur non reçu — un seul nouvel essai', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ missExportClicks: 1 }, { dialogSeconds: 4 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(sim.log.filter(l => l.endsWith('MainWindowTitleBarExportBtn')).length, 2);
  } finally { f.cleanup(); }
});

test('pilote : clic final sans effet — aucun second envoi, lot interrompu', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ missPresses: 1 }, { startSeconds: 2 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.equal(sim.log.filter(l => l === 'press ExportOkBtn').length, 1);
    assert.doesNotMatch(notes(pilot), /Nouvel essai unique par AXPress/);
  } finally { f.cleanup(); }
});

test('pilote : Exporter jamais reçu — erreur explicite, jamais de troisième essai ni de touche Entrée', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ missPresses: 9 }, { startSeconds: 2 });
  try {
    const jobs = await pilot.run(projects(2), { exportDir });
    assert.equal(jobs[0].status, 'failed');
    assert.match(jobs[0].error, /n’a pas commencé l’export.*réglages d’export/);
    assert.equal(sim.log.filter(l => l === 'press ExportOkBtn').length, 1);
    assert.equal(jobs[1].status, 'cancelled');
  } finally { f.cleanup(); }
});

test('pilote : AXPress sans effet observé sur Mac — le dernier Exporter utilise directement la souris', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ requireExportMouse: true }, { startSeconds: 1 });
  const nativePress = sim.driver.press;
  const attempts = [];
  sim.driver.press = async args => { attempts.push(args); return nativePress(args); };
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    const final = attempts.filter(a => a.label === 'ExportOkBtn');
    assert.equal(final.length, 1);
    assert.equal(final[0].mouse, true);
    assert.equal(attempts.find(a => a.label === 'automationcloseBtn').mouse, undefined, 'Fermer reste AXPress');
  } finally { f.cleanup(); }
});

test('pilote : clic refusé car CapCut n’était pas au premier plan — remis devant, un seul nouvel essai', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    const click = sim.driver.click; let refused = 0, activated = 0;
    sim.driver.click = async args => (refused++ < 1 ? { ok: false, code: 'NOT_FRONTMOST', message: 'CapCut n’a pas pu passer au premier plan.', commandAttempted: false } : click(args));
    sim.actions.activate = async () => { activated++; };
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(activated, 1);
    assert.match(notes(pilot), /Nouvel essai après avoir remis CapCut au premier plan/);
  } finally { f.cleanup(); }
});

test('pilote : AXPress reçu mais réponse incertaine — effet vérifié, aucun second envoi', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ uncertainPress: true });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(sim.log.filter(l => l === 'press ExportOkBtn').length, 1);
    assert.match(notes(pilot), /réponse incertaine.*vérification de son effet/);
  } finally { f.cleanup(); }
});

test('pilote : nom refusé par l’outil natif au dernier moment — aucun export, erreur d’identité', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    sim.driver.press = async ({ label }) => (label === 'ExportOkBtn' ? { ok: false, code: 'TARGET_MISMATCH', message: 'CapCut s’apprête à exporter « Autre.mp4 ».', commandAttempted: false } : { ok: false, code: 'WRONG_VIEW', message: 'x', commandAttempted: false });
    const jobs = await pilot.run(projects(2), { exportDir });
    assert.equal(jobs[0].status, 'failed');
    assert.match(jobs[0].error, /Autre\.mp4/);
    assert.equal(jobs[1].status, 'cancelled');
  } finally { f.cleanup(); }
});

test('pilote : vidéo plus courte que la timeline — livrée avec une remarque après la fin annoncée', async () => {
  const { f, exportDir, pilot, projects } = setup({ probeSeconds: 120 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.match(notes(pilot), /Durée exportée 120\.0 s pour une timeline de 275\.7 s/);
  } finally { f.cleanup(); }
});

test('pilote : vidéo illisible après la fin annoncée — erreur, jamais une attente sans fin', async () => {
  const { f, exportDir, pilot, projects } = setup({ incompleteProbes: 1e9 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /FFprobe ne lit pas/);
  } finally { f.cleanup(); }
});

test('pilote : la progression de CapCut est suivie et affichée', async () => {
  const { f, exportDir, pilot, projects } = setup({ step: 20 });
  try {
    const stages = []; pilot.on('update', jobs => stages.push(jobs[0].stage));
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    // 10 % at the click, 30 % seen while confirming the start, then 50, 70, 90.
    assert.ok(stages.some(s => /^Export CapCut · 50 %$/.test(s)), stages.join(' | '));
    assert.ok(stages.some(s => /^Export CapCut · 90 %$/.test(s)));
    assert.match(notes(pilot), /Export démarré dans CapCut \(30 %\)/);
    assert.ok(stages.includes('CapCut a terminé · vérification du fichier'));
  } finally { f.cleanup(); }
});

test('pilote : fichier encore illisible pour FFprobe — attente, puis validé', async () => {
  const { f, exportDir, pilot, projects } = setup({ incompleteProbes: 3 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.match(notes(pilot), /pas encore complet pour FFprobe/);
  } finally { f.cleanup(); }
});

test('pilote : sans FFprobe, la fin annoncée par CapCut et un fichier stable suffisent', async () => {
  const { f, exportDir, pilot, projects } = setup({ noProbe: true });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
  } finally { f.cleanup(); }
});

test('pilote : fichier déjà présent — CapCut écrit « (1) », retrouvé comme le bon fichier', async () => {
  const { f, exportDir, pilot, projects } = setup({ fileName: 'Test ELPO(1).mp4' });
  try {
    fs.writeFileSync(path.join(exportDir, 'Test ELPO.mp4'), 'ancien export');
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.output, path.join(exportDir, 'Test ELPO(1).mp4'));
  } finally { f.cleanup(); }
});

test('pilote : fichier apparu après le panneau de fin — attendu', async () => {
  const { f, exportDir, pilot, projects } = setup({ fileDelayReads: 4 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
  } finally { f.cleanup(); }
});

test('pilote : fin annoncée sans fichier — erreur, lot arrêté', async () => {
  const { f, exportDir, pilot, projects } = setup({ noFile: true });
  try {
    const jobs = await pilot.run(projects(2), { exportDir });
    assert.equal(jobs[0].status, 'failed');
    assert.match(jobs[0].error, /aucun fichier n’est apparu/);
    assert.equal(jobs[1].status, 'cancelled');
  } finally { f.cleanup(); }
});

test('pilote : progression bloquée — export déclaré bloqué, CapCut laissé tel quel', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ stuck: 70 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /Aucune progression ni écriture depuis .* \(bloqué à 70 %\)/);
    assert.equal(sim.state().page, 'exporting');
    assert.ok(!sim.log.includes('term') && !sim.log.includes('kill'));
  } finally { f.cleanup(); }
});

test('pilote : feuille d’export disparue en cours de route — export interrompu', async () => {
  const { f, exportDir, pilot, projects } = setup({ cancelAt: 40 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /annulé ou interrompu/);
  } finally { f.cleanup(); }
});

test('pilote : fenêtre d’erreur de CapCut pendant l’export — signalée avec ses éléments', async () => {
  const { f, exportDir, pilot, projects } = setup({ errorAt: 40 });
  try {
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /fenêtre inattendue pendant l’export.*automationErrorOkBtn/);
  } finally { f.cleanup(); }
});

test('pilote : CapCut exporte ailleurs que le dossier choisi — dossier annoncé surveillé', async () => {
  const { f, exportDir, projects } = setup();
  try {
    const elsewhere = path.join(f.temp, 'Bureau'); fs.mkdirSync(elsewhere);
    const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', announceFolder: elsewhere });
    const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: FAST });
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.output, path.join(elsewhere, 'Test ELPO.mp4'));
    assert.match(notes(pilot), /CapCut exporte dans .*Bureau/);
  } finally { f.cleanup(); }
});

test('pilote : dossier annoncé illisible — aucun export envoyé', async () => {
  const { f, exportDir, projects } = setup();
  try {
    const sim = simulatedCapcut({ exportDir, name: 'Test ELPO', announceFolder: path.join(f.temp, 'absent') });
    const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions: sim.actions, driver: sim.driver, settings: FAST });
    const [job] = await pilot.run(projects(1), { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /ne peut pas lire .*absent/);
    assert.ok(!sim.log.includes('press ExportOkBtn'));
  } finally { f.cleanup(); }
});

test('pilote : médias manquants détectés avant d’ouvrir CapCut, le lot continue', async () => {
  const { f, exportDir, sim, pilot } = setup();
  try {
    fs.unlinkSync(f.items[0].file_Path);
    assert.deepEqual(missingMedia(f.project), ['scene-1.png']);
    const jobs = await pilot.run([{ path: f.project, name: 'Test ELPO' }, { path: f.project, name: 'Test ELPO' }], { exportDir });
    assert.deepEqual(jobs.map(j => j.status), ['failed', 'failed']);
    assert.match(jobs[0].error, /introuvable.*relie-les dans CapCut/);
    assert.ok(!sim.log.includes('launch'), 'CapCut n’est pas lancé');
  } finally { f.cleanup(); }
});

test('pilote : commande native incertaine — lot arrêté, aucun nouvel essai', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    sim.driver.click = async () => ({ ok: false, code: 'DRIVER_ERROR', message: 'Interrompu après l’envoi.', commandAttempted: true });
    const jobs = await pilot.run(projects(2), { exportDir });
    assert.equal(jobs[0].status, 'failed');
    assert.match(jobs[0].error, /Interrompu après l’envoi/);
    assert.equal(jobs[1].status, 'cancelled');
  } finally { f.cleanup(); }
});

test('pilote : outil natif absent, dossier d’export absent, accessibilité refusée', async () => {
  const { f, exportDir, sim, projects } = setup();
  try {
    const missing = new CapcutPilot({ root: f.root, actions: sim.actions, driver: { available: () => false }, settings: FAST });
    await assert.rejects(missing.run(projects(1), { exportDir }), e => e.code === 'NATIVE_MISSING');
    assert.equal(missing.controller, null);
    const noDir = new CapcutPilot({ root: f.root, actions: sim.actions, driver: sim.driver, settings: FAST });
    await assert.rejects(noDir.run(projects(1), { exportDir: path.join(f.temp, 'nulle-part') }), e => e.code === 'EXPORT_DIR');
    const denied = new CapcutPilot({ root: f.root, actions: { ...sim.actions, accessibility: async () => false }, driver: sim.driver, settings: FAST });
    await assert.rejects(denied.run(projects(1), { exportDir }), e => e.code === 'ACCESSIBILITY');
    assert.equal(denied.controller, null);
    assert.throws(() => bumpProject(f.root, f.temp), e => e.code === 'PROJECT_PATH');
  } finally { f.cleanup(); }
});

test('pilote : un second lancement est refusé pendant la vérification d’accessibilité', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    let grant; sim.actions.accessibility = () => new Promise(resolve => { grant = resolve; });
    const first = pilot.run(projects(1), { exportDir });
    assert.ok(pilot.controller, 'le pilotage est réservé dès l’appel');
    await assert.rejects(pilot.run(projects(1), { exportDir }), e => e.code === 'PILOT_BUSY');
    grant(true);
    const [job] = await first;
    assert.equal(job.status, 'done', job.error);
    assert.equal(pilot.controller, null);
  } finally { f.cleanup(); }
});

test('pilote : pause avant la prochaine action CapCut, reprise, puis arrêt pendant une pause', async () => {
  const { f, exportDir, sim, pilot, projects } = setup();
  try {
    const events = []; pilot.on('paused', e => events.push(e.paused));
    assert.equal(pilot.pause(), false, 'aucune pause hors pilotage');
    const first = pilot.run(projects(1), { exportDir });
    assert.equal(pilot.pause('La souris a bougé.'), true);
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(sim.log, [], 'CapCut n’est pas lancé pendant la pause');
    assert.equal(pilot.resume(), true);
    const [job] = await first;
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(events, [true, false]);
    const second = pilot.run(projects(1), { exportDir });
    pilot.pause(); await new Promise(r => setTimeout(r, 30)); pilot.stop();
    const [stopped] = await second;
    assert.equal(stopped.status, 'cancelled'); assert.equal(pilot.paused, false);
  } finally { f.cleanup(); }
});

test('pilote : arrêt pendant l’encodage — CapCut continue, rien n’est fermé de force', async () => {
  const { f, exportDir, sim, pilot, projects } = setup({ stuck: 50 }, { stallMinutes: 5 });
  try {
    const running = pilot.run(projects(2), { exportDir });
    for (let i = 0; i < 200 && sim.state().page !== 'exporting'; i++) await new Promise(r => setTimeout(r, 5));
    pilot.stop();
    const jobs = await running;
    assert.deepEqual(jobs.map(j => j.status), ['cancelled', 'cancelled']);
    assert.equal(sim.state().page, 'exporting');
    assert.ok(!sim.log.some(l => ['quit', 'term', 'kill'].includes(l)));
  } finally { f.cleanup(); }
});

test('surveillance : fichiers du projet seulement, nouveaux ou modifiés depuis Exporter', () => {
  const f = fixture();
  try {
    const dir = path.join(f.temp, 'out'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Test ELPO.mp4'), 'ancien');
    fs.writeFileSync(path.join(dir, 'Autre.mp4'), 'autre');
    const before = outputsOf(dir, 'Test ELPO');
    assert.deepEqual([...before.keys()].map(p => path.basename(p)), ['Test ELPO.mp4']);
    const since = Date.now();
    assert.equal(exportedFile(dir, path.join(dir, 'Test ELPO.mp4'), 'Test ELPO', before, since), null, 'le fichier ancien n’est pas cet export');
    fs.writeFileSync(path.join(dir, 'Test ELPO(1).mp4'), 'nouveau');
    assert.equal(path.basename(exportedFile(dir, path.join(dir, 'Test ELPO.mp4'), 'Test ELPO', before, since)), 'Test ELPO(1).mp4');
    assert.deepEqual(listVideos(dir).map(p => path.basename(p)).sort(), ['Autre.mp4', 'Test ELPO(1).mp4', 'Test ELPO.mp4']);
  } finally { f.cleanup(); }
});

test('réglages : délais maximum par défaut, sans point visé', () => {
  for (const k of ['tile', 'home', 'exportButton', 'frames', 'closeKeys', 'openWith']) assert.equal(k in DEFAULT_PILOT, false, k);
  assert.ok(DEFAULT_PILOT.launchSeconds >= 30 && DEFAULT_PILOT.stallMinutes >= 1);
});
