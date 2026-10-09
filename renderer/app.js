import { parseSrt, parseScenes, planScenes } from '../lib/planner.js';
import { groupCues, boundary, merge, split, clipAt } from '../lib/sync.js';
const $ = id => document.getElementById(id);
const api = window.elpo;
let project = null, report = null, currentStep = 'project', running = 'unknown', working = false, page = 0;
let scenesFile = null, srtFile = null, transitions = [], transitionIds = new Set(), preferences = {};
let syncPlan = null, syncPage = 0, mediaUrls = {}, playback = null, activeClip = null, raf = 0, playGeneration = 0;
const pageSize = 12;
const labels = { project: 'PROJET & MÉDIAS', settings: 'MISE EN SCÈNE', preview: 'APERÇU & MONTAGE', backups: 'SAUVEGARDES' };
const time = t => { const ms = Math.round(t / 1000); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
async function unwrap(promise) { const r = await promise; if (!r?.ok) { const e = new Error(r?.error?.message || 'Opération impossible.'); e.code = r?.error?.code; e.details = r?.error?.details; throw e; } return r.result; }
const engine = (action, args) => unwrap(api.engine(action, args));
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = `notice${error ? ' error' : ''}`; $('notice').hidden = false; }
function showError(e) { notice(`${e.message}${e.details?.length ? ' ' + e.details.slice(0, 8).join(', ') : ''}`, true); }
function step(name) { if (name !== 'preview') $('voicePlayer').pause(); currentStep = name; Object.keys(labels).forEach(n => $(n).hidden = n !== name); document.querySelectorAll('.nav[data-step]').forEach(b => b.classList.toggle('active', b.dataset.step === name)); $('crumb').textContent = labels[name]; }
function invalidate() { stopPlayback(); report = null; $('confirm').checked = false; $('previewContent').hidden = true; $('previewEmpty').hidden = false; $('exportScenes').disabled = true; buttons(); }
function buttons() {
  $('chooseFlowFolder').disabled = !project || working;
  $('clearFlowFolder').disabled = !project || working;
  $('toSettings').disabled = !project || project.nonempty || working;
  $('analyze').disabled = !project || project.nonempty || working;
  $('build').disabled = !report || !$('confirm').checked || running !== 'closed' || working;
  $('buildHint').textContent = running === 'open' ? 'Quittez CapCut pour autoriser la génération.' : running === 'unknown' ? 'La fermeture de CapCut doit être vérifiée.' : report ? 'Une sauvegarde précédera l’écriture des fichiers.' : 'L’écriture devient disponible après analyse et vérification.';
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
  $('status').textContent = running === 'closed' ? 'CapCut fermé · écriture possible' : running === 'open' ? 'CapCut ouvert · aperçu disponible' : 'Statut CapCut non vérifiable';
  $('status').className = `badge${running === 'closed' ? ' green' : running === 'open' ? ' red' : ''}`; buttons();
}
async function refresh() {
  const old = $('projectSelect').value;
  const list = await engine('list');
  $('projectSelect').replaceChildren(el('option', 'Sélectionnez un projet'));
  $('projectSelect').firstChild.value = '';
  for (const p of list) { const o = el('option', p.name); o.value = p.path; $('projectSelect').append(o); }
  if (list.some(p => p.path === old)) { $('projectSelect').value = old; await selectProject(); }
  else { project = null; invalidate(); $('flowFolder').textContent = 'Aucun dossier Flow choisi : les visuels du chutier seront utilisés.'; $('clearFlowFolder').hidden = true; $('mediaList').replaceChildren(el('p', 'Sélectionnez un projet.')); $('projectInfo').textContent = 'Les informations du projet apparaîtront ici.'; }
  if (!list.length) notice('Aucun projet reconnu dans ce dossier. Créez un projet dans CapCut et importez vos médias.');
}
async function selectProject() {
  $('flowFolder').textContent = 'Aucun dossier Flow choisi : les visuels du chutier seront utilisés.'; $('clearFlowFolder').hidden = true;
  invalidate(); syncPlan = null; syncPage = 0; scenesFile = null; srtFile = null; mediaUrls = {}; $('clearSrt').hidden = true; $('srtName').textContent = 'Chargez le SRT correspondant à la voix off de ce projet.'; $('clearScenes').hidden = true; $('scenesName').textContent = 'Chargez un plan existant pour reprendre vos corrections.'; project = null; renderSync();
  const path = $('projectSelect').value; if (!path) { buttons(); return; }
  const p = await engine('inspect', { project: path }); project = p;
  $('flowFolder').textContent = p.visualFolder || 'Aucun dossier Flow choisi : les visuels du chutier seront utilisés.';
  $('clearFlowFolder').hidden = !p.visualFolder;
  $('projectInfo').textContent = `${p.canvas?.width || '?'} × ${p.canvas?.height || '?'} · ${p.fps || '?'} images/s · ${p.nonempty ? 'Timeline déjà remplie — génération bloquée' : 'Timeline vide'}`;
  $('projectHint').textContent = p.nonempty ? 'Sélectionnez une copie dont la timeline est vide.' : 'Projet prêt pour les réglages.';
  $('mediaCount').textContent = `${p.visuals.length} visuels · ${p.audios.length} audios`;
  $('mediaList').classList.remove('empty'); $('mediaList').replaceChildren();
  for (const m of [...p.audios, ...p.visuals].slice(0, 150)) {
    const row = el('div', undefined, 'media-row'); row.append(el('span', m.type === 'audio' ? '♫' : m.type === 'video' ? '▶' : '▧', 'media-icon'), el('span', m.name, 'name'), el('span', m.durationUs ? `${(m.durationUs / 1e6).toFixed(1)} s` : 'Image', 'subtle')); $('mediaList').append(row);
  }
  if (p.visuals.length + p.audios.length > 150) $('mediaList').append(el('p', 'Liste abrégée à 150 médias. Tous seront pris en compte dans l’analyse.', 'hint'));
  $('audio').replaceChildren(el('option', 'Choisissez la voix off')); $('audio').firstChild.value = '';
  for (const a of p.audios) { const o = el('option', `${a.name} · ${a.durationUs ? (a.durationUs / 1e6).toFixed(1) + ' s' : 'durée inconnue'}`); o.value = a.path; $('audio').append(o); }
  if (p.audios.length === 1) $('audio').value = p.audios[0].path;
  $('placement').value = 'sync'; placementHint();
  mediaUrls = await unwrap(api.mediaSources(p.path));
  if (p.flowError) notice(`${p.flowError} Choisissez un autre dossier ou utilisez le chutier.`, true);
  else if (p.nonempty) notice('La timeline est déjà remplie. Pour protéger le montage, cette édition travaille uniquement sur des timelines vides.', true);
  else if (p.ignoredFiles) notice(`${p.ignoredFiles} entrée(s) hors images prises en charge, cachées ou sous-dossiers ne sont pas importées.`);
  else $('notice').hidden = true;
  buttons();
}
function placementHint() {
  $('timestampsBox').hidden = $('placement').value !== 'timestamps';
  $('placementHint').textContent = { sync: 'Un plan éditable : phrases regroupées, médias choisis et raccords ajustables en secondes. La validation finale s’écoute dans l’aperçu.', even: 'Ordre naturel : 001, 002, 010. Chaque visuel reçoit une durée égale.', timecode: 'Tous les noms doivent contenir un horaire explicite : 0-00, 0-20, 0-20-243. Départ à zéro obligatoire.', srt: 'Un bloc SRT par visuel, dans l’ordre naturel. Les nombres de blocs et de visuels doivent correspondre.', timestamps: 'Collez un départ par visuel. Le dernier visuel finit avec la voix off.', scenes: 'Le JSON associe explicitement chaque fichier à un début et une fin en secondes.' }[$('placement').value];
}
function confirmVisualChange() {
  return !syncPlan && !scenesFile || window.confirm('Changer la source des images réinitialise le plan actuel. Sauvez votre plan avant de continuer si vous souhaitez le conserver.');
}
$('chooseFlowFolder').onclick = () => task(async () => {
  if (!project || !confirmVisualChange()) return;
  const selected = await unwrap(api.chooseFlowFolder(project.path));
  if (selected) { await selectProject(); notice(`${selected.visuals.length} images Flow disponibles. Choisissez la voix off puis préparez les scènes.`); }
});
$('clearFlowFolder').onclick = () => task(async () => {
  if (!project || !confirmVisualChange()) return;
  await unwrap(api.clearFlowFolder(project.path)); await selectProject();
});
function options() {
  if ($('placement').value === 'sync' && (!syncPlan?.scenes?.length || syncPlan.scenes.some(s => !s.file))) throw new Error('Crée un plan et associe un média à chaque scène avant l’analyse.');
  return { audioPath: $('audio').value, placement: $('placement').value === 'sync' ? 'scenes' : $('placement').value, videoPolicy: $('videoPolicy').value,
  motion: $('motion').value, amount: Number($('amount').value) / 100, videoVolume: Number($('videoVolume').value) / 100,
  transitionIds: [...transitionIds], transitionSeconds: Number($('transitionSeconds').value),
  scenesText: $('placement').value === 'sync' ? JSON.stringify(syncPlan) : scenesFile?.text || '', srtText: srtFile?.text || '', timestampsText: $('timestampsText').value }; }
function renderTransitions() {
  $('transitions').replaceChildren(); $('transitions').classList.remove('empty');
  const q = $('transitionSearch').value.toLocaleLowerCase('fr');
  for (const t of transitions.filter(t => t.name.toLocaleLowerCase('fr').includes(q))) {
    const b = el('button', t.name, `transition-chip${transitionIds.has(t.id) ? ' selected' : ''}${t.available ? '' : ' unavailable'}`);
    b.disabled = !t.available; b.title = t.available ? `${t.category || 'Transition'} · ${t.id}` : t.reason; b.setAttribute('aria-pressed', String(transitionIds.has(t.id)));
    b.onclick = () => { if (transitionIds.has(t.id)) transitionIds.delete(t.id); else transitionIds.add(t.id); invalidate(); renderTransitions(); }; $('transitions').append(b);
  }
  if (!$('transitions').children.length) $('transitions').append(el('p', q ? 'Aucun résultat.' : 'Aucune transition trouvée. Utilisez une transition dans un projet CapCut, fermez-le puis actualisez le catalogue.', 'hint'));
}
async function loadCatalog() {
  transitions = await engine('catalog'); transitionIds = new Set([...transitionIds].filter(id => transitions.some(t => t.id === id && t.available))); renderTransitions(); invalidate();
}
function renderReport() {
  $('previewEmpty').hidden = true; $('previewContent').hidden = false; $('exportScenes').disabled = false; $('confirm').checked = false;
  $('stats').replaceChildren();
  for (const [value, label] of [[report.scenes, 'Scènes préparées'], [report.clips, 'Clips sur la timeline'], [time(report.durationUs), 'Durée de la voix off'], [`${report.fps} fps`, 'Fréquence du projet']]) {
    const c = el('div', undefined, 'stat'); c.append(el('strong', String(value)), el('span', label)); $('stats').append(c);
  }
  $('warnings').replaceChildren(...report.warnings.map(w => el('li', w)));
  $('writeFiles').textContent = `${report.filesToWrite.length} fichiers seront sauvegardés puis modifiés : ${report.filesToWrite.join(' · ')}`;
  $('sceneCount').textContent = `${report.rows.length} scènes · ${report.audio}`;
  page = 0; renderRows(); setupPlayback(); step('preview'); buttons();
}
function renderRows() {
  if (!report) return;
  const token = report.token;
  $('sceneRows').replaceChildren();
  for (const r of report.rows.slice(page * pageSize, (page + 1) * pageSize)) {
    const tr = el('tr'); tr.append(el('td', String(r.index)));
    const visual = el('td'); const jump = el('button', r.name, 'scene-jump'); jump.onclick = () => { $('voicePlayer').currentTime = r.startUs / 1e6; updatePlayback(); }; visual.append(jump); tr.append(visual, el('td', `${time(r.startUs)} → ${time(r.endUs)}`), el('td', `${(r.durationUs / 1e6).toFixed(2)} s`), el('td', String(r.clips)), el('td', r.text || '—')); $('sceneRows').append(tr);
    if (r.type === 'photo') engine('thumbnail', { file: r.path }).then(src => { if (report?.token === token && visual.isConnected) { const img = el('img', undefined, 'thumb'); img.alt = ''; img.src = src; visual.prepend(img); } }).catch(() => {});
  }
  const totalPages = Math.ceil(report.rows.length / pageSize);
  const prev = el('button', '← Précédent', 'button small'), next = el('button', 'Suivant →', 'button small');
  prev.disabled = page === 0; next.disabled = page >= totalPages - 1;
  prev.onclick = () => { page--; renderRows(); }; next.onclick = () => { page++; renderRows(); };
  $('pagination').replaceChildren(prev, el('span', `Page ${page + 1} / ${totalPages}`), next);
}
async function backups() {
  const list = await engine('backups'); $('backupList').replaceChildren(); $('backupList').classList.remove('empty');
  const status = { committed: 'Montage généré', restored: 'Restaurée', 'rolled-back': 'Annulée après erreur', pending: 'Récupération requise', 'recovery-required': 'Récupération requise', 'restore-pending': 'Restauration à reprendre', preparing: 'Préparation interrompue' };
  for (const b of list) {
    const row = el('div', undefined, 'backup-row'), info = el('div', undefined, 'info');
    info.append(el('strong', b.name || b.project.split(/[\\/]/).pop()), el('span', `${new Date(b.created).toLocaleString('fr-FR')} · ${status[b.status] || b.status}`)); row.append(info);
    if (['committed', 'pending', 'recovery-required', 'restore-pending'].includes(b.status)) {
      const btn = el('button', 'Restaurer les fichiers', 'button small');
      btn.onclick = () => { if (window.confirm('Restaurer les fichiers sauvegardés de ce projet ? CapCut doit être fermé. Les changements ultérieurs seront protégés par un contrôle de conflit.')) task(async () => { await engine('restore', { id: b.id }); invalidate(); notice('Les fichiers d’origine ont été restaurés.'); await backups(); }); }; row.append(btn);
    }
    $('backupList').append(row);
  }
  if (!list.length) $('backupList').append(el('p', 'Aucune génération sauvegardée dans ce dossier de projets.', 'hint'));
}
document.querySelectorAll('.nav[data-step]').forEach(b => b.onclick = () => { step(b.dataset.step); if (b.dataset.step === 'backups') task(backups); });
$('chooseRoot').onclick = () => task(async () => { const r = await unwrap(api.chooseRoot()); if (r) { $('root').textContent = r; project = null; invalidate(); await refresh(); await loadCatalog(); } });
$('refresh').onclick = () => task(refresh);
$('projectSelect').onchange = () => task(selectProject);
$('toSettings').onclick = () => step('settings');
for (const id of ['audio', 'placement', 'videoPolicy', 'motion', 'amount', 'videoVolume', 'transitionSeconds', 'timestampsText']) $(id).addEventListener('input', () => { invalidate(); placementHint(); $('amountValue').textContent = `${$('amount').value} %`; $('volumeValue').textContent = `${$('videoVolume').value} %`; });
$('audio').addEventListener('change', () => { syncPlan = null; scenesFile = null; renderSync(); notice('Voix off changée : reconstruis ou recharge le plan pour cette durée.'); });
$('transitionSearch').oninput = renderTransitions;
$('refreshTransitions').onclick = () => task(loadCatalog);
for (const [type, load, clear, name] of [['scenes', 'loadScenes', 'clearScenes', 'scenesName'], ['srt', 'loadSrt', 'clearSrt', 'srtName']]) {
  $(load).onclick = () => task(async () => { const r = await unwrap(api.loadFile(type)); if (!r) return; if (type === 'scenes') { syncPlan = parseScenes(r.text); scenesFile = r; $('placement').value = 'sync'; renderSync(); } else srtFile = r; $(name).textContent = r.name; $(clear).hidden = false; invalidate(); placementHint(); });
  $(clear).onclick = () => { if (type === 'scenes') { scenesFile = null; syncPlan = null; renderSync(); $('placement').value = 'sync'; } else srtFile = null; $(clear).hidden = true; $(name).textContent = type === 'srt' ? 'SRT retiré. Repères de lecture uniquement, sans piste de captions.' : 'Plan retiré.'; invalidate(); placementHint(); };
}
$('savePreset').onclick = () => task(async () => { const { audioPath, scenesText, srtText, timestampsText, ...saved } = options(); await unwrap(api.preferences(saved)); preferences = saved; notice('Vos réglages de mouvement, son, vidéos et transitions ont été mémorisés.'); });
$('analyze').onclick = () => task(async () => { invalidate(); $('settingsHint').textContent = 'Vérification des médias et préparation du montage…'; report = await engine('preview', { project: project.path, options: options() }); renderReport(); notice('Aperçu prêt. Aucun fichier CapCut n’a été modifié.'); $('settingsHint').textContent = 'L’analyse ne modifie aucun fichier CapCut.'; });
$('confirm').onchange = buttons;
$('build').onclick = () => task(async () => {
  $('buildHint').textContent = 'Sauvegarde, écriture puis vérification…'; stopPlayback(); const token = report.token; report = null; $('confirm').checked = false; $('exportScenes').disabled = true; const r = await engine('commit', { token });
  report = null; $('confirm').checked = false; $('exportScenes').disabled = true;
  notice(`Montage généré : ${r.scenes} scènes, ${r.clips} clips. ${r.files} fichiers sauvegardés et vérifiés. Ouvrez CapCut pour contrôler le résultat.`);
  $('buildHint').textContent = 'Génération terminée. Ouvrez CapCut pour vérifier le rendu.';
});
$('exportScenes').onclick = () => task(async () => {
  const obj = { version: 1, scenes: report.rows.map(r => ({ file: r.path, sourceIn: (r.sourceInUs || 0) / 1e6, start: r.startUs / 1e6, end: r.endUs / 1e6, ...(r.text ? { text: r.text } : {}) })) };
  if (await unwrap(api.export('ElpoAiAutoCapcut-scenes.json', JSON.stringify(obj, null, 2)))) notice('Le plan de scènes a été exporté.');
});
$('refreshBackups').onclick = () => task(backups);
$('recover').onclick = () => task(async () => { await engine('recover'); await backups(); notice('Verrou vérifié. Restaurez l’opération signalée si une récupération est requise.'); });
$('openBackups').onclick = () => task(async () => unwrap(api.openBackups()));
$('openCapcut').onclick = () => task(async () => { await unwrap(api.openCapcut()); running = 'open'; $('status').textContent = 'Ouverture de CapCut…'; $('status').className = 'badge red'; });
async function start() {
  const s = await unwrap(api.status()); $('root').textContent = s.root || 'Dossier à sélectionner'; preferences = s.preferences || {};
  for (const id of ['videoPolicy', 'motion', 'transitionSeconds']) if (preferences[id] !== undefined) $(id).value = preferences[id];
  if (Number.isFinite(preferences.amount)) $('amount').value = preferences.amount * 100;
  if (Number.isFinite(preferences.videoVolume)) $('videoVolume').value = preferences.videoVolume * 100;
  $('amountValue').textContent = `${$('amount').value} %`; $('volumeValue').textContent = `${$('videoVolume').value} %`;
  transitionIds = new Set(preferences.transitionIds || []);
  if (s.initialized) { await refresh(); await loadCatalog(); }
  else notice('Bienvenue. Choisissez le dossier contenant vos projets CapCut pour commencer.');
}
task(start).then(poll);
setInterval(poll, 10000);
function voiceDuration() {
  const a = project?.audios.find(a => a.path === $('audio').value);
  if (!a?.durationUs) throw new Error('Sélectionne une voix off dont la durée est connue.');
  return a.durationUs;
}
function syncChanged() { invalidate(); $('placement').value = 'sync'; placementHint(); renderSync(); }
function renderSync() {
  const rows = syncPlan?.scenes || [];
  $('syncSummary').textContent = rows.length ? `${rows.length} scènes · ${rows.filter(s => !s.file).length} médias à associer · horaires en secondes, arrondis aux images lors de l’analyse` : 'Aucun plan éditable. Sélectionnez la voix off puis chargez un SRT, un JSON ou partez de vos médias.';
  $('syncRows').replaceChildren(); $('syncPages').replaceChildren();
  syncPage = Math.max(0, Math.min(syncPage, Math.ceil(rows.length / pageSize) - 1));
  rows.slice(syncPage * pageSize, (syncPage + 1) * pageSize).forEach((s, localIndex) => {
    const index = syncPage * pageSize + localIndex, row = el('div', undefined, 'sync-row'), timing = el('div'), media = el('div');
    row.append(el('strong', String(index + 1)), timing, media);
    const times = el('div', undefined, 'sync-times');
    const startBox = el('div'), label = el('label', 'Début (secondes)'), start = el('input'); start.type = 'number'; start.step = '.001'; start.value = s.start; start.disabled = index === 0; start.setAttribute('aria-label', `Début scène ${index + 1}`);
    start.onchange = () => { try { boundary(syncPlan, index, Number(start.value)); syncChanged(); } catch (e) { showError(e); renderSync(); } };
    startBox.append(label, start); times.append(startBox, el('span', `→ ${Number(s.end).toFixed(3)} s`, 'hint')); timing.append(times);
    const text = el('textarea'); text.rows = 3; text.value = s.text || ''; text.setAttribute('aria-label', `Texte scène ${index + 1}`); text.onchange = () => { s.text = text.value; invalidate(); }; timing.append(text);
    const select = el('select'); select.setAttribute('aria-label', `Visuel scène ${index + 1}`); const empty = el('option', 'Choisir le visuel…'); empty.value = ''; select.append(empty);
    for (const m of project?.visuals || []) { const o = el('option', `${m.type === 'video' ? '▶' : '▧'} ${m.name}`); o.value = m.path; select.append(o); }
    const matches = project?.visuals.filter(m => m.path === s.file || m.name === s.file) || [];
    const found = matches.length === 1 ? matches[0] : null;
    if (found) { select.value = found.path; s.file = found.path; }
    else if (s.file) { const o = el('option', `Absent ou ambigu : ${s.file}`); o.value = s.file; select.append(o); select.value = s.file; }
    select.onchange = () => { s.file = select.value; s.sourceIn = 0; syncChanged(); };
    media.append(el('label', 'Image ou extrait vidéo'), select);
    if (found?.type === 'video') {
      const source = el('input'); source.type = 'number'; source.min = '0'; source.step = '.001'; source.value = s.sourceIn || 0; source.setAttribute('aria-label', `Début dans la vidéo scène ${index + 1}`);
      source.onchange = () => { s.sourceIn = Number(source.value); invalidate(); }; media.append(el('label', `Entrée dans la vidéo (secondes) · source ${(found.durationUs / 1e6).toFixed(2)} s`), source);
    }
    const actions = el('div', undefined, 'sync-actions'), cut = el('input'); cut.type = 'number'; cut.step = '.001'; cut.value = ((s.start + s.end) / 2).toFixed(3); cut.setAttribute('aria-label', `Horaire de coupure scène ${index + 1}`); cut.style.width = '100px';
    const splitButton = el('button', 'Découper', 'button small'); splitButton.onclick = () => { try { split(syncPlan, index, Number(cut.value)); syncChanged(); } catch (e) { showError(e); } };
    const mergeButton = el('button', 'Fusionner suivante', 'button small'); mergeButton.disabled = index === rows.length - 1; mergeButton.onclick = () => { merge(syncPlan, index); syncChanged(); };
    actions.append(cut, splitButton, mergeButton); media.append(actions); $('syncRows').append(row);
  });
  if (rows.length > pageSize) {
    const previous = el('button', '← Précédent', 'button small'), next = el('button', 'Suivant →', 'button small');
    previous.disabled = syncPage === 0; next.disabled = (syncPage + 1) * pageSize >= rows.length;
    previous.onclick = () => { syncPage--; renderSync(); }; next.onclick = () => { syncPage++; renderSync(); };
    $('syncPages').append(previous, el('span', `Page ${syncPage + 1} / ${Math.ceil(rows.length / pageSize)}`), next);
  }
}
$('groupSrt').onclick = () => task(async () => {
  if (!srtFile) throw new Error('Charge le SRT de cette voix off avec « Charger un SRT ».');
  const proposed = groupCues(parseSrt(srtFile.text), voiceDuration(), Number($('targetSeconds').value));
  if (syncPlan && !window.confirm('Remplacer le plan actuel par les scènes proposées ? Sauve ton plan pour conserver tes corrections.')) return;
  syncPlan = proposed; syncPage = 0; syncChanged(); notice('Scènes proposées. Choisis les visuels selon le sens de la narration, puis vérifie à l’écoute.');
});
$('createEven').onclick = () => task(async () => {
  const plan = planScenes(project?.visuals || [], voiceDuration(), { fps: project.fps });
  if (syncPlan && !window.confirm('Remplacer le plan actuel par une répartition égale des médias ?')) return;
  syncPlan = { version: 1, scenes: plan.map(s => ({ file: s.item.path, start: s.startUs / 1e6, end: s.endUs / 1e6, text: '' })) }; syncPage = 0; syncChanged();
});
$('assignOrder').onclick = () => task(async () => {
  if (!syncPlan) throw new Error('Crée d’abord le plan de scènes.');
  const sorted = [...project.visuals].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  if (sorted.length !== syncPlan.scenes.length) throw new Error(`${syncPlan.scenes.length} scènes pour ${sorted.length} visuels : associe les médias manuellement ou ajuste les scènes.`);
  if (!window.confirm('Associer les scènes aux médias par ordre des noms ? Les choix actuels seront remplacés. La pertinence doit être vérifiée à l’écoute.')) return;
  syncPlan.scenes.forEach((s, i) => { s.file = sorted[i].path; s.sourceIn = 0; }); syncChanged();
});
$('saveSync').onclick = () => task(async () => {
  if (!syncPlan) throw new Error('Aucun plan à sauvegarder.');
  if (await unwrap(api.export('ElpoAiAutoCapcut-plan-voix.json', JSON.stringify(syncPlan, null, 2)))) notice('Plan sauvegardé. Recharge ce JSON pour reprendre tes corrections.');
});
$('editSync').onclick = () => { $('voicePlayer').pause(); step('settings'); $('syncSummary').scrollIntoView({ block: 'center' }); };
function playbackError(text) { $('playerError').textContent = text; $('playerError').hidden = false; }
function stopPlayback() {
  playGeneration++; cancelAnimationFrame(raf); playback = null; activeClip = null;
  $('voicePlayer').pause(); $('voicePlayer').removeAttribute('src'); $('voicePlayer').load();
  $('playerVideo').pause(); $('playerVideo').removeAttribute('src'); $('playerVideo').load();
  $('playerImage').removeAttribute('src'); $('playerImage').hidden = true; $('playerVideo').hidden = true; $('playerEmpty').hidden = false;
}
function setupPlayback() {
  stopPlayback(); playback = report; $('playerError').hidden = true;
  const url = mediaUrls[report.audioPath];
  if (!url) { playbackError('Voix off indisponible pour la lecture locale. Format non pris en charge ou fichier absent.'); return; }
  $('voicePlayer').src = url; updatePlayback();
}
function updatePlayback() {
  if (!playback) return;
  const audio = $('voicePlayer'), video = $('playerVideo'), t = audio.currentTime, clip = clipAt(playback.playbackClips, t);
  $('playerClock').textContent = `${time(t * 1e6)} / ${time(playback.durationUs)}`;
  if (!clip) { video.pause(); $('playerVideo').hidden = true; $('playerImage').hidden = true; $('playerEmpty').hidden = false; $('playerEmpty').textContent = 'Fin de la voix off.'; activeClip = null; return; }
  const row = playback.rows[clip.scene - 1]; $('playerScene').textContent = `SCÈNE ${clip.scene} · ${row.name}`; $('playerText').textContent = row.text || 'Aucun texte associé.';
  const target = (clip.sourceStartUs + Math.round(t * 1e6) - clip.startUs) / 1e6;
  if (activeClip !== clip) {
    activeClip = clip; video.pause(); const url = mediaUrls[clip.path];
    $('playerImage').hidden = true; video.hidden = true; $('playerEmpty').hidden = !!url;
    if (!url) { $('playerEmpty').textContent = 'Visuel indisponible pour la lecture locale.'; playbackError(`Lecture indisponible : ${row.name}. Vérifie le fichier et le codec.`); }
    else if (clip.type === 'photo') { $('playerImage').src = url; $('playerImage').hidden = false; }
    else { video.src = url; video.hidden = false; }
  }
  if (clip.type === 'video' && video.readyState >= 1) {
    if (Math.abs(video.currentTime - target) > .08) video.currentTime = target;
    if (!audio.paused && video.paused) { const generation = playGeneration; video.play().catch(() => { if (generation === playGeneration) playbackError('Le clip vidéo ne peut pas être lu. Vérifie son codec dans CapCut.'); }); }
    else if (audio.paused) video.pause();
  }
}
function animatePlayback() { updatePlayback(); if (!$('voicePlayer').paused && playback) raf = requestAnimationFrame(animatePlayback); }
$('voicePlayer').addEventListener('play', () => { cancelAnimationFrame(raf); animatePlayback(); });
for (const event of ['pause', 'seeked', 'timeupdate', 'ended']) $('voicePlayer').addEventListener(event, updatePlayback);
$('voicePlayer').addEventListener('error', () => { if (playback) playbackError('Voix off illisible dans cet aperçu. Vérifie le fichier et son codec.'); });
$('playerVideo').addEventListener('loadedmetadata', updatePlayback);
$('playerVideo').addEventListener('error', () => { if (playback) playbackError('Vidéo illisible dans cet aperçu. Vérifie son codec ; aucun remplacement automatique.'); });
$('playerImage').addEventListener('error', () => { if (playback) playbackError('Image illisible dans cet aperçu.'); });
