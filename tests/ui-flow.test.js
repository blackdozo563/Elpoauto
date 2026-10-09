// Exercises renderer event handlers with a minimal DOM; no browser rendering/codec claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Engine, inspect } from '../lib/engine.js';
import { fixture } from './fixtures.js';
import path from 'node:path';
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.value = ''; this.dataset = {}; this.events = {}; this.style = {}; this.paused = true; this.currentTime = 0; this.readyState = 1; this.isConnected = true; this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this[k] = v; }
  removeAttribute(k) { delete this[k]; }
  addEventListener(event, fn) { (this.events[event] ||= []).push(fn); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  scrollIntoView() {}
}
const source = relative => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const strip = s => s.replace(/^import .*?;\n/gm, '').replace(/\bexport /g, '');
async function renderer(f, flowFolder = null) {
  const nodes = new Map([...source('renderer/index.html').matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Node()]));
  for (const [k, v] of Object.entries({ placement: 'sync', videoPolicy: 'repeat', motion: 'none', amount: '6', videoVolume: '0', transitionSeconds: '.5', targetSeconds: '6' })) nodes.get(k).value = v;
  const e = new Engine({ root: f.root, backupDir: f.backupDir, guard: () => {} });
  const ok = result => Promise.resolve({ ok: true, result });
  const srt = '1\n00:00:00,000 --> 00:00:08,000\nPremière idée.\n\n2\n00:00:10,000 --> 00:00:18,000\nSeconde idée.\n\n3\n00:00:20,000 --> 00:00:29,000\nConclusion.';
  const api = { status: () => ok({ root: f.root, initialized: true }), mediaSources: () => ok(Object.fromEntries(f.items.map(m => [m.file_Path, 'elpo-media://local/' + m.file_Path.split('/').pop()]))), loadFile: () => ok({ name: 'voice.srt', text: srt }),
    chooseFlowFolder: () => ok(flowFolder ? e.setVisualFolder(f.project, flowFolder) : null),
    clearFlowFolder: () => ok(e.setVisualFolder(f.project, null)),
    engine: async (action, args = {}) => { try { return { ok: true, result: action === 'running' ? 'unknown' : action === 'catalog' ? [] : action === 'list' ? [{ path: f.project, name: 'Test' }] : action === 'inspect' ? e.inspect(args.project) : action === 'preview' ? e.preview(args.project, args.options) : e[action]() }; } catch (error) { return { ok: false, error: { message: error.message } }; } } };
  const context = vm.createContext({ window: { elpo: api, confirm: () => true }, document: { getElementById: id => nodes.get(id), createElement: tag => new Node(tag), body: new Node(), querySelectorAll: () => [] }, setInterval() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, console });
  vm.runInContext(['lib/errors.js', 'lib/planner.js', 'lib/sync.js', 'renderer/app.js'].map(s => strip(source(s))).join('\n'), context);
  await new Promise(resolve => setImmediate(resolve));
  nodes.get('projectSelect').value = f.project; await nodes.get('projectSelect').onchange();
  return { nodes, context, e };
}
test('UI : SRT → propositions → médias associés → aperçu ; aucun fichier écrit', async () => {
  const f = fixture({ visuals: ['001.png', '002.mp4', '003.png'] });
  try {
    const before = fs.readFileSync(f.draftFile), { nodes, context } = await renderer(f);
    await nodes.get('loadSrt').onclick(); await nodes.get('groupSrt').onclick();
    assert.match(nodes.get('syncSummary').textContent, /3 scènes · 3 médias/);
    await nodes.get('analyze').onclick(); assert.match(nodes.get('notice').textContent, /associe un média/); assert.equal(vm.runInContext('report', context), null);
    await nodes.get('assignOrder').onclick(); await nodes.get('analyze').onclick();
    assert.equal(vm.runInContext('report.clips', context), 4); assert.equal(nodes.get('previewContent').hidden, false); assert.equal(nodes.get('build').disabled, true);
    nodes.get('voicePlayer').currentTime = 10; vm.runInContext('updatePlayback()', context);
    assert.equal(nodes.get('playerVideo').hidden, false); assert.match(nodes.get('playerScene').textContent, /SCÈNE 2/);
    assert.deepEqual(fs.readFileSync(f.draftFile), before);
  } finally { f.cleanup(); }
});
test('UI : dossier Flow → plan → aperçu ; retour chutier invalide le plan', async () => {
  const f=fixture();
  try {
    const folder=path.join(f.temp,'Flow');fs.mkdirSync(folder);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
    fs.writeFileSync(path.join(folder,'001.png'),png);
    const {nodes,context}=await renderer(f,folder);
    await nodes.get('chooseFlowFolder').onclick();
    assert.equal(nodes.get('flowFolder').textContent,folder);
    assert.equal(nodes.get('clearFlowFolder').hidden,false);
    assert.equal(vm.runInContext('project.visuals.length',context),1);
    await nodes.get('createEven').onclick();await nodes.get('analyze').onclick();
    assert.equal(vm.runInContext('report.scenes',context),1);
    await nodes.get('clearFlowFolder').onclick();
    assert.equal(vm.runInContext('project.visuals.length',context),2);
    assert.equal(vm.runInContext('report',context),null);
    assert.equal(vm.runInContext('syncPlan',context),null);
    assert.equal(nodes.get('clearFlowFolder').hidden,true);
  }finally{f.cleanup()}
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
