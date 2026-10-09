import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check } from './errors.js';
import { readJson, safeExisting } from './storage.js';

export const defaultRoot = () => path.join(os.homedir(), 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
const names = ['draft_content.json', 'draft_info.json'];
export function canonicalRoot(root) {
  check(typeof root === 'string' && fs.existsSync(root), 'ROOT_MISSING', 'Choisis le dossier qui contient tes projets CapCut.');
  const r = fs.realpathSync(root); check(fs.statSync(r).isDirectory(), 'ROOT_INVALID', 'Le dossier de projets est invalide.'); return r;
}
export function listProjects(root) {
  root = canonicalRoot(root);
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && names.some(n => fs.existsSync(path.join(root, e.name, n)))).map(e => {
    const dir = path.join(root, e.name);
    let name = e.name;
    try { name = readJson(path.join(dir, 'draft_meta_info.json')).value.draft_name || name; } catch { /* inaccessible name is not used for matching */ }
    const mtime = Math.max(...names.filter(n => fs.existsSync(path.join(dir, n))).map(n => fs.statSync(path.join(dir, n)).mtimeMs));
    return { path: dir, name: String(name), mtime };
  }).sort((a, b) => b.mtime - a.mtime);
}
export function loadProject(root, project) {
  root = canonicalRoot(root);
  check(typeof project === 'string' && path.dirname(project) === root && !fs.lstatSync(project).isSymbolicLink(), 'PROJECT_PATH', 'Sélectionne un projet situé directement dans le dossier choisi.');
  const files = names.filter(n => fs.existsSync(path.join(project, n))).map(n => path.join(project, n));
  check(files.length > 0, 'PROJECT_MISSING', 'Aucun fichier de projet reconnu.');
  let nestedFiles = [];
  const tp = path.join(project, 'Timelines', 'project.json');
  if (fs.existsSync(path.join(project, 'Timelines'))) {
    check(fs.existsSync(tp), 'TIMELINES_UNKNOWN', 'Structure Timelines inconnue : aucune écriture autorisée.');
    safeExisting(root, tp);
    const info = readJson(tp);
    const id = info.value.main_timeline_id;
    check(typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id), 'TIMELINE_ID', 'La timeline principale n’est pas identifiable.');
    const dir = path.join(project, 'Timelines', id);
    nestedFiles = names.filter(n => fs.existsSync(path.join(dir, n))).map(n => path.join(dir, n));
    check(nestedFiles.length > 0, 'MIRROR_MISSING', 'La copie principale de la timeline est absente.');
  }
  const entries = [...files, ...nestedFiles].map(file => { safeExisting(root, file); return { path: file, ...readJson(file) }; });
  const raw = entries.at(-1).value;
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.tracks) && raw.materials && typeof raw.materials === 'object' && !Array.isArray(raw.materials),
    'PROJECT_SCHEMA', 'Format de projet non reconnu. Les projets chiffrés ou opaques ne sont pas pris en charge.');
  check(entries.every(e => JSON.stringify(e.value) === JSON.stringify(raw)), 'MIRROR_DIVERGED', 'Les copies de la timeline diffèrent. Ouvre, sauvegarde puis ferme ce projet dans CapCut avant de recommencer.');
  const metadataFile = path.join(project, 'draft_meta_info.json'); safeExisting(root, metadataFile);
  const meta = { path: metadataFile, ...readJson(metadataFile) };
  check(meta.value && typeof meta.value === 'object' && !Array.isArray(meta.value), 'META_SCHEMA', 'Métadonnées du projet invalides.');
  const rootFile = path.join(root, 'root_meta_info.json');
  let index = null;
  if (fs.existsSync(rootFile)) { safeExisting(root, rootFile); index = { path: rootFile, ...readJson(rootFile) }; }
  const tpEntry = nestedFiles.length ? { path: tp, ...readJson(tp) } : null;
  return { root, project, raw, entries, meta, index, tpEntry };
}

export function mediaPool(meta) {
  check(Array.isArray(meta.draft_materials), 'POOL_FORMAT', 'Le chutier du projet n’est pas reconnu. Importe les médias dans CapCut puis ferme-le.');
  const result = [];
  for (const group of meta.draft_materials) {
    check(group && Array.isArray(group.value), 'POOL_GROUP', 'Un groupe du chutier est invalide.');
    for (const v of group.value) {
      if (!v || typeof v !== 'object') continue;
      const file = v.file_Path || v.path;
      const type = ['photo', 'video'].includes(v.metetype) ? v.metetype : ['music', 'audio'].includes(v.metetype) ? 'audio' : null;
      if (!type) continue;
      check(typeof file === 'string' && path.isAbsolute(file), 'MEDIA_PATH', 'Le chutier contient un média sans chemin local absolu.');
      const name = path.basename(file);
      result.push({ path: file, name, type, width: v.width, height: v.height, durationUs: v.duration });
    }
  }
  check(result.length <= 15000, 'POOL_SIZE', 'Le chutier contient trop de médias.');
  const dedup = new Map();
  for (const m of result) {
    const key = m.path;
    if (dedup.has(key)) {
      const prior = dedup.get(key);
      check(prior.type === m.type && prior.durationUs === m.durationUs && prior.width === m.width && prior.height === m.height, 'POOL_CONFLICT', `Métadonnées contradictoires : ${m.name}.`);
    } else dedup.set(key, m);
  }
  return [...dedup.values()];
}
