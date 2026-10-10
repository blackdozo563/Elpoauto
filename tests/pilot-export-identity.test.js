import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { CapcutPilot } from '../lib/capcut-pilot.js';

test('pilote CapCut 9 : chemin de sortie absent, aucun export et lot interrompu', async () => {
  const f = fixture(), log = [];
  const exportDir = path.join(f.temp, 'exports');
  fs.mkdirSync(exportDir);
  let running = false, page = 'home';
  const ui = ids => ({ windows: [{ title: 'CapCut', nodes: ids.map(description => ({ role: 'AXStaticText', description })) }] });
  const actions = {
    accessibility: async () => true,
    isRunning: async () => running,
    assertClosed: () => assert.equal(running, false),
    launch: async () => { running = true; },
    quit: async () => { log.push('quit'); running = false; },
    activate: async () => {},
    readUi: async () => ui(page === 'home' ? ['HomePageDraft'] : page === 'editor' ? ['MainTimeLineRoot'] : ['ExportDialog', 'ExportOkBtn']),
    click: async () => { log.push('click'); page = 'editor'; },
    shortcut: async () => { log.push('shortcut'); page = 'sheet'; },
    key: async key => { log.push(key); },
  };
  const pilot = new CapcutPilot({ root: f.root, backupDir: f.backupDir, actions, settings: {
    tile: { x: 200, y: 250 }, exportButton: { x: 1000, y: 700 }, launchSeconds: 0, openSeconds: 0, dialogSeconds: 0,
  } });
  const project = { path: f.project, name: 'Test ELPO' };
  try {
    const [job, pending] = await pilot.run([project, project], { exportDir });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /chemin de sortie.*illisible/);
    assert.equal(pending.status, 'cancelled');
    assert.deepEqual(log, ['click', 'shortcut'], 'seuls l’ouverture du projet et du dialogue sont autorisés');
  } finally { f.cleanup(); }
});
