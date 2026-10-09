#!/usr/bin/env python3
"""Standalone UI demonstration with test assets; never writes a CapCut project."""
import base64, json, pathlib, re, sys
source, assets, output = map(pathlib.Path, sys.argv[1:])
html = (source/'renderer/index.html').read_text()
html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '''<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'">''', html)
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>'+(source/'renderer/styles.css').read_text()+'</style>')
html = html.replace('VOTRE STUDIO LOCAL','DÉMONSTRATION INTERACTIVE').replace('Vos médias restent sur votre ordinateur.', 'Exemples inclus : bips, images et vidéo de test. Aucune écriture dans CapCut.')
def code(name):
    return re.sub(r'^import .*?;\n', '', (source/name).read_text(), flags=re.M).replace('export ', '')
common = code('lib/errors.js')+code('lib/planner.js')+code('lib/sync.js')
urls = {}
for name, mime in [('001.png','image/png'),('002.mp4','video/mp4'),('003.png','image/png'),('audio-test.wav','audio/wav')]:
    urls['/demo/'+name] = 'data:'+mime+';base64,'+base64.b64encode((assets/name).read_bytes()).decode()
mock = r'''
const demoProject='/demo/CapCut/Projects/Exemple';
const demoAudio={path:'/demo/audio-test.wav',name:'audio-test.wav',type:'audio',durationUs:30000000};
const demoVisuals=[{path:'/demo/001.png',name:'001.png',type:'photo',width:1920,height:1080,durationUs:0},{path:'/demo/002.mp4',name:'002.mp4',type:'video',width:1920,height:1080,durationUs:8000000},{path:'/demo/003.png',name:'003.png',type:'photo',width:1920,height:1080,durationUs:0}];
const demoScenes={version:1,scenes:[{file:'/demo/001.png',start:0,end:10,text:'Début de la narration.'},{file:'/demo/002.mp4',start:10,end:20,text:'Extrait vidéo au milieu.'},{file:'/demo/003.png',start:20,end:30,text:'Conclusion de la narration.'}]};
const ok=result=>Promise.resolve({ok:true,result});
window.elpo={status:()=>ok({root:'/Exemple/CapCut/Projects',initialized:true,preferences:{videoPolicy:'repeat'},version:'0.3.1'}),mediaSources:()=>ok(DEMO_URLS),chooseRoot:()=>ok(null),preferences:()=>ok(true),openCapcut:()=>ok(null),openBackups:()=>ok(null),
loadFile:type=>ok(type==='scenes'?{name:'plan-exemple.json',text:JSON.stringify(demoScenes)}:{name:'voix-exemple.srt',text:'1\n00:00:00,000 --> 00:00:08,000\nDébut de la narration.\n\n2\n00:00:10,000 --> 00:00:18,000\nExtrait vidéo au milieu.\n\n3\n00:00:20,000 --> 00:00:29,000\nConclusion de la narration.'}),
export:(name,text)=>{const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return ok(true)},
engine:(action,args={})=>{
if(action==='running')return ok('unknown');
if(action==='list')return ok([{path:demoProject,name:'Exemple · bips et visuels de test'}]);
if(action==='inspect')return ok({path:demoProject,name:'Exemple',fps:30,canvas:{width:1920,height:1080},visuals:demoVisuals,audios:[demoAudio],nonempty:false,suggestedPlacement:'even'});
if(action==='catalog'||action==='backups'||action==='recover')return ok([]);
if(action==='thumbnail')return ok(DEMO_URLS[args.file]);
if(action==='preview'){
try{
const opts=args.options;
const plan=planScenes(demoVisuals,30000000,{placement:opts.placement,scenes:opts.scenesText?parseScenes(opts.scenesText):null,captions:opts.srtText?parseSrt(opts.srtText):[],timestamps:opts.timestampsText?parseTimestampList(opts.timestampsText):[]});
const clips=expandVideos(plan,{videoPolicy:opts.videoPolicy});
return ok({token:'DEMO',name:'Exemple',scenes:plan.length,clips:clips.length,durationUs:30000000,fps:30,canvas:{width:1920,height:1080},audio:demoAudio.name,audioPath:demoAudio.path,
playbackClips:clips.map(c=>({path:c.item.path,type:c.item.type,startUs:c.startUs,endUs:c.endUs,sourceStartUs:c.sourceStartUs,scene:c.index+1})),
rows:plan.map(s=>({index:s.index+1,name:s.item.name,path:s.item.path,type:s.item.type,startUs:s.startUs,endUs:s.endUs,durationUs:s.durationUs,sourceInUs:s.sourceInUs||0,sourceUs:s.item.durationUs,clips:clips.filter(c=>c.index===s.index).length,text:s.text})),
filesToWrite:['DÉMONSTRATION — aucun fichier réel'],warnings:['Démonstration d’interface avec médias de test. Aucune connexion à CapCut.','Les bips sont des repères de temps ; les textes sont des exemples, sans transcription de voix.','Le bouton de génération est volontairement désactivé.']});
}catch(e){return Promise.resolve({ok:false,error:{message:e.message}})}
}
return Promise.resolve({ok:false,error:{message:'Action native indisponible dans la démonstration.'}});
}};
'''.replace('DEMO_URLS',json.dumps(urls))
script=common+mock+code('renderer/app.js')
html=html.replace('<script type="module" src="app.js"></script>', '<script>'+script.replace('</script','<\\/script')+'</script>')
output.write_text(html)
print(output,output.stat().st_size)
