// Export queue: runs ELPO renders one project at a time (or a few in parallel),
// reports progress, can be cancelled, and never leaves a half-written MP4 behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildJob } from './render.js';

const run = (file, args, timeout = 15000) => new Promise(resolve => execFile(file, args, { timeout, maxBuffer: 8e6 }, (error, stdout) => resolve(error ? null : String(stdout))));

// FFmpeg is not part of macOS: look where Homebrew and MacPorts install it, or use the chosen binary.
export async function findFfmpeg(custom = null) {
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
  const candidates = [custom, ...dirs.map(d => d && path.join(d, 'ffmpeg'))].filter(Boolean);
  for (const ffmpeg of [...new Set(candidates)]) {
    if (!path.isAbsolute(ffmpeg) || !fs.existsSync(ffmpeg)) continue;
    const version = await run(ffmpeg, ['-hide_banner', '-version']);
    if (!version) continue;
    const encoders = (await run(ffmpeg, ['-hide_banner', '-encoders'])) || '', filters = (await run(ffmpeg, ['-hide_banner', '-filters'])) || '';
    const has = (text, name) => new RegExp(`\\s${name}\\s`).test(text);
    const probe = path.join(path.dirname(ffmpeg), 'ffprobe');
    return { ffmpeg, ffprobe: fs.existsSync(probe) ? probe : null, version: version.split('\n')[0].replace(/^ffmpeg version\s*/, '').split(' ')[0],
      encoders: Object.fromEntries(['libx264', 'libx265', 'h264_videotoolbox', 'hevc_videotoolbox'].map(n => [n, has(encoders, n)])),
      filters: Object.fromEntries(['xfade', 'zoompan', 'subtitles', 'amix'].map(n => [n, has(filters, n)])) };
  }
  return null;
}

export async function hasAudioStream(ffprobe, file) {
  if (!ffprobe) return true;
  const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return out === null ? true : out.trim().length > 0;
}

const safeName = s => String(s).normalize('NFC').replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'export';
export function outputName(pattern, { name, date = new Date(), index = 1 }) {
  const d = date.toISOString().slice(0, 10);
  return safeName(String(pattern || '{projet}').replaceAll('{projet}', name).replaceAll('{date}', d).replaceAll('{n}', String(index).padStart(2, '0'))) + '.mp4';
}
export function uniquePath(dir, file) {
  const ext = path.extname(file), base = file.slice(0, -ext.length);
  let candidate = path.join(dir, file), n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++})${ext}`);
  return candidate;
}

export class ExportQueue extends EventEmitter {
  // plan(project) returns the render plan; tool is the result of findFfmpeg.
  constructor({ plan, tool, tmp = os.tmpdir() }) {
    super(); this.plan = plan; this.tool = tool; this.tmp = tmp; this.jobs = []; this.running = new Map(); this.concurrency = 1;
  }
  list() { return this.jobs.map(({ child, ...job }) => job); }
  active() { return this.jobs.some(j => ['queued', 'preparing', 'rendering'].includes(j.status)); }
  add(projects, settings) {
    if (!this.tool) throw Object.assign(new Error('FFmpeg est introuvable. Installe-le (brew install ffmpeg) ou indique son emplacement dans Réglages.'), { code: 'FFMPEG_MISSING' });
    if (!settings?.outputDir || !fs.existsSync(settings.outputDir)) throw Object.assign(new Error('Choisis un dossier de sortie existant.'), { code: 'OUTPUT_DIR' });
    this.concurrency = Math.min(3, Math.max(1, Number(settings.parallel) || 1));
    const added = projects.map((p, i) => ({ id: randomUUID(), project: p.path, name: p.name, subtitles: p.subtitles || null, settings: { ...settings }, index: i + 1,
      status: 'queued', progress: 0, stage: 'En attente', created: Date.now(), output: null, error: null, warnings: [] }));
    this.jobs.push(...added); this.changed(); this.pump();
    return added.map(j => j.id);
  }
  cancel(id = null) {
    for (const job of this.jobs.filter(j => (!id || j.id === id) && ['queued', 'preparing', 'rendering'].includes(j.status))) {
      job.cancelled = true;
      if (job.status === 'queued') { job.status = 'cancelled'; job.stage = 'Annulé'; }
      job.child?.kill('SIGTERM');
    }
    this.changed();
  }
  clearFinished() { this.jobs = this.jobs.filter(j => ['queued', 'preparing', 'rendering'].includes(j.status)); this.changed(); }
  changed() { this.emit('update', this.list()); }
  pump() {
    while (this.running.size < this.concurrency) {
      const job = this.jobs.find(j => j.status === 'queued');
      if (!job) break;
      this.running.set(job.id, this.execute(job).finally(() => { this.running.delete(job.id); this.pump(); if (!this.active()) this.emit('idle', this.list()); }));
    }
  }
  async execute(job) {
    const dir = fs.mkdtempSync(path.join(this.tmp, 'elpo-render-'));
    try {
      job.status = 'preparing'; job.stage = 'Lecture de la timeline'; job.started = Date.now(); this.changed();
      const plan = await this.plan(job.project);
      job.warnings = plan.warnings || [];
      for (const s of plan.sounds) if (s.fromVideo) s.hasAudio = await hasAudioStream(this.tool.ffprobe, s.path);
      const settings = { ...job.settings, subtitles: job.subtitles && job.settings.subtitles && this.tool.filters.subtitles };
      if (settings.subtitles) fs.copyFileSync(job.subtitles, path.join(dir, 'subtitles.srt'));
      const built = buildJob(plan, settings, dir, this.tool.encoders);
      const total = built.steps.reduce((n, s) => n + s.frames, 0) || 1;
      let done = 0;
      job.status = 'rendering'; job.size = `${built.width}×${built.height}`; this.changed();
      for (const [i, step] of built.steps.entries()) {
        if (job.cancelled) throw Object.assign(new Error('Export annulé.'), { code: 'CANCELLED' });
        job.stage = step.label === 'Encodage final' ? 'Encodage final' : step.label === 'Assemblage' ? 'Assemblage des transitions' : `Plan ${i + 1} / ${built.steps.length}`;
        await this.spawn(job, step, frames => { job.progress = Math.min(0.995, (done + Math.min(frames, step.frames)) / total); this.changed(); });
        done += step.frames; job.progress = done / total; this.changed();
      }
      const target = uniquePath(job.settings.outputDir, outputName(job.settings.pattern, { name: job.name, index: job.index }));
      fs.copyFileSync(built.output, target + '.partial');
      fs.renameSync(target + '.partial', target);
      Object.assign(job, { status: 'done', progress: 1, stage: 'Terminé', output: target, finished: Date.now() });
    } catch (e) {
      Object.assign(job, job.cancelled ? { status: 'cancelled', stage: 'Annulé' } : { status: 'failed', stage: 'Échec', error: e.message }, { finished: Date.now() });
    } finally {
      job.child = null; fs.rmSync(dir, { recursive: true, force: true }); this.changed();
    }
  }
  spawn(job, step, onFrames) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.tool.ffmpeg, ['-progress', 'pipe:1', '-nostats', '-loglevel', 'error', ...step.args], { cwd: path.dirname(step.output), stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      let errors = '';
      child.stdout.on('data', chunk => { const m = String(chunk).match(/frame=(\d+)/g); if (m) onFrames(Number(m.at(-1).slice(6))); });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(job.cancelled ? 'Export annulé.' : `FFmpeg a échoué (${step.label}) : ${errors.trim().split('\n').slice(-2).join(' ') || 'code ' + code}`), { code: 'FFMPEG' })));
    });
  }
}
