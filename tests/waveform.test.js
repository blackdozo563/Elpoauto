import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PeakReducer, binPeaks, waveform } from '../lib/waveform.js';
import { findFfmpeg } from '../lib/export-queue.js';
import { MediaServer } from '../lib/media-server.js';

test('forme d’onde : pics par bloc, morceaux coupés au milieu d’un échantillon', () => {
  const samples = Buffer.alloc(8 * 2);
  [100, -300, 50, 20, -32767, 10, 5, 7].forEach((v, i) => samples.writeInt16LE(v, i * 2));
  const r = new PeakReducer(4);
  r.push(samples.subarray(0, 3)); r.push(samples.subarray(3, 11)); r.push(samples.subarray(11));
  assert.deepEqual(r.end(), [300, 32767]);
  assert.deepEqual(binPeaks([300, 32767], 10), [0.009, 1]);
  assert.deepEqual(binPeaks([1, 2, 3, 32767], 2), [0, 1]);
  assert.deepEqual(binPeaks([], 10), []);
});
test('forme d’onde : jeton de lecture résolu vers le fichier autorisé seulement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-wave-'));
  try {
    const file = path.join(dir, 'voix.wav'); fs.writeFileSync(file, 'RIFF-synthetic');
    const media = new MediaServer(), urls = media.grant([{ path: file }], 'project');
    assert.equal(media.resolve(urls[file]).real, fs.realpathSync(file));
    assert.equal(media.resolve('elpo-media://local/inconnu'), null);
    assert.equal(media.resolve('file:///etc/passwd'), null);
    assert.equal(media.resolve(urls[file] + '?x=1'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const tool = await findFfmpeg();
test('forme d’onde : vraie analyse FFmpeg d’un son de 3 s', { skip: !tool && 'FFmpeg absent' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-wave-'));
  try {
    const file = path.join(dir, 'voix.wav');
    execFileSync(tool.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', file]);
    const { peaks, seconds } = await waveform(tool.ffmpeg, file);
    assert.ok(Math.abs(seconds - 3) < 0.05, `durée lue : ${seconds}`);
    assert.equal(peaks.length, 120);
    assert.ok(Math.max(...peaks) > 0.05 && Math.max(...peaks) <= 1);
    await assert.rejects(waveform(tool.ffmpeg, path.join(dir, 'absent.wav')), e => e.code === 'WAVEFORM');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
