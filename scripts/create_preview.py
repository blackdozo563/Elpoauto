#!/usr/bin/env python3
"""Standalone UI demonstration with test assets; never writes a CapCut project.
Usage: create_preview.py SOURCE ASSETS_DIR OUTPUT.html
ASSETS_DIR holds cover-a.png … cover-f.png, clip.mp4 and voice.wav."""
import base64, json, pathlib, re, sys
source, assets, output = map(pathlib.Path, sys.argv[1:])
html = (source/'renderer/index.html').read_text()
html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '''<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src data:; object-src 'none'; base-uri 'none'">''', html)
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>'+(source/'renderer/styles.css').read_text()+'</style>')
def code(name):
    return re.sub(r'^import .*?;\n', '', (source/name).read_text(), flags=re.M).replace('export ', '')
common = code('lib/errors.js')+code('lib/planner.js')+code('lib/sync.js')
def data(name, mime):
    return 'data:'+mime+';base64,'+base64.b64encode((assets/name).read_bytes()).decode()
urls = {f'/demo/media/{i:03d}.png': data(f'cover-{c}.png', 'image/png') for i, c in enumerate('abcdef', 1)}
urls['/demo/media/007.mp4'] = data('clip.mp4', 'video/mp4')
urls['/demo/media/voix-off.wav'] = data('voice.wav', 'audio/wav')
covers = {c: urls[f'/demo/media/{i:03d}.png'] for i, c in enumerate('abcdef', 1)}
mock = r'''
const URLS = DEMO_URLS, COVERS = DEMO_COVERS, ROOT = '/Users/elpo/Movies/CapCut/User Data/Projects/com.lveditor.draft';
const P = (n, cover, extra) => ({ path: ROOT + '/' + n, name: n, mtime: Date.now(), cover: 'x', coverUrl: COVERS[cover], readable: true, fps: 30, canvas: { width: 1920, height: 1080 }, durationUs: 0, segments: 0, nonempty: false, visuals: 7, audios: 2, visualFolder: null, elpo: false, subtitles: null, lastExport: null, ...extra });
const PROJECTS = [P('Prière du matin', 'a', { subtitles: '/x.srt' }), P('Psaume 23 — méditation', 'd'), P('Intention du soir', 'b', { nonempty: true, segments: 14, durationUs: 92e6, elpo: true }),
  P('Béatitudes', 'c', { nonempty: true, segments: 22, durationUs: 184e6, lastExport: { at: Date.now() } }), P('Notre Père — chant', 'e', { canvas: { width: 1080, height: 1920 } }), P('Avent jour 3', 'f', { nonempty: true, segments: 9, durationUs: 61e6 }),
  P('Archive 2025', null, { readable: false })];
const VIS = Object.keys(URLS).filter(k => /png|mp4/.test(k)).map(p => ({ path: p, name: p.split('/').pop(), type: p.endsWith('mp4') ? 'video' : 'photo', width: 1920, height: 1080, durationUs: p.endsWith('mp4') ? 8e6 : 0 }));
const AUD = [{ path: '/demo/media/voix-off.wav', name: 'voix-off.wav', type: 'audio', durationUs: 30e6 }, { path: '/demo/media/musique-douce.m4a', name: 'musique-douce.m4a', type: 'audio', durationUs: 95e6 }];
const L = (kind, names, favs) => names.map((n, i) => ({ id: kind + i, kind, name: n, category: '', available: i % 7 !== 6, favorite: favs.includes(i), clip: true, track: kind !== 'transition', sources: ['ELPO Favoris'], reason: 'Ressource absente' }));
const LIB = { transitions: L('transition', ['Fondu enchaîné', 'Fondu au noir', 'Flou', 'Glisser à gauche', 'Zoom doux', 'Lumière', 'Balayage', 'Rideau', 'Cercle', 'Mélange'], [0, 2, 4]),
  effects: L('effect', ['Grain de film', 'Lueur dorée', 'Particules', 'Vignette', 'Halo', 'Poussière', 'Rayons', 'Bokeh'], [1, 3]),
  filters: L('filter', ['Chaud', 'Cinéma', 'Doux', 'Ivoire', 'Nuit bleue', 'Sépia', 'Contraste'], [1]) };
let jobs = [], tick = 0;
const ok = result => Promise.resolve({ ok: true, result });
window.elpo = { status: () => ok({ root: ROOT, initialized: true, platform: 'demo', version: '0.5.0', preferences: { motion: 'kenburns', amount: .08, favorites: { transitions: true } }, styles: { 'Prière douce': { motion: 'kenburns', transitionIds: ['transition0'], effectIds: [], filterIds: ['filter1'] } }, favorites: { transitions: [], effects: [], filters: [] }, exportSettings: { outputDir: '/Users/elpo/Movies/Exports ELPO', quality: 'high' }, pilot: { tile: { x: 412, y: 318 }, exportDir: '/Users/elpo/Movies/CapCut Exports', openWith: 'double', launchSeconds: 12, openSeconds: 8, dialogSeconds: 3, stableSeconds: 4, timeoutMinutes: 60 }, history: [{ name: 'Béatitudes', at: Date.now() - 36e5, engine: 'elpo', output: '/x.mp4' }], ffmpeg: { version: '7.1', ffmpeg: '/opt/homebrew/bin/ffmpeg', encoders: { h264_videotoolbox: true }, filters: { subtitles: true } } }),
  overview: () => ok(PROJECTS), mediaSources: () => ok(URLS), chooseRoot: () => ok(null), preferences: () => ok(true), styles: () => ok({}), favorite: () => ok({ transitions: [], effects: [], filters: [] }), openCapcut: () => ok(null), openBackups: () => ok(null),
  subtitles: () => ok(true), chooseDir: () => ok('/Users/elpo/Movies/Exports ELPO'), exportSettings: () => ok(true), jobs: () => ok({ export: [], pilot: [] }), pilotSettings: v => ok(v), pilotAccess: () => ok(true), ffmpeg: () => ok(null),
  exportStart: ({ projects }) => { jobs.push(...projects.map((p, i) => ({ id: p.path, project: p.path, name: p.name, status: i ? 'queued' : 'rendering', stage: i ? 'En attente' : 'Plan 3 / 9', progress: i ? 0 : .34, size: '1920×1080' }))); listener && listener({ type: 'export', data: jobs }); return ok(jobs.map(j => j.id)); },
  exportCancel: () => ok(true), exportClear: () => ok([]), pilotStart: () => ok(true), pilotStop: () => ok(true), reveal: () => ok(true), clearFlowFolder: () => ok(null), chooseFlowFolder: () => ok(null),
  loadFile: type => ok(type === 'scenes' ? null : { name: 'voix-off.srt', path: '/x.srt', text: '1\n00:00:00,000 --> 00:00:05,500\nSeigneur, au commencement de ce jour,\n\n2\n00:00:06,000 --> 00:00:11,000\nje remets entre tes mains mes pensées.\n\n3\n00:00:11,500 --> 00:00:17,000\nQue ta lumière éclaire mes pas.\n\n4\n00:00:17,500 --> 00:00:23,000\nDonne-moi la paix du cœur.\n\n5\n00:00:23,500 --> 00:00:29,000\nAmen.' }),
  export: () => ok(true), on: cb => { listener = cb; },
  engine: (action, args = {}) => {
    if (action === 'running') return ok('closed');
    if (action === 'inspect') { const p = PROJECTS.find(x => x.path === args.project); return ok({ path: p.path, name: p.name, fps: 30, canvas: p.canvas, visuals: VIS, audios: AUD, nonempty: p.nonempty, suggestedPlacement: 'even' }); }
    if (action === 'library') return ok(LIB);
    if (['catalog', 'recover'].includes(action)) return ok([]);
    if (action === 'backups') return ok([{ id: 'b1', project: PROJECTS[2].path, name: 'Intention du soir', created: Date.now() - 72e5, status: 'committed' }]);
    if (action === 'thumbnail') return ok(URLS[args.file]);
    if (action === 'preview') {
      try {
        const o = args.options;
        const plan = planScenes(VIS, 30e6, { placement: o.placement, scenes: o.scenesText ? parseScenes(o.scenesText) : null, captions: o.srtText ? parseSrt(o.srtText) : [], timestamps: o.timestampsText ? parseTimestampList(o.timestampsText) : [] });
        const clips = expandVideos(plan, { videoPolicy: 'repeat' });
        return ok({ token: 'DEMO', name: 'Démo', scenes: plan.length, clips: clips.length, durationUs: 30e6, fps: 30, canvas: { width: 1920, height: 1080 }, audio: 'voix-off.wav', audioPath: '/demo/media/voix-off.wav', transitions: 3, effects: 0, filters: 1,
          playbackClips: clips.map(c => ({ path: c.item.path, type: c.item.type, startUs: c.startUs, endUs: c.endUs, sourceStartUs: c.sourceStartUs, scene: c.index + 1 })),
          rows: plan.map(s => ({ index: s.index + 1, name: s.item.name, path: s.item.path, type: s.item.type, startUs: s.startUs, endUs: s.endUs, durationUs: s.durationUs, sourceInUs: s.sourceInUs || 0, clips: clips.filter(c => c.index === s.index).length, text: s.text })),
          filesToWrite: ['Démonstration : aucun fichier réel'], warnings: ['Démonstration d’interface : aucune connexion à CapCut.', 'Transitions : tes favoris (3).', 'Raccords alignés sur les images du projet.'] });
      } catch (e) { return Promise.resolve({ ok: false, error: { message: e.message } }); }
    }
    return Promise.resolve({ ok: false, error: { message: 'Action indisponible dans la démonstration.' } });
  } };
let listener = null;
'''.replace('DEMO_URLS', json.dumps(urls)).replace('DEMO_COVERS', json.dumps(covers))
script = common + mock + code('renderer/app.js')
html = html.replace('<script type="module" src="app.js"></script>', '<script>'+script.replace('</script', '<\\/script')+'</script>')
output.write_text(html)
print(output, output.stat().st_size)
