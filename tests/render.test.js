import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture } from './fixtures.js';
import { Engine } from '../lib/engine.js';
import { renderPlan, buildJob, frameLayout, xfadeName, curveExpr, outputSize, resolveMediaPath } from '../lib/render.js';
import { ExportQueue, findFfmpeg, outputName, uniquePath } from '../lib/export-queue.js';

test('rendu : noms de transitions CapCut vers xfade', () => {
  assert.equal(xfadeName('Fondu enchaîné'), 'fade');
  assert.equal(xfadeName('Fondu au noir'), 'fadeblack');
  assert.equal(xfadeName('Slide left'), 'slideleft');
  assert.equal(xfadeName('Inconnue'), 'fade');
});
test('rendu : courbe de keyframes maintenue aux extrémités', () => {
  assert.equal(curveExpr([[0, 1.06]], 'T'), '1.06');
  assert.equal(curveExpr([[0, 1], [100, 2]], 'T'), 'if(lt(T,0),1,if(lt(T,100),1+(1)*((T)-0)/100,2))');
});
test('rendu : formats de sortie pairs et orientation conservée', () => {
  assert.deepEqual(outputSize({ width: 1080, height: 1920 }, '720'), { width: 720, height: 1280 });
  assert.deepEqual(outputSize({ width: 1920, height: 1080 }, '2160'), { width: 3840, height: 2160 });
  assert.equal(resolveMediaPath('##_draftpath_placeholder_0E68-AB_##/materials/a.png', '/p/x'), '/p/x/materials/a.png');
});
test('rendu : transitions centrées sur les raccords, durée totale exacte', () => {
  const plan = { durationUs: 3e6, visuals: [0, 1, 2].map(i => ({ type: 'photo', startUs: i * 1e6, durationUs: 1e6, transition: i < 2 ? { name: 'Fade', durationUs: 4e5 } : null })) };
  const l = frameLayout(plan, 30);
  assert.deepEqual(l.clips.map(c => [c.frames, c.head, c.tail]), [[30, 0, 6], [30, 6, 6], [30, 6, 0]]);
  assert.deepEqual(l.joins.map(j => j.frames), [12, 12]);
  // xfade chain: (30+6) + (42-12) + (36-12) = 90 frames = 3 s.
  assert.equal(36 + 42 - 12 + 36 - 12, 90);
});
test('export : nommage et absence d’écrasement', () => {
  assert.equal(outputName('{projet} - {date}', { name: 'A/B: test', date: new Date('2026-10-09T10:00:00Z') }), 'A-B- test - 2026-10-09.mp4');
  const dir = fs.mkdtempSync('/tmp/elpo-name-'); fs.writeFileSync(path.join(dir, 'x.mp4'), '');
  assert.equal(path.basename(uniquePath(dir, 'x.mp4')), 'x (2).mp4'); fs.rmSync(dir, { recursive: true });
});

const ffmpeg = await findFfmpeg();
test('export réel : montage ELPO → MP4 lisible à la bonne durée', { skip: !ffmpeg && 'FFmpeg absent' }, async () => {
  const f = fixture({ visuals: ['001.png', '002.mp4', '003.png'], totalUs: 6000000 });
  try {
    const run = args => execFileSync(ffmpeg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    const [img1, vid, img2, voice] = f.items.map(i => i.file_Path);
    run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', img1]);
    run(['-f', 'lavfi', '-i', 'smptebars=s=480x480', '-frames:v', '1', img2]);
    run(['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', vid]);
    run(['-f', 'lavfi', '-i', 'sine=f=220:d=6', voice]);
    f.raw.canvas_config = { width: 640, height: 360 }; f.write(f.draftFile, f.raw);
    const resource = path.join(f.temp, 'transition'); fs.mkdirSync(resource);
    f.raw.materials.transitions = [{ id: 'T', effect_id: 'E', name: 'Fondu', path: resource, duration: 500000 }]; f.write(f.draftFile, f.raw);
    const e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
    const r = e.preview(f.project, { motion: 'kenburns', amount: 0.1, transitionIds: ['E'], videoVolume: 0.5 });
    e.commit(r.token);
    const plan = renderPlan(f.root, f.project);
    assert.equal(plan.visuals.length, 3); assert.equal(plan.sounds.length, 2); assert.ok(plan.visuals[0].transition);
    const outputDir = path.join(f.temp, 'out'); fs.mkdirSync(outputDir);
    const queue = new ExportQueue({ plan: async project => renderPlan(f.root, project), tool: ffmpeg, tmp: f.temp });
    const done = new Promise(resolve => queue.once('idle', resolve));
    queue.add([{ path: f.project, name: 'Test ELPO' }], { outputDir, resolution: 'project', fps: 'project', quality: 'standard', codec: 'h264', pattern: '{projet}' });
    const [job] = await done;
    assert.equal(job.status, 'done', job.error);
    const duration = Number(execFileSync(ffmpeg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', job.output]));
    assert.ok(Math.abs(duration - 6) < 0.1, `durée ${duration}`);
    const streams = String(execFileSync(ffmpeg.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', job.output]));
    assert.match(streams, /video,640,360/); assert.match(streams, /audio/);
    assert.deepEqual(fs.readdirSync(f.temp).filter(n => n.startsWith('elpo-render-')), []);
  } finally { f.cleanup(); }
});
