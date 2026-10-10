import { parseSrt, parseScenes, planScenes } from '../lib/planner.js';
import { groupCues, boundary, merge, split, clipAt } from '../lib/sync.js';

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const api = window.elpo;
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = text; if (cls) n.className = cls; return n; };
const SVG = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'ico') { const s = document.createElementNS(SVG, 'svg'); s.setAttribute('class', cls); const u = document.createElementNS(SVG, 'use'); u.setAttribute('href', `#i-${name}`); s.append(u); return s; }
const time = t => { const ms = Math.round(t / 1000); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
const short = us => { const s = Math.round(us / 1e6); return s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const plural = (n, words) => `${n} ${n > 1 ? words.split(' ').map(w => w + 's').join(' ') : words}`;
const VOICE = /voix|voice|narrat|vo[-_ .]|_vo\b|^vo\b|speech|parole|lecture/;
const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const HUES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(v => `var(${v})`);
async function unwrap(promise) { const r = await promise; if (!r?.ok) { const e = new Error(r?.error?.message || 'Opération impossible.'); e.code = r?.error?.code; e.details = r?.error?.details; throw e; } return r.result; }
const engine = (action, args) => unwrap(api.engine(action, args));

// ── State ──────────────────────────────────────────────────────────────────
let project = null, report = null, currentStep = 'media', currentPage = 'library', running = 'unknown', working = false, page = 0;
let scenesFile = null, srtFile = null, transitions = [], transitionIds = new Set(), effectIds = new Set(), filterIds = new Set(), preferences = {};
let syncPlan = null, syncPage = 0, mediaUrls = {}, playback = null, activeClip = null, raf = 0, playGeneration = 0;
let projects = [], selected = new Set(), libraryFilter = 'all', status = {}, styles = {}, favorites = { transitions: [], effects: [], filters: [] };
let library = { transitions: [], effects: [], filters: [] }, fxKind = 'transitions', fxShow = null, batchEngine = 'auto', singleEngine = 'elpo';
let exportJobs = [], pilotJobs = [], pilotSettings = {}, ffmpeg = null, focusScene = -1, ribbonZoom = 1, waveCache = new Map(), built = false;
const pageSize = 12;
// Each page: [eyebrow, title]. Mode 1 is the Plateau, mode 2 the Salle de rendu.
const PAGES = { library: ['Tous tes projets CapCut', 'Projets'], build: ['Mode 1 · Montage complet', 'Plateau'], batch: ['Mode 2 · Production en lot', 'Salle de rendu'],
  fx: ['Transitions, effets et filtres de tes projets', 'Bibliothèque'], vault: ['Sauvegardes et vidéos exportées', 'Coffre'], settings: ['FFmpeg, pilotage et recettes', 'Réglages'] };
// The chutier (media) is always visible on the Plateau; the inspector has four tabs.
const STEPS = ['scenes', 'style', 'review', 'deliver'];
let livePreview = false, liveTimer = 0, batchView = 'setup', lastRoutes = null, pilotPaused = false;

// ── Feedback ───────────────────────────────────────────────────────────────
let noticeTimer = 0;
function notice(text, error = false) {
  const n = $('notice'); n.textContent = text; n.className = `toast${error ? ' error' : ''}`; n.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { n.hidden = true; }, error ? 9000 : 5200);
}
function showError(e) { notice(`${e.message}${e.details?.length ? ' ' + e.details.slice(0, 8).join(', ') : ''}`, true); }
// Confirmation in an in-app sheet. `nodes` is optional detail content.
function ask(title, nodes = [], okLabel = 'Continuer', cancelLabel = 'Annuler') {
  return new Promise(resolve => {
    $('modalTitle').textContent = title; $('modalBody').replaceChildren(...[].concat(nodes).map(n => typeof n === 'string' ? el('p', n) : n));
    $('modalOk').textContent = okLabel; $('modalCancel').textContent = cancelLabel; $('modalCancel').hidden = !cancelLabel; $('modal').hidden = false;
    const done = value => { $('modal').hidden = true; resolve(value); };
    $('modalOk').onclick = () => done(true); $('modalCancel').onclick = () => done(false);
    $('modal').onclick = e => { if (e.target === $('modal')) done(false); };
    setTimeout(() => $('modalOk').focus?.(), 30);
  });
}

// ── Navigation ─────────────────────────────────────────────────────────────
function go(name) {
  if (!PAGES[name]) return;
  if (name !== 'build') $('voicePlayer').pause();
  const from = currentPage; currentPage = name;
  const show = () => {
    for (const p of Object.keys(PAGES)) $(`page-${p}`).hidden = p !== currentPage;
    document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === currentPage));
    $('pageEyebrow').textContent = PAGES[currentPage][0]; $('pageTitle').textContent = PAGES[currentPage][1];
    $('selectionBar').hidden = currentPage !== 'library' || !selected.size;
  };
  // Cross-fade between pages (View Transitions), unless the system asks for reduced motion.
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (from !== name && document.startViewTransition && !calm && !document.body.classList.contains('booting')) document.startViewTransition(show); else show();
  if (name === 'vault') task(backups);
  if (name === 'batch') renderBatch();
  if (name === 'fx') renderFx();
  if (name === 'settings') renderSettings();
}
function step(name) {
  if (name === 'media') name = 'scenes';
  if (name !== 'review') $('voicePlayer').pause();
  currentStep = name;
  for (const s of STEPS) $(`step-${s}`).hidden = s !== name;
  document.querySelectorAll('#stepper button').forEach(b => { b.classList.toggle('on', b.dataset.step === name); b.classList.toggle('done', STEPS.indexOf(b.dataset.step) < STEPS.indexOf(name)); });
  if (currentPage !== 'build') go('build');
  renderRibbon(); buttons();
}
function invalidate() { stopPlayback(); report = null; $('confirm').checked = false; $('previewContent').hidden = true; $('previewEmpty').hidden = false; $('exportScenes').disabled = true; renderRibbon(); buttons(); scheduleLive(); }
// Live preview: once a project has been analysed, every change is re-analysed quietly (read-only).
function scheduleLive() {
  clearTimeout(liveTimer);
  if (!livePreview || !project || project.nonempty) return;
  liveTimer = setTimeout(async () => {
    if (working) { scheduleLive(); return; }
    working = true; document.body.classList.add('busy'); buttons();
    try { await analyzeNow({ quiet: true }); }
    catch (e) { $('settingsHint').textContent = `Aperçu en attente : ${e.message}`; }
    finally { working = false; document.body.classList.remove('busy'); buttons(); }
  }, 650);
}
function buttons() {
  const at = STEPS.indexOf(currentStep);
  $('chooseFlowFolder').disabled = !project || working;
  $('clearFlowFolder').disabled = !project || working;
  $('toSettings').disabled = !project || project.nonempty || working;
  $('analyze').disabled = !project || project.nonempty || working;
  $('analyze').hidden = !['scenes', 'style', 'review'].includes(currentStep);
  $('stepBack').disabled = at <= 0; $('stepNext').hidden = at >= STEPS.length - 1 || (currentStep === 'style' && !report);
  $('stepNext').textContent = currentStep === 'review' ? 'Vers l’écriture' : 'Suivant';
  $('build').disabled = !report || !$('confirm').checked || running !== 'closed' || working;
  $('buildHint').textContent = running === 'open' ? 'Quitte CapCut pour autoriser la génération.' : running === 'unknown' ? 'La fermeture de CapCut doit être vérifiée.' : report ? 'Une sauvegarde précédera l’écriture des fichiers.' : 'L’écriture devient disponible après l’analyse.';
  $('exportOne').disabled = !project || (!built && !project.nonempty) || working;
  $('modeBuildMeta').textContent = project ? project.name : 'Choisis un projet';
  $('modeBatchMeta').textContent = selected.size ? `${plural(selected.size, 'projet coché')}` : 'Aucun projet coché';
  $('batchStart').disabled = !selected.size || working || !($('batchBuild').checked || $('batchExport').checked);
  $('liveBadge').hidden = !(livePreview && report);
  renderReadiness();
}
// Readiness pills in the Plateau header: what is done, and the next thing to do.
function renderReadiness() {
  const box = $('readiness'); box.replaceChildren();
  if (!project) return;
  if (project.nonempty) { const li = el('li', built ? 'Montage écrit · export possible' : 'Timeline déjà remplie · export possible', 'done'); li.prepend(icon('check')); box.append(li); return; }
  const scenesReady = $('placement').value !== 'sync' || (!!syncPlan?.scenes?.length && syncPlan.scenes.every(x => x.file));
  const items = [['Médias', project.visuals.length > 0 && !!$('audio').value], ['Scènes', !!report || scenesReady], ['Aperçu', !!report], ['Écriture', built]];
  let next = false;
  for (const [label, done] of items) {
    const li = el('li', label, done ? 'done' : next ? '' : 'next');
    if (done) li.prepend(icon('check')); else next = true;
    box.append(li);
  }
}
async function task(action) {
  if (working) return;
  working = true; document.body.classList.add('busy'); buttons();
  try { await action(); } catch (e) { showError(e); }
  finally { working = false; document.body.classList.remove('busy'); buttons(); }
}
async function poll() {
  if (working) return;
  try { running = await engine('running'); } catch { running = 'unknown'; }
  const label = running === 'closed' ? 'CapCut fermé · écriture possible' : running === 'open' ? 'CapCut ouvert · aperçu seulement' : 'État de CapCut inconnu';
  $('status').textContent = label; $('status').className = `pill${running === 'closed' ? ' green' : running === 'open' ? ' red' : ''}`;
  $('capcutLine').textContent = running === 'closed' ? 'CapCut fermé' : running === 'open' ? 'CapCut ouvert' : 'CapCut : état inconnu';
  $('capcutDot').className = `dot ${running === 'closed' ? 'ok' : running === 'open' ? 'warn' : ''}`;
  buttons();
}

// ── Projects (library of CapCut drafts) ──────────────────────────────────────────
function projectState(p) {
  if (!p.readable) return 'unreadable';
  if (p.lastExport) return 'exported';
  return p.nonempty ? 'built' : 'ready';
}
function coverNode(p, cls = 'cover') {
  const box = el('div', undefined, cls);
  if (p?.coverUrl) { const img = el('img'); img.alt = ''; img.src = p.coverUrl; box.append(img); }
  else box.append(el('span', (p?.name || '?').trim().charAt(0).toUpperCase(), 'monogram'));
  return box;
}
function renderGrid() {
  const q = $('librarySearch').value.trim().toLocaleLowerCase('fr');
  const list = projects.filter(p => (!q || p.name.toLocaleLowerCase('fr').includes(q)) && (libraryFilter === 'all' || projectState(p) === libraryFilter));
  $('projectGrid').replaceChildren(); $('projectGrid').classList.toggle('selecting', selected.size > 0);
  for (const p of list) {
    const card = el('article', undefined, `project-card${selected.has(p.path) ? ' selected' : ''}${project?.path === p.path ? ' active' : ''}`);
    const open = el('button', undefined, 'card-open'); open.setAttribute('aria-label', `Ouvrir ${p.name} dans Montage complet`); open.onclick = () => openProject(p.path);
    const check = el('button', undefined, 'card-check'); check.append(icon('check')); check.setAttribute('aria-label', `Cocher ${p.name}`); check.setAttribute('aria-pressed', String(selected.has(p.path)));
    check.onclick = e => { e.stopPropagation(); toggleSelect(p.path); };
    const body = el('div', undefined, 'card-body'), tags = el('div', undefined, 'tags');
    body.append(el('strong', p.name), el('span', p.readable ? `${p.canvas?.width}×${p.canvas?.height} · ${p.fps} i/s · ${p.durationUs ? short(p.durationUs) : 'vide'}` : 'Lecture impossible', 'subtle'), tags);
    const state = projectState(p);
    tags.append(el('span', { ready: 'Timeline vide', built: 'Timeline montée', exported: 'Exporté', unreadable: 'Format non lu' }[state], `tag ${state === 'ready' ? 'gold' : state === 'unreadable' ? 'bad' : 'ok'}`));
    if (p.readable) tags.append(el('span', `${plural(p.visuals, 'visuel')} · ${plural(p.audios, 'audio')}`, 'tag'));
    if (p.visualFolder) tags.append(el('span', 'Dossier Flow', 'tag'));
    if (p.subtitles) tags.append(el('span', 'SRT', 'tag'));
    card.append(coverNode(p), body, open, check); $('projectGrid').append(card);
  }
  $('libraryEmpty').hidden = list.length > 0;
  $('libraryEmptyTitle').textContent = projects.length ? 'Aucun projet ne correspond' : 'Aucun projet ici';
  $('navProjects').textContent = projects.length ? String(projects.length) : '';
  $('selectionText').textContent = plural(selected.size, 'projet coché');
  $('selectionBar').hidden = currentPage !== 'library' || !selected.size;
  buttons();
}
function toggleSelect(path, force) {
  const on = force ?? !selected.has(path);
  if (on) selected.add(path); else selected.delete(path);
  renderGrid(); renderBatch();
}
async function loadProjects() {
  const old = $('projectSelect').value;
  projects = await unwrap(api.overview());
  $('projectSelect').replaceChildren(el('option', 'Aucun projet actif'));
  $('projectSelect').firstChild.value = '';
  for (const p of projects) { const o = el('option', p.name); o.value = p.path; $('projectSelect').append(o); }
  if (projects.some(p => p.path === old)) $('projectSelect').value = old;
  selected = new Set([...selected].filter(p => projects.some(x => x.path === p)));
  renderGrid(); renderBatch();
}
async function refresh() {
  const old = $('projectSelect').value;
  projects = await unwrap(api.overview());
  selected = new Set([...selected].filter(p => projects.some(x => x.path === p)));
  $('projectSelect').replaceChildren(el('option', 'Aucun projet actif'));
  $('projectSelect').firstChild.value = '';
  for (const p of projects) { const o = el('option', p.name); o.value = p.path; $('projectSelect').append(o); }
  renderGrid(); renderBatch();
  if (projects.some(p => p.path === old)) { $('projectSelect').value = old; await selectProject(); }
  else if (old) { project = null; resetProjectView(); }
  if (!projects.length) notice('Aucun projet reconnu dans ce dossier. Crée un projet dans CapCut puis actualise.');
}
async function openProject(path) {
  $('projectSelect').value = path;
  await task(selectProject);
  go('build'); step(project?.nonempty ? 'deliver' : 'media');
}
function resetProjectView() {
  $('flowFolder').textContent = 'Les visuels importés dans CapCut sont utilisés.'; $('sourceTitle').textContent = 'Chutier CapCut'; $('clearFlowFolder').hidden = true;
  $('mediaList').replaceChildren(el('p', 'Sélectionne un projet pour voir ses médias.', 'hint'));
  $('projectInfo').textContent = 'Choisis un projet dans Projets ou dans le sélecteur en haut.'; $('projectName').textContent = 'Aucun projet actif';
  $('projectCover').replaceChildren(); $('mediaCount').textContent = 'Aucun projet sélectionné';
  invalidate();
}
async function selectProject() {
  livePreview = false; clearTimeout(liveTimer);
  resetProjectView(); built = false;
  syncPlan = null; syncPage = 0; scenesFile = null; srtFile = null; mediaUrls = {}; focusScene = -1;
  $('clearSrt').hidden = true; $('srtName').textContent = 'Phrases et pauses proposent les raccords. Le SRT peut aussi être incrusté à l’export.';
  $('clearScenes').hidden = true; $('scenesName').textContent = 'Reprends un plan enregistré.'; project = null; renderSync();
  const path = $('projectSelect').value; if (!path) { renderGrid(); buttons(); return; }
  const p = await engine('inspect', { project: path }); project = p;
  const card = projects.find(x => x.path === p.path);
  $('projectName').textContent = p.name; $('projectCover').replaceChildren(coverNode(card || p, 'cover'));
  $('flowFolder').textContent = p.visualFolder || 'Les visuels importés dans CapCut sont utilisés.';
  $('sourceTitle').textContent = p.visualFolder ? 'Dossier d’images' : 'Chutier CapCut';
  $('clearFlowFolder').hidden = !p.visualFolder;
  $('projectInfo').textContent = `${p.canvas?.width || '?'}×${p.canvas?.height || '?'} · ${p.fps || '?'} images/s · ${p.nonempty ? 'timeline déjà remplie : génération bloquée, export possible' : 'timeline vide, prête pour le montage'}`;
  $('mediaCount').textContent = `${plural(p.visuals.length, 'visuel')} · ${plural(p.audios.length, 'audio')}`;
  $('audio').replaceChildren(el('option', 'Choisis la voix off')); $('audio').firstChild.value = '';
  $('music').replaceChildren(el('option', 'Aucune musique')); $('music').firstChild.value = '';
  for (const a of p.audios) {
    const label = `${a.name} · ${a.durationUs ? (a.durationUs / 1e6).toFixed(1) + ' s' : 'durée inconnue'}`;
    const o = el('option', label); o.value = a.path; $('audio').append(o);
    const m = el('option', label); m.value = a.path; $('music').append(m);
  }
  // Preselect only when unambiguous: the single audio, or a name that says "voix".
  const named = p.audios.filter(a => VOICE.test(fold(a.name)));
  if (p.audios.length === 1) $('audio').value = p.audios[0].path;
  else if (named.length === 1) $('audio').value = named[0].path;
  $('musicBox').hidden = true;
  setPlacement('sync');
  mediaUrls = await unwrap(api.mediaSources(p.path));
  renderMedia(); renderMotions();
  if (p.flowError) notice(`${p.flowError} Choisis un autre dossier ou reviens au chutier.`, true);
  else if (p.nonempty) notice('La timeline est déjà remplie : ELPO ne la remplace pas. Tu peux exporter ce projet depuis l’étape 5 ou la production en lot.');
  else if (p.ignoredFiles) notice(`${p.ignoredFiles} entrée(s) non prises en charge, cachées ou sous-dossiers ne sont pas importées.`);
  renderGrid(); loadWave(); buttons();
}
function renderMedia() {
  const p = project; $('mediaList').replaceChildren();
  for (const m of [...p.visuals].slice(0, 240)) {
    const tile = el('div', undefined, 'media-tile');
    if (m.type === 'photo' && mediaUrls[m.path]) { const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = mediaUrls[m.path]; tile.append(img); }
    else tile.append(icon(m.type === 'video' ? 'film' : 'image'));
    if (m.type === 'video' && m.durationUs) tile.append(el('em', `${(m.durationUs / 1e6).toFixed(1)} s`));
    tile.append(el('span', m.name)); $('mediaList').append(tile);
  }
  if (p.visuals.length > 240) $('mediaList').append(el('p', `Aperçu limité à 240 visuels sur ${p.visuals.length}. Tous sont pris en compte.`, 'hint'));
  if (!p.visuals.length) $('mediaList').append(el('p', 'Aucun visuel : importe des images dans CapCut ou choisis un dossier d’images.', 'hint'));
}
function confirmVisualChange() {
  return !syncPlan && !scenesFile ? Promise.resolve(true) : ask('Changer la source des images ?', 'Le plan actuel sera réinitialisé. Enregistre-le avant si tu veux le conserver.', 'Changer de source');
}
$('chooseFlowFolder').onclick = () => task(async () => {
  if (!project || !(await confirmVisualChange())) return;
  const picked = await unwrap(api.chooseFlowFolder(project.path));
  if (picked) { await selectProject(); notice(`${plural(picked.visuals.length, 'image')} disponibles. Prépare maintenant les scènes.`); }
});
$('clearFlowFolder').onclick = () => task(async () => {
  if (!project || !(await confirmVisualChange())) return;
  await unwrap(api.clearFlowFolder(project.path)); await selectProject();
});

// ── Scenes ─────────────────────────────────────────────────────────────────
const PLACEMENT_HINTS = { sync: 'Un plan éditable : phrases regroupées, visuels choisis et raccords ajustables, ici ou directement sur la timeline.', even: 'Ordre naturel 001, 002, 010 : chaque visuel reçoit la même durée.', timecode: 'Chaque nom contient son horaire de départ (0-00, 0-20, 0-20-243). Départ à zéro obligatoire.', srt: 'Un bloc SRT par visuel, dans l’ordre des noms. Les nombres doivent correspondre.', timestamps: 'Colle un départ par visuel. Le dernier visuel finit avec la voix off.', scenes: 'Le JSON associe chaque fichier à un début et une fin en secondes.' };
function setPlacement(value) { $('placement').value = value; placementHint(); }
function placementHint() {
  const v = $('placement').value;
  $('timestampsBox').hidden = v !== 'timestamps';
  $('placementHint').textContent = PLACEMENT_HINTS[v];
  document.querySelectorAll('#placementCards button').forEach(b => { b.classList.toggle('on', b.dataset.placement === v); b.setAttribute('aria-checked', String(b.dataset.placement === v)); });
  $('syncPanel').classList.toggle('muted', v !== 'sync');
}
document.querySelectorAll('#placementCards button').forEach(b => b.onclick = () => { setPlacement(b.dataset.placement); invalidate(); });
function voiceDuration() {
  const a = project?.audios.find(a => a.path === $('audio').value);
  if (!a?.durationUs) throw new Error('Sélectionne une voix off dont la durée est connue.');
  return a.durationUs;
}
function syncChanged() { invalidate(); setPlacement('sync'); renderSync(); }
function visualFor(file) {
  const matches = project?.visuals.filter(m => m.path === file || m.name === file) || [];
  return matches.length === 1 ? matches[0] : null;
}
function renderSync() {
  const rows = syncPlan?.scenes || [];
  $('syncSummary').textContent = rows.length ? `${plural(rows.length, 'scène')} · ${rows.filter(s => !s.file).length} médias à associer` : 'Aucun plan : charge un SRT ou pars de tes médias';
  $('syncRows').replaceChildren(); $('syncPages').replaceChildren();
  syncPage = Math.max(0, Math.min(syncPage, Math.ceil(rows.length / pageSize) - 1));
  rows.slice(syncPage * pageSize, (syncPage + 1) * pageSize).forEach((s, localIndex) => {
    const index = syncPage * pageSize + localIndex, row = el('div', undefined, `sync-row${index === focusScene ? ' focus' : ''}`);
    const num = el('span', String(index + 1), 'num'); num.style.background = HUES[index % HUES.length];
    const found = visualFor(s.file);
    if (found) s.file = found.path;
    const thumb = el('div', undefined, 'thumb');
    if (found?.type === 'photo' && mediaUrls[found.path]) { const img = el('img'); img.alt = ''; img.src = mediaUrls[found.path]; thumb.append(img); } else thumb.append(icon(found?.type === 'video' ? 'film' : 'image'));
    const timing = el('div'), media = el('div');
    const times = el('div', undefined, 'sync-times');
    const start = el('input'); start.type = 'number'; start.step = '.001'; start.value = String(Number(Number(s.start).toFixed(3))); start.disabled = index === 0; start.setAttribute('aria-label', `Début scène ${index + 1}`);
    start.onchange = () => { try { boundary(syncPlan, index, Number(start.value)); syncChanged(); } catch (e) { showError(e); renderSync(); } };
    times.append(start, el('span', `→ ${Number(s.end).toFixed(3)} s`, 'timecode')); timing.append(times);
    const text = el('textarea'); text.rows = 2; text.value = s.text || ''; text.placeholder = 'Texte de la scène'; text.setAttribute('aria-label', `Texte scène ${index + 1}`); text.onchange = () => { s.text = text.value; invalidate(); }; timing.append(text);
    const select = el('select'); select.setAttribute('aria-label', `Visuel scène ${index + 1}`); const empty = el('option', 'Choisir le visuel…'); empty.value = ''; select.append(empty);
    for (const m of project?.visuals || []) { const o = el('option', `${m.type === 'video' ? '▶ ' : ''}${m.name}`); o.value = m.path; select.append(o); }
    if (found) select.value = found.path;
    else if (s.file) { const o = el('option', `Absent ou ambigu : ${s.file}`); o.value = s.file; select.append(o); select.value = s.file; }
    select.onchange = () => { s.file = select.value; s.sourceIn = 0; syncChanged(); };
    media.append(select);
    if (found?.type === 'video') {
      const source = el('input'); source.type = 'number'; source.min = '0'; source.step = '.001'; source.value = s.sourceIn || 0; source.setAttribute('aria-label', `Entrée dans la vidéo scène ${index + 1}`);
      source.onchange = () => { s.sourceIn = Number(source.value); invalidate(); };
      media.append(el('label', `Entrée dans la vidéo (s) · source ${(found.durationUs / 1e6).toFixed(2)} s`), source);
    }
    const actions = el('div', undefined, 'sync-actions'), cut = el('input'); cut.type = 'number'; cut.step = '.001'; cut.value = ((s.start + s.end) / 2).toFixed(3); cut.setAttribute('aria-label', `Horaire de coupure scène ${index + 1}`);
    const splitButton = el('button', 'Couper', 'btn ghost'); splitButton.prepend(icon('cut')); splitButton.onclick = () => { try { split(syncPlan, index, Number(cut.value)); syncChanged(); } catch (e) { showError(e); } };
    const mergeButton = el('button', 'Fusionner', 'btn ghost'); mergeButton.title = 'Fusionner avec la scène suivante'; mergeButton.disabled = index === rows.length - 1; mergeButton.onclick = () => { merge(syncPlan, index); syncChanged(); };
    actions.append(cut, splitButton, mergeButton); media.append(actions);
    row.append(num, thumb, timing, media); $('syncRows').append(row);
  });
  if (rows.length > pageSize) {
    const previous = el('button', 'Précédent', 'btn ghost'), next = el('button', 'Suivant', 'btn ghost');
    previous.disabled = syncPage === 0; next.disabled = (syncPage + 1) * pageSize >= rows.length;
    previous.onclick = () => { syncPage--; renderSync(); }; next.onclick = () => { syncPage++; renderSync(); };
    $('syncPages').append(previous, el('span', `Page ${syncPage + 1} / ${Math.ceil(rows.length / pageSize)}`), next);
  }
  renderRibbon();
}
$('groupSrt').onclick = () => task(async () => {
  if (!srtFile) throw new Error('Charge d’abord le SRT de cette voix off.');
  const proposed = groupCues(parseSrt(srtFile.text), voiceDuration(), Number($('targetSeconds').value));
  if (syncPlan && !(await ask('Remplacer le plan actuel ?', 'Les scènes proposées remplaceront tes corrections. Enregistre le plan pour les garder.', 'Remplacer'))) return;
  syncPlan = proposed; syncPage = 0; syncChanged(); notice('Scènes proposées. Choisis les visuels selon la narration, puis vérifie à l’écoute.');
});
$('createEven').onclick = () => task(async () => {
  const plan = planScenes(project?.visuals || [], voiceDuration(), { fps: project.fps });
  if (syncPlan && !(await ask('Remplacer le plan actuel ?', 'Les médias seront répartis à durées égales.', 'Remplacer'))) return;
  syncPlan = { version: 1, scenes: plan.map(s => ({ file: s.item.path, start: s.startUs / 1e6, end: s.endUs / 1e6, text: '' })) }; syncPage = 0; syncChanged();
});
$('assignOrder').onclick = () => task(async () => {
  if (!syncPlan) throw new Error('Crée d’abord le plan de scènes.');
  const sorted = [...project.visuals].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  if (sorted.length !== syncPlan.scenes.length) throw new Error(`${plural(syncPlan.scenes.length, 'scène')} pour ${plural(sorted.length, 'visuel')} : associe les médias à la main ou ajuste les scènes.`);
  if (!(await ask('Associer par ordre des noms ?', 'Les choix actuels seront remplacés. Vérifie ensuite la pertinence à l’écoute.', 'Associer'))) return;
  syncPlan.scenes.forEach((s, i) => { s.file = sorted[i].path; s.sourceIn = 0; }); syncChanged();
});
$('saveSync').onclick = () => task(async () => {
  if (!syncPlan) throw new Error('Aucun plan à enregistrer.');
  if (await unwrap(api.export(`${project?.name || 'ElpoAiAutoCapcut'}-plan.json`, JSON.stringify(syncPlan, null, 2)))) notice('Plan enregistré. Recharge ce JSON pour reprendre tes corrections.');
});
for (const [type, load, clear, name] of [['scenes', 'loadScenes', 'clearScenes', 'scenesName'], ['srt', 'loadSrt', 'clearSrt', 'srtName']]) {
  $(load).onclick = () => task(async () => { const r = await unwrap(api.loadFile(type)); if (!r) return; if (type === 'scenes') { syncPlan = parseScenes(r.text); scenesFile = r; setPlacement('sync'); renderSync(); } else srtFile = r; $(name).textContent = r.name; $(clear).hidden = false; invalidate(); placementHint(); });
  $(clear).onclick = () => { if (type === 'scenes') { scenesFile = null; syncPlan = null; renderSync(); setPlacement('sync'); } else srtFile = null; $(clear).hidden = true; $(name).textContent = type === 'srt' ? 'SRT retiré.' : 'Plan retiré.'; invalidate(); placementHint(); };
}

// ── Style ──────────────────────────────────────────────────────────────────
const MOTIONS = [['none', 'Fixe', ''], ['in', 'Zoom avant', 'm-in'], ['out', 'Zoom arrière', 'm-out'], ['alternate', 'Alterné', 'm-in'], ['pan-left', 'Vers la gauche', 'm-left'], ['pan-right', 'Vers la droite', 'm-right'], ['pan-up', 'Vers le haut', 'm-up'], ['pan-down', 'Vers le bas', 'm-down'], ['kenburns', 'Ken Burns', 'm-ken']];
function renderMotions() {
  $('motionGrid').replaceChildren();
  for (const [value, label, anim] of MOTIONS) {
    const b = el('button', undefined, `motion${$('motion').value === value ? ' on' : ''}`), frame = el('span', undefined, 'motion-frame'), pic = el('i');
    if (anim) pic.style.setProperty('--anim', anim);
    const sample = project?.visuals.find(m => m.type === 'photo' && mediaUrls[m.path]);
    if (sample) { pic.classList.add('real'); pic.style.backgroundImage = `url("${mediaUrls[sample.path]}")`; }
    frame.append(pic); b.append(frame, el('span', label)); b.setAttribute('aria-pressed', String($('motion').value === value));
    b.onclick = () => { $('motion').value = value; renderMotions(); invalidate(); };
    $('motionGrid').append(b);
  }
}
const FX = { transitions: { ids: () => transitionIds, box: 'transitions', fav: 'favTransitions' }, effects: { ids: () => effectIds, box: 'effects', fav: 'favEffects' }, filters: { ids: () => filterIds, box: 'filters', fav: 'favFilters' } };
const isFavorite = (kind, item) => item.favorite || (favorites[kind] || []).includes(item.id);
function renderChips(kind) {
  const cfg = FX[kind], box = $(cfg.box), ids = cfg.ids();
  const q = kind === 'transitions' ? $('transitionSearch').value.toLocaleLowerCase('fr') : '';
  const list = (library[kind] || []).filter(t => t.available && (!q || t.name.toLocaleLowerCase('fr').includes(q)))
    .sort((a, b) => isFavorite(kind, b) - isFavorite(kind, a) || a.name.localeCompare(b.name, 'fr'));
  box.replaceChildren();
  for (const t of list) {
    const b = el('button', undefined, `chip${ids.has(t.id) ? ' selected' : ''}`);
    if (isFavorite(kind, t)) b.append(icon('star'));
    b.append(document.createTextNode(t.name));
    b.title = `${t.category || ''}${t.clip ? ' · sur clip' : ''}${t.track ? ' · sur toute la vidéo' : ''}`; b.setAttribute('aria-pressed', String(ids.has(t.id)));
    b.onclick = () => { if (ids.has(t.id)) ids.delete(t.id); else ids.add(t.id); invalidate(); renderChips(kind); };
    box.append(b);
  }
  if (!list.length) box.append(el('p', q ? 'Aucun résultat.' : 'Rien de disponible. Utilise-les dans un projet CapCut, ferme-le, puis actualise.', 'hint'));
  const fav = (library[kind] || []).filter(t => t.available && isFavorite(kind, t)).length;
  const label = $(`${cfg.fav}Label`); if (label) label.textContent = `Mes favoris automatiquement${fav ? ` (${fav})` : kind === 'transitions' ? ' (sinon toutes)' : ' (aucun favori)'}`;
}
function renderTransitions() { renderChips('transitions'); }
async function loadCatalog() {
  library = await engine('library');
  transitions = library.transitions;
  for (const kind of Object.keys(FX)) { const ids = FX[kind].ids(); for (const id of [...ids]) if (!library[kind].some(t => t.id === id && t.available)) ids.delete(id); renderChips(kind); }
  $('navFx').textContent = String(library.transitions.length + library.effects.length + library.filters.length || '');
  renderFx(); invalidate();
}
function styleValues() {
  return { videoPolicy: $('videoPolicy').value, motion: $('motion').value, amount: Number($('amount').value) / 100, videoVolume: Number($('videoVolume').value) / 100,
    transitionIds: [...transitionIds], transitionSeconds: Number($('transitionSeconds').value), transitionOrder: $('transitionOrder').value,
    effectIds: [...effectIds], effectScope: $('effectScope').value, filterIds: [...filterIds], filterScope: $('filterScope').value,
    musicVolume: Number($('musicVolume').value) / 100,
    favorites: { transitions: $('favTransitions').checked, effects: $('favEffects').checked, filters: $('favFilters').checked } };
}
function applyStyle(v = {}) {
  for (const id of ['videoPolicy', 'motion', 'transitionSeconds', 'transitionOrder', 'effectScope', 'filterScope']) if (v[id] !== undefined) $(id).value = v[id];
  if (Number.isFinite(v.amount)) $('amount').value = Math.round(v.amount * 100);
  if (Number.isFinite(v.videoVolume)) $('videoVolume').value = Math.round(v.videoVolume * 100);
  if (Number.isFinite(v.musicVolume)) $('musicVolume').value = Math.round(v.musicVolume * 100);
  if (v.transitionIds) transitionIds = new Set(v.transitionIds);
  if (v.effectIds) effectIds = new Set(v.effectIds);
  if (v.filterIds) filterIds = new Set(v.filterIds);
  $('favTransitions').checked = !!v.favorites?.transitions; $('favEffects').checked = !!v.favorites?.effects; $('favFilters').checked = !!v.favorites?.filters;
  outputs(); renderMotions(); for (const k of Object.keys(FX)) renderChips(k);
}
function outputs() { $('amountValue').textContent = `${$('amount').value} %`; $('volumeValue').textContent = `${$('videoVolume').value} %`; $('musicVolumeValue').textContent = `${$('musicVolume').value} %`; }
function options() {
  if ($('placement').value === 'sync' && (!syncPlan?.scenes?.length || syncPlan.scenes.some(s => !s.file))) throw new Error('Crée un plan et associe un média à chaque scène avant l’analyse.');
  return { ...styleValues(), audioPath: $('audio').value, musicPath: $('music').value || undefined, placement: $('placement').value === 'sync' ? 'scenes' : $('placement').value,
    scenesText: $('placement').value === 'sync' ? JSON.stringify(syncPlan) : scenesFile?.text || '', srtText: srtFile?.text || '', timestampsText: $('timestampsText').value };
}
function renderStyles() {
  const current = $('styleSelect').value;
  for (const id of ['styleSelect', 'batchStyle']) {
    const s = $(id); s.replaceChildren(el('option', id === 'styleSelect' ? 'Réglages actuels' : 'Réglages par défaut')); s.firstChild.value = '';
    for (const name of Object.keys(styles).sort((a, b) => a.localeCompare(b, 'fr'))) { const o = el('option', name); o.value = name; s.append(o); }
  }
  if (styles[current]) $('styleSelect').value = current;
  $('deleteStyle').hidden = !$('styleSelect').value;
  $('styleList').replaceChildren();
  for (const name of Object.keys(styles)) {
    const row = el('div', undefined, 'row'), info = el('div'), v = styles[name];
    info.append(el('strong', name), el('span', `${MOTIONS.find(m => m[0] === v.motion)?.[1] || 'Fixe'} · ${plural((v.transitionIds || []).length, 'transition')} · ${plural((v.effectIds || []).length, 'effet')} · ${plural((v.filterIds || []).length, 'filtre')}`));
    const del = el('button', 'Supprimer', 'link'); del.onclick = () => task(async () => { styles = await unwrap(api.styles({ action: 'delete', name })); renderStyles(); });
    row.append(info, del); $('styleList').append(row);
  }
  if (!Object.keys(styles).length) $('styleList').append(el('p', 'Aucun style. Règle mouvement, transitions, effets et filtres à l’étape Style, puis enregistre-les.', 'hint'));
}
$('styleSelect').onchange = () => { const v = styles[$('styleSelect').value]; if (v) { applyStyle(v); invalidate(); notice(`Style « ${$('styleSelect').value} » appliqué.`); } $('deleteStyle').hidden = !$('styleSelect').value; };
$('saveStyle').onclick = async () => {
  const input = el('input'); input.type = 'text'; input.placeholder = 'Nom du style, par exemple Prière douce'; input.value = $('styleSelect').value || '';
  if (!(await ask('Enregistrer ce style', [el('p', 'Mouvement, transitions, effets, filtres et sons seront réutilisables ici et en production en lot.'), input], 'Enregistrer'))) return;
  const name = input.value.trim(); if (!name) return;
  task(async () => { styles = await unwrap(api.styles({ action: 'save', name, value: styleValues() })); renderStyles(); $('styleSelect').value = name; $('deleteStyle').hidden = false; notice(`Style « ${name} » enregistré.`); });
};
$('deleteStyle').onclick = () => task(async () => { const name = $('styleSelect').value; if (!name || !(await ask(`Supprimer « ${name} » ?`, [], 'Supprimer'))) return; styles = await unwrap(api.styles({ action: 'delete', name })); $('styleSelect').value = ''; renderStyles(); });
$('savePreset').onclick = () => task(async () => { const saved = styleValues(); await unwrap(api.preferences(saved)); preferences = saved; notice('Ces réglages seront appliqués par défaut.'); });
for (const id of ['audio', 'music', 'videoPolicy', 'amount', 'videoVolume', 'musicVolume', 'transitionSeconds', 'transitionOrder', 'effectScope', 'filterScope', 'timestampsText', 'favTransitions', 'favEffects', 'favFilters'])
  $(id).addEventListener('input', () => { invalidate(); placementHint(); outputs(); $('musicBox').hidden = !$('music').value; });
$('audio').addEventListener('change', () => { syncPlan = null; scenesFile = null; renderSync(); loadWave(); notice('Voix off changée : reconstruis ou recharge le plan pour cette durée.'); });
$('music').addEventListener('change', () => { if ($('music').value && $('music').value === $('audio').value) { $('music').value = ''; notice('La musique doit être différente de la voix off.', true); } $('musicBox').hidden = !$('music').value; });
$('transitionSearch').oninput = renderTransitions;
$('refreshTransitions').onclick = () => task(loadCatalog);

// ── Review ──────────────────────────────────────────────────────────────────
function renderReport(jump = true) {
  $('previewEmpty').hidden = true; $('previewContent').hidden = false; $('exportScenes').disabled = false; $('confirm').checked = false;
  $('stats').replaceChildren();
  for (const [value, label] of [[report.scenes, 'scènes'], [report.clips, 'clips sur la timeline'], [time(report.durationUs), 'de voix off'], [`${report.transitions + (report.effects || 0) + (report.filters || 0)}`, 'transitions, effets, filtres']]) {
    const c = el('div', undefined, 'stat'); c.append(el('strong', String(value)), el('span', label)); $('stats').append(c);
  }
  $('warnings').replaceChildren(...report.warnings.map(w => el('li', w)));
  $('writeFiles').textContent = `${plural(report.filesToWrite.length, 'fichier')} sauvegardé(s) puis modifié(s) : ${report.filesToWrite.join(', ')}`;
  $('sceneCount').textContent = `${plural(report.rows.length, 'scène')} · ${report.audio}`;
  page = 0; renderRows(); setupPlayback();
  if (jump) step('review'); else renderRibbon();
  buttons();
}
function renderRows() {
  if (!report) return;
  const token = report.token;
  $('sceneRows').replaceChildren();
  for (const r of report.rows.slice(page * pageSize, (page + 1) * pageSize)) {
    const tr = el('tr'); tr.append(el('td', String(r.index)));
    const visual = el('td'); const jump = el('button', r.name, 'scene-jump'); jump.onclick = () => seek(r.startUs); visual.append(jump);
    tr.append(visual, el('td', `${time(r.startUs)} → ${time(r.endUs)}`), el('td', `${(r.durationUs / 1e6).toFixed(2)} s`), el('td', String(r.clips)), el('td', r.text || '—')); $('sceneRows').append(tr);
    if (r.type === 'photo') {
      const show = src => { if (report?.token === token && visual.isConnected) { const img = el('img', undefined, 'thumb-sm'); img.alt = ''; img.src = src; visual.prepend(img); } };
      if (mediaUrls[r.path]) show(mediaUrls[r.path]); else engine('thumbnail', { file: r.path }).then(show).catch(() => {});
    }
  }
  const totalPages = Math.ceil(report.rows.length / pageSize);
  if (totalPages <= 1) { $('pagination').replaceChildren(); return; }
  const prev = el('button', 'Précédent', 'btn ghost'), next = el('button', 'Suivant', 'btn ghost');
  prev.disabled = page === 0; next.disabled = page >= totalPages - 1;
  prev.onclick = () => { page--; renderRows(); }; next.onclick = () => { page++; renderRows(); };
  $('pagination').replaceChildren(prev, el('span', `Page ${page + 1} / ${totalPages}`), next);
}
async function analyzeNow({ quiet = false } = {}) {
  const live = livePreview, resumeAt = quiet ? $('voicePlayer').currentTime || 0 : 0;
  livePreview = false; clearTimeout(liveTimer);
  invalidate(); $('settingsHint').textContent = quiet ? 'Aperçu vivant : mise à jour…' : 'Vérification des médias et préparation du montage…';
  try { report = await engine('preview', { project: project.path, options: options() }); }
  catch (e) { livePreview = live; throw e; }
  finally { $('settingsHint').textContent = 'L’analyse ne modifie aucun fichier CapCut.'; }
  livePreview = true;
  renderReport(!quiet);
  if (resumeAt) seek(resumeAt * 1e6);
}
$('analyze').onclick = () => task(async () => { await analyzeNow(); notice('Aperçu prêt. Il se met à jour tout seul quand tu changes un réglage. Aucun fichier CapCut n’a été modifié.'); });
$('confirm').onchange = buttons;
$('build').onclick = () => task(async () => {
  $('buildHint').textContent = 'Sauvegarde, écriture puis vérification…'; stopPlayback(); const token = report.token; report = null; $('confirm').checked = false; $('exportScenes').disabled = true;
  const r = await engine('commit', { token });
  if (srtFile?.path) await unwrap(api.subtitles({ project: project.path, file: srtFile.path })).catch(() => {});
  built = true;
  notice(`Montage généré : ${plural(r.scenes, 'scène')}, ${plural(r.clips, 'clip')}. ${r.files} fichiers sauvegardés et vérifiés.`);
  $('buildHint').textContent = 'Génération terminée. Ouvre CapCut pour contrôler, ou exporte directement.';
  project.nonempty = true; buttons();
  loadProjects().catch(() => {});
});
$('exportScenes').onclick = () => task(async () => {
  const obj = { version: 1, scenes: report.rows.map(r => ({ file: r.path, sourceIn: (r.sourceInUs || 0) / 1e6, start: r.startUs / 1e6, end: r.endUs / 1e6, ...(r.text ? { text: r.text } : {}) })) };
  if (await unwrap(api.export(`${project?.name || 'ElpoAiAutoCapcut'}-scenes.json`, JSON.stringify(obj, null, 2)))) notice('Plan de scènes exporté.');
});
$('editSync').onclick = () => { $('voicePlayer').pause(); step('scenes'); };

// ── Player ──────────────────────────────────────────────────────────────────
function playbackError(text) { $('playerError').textContent = text; $('playerError').hidden = false; }
function stopPlayback() {
  playGeneration++; cancelAnimationFrame(raf); playback = null; activeClip = null;
  $('playerImage').style.transform = ''; $('playerVideo').style.transform = '';
  $('playerEmpty').textContent = project?.nonempty ? 'Timeline déjà remplie : exporte ce projet depuis l’onglet Écrire.' : 'Analyse le projet : le montage apparaîtra ici, en mouvement.';
  $('voicePlayer').pause(); $('voicePlayer').removeAttribute('src'); $('voicePlayer').load();
  $('playerVideo').pause(); $('playerVideo').removeAttribute('src'); $('playerVideo').load();
  $('playerImage').removeAttribute('src'); $('playerImage').hidden = true; $('playerVideo').hidden = true; $('playerEmpty').hidden = false; $('playerBadge').textContent = '';
}
function setupPlayback() {
  stopPlayback(); playback = report; $('playerError').hidden = true;
  const url = mediaUrls[report.audioPath];
  if (!url) { playbackError('Voix off indisponible pour la lecture locale : format non pris en charge ou fichier absent.'); return; }
  $('voicePlayer').src = url; updatePlayback();
}
function seek(us) { if (!playback) return; $('voicePlayer').currentTime = us / 1e6; updatePlayback(); }
function updatePlayback() {
  if (!playback) return;
  const audio = $('voicePlayer'), video = $('playerVideo'), t = audio.currentTime, clip = clipAt(playback.playbackClips, t);
  $('playerClock').textContent = `${time(t * 1e6)} / ${time(playback.durationUs)}`; $('dockClock').textContent = time(t * 1e6);
  placePlayhead(t * 1e6);
  if (!clip) { video.pause(); $('playerVideo').hidden = true; $('playerImage').hidden = true; $('playerEmpty').hidden = false; $('playerEmpty').textContent = 'Fin de la voix off.'; activeClip = null; return; }
  const row = playback.rows[clip.scene - 1]; $('playerScene').textContent = `Scène ${clip.scene} · ${row.name}`; $('playerText').textContent = row.text || 'Aucun texte associé.'; $('playerBadge').textContent = `${clip.scene} / ${playback.rows.length}`;
  const target = (clip.sourceStartUs + Math.round(t * 1e6) - clip.startUs) / 1e6;
  if (activeClip !== clip) {
    activeClip = clip; video.pause(); const url = mediaUrls[clip.path];
    $('playerImage').hidden = true; video.hidden = true; $('playerEmpty').hidden = !!url;
    if (!url) { $('playerEmpty').textContent = 'Visuel indisponible pour la lecture locale.'; playbackError(`Lecture indisponible : ${row.name}. Vérifie le fichier et le codec.`); }
    else if (clip.type === 'photo') { $('playerImage').src = url; $('playerImage').hidden = false; }
    else { video.src = url; video.hidden = false; }
  }
  applyMotion(clip, t);
  if (clip.type === 'video' && video.readyState >= 1) {
    if (Math.abs(video.currentTime - target) > .08) video.currentTime = target;
    if (!audio.paused && video.paused) { const generation = playGeneration; video.play().catch(() => { if (generation === playGeneration) playbackError('Le clip vidéo ne peut pas être lu ici. Vérifie son codec dans CapCut.'); }); }
    else if (audio.paused) video.pause();
  }
}
// Same math as motionFor() in lib/engine.js, so the stage moves the way CapCut will.
const KENBURNS = ['in', 'pan-right', 'out', 'pan-left', 'pan-up', 'pan-down'];
function motionAt(kind, sceneIndex, amount, f) {
  if (kind === 'alternate') kind = sceneIndex % 2 === 0 ? 'in' : 'out';
  if (kind === 'kenburns') kind = KENBURNS[sceneIndex % KENBURNS.length];
  const big = 1 + amount, p = amount * 0.9, lerp = (a, b) => a + (b - a) * f;
  const m = { in: [1, big, 0, 0, 0, 0], out: [big, 1, 0, 0, 0, 0], 'pan-left': [big, big, p, -p, 0, 0], 'pan-right': [big, big, -p, p, 0, 0], 'pan-up': [big, big, 0, 0, -p, p], 'pan-down': [big, big, 0, 0, p, -p] }[kind];
  return m ? { s: lerp(m[0], m[1]), x: lerp(m[2], m[3]), y: lerp(m[4], m[5]) } : null;
}
function applyMotion(clip, t) {
  const row = playback.rows[clip.scene - 1], amount = Number($('amount').value) / 100, kind = playback.motion || 'none';
  const f = Math.min(1, Math.max(0, (t * 1e6 - row.startUs) / Math.max(1, row.endUs - row.startUs)));
  const m = kind !== 'none' && amount > 0 ? motionAt(kind, clip.scene - 1, amount, f) : null;
  // CapCut positions are in half-canvas units, y pointing up.
  const value = m ? `translate(${(m.x * 50).toFixed(3)}%, ${(-m.y * 50).toFixed(3)}%) scale(${m.s.toFixed(4)})` : '';
  $('playerImage').style.transform = clip.type === 'photo' ? value : ''; $('playerVideo').style.transform = clip.type === 'video' ? value : '';
}
function animatePlayback() { updatePlayback(); if (!$('voicePlayer').paused && playback) raf = requestAnimationFrame(animatePlayback); }
function togglePlay() { if (!playback) return; const a = $('voicePlayer'); if (a.paused) a.play()?.catch?.(() => {}); else a.pause(); }
$('playToggle').onclick = togglePlay;
$('voicePlayer').addEventListener('play', () => { cancelAnimationFrame(raf); animatePlayback(); $('playToggle').replaceChildren(icon('stop')); });
$('voicePlayer').addEventListener('pause', () => $('playToggle').replaceChildren(icon('play')));
for (const event of ['pause', 'seeked', 'timeupdate', 'ended']) $('voicePlayer').addEventListener(event, updatePlayback);
$('voicePlayer').addEventListener('error', () => { if (playback) playbackError('Voix off illisible dans cet aperçu. Vérifie le fichier et son codec.'); });
$('playerVideo').addEventListener('loadedmetadata', updatePlayback);
$('playerVideo').addEventListener('error', () => { if (playback) playbackError('Vidéo illisible dans cet aperçu. Vérifie son codec ; aucun remplacement automatique.'); });
$('playerImage').addEventListener('error', () => { if (playback) playbackError('Image illisible dans cet aperçu.'); });

// ── Timeline ribbon: scenes, waveform, draggable cuts ────────────────────────────
function ribbonScenes() {
  if (report) return report.rows.map(r => ({ start: r.startUs / 1e6, end: r.endUs / 1e6, file: r.path, name: r.name }));
  return (syncPlan?.scenes || []).map(s => ({ start: s.start, end: s.end, file: s.file, name: visualFor(s.file)?.name || '' }));
}
function renderRibbon() {
  const scenes = ribbonScenes(), show = currentPage === 'build' && scenes.length > 0;
  $('timelineDock').hidden = !show;
  if (!show) return;
  const total = scenes.at(-1).end || 1, editable = !report && $('placement').value === 'sync' && !!syncPlan;
  $('ribbon').style.width = `${Math.round(ribbonZoom * 100)}%`;
  $('dockInfo').textContent = editable ? 'Glisse un raccord pour l’ajuster. Clique une scène pour la retrouver dans le plan.' : report ? 'Clique une scène pour l’écouter.' : 'Aperçu du plan.';
  $('ribbonScenes').replaceChildren();
  scenes.forEach((s, i) => {
    const block = el('div', undefined, `rscene${s.file ? '' : ' empty'}${i === focusScene ? ' focus' : ''}`);
    block.style.left = `${s.start / total * 100}%`; block.style.width = `calc(${(s.end - s.start) / total * 100}% - 2px)`;
    block.style.setProperty('--c', HUES[i % HUES.length]); block.style.setProperty('--i', String(Math.min(i, 60)));
    const v = visualFor(s.file);
    if (v?.type === 'photo' && mediaUrls[v.path]) { const img = el('img'); img.alt = ''; img.src = mediaUrls[v.path]; block.append(img); }
    block.append(el('span', `${i + 1}${s.name ? ' · ' + s.name : s.file ? '' : ' · à associer'}`));
    block.title = `${i + 1} · ${s.start.toFixed(2)} → ${s.end.toFixed(2)} s`;
    block.onclick = () => { focusScene = i; if (report) seek(s.start * 1e6); else { syncPage = Math.floor(i / pageSize); renderSync(); } };
    $('ribbonScenes').append(block);
    if (editable && i > 0) $('ribbonScenes').append(handle(i, s.start, total));
  });
  drawWave();
  if (report && playback) placePlayhead($('voicePlayer').currentTime * 1e6); else $('playhead').style.left = '0%';
}
function handle(index, at, total) {
  const h = el('div', undefined, 'handle'); h.style.left = `${at / total * 100}%`; h.setAttribute('aria-label', `Raccord ${index}`);
  h.onpointerdown = e => {
    e.preventDefault(); h.setPointerCapture?.(e.pointerId); h.classList.add('drag');
    const rect = $('ribbon').getBoundingClientRect(), rows = syncPlan.scenes, min = rows[index - 1].start + .05, max = rows[index].end - .05;
    let t = at;
    const move = ev => { t = Math.min(max, Math.max(min, (ev.clientX - rect.left) / rect.width * total)); h.style.left = `${t / total * 100}%`; $('dockClock').textContent = time(t * 1e6); };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.classList.remove('drag'); try { boundary(syncPlan, index, Math.round(t * 1000) / 1000); syncChanged(); } catch (err) { showError(err); renderRibbon(); } };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
  };
  return h;
}
function placePlayhead(us) { const total = (ribbonScenes().at(-1)?.end || 1) * 1e6; $('playhead').style.left = `${Math.min(100, us / total * 100)}%`; }
async function loadWave() {
  const path = $('audio').value, url = mediaUrls[path];
  if (!url || waveCache.has(path) || typeof api.waveform !== 'function') { drawWave(); return; }
  try {
    // Peaks come from FFmpeg in the main process: no full decode in this window.
    const { peaks } = await unwrap(api.waveform(url));
    if (peaks.length) waveCache.set(path, peaks);
    drawWave();
  } catch { /* the ribbon works without a waveform */ }
}
function drawWave() {
  const canvas = $('wave'), peaks = waveCache.get(report?.audioPath || $('audio').value), ctx = canvas.getContext?.('2d');
  if (!ctx || !canvas.clientWidth) return;
  const w = canvas.clientWidth * devicePixelRatio, h = canvas.clientHeight * devicePixelRatio; canvas.width = w; canvas.height = h; ctx.clearRect(0, 0, w, h);
  if (!peaks) return;
  ctx.fillStyle = 'rgba(212,176,106,.55)';
  const max = Math.max(...peaks) || 1, bar = Math.max(1, w / peaks.length);
  for (let i = 0; i < peaks.length; i++) { const v = peaks[i] / max * h * .92; ctx.fillRect(i * bar, (h - v) / 2, Math.max(1, bar - .4), Math.max(1, v)); }
}
$('dockZoomIn').onclick = () => { ribbonZoom = Math.min(8, ribbonZoom * 1.6); renderRibbon(); };
$('dockZoomOut').onclick = () => { ribbonZoom = Math.max(1, ribbonZoom / 1.6); renderRibbon(); };

// ── Deliver: export this project ──────────────────────────────────────────────────
function exportSettings() {
  return { outputDir: $('outputDir').dataset.path || '', resolution: $('exResolution').value, fps: $('exFps').value, quality: $('exQuality').value, codec: $('exCodec').value,
    parallel: Number($('exParallel').value), pattern: $('exPattern').value || '{projet}', hardware: $('exHardware').checked, subtitles: $('exSubtitles').checked };
}
function applyExportSettings(s = {}) {
  if (s.outputDir) { $('outputDir').dataset.path = s.outputDir; $('outputDir').textContent = s.outputDir; }
  for (const [id, key] of [['exResolution', 'resolution'], ['exFps', 'fps'], ['exQuality', 'quality'], ['exCodec', 'codec'], ['exParallel', 'parallel'], ['exPattern', 'pattern']]) if (s[key] !== undefined) $(id).value = String(s[key]);
  if (s.hardware !== undefined) $('exHardware').checked = !!s.hardware; if (s.subtitles !== undefined) $('exSubtitles').checked = !!s.subtitles;
}
async function saveExportSettings() { await unwrap(api.exportSettings(exportSettings())); }
async function startExport(list, engineName, test = false, { confirmed = false } = {}) {
  if (!list.length) throw new Error('Aucun projet à exporter.');
  if (engineName === 'capcut') {
    if (!pilotSettings.tile) { go('settings'); throw new Error('Vise d’abord la première vignette de l’accueil CapCut : Réglages, Pilotage de CapCut, bouton « Viser ».'); }
    if (!pilotSettings.exportDir) { go('settings'); throw new Error('Indique le dossier d’export utilisé par CapCut (Réglages).'); }
    if (!confirmed && !(await ask(test ? 'Tester le pilotage sur un projet ?' : `Exporter ${plural(list.length, 'projet')} avec CapCut ?`, [
      el('p', 'ELPO va fermer et relancer CapCut, ouvrir chaque projet, lancer l’export puis revenir à la liste des projets. N’utilise pas le clavier ni la souris pendant le lot.'),
      el('p', 'Pour arrêter : bouton Tout arrêter, ou ⌘Q dans ELPO après l’export en cours.')], 'Démarrer'))) return false;
    await unwrap(api.pilotStart({ projects: list.map(p => ({ path: p.path, name: p.name })), test }));
    notice('Pilotage de CapCut démarré.');
  } else {
    if (!ffmpeg) { go('settings'); throw new Error('FFmpeg est introuvable. Installe-le avec Homebrew (brew install ffmpeg) ou indique son emplacement.'); }
    const s = exportSettings();
    if (!s.outputDir) { const dir = await unwrap(api.chooseDir({ purpose: 'output' })); if (!dir) return false; $('outputDir').dataset.path = dir; $('outputDir').textContent = dir; s.outputDir = dir; }
    await saveExportSettings();
    await unwrap(api.exportStart({ projects: list.map(p => ({ path: p.path, name: p.name })), settings: s }));
    notice(`${plural(list.length, 'export')} ajouté(s) à la file.`);
  }
  return true;
}
// Automatic engine: each project goes to ELPO when it renders the timeline faithfully, to CapCut otherwise.
async function startAutoExport(list) {
  if (!list.length) throw new Error('Aucun projet à exporter.');
  const routes = new Map((await engine('fidelity', { projects: list.map(p => p.path) })).map(r => [r.project, r]));
  const elpoList = [], capcutList = [];
  for (const p of list) { const r = routes.get(p.path); if (!r || r.empty) continue; (r.engine === 'capcut' ? capcutList : elpoList).push(p); }
  if (!elpoList.length && !capcutList.length) throw new Error('Aucune timeline à exporter dans la sélection.');
  const rows = capcutList.map(p => { const row = el('div', undefined, 'modal-row'), info = el('div'); info.append(el('strong', p.name), el('p', `Via CapCut : ${routes.get(p.path).reasons.join(', ')}.`)); row.append(icon('fx'), info); return row; });
  const intro = el('p', `${plural(elpoList.length, 'projet')} avec ELPO en arrière-plan · ${plural(capcutList.length, 'projet')} via CapCut pour un rendu identique.`);
  if (capcutList.length && (!pilotSettings.tile || !pilotSettings.exportDir)) {
    // The pilot is not set up: export those projects with ELPO anyway (without these elements), or leave them out.
    const anyway = await ask('Pilotage CapCut pas encore prêt', [intro, ...rows, el('p', 'Pour exporter ces projets à l’identique, vise la vignette de CapCut dans « Pilotage prêt ? ». Sinon, ELPO peut les exporter sans ces éléments.')], 'Exporter avec ELPO quand même', 'Les laisser de côté');
    if (anyway) elpoList.push(...capcutList);
    capcutList.length = 0;
    if (!elpoList.length) return false;
  } else if (!(await ask(`Exporter ${plural(elpoList.length + capcutList.length, 'projet')} ?`, [intro, ...rows, ...(capcutList.length ? [el('p', 'Pendant le pilotage, ELPO utilise la souris et le clavier : n’y touche pas.')] : [])], 'Démarrer'))) return false;
  lastRoutes = { elpo: elpoList.map(p => p.name), capcut: capcutList.map(p => ({ name: p.name, reasons: routes.get(p.path).reasons })) };
  if (elpoList.length && !(await startExport(elpoList, 'elpo'))) return false;
  if (capcutList.length) await startExport(capcutList, 'capcut', false, { confirmed: true });
  renderFidelity();
  return true;
}
function renderFidelity() {
  $('fidelityCard').hidden = !lastRoutes;
  if (!lastRoutes) return;
  const nodes = [el('p', `${plural(lastRoutes.elpo.length, 'projet')} avec ELPO, en arrière-plan.`)];
  for (const r of lastRoutes.capcut) { const p = el('p'); p.append(el('strong', r.name), document.createTextNode(` via CapCut : ${r.reasons.join(', ')}.`)); nodes.push(p); }
  $('fidelityList').replaceChildren(...nodes);
}
function setBatchView(view) {
  batchView = view;
  $('batchSetup').hidden = view !== 'setup'; $('renderRoom').hidden = view !== 'room'; $('roomStats').hidden = view !== 'room';
  document.querySelectorAll('#batchView button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
}
function showRoom() { go('batch'); setBatchView('room'); }
document.querySelectorAll('#batchView button').forEach(b => b.onclick = () => setBatchView(b.dataset.view));
document.querySelectorAll('#singleEngine button').forEach(b => b.onclick = () => { singleEngine = b.dataset.engine; document.querySelectorAll('#singleEngine button').forEach(x => x.classList.toggle('on', x === b)); });
$('exportOne').onclick = () => task(async () => { if (project) await startExport([{ path: project.path, name: project.name }], singleEngine); });

// ── Batch production ──────────────────────────────────────────────────────────────
function selectedProjects() { return projects.filter(p => selected.has(p.path)); }
function renderBatch() {
  const list = selectedProjects();
  $('batchCount').textContent = plural(list.length, 'projet');
  $('batchProjects').replaceChildren();
  for (const p of list) {
    const row = el('div', undefined, 'batch-item'), info = el('div'), mini = coverNode(p, 'mini');
    info.append(el('strong', p.name), el('span', !p.readable ? 'Format non lu par ELPO : export via CapCut uniquement' : p.nonempty ? `${p.elpo ? 'Monté par ELPO' : 'Montage manuel'} · ${short(p.durationUs)}` : `Timeline vide · ${p.visuals} visuels, ${p.audios} audios`));
    const remove = el('button', undefined, 'link'); remove.append(icon('x')); remove.setAttribute('aria-label', `Retirer ${p.name}`); remove.onclick = () => toggleSelect(p.path, false);
    row.append(mini, info, remove); $('batchProjects').append(row);
  }
  if (!list.length) $('batchProjects').append(el('p', 'Coche des projets dans Projets (case en haut à gauche de chaque vignette), ou ⌘A pour tout cocher.', 'hint'));
  const buildOn = $('batchBuild').checked, exportOn = $('batchExport').checked;
  $('batchBuildBox').classList.toggle('off', !buildOn); $('batchExportBox').classList.toggle('off', !exportOn);
  document.querySelectorAll('#batchEngine button').forEach(b => b.classList.toggle('on', b.dataset.engine === batchEngine));
  $('elpoExportBox').hidden = batchEngine === 'capcut'; $('capcutExportBox').hidden = batchEngine === 'elpo';
  $('batchTest').hidden = !(exportOn && batchEngine !== 'elpo');
  $('batchVoicePatternBox').hidden = $('batchVoice').value !== 'name';
  const toBuild = buildOn ? list.filter(p => p.readable && !p.nonempty).length : 0;
  const exportable = list.filter(p => batchEngine === 'elpo' ? p.readable && p.nonempty : !p.readable || p.nonempty).length + toBuild;
  $('batchHint').textContent = !list.length ? 'Coche des projets dans Projets.' : [buildOn ? `${plural(toBuild, 'timeline')} à monter` : null, exportOn ? `${plural(exportable, 'vidéo')} à exporter ${batchEngine === 'capcut' ? 'via CapCut' : batchEngine === 'auto' ? 'avec le moteur automatique' : 'avec ELPO'}` : null,
    exportOn && exportable < list.length ? `${list.length - exportable} sans timeline` : null].filter(Boolean).join(' · ') || 'Active au moins une étape.';
  renderPilotState(); buttons();
}
// "Pilotage prêt": each missing piece comes with the button that fixes it, right where the batch starts.
let pilotAccessOk = null;
function renderPilotState() {
  const p = pilotSettings;
  $('homePoint').textContent = p.home ? `x ${p.home.x}, y ${p.home.y}` : 'Détection automatique, ou viser le bouton dans la barre de gauche';
  const items = [
    [pilotAccessOk === true, pilotAccessOk === true ? 'Accessibilité autorisée' : 'Autorise ELPO à piloter CapCut (Accessibilité de macOS)', pilotAccessOk === true ? null : ['Autoriser', () => $('pilotAccess').onclick()]],
    [!!p.exportDir, p.exportDir ? `Exports CapCut : ${p.exportDir}` : 'Indique le dossier où CapCut enregistre ses vidéos', [p.exportDir ? 'Changer' : 'Choisir', () => $('chooseCapcutDir').onclick()]],
    [!!p.tile, p.tile ? 'Première vignette de l’accueil visée' : 'Vise la première vignette de l’accueil de CapCut', [p.tile ? 'Viser à nouveau' : 'Viser', () => aim('tile')]],
    [!!p.exportButton, p.exportButton ? 'Bouton « Exporter » visé' : 'Bouton « Exporter » : ELPO appuie sur Entrée (viser est plus sûr)', [p.exportButton ? 'Viser à nouveau' : 'Viser', () => aim('exportButton')]],
    [true, p.missing === 'continue' ? 'Médias manquants : export malgré la fenêtre « Relier »' : 'Projets aux médias manquants laissés de côté', null]];
  $('pilotState').replaceChildren(...items.map(([okay, text, action]) => {
    const d = el('div'); d.append(el('span', undefined, `dot ${okay ? 'ok' : 'warn'}`), el('span', text));
    if (action) { const b = el('button', action[0], 'btn ghost small'); b.onclick = action[1]; d.append(b); }
    return d;
  }));
}
document.querySelectorAll('#batchEngine button').forEach(b => b.onclick = () => { batchEngine = b.dataset.engine; renderBatch(); });
for (const id of ['batchBuild', 'batchExport', 'batchVoice']) $(id).addEventListener('change', renderBatch);
$('chooseOutput').onclick = () => task(async () => { const dir = await unwrap(api.chooseDir({ purpose: 'output' })); if (dir) { $('outputDir').dataset.path = dir; $('outputDir').textContent = dir; await saveExportSettings(); } });
for (const id of ['exResolution', 'exFps', 'exQuality', 'exCodec', 'exParallel', 'exPattern', 'exHardware', 'exSubtitles']) $(id).addEventListener('change', () => saveExportSettings().catch(showError));
function batchRules() {
  return { voice: { mode: $('batchVoice').value, pattern: $('batchVoicePattern').value }, music: $('batchMusicPattern').value.trim() ? { mode: 'name', pattern: $('batchMusicPattern').value.trim() } : null };
}
async function batchBuild(list) {
  const candidates = list.filter(p => p.readable && !p.nonempty);
  if (!candidates.length) { notice('Aucune timeline vide à monter dans la sélection.'); return true; }
  const style = styles[$('batchStyle').value] || preferences || {};
  const results = await engine('batchPreview', { projects: candidates.map(p => p.path), options: { ...style, placement: $('batchPlacement').value, videoPolicy: $('batchVideoPolicy').value === 'repeat' ? 'repeat' : 'reject' }, rules: batchRules() });
  const ready = results.filter(r => r.ok);
  const rows = results.map(r => {
    const row = el('div', undefined, 'modal-row'), info = el('div');
    row.append(icon(r.ok ? 'check' : 'x')); info.append(el('strong', r.name));
    info.append(el('p', r.ok ? `${plural(r.scenes, 'scène')}, ${plural(r.clips, 'clip')}, ${time(r.durationUs)} · voix : ${r.audio}${r.music ? ` · musique : ${r.music}` : ''}` : r.error.message));
    if (r.ok) { const ul = el('ul'); for (const w of r.warnings.slice(0, 4)) ul.append(el('li', w)); info.append(ul); }
    row.append(info); return row;
  });
  if (!ready.length) { await ask('Aucun projet ne peut être monté', rows, 'Fermer', null); return false; }
  if (running !== 'closed') rows.unshift(el('p', 'CapCut doit être fermé pour écrire les timelines. Quitte CapCut avant de continuer.', 'alert'));
  if (!(await ask(`Monter ${plural(ready.length, 'timeline')} ?`, rows, `Générer ${ready.length}`))) return false;
  await poll();
  const written = await engine('batchCommit', { tokens: ready.map(r => r.token) });
  const okCount = written.filter(r => r.ok).length, failed = written.filter(r => !r.ok);
  notice(`${plural(okCount, 'timeline')} montée(s)${failed.length ? `, ${failed.length} en échec : ${failed[0].error.message}` : '.'}`, !!failed.length);
  await loadProjects();
  return okCount > 0 || !failed.length;
}
$('batchStart').onclick = () => task(async () => {
  let list = selectedProjects();
  if (!list.length) throw new Error('Coche au moins un projet.');
  if ($('batchBuild').checked && !(await batchBuild(list))) return;
  if (!$('batchExport').checked) return;
  list = selectedProjects().filter(p => batchEngine === 'elpo' ? p.readable && p.nonempty : !p.readable || p.nonempty);
  const skipped = selected.size - list.length;
  if (skipped) notice(`${plural(skipped, 'projet')} sans timeline exportable ignoré(s).`);
  const started = batchEngine === 'auto' ? await startAutoExport(list) : await startExport(list, batchEngine);
  if (started) showRoom();
});
$('batchTest').onclick = () => task(async () => { const list = selectedProjects(); await startExport(list.slice(0, 1), 'capcut', true); });
// Remaining time of one ELPO job from its own pace; null when it cannot be estimated yet.
function jobLeft(j, now = Date.now()) {
  if (j.engine !== 'elpo' || !j.started || !(j.progress > 0.02)) return null;
  return (now - j.started) * (1 - j.progress) / j.progress;
}
const minutes = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${Math.floor(ms / 3600000)} h ${String(Math.round(ms / 60000) % 60).padStart(2, '0')}`;
function jobRow(j) {
  const card = projects.find(p => p.path === j.project);
  const row = el('div', undefined, `job ${j.status}`), main = el('div', undefined, 'job-main'), top = el('div', undefined, 'job-top'), bar = el('div', undefined, `bar ${j.status}`), fill = el('i');
  fill.style.width = `${Math.round((j.progress || 0) * 100)}%`; bar.append(fill);
  top.append(el('strong', j.name), el('span', `${j.engine === 'capcut' ? 'CapCut' : 'ELPO'} · ${j.stage}${j.size ? ' · ' + j.size : ''}`), el('span', j.status === 'done' ? 'Terminé' : `${Math.round((j.progress || 0) * 100)} %`, 'pct'));
  main.append(top, bar);
  if (j.error) main.append(el('span', j.error, 'err'));
  const actions = el('div', undefined, 'job-actions');
  if (j.status === 'done' && j.output) {
    const show = el('button', 'Afficher', 'link'); show.onclick = () => task(() => unwrap(api.reveal({ file: j.output })));
    const play = el('button', 'Lire', 'link'); play.onclick = () => task(() => unwrap(api.reveal({ file: j.output, open: true })));
    actions.append(play, show);
  } else if (j.status === 'failed') {
    const again = el('button', 'Relancer', 'link'); again.onclick = () => task(() => startExport([{ path: j.project, name: j.name }], j.engine));
    actions.append(again);
  } else if (j.engine === 'elpo' && j.status === 'queued') { const c = el('button', 'Annuler', 'link'); c.onclick = () => task(() => unwrap(api.exportCancel(j.id))); actions.append(c); }
  row.append(coverNode(card || j, 'mini'), main, actions);
  return row;
}
function liveCard(j) {
  const card = projects.find(p => p.path === j.project), box = el('article', undefined, 'live-card'), frame = el('div', undefined, 'frame'), moving = el('div');
  moving.append(card?.coverUrl ? Object.assign(el('img'), { alt: '', src: card.coverUrl }) : el('span', (j.name || '?').charAt(0).toUpperCase(), 'monogram'));
  frame.append(moving, el('span', j.stage, 'chip-on'), el('span', j.engine === 'capcut' ? 'Via CapCut' : 'ELPO', 'engine'));
  const body = el('div', undefined, 'body'), bar = el('div', undefined, 'bar'), fill = el('i', undefined, 'live'), meta = el('div', undefined, 'meta'), left = jobLeft(j);
  fill.style.width = `${Math.round((j.progress || 0) * 100)}%`; bar.append(fill);
  meta.append(el('span', left ? `encore ${minutes(left)}` : j.engine === 'capcut' ? 'CapCut exporte' : 'Calcul du temps…'), el('span', `${Math.round((j.progress || 0) * 100)} %`, 'pct'));
  const actions = el('div', undefined, 'job-actions');
  if (j.engine === 'elpo') { const c = el('button', 'Annuler', 'link'); c.onclick = () => task(() => unwrap(api.exportCancel(j.id))); actions.append(c); }
  body.append(el('strong', j.name), bar, meta, actions); box.append(frame, body);
  return box;
}
function renderQueue() {
  const jobs = [...pilotJobs.map(j => ({ ...j, engine: 'capcut' })), ...exportJobs.map(j => ({ ...j, engine: 'elpo' }))];
  const live = jobs.filter(j => ['preparing', 'rendering', 'running'].includes(j.status)), queued = jobs.filter(j => j.status === 'queued');
  const done = jobs.filter(j => j.status === 'done'), failed = jobs.filter(j => j.status === 'failed'), cancelled = jobs.filter(j => j.status === 'cancelled');
  const active = live.length + queued.length;
  $('queueSummary').textContent = jobs.length ? `${done.length} terminée(s) · ${active} en cours ou en attente${failed.length ? ` · ${failed.length} à revoir` : ''}` : 'Vide';
  $('queueStop').hidden = !active;
  $('queueList').replaceChildren();
  const group = (title, nodes) => { if (!nodes.length) return; const g = el('section', undefined, 'queue-group'), h = el('h4', title); h.append(el('span', String(nodes.length))); g.append(h, ...nodes); $('queueList').append(g); };
  if (live.length) { const cards = el('div', undefined, 'live-cards'); cards.append(...live.map(liveCard)); const g = el('section', undefined, 'queue-group'), h = el('h4', 'En cours'); h.append(el('span', String(live.length))); g.append(h, cards); $('queueList').append(g); }
  group('En attente', queued.map(jobRow)); group('À revoir', failed.map(jobRow)); group('Terminées', done.map(jobRow)); group('Annulées', cancelled.map(jobRow));
  if (!jobs.length) $('queueList').append(el('p', 'Les exports apparaîtront ici avec leur progression.', 'hint'));
  // Strip: one segment per video of the batch.
  $('roomStrip').replaceChildren(...jobs.filter(j => j.status !== 'cancelled').slice(0, 200).map(j => {
    const i = el('i', undefined, j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : j.status === 'queued' ? '' : 'live');
    i.style.setProperty('--p', String(Math.round((j.progress || 0) * 100))); return i;
  }));
  // Estimated end: running jobs at their own pace, queued ELPO jobs at the average pace, shared by the parallel exports.
  const now = Date.now(), finished = done.filter(j => j.engine === 'elpo' && j.started && j.finished);
  const lefts = live.map(j => jobLeft(j, now)).filter(x => x !== null);
  const avg = finished.length ? finished.reduce((n, j) => n + (j.finished - j.started), 0) / finished.length : live.filter(j => jobLeft(j, now) !== null).map(j => (now - j.started) / j.progress)[0];
  const waiting = queued.filter(j => j.engine === 'elpo').length, parallel = Math.max(1, Number($('exParallel').value) || 1);
  const left = active && (lefts.length || (waiting && avg)) ? (lefts.reduce((a, b) => Math.max(a, b), 0) + (waiting && avg ? waiting * avg / parallel : 0)) : null;
  $('roomEnd').textContent = left ? new Date(now + left).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
  $('roomLeft').textContent = left ? minutes(left) : active ? 'calcul…' : '—';
  $('roomDone').textContent = String(done.length);
  $('roomCount').textContent = active ? `(${active})` : '';
  $('navJobs').textContent = active ? String(active) : '';
  const total = jobs.filter(j => j.status !== 'cancelled'), pct = total.length ? total.reduce((n, j) => n + (j.progress || 0), 0) / total.length : 0;
  $('queueMini').hidden = !active; $('queueMiniText').textContent = `${plural(active, 'export')} en cours`; $('queueMiniPct').textContent = `${Math.round(pct * 100)} %`;
  $('queueMini').style.setProperty('--p', String(Math.round(pct * 100)));
  const mine = project && jobs.find(j => j.project === project.path);
  $('singleJob').hidden = !mine;
  if (mine) $('singleJob').replaceChildren(el('span', `${mine.stage} · ${Math.round((mine.progress || 0) * 100)} %`, 'subtle'));
  renderOutput();
}
function renderOutput() {
  const s = exportSettings(), rows = [['Dossier ELPO', s.outputDir || 'Non choisi'], ['Format', `${s.resolution === 'project' ? 'Résolution du projet' : s.resolution + 'p'} · ${s.codec === 'hevc' ? 'HEVC' : 'H.264'} · ${s.hardware ? 'VideoToolbox' : 'logiciel'}`], ['Nom', s.pattern], ['Exports CapCut', pilotSettings.exportDir || 'Non choisi']];
  $('roomOutput').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
}
$('queueMini').onclick = showRoom;
$('pilotResume').onclick = () => task(async () => { await unwrap(api.pilotResume()); });
$('pilotAbort').onclick = () => task(async () => { await unwrap(api.pilotStop()); });
$('queueStop').onclick = () => task(async () => { if (!(await ask('Arrêter toute la production ?', 'Les exports en cours sont interrompus, aucun fichier incomplet n’est conservé.', 'Tout arrêter'))) return; await unwrap(api.exportCancel(null)); await unwrap(api.pilotStop()); });
$('queueClear').onclick = () => task(async () => { exportJobs = await unwrap(api.exportClear()); pilotJobs = pilotJobs.filter(j => ['queued', 'running'].includes(j.status)); renderQueue(); });

// Library-wide selection bar.
$('selectionClear').onclick = () => { selected.clear(); renderGrid(); renderBatch(); };
$('selectionBuild').onclick = () => { $('batchBuild').checked = true; $('batchExport').checked = false; go('batch'); };
$('selectionExport').onclick = () => { $('batchBuild').checked = false; $('batchExport').checked = true; go('batch'); };

// ── Bibliothèque (effects, transitions, filters) ───────────────────────────────────
const KIND_LABEL = { transitions: 'transition', effects: 'effet', filters: 'filtre' };
function renderFx() {
  for (const [kind, id] of [['transitions', 'fxCountTransitions'], ['effects', 'fxCountEffects'], ['filters', 'fxCountFilters']]) $(id).textContent = String((library[kind] || []).length);
  const all = library[fxKind] || [], favs = all.filter(t => isFavorite(fxKind, t));
  const show = fxShow || (favs.some(t => t.available) ? 'favorites' : 'available');
  document.querySelectorAll('#fxKind button').forEach(b => b.classList.toggle('on', b.dataset.kind === fxKind));
  document.querySelectorAll('#fxShow button').forEach(b => b.classList.toggle('on', b.dataset.show === show));
  const q = $('fxSearch').value.trim().toLocaleLowerCase('fr');
  const list = all.filter(t => (show === 'all' || (show === 'favorites' ? isFavorite(fxKind, t) : t.available)) && (!q || `${t.name} ${t.category}`.toLocaleLowerCase('fr').includes(q)))
    .sort((a, b) => isFavorite(fxKind, b) - isFavorite(fxKind, a) || b.available - a.available || a.name.localeCompare(b.name, 'fr'));
  $('fxGrid').replaceChildren();
  list.forEach((t, i) => {
    const card = el('div', undefined, `fx${t.available ? '' : ' unavailable'}`), sw = el('span', t.name.charAt(0).toUpperCase(), 'fx-swatch'), info = el('div');
    sw.style.setProperty('--c', HUES[(t.name.length + i) % HUES.length]);
    info.append(el('strong', t.name), el('span', [t.category, t.favorite ? 'Favori CapCut' : null, t.available ? (t.track && !t.clip ? 'Sur toute la vidéo' : t.clip && t.track ? 'Clip ou vidéo entière' : null) : 'Ressource absente'].filter(Boolean).join(' · ') || KIND_LABEL[fxKind]));
    info.title = t.available ? `Vu dans : ${(t.sources || []).join(', ')}` : t.reason;
    const star = el('button', undefined, `star${isFavorite(fxKind, t) ? ' on' : ''}`); star.append(icon('star'));
    star.setAttribute('aria-pressed', String(isFavorite(fxKind, t))); star.setAttribute('aria-label', `Favori : ${t.name}`);
    if (t.favorite) star.title = 'Favori importé du projet « ELPO Favoris » : retire-le dans ce projet CapCut';
    star.onclick = () => t.favorite ? notice('Ce favori vient du projet « ELPO Favoris » : retire-le de ce projet dans CapCut pour l’enlever.') : task(async () => { favorites = await unwrap(api.favorite({ kind: fxKind, id: t.id, on: !(favorites[fxKind] || []).includes(t.id) })); renderFx(); for (const k of Object.keys(FX)) renderChips(k); });
    card.append(sw, info, star); $('fxGrid').append(card);
  });
  if (!list.length) $('fxGrid').append(el('p', show === 'favorites' ? `Aucun favori parmi les ${KIND_LABEL[fxKind]}s. Ajoute-en avec l’étoile, ou via le projet « ELPO Favoris ».` : `Aucun ${KIND_LABEL[fxKind]} trouvé dans tes projets. Utilise-en dans CapCut, ferme le projet, puis actualise.`, 'hint'));
}
document.querySelectorAll('#fxKind button').forEach(b => b.onclick = () => { fxKind = b.dataset.kind; fxShow = null; renderFx(); });
document.querySelectorAll('#fxShow button').forEach(b => b.onclick = () => { fxShow = b.dataset.show; renderFx(); });
$('fxSearch').oninput = renderFx;
$('fxRefresh').onclick = () => task(loadCatalog);

// ── Vault ───────────────────────────────────────────────────────────────────
async function backups() {
  const list = await engine('backups'); $('backupList').replaceChildren();
  const label = { committed: 'Montage généré', restored: 'Restaurée', 'rolled-back': 'Annulée après erreur', pending: 'Récupération requise', 'recovery-required': 'Récupération requise', 'restore-pending': 'Restauration à reprendre', preparing: 'Préparation interrompue' };
  for (const b of list) {
    const row = el('div', undefined, 'row'), info = el('div');
    info.append(el('strong', b.name || b.project.split(/[\\/]/).pop()), el('span', `${new Date(b.created).toLocaleString('fr-FR')} · ${label[b.status] || b.status}`)); row.append(info);
    if (['committed', 'pending', 'recovery-required', 'restore-pending'].includes(b.status)) {
      const btn = el('button', 'Restaurer', 'btn ghost');
      btn.onclick = async () => { if (await ask('Restaurer les fichiers de ce projet ?', 'CapCut doit être fermé. Les changements faits ensuite dans CapCut sont protégés par un contrôle de conflit.', 'Restaurer')) task(async () => { await engine('restore', { id: b.id }); invalidate(); notice('Les fichiers d’origine ont été restaurés.'); await backups(); loadProjects().catch(() => {}); }); };
      row.append(btn);
    }
    $('backupList').append(row);
  }
  if (!list.length) $('backupList').append(el('p', 'Aucune génération sauvegardée pour ce dossier de projets.', 'hint'));
  $('historyList').replaceChildren();
  for (const h of (status.history || []).slice(0, 30)) {
    const row = el('div', undefined, 'row'), info = el('div');
    info.append(el('strong', h.name), el('span', `${new Date(h.at).toLocaleString('fr-FR')} · ${h.engine === 'capcut' ? 'via CapCut' : 'export ELPO'}`));
    const show = el('button', 'Afficher', 'link'); show.onclick = () => task(() => unwrap(api.reveal({ file: h.output })));
    row.append(info, show); $('historyList').append(row);
  }
  if (!(status.history || []).length) $('historyList').append(el('p', 'Aucune vidéo exportée pour l’instant.', 'hint'));
}
$('refreshBackups').onclick = () => task(backups);
$('recover').onclick = () => task(async () => { await engine('recover'); await backups(); notice('Verrou vérifié. Restaure l’opération signalée si une récupération est requise.'); });
$('openBackups').onclick = () => task(async () => unwrap(api.openBackups()));
$('openCapcut').onclick = () => task(async () => { await unwrap(api.openCapcut()); running = 'open'; $('status').textContent = 'Ouverture de CapCut…'; $('status').className = 'pill red'; });

// ── Settings ───────────────────────────────────────────────────────────────────
function renderFfmpeg() {
  $('ffmpegLine').textContent = ffmpeg ? `FFmpeg ${ffmpeg.version}` : 'FFmpeg absent';
  $('ffmpegDot').className = `dot ${ffmpeg ? 'ok' : 'warn'}`;
  $('ffmpegInfo').textContent = ffmpeg ? `FFmpeg ${ffmpeg.version} trouvé : ${ffmpeg.ffmpeg}. Accélération Apple ${ffmpeg.encoders?.h264_videotoolbox ? 'disponible' : 'indisponible'}, incrustation de sous-titres ${ffmpeg.filters?.subtitles ? 'disponible' : 'indisponible'}.` : 'FFmpeg est introuvable : l’export ELPO est désactivé. L’export via CapCut reste possible.';
}
function renderSettings() {
  renderFfmpeg(); renderStyles();
  const p = pilotSettings;
  $('tilePoint').textContent = p.tile ? `x ${p.tile.x}, y ${p.tile.y}` : 'Pas encore visée';
  $('exportPoint').textContent = p.exportButton ? `x ${p.exportButton.x}, y ${p.exportButton.y}` : 'Touche Entrée utilisée';
  $('capcutExportDir').textContent = p.exportDir || 'Non choisi';
  for (const [id, key] of [['pOpenWith', 'openWith'], ['pLaunch', 'launchSeconds'], ['pOpen', 'openSeconds'], ['pDialog', 'dialogSeconds'], ['pStable', 'stableSeconds'], ['pTimeout', 'timeoutMinutes'], ['pMissing', 'missing']]) if (p[key] !== undefined) $(id).value = p[key];
  if (Array.isArray(p.closeKeys)) $('pClose').value = p.closeKeys.join(',');
}
$('ffmpegDetect').onclick = () => task(async () => { ffmpeg = await unwrap(api.ffmpeg({})); renderFfmpeg(); notice(ffmpeg ? 'FFmpeg trouvé.' : 'FFmpeg toujours introuvable.', !ffmpeg); });
$('ffmpegChoose').onclick = () => task(async () => { ffmpeg = await unwrap(api.ffmpeg({ choose: true })); renderFfmpeg(); });
async function savePilot(extra = {}) {
  pilotSettings = await unwrap(api.pilotSettings({ ...pilotSettings, openWith: $('pOpenWith').value, launchSeconds: $('pLaunch').value, openSeconds: $('pOpen').value, dialogSeconds: $('pDialog').value, stableSeconds: $('pStable').value, timeoutMinutes: $('pTimeout').value, missing: $('pMissing').value, closeKeys: $('pClose').value ? $('pClose').value.split(',') : [], ...extra }));
  renderSettings(); renderPilotState();
}
$('pilotSave').onclick = () => task(async () => { await savePilot(); notice('Réglages du pilotage enregistrés.'); });
$('clearExportPoint').onclick = () => task(() => savePilot({ exportButton: null }));
$('chooseCapcutDir').onclick = () => task(async () => { const dir = await unwrap(api.chooseDir({ purpose: 'capcut' })); if (dir) await savePilot({ exportDir: dir }); });
$('pilotAccess').onclick = () => task(async () => { const okay = await unwrap(api.pilotAccess()); pilotAccessOk = okay; renderPilotState(); $('accessState').textContent = okay ? 'Accessibilité autorisée' : 'Accessibilité à autoriser'; $('accessState').className = `pill ${okay ? 'green' : 'red'}`; if (!okay) notice('Coche ElpoAiAutoCapcut dans Réglages Système → Confidentialité et sécurité → Accessibilité, puis réessaie.'); });
$('pilotDiagnostic').onclick = () => task(async () => {
  $('pilotDiagnosticState').textContent = 'Lecture de CapCut en cours…';
  try {
    const result = await unwrap(api.pilotDiagnostic());
    $('pilotDiagnosticState').textContent = result ? `Diagnostic enregistré : ${result.file}` : 'Enregistrement annulé.';
  } catch (error) {
    $('pilotDiagnosticState').textContent = 'Diagnostic interrompu.';
    throw error;
  }
});
// A full-screen sight opens over CapCut: one click records the point, Escape cancels.
function aim(target) {
  return task(async () => {
    const next = await unwrap(api.pilotCalibrate(target));
    if (next) { pilotSettings = next; notice('Position enregistrée.'); } else notice('Visée annulée : position inchangée.');
    renderSettings(); renderPilotState();
  });
}
document.querySelectorAll('[data-calibrate]').forEach(b => b.onclick = () => aim(b.dataset.calibrate));

// ── Command palette & keyboard ────────────────────────────────────────────────────
function commands() {
  const list = [
    ['Aller à Projets', '⌘1', () => go('library')], ['Plateau (montage complet)', '⌘2', () => go('build')], ['Production en lot', '⌘3', () => go('batch')],
    ['Bibliothèque : transitions, effets, filtres', '⌘4', () => go('fx')], ['Coffre : sauvegardes', '⌘5', () => go('vault')], ['Réglages', '⌘,', () => go('settings')],
    ['Plateau : scènes', '', () => step('scenes')], ['Plateau : style', '', () => step('style')], ['Plateau : vérifier', '', () => step('review')], ['Plateau : écrire et exporter', '', () => step('deliver')], ['Salle de rendu', '', showRoom],
    ['Analyser et vérifier', '⌘↩', () => !$('analyze').disabled && $('analyze').onclick()], ['Charger un SRT', '', () => $('loadSrt').onclick()],
    ['Proposer les scènes depuis le SRT', '', () => $('groupSrt').onclick()], ['Partir des médias', '', () => $('createEven').onclick()],
    ['Tout cocher dans Projets', '⌘A', () => { projects.forEach(p => selected.add(p.path)); renderGrid(); renderBatch(); }],
    ['Production en lot : monter les projets cochés', '', () => { $('batchBuild').checked = true; $('batchExport').checked = false; go('batch'); }],
    ['Production en lot : exporter les projets cochés', '', () => { $('batchBuild').checked = false; $('batchExport').checked = true; go('batch'); }],
    ['Exporter le projet actif', '', () => { step('deliver'); if (!$('exportOne').disabled) $('exportOne').onclick(); }],
    ['Générer dans CapCut', '', () => step('deliver')], ['Bibliothèque : mes favoris', '', () => { fxShow = 'favorites'; go('fx'); }],
    ['Viser les cibles du pilotage CapCut', '', () => go('settings')], ['Vidéos exportées', '', () => go('vault')], ['Ouvrir CapCut', '⇧⌘O', () => $('openCapcut').onclick()], ['Changer le dossier des projets', '', () => $('chooseRoot').onclick()],
    ['Actualiser les projets', '', () => $('refresh').onclick()], ['Actualiser la bibliothèque', '', () => $('fxRefresh').onclick()],
  ];
  for (const p of projects.slice(0, 200)) list.push([`Ouvrir « ${p.name} »`, 'Projet', () => openProject(p.path)]);
  return list;
}
let paletteIndex = 0, paletteItems = [];
function openPalette() { $('palette').hidden = false; $('paletteInput').value = ''; renderPalette(); setTimeout(() => $('paletteInput').focus?.(), 20); }
function closePalette() { $('palette').hidden = true; }
function renderPalette() {
  const q = fold($('paletteInput').value.trim());
  paletteItems = commands().filter(([label]) => !q || q.split(/\s+/).every(w => fold(label).includes(w))).slice(0, 40);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  $('paletteList').replaceChildren(...paletteItems.map(([label, hint, run], i) => { const li = el('li', label, i === paletteIndex ? 'on' : ''); if (hint) li.append(el('span', hint)); li.onclick = () => { closePalette(); run(); }; return li; }));
}
$('paletteInput').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
$('paletteInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') { const item = paletteItems[paletteIndex]; closePalette(); item?.[2](); }
  else if (e.key === 'Escape') closePalette();
});
$('palette').onclick = e => { if (e.target === $('palette')) closePalette(); };
$('paletteButton').onclick = openPalette;
function command(name) {
  ({ library: () => go('library'), build: () => go('build'), batch: () => go('batch'), 'batch-room': showRoom, 'library-fx': () => go('fx'), vault: () => go('vault'), settings: () => go('settings'), palette: openPalette, 'open-capcut': () => $('openCapcut').onclick() })[name]?.();
}
document.addEventListener?.('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '');
  if (e.key === 'Escape') { if (!$('palette').hidden) closePalette(); else if (!$('modal').hidden) $('modalCancel').onclick?.(); return; }
  if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('palette').hidden ? openPalette() : closePalette(); return; }
  if (e.metaKey && e.key === 'Enter' && currentPage === 'build') { e.preventDefault(); if (!$('analyze').disabled) $('analyze').onclick(); return; }
  if (e.metaKey && !typing && e.key.toLowerCase() === 'a' && currentPage === 'library') { e.preventDefault(); const all = projects.every(p => selected.has(p.path)); projects.forEach(p => all ? selected.delete(p.path) : selected.add(p.path)); renderGrid(); renderBatch(); return; }
  if (e.metaKey && /^[1-5]$/.test(e.key) && !window.elpoMenu) { e.preventDefault(); go(['library', 'build', 'batch', 'fx', 'vault'][Number(e.key) - 1]); return; }
  if (e.key === ' ' && !typing && currentPage === 'build' && currentStep === 'review') { e.preventDefault(); togglePlay(); }
});
window.addEventListener?.('resize', () => drawWave());

// Drag and drop: a folder becomes the image source of the active project, a .srt or .json is loaded in the scenes.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener?.('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropZone').hidden = false; });
document.addEventListener?.('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener?.('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropZone').hidden = true; });
document.addEventListener?.('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropZone').hidden = true;
  const paths = [...(e.dataTransfer.files || [])].map(f => api.pathForFile?.(f)).filter(Boolean);
  if (paths.length) task(() => handleDrop(paths));
});
async function handleDrop(paths) {
  for (const file of paths.slice(0, 3)) {
    const r = await unwrap(api.dropped(file));
    if (r.kind === 'folder') {
      if (!project) throw new Error('Ouvre d’abord un projet dans le Plateau, puis dépose le dossier d’images.');
      if (!(await confirmVisualChange())) return;
      await unwrap(api.useFlowFolder({ project: project.path, folder: r.path })); await selectProject(); go('build');
      notice(`Dossier « ${r.name} » : ${plural(project.visuals.length, 'image')}, source du projet.`);
    } else if (r.kind === 'srt') {
      srtFile = r; $('srtName').textContent = r.name; $('clearSrt').hidden = false; invalidate(); placementHint(); go('build'); step('scenes'); notice(`SRT chargé : ${r.name}.`);
    } else {
      syncPlan = parseScenes(r.text); scenesFile = r; setPlacement('sync'); renderSync(); $('scenesName').textContent = r.name; $('clearScenes').hidden = false; invalidate(); go('build'); step('scenes'); notice(`Plan chargé : ${r.name}.`);
    }
  }
}

function showRoot(r) { const parts = String(r || '').split('/').filter(Boolean); $('root').textContent = r ? (parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : r) : 'Dossier à sélectionner'; $('root').title = r || ''; }
// ── Wiring ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => go(b.dataset.page));
document.querySelectorAll('[data-page-link]').forEach(b => b.onclick = () => go(b.dataset.pageLink));
document.querySelectorAll('#stepper button').forEach(b => b.onclick = () => step(b.dataset.step));
document.querySelectorAll('[data-run]').forEach(b => b.onclick = () => $(b.dataset.run).onclick());
document.querySelectorAll('#libraryFilter button').forEach(b => b.onclick = () => { libraryFilter = b.dataset.filter; document.querySelectorAll('#libraryFilter button').forEach(x => x.classList.toggle('on', x === b)); renderGrid(); });
$('librarySearch').oninput = renderGrid;
$('stepBack').onclick = () => step(STEPS[Math.max(0, STEPS.indexOf(currentStep) - 1)]);
$('stepNext').onclick = () => step(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(currentStep) + 1)]);
$('chooseRoot').onclick = () => task(async () => { const r = await unwrap(api.chooseRoot()); if (r) { showRoot(r); project = null; selected.clear(); invalidate(); await refresh(); await loadCatalog(); } });
$('refresh').onclick = () => task(refresh);
$('projectSelect').onchange = () => task(selectProject);
$('toSettings').onclick = () => step('scenes');

api.on?.(({ type, data }) => {
  if (type === 'export') { exportJobs = data; renderQueue(); }
  else if (type === 'pilot') { pilotJobs = data; renderQueue(); }
  else if (type === 'pilotLog') { $('pilotLogBox').hidden = false; const li = el('li', `${new Date(data.at).toLocaleTimeString('fr-FR')} ${data.project ? data.project + ' : ' : ''}${data.text}`); $('pilotLog').append(li); li.scrollIntoView?.({ block: 'nearest' }); }
  else if (type === 'pilotError') showError(data);
  else if (type === 'pilotPaused') { pilotPaused = !!data.paused; $('pilotPanel').hidden = !pilotPaused; if (pilotPaused) { $('pilotPauseText').textContent = data.reason || 'Le pilotage attend avant sa prochaine action.'; showRoom(); } }
  else if (type === 'command') command(data);
});

async function start() {
  status = await unwrap(api.status());
  if (status.platform === 'darwin') { document.body.classList.add('vibrant'); window.elpoMenu = true; }
  showRoot(status.root); preferences = status.preferences || {}; styles = status.styles || {};
  favorites = { transitions: [], effects: [], filters: [], ...(status.favorites || {}) }; pilotSettings = status.pilot || {}; ffmpeg = status.ffmpeg || null;
  if (typeof status.access === 'boolean') pilotAccessOk = status.access;
  if (status.version) $('version').textContent = `v${status.version}`;
  applyStyle(preferences); applyExportSettings(status.exportSettings || {}); renderStyles(); renderFfmpeg(); renderMotions(); placementHint();
  if (status.initialized) { await refresh(); await loadCatalog(); }
  else notice('Bienvenue. Choisis le dossier qui contient tes projets CapCut pour commencer.');
  try { const jobs = await unwrap(api.jobs()); exportJobs = jobs.export; pilotJobs = jobs.pilot; renderQueue(); } catch { /* no running jobs */ }
  document.body.classList.remove('booting');
}
go('library'); step('scenes'); setBatchView('setup'); go('library');
task(start).then(poll);
setInterval(poll, 10000);
