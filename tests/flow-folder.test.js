import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { scanFlowFolder, imageDimensions } from '../lib/flow-folder.js';
import { Engine } from '../lib/engine.js';
import { readJson } from '../lib/storage.js';

// Real single-pixel PNG; these tests check metadata/placement, not native playback.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
function flow(f) {
  const dir = path.join(f.temp, 'Flow'); fs.mkdirSync(dir);
  for (const name of ['010.png', '002.png', '001.PNG']) fs.writeFileSync(path.join(dir, name), png);
  return dir;
}
test('Flow : dimensions PNG réelles, tri naturel et exclusions explicites', () => {
  const f = fixture();
  try {
    const folder = flow(f); fs.mkdirSync(path.join(folder, 'nested')); fs.writeFileSync(path.join(folder, 'notes.txt'), 'test');
    fs.writeFileSync(path.join(folder, '.hidden.png'), png);
    const result = scanFlowFolder(folder);
    assert.deepEqual(result.visuals.map(v => v.name), ['001.PNG', '002.png', '010.png']);
    assert(result.visuals.every(v => v.width === 1 && v.height === 1 && v.type === 'photo'));
    assert.equal(result.ignored, 3);
  } finally { f.cleanup(); }
});
test('Flow : images vides, tronquées, liens et dossiers sans images refusés', () => {
  const f = fixture();
  try {
    const folder = path.join(f.temp, 'Flow'); fs.mkdirSync(folder);
    assert.throws(() => scanFlowFolder(folder), e => e.code === 'FLOW_COUNT');
    const file = path.join(folder, '001.png'); fs.writeFileSync(file, '');
    assert.throws(() => scanFlowFolder(folder), e => e.code === 'FLOW_FILE');
    fs.writeFileSync(file, png.subarray(0, 40));
    assert.throws(() => scanFlowFolder(folder), e => e.code === 'IMAGE_FORMAT');
    fs.unlinkSync(file); fs.symlinkSync(f.items[0].file_Path, file);
    assert.throws(() => scanFlowFolder(folder), e => e.code === 'FLOW_FILE');
  } finally { f.cleanup(); }
});
test('Flow : lecture des dimensions JPEG et WebP ; animation refusée', () => {
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,100,0,200,1,1,0x11,0,0xff,0xd9]);
  assert.deepEqual(imageDimensions(jpeg), {width:200,height:100});
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22,4); webp.write('WEBP',8); webp.write('VP8X',12); webp.writeUInt32LE(10,16); webp.writeUIntLE(199,24,3); webp.writeUIntLE(99,27,3);
  assert.deepEqual(imageDimensions(webp), {width:200,height:100});
  webp[20] = 2; assert.throws(() => imageDimensions(webp), e => e.code === 'IMAGE_FORMAT');
  assert.throws(() => imageDimensions(Buffer.from('not-an-image')), e => e.code === 'IMAGE_FORMAT');
});
test('Flow → aperçu → matériaux et chutier CapCut → restauration exacte', () => {
  const f = fixture({visuals:[]});
  try {
    const folder = flow(f), files = [f.draftFile, f.metaFile, f.indexFile];
    const before = files.map(file => fs.readFileSync(file));
    const e = new Engine({root:f.root,backupDir:f.backupDir,guard:()=>{}});
    assert.equal(e.setVisualFolder(f.project,folder).visuals.length,3);
    const report = e.preview(f.project, {});
    assert.equal(report.scenes,3); assert.equal(report.audioPath,f.items[0].file_Path);
    files.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
    const result = e.commit(report.token), draft = readJson(f.draftFile).value;
    assert.deepEqual(draft.materials.videos.map(v=>v.material_name),['001.PNG','002.png','010.png']);
    assert.equal(draft.tracks.at(-2).segments.at(-1).target_timerange.start,20000000);
    assert.equal(readJson(f.metaFile).value.draft_materials[0].value.filter(v=>v.metetype==='photo').length,3);
    assert.equal(e.inspect(f.project).nonempty,true);
    e.restore(result.backupId); files.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
  } finally { f.cleanup(); }
});
test('Flow : seul le visuel utilisé entre au chutier et pas de doublon de chemin', () => {
  const f = fixture({visuals:[]});
  try {
    const folder=flow(f), e=new Engine({root:f.root,backupDir:f.backupDir,guard:()=>{}});
    e.setVisualFolder(f.project,folder);
    const image=path.join(folder,'001.PNG');
    const scenesText=JSON.stringify({version:1,scenes:[{file:image,start:0,end:10},{file:image,start:10,end:30}]});
    const p=e.preview(f.project,{placement:'scenes',scenesText});e.commit(p.token);
    assert.equal(readJson(f.metaFile).value.draft_materials[0].value.filter(v=>v.metetype==='photo').length,1);
    assert.equal(readJson(f.draftFile).value.materials.videos.length,1);
  }finally{f.cleanup()}
});
test('Flow : modification après aperçu bloque l’écriture ; changement de source invalide le token', () => {
  const f = fixture();
  try {
    const folder=flow(f),e=new Engine({root:f.root,backupDir:f.backupDir,guard:()=>{}});
    e.setVisualFolder(f.project,folder);let p=e.preview(f.project,{});
    fs.appendFileSync(path.join(folder,'001.PNG'),'changed');
    assert.throws(()=>e.commit(p.token),x=>x.code==='MEDIA_CHANGED');
    assert.equal(readJson(f.draftFile).value.duration,0);
    fs.writeFileSync(path.join(folder,'001.PNG'),png);p=e.preview(f.project,{});
    e.setVisualFolder(f.project,null);
    assert.throws(()=>e.commit(p.token),x=>x.code==='PREVIEW_REQUIRED');
    assert.equal(e.inspect(f.project).visuals.length,2);
  }finally{f.cleanup()}
});
test('Flow : sélection persistée par projet, dossier supprimé remplaçable, génération bloquée', () => {
  const f=fixture();
  try {
    const folder=flow(f), e=new Engine({root:f.root,backupDir:f.backupDir,guard:()=>{},visualFolders:{[f.project]:folder}});
    assert.equal(e.inspect(f.project).visuals.length,3);
    fs.rmSync(folder,{recursive:true});
    assert.equal(e.inspect(f.project).visuals.length,0);assert(e.inspect(f.project).flowError);
    assert.throws(()=>e.preview(f.project,{}),x=>x.code==='FLOW_FOLDER');
    assert.equal(e.setVisualFolder(f.project,null).visuals.length,2);
  }finally{f.cleanup()}
});
