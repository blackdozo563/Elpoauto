// Exercises renderer event handlers with a minimal DOM; no browser rendering/codec claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { Engine } from '../lib/engine.js';
import { fixture } from './fixtures.js';

class ClassList { constructor() { this.set = new Set(); } add(...c) { c.forEach(x => this.set.add(x)); } remove(...c) { c.forEach(x => this.set.delete(x)); } toggle(c, force) { const on = force ?? !this.set.has(c); if (on) this.set.add(c); else this.set.delete(c); return on; } contains(c) { return this.set.has(c); } }
class Node {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.dataset = {}; this.events = {}; this.style = { setProperty() {} }; this.paused = true; this.currentTime = 0; this.readyState = 1; this.isConnected = true; this.classList = new ClassList(); this.checked = false; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this[k] = v; }
  removeAttribute(k) { delete this[k]; }
  addEventListener(event, fn) { (this.events[event] ||= []).push(fn); }
  removeEventListener() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  focus() {}
  scrollIntoView() {}
}
const source = relative => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const strip = s => s.replace(/^import .*?;\n/gm, '').replace(/\bexport /g, '');
async function renderer(f, flowFolder = null) {
  const nodes = new Map([...source('renderer/index.html').matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Node()]));
  for (const [k, v] of Object.entries({ placement: 'sync', videoPolicy: 'repeat', motion: 'none', amount: '6', videoVolume: '0', musicVolume: '20', transitionSeconds: '.5', transitionOrder: 'cycle', effectScope: 'all', filterScope: 'global', targetSeconds: '6', batchPlacement: 'auto', batchVoice: 'auto', batchVideoPolicy: 'repeat', exPattern: '{projet}' })) nodes.get(k).value = v;
  nodes.get('batchExport').checked = true;
  const e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
  const ok = result => Promise.resolve({ ok: true, result });
  const srt = '1\n00:00:00,000 --> 00:00:08,000\nPremière idée.\n\n2\n00:00:10,000 --> 00:00:18,000\nSeconde idée.\n\n3\n00:00:20,000 --> 00:00:29,000\nConclusion.';
  const calls = [];
  const api = { status: () => ok({ root: f.root, initialized: true, platform: 'linux' }), overview: () => ok(e.overview()), mediaSources: () => ok(Object.fromEntries(f.items.map(m => [m.file_Path, 'elpo-media://local/' + m.file_Path.split('/').pop()]))), loadFile: () => ok({ name: 'voice.srt', path: '/tmp/voice.srt', text: srt }),
    chooseFlowFolder: () => ok(flowFolder ? e.setVisualFolder(f.project, flowFolder) : null),
    clearFlowFolder: () => ok(e.setVisualFolder(f.project, null)), subtitles: () => ok(true), jobs: () => ok({ export: [], pilot: [] }),
    exportSettings: () => ok(true), exportStart: args => { calls.push(['exportStart', args]); return ok(['job']); }, chooseDir: () => ok('/tmp/out'),
    engine: async (action, args = {}) => { try { return { ok: true, result: action === 'running' ? 'closed' : action === 'library' ? { transitions: [], effects: [], filters: [] } : action === 'inspect' ? e.inspect(args.project) : action === 'preview' ? e.preview(args.project, args.options) : action === 'batchPreview' ? e.batchPreview(args.projects, args.options, args.rules) : action === 'batchCommit' ? e.batchCommit(args.tokens) : action === 'commit' ? e.commit(args.token) : e[action]() }; } catch (error) { return { ok: false, error: { message: error.message } }; } } };
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), createTextNode: t => ({ textContent: t }), body: new Node(), querySelectorAll: () => [] };
  const context = vm.createContext({ window: { elpo: api }, document, setInterval() {}, setTimeout, clearTimeout, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, console, devicePixelRatio: 1 });
  vm.runInContext(['lib/errors.js', 'lib/planner.js', 'lib/sync.js', 'renderer/app.js'].map(s => strip(source(s))).join('\n'), context);
  vm.runInContext('ask = async () => true', context);
  await new Promise(resolve => setTimeout(resolve, 20));
  nodes.get('projectSelect').value = f.project; await nodes.get('projectSelect').onchange();
  await new Promise(resolve => setTimeout(resolve, 5));
  return { nodes, context, e, calls };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
test('UI : SRT → propositions → médias associés → aperçu ; aucun fichier écrit', async () => {
  const f = fixture({ visuals: ['001.png', '002.mp4', '003.png'] });
  try {
    const before = fs.readFileSync(f.draftFile), { nodes, context } = await renderer(f);
    await nodes.get('loadSrt').onclick(); await nodes.get('groupSrt').onclick();
    assert.match(nodes.get('syncSummary').textContent, /3 scènes · 3 médias/);
    await nodes.get('analyze').onclick(); assert.match(nodes.get('notice').textContent, /associe un média/); assert.equal(vm.runInContext('report', context), null);
    await nodes.get('assignOrder').onclick(); await nodes.get('analyze').onclick();
    assert.equal(vm.runInContext('report.clips', context), 4); assert.equal(nodes.get('previewContent').hidden, false);
    assert.equal(vm.runInContext('currentStep', context), 'review');
    assert.equal(nodes.get('build').disabled, true);
    nodes.get('voicePlayer').currentTime = 10; vm.runInContext('updatePlayback()', context);
    assert.equal(nodes.get('playerVideo').hidden, false); assert.match(nodes.get('playerScene').textContent, /Scène 2/);
    assert.equal(nodes.get('timelineDock').hidden, false);
    assert.equal(nodes.get('ribbonScenes').children.filter(n => n.className.startsWith('rscene')).length, 3);
    assert.deepEqual(fs.readFileSync(f.draftFile), before);
  } finally { f.cleanup(); }
});
test('UI : dossier Flow → plan → aperçu ; retour chutier invalide le plan', async () => {
  const f = fixture();
  try {
    const folder = path.join(f.temp, 'Flow'); fs.mkdirSync(folder);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(folder, '001.png'), png);
    const { nodes, context } = await renderer(f, folder);
    await nodes.get('chooseFlowFolder').onclick();
    assert.equal(nodes.get('flowFolder').textContent, folder);
    assert.equal(nodes.get('clearFlowFolder').hidden, false);
    assert.equal(vm.runInContext('project.visuals.length', context), 1);
    await nodes.get('createEven').onclick(); await nodes.get('analyze').onclick();
    assert.equal(vm.runInContext('report.scenes', context), 1);
    await nodes.get('clearFlowFolder').onclick();
    assert.equal(vm.runInContext('project.visuals.length', context), 2);
    assert.equal(vm.runInContext('report', context), null);
    assert.equal(vm.runInContext('syncPlan', context), null);
    assert.equal(nodes.get('clearFlowFolder').hidden, true);
  } finally { f.cleanup(); }
});
test('UI : correction du raccord invalide l’aperçu et arrête la lecture', async () => {
  const f = fixture({ visuals: ['001.png', '002.mp4', '003.png'] });
  try {
    const { nodes, context } = await renderer(f);
    await nodes.get('createEven').onclick(); await nodes.get('analyze').onclick();
    vm.runInContext('boundary(syncPlan, 1, 9.5); syncChanged()', context);
    assert.equal(vm.runInContext('report', context), null); assert.equal(nodes.get('voicePlayer').paused, true); assert.equal(nodes.get('build').disabled, true);
    assert.equal(vm.runInContext('syncPlan.scenes[0].end', context), 9.5);
  } finally { f.cleanup(); }
});
test('UI : style (Ken Burns, musique) → génération → export ELPO du projet', async () => {
  const f = fixture({ visuals: ['001.png', '002.png'], audioCount: 2 });
  try {
    const { nodes, context, calls } = await renderer(f);
    nodes.get('music').value = f.items.at(-1).file_Path; nodes.get('audio').value = f.items.at(-2).file_Path;
    vm.runInContext("$('motion').value = 'kenburns'", context);
    await nodes.get('createEven').onclick(); await nodes.get('analyze').onclick();
    assert.equal(vm.runInContext('report.music', context), 'voice-1.wav');
    nodes.get('confirm').checked = true; vm.runInContext('buttons()', context);
    assert.equal(nodes.get('build').disabled, false);
    await nodes.get('build').onclick(); await settle();
    assert.match(nodes.get('notice').textContent, /Montage généré/);
    const draft = JSON.parse(fs.readFileSync(f.draftFile, 'utf8'));
    assert.equal(draft.tracks.filter(t => t.type === 'audio').length, 2);
    assert.ok(draft.tracks.find(t => t.type === 'video').segments[1].common_keyframes.some(k => k.property_type === 'KFTypePositionX'));
    vm.runInContext("ffmpeg = { version: 'test' }", context);
    await nodes.get('exportOne').onclick();
    assert.equal(calls[0][0], 'exportStart'); assert.equal(calls[0][1].projects[0].path, f.project); assert.equal(calls[0][1].settings.outputDir, '/tmp/out');
  } finally { f.cleanup(); }
});
test('UI : production en lot — cocher, monter les timelines vides puis exporter', async () => {
  const f = fixture({ visuals: ['001.png', '002.png'] });
  try {
    const { nodes, context, calls } = await renderer(f);
    vm.runInContext('toggleSelect(projects[0].path, true)', context);
    assert.equal(nodes.get('selectionBar').hidden, false);
    await nodes.get('selectionExport').onclick();
    nodes.get('batchBuild').checked = true; vm.runInContext('renderBatch()', context);
    assert.match(nodes.get('batchHint').textContent, /1 timeline à monter · 1 vidéo à exporter avec ELPO/);
    vm.runInContext("ffmpeg = { version: 'test' }", context);
    await nodes.get('batchStart').onclick(); await settle();
    const draft = JSON.parse(fs.readFileSync(f.draftFile, 'utf8'));
    assert.equal(draft.tracks.find(t => t.type === 'video').segments.length, 2);
    assert.equal(calls.at(-1)[0], 'exportStart'); assert.equal(calls.at(-1)[1].projects.length, 1);
  } finally { f.cleanup(); }
});
