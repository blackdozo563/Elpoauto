import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MediaServer } from '../lib/media-server.js';
import { fixture } from './fixtures.js';
const request = (url, range, method = 'GET') => new Request(url, { method, headers: range ? { range } : {} });
test('lecture locale : octets complets et requêtes de déplacement audio', async () => {
  const f = fixture();
  try {
    const file = f.items.at(-1).file_Path; fs.writeFileSync(file, '0123456789');
    const server = new MediaServer(), url = server.grant([{ path: file }])[file];
    let r = await server.handle(request(url)); assert.equal(r.status, 200); assert.equal(await r.text(), '0123456789');
    r = await server.handle(request(url, 'bytes=2-5')); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await r.text(), '2345');
    r = await server.handle(request(url, 'bytes=8-')); assert.equal(await r.text(), '89');
    r = await server.handle(request(url, 'bytes=-3')); assert.equal(await r.text(), '789');
    r = await server.handle(request(url, undefined, 'HEAD')); assert.equal(r.headers.get('content-length'), '10'); assert.equal(await r.text(), '');
  } finally { f.cleanup(); }
});
test('lecture locale : accès non accordé, plages invalides et jetons révoqués', async () => {
  const f = fixture();
  try {
    const file = f.items.at(-1).file_Path, server = new MediaServer(), url = server.grant([{ path: file }])[file];
    for (const range of ['bytes=999999-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'no']) assert.equal((await server.handle(request(url, range))).status, 416);
    assert.equal((await server.handle(request('elpo-media://local/etc/passwd'))).status, 404);
    assert.equal((await server.handle(request(url.replace('local', 'other')))).status, 404);
    assert.equal((await server.handle(request(url, undefined, 'POST'))).status, 405);
    server.clear(); assert.equal((await server.handle(request(url))).status, 404);
  } finally { f.cleanup(); }
});
test('lecture locale : média modifié ou remplacé par un lien bloqué', async () => {
  const f = fixture();
  try {
    const file = f.items.at(-1).file_Path, server = new MediaServer();
    let url = server.grant([{ path: file }])[file]; fs.appendFileSync(file, 'changed'); assert.equal((await server.handle(request(url))).status, 409);
    url = server.grant([{ path: file }])[file]; fs.unlinkSync(file); fs.symlinkSync(f.items[0].file_Path, file); assert.equal((await server.handle(request(url))).status, 404);
  } finally { f.cleanup(); }
});
