import { test } from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import { fixture } from './fixtures.js';import { transact, digest, listBackups, restore, readJson } from '../lib/storage.js';
const withF=fn=>{const f=fixture();try{fn(f)}finally{f.cleanup()}};
const changes=f=>[f.draftFile,f.metaFile,f.indexFile].map(file=>({path:file,expectedHash:digest(fs.readFileSync(file)),bytes:Buffer.from(JSON.stringify({changed:true}))}));
test('panne au deuxième fichier : restauration de tous les originaux',()=>withF(f=>{const ch=changes(f),originals=ch.map(c=>fs.readFileSync(c.path));assert.throws(()=>transact({root:f.root,backupDir:f.backupDir,project:f.project,changes:ch,beforeReplace:i=>{if(i===1)throw new Error('injected disk error')}}));ch.forEach((c,i)=>assert(fs.readFileSync(c.path).equals(originals[i])));assert.equal(listBackups(f.backupDir,f.root)[0].status,'rolled-back');}));
test('préflight : aucune écriture si cible invalide',()=>withF(f=>{const ch=changes(f);fs.unlinkSync(f.metaFile);fs.mkdirSync(f.metaFile);assert.throws(()=>transact({root:f.root,backupDir:f.backupDir,project:f.project,changes:ch}));assert.equal(readJson(f.draftFile).value.duration,0);}));
test('verrou actif refuse une seconde transaction',()=>withF(f=>{fs.writeFileSync(path.join(f.root,'.elpo-autocapcut.lock'),'{}');assert.throws(()=>transact({root:f.root,backupDir:f.backupDir,project:f.project,changes:changes(f)}),e=>e.code==='LOCKED');assert.equal(readJson(f.draftFile).value.duration,0);}));
test('préflight contrôle les empreintes attendues',()=>withF(f=>{const ch=changes(f);ch[1].expectedHash='0'.repeat(64);assert.throws(()=>transact({root:f.root,backupDir:f.backupDir,project:f.project,changes:ch}),e=>e.code==='PROJECT_CHANGED');assert.equal(readJson(f.draftFile).value.duration,0);}));
test('sauvegarde altérée : restauration refusée sans écriture',()=>withF(f=>{const ch=changes(f);const r=transact({root:f.root,backupDir:f.backupDir,project:f.project,changes:ch});fs.writeFileSync(path.join(f.backupDir,r.backupId,'0.original.json'),'{}');assert.throws(()=>restore({root:f.root,backupDir:f.backupDir,backupId:r.backupId}),e=>e.code==='BACKUP_CORRUPT');assert(readJson(f.draftFile).value.changed);}));
test('interruption simulée + reprise depuis journal',()=>withF(f=>{
  const ch=changes(f);let checks=0;
  assert.throws(()=>transact({root:f.root,backupDir:f.backupDir,project:f.project,changes:ch,guard:()=>{if(++checks>=3)throw new Error('CapCut reopened')}}),e=>e.code==='RECOVERY_REQUIRED');
  const b=listBackups(f.backupDir,f.root)[0];assert.equal(b.status,'recovery-required');assert(readJson(f.draftFile).value.changed);
  restore({root:f.root,backupDir:f.backupDir,backupId:b.id});assert.equal(readJson(f.draftFile).value.duration,0);
}));
test('chemins de sauvegarde traversants refusés',()=>withF(f=>assert.throws(()=>restore({root:f.root,backupDir:f.backupDir,backupId:'../../outside'}),e=>e.code==='BACKUP_ID')));
