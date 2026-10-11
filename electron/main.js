import { app, BrowserWindow, ipcMain, dialog, shell, protocol, Menu, Notification, screen, systemPreferences, Tray, nativeImage, globalShortcut } from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultRoot } from '../lib/projects.js';
import { atomicWrite, readJson } from '../lib/storage.js';
import { MediaServer } from '../lib/media-server.js';
import { ExportQueue, findFfmpeg } from '../lib/export-queue.js';
import { CapcutPilot, DEFAULT_PILOT } from '../lib/capcut-pilot.js';
import { macActions, CAPCUT_ID } from '../lib/mac-automation.js';
import { nativeDriver } from '../lib/capcut-native.js';
import { waveform } from '../lib/waveform.js';
import { TRAY_ICON_PNG } from './tray-icon.js';

const media = new MediaServer();
protocol.registerSchemesAsPrivileged([{ scheme: 'elpo-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
app.setName('ElpoAiAutoCapcut');
const mac = process.platform === 'darwin';
const page = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const hudPage = fileURLToPath(new URL('../renderer/hud.html', import.meta.url));
const overlayPreload = fileURLToPath(new URL('./preload-overlay.cjs', import.meta.url));
let window, worker, root, busy = false, sequence = 0, initialized = false, workerFailed = false;
const calls = new Map();
let settingsPath;
// Everything the app remembers between launches.
let settings = { preferences: {}, visualFolders: {}, styles: {}, favorites: { transitions: [], effects: [], filters: [] }, exportSettings: {}, pilot: { ...DEFAULT_PILOT }, ffmpegPath: null, subtitles: {}, history: [] };
let tool = null, queue = null, pilot = null;
let hud = null, hudState = null, tray = null, trayTimer = 0, watch = null, automated = null, lastNote = null;
let showMain = () => {};

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
async function engineResult(action, args) { const r = await invoke(action, args); if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.result; }
function trusted(event) { return event.sender === window?.webContents && event.senderFrame?.url === pathToFileURL(page).href; }
function register(name, handler) {
  ipcMain.handle(name, async (event, value) => {
    if (!trusted(event)) return { ok: false, error: { message: 'Origine non autorisée.' } };
    try { return await handler(value); }
    catch (e) { return { ok: false, error: { code: e.code || 'ERROR', message: e.message } }; }
  });
}
const ok = result => ({ ok: true, result });
const send = (type, data) => { if (window && !window.isDestroyed()) window.webContents.send('elpo:event', { type, data }); };
const saveSettings = () => atomicWrite(settingsPath, Buffer.from(JSON.stringify({ root, ...settings })));
const pilotRunning = () => !!pilot?.controller;
// The native helper ships next to the app's executable (Contents/MacOS/capcut-ax); in
// development it is built by `npm run build:native`.
const helperPath = () => app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'capcut-ax') : fileURLToPath(new URL('../build/native/capcut-ax', import.meta.url));
const nativeCommands = [];
function makeDriver() {
  const base = nativeDriver({ binary: helperPath(), onCommand: evidence => {
    nativeCommands.push(evidence);
    if (nativeCommands.length > 40) nativeCommands.splice(0, nativeCommands.length - 40);
  } });
  // The helper moves the pointer for its two clicks per project (the tile, the editor's
  // « Exporter »): the pause-on-mouse watch must not take them for the user's hand.
  // The HUD is hidden during a click: the helper checks that the element under the
  // point belongs to CapCut, and the HUD floats above CapCut's title bar.
  const withoutHud = async fn => {
    const shown = !!hud && !hud.isDestroyed() && hud.isVisible();
    if (shown) hud.hide();
    try { return await fn(); }
    finally { if (shown && hudState && hud && !hud.isDestroyed()) hud.showInactive(); }
  };
  return { ...base, press: async args => {
    if (args.mouse) automated = { at: Date.now(), until: Date.now() + 20000 };
    try { return await withoutHud(() => base.press(args)); }
    finally {
      if (args.mouse) automated = { ...screen.getCursorScreenPoint(), at: Date.now(), until: Date.now() + 1500 };
    }
  }, click: async args => {
    automated = { x: Math.round(args.x), y: Math.round(args.y), at: Date.now(), until: Date.now() + 8000 };
    const hudShown = !!hud && !hud.isDestroyed() && hud.isVisible();
    if (hudShown) hud.hide();
    try { return await base.click(args); }
    finally {
      automated = { ...automated, at: Date.now(), until: Date.now() + 1500 };
      if (hudShown && hudState && hud && !hud.isDestroyed()) hud.showInactive();
    }
  } };
}
// Settings saved by 0.6.x carried calibrated points and short fixed delays: only the
// CapCut export folder is kept, the delays become the new maxima.
function pilotSettingsFrom(saved = {}) {
  if (saved?.version === DEFAULT_PILOT.version) return { ...DEFAULT_PILOT, ...saved };
  return { ...DEFAULT_PILOT, exportDir: typeof saved?.exportDir === 'string' ? saved.exportDir : null };
}
const movies = () => { try { return app.getPath('movies'); } catch { return app.getPath('home'); } };

async function selectRoot(dir) {
  const reply = await invoke('init', { root: dir, backupDir: path.join(app.getPath('userData'), 'backups'), visualFolders: settings.visualFolders });
  if (reply.ok) { media.clear(); root = fs.realpathSync(dir); initialized = true; makePilot(); saveSettings(); }
  return reply;
}
function remember(entry) { settings.history = [entry, ...settings.history].slice(0, 500); saveSettings(); }

// Dock progress, badge and a notification when a batch finishes.
function dock() {
  const jobs = [...(queue?.list() || []), ...(pilot?.list() || [])];
  const live = jobs.filter(j => ['queued', 'preparing', 'rendering', 'running'].includes(j.status));
  if (!window || window.isDestroyed()) return;
  window.setProgressBar(live.length ? jobs.filter(j => j.status !== 'cancelled').reduce((n, j) => n + (j.progress || 0), 0) / Math.max(1, jobs.filter(j => j.status !== 'cancelled').length) : -1);
  if (mac) app.dock?.setBadge(live.length ? String(live.length) : '');
  updateTray();
}
// Menu bar: progress as a title, running exports in the menu. Exports keep going when the window is closed.
function makeTray() {
  if (!mac || tray) return;
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'), { scaleFactor: 2 });
  image.setTemplateImage(true);
  tray = new Tray(image); tray.setToolTip('ElpoAiAutoCapcut'); updateTray();
}
function updateTray() {
  if (!tray) return;
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => {
    const jobs = [...(queue?.list() || []), ...(pilot?.list() || [])].filter(j => j.status !== 'cancelled');
    const live = jobs.filter(j => ['queued', 'preparing', 'rendering', 'running'].includes(j.status));
    const running = jobs.filter(j => ['preparing', 'rendering', 'running'].includes(j.status));
    const pct = jobs.length ? jobs.reduce((n, j) => n + (j.progress || 0), 0) / jobs.length : 0;
    tray.setTitle(live.length ? ` ${Math.round(pct * 100)} %` : '');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: live.length ? `${live.length} export(s) en cours ou en attente` : 'Aucun export en cours', enabled: false },
      ...running.slice(0, 6).map(j => ({ label: `${j.name} — ${Math.round((j.progress || 0) * 100)} %`, enabled: false })),
      { type: 'separator' },
      { label: 'Ouvrir la Salle de rendu', click: () => showMain('batch-room') },
      { label: 'Tout arrêter', enabled: live.length > 0, click: () => { queue?.cancel(null); pilot?.stop(); } },
      { type: 'separator' },
      { role: 'quit', label: 'Quitter ElpoAiAutoCapcut' },
    ]));
  }, 300);
}
function finished(kind, jobs) {
  const done = jobs.filter(j => j.status === 'done'), failed = jobs.filter(j => j.status === 'failed');
  for (const j of done) if (!settings.history.some(h => h.id === j.id)) remember({ id: j.id, project: j.project, name: j.name, output: j.output, engine: kind, at: Date.now() });
  if (Notification.isSupported() && jobs.length) {
    // Kept in a variable so its click and action handlers survive garbage collection.
    lastNote = new Notification({ title: kind === 'capcut' ? 'Export CapCut terminé' : 'Export ELPO terminé', body: `${done.length} vidéo(s) prête(s)${failed.length ? `, ${failed.length} à revoir` : ''}.`, silent: false,
      actions: done.length ? [{ type: 'button', text: 'Afficher' }] : [] });
    lastNote.on('click', () => showMain('batch-room'));
    lastNote.on('action', () => { const output = done.at(-1)?.output; if (output && fs.existsSync(output)) shell.showItemInFolder(output); else showMain('batch-room'); });
    lastNote.show();
  }
  dock();
}
function makePilot() {
  // Never replace (and so abort) a pilot that is exporting.
  if (pilotRunning()) throw Object.assign(new Error('Le pilotage CapCut est en cours : attends sa fin.'), { code: 'PILOT_BUSY' });
  pilot?.stop(); pilot = null;
  // No pilot until a CapCut projects folder is open (FFmpeg can be detected before that).
  if (!initialized) return;
  const actions = macActions({ ffprobe: tool?.ffprobe, trusted: () => !mac || systemPreferences.isTrustedAccessibilityClient(false) });
  pilot = new CapcutPilot({ root, backupDir: path.join(app.getPath('userData'), 'backups'), settings: settings.pilot, actions, driver: makeDriver() });
  pilot.on('update', jobs => { send('pilot', jobs); dock(); pilotHud(jobs); });
  pilot.on('log', line => send('pilotLog', line));
  pilot.on('paused', state => { send('pilotPaused', state); if (hudState) showHud({ ...hudState, paused: state.paused, reason: state.reason }); });
  pilot.on('idle', jobs => { pilotWatch(false); hideHud(); finished('capcut', jobs); send('pilot', jobs); });
}

// HUD above CapCut while the pilot runs: click-through, never takes the focus.
function hudWindow() {
  if (hud && !hud.isDestroyed()) return hud;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, width = 600, height = 196;
  hud = new BrowserWindow({ width, height, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 10, frame: false, transparent: true, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true,
    webPreferences: { preload: overlayPreload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  hud.setAlwaysOnTop(true, 'screen-saver'); hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); hud.setIgnoreMouseEvents(true);
  hud.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); hud.webContents.on('will-navigate', e => e.preventDefault());
  hud.webContents.on('did-finish-load', () => { if (hudState) hud.webContents.send('overlay:state', hudState); });
  hud.loadFile(hudPage);
  return hud;
}
function showHud(state) {
  hudState = state;
  const w = hudWindow();
  if (!w.webContents.isLoading()) w.webContents.send('overlay:state', state);
  if (!w.isVisible()) w.showInactive();
}
function hideHud() { hudState = null; if (hud && !hud.isDestroyed()) hud.hide(); }
function pilotHud(jobs) {
  const index = jobs.findIndex(j => j.status === 'running');
  if (index < 0) return;
  const job = jobs[index];
  pilotWatch(true);
  showHud({ name: job.name, index: index + 1, total: jobs.length, stage: job.stage, progress: job.progress, paused: !!pilot?.paused, reason: hudState?.reason });
}
// While the pilot runs: ⌥⌘. stops, ⌥⌘R resumes, and a mouse move by the user pauses before the next action.
function pilotWatch(on) {
  if (on && watch) return;
  clearInterval(watch); watch = null;
  if (!on) { globalShortcut.unregister('Alt+Command+.'); globalShortcut.unregister('Alt+Command+R'); return; }
  try { globalShortcut.register('Alt+Command+.', () => pilot?.stop()); globalShortcut.register('Alt+Command+R', () => pilot?.resume()); } catch { /* shortcut taken by another app */ }
  let last = screen.getCursorScreenPoint();
  watch = setInterval(() => {
    const now = screen.getCursorScreenPoint();
    const moved = Math.hypot(now.x - last.x, now.y - last.y) > 4;
    const ours = automated && (Date.now() < (automated.until || automated.at + 1500) || (Math.abs(now.x - automated.x) <= 2 && Math.abs(now.y - automated.y) <= 2));
    if (moved && !ours) pilot?.pause('La souris a bougé : ELPO attend avant sa prochaine action dans CapCut.');
    last = now;
  }, 250);
}

async function prepareTools() {
  tool = await findFfmpeg(settings.ffmpegPath);
  queue = new ExportQueue({ tool, plan: project => engineResult('renderPlan', { project }) });
  queue.on('update', jobs => { send('export', jobs); dock(); });
  queue.on('idle', jobs => finished('elpo', jobs));
}

function menu() {
  const go = command => () => send('command', command);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [{ role: 'about', label: 'À propos d’ElpoAiAutoCapcut' }, { type: 'separator' }, { label: 'Réglages…', accelerator: 'Cmd+,', click: go('settings') }, { type: 'separator' }, { role: 'hide', label: 'Masquer ElpoAiAutoCapcut' }, { role: 'hideOthers', label: 'Masquer les autres' }, { role: 'unhide', label: 'Tout afficher' }, { type: 'separator' }, { role: 'quit', label: 'Quitter ElpoAiAutoCapcut' }] }] : []),
    { label: 'Édition', submenu: [{ role: 'undo', label: 'Annuler' }, { role: 'redo', label: 'Rétablir' }, { type: 'separator' }, { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' }, { role: 'paste', label: 'Coller' }, { role: 'selectAll', label: 'Tout sélectionner' }] },
    { label: 'Studio', submenu: [{ label: 'Projets', accelerator: 'CmdOrCtrl+1', click: go('library') }, { label: 'Plateau (montage complet)', accelerator: 'CmdOrCtrl+2', click: go('build') }, { label: 'Production en lot', accelerator: 'CmdOrCtrl+3', click: go('batch') }, { label: 'Salle de rendu', click: go('batch-room') }, { label: 'Bibliothèque', accelerator: 'CmdOrCtrl+4', click: go('library-fx') }, { label: 'Coffre (sauvegardes)', accelerator: 'CmdOrCtrl+5', click: go('vault') }, { type: 'separator' }, { label: 'Palette de commandes', accelerator: 'CmdOrCtrl+K', click: go('palette') }, { label: 'Ouvrir CapCut', accelerator: 'CmdOrCtrl+Shift+O', click: go('open-capcut') }] },
    { label: 'Présentation', submenu: [{ role: 'togglefullscreen', label: 'Plein écran' }, { role: 'resetZoom', label: 'Taille réelle' }, { role: 'zoomIn', label: 'Agrandir' }, { role: 'zoomOut', label: 'Réduire' }] },
    { role: 'windowMenu', label: 'Fenêtre' },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    protocol.handle('elpo-media', request => media.handle(request));
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    try { const saved = readJson(settingsPath, 4e6).value; root = saved.root; for (const k of Object.keys(settings)) if (saved[k] !== undefined) settings[k] = saved[k]; settings.pilot = pilotSettingsFrom(settings.pilot); } catch { /* first launch */ }
    root ||= defaultRoot(); startWorker(); await prepareTools();
    if (fs.existsSync(root)) await selectRoot(root);
    menu();

    register('elpo:status', async () => { const r = await invoke('running'); return ok({ root, initialized, preferences: settings.preferences, styles: settings.styles, favorites: settings.favorites, exportSettings: settings.exportSettings, pilot: settings.pilot, subtitles: settings.subtitles, history: settings.history.slice(0, 100), version: app.getVersion(), platform: process.platform, running: r.ok ? r.result : 'unknown', ffmpeg: tool, moviesDir: movies(), access: !mac || systemPreferences.isTrustedAccessibilityClient(false), native: { available: fs.existsSync(helperPath()) } }); });
    register('elpo:chooseRoot', async () => {
      if (busy || pilotRunning()) throw new Error('Une opération est en cours.');
      const picked = await dialog.showOpenDialog(window, { title: 'Dossier contenant les projets CapCut', properties: ['openDirectory'], defaultPath: fs.existsSync(root) ? root : movies() });
      if (picked.canceled) return ok(null);
      const reply = await selectRoot(picked.filePaths[0]); return reply.ok ? ok(root) : reply;
    });
    const actions = ['list', 'inspect', 'catalog', 'library', 'preview', 'commit', 'backups', 'restore', 'recover', 'thumbnail', 'running', 'batchPreview', 'batchCommit', 'fidelity'];
    register('elpo:engine', async ({ action, args = {} } = {}) => {
      if (!actions.includes(action)) throw new Error('Action non autorisée.');
      if (JSON.stringify(args).length > 8e6) throw new Error('Données trop volumineuses.');
      if (busy && action !== 'running') throw new Error('Attends la fin de l’opération en cours.');
      if (action !== 'running' && !initialized) throw new Error('Choisis le dossier de projets CapCut.');
      const mutating = ['commit', 'restore', 'recover', 'preview', 'batchPreview', 'batchCommit'].includes(action);
      if (['commit', 'restore', 'recover', 'batchCommit'].includes(action) && pilotRunning()) throw new Error('Le pilotage CapCut est en cours : attends sa fin avant d’écrire dans un projet.');
      // ELPO stars count as favourites, alongside the CapCut "Favoris" project.
      if (['preview', 'batchPreview'].includes(action)) args = { ...args, options: { ...(args.options || {}), starred: settings.favorites } };
      if (mutating) busy = true;
      try { return await invoke(action, args); } finally { if (mutating) busy = false; }
    });
    register('elpo:overview', async () => {
      const list = await engineResult('overview');
      const urls = media.grant(list.filter(p => p.cover).map(p => ({ path: p.cover })), 'covers');
      const exported = new Map(settings.history.map(h => [h.project, h]));
      return ok(list.map(p => ({ ...p, coverUrl: urls[p.cover] || null, subtitles: settings.subtitles[p.path] || null, lastExport: exported.get(p.path) || null })));
    });
    async function setFlowFolder(project, folder) {
      if (busy || !initialized || typeof project !== 'string') throw new Error('Sélectionnez un projet disponible.');
      busy = true;
      try {
        const reply = await invoke('setVisualFolder', { project, folder });
        if (reply.ok) {
          if (reply.result.visualFolder) settings.visualFolders[project] = reply.result.visualFolder;
          else delete settings.visualFolders[project];
          media.clear('project'); saveSettings();
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
      if (picked.canceled) return ok(null);
      return setFlowFolder(project, picked.filePaths[0]);
    });
    register('elpo:clearFlowFolder', project => setFlowFolder(project, null));
    // Drag and drop: the window only sends the path of what was dropped; only folders, .srt and .json are read.
    register('elpo:dropped', async file => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Élément déposé invalide.');
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return ok({ kind: 'folder', path: file, name: path.basename(file) });
      const ext = path.extname(file).toLowerCase();
      if (!stat.isFile() || !['.srt', '.json'].includes(ext)) throw new Error('Dépose un dossier d’images, un fichier .srt ou un plan .json.');
      if (stat.size > 4e6) throw new Error('Fichier limité à 4 Mo.');
      return ok({ kind: ext === '.srt' ? 'srt' : 'scenes', name: path.basename(file), path: file, text: fs.readFileSync(file, 'utf8') });
    });
    register('elpo:useFlowFolder', async ({ project, folder } = {}) => {
      if (typeof folder !== 'string' || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Dossier invalide.');
      return setFlowFolder(project, folder);
    });
    register('elpo:mediaSources', async project => {
      if (busy || !initialized || typeof project !== 'string') throw new Error('Sélectionne un projet disponible.');
      const reply = await invoke('inspect', { project });
      if (!reply.ok) return reply;
      return ok(media.grant([...reply.result.visuals, ...reply.result.audios], 'project'));
    });
    // Voice-over peaks, computed once per file version by FFmpeg (see lib/waveform.js).
    const waves = new Map();
    register('elpo:waveform', async url => {
      const entry = typeof url === 'string' ? media.resolve(url) : null;
      if (!entry || !/^(audio|video)\//.test(entry.type)) throw new Error('Média non autorisé.');
      if (!tool?.ffmpeg) throw Object.assign(new Error('FFmpeg est nécessaire pour afficher la forme d’onde.'), { code: 'FFMPEG_MISSING' });
      const key = `${entry.real}|${entry.size}|${entry.mtimeMs}`;
      if (!waves.has(key)) {
        if (waves.size >= 24) waves.delete(waves.keys().next().value);
        waves.set(key, waveform(tool.ffmpeg, entry.real).catch(error => { waves.delete(key); throw error; }));
      }
      return ok(await waves.get(key));
    });
    register('elpo:loadFile', async type => {
      if (!['scenes', 'srt'].includes(type)) throw new Error('Format inconnu.');
      const r = await dialog.showOpenDialog(window, { title: type === 'srt' ? 'SRT — repères de lecture' : 'Plan de scènes JSON', properties: ['openFile'], filters: [{ name: type.toUpperCase(), extensions: [type === 'srt' ? 'srt' : 'json'] }] });
      if (r.canceled) return ok(null);
      const file = r.filePaths[0]; if (fs.statSync(file).size > 4e6) throw new Error('Fichier limité à 4 Mo.');
      return ok({ name: path.basename(file), path: file, text: fs.readFileSync(file, 'utf8') });
    });
    register('elpo:subtitles', async ({ project, file } = {}) => {
      if (typeof project !== 'string' || path.dirname(project) !== root) throw new Error('Projet invalide.');
      if (file === null) delete settings.subtitles[project];
      else { if (typeof file !== 'string' || !/\.srt$/i.test(file) || !fs.existsSync(file)) throw new Error('SRT introuvable.'); settings.subtitles[project] = file; }
      saveSettings(); return ok(true);
    });
    register('elpo:export', async ({ name, text } = {}) => {
      if (typeof text !== 'string' || text.length > 8e6) throw new Error('Export invalide.');
      const r = await dialog.showSaveDialog(window, { defaultPath: path.basename(name || 'scenes.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled) return ok(false);
      atomicWrite(r.filePath, Buffer.from(text)); return ok(true);
    });
    register('elpo:preferences', async value => {
      if (!value || typeof value !== 'object' || JSON.stringify(value).length > 20000) throw new Error('Réglages invalides.');
      settings.preferences = value; saveSettings(); return ok(true);
    });
    register('elpo:styles', async ({ action, name, value } = {}) => {
      if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('Nom de style invalide.');
      if (action === 'delete') delete settings.styles[name];
      else { if (!value || typeof value !== 'object' || JSON.stringify(value).length > 20000) throw new Error('Style invalide.'); if (!settings.styles[name] && Object.keys(settings.styles).length >= 40) throw new Error('40 styles maximum.'); settings.styles[name.trim()] = value; }
      saveSettings(); return ok(settings.styles);
    });
    register('elpo:favorite', async ({ kind, id, on } = {}) => {
      if (!['transitions', 'effects', 'filters'].includes(kind) || typeof id !== 'string' || id.length > 200) throw new Error('Favori invalide.');
      const set = new Set(settings.favorites[kind] || []); if (on) set.add(id); else set.delete(id);
      settings.favorites[kind] = [...set].slice(0, 500); saveSettings(); return ok(settings.favorites);
    });
    register('elpo:openCapcut', async () => {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-b', CAPCUT_ID], e => e ? reject(new Error('Ouvre CapCut manuellement depuis Applications.')) : resolve()));
      return ok(true);
    });
    register('elpo:openBackups', async () => { const dir = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(dir, { recursive: true }); await shell.openPath(dir); return ok(true); });

    // ELPO render (FFmpeg).
    const knownOutputs = () => new Set([...settings.history.map(h => h.output), ...(queue?.list() || []).map(j => j.output), ...(pilot?.list() || []).map(j => j.output)].filter(Boolean));
    register('elpo:ffmpeg', async ({ choose = false } = {}) => {
      // Checked first: nothing is saved or replaced while an export or a pilot runs.
      if (queue?.active()) throw new Error('Attends la fin des exports en cours.');
      if (pilotRunning()) throw new Error('Attends la fin du pilotage CapCut.');
      if (choose) {
        const r = await dialog.showOpenDialog(window, { title: 'Emplacement de FFmpeg', properties: ['openFile', 'showHiddenFiles'], defaultPath: fs.existsSync('/opt/homebrew/bin') ? '/opt/homebrew/bin' : '/usr/local/bin' });
        if (r.canceled) return ok(tool);
        const found = await findFfmpeg(r.filePaths[0]);
        if (!found || found.ffmpeg !== r.filePaths[0]) throw new Error('Ce fichier n’est pas un FFmpeg utilisable.');
        settings.ffmpegPath = r.filePaths[0]; saveSettings();
      }
      await prepareTools(); makePilot(); return ok(tool);
    });
    register('elpo:chooseDir', async ({ purpose } = {}) => {
      const r = await dialog.showOpenDialog(window, { title: purpose === 'capcut' ? 'Dossier d’export utilisé par CapCut' : 'Dossier de sortie des vidéos', properties: ['openDirectory', 'createDirectory'], defaultPath: movies() });
      return ok(r.canceled ? null : r.filePaths[0]);
    });
    register('elpo:exportSettings', async value => {
      if (!value || typeof value !== 'object' || JSON.stringify(value).length > 10000) throw new Error('Réglages d’export invalides.');
      settings.exportSettings = value; saveSettings(); return ok(true);
    });
    register('elpo:exportStart', async ({ projects, settings: s } = {}) => {
      if (!Array.isArray(projects) || !projects.length || projects.length > 500) throw new Error('Sélectionne entre 1 et 500 projets.');
      const list = projects.filter(p => typeof p?.path === 'string' && path.dirname(p.path) === root).map(p => ({ path: p.path, name: String(p.name || path.basename(p.path)).slice(0, 200), subtitles: settings.subtitles[p.path] || null }));
      return ok(queue.add(list, { ...s, outputDir: s?.outputDir }));
    });
    register('elpo:exportCancel', async id => { queue.cancel(typeof id === 'string' ? id : null); return ok(true); });
    register('elpo:exportClear', async () => { queue.clearFinished(); return ok(queue.list()); });
    register('elpo:jobs', async () => ok({ export: queue?.list() || [], pilot: pilot?.list() || [], log: pilot?.log.slice(-120) || [] }));
    register('elpo:reveal', async ({ file, open = false } = {}) => {
      if (!knownOutputs().has(file) || !fs.existsSync(file)) throw new Error('Fichier introuvable.');
      if (open) await shell.openPath(file); else shell.showItemInFolder(file);
      return ok(true);
    });

    // CapCut pilot.
    register('elpo:pilotSettings', async value => {
      if (pilotRunning()) throw new Error('Pilotage en cours.');
      if (value) {
        const n = (v, min, max, d) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d;
        const d = DEFAULT_PILOT, p = settings.pilot;
        settings.pilot = { ...p, version: d.version, exportDir: typeof value.exportDir === 'string' ? value.exportDir : p.exportDir,
          launchSeconds: n(value.launchSeconds, 10, 180, d.launchSeconds), openSeconds: n(value.openSeconds, 5, 120, d.openSeconds),
          dialogSeconds: n(value.dialogSeconds, 5, 60, d.dialogSeconds), startSeconds: n(value.startSeconds, 5, 120, d.startSeconds),
          stableSeconds: n(value.stableSeconds, 1, 30, d.stableSeconds), stallMinutes: n(value.stallMinutes, 1, 60, d.stallMinutes),
          timeoutMinutes: n(value.timeoutMinutes, 5, 600, d.timeoutMinutes), quitSeconds: n(value.quitSeconds, 5, 120, d.quitSeconds) };
        saveSettings(); makePilot();
      }
      return ok(settings.pilot);
    });
    register('elpo:pilotAccess', async () => ok(!mac || systemPreferences.isTrustedAccessibilityClient(true)));
    let diagnosing = false;
    // Native reading of what CapCut shows right now (every node, every AX read), saved
    // as JSON to attach to a report. Read only: nothing is pressed or clicked.
    register('elpo:pilotDiagnostic', async () => {
      if (!mac) throw new Error('Ce diagnostic nécessite macOS et CapCut ouvert.');
      if (pilotRunning() || diagnosing || busy) throw new Error('Arrête le pilotage et attends la fin de l’opération avant le diagnostic.');
      diagnosing = true;
      try {
        const driver = makeDriver();
        if (!driver.available()) throw Object.assign(new Error('L’outil natif capcut-ax est absent de l’application : réinstalle ElpoAiAutoCapcut.'), { code: 'NATIVE_MISSING' });
        const at = new Date().toISOString();
        const report = { schema: 2, at, app: { version: app.getVersion(), platform: process.platform, arch: process.arch, accessibility: systemPreferences.isTrustedAccessibilityClient(false) },
          displays: screen.getAllDisplays().map(({ bounds, scaleFactor }) => ({ bounds, scaleFactor })), pilot: settings.pilot, log: pilot?.log.slice(-120) || [], nativeCommands: [...nativeCommands] };
        for (const [key, read] of [['helper', () => driver.version()], ['snapshot', () => driver.snapshot()], ['state', () => driver.state()]]) {
          try { report[key] = await read(); } catch (error) { report[key] = { error: { code: error.code ?? null, message: error.message } }; }
        }
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: 'Enregistrer le diagnostic CapCut',
          defaultPath: path.join(app.getPath('desktop'), `diagnostic-capcut-${at.replace(/[:.]/g, '-')}.json`),
          filters: [{ name: 'Diagnostic JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return ok(null);
        atomicWrite(filePath, Buffer.from(JSON.stringify(report, null, 2)));
        return ok({ file: filePath });
      } finally { diagnosing = false; }
    });
    register('elpo:pilotStart', async ({ projects, test = false } = {}) => {
      if (diagnosing) throw new Error('Attends la fin du diagnostic avant de lancer le pilotage.');
      if (busy) throw new Error('Une écriture ELPO est en cours.');
      if (pilotRunning()) throw new Error('Un pilotage CapCut est déjà en cours.');
      if (!pilot) throw new Error('Choisis le dossier de projets CapCut.');
      if (!Array.isArray(projects) || !projects.length) throw new Error('Coche au moins un projet.');
      const list = projects.filter(p => typeof p?.path === 'string' && path.dirname(p.path) === root).map(p => ({ path: p.path, name: String(p.name || '') }));
      pilot.run(list, { exportDir: settings.pilot.exportDir, test }).catch(e => send('pilotError', { message: e.message, code: e.code }));
      return ok(true);
    });
    register('elpo:pilotStop', async () => { pilot?.stop(); return ok(true); });
    register('elpo:pilotResume', async () => ok(!!pilot?.resume()));

    function createWindow() {
      window = new BrowserWindow({ width: 1360, height: 880, minWidth: 1080, minHeight: 720, title: 'ElpoAiAutoCapcut', show: false,
        ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' } : { backgroundColor: '#0f1726' }),
        webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
      window.once('ready-to-show', () => window.show());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', e => e.preventDefault()); window.loadFile(page);
    }
    createWindow(); app.on('activate', () => { if (!window || window.isDestroyed()) createWindow(); });
    showMain = command => {
      const fresh = !window || window.isDestroyed();
      if (fresh) createWindow();
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      if (command) { if (fresh) window.webContents.once('did-finish-load', () => send('command', command)); else send('command', command); }
    };
    makeTray();
  });
  app.on('before-quit', event => {
    if (busy || queue?.active() || pilotRunning()) {
      event.preventDefault();
      // The window may be closed (exports keep running from the menu bar).
      const options = { message: 'Une génération ou un export est en cours. Attends sa fin ou annule-le avant de quitter.', type: 'info' };
      if (window && !window.isDestroyed()) dialog.showMessageBoxSync(window, options); else dialog.showMessageBoxSync(options);
    }
  });
  app.on('window-all-closed', () => { if (!mac) app.quit(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
