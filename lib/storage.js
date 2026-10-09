import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { check, EditError } from './errors.js';

export const digest = b => createHash('sha256').update(b).digest('hex');
export const jsonBytes = obj => Buffer.from(JSON.stringify(obj));
export function readJson(file, max = 64 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max, 'FILE_TYPE', `Fichier absent, lié ou trop volumineux : ${file}.`);
  const bytes = fs.readFileSync(file);
  let value;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new EditError('PROJECT_JSON', `Fichier JSON illisible ou format non pris en charge : ${path.basename(file)}.`); }
  return { value, bytes, hash: digest(bytes) };
}
export function contained(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export function safeExisting(root, file) {
  check(contained(root, file), 'PATH_OUTSIDE', 'Chemin extérieur au dossier de projets.');
  let cursor = file;
  while (cursor !== root) {
    check(!fs.lstatSync(cursor).isSymbolicLink(), 'SYMLINK', 'Les liens symboliques ne sont pas acceptés dans les fichiers modifiés.');
    cursor = path.dirname(cursor);
  }
  check(fs.lstatSync(file).isFile(), 'FILE_TYPE', `Ce chemin n’est pas un fichier : ${file}.`);
}
export function atomicWrite(file, bytes, mode = 0o600) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.elpo-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    // macOS / Linux directory sync where supported.
    let dirFd;
    try { dirFd = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dirFd); } catch { /* filesystem may not support directory fsync */ }
    finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
const saveManifest = (dir, data) => atomicWrite(path.join(dir, 'manifest.json'), jsonBytes(data));
const fileHash = file => digest(fs.readFileSync(file));

function withLock(root, action) {
  const lock = path.join(root, '.elpo-autocapcut.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new EditError('LOCKED', 'Une autre opération ELPO est en cours, ou une interruption a laissé un verrou. Utilise le bouton de récupération.'); }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created: Date.now() })); fs.closeSync(fd);
  try { return action(); } finally { if (fs.existsSync(lock)) fs.unlinkSync(lock); }
}

export function transact({ root, backupDir, project, projectName = null, changes, guard = () => {}, beforeReplace = null }) {
  return withLock(root, () => {
    guard();
    check(changes.length > 0 && changes.length <= 12, 'TRANSACTION_SIZE', 'Liste d’écritures invalide.');
    check(new Set(changes.map(c => c.path)).size === changes.length, 'DUPLICATE_WRITE', 'Un fichier apparaît deux fois dans l’écriture.');
    for (const c of changes) {
      safeExisting(root, c.path);
      check(fileHash(c.path) === c.expectedHash, 'PROJECT_CHANGED', 'Le projet a changé depuis l’aperçu. Relance l’analyse.');
      check(Buffer.isBuffer(c.bytes), 'WRITE_BYTES', 'Contenu à écrire invalide.');
      JSON.parse(c.bytes.toString('utf8'));
    }
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const dir = path.join(backupDir, id); fs.mkdirSync(dir, { mode: 0o700 });
    const manifest = { version: 1, id, root, project, name: projectName, created: Date.now(), status: 'preparing', entries: [] };
    for (const [i, c] of changes.entries()) {
      const old = fs.readFileSync(c.path);
      check(digest(old) === c.expectedHash, 'PROJECT_CHANGED', 'Le projet a changé pendant sa sauvegarde.');
      const backup = `${i}.original.json`;
      atomicWrite(path.join(dir, backup), old);
      manifest.entries.push({ path: c.path, backup, beforeHash: digest(old), afterHash: digest(c.bytes), mode: fs.statSync(c.path).mode & 0o777 });
    }
    manifest.status = 'pending'; saveManifest(dir, manifest);
    try {
      for (const [i, c] of changes.entries()) {
        guard();
        if (beforeReplace) beforeReplace(i);
        check(fileHash(c.path) === c.expectedHash, 'PROJECT_CHANGED', 'Le projet a été modifié pendant l’écriture.');
        atomicWrite(c.path, c.bytes, manifest.entries[i].mode);
      }
      for (const e of manifest.entries) check(fileHash(e.path) === e.afterHash, 'WRITE_VERIFY', 'Vérification après écriture échouée.');
      manifest.status = 'committed'; saveManifest(dir, manifest);
      return { backupId: id, files: manifest.entries.length };
    } catch (error) {
      try { guard(); rollback(root, dir, manifest, guard); manifest.status = 'rolled-back'; saveManifest(dir, manifest); }
      catch (rollbackError) { manifest.status = 'recovery-required'; manifest.error = error.message; manifest.recoveryError = rollbackError.message; saveManifest(dir, manifest); throw new EditError('RECOVERY_REQUIRED', 'Écriture interrompue. Sauvegarde conservée ; ferme CapCut et utilise la récupération avant de continuer.'); }
      throw error;
    }
  });
}

function validateManifest(root, dir, m) {
  check(m?.version === 1 && m.root === root && Array.isArray(m.entries) && m.entries.length > 0 && m.entries.length <= 12,
    'BACKUP_INVALID', 'Sauvegarde invalide ou liée à un autre dossier.');
  for (const e of m.entries) {
    check(typeof e.path === 'string' && /^\d+\.original\.json$/.test(e.backup) && /^[a-f0-9]{64}$/.test(e.beforeHash) && /^[a-f0-9]{64}$/.test(e.afterHash), 'BACKUP_INVALID', 'Entrée de sauvegarde invalide.');
    safeExisting(root, e.path);
    const original = readJson(path.join(dir, e.backup));
    check(original.hash === e.beforeHash, 'BACKUP_CORRUPT', 'Une sauvegarde a été altérée. Aucune restauration effectuée.');
    const current = fileHash(e.path);
    check(current === e.beforeHash || current === e.afterHash, 'RESTORE_CONFLICT', 'CapCut ou un autre programme a modifié un fichier depuis le montage. Restauration automatique refusée pour protéger ces changements.');
  }
}
function rollback(root, dir, m, guard = () => {}) {
  validateManifest(root, dir, m);
  for (const e of [...m.entries].reverse()) {
    guard();
    const current = fileHash(e.path);
    check(current === e.beforeHash || current === e.afterHash, 'RESTORE_CONFLICT', 'Le projet change pendant la restauration.');
    if (current !== e.beforeHash) atomicWrite(e.path, fs.readFileSync(path.join(dir, e.backup)), e.mode);
  }
  for (const e of m.entries) check(fileHash(e.path) === e.beforeHash, 'RESTORE_VERIFY', 'Vérification de restauration échouée.');
}
export function listBackups(backupDir, root, project = null) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).flatMap(e => {
    try { const m = readJson(path.join(backupDir, e.name, 'manifest.json'), 2e6).value;
      return m.root === root && (!project || m.project === project) && m.id === e.name ? [{ id: m.id, project: m.project, name: typeof m.name === 'string' ? m.name : null, created: m.created, status: m.status }] : [];
    } catch { return []; }
  }).sort((a, b) => b.created - a.created);
}
export function restore({ root, backupDir, backupId, guard = () => {} }) {
  check(typeof backupId === 'string' && /^[0-9TZ.:-]+-[a-f0-9-]{36}$/.test(backupId), 'BACKUP_ID', 'Identifiant de sauvegarde invalide.');
  return withLock(root, () => {
    guard();
    const dir = path.join(backupDir, backupId);
    check(!fs.lstatSync(dir).isSymbolicLink(), 'BACKUP_INVALID', 'Dossier de sauvegarde lié refusé.');
    const m = readJson(path.join(dir, 'manifest.json')).value;
    check(['committed', 'pending', 'recovery-required', 'restore-pending'].includes(m.status), 'BACKUP_STATUS', 'Cette sauvegarde a déjà été restaurée ou est incomplète.');
    validateManifest(root, dir, m);
    m.status = 'restore-pending'; saveManifest(dir, m);
    guard(); rollback(root, dir, m, guard);
    m.status = 'restored'; saveManifest(dir, m);
    return { restored: true, files: m.entries.length };
  });
}
export function recoverLock(root, guard = () => {}) {
  guard();
  const lock = path.join(root, '.elpo-autocapcut.lock');
  if (!fs.existsSync(lock)) return;
  const m = readJson(lock, 4096).value;
  check(Number.isInteger(m.pid) && m.pid > 0, 'LOCK_INVALID', 'Verrou invalide : vérification manuelle requise.');
  let alive = true;
  try { process.kill(m.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
  check(!alive, 'LOCK_ACTIVE', 'Le processus qui détient le verrou est encore actif.');
  fs.unlinkSync(lock);
}
