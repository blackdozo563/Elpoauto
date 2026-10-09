import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExportQueue } from '../lib/export-queue.js';

test('file d’export : la fin d’un lot ne compte que ses propres vidéos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-queue-'));
  try {
    const queue = new ExportQueue({ tool: { ffmpeg: '/bin/false', encoders: {}, filters: {} }, plan: async () => ({}) });
    queue.execute = async job => { job.status = 'done'; job.progress = 1; };
    const idle = () => new Promise(resolve => queue.once('idle', resolve));
    let done = idle();
    queue.add([{ path: '/p/a', name: 'A' }, { path: '/p/b', name: 'B' }], { outputDir: dir });
    assert.deepEqual((await done).map(j => j.name), ['A', 'B']);
    done = idle();
    queue.add([{ path: '/p/c', name: 'C' }], { outputDir: dir });
    assert.deepEqual((await done).map(j => j.name), ['C']);
    assert.equal(queue.list().length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
