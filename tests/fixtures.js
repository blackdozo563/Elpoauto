import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function fixture({ mac = false, mirror = false, visuals = ['scene-1.png', 'scene-2.png'], audioCount = 1, totalUs = 30000000 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-test-'));
  const root = path.join(temp, 'projects'), project = path.join(root, 'example'), media = path.join(temp, 'media'), backupDir = path.join(temp, 'backups');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(media);
  const id = randomUUID();
  const raw = { id, duration: 0, fps: 30, canvas_config: { width: 1920, height: 1080 }, tracks: [], materials: { videos: [], audios: [], transitions: [] } };
  const write = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));
  const filename = mac ? 'draft_info.json' : 'draft_content.json';
  const draftFile = path.join(project, filename); write(draftFile, raw);
  let mirrorFile = null;
  if (mirror) { const d = path.join(project, 'Timelines', 'MAIN'); fs.mkdirSync(d, { recursive: true }); write(path.join(project, 'Timelines', 'project.json'), { main_timeline_id: 'MAIN' }); mirrorFile = path.join(d, filename); write(mirrorFile, raw); }
  const items = visuals.map((name, i) => {
    const file = path.join(media, name); fs.writeFileSync(file, `synthetic-visual-${i}`);
    return { file_Path: file, metetype: name.endsWith('.mp4') ? 'video' : 'photo', width: 1920, height: 1080, duration: name.endsWith('.mp4') ? 8000000 : 0 };
  });
  for (let i = 0; i < audioCount; i++) { const file = path.join(media, `voice-${i}.wav`); fs.writeFileSync(file, 'synthetic-audio'); items.push({ file_Path: file, metetype: 'music', duration: totalUs }); }
  const metaFile = path.join(project, 'draft_meta_info.json');
  const meta = { draft_id: id, draft_name: 'Test ELPO', draft_fold_path: project, draft_materials: [{ type: 0, value: items }], tm_duration: 0 }; write(metaFile, meta);
  const indexFile = path.join(root, 'root_meta_info.json'); write(indexFile, { all_draft_store: [{ draft_id: id, draft_fold_path: project, draft_name: 'Test ELPO', tm_duration: 0 }, { draft_id: 'other', draft_fold_path: path.join(root, 'other'), tm_duration: 12 }] });
  return { temp, root, project, backupDir, draftFile, mirrorFile, metaFile, indexFile, raw, meta, media, items, write,
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}
