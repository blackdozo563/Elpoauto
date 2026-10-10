// Interpretation of macOS accessibility snapshots; no screen coordinates invented here.
const fold = value => String(value || '').normalize('NFC').trim().toLocaleLowerCase();
const labels = node => [node.name, node.description, node.value].filter(v => typeof v === 'string').map(fold);
// System Events lists the front window first. A project in a background window
// must not authorize keystrokes in a Studio page in front of it.
// CapCut 9 also floats a small untitled window (the EditPilot bubble, ~183×88) above
// the editor: it is never the page being driven, so small windows are skipped.
const usable = w => !w?.frame || (w.frame.width >= 400 && w.frame.height >= 300);
const front = ui => (ui?.windows || []).filter(usable).slice(0, 1);
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

// CapCut 9 does not expose visible texts such as "Projets" on its home page: it exposes
// internal automation identifiers instead (independent of the interface language).
const HOME_IDS = ['homepagedraft', 'homepagestartprojectname', 'homepagestartprojectdesp'];
const HOME_TEXTS = ['créer un projet', 'create project', 'nouveau projet', 'new project'];
const isHome = items => has(items, HOME_IDS) ||
  (has(items, ['projets', 'projects']) && has(items, HOME_TEXTS));

export function homeIsOpen(ui) {
  return front(ui).some(w => isHome(w.nodes || []));
}

// CapCut 9 editor identifiers. Its window is titled "CapCut", not after the project:
// the project name is then confirmed on the export sheet (exportTarget).
const EDITOR_IDS = ['mainwindowtitlebarexportbtn', 'maintimelineroot'];
export function editorIsOpen(ui) {
  return front(ui).some(w => has(w.nodes || [], EDITOR_IDS) && !isHome(w.nodes || []));
}

export function projectIsOpen(ui, name) {
  const expected = fold(name);
  if (!expected) return false;
  if (editorIsOpen(ui)) return true;
  return front(ui).some(w => {
    const items = w.nodes || [];
    // A project on the home page is not an open editor. Match the full name,
    // not a substring (TEST must not match TESTO).
    const title = fold(w.title).replace(/^capcut\s*[-–—:]\s*/u, '').replace(/\s*[-–—:]\s*capcut$/u, '');
    const named = title === expected || has(items, [expected]);
    const editor = has(items, EXPORT) && !has(items, HOME_IDS) && !has(items, ['créer un projet', 'create project']);
    return named && editor;
  });
}

// CapCut 9 shows its export settings as a sheet inside the editor window.
const DIALOG_IDS = ['exportdialog'], EXPORT_OK = ['exportokbtn'];
export const EXPORT_BUTTON = EXPORT_OK;

// Full path of the file CapCut is about to write, read from the export sheet
// (shown next to ExportPathInput), or null when CapCut does not expose it.
export function exportTarget(ui) {
  for (const n of nodes(ui)) for (const v of [n.name, n.description, n.value]) {
    if (typeof v === 'string' && /^\/.+\.(mp4|mov|m4v)$/iu.test(v.trim())) return v.trim();
  }
  return null;
}
// "TESTO(1).mp4" is CapCut's name for TESTO when TESTO.mp4 already exists.
export function targetMatches(file, name) {
  const base = fold(String(file).split('/').pop().replace(/\.[^.]+$/u, '')).replace(/\s*\(\d+\)$/u, '');
  return !!fold(name) && base === fold(name);
}

export function exportDialogIsOpen(ui) {
  return front(ui).some(w => {
    const items = w.nodes || [];
    if (has(items, DIALOG_IDS) && has(items, EXPORT_OK)) return true;
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
