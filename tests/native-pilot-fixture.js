import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
export const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/capcut-native-cycle.json', import.meta.url)));
export const FAST = { launchSeconds: 0, openSeconds: 0, dialogSeconds: 0, startSeconds: 0, timeoutMinutes: 0.005, quitSeconds: 0.01, pollMs: 1 };
export function setup({ beforeOpen = false, stubborn = false, corrupt = null, neverKill = false, duration = 5, create = true } = {}) {
  const f = fixture(); f.raw.duration = 5000000; f.write(f.draftFile, f.raw); f.meta.tm_duration = 5000000; f.write(f.metaFile, f.meta);
  const dir = path.join(f.temp, 'exports'); fs.mkdirSync(dir);
  let running = beforeOpen, page = 'home', target = null, presses = 0, encodingReads = 0;
  const log = [];
  const source = { home: 0, editor: 7, 'export-settings': 13, encoding: 20, done: 58 };
  const actions = {
    accessibility: async () => true, probeAvailable: () => true,
    assertClosed: () => { if (running) throw new Error('Projet protégé : CapCut ouvert'); },
    isRunning: async () => running,
    launch: async () => { running = true; page = 'home'; log.push('launch'); },
    quit: async () => { log.push('quit'); if (!stubborn) running = false; },
    forceQuit: async hard => { log.push(hard ? 'kill' : 'term'); if (corrupt) fs.writeFileSync(corrupt, '{cut'); if (!neverKill) running = false; },
    state: async () => {
      if (page === 'encoding' && ++encodingReads > 1 && create) { fs.writeFileSync(target, 'fichier simulé, ffprobe injecté uniquement dans ce test'); page = 'done'; }
      const snapshot = structuredClone(recorded.frames.find(f => f.fixtureSourceIndex === source[page]));
      snapshot.state = { page, percent: page === 'encoding' ? 38.4 : null, outputPath: page === 'export-settings' ? target : null };
      log.push(`state:${page}`); return snapshot;
    },
    openProject: async name => { log.push(`open-project:${name}`); page = 'editor'; return { ok: true }; },
    openExport: async () => { log.push('open-export'); page = 'export-settings'; target = path.join(dir, `Test ELPO${presses ? `(${presses})` : ''}.mp4`); return { ok: true }; },
    pressExport: async () => { log.push('press-export'); presses++; page = 'encoding'; encodingReads = 0; return { ok: true, outputPath: target }; },
    closeDone: async () => { log.push('close-done'); page = 'editor'; return { ok: true }; },
    probeDuration: async () => ({ duration, video: true }),
  };
  return { f, dir, log, actions, setPage: p => { page = p; }, project: { path: f.project, name: 'Test ELPO' } };
}
