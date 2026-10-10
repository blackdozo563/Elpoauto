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

// Project tiles of the home page ("HomePageDraft"), first tile first (top row, then left).
// Only tiles whose centre lies inside the window are returned: CapCut lists the
// "Projets" row even when it is scrolled below the visible part of the home page.
const placed = n => n.position?.length === 2 && n.position.every(Number.isFinite) &&
  n.size?.length === 2 && n.size.every(v => Number.isFinite(v) && v > 0);
const DRAFT = ['homepagedraft'];
const draftNodes = ui => nodes(ui).filter(n => has([n], DRAFT));
export function placedDrafts(ui) {
  return draftNodes(ui).filter(placed);
}
// Visible part of a rectangle inside the window (below the title bar), or null when
// less than 40×40 points of it can be clicked.
function visiblePart(f, left, top, width, height) {
  let l = left, t = top, r = left + width, b = top + height;
  if (f) { l = Math.max(l, f.x); r = Math.min(r, f.x + f.width); t = Math.max(t, f.y + 40); b = Math.min(b, f.y + f.height - 10); }
  return r - l >= 40 && b - t >= 40 ? { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) } : null;
}
// Click point of each project tile, first tile first. The point is the centre of the
// tile's VISIBLE part: right after launch CapCut 9 shows the "Projets" row cut by the
// bottom of the window (tile centre 819, window bottom 832 in a real capture).
export function draftTiles(ui) {
  const f = front(ui)[0]?.frame;
  const seen = new Set();
  return placedDrafts(ui).filter(n => n.size[1] >= 60)
    .map(n => visiblePart(f, n.position[0], n.position[1], n.size[0], n.size[1]))
    .filter(p => p && !seen.has(`${p.x},${p.y}`) && seen.add(`${p.x},${p.y}`))
    .sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x));
}
// CapCut 9 also names each tile: "HomePageDraftTitle:<project name>", a small label at the
// bottom-left of the tile, exposed only when the tile is fully visible. CapCut sometimes
// gives such a node the frame of ANOTHER tile, so only small title labels are trusted and
// the click aims at the thumbnail just above the label (not the label: a double-click on a
// name may start renaming). Returns that point for the exact project name (TESTO is not
// "TESTO (1)"), null if it is not visible, or undefined when no title is exposed.
const TITLE = 'homepagedrafttitle:';
const titleNodes = ui => nodes(ui).filter(n => placed(n) && n.size[1] <= 30 && labels(n).some(s => s.startsWith(TITLE)));
export function draftTitles(ui) {
  return [...new Set(titleNodes(ui).flatMap(labels).filter(s => s.startsWith(TITLE)).map(s => s.slice(TITLE.length)))];
}
export function draftTileFor(ui, name) {
  const titles = titleNodes(ui);
  if (!titles.length) return undefined;
  const expected = TITLE + fold(name);
  const f = front(ui)[0]?.frame;
  for (const t of titles.filter(n => labels(n).includes(expected))) {
    // The thumbnail occupies the 140 points above the label.
    const p = visiblePart(f, t.position[0], t.position[1] - 120, Math.max(t.size[0], 40), 100);
    // CapCut's HomePageDraft list can miss tiles: the label geometry is the reference.
    if (p) return p;
  }
  return null;
}

// True when a point falls on a project tile (used to refuse a calibrated point
// that lands elsewhere, e.g. on "Studio de conceptions").
export function pointOnDraft(ui, p) {
  const tiles = placedDrafts(ui).filter(n => n.size[1] >= 60);
  if (!tiles.length) return null;
  return tiles.some(n => p.x >= n.position[0] && p.x <= n.position[0] + n.size[0] &&
    p.y >= n.position[1] && p.y <= n.position[1] + n.size[1]);
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

// Which CapCut page each window shows, so that a failure says what was really on screen.
function pageOf(w) {
  const items = w.nodes || [];
  if (!usable(w)) return 'petite fenêtre flottante ignorée';
  if (has(items, DIALOG_IDS) && has(items, EXPORT_OK)) return 'feuille d’export';
  if (isHome(items)) return 'accueil';
  if (has(items, EDITOR_IDS)) return 'éditeur';
  return 'page non reconnue (Studio ou autre)';
}
export function uiSummary(ui) {
  return (ui?.windows || []).map(w => `${w.title || '(fenêtre sans titre)'} [${pageOf(w)}]`).join(' · ') || 'aucune fenêtre lisible';
}

export function validFrame(frame) {
  return frame && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) && frame.width > 0 && frame.height > 0;
}
