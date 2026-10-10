// Interpretation of macOS accessibility snapshots; no screen coordinates invented here.
const fold = value => String(value || '').normalize('NFC').trim().toLocaleLowerCase();
const labels = node => [node.name, node.description, node.value].filter(v => typeof v === 'string').map(fold);
// System Events lists the front window first. A project in a background window
// must not authorize keystrokes in a Studio page in front of it.
const front = ui => (ui?.windows || []).slice(0, 1);
const nodes = ui => front(ui).flatMap(w => w.nodes || []);
const has = (items, names) => items.some(n => labels(n).some(s => names.includes(s)));
const EXPORT = ['exporter', 'export'];

export function controlPoint(ui, names) {
  const matches = nodes(ui).filter(n => has([n], names.map(fold)) && n.enabled !== false && n.visible !== false &&
    n.position?.length === 2 && n.position.every(Number.isFinite) && n.size?.length === 2 && n.size.every(v => Number.isFinite(v) && v > 0));
  // Prefer the button containing a label to the label itself.
  const node = matches.find(n => n.role === 'AXButton') || matches[0];
  return node ? { x: node.position[0] + node.size[0] / 2, y: node.position[1] + node.size[1] / 2 } : null;
}

export function homeIsOpen(ui) {
  return front(ui).some(w => has(w.nodes || [], ['projets', 'projects']) &&
    has(w.nodes || [], ['créer un projet', 'create project', 'nouveau projet', 'new project']));
}

export function projectIsOpen(ui, name) {
  const expected = fold(name);
  if (!expected) return false;
  return front(ui).some(w => {
    const items = w.nodes || [];
    // A project on the home page is not an open editor. Match the full name,
    // not a substring (TEST must not match TESTO).
    const title = fold(w.title).replace(/^capcut\s*[-–—:]\s*/u, '').replace(/\s*[-–—:]\s*capcut$/u, '');
    const named = title === expected || has(items, [expected]);
    const editor = has(items, EXPORT) && !has(items, ['créer un projet', 'create project']);
    return named && editor;
  });
}

export function exportDialogIsOpen(ui) {
  return front(ui).some(w => {
    const items = w.nodes || [];
    return has(items, EXPORT) &&
      items.some(n => labels(n).some(s => /^(résolution|resolution)(\s*[:：])?$/u.test(s))) &&
      items.some(n => labels(n).some(s => /^(format|codec|fréquence d’images|fréquence d'images|frame rate|bitrate|débit binaire)(\s*[:：])?$/u.test(s)));
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
  return (ui?.windows || []).map(w => w.title || '(fenêtre sans titre)').join(' · ') || 'aucune fenêtre lisible';
}

export function validFrame(frame) {
  return frame && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) && frame.width > 0 && frame.height > 0;
}
