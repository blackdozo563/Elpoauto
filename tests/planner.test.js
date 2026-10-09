import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimecode, parseTimestampList, parseSrt, planScenes, expandVideos, parseScenes } from '../lib/planner.js';
const items = names => names.map(name => ({ name, path: `/media/${name}`, type: 'photo' }));
const reject = (fn, code) => assert.throws(fn, e => e.code === code);

test('les nombres simples restent des numéros de séquence', () => { for (const n of ['001.png', '002.png', '1234.jpg', '12.mp4']) assert.equal(parseTimecode(n), null); });
test('horaires explicites et format numéro + stamp', () => {
  assert.equal(parseTimecode('0-20-243.png'), 20243000);
  assert.equal(parseTimecode('00-01-02.jpg'), 62000000);
  assert.equal(parseTimecode('0001_00-00-12,243.jpg'), 12243000);
  assert.equal(parseTimecode('0001_00-00-12.243_v1.jpg'), 12243000);
  assert.equal(parseTimecode('0-20_20261004231200.png'), 20000000);
});
test('horaires invalides refusés', () => { for (const n of ['00-60-00.jpg', '0-61.png', 'text.png', '1-00-9999.jpg']) assert.equal(parseTimecode(n), null); });
test('ordre naturel et couverture exacte', () => {
  const p = planScenes(items(['010.png', '002.png', '001.png']), 30000000);
  assert.deepEqual(p.map(p => p.item.name), ['001.png', '002.png', '010.png']);
  assert.deepEqual(p.map(p => [p.startUs, p.durationUs]), [[0,10000000],[10000000,10000000],[20000000,10000000]]);
});
test('aucun média perdu lorsque les noms sont mélangés', () => reject(() => planScenes(items(['0-00.png','0-10.png','scene.png']), 30000000, { placement: 'timecode' }), 'TIMECODE_MISSING'));
test('horaires en double refusés', () => reject(() => planScenes(items(['0-00.png','0-00.jpg']), 30000000, { placement: 'timecode' }), 'TIMECODE_RANGE'));
test('premier départ non nul refusé', () => reject(() => planScenes(items(['0-01.png']), 30000000, { placement: 'timecode' }), 'START_NOT_ZERO'));
test('horaire après la fin audio refusé', () => reject(() => planScenes(items(['0-00.png','0-40.png']), 30000000, { placement: 'timecode' }), 'TIMECODE_RANGE'));
test('audio nul et durée non finie refusés', () => { for (const t of [0, NaN, Infinity, -1]) reject(() => planScenes(items(['a.png']), t), 'AUDIO_DURATION'); });
test('horaires trop proches pour une frame refusés', () => reject(() => planScenes(items(['0-00.png','0-00-001.png']), 30000000, { placement: 'timecode' }), 'SCENE_TOO_SHORT'));
test('scènes JSON : conservation des associations explicites et du texte', () => {
  const scenes = parseScenes('{"version":1,"scenes":[{"file":"b.png","start":0,"end":15,"text":"Bonjour"},{"file":"a.png","start":15,"end":30}]}');
  const p = planScenes(items(['a.png','b.png']), 30000000, { placement: 'scenes', scenes });
  assert.equal(p[0].item.name, 'b.png'); assert.equal(p[0].text, 'Bonjour');
});
test('trous et chevauchements du JSON refusés', () => {
  for (const next of [14,16]) reject(() => planScenes(items(['a.png','b.png']),30000000,{placement:'scenes',scenes:{version:1,scenes:[{file:'a.png',start:0,end:15},{file:'b.png',start:next,end:30}]}}), 'SCENES_COVERAGE');
});
test('fichier de scène absent ou ambigu refusé', () => {
  const scenes={version:1,scenes:[{file:'missing.png',start:0,end:30}]}; reject(()=>planScenes(items(['a.png']),30000000,{placement:'scenes',scenes}), 'SCENE_MEDIA');
});
test('SRT avec millisecondes, CRLF et BOM', () => {
  const c=parseSrt('\uFEFF1\r\n00:00:00,120 --> 00:00:05,000\r\nBonjour\r\n\r\n2\r\n00:00:10,243 --> 00:00:20,000\r\nBonsoir');
  assert.equal(c[0].startUs,120000);assert.equal(c[1].startUs,10243000);
  const p=planScenes(items(['002.png','001.png']),30000000,{placement:'srt',captions:c});assert.equal(p[0].startUs,0);assert.equal(p[1].endUs,30000000);assert.equal(p[0].text,'Bonjour');
});
test('SRT malformé, inversé ou chevauchant refusé', () => {
  for (const s of ['hello','1\n00:00:06,000 --> 00:00:05,000\na','1\n00:00:00,000 --> 00:00:06,000\na\n\n2\n00:00:05,000 --> 00:00:08,000\nb']) assert.throws(()=>parseSrt(s));
});
test('nombre de blocs SRT incohérent refusé', () => reject(()=>planScenes(items(['a.png','b.png']),30000000,{placement:'srt',captions:[{startUs:0,text:'a'}]}),'TIMING_COUNT'));
test('liste d’horaires : colonnes et secondes décimales',()=>{const p=planScenes(items(['a.png','b.png','c.png']),30000000,{placement:'timestamps',timestamps:parseTimestampList('00:00:00,000\n10.25\n00:00:20,000')});assert.equal(p[1].startUs,10266667);assert.equal(p[2].endUs,30000000);});
test('vidéo courte bloquée par défaut',()=>{const p=planScenes([{name:'v.mp4',type:'video',durationUs:8000000}],60000000);reject(()=>expandVideos(p),'VIDEO_TOO_SHORT');});
test('répétition couvre 60s sans source dépassée ni trou',()=>{const p=planScenes([{name:'v.mp4',type:'video',durationUs:8000000}],60000000);const c=expandVideos(p,{videoPolicy:'repeat'});assert.equal(c.length,8);assert.equal(c.at(-1).endUs,60000000);assert(c.every((s,i)=>s.sourceDurationUs<=8000000&&(!i||s.startUs===c[i-1].endUs)));});
test('propriétés de couverture pour plusieurs fps et durées',()=>{
  for(const fps of [24,25,29.97,30,50,60]) for(const duration of [1000000,8000001,60000000,123456789]){
    const p=planScenes(items(['003.png','001.png','002.png']),duration,{fps});assert.equal(p[0].startUs,0);assert.equal(p.at(-1).endUs,duration);assert(p.every((s,i)=>s.durationUs>0&&(!i||s.startUs===p[i-1].endUs)));
    const v=planScenes([{name:'v',type:'video',durationUs:8123456}],duration,{fps});const clips=expandVideos(v,{fps,videoPolicy:'repeat'});assert.equal(clips.reduce((n,c)=>n+c.durationUs,0),duration);assert(clips.every(c=>c.sourceDurationUs<=8123456));
  }
});
