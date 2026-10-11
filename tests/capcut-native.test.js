import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {nativeActions} from '../lib/capcut-native.js';
test('adaptateur natif : aucune action JXA/UI ni touche de secours exposée',()=>{const actions=nativeActions({binary:'/inexistant'});for(const key of ['readUi','key','shortcut','click','restoreWindow','windowFrame'])assert.equal(actions[key],undefined,key);});
test('adaptateur natif : outil absent produit une erreur explicite',async()=>{const a=nativeActions({binary:'/inexistant'});await assert.rejects(a.state(),e=>e.code==='AX_BINARY');assert.equal(a.probeAvailable(),false);});
test('ffprobe réel : lecture des métadonnées d’un MP4 de 5 s, sans décodage',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'elpo-native-probe-'));try{
 const ffprobe=execFileSync('which',['ffprobe'],{encoding:'utf8'}).trim();const file=path.join(dir,'5s.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=128x72:r=25','-t','5','-c:v','libx264',file]);
 const a=nativeActions({ffprobe});assert.equal(a.probeAvailable(),true);const result=await a.probeDuration(file);assert.equal(result.duration,5);assert.equal(result.video,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}});
