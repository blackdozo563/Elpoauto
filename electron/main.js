import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultRoot } from '../lib/projects.js';
import { atomicWrite, readJson } from '../lib/storage.js';

import { MediaServer } from '../lib/media-server.js';
const media = new MediaServer();
protocol.registerSchemesAsPrivileged([{ scheme: 'elpo-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

app.setName('ElpoAiAutoCapcut');
const page = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
let window, worker, root, busy = false, sequence = 0, initialized = false, workerFailed = false;
const calls = new Map();
let settingsPath, preferences = {}, visualFolders = {};

function startWorker() {
  worker = new Worker(new URL('../lib/worker.js', import.meta.url));
  worker.on('message', ({ id, ...reply }) => { const p = calls.get(id); if (p) { calls.delete(id); p.resolve(reply); } });
  const failed = () => { initialized = false; workerFailed = true; for (const c of calls.values()) c.resolve({ ok: false, error: { code: 'WORKER_STOPPED', message: 'Le moteur s’est arrêté. Redémarre l’application et utilise la récupération si une écriture était en cours.' } }); calls.clear(); };
  worker.on('error', failed); worker.on('exit', failed);
}
function invoke(action, args = {}) {
  if (workerFailed) return Promise.resolve({ ok: false, error: { code: 'WORKER_STOPPED', message: 'Redémarre l’application : le moteur a été interrompu.' } });
  return new Promise(resolve => { const id = ++sequence; calls.set(id, { resolve }); worker.postMessage({ id, action, args }); });
}
function trusted(event) { return event.sender === window?.webContents && event.senderFrame?.url === pathToFileURL(page).href; }
function register(name, handler) {
  ipcMain.handle(name, async (event, value) => {
    if (!trusted(event)) return { ok: false, error: { message: 'Origine non autorisée.' } };
    try { return await handler(value); }
    catch (e) { return { ok: false, error: { code: e.code || 'ERROR', message: e.message } }; }
  });
}
const saveSettings = () => atomicWrite(settingsPath, Buffer.from(JSON.stringify({ root, preferences, visualFolders })));
async function selectRoot(dir) {
  const reply = await invoke('init', { root: dir, backupDir: path.join(app.getPath('userData'), 'backups'), visualFolders });
  if (reply.ok) { media.clear(); root = fs.realpathSync(dir); initialized = true; saveSettings(); }
  return reply;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    protocol.handle('elpo-media', request => media.handle(request));
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    try { const saved = readJson(settingsPath, 100000).value; root = saved.root; preferences = saved.preferences || {}; visualFolders = saved.visualFolders || {}; } catch { /* first launch */ }
    root ||= defaultRoot(); startWorker();
    if (fs.existsSync(root)) await selectRoot(root);
    register('elpo:status', async () => { const r = await invoke('running'); return { ok: true, result: { root, initialized, preferences, version: app.getVersion(), running: r.ok ? r.result : 'unknown' } }; });
    register('elpo:chooseRoot', async () => {
      if (busy) throw new Error('Une opération est en cours.');
      const picked = await dialog.showOpenDialog(window, { title: 'Dossier contenant les projets CapCut', properties: ['openDirectory'], defaultPath: fs.existsSync(root) ? root : app.getPath('movies') });
      if (picked.canceled) return { ok: true, result: null };
      const reply = await selectRoot(picked.filePaths[0]); return reply.ok ? { ok: true, result: root } : reply;
    });
    register('elpo:engine', async ({ action, args = {} } = {}) => {
      if (!['list', 'inspect', 'catalog', 'preview', 'commit', 'backups', 'restore', 'recover', 'thumbnail', 'running'].includes(action)) throw new Error('Action non autorisée.');
      if (JSON.stringify(args).length > 8e6) throw new Error('Données trop volumineuses.');
      if (busy && action !== 'running') throw new Error('Attends la fin de l’opération en cours.');
      if (action !== 'running' && !initialized) throw new Error('Choisis le dossier de projets CapCut.');
      const mutating = ['commit', 'restore', 'recover', 'preview'].includes(action);
      if (mutating) busy = true;
      try { return await invoke(action, args); } finally { if (mutating) busy = false; }
    });
    async function setFlowFolder(project, folder) {
      if (busy || !initialized || typeof project !== 'string') throw new Error('Sélectionnez un projet disponible.');
      busy = true;
      try {
        const reply = await invoke('setVisualFolder', { project, folder });
        if (reply.ok) {
          if (reply.result.visualFolder) visualFolders[project] = reply.result.visualFolder;
          else delete visualFolders[project];
          media.clear(); saveSettings();
        }
        return reply;
      } finally { busy = false; }
    }
    register('elpo:chooseFlowFolder', async project => {
      if (busy || !initialized || typeof project !== 'string') throw new Error('Sélectionnez un projet disponible.');
      const valid = await invoke('inspect', { project });
      // A missing saved folder must not prevent choosing a replacement.
      if (!valid.ok && !['FLOW_FOLDER', 'ENOENT', 'FLOW_COUNT', 'FLOW_FILE', 'IMAGE_FORMAT'].includes(valid.error?.code)) return valid;
      const picked = await dialog.showOpenDialog(window, { title: 'Dossier des images générées dans Flow', properties: ['openDirectory'] });
      if (picked.canceled) return { ok: true, result: null };
      return setFlowFolder(project, picked.filePaths[0]);
    });
    register('elpo:clearFlowFolder', project => setFlowFolder(project, null));
    register('elpo:mediaSources', async (project) => {
      if (busy || !initialized || typeof project !== 'string') throw new Error('Sélectionne un projet disponible.');
      const reply = await invoke('inspect', { project });
      if (!reply.ok) return reply;
      return { ok: true, result: media.grant([...reply.result.visuals, ...reply.result.audios]) };
    });
    register('elpo:loadFile', async (type) => {
      if (!['scenes', 'srt'].includes(type)) throw new Error('Format inconnu.');
      const r = await dialog.showOpenDialog(window, { title: type === 'srt' ? 'SRT — repères de lecture' : 'Plan de scènes JSON', properties: ['openFile'], filters: [{ name: type.toUpperCase(), extensions: [type === 'srt' ? 'srt' : 'json'] }] });
      if (r.canceled) return { ok: true, result: null };
      const file = r.filePaths[0]; if (fs.statSync(file).size > 4e6) throw new Error('Fichier limité à 4 Mo.');
      return { ok: true, result: { name: path.basename(file), text: fs.readFileSync(file, 'utf8') } };
    });
    register('elpo:export', async ({ name, text } = {}) => {
      if (typeof text !== 'string' || text.length > 8e6) throw new Error('Export invalide.');
      const r = await dialog.showSaveDialog(window, { defaultPath: path.basename(name || 'scenes.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled) return { ok: true, result: false };
      atomicWrite(r.filePath, Buffer.from(text)); return { ok: true, result: true };
    });
    register('elpo:preferences', async (value) => {
      if (!value || typeof value !== 'object' || JSON.stringify(value).length > 10000) throw new Error('Réglages invalides.');
      preferences = value; saveSettings(); return { ok: true, result: true };
    });
    // On macOS, the bundle identifier is more dependable than a URL scheme.
    register('elpo:openCapcut', async () => {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-b', 'com.lemon.lvoverseas'], e => e ? reject(new Error('Ouvre CapCut manuellement depuis Applications.')) : resolve()));
      return { ok: true, result: true };
    });
    register('elpo:openBackups', async () => { const dir = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(dir, { recursive: true }); await shell.openPath(dir); return { ok: true, result: true }; });
    function createWindow() {
      window = new BrowserWindow({ width: 1240, height: 860, minWidth: 950, minHeight: 700, title: 'ElpoAiAutoCapcut', backgroundColor: '#0b1324',
        webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', e => e.preventDefault()); window.loadFile(page);
    }
    createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', event => { if (busy) { event.preventDefault(); dialog.showMessageBoxSync(window, { message: 'Une opération est en cours. Attends sa fin avant de quitter.', type: 'info' }); } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
