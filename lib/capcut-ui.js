// Interpretation of macOS accessibility snapshots; no screen coordinates invented here.
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'").replace(/…|\.\.\./g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const rawLabels = node => [node.name, node.description, node.title, node.value].filter(v => typeof v === 'string');
const labels = node => rawLabels(node).map(fold);
// UI labels tolerate accents/ellipsis, but project identity must not: Prière
// and Priere can be two different projects.
const identity = value => String(value || '').normalize('NFC').trim();
// System Events lists the front window first. A project in a background window
// must not authorize keystrokes in a Studio page in front of it.
const front = ui => (ui?.windows || []).slice(0, 1);
const nodes = ui => front(ui).flatMap(w => w.nodes || []);
const has = (items, names) => items.some(n => labels(n).some(s => names.includes(s)));
const EXPORT = ['exporter', 'export'];
const HOME_CREATE = ['creer un projet', 'create project', 'create a project', 'create new project', 'create a new project', 'nouveau projet', 'new project'];

export function controlPoint(ui, names) {
  const frame = front(ui)[0]?.frame;
  const matches = nodes(ui).filter(n => has([n], names.map(fold)) && n.enabled !== false && n.visible !== false &&
    n.position?.length === 2 && n.position.every(Number.isFinite) && n.size?.length === 2 && n.size.every(v => Number.isFinite(v) && v > 0) &&
    (!validFrame(frame) || (n.position[0] + n.size[0] / 2 > frame.x && n.position[0] + n.size[0] / 2 < frame.x + frame.width &&
      n.position[1] + n.size[1] / 2 > frame.y && n.position[1] + n.size[1] / 2 < frame.y + frame.height)));
  // Prefer the button containing a label to the label itself.
  const node = matches.find(n => n.role === 'AXButton') || matches[0];
  return node ? { x: node.position[0] + node.size[0] / 2, y: node.position[1] + node.size[1] / 2 } : null;
}

export function projectTarget(ui, name) {
  const expected = identity(name), w = front(ui)[0];
  if (!expected || !w || !homeIsOpen(ui)) return null;
  const n = (w.nodes || []).find(n => Number.isInteger(n.index) && n.enabled !== false && rawLabels(n).some(v => identity(v) === expected));
  if (!n) return null;
  const label = [n.name, n.title, n.value].find(v => typeof v === 'string' && identity(v) === expected);
  return label ? { windowIndex: w.index, index: n.index, label } : null;
}

export function projectPoint(ui, name) {
  const w = front(ui)[0];
  if (!w) return null;
  return controlPoint({ windows: [{ ...w, nodes: (w.nodes || []).filter(n => rawLabels(n).some(v => identity(v) === identity(name))) }] }, [name]);
}

export function projectScroll(ui, name) {
  const w = front(ui)[0], frame = w?.frame;
  if (!validFrame(frame) || !homeIsOpen(ui)) return null;
  const n = (w.nodes || []).find(n => rawLabels(n).some(v => identity(v) === identity(name)) && n.position?.every(Number.isFinite) && n.size?.every(Number.isFinite));
  if (!n || n.size[0] <= 0 || n.size[1] <= 0) return null;
  const x = n.position[0] + n.size[0] / 2, y = n.position[1] + n.size[1] / 2;
  if (x <= frame.x || x >= frame.x + frame.width || frame.height < 160) return null;
  if (y >= frame.y + frame.height) return { point: { x, y: frame.y + frame.height - 60 }, lines: -8 };
  if (y <= frame.y) return { point: { x, y: frame.y + 60 }, lines: 8 };
  return null;
}

export function homeIsOpen(ui) {
  // The project grid can be below the viewport (CapCut's promotional panels
  // change its position). Its heading is not a necessary home marker.
  return front(ui).some(w => has((w.nodes || []).filter(n => n.enabled !== false), HOME_CREATE));
}

export function projectIsOpen(ui, name) {
  const expected = identity(name);
  if (!expected) return false;
  return front(ui).some(w => {
    const items = w.nodes || [];
    // A project on the home page is not an open editor. Match the full name,
    // not a substring (TEST must not match TESTO).
    const title = identity(w.title).replace(/^capcut\s*[-–—:]\s*/iu, '').replace(/\s*[-–—:]\s*capcut$/iu, '');
    const named = title === expected || items.some(n => rawLabels(n).some(v => identity(v) === expected));
    const editor = has(items, EXPORT) && !has(items, HOME_CREATE);
    return named && editor;
  });
}

export function exportDialogIsOpen(ui) {
  return front(ui).some(w => {
    const items = w.nodes || [];
    return has(items, EXPORT) &&
      items.some(n => labels(n).some(s => /^(resolution)(\s*[:：])?$/u.test(s))) &&
      items.some(n => labels(n).some(s => /^(format|codec|frequence d'images|frame rate|bitrate|debit binaire)(\s*[:：])?$/u.test(s)));
  });
}

export function exportIsRunning(ui) {
  return front(ui).some(w => {
    const items = w.nodes || [];
    return items.some(n => n.role === 'AXProgressIndicator') &&
      (/^export/u.test(fold(w.title)) || items.some(n => labels(n).some(s => /^(exportation|exporting|export progress)(\b|\s)/u.test(s))));
  });
}

export function uiSummary(ui) {
  const window = front(ui)[0];
  if (!window) return 'aucune fenêtre lisible';
  const readable = [...new Set((window.nodes || []).flatMap(n => [n.name, n.title, n.value]).filter(v => typeof v === 'string' && v.trim()))].slice(0, 12);
  return `${window.title || '(fenêtre sans titre)'} · ${(window.nodes || []).length} éléments${ui.truncated ? ' (lecture tronquée)' : ''} · ${readable.join(' / ').slice(0, 350) || 'aucun libellé lisible'}`;
}

export function validFrame(frame) {
  return frame && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) && frame.width > 0 && frame.height > 0;
}
