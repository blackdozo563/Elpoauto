// Waveform peaks computed by FFmpeg in the main process. The window never decodes a whole
// voice-over: 30 minutes of audio is about 700 MB of samples once decoded by the browser.
import { spawn } from 'node:child_process';

export const WAVE_RATE = 4000; // mono samples per second analysed
export const WAVE_BLOCK = 100; // samples per stored peak (25 ms)

// Streaming reducer: keeps one peak per block, never the whole signal.
export class PeakReducer {
  constructor(block = WAVE_BLOCK) { this.block = block; this.blocks = []; this.current = 0; this.count = 0; this.carry = null; }
  push(chunk) {
    const buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = Math.abs(buf.readInt16LE(i));
      if (v > this.current) this.current = v;
      if (++this.count === this.block) { this.blocks.push(this.current); this.current = 0; this.count = 0; }
    }
    this.carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
  }
  end() { if (this.count) this.blocks.push(this.current); this.current = 0; this.count = 0; return this.blocks; }
}

// At most `bins` values between 0 and 1: the loudest block of each bin.
export function binPeaks(blocks, bins = 1600) {
  if (!blocks.length) return [];
  const n = Math.min(bins, blocks.length), out = new Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * blocks.length / n), end = Math.floor((i + 1) * blocks.length / n); j < end; j++) if (blocks[j] > m) m = blocks[j];
    out[i] = Math.round(m / 32767 * 1000) / 1000;
  }
  return out;
}

export function waveform(ffmpeg, file, { bins = 1600, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const reducer = new PeakReducer();
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(WAVE_RATE), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => reducer.push(chunk));
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error(`Forme d’onde indisponible : ${errors.trim().split('\n').at(-1) || 'FFmpeg interrompu'}.`), { code: 'WAVEFORM' }));
      const blocks = reducer.end();
      resolve({ peaks: binPeaks(blocks, bins), seconds: blocks.length * WAVE_BLOCK / WAVE_RATE });
    });
  });
}
