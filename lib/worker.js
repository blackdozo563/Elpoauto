import { parentPort } from 'node:worker_threads';
import { Engine, inspect, catalog, capcutState } from './engine.js';
import { listProjects, canonicalRoot } from './projects.js';
let engine;
parentPort.on('message', ({ id, action, args }) => {
  try {
    let result;
    if (action === 'init') { engine = new Engine(args); result = true; }
    else if (action === 'running') { result = capcutState(); }
    else {
      if (!engine) throw new Error('Choisis le dossier de projets.');
      if (action === 'list') result = listProjects(engine.root);
      else if (action === 'inspect') result = engine.inspect(args.project);
      else if (action === 'setVisualFolder') result = engine.setVisualFolder(args.project, args.folder);
      else if (action === 'catalog') result = catalog(engine.root).map(({ template, ...info }) => info);
      else if (action === 'preview') result = engine.preview(args.project, args.options);
      else if (action === 'commit') result = engine.commit(args.token);
      else if (action === 'backups') result = engine.backups(args.project || null);
      else if (action === 'restore') result = engine.restore(args.id);
      else if (action === 'recover') result = engine.recover();
      else if (action === 'thumbnail') result = engine.thumbnail(args.file);
      else throw new Error('Action inconnue.');
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) { parentPort.postMessage({ id, ok: false, error: { code: e.code || 'ERROR', message: e.message, details: e.details || [] } }); }
});
