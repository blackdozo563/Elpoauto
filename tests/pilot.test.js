import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, FAST } from './native-pilot-fixture.js';
import { CapcutPilot, bumpProject, missingMedia } from '../lib/capcut-pilot.js';
import { readJson } from '../lib/storage.js';
test('pilote natif : action, état confirmé, fichier annoncé et ffprobe, fermeture puis quit', async () => {
 const s=setup();try {
  const p=new CapcutPilot({root:s.f.root,backupDir:s.f.backupDir,actions:s.actions,settings:FAST});
  const [j]=await p.run([s.project],{exportDir:s.dir}); assert.equal(j.status,'done',j.error);
  assert.deepEqual(s.log.filter(x=>!x.startsWith('state:')),['launch','open-project:Test ELPO','open-export','press-export','close-done','quit']);
  assert.ok(readJson(s.f.metaFile).value.tm_draft_modified>0); assert.ok(fs.existsSync(j.report));
  const report=readJson(j.report).value;assert.equal(report.events.find(e=>e.validation).validation.actualDuration,5);
 }finally{s.f.cleanup();}
});
test('pilote natif : médias manquants refusés sans touche aveugle',async()=>{
 const s=setup();try{fs.unlinkSync(s.f.items[0].file_Path);assert.deepEqual(missingMedia(s.f.project),['scene-1.png']);
 const p=new CapcutPilot({root:s.f.root,actions:s.actions,settings:FAST});const [j]=await p.run([s.project],{exportDir:s.dir});assert.equal(j.status,'failed');assert.equal(s.log.length,0);
 }finally{s.f.cleanup();}
});
test('pilote natif : aucun calibrage requis, projet extérieur refusé et ffprobe obligatoire',async()=>{
 const s=setup();try{assert.throws(()=>bumpProject(s.f.root,s.f.temp));s.actions.probeAvailable=()=>false;
 const p=new CapcutPilot({root:s.f.root,actions:s.actions});await assert.rejects(p.run([s.project],{exportDir:s.dir}),e=>e.code==='FFPROBE_REQUIRED');assert.equal(p.controller,null);
 }finally{s.f.cleanup();}
});
test('pilote natif : réservation atomique avant la vérification des autorisations',async()=>{
 const s=setup();try{let grant;s.actions.accessibility=()=>new Promise(r=>grant=r);const p=new CapcutPilot({root:s.f.root,actions:s.actions,settings:FAST});
 const first=p.run([s.project],{exportDir:s.dir});await assert.rejects(p.run([s.project],{exportDir:s.dir}),e=>e.code==='PILOT_BUSY');grant(false);await assert.rejects(first,e=>e.code==='ACCESSIBILITY');assert.equal(p.controller,null);
 }finally{s.f.cleanup();}
});
test('pilote natif : arrêt pendant la pause, aucune prochaine action',async()=>{
 const s=setup();try{const p=new CapcutPilot({root:s.f.root,actions:s.actions,settings:FAST});const run=p.run([s.project],{exportDir:s.dir});p.pause();p.stop();const [j]=await run;assert.equal(j.status,'cancelled');assert.equal(p.paused,false);assert.ok(!s.log.includes('press-export'));
 }finally{s.f.cleanup();}
});
