// ELPO render: turns a CapCut draft into an MP4 with FFmpeg, without opening CapCut.
// The plan is read from the project files (whatever built them); the commands are pure
// functions so they can be checked without running FFmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { check } from './errors.js';
import { loadProject } from './projects.js';

const PLACEHOLDER = /^##_draftpath_placeholder_[^#]*_##[\\/]?/;
export function resolveMediaPath(file, projectDir) {
  if (typeof file !== 'string' || !file) return null;
  if (PLACEHOLDER.test(file)) return path.join(projectDir, file.replace(PLACEHOLDER, ''));
  return path.isAbsolute(file) ? file : path.join(projectDir, file);
}

// Piecewise-linear keyframes [[offsetUs, value]…] for one property, or null.
function curve(segment, property) {
  const kf = (segment.common_keyframes || []).find(k => k?.property_type === property);
  const list = (kf?.keyframe_list || []).map(k => [Number(k.time_offset), Number(k.values?.[0])]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  return list.length ? list.sort((a, b) => a[0] - b[0]) : null;
}

export function renderPlan(root, project) {
  const p = loadProject(root, project), raw = p.raw;
  const fps = raw.fps, width = raw.canvas_config?.width, height = raw.canvas_config?.height;
  check(Number.isFinite(fps) && fps > 0 && width > 0 && height > 0, 'CANVAS', 'Format du projet non reconnu.');
  const byId = key => new Map((raw.materials[key] || []).filter(m => m?.id).map(m => [m.id, m]));
  const videos = byId('videos'), audios = byId('audios'), transitions = byId('transitions'), effects = byId('video_effects'), looks = byId('effects');
  const warnings = [];
  const videoTracks = raw.tracks.filter(t => t?.type === 'video' && t.segments?.length);
  check(videoTracks.length, 'EMPTY_TIMELINE', 'La timeline ne contient aucun visuel : construis le montage avant l’export.');
  if (videoTracks.length > 1) warnings.push(`${videoTracks.length - 1} piste(s) vidéo superposée(s) non rendue(s).`);
  const ignored = raw.tracks.filter(t => t?.segments?.length && !['video', 'audio'].includes(t.type)).map(t => t.type);
  if (ignored.length) warnings.push(`Pistes non rendues par ELPO : ${[...new Set(ignored)].join(', ')}.`);
  const missing = [];
  const visuals = [];
  let cursor = 0, clipEffects = 0;
  for (const s of [...videoTracks[0].segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start)) {
    const start = s.target_timerange.start, duration = s.target_timerange.duration;
    if (start > cursor) visuals.push({ type: 'black', startUs: cursor, durationUs: start - cursor });
    const m = videos.get(s.material_id);
    if (!m || !['photo', 'video'].includes(m.type)) { warnings.push('Un élément non visuel de la piste principale est remplacé par du noir.'); visuals.push({ type: 'black', startUs: start, durationUs: duration }); cursor = start + duration; continue; }
    const file = resolveMediaPath(m.path, project);
    if (!file || !fs.existsSync(file)) missing.push(m.material_name || path.basename(String(m.path)));
    const refs = s.extra_material_refs || [];
    const tr = refs.map(id => transitions.get(id)).find(Boolean);
    clipEffects += refs.filter(id => effects.has(id) || looks.has(id)).length;
    if (s.reverse) warnings.push(`${path.basename(file || '')} : lecture inversée non rendue.`);
    const scale = Number(s.clip?.scale?.x) || 1, tx = Number(s.clip?.transform?.x) || 0, ty = Number(s.clip?.transform?.y) || 0;
    visuals.push({ type: m.type, path: file, name: m.material_name || path.basename(file || ''), startUs: start, durationUs: duration,
      sourceStartUs: s.source_timerange?.start || 0, speed: Number(s.speed) > 0 ? Number(s.speed) : 1, volume: Number.isFinite(s.volume) ? s.volume : 1,
      scale: curve(s, 'KFTypeScaleX') || [[0, scale]], x: curve(s, 'KFTypePositionX') || [[0, tx]], y: curve(s, 'KFTypePositionY') || [[0, ty]],
      transition: tr ? { name: String(tr.name || ''), durationUs: Number(tr.duration) || 500000 } : null });
    cursor = start + duration;
  }
  check(!missing.length, 'MEDIA_MISSING', `Média introuvable pour l’export : ${missing.slice(0, 5).join(', ')}.`);
  if (clipEffects) warnings.push(`${clipEffects} effet(s) ou filtre(s) CapCut non reproduit(s) : l’export ELPO rend les images, mouvements, transitions et sons.`);
  const sounds = [];
  for (const t of raw.tracks.filter(t => t?.type === 'audio')) for (const s of t.segments || []) {
    const m = audios.get(s.material_id);
    if (!m) continue;
    const file = resolveMediaPath(m.path, project);
    check(file && fs.existsSync(file), 'MEDIA_MISSING', `Audio introuvable pour l’export : ${m.name || path.basename(String(m.path))}.`);
    sounds.push({ path: file, startUs: s.target_timerange.start, durationUs: s.target_timerange.duration, sourceStartUs: s.source_timerange?.start || 0,
      speed: Number(s.speed) > 0 ? Number(s.speed) : 1, volume: Number.isFinite(s.volume) ? s.volume : 1 });
  }
  // Clip sound from videos is mixed only when its segment volume is above zero.
  for (const v of visuals) if (v.type === 'video' && v.volume > 0) sounds.push({ path: v.path, startUs: v.startUs, durationUs: v.durationUs, sourceStartUs: v.sourceStartUs, speed: v.speed, volume: v.volume, fromVideo: true });
  const end = Math.max(cursor, ...sounds.map(s => s.startUs + s.durationUs));
  const durationUs = Math.max(cursor, Math.min(end, Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : end));
  if (durationUs > cursor) visuals.push({ type: 'black', startUs: cursor, durationUs: durationUs - cursor });
  return { project, name: p.meta.value.draft_name || path.basename(project), fps, width, height, durationUs, visuals, sounds, warnings };
}

// CapCut transition names (FR/EN) mapped to the nearest FFmpeg xfade.
const XFADE = [[/fondu.*noir|black|dip/i, 'fadeblack'], [/blanc|white|flash/i, 'fadewhite'], [/flou|blur/i, 'hblur'], [/zoom/i, 'zoomin'],
  [/cercle|circle|rond/i, 'circleopen'], [/gauche|left/i, 'slideleft'], [/droite|right/i, 'slideright'], [/haut|up/i, 'slideup'], [/bas|down/i, 'slidedown'],
  [/gliss|slide|push|pouss/i, 'slideleft'], [/balay|wipe|volet/i, 'wipeleft'], [/pixel/i, 'pixelize'], [/rideau|curtain|split/i, 'horzopen'],
  [/rotat|tourn|spin/i, 'radial'], [/dissol|fondu|fade|mix|cross/i, 'fade']];
export const xfadeName = name => (XFADE.find(([re]) => re.test(name || '')) || [null, 'fade'])[1];

export function outputSize(plan, resolution = 'project') {
  if (resolution === 'project') return { width: plan.width - plan.width % 2, height: plan.height - plan.height % 2 };
  const short = Number(resolution);
  check([720, 1080, 1440, 2160].includes(short), 'RESOLUTION', 'Résolution inconnue.');
  const ratio = plan.width / plan.height, even = n => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1 ? { width: even(short * ratio), height: short } : { width: short, height: even(short / ratio) };
}

const num = n => Number(n.toFixed(6)).toString();
// Piecewise-linear FFmpeg expression of time T (µs), holding the ends.
export function curveExpr(points, T) {
  if (points.length === 1) return num(points[0][1]);
  let expr = num(points.at(-1)[1]);
  for (let i = points.length - 2; i >= 0; i--) {
    const [t0, v0] = points[i], [t1, v1] = points[i + 1];
    const span = t1 - t0 > 0 ? `${num(v0)}+(${num(v1 - v0)})*((${T})-${t0})/${t1 - t0}` : num(v1);
    expr = `if(lt(${T},${t1}),${span},${expr})`;
  }
  return `if(lt(${T},${points[0][0]}),${num(points[0][1])},${expr})`;
}
const moving = v => v.scale.some(([, s]) => Math.abs(s - 1) > 1e-6) || v.x.some(([, x]) => x) || v.y.some(([, y]) => y);

// Frame bookkeeping: boundaries are snapped once so the sum is exactly the duration.
export function frameLayout(plan, fps) {
  const f = us => Math.round(us * fps / 1e6);
  // Clips shorter than a frame after snapping are dropped with their transition.
  const clips = plan.visuals.map(v => ({ ...v, frames: f(v.startUs + v.durationUs) - f(v.startUs), head: 0, tail: 0 })).filter(c => c.frames > 0);
  const joins = [];
  for (let i = 0; i < clips.length - 1; i++) {
    const t = clips[i].transition;
    let frames = t ? Math.max(2, f(t.durationUs)) : 0;
    frames = Math.min(frames, clips[i].frames, clips[i + 1].frames);
    if (frames < 2) frames = 0;
    joins.push({ frames, name: frames ? xfadeName(t.name) : null });
    clips[i].tail = frames - Math.floor(frames / 2); clips[i + 1].head = Math.floor(frames / 2);
  }
  return { clips, joins, totalFrames: f(plan.durationUs) };
}

// Pass 1: one normalized intermediate per clip, extended for the transitions around it.
export function clipStep(clip, { width: W, height: H, fps }, output, encoder) {
  const frames = clip.frames + clip.head + clip.tail;
  // Keyframe time in µs from the clip's nominal start (photo frames include the head extension).
  const T = `(on/${fps}*1000000-${clip.type === 'photo' ? Math.round(clip.head * 1e6 / fps) : 0})`;
  const zoom = `max(1,${curveExpr(clip.scale || [[0, 1]], T)})`;
  const pan = (axis, sign) => `${axis === 'x' ? 'iw' : 'ih'}/2*(1-(1${sign}(${curveExpr(clip[axis] || [[0, 0]], T)}))/zoom)`;
  const zp = d => `zoompan=z='${zoom}':x='${pan('x', '+')}':y='${pan('y', '-')}':d=${d}:s=${W}x${H}:fps=${fps}`;
  const fit = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  let input, filter;
  if (clip.type === 'black') {
    input = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}`];
    filter = `[0:v]trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v]`;
  } else if (clip.type === 'photo') {
    input = ['-i', clip.path];
    filter = `[0:v]${fit(W * 2, H * 2)},${zp(frames)},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v]`;
  } else {
    const speed = clip.speed || 1, sourceSeconds = clip.frames / fps * speed;
    input = ['-ss', num(clip.sourceStartUs / 1e6), '-t', num(sourceSeconds + 1 / fps), '-i', clip.path];
    const motion = moving(clip) ? `${fit(W * 2, H * 2)},${zp(1)}` : fit(W, H);
    filter = `[0:v]setpts=(PTS-STARTPTS)/${num(speed)},fps=${fps},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${clip.frames},setpts=PTS-STARTPTS,${motion}` +
      `,tpad=start_mode=clone:start=${clip.head}:stop_mode=clone:stop=${clip.tail},setpts=PTS-STARTPTS,format=yuv420p[v]`;
  }
  return { label: clip.name || 'Plan noir', frames, output,
    args: ['-y', '-hide_banner', '-nostdin', ...input, '-filter_complex', filter, '-map', '[v]', '-frames:v', String(frames), '-r', String(fps), ...encoder, '-an', output] };
}

// Pass 2: chain clips with xfade (transition) or concat (cut), by chunks of 16 inputs.
export function chainStep(parts, joins, fps, output, encoder) {
  const inputs = parts.flatMap(p => ['-i', p.path]);
  // xfade needs a declared constant frame rate. Normalize its pixel format first,
  // then restore FPS after setpts (FFmpeg 7 clears frame-rate metadata there).
  const lines = parts.map((_, i) => `[${i}:v]format=yuv444p,setpts=PTS-STARTPTS,fps=${fps}[s${i}]`);
  let last = 's0', length = parts[0].frames;
  joins.forEach((j, i) => {
    const out = `c${i}`;
    if (j.frames) { lines.push(`[${last}][s${i + 1}]xfade=transition=${j.name}:duration=${num(j.frames / fps)}:offset=${num((length - j.frames) / fps)}[${out}]`); length += parts[i + 1].frames - j.frames; }
    else { lines.push(`[${last}][s${i + 1}]concat=n=2:v=1:a=0[${out}]`); length += parts[i + 1].frames; }
    last = out;
  });
  return { label: 'Assemblage', frames: length, output, length,
    args: ['-y', '-hide_banner', '-nostdin', ...inputs, '-filter_complex', lines.join(';'), '-map', `[${last}]`, '-frames:v', String(length), '-r', String(fps), ...encoder, '-an', output] };
}
export function assemble(parts, joins, fps, dir, encoder, level = 0, steps = []) {
  if (parts.length === 1) return { steps, result: parts[0] };
  const size = 16, chunks = [], chunkJoins = [];
  for (let i = 0; i < parts.length; i += size) {
    const group = parts.slice(i, i + size), groupJoins = joins.slice(i, i + group.length - 1);
    if (group.length === 1) chunks.push(group[0]);
    else {
      const step = chainStep(group, groupJoins, fps, path.join(dir, `chain-${level}-${String(chunks.length).padStart(4, '0')}.mp4`), encoder);
      steps.push(step); chunks.push({ path: step.output, frames: step.length });
    }
    if (i + size < parts.length) chunkJoins.push(joins[i + size - 1]);
  }
  return assemble(chunks, chunkJoins, fps, dir, encoder, level + 1, steps);
}

const atempo = speed => { const out = []; let s = speed; while (s > 2) { out.push('atempo=2'); s /= 2; } while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; } out.push(`atempo=${num(s)}`); return out.join(','); };
export function videoEncoder({ codec = 'h264', hardware = false, quality = 'high' }, { width, height, fps }, available = {}) {
  const hevc = codec === 'hevc';
  const bpp = { standard: 0.07, high: 0.1, max: 0.15 }[quality] ?? 0.1;
  const kbps = Math.round(width * height * fps * bpp * (hevc ? 0.65 : 1) / 1000);
  if (hardware && available[hevc ? 'hevc_videotoolbox' : 'h264_videotoolbox'])
    return [...(hevc ? ['-c:v', 'hevc_videotoolbox', '-tag:v', 'hvc1'] : ['-c:v', 'h264_videotoolbox', '-profile:v', 'high']), '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-pix_fmt', 'yuv420p'];
  const crf = { standard: 23, high: 19, max: 16 }[quality] ?? 19;
  if (hevc && available.libx265 !== false) return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf + 3), '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'];
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
}
export const intermediateEncoder = available => available.libx264 === false && available.h264_videotoolbox
  ? ['-c:v', 'h264_videotoolbox', '-q:v', '85', '-pix_fmt', 'yuv420p']
  : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p'];

// Final pass: video + every sound placed at its timeline position, optional burned subtitles.
export function finalStep(video, sounds, { durationUs, fps }, settings, encoder, output, subtitles = null) {
  const seconds = num(durationUs / 1e6);
  const inputs = ['-i', video.path], lines = [];
  let v = '0:v';
  if (subtitles) {
    lines.push(`[0:v]subtitles=${subtitles}:force_style='FontName=Helvetica Neue,Bold=1,FontSize=17,PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=1.6,Shadow=0,MarginV=28'[vs]`);
    v = 'vs';
  }
  const labels = [];
  sounds.forEach((s, i) => {
    const k = i + 1, speed = s.speed || 1;
    inputs.push('-ss', num(s.sourceStartUs / 1e6), '-t', num(s.durationUs * speed / 1e6), '-i', s.path);
    const delay = Math.round(s.startUs / 1000);
    lines.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo${speed !== 1 ? ',' + atempo(speed) : ''},volume=${num(s.volume)},adelay=${delay}|${delay}[a${k}]`);
    labels.push(`[a${k}]`);
  });
  if (labels.length) lines.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad,atrim=0:${seconds}[aout]`);
  else { inputs.push('-f', 'lavfi', '-t', seconds, '-i', 'anullsrc=r=48000:cl=stereo'); lines.push(`[1:a]anull[aout]`); }
  return { label: 'Encodage final', frames: Math.round(durationUs * fps / 1e6), output,
    args: ['-y', '-hide_banner', '-nostdin', ...inputs, '-filter_complex', lines.join(';'), '-map', v.includes(':') ? v : `[${v}]`, '-map', '[aout]',
      ...encoder, '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-t', seconds, '-movflags', '+faststart', output] };
}

// Every command of one export, in order. `available` lists the encoders FFmpeg offers.
export function buildJob(plan, settings, dir, available = {}) {
  const size = outputSize(plan, settings.resolution || 'project');
  const fps = settings.fps === 'project' || !settings.fps ? plan.fps : Number(settings.fps);
  check(Number.isFinite(fps) && fps >= 1 && fps <= 120, 'FPS', 'Fréquence d’export invalide.');
  const layout = frameLayout(plan, fps), mid = intermediateEncoder(available);
  const geometry = { ...size, fps };
  const clipSteps = layout.clips.map((c, i) => clipStep(c, geometry, path.join(dir, `clip-${String(i).padStart(5, '0')}.mp4`), mid));
  const parts = clipSteps.map((s, i) => ({ path: s.output, frames: layout.clips[i].frames + layout.clips[i].head + layout.clips[i].tail }));
  const joined = assemble(parts, layout.joins.slice(0, parts.length - 1), fps, dir, mid);
  const output = path.join(dir, 'final.mp4');
  const final = finalStep(joined.result, plan.sounds.filter(s => s.hasAudio !== false), { durationUs: plan.durationUs, fps }, settings,
    videoEncoder(settings, geometry, available), output, settings.subtitles ? 'subtitles.srt' : null);
  return { steps: [...clipSteps, ...joined.steps, final], output, width: size.width, height: size.height, fps };
}
