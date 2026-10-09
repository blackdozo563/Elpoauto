import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fixture } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';
test('worker : initialisation, catalogue, aperçu, refus de commit sur Linux', async () => {
  const f = fixture();
  const worker = new Worker(new URL('../lib/worker.js', import.meta.url));
  let sequence = 0;
  const pending = new Map();
  worker.on('message', reply => { const cb = pending.get(reply.id); if (cb) { pending.delete(reply.id); cb(reply); } });
  const call = (action, args = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); worker.postMessage({ id, action, args }); });
  try {
    assert((await call('init', { root: f.root, backupDir: f.backupDir })).ok);
    const list = await call('list'); assert(list.ok); assert.equal(list.result.length, 1);
    const preview = await call('preview', { project: f.project, options: {} }); assert(preview.ok); assert.equal(preview.result.scenes, 2);
    if (process.platform !== 'darwin') { const commit = await call('commit', { token: preview.result.token }); assert.equal(commit.ok, false); assert.equal(commit.error.code, 'PLATFORM'); }
    const folder=path.join(f.temp,'Flow');fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder,'001.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64'));
    const selected=await call('setVisualFolder',{project:f.project,folder});assert(selected.ok);assert.equal(selected.result.visuals.length,1);
    const flowPreview=await call('preview',{project:f.project,options:{}});assert(flowPreview.ok);assert.equal(flowPreview.result.scenes,1);
    assert.equal(flowPreview.result.rows[0].path,path.join(folder,'001.png'));
    assert((await call('setVisualFolder',{project:f.project,folder:null})).ok);
    assert.equal((await call('inspect',{project:f.project})).result.visuals.length,2);
  } finally { await worker.terminate(); f.cleanup(); }
});
