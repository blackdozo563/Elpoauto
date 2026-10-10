// Interpretation of macOS accessibility snapshots; no screen coordinates invented here.
const fold = value => String(value || '').normalize('NFC').trim().toLocaleLowerCase();
const labels = node => [node.name, node.description, node.value].filter(v => typeof v === 'string').map(fold);
// System Events lists the front window first. A project in a background window
// must not authorize keystrokes in a Studio page in front of it.
// CapCut 9 also floats a small untitled window (the EditPilot bubble, ~183×88) above
// the editor: it is never the page being driven, so small windows are skipped.
const usable = w => !w?.frame || (w.frame.width >= 400 && w.frame.height >= 300);
const front = ui => (ui?.windows || []).filter(usable).slice(0, 1);
const usableWindows = ui => (ui?.windows || []).filter(usable);
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

// The editor's own "Export" button, exposed by CapCut 9 as
// "MainWindowTitleBarExportBtn" (an AXStaticText with a real frame, seen in a
// capture at position [1272, 97], size [77, 22]). Clicking it opens the export
// settings without depending on ⌘E being bound or on the keyboard layout.
export const EXPORT_OPEN_BUTTON = ['mainwindowtitlebarexportbtn'];
export function exportOpenPoint(ui) { return controlPoint(ui, EXPORT_OPEN_BUTTON); }

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

// CapCut 9 shows its export settings as a sheet inside the editor window. Every one
// of these identifiers belongs to that sheet and to nothing else in CapCut 9 (all
// four appear in a real capture); any single one of them is enough to say the sheet
// is on screen, because a read that stops early may not have reached the others.
// The click is a separate question: it needs a real `ExportOkBtn` frame.
const DIALOG_IDS = ['exportdialog', 'exportokbtn', 'exportfilenameinput', 'exportpathinput'];
const EXPORT_OK = ['exportokbtn'];
export const EXPORT_BUTTON = EXPORT_OK;
const sheetIn = items => has(items, DIALOG_IDS) ||
  (has(items, EXPORT) &&
    items.some(n => labels(n).some(s => /^(résolution|resolution)(\s*[:：])?$/u.test(s))) &&
    items.some(n => labels(n).some(s => /^(format|codec|fréquence d’images|fréquence d'images|frame rate|bitrate|débit binaire)(\s*[:：])?$/u.test(s))));

// The window showing the export settings, or null. CapCut lists the sheet inside the
// editor window, but a build that floats it as its own window must be found too: only
// the editor's window is "front", and looking at the front window alone is exactly
// what made a real run report "dialog not confirmed" while the sheet was open.
export function exportDialogWindow(ui) {
  return usableWindows(ui).find(w => sheetIn(w.nodes || [])) || null;
}
// Click point of the sheet's real Export button, or null when CapCut has not exposed
// a usable frame for it (the caller then falls back to the calibrated point / Return).
export function exportOkPoint(ui) {
  const w = exportDialogWindow(ui);
  return w ? controlPoint({ windows: [w] }, EXPORT_BUTTON) : null;
}

// Full path of the file CapCut is about to write, read from the export sheet
// (shown next to ExportPathInput), or null when CapCut does not expose it.
export function exportTarget(ui) {
  const sheet = exportDialogWindow(ui);
  const where = sheet ? sheet.nodes || [] : usableWindows(ui).flatMap(w => w.nodes || []);
  for (const n of where) for (const v of [n.name, n.description, n.value]) {
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
  return !!exportDialogWindow(ui);
}

export function exportIsRunning(ui) {
  return front(ui).some(w => {
    const items = w.nodes || [];
    return items.some(n => n.role === 'AXProgressIndicator') &&
      (/^export/u.test(fold(w.title)) || items.some(n => labels(n).some(s => /^(exportation|exporting|export progress)(\b|\s)/u.test(s))));
  });
}

// ---- Following CapCut's own export progress -------------------------------------
// CapCut shows its export progress as a progress bar and/or a "45%" text. Each one is
// a reading { key, pct, strong }. The key is the node's place on screen, so the same
// control is recognised from one read to the next.
// strong: a real AXProgressIndicator, or a label that speaks of export/progress.
const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s*%/u;
const EXPORTISH = /export|progress|progression|encod|rendu|render/u;
export function progressReadings(ui) {
  const out = [];
  for (const w of usableWindows(ui)) {
    const items = w.nodes || [];
    const windowStrong = EXPORTISH.test(fold(w.title));
    for (const n of items) {
      const where = Array.isArray(n.position) ? n.position.map(v => Math.round(v)).join(',') : '?';
      const ls = labels(n);
      if (n.role === 'AXProgressIndicator') {
        const v = typeof n.value === 'number' ? n.value : Number.parseFloat(String(n.value ?? '').replace(',', '.'));
        if (!Number.isFinite(v)) continue;
        const max = Number.isFinite(n.max) && n.max > 0 ? n.max : (v <= 1 ? 1 : 100);
        out.push({ key: `bar@${where}`, pct: Math.max(0, Math.min(100, (v / max) * 100)), strong: true });
        continue;
      }
      for (const s of ls) {
        const m = PERCENT.exec(s);
        if (!m) continue;
        const pct = Number.parseFloat(m[1].replace(',', '.'));
        if (!(pct >= 0 && pct <= 100)) continue;
        out.push({ key: `text@${n.role}@${where}`, pct, strong: windowStrong || ls.some(l => EXPORTISH.test(l)) });
        break;
      }
    }
  }
  return out;
}
// The settings view of the export sheet: its « Exporter » button (ExportOkBtn) is
// visible. CapCut 9 hides it while the same sheet shows the export progress.
export function exportSettingsShown(ui) {
  return usableWindows(ui).some(w => has(w.nodes || [], EXPORT_OK));
}
// « Fermer » of CapCut's end-of-export panel, or null. Searched only in a window that
// shows that panel; « Partager », TikTok, YouTube, « Connexion » and « Ouvrir le dossier »
// are never returned, nor anything that starts an export.
const NEVER_CLICK = /partager|share|tiktok|youtube|connexion|login|ouvrir le dossier|open folder|export/u;
export function finishedClosePoint(ui) {
  for (const w of usableWindows(ui)) {
    const items = w.nodes || [];
    if (![w.title, ...items.flatMap(labels)].some(s => FINISHED.test(fold(s)))) continue;
    const hits = items.filter(n => {
      if (!placed(n) || n.enabled === false || n.visible === false) return false;
      const ls = labels(n);
      if (ls.some(s => NEVER_CLICK.test(s) && !/close(btn|button)$/u.test(s))) return false;
      return ls.some(s => s === 'fermer' || s === 'close' || /close(btn|button)$/u.test(s));
    });
    const n = hits.find(h => h.role === 'AXButton') || hits[0];
    if (n) return { x: Math.round(n.position[0] + n.size[0] / 2), y: Math.round(n.position[1] + n.size[1] / 2) };
  }
  return null;
}
// CapCut's "export finished" panel, recognised by its wording when exposed.
// CapCut 9 (real capture, 10 Oct 2026): the export sheet ends on a share panel
// « La vidéo est enregistrée sur ton bureau ou ton ordinateur portable. Tu peux la
// partager dès maintenant. » with TikTok / YouTube, « Ouvrir le dossier », « Fermer »
// and « Partager ».
const FINISHED = /(export(ation)?|vidéo)\s+(est\s+)?(terminée?|réussie?|complete|completed|finished|done|successful|enregistrée?)|exporté(e)? avec succès|export(ed)? successfully|enregistrée sur ton bureau|video (is|has been) saved|saved to your (desktop|computer)/u;
export function exportFinishedShown(ui) {
  return usableWindows(ui).some(w => [w.title, ...(w.nodes || []).flatMap(labels)].some(s => FINISHED.test(fold(s))));
}
// Turns successive reads into { percent, done }. `baseline` is the read of the export
// sheet taken BEFORE clicking Export: a "100%" already on screen then (zoom, opacity,
// volume…) never moves and is ignored, so it can never be mistaken for the end.
// done is one of: '100 %' — the bar/percentage reached the end after being seen lower;
//   'fenêtre de fin' — CapCut shows its export-finished panel;
//   'progression disparue' — a progress seen earlier is gone from two complete reads.
export function exportTracker(baseline = null) {
  const first = new Map();
  for (const r of baseline ? progressReadings(baseline) : []) if (!first.has(r.key)) first.set(r.key, { pct: r.pct, baseline: true });
  let seen = false, gone = 0, last = null, settingsLeft = false;
  return {
    get seen() { return seen; },
    get percent() { return last; },
    update(ui) {
      const complete = !!ui && !ui.timedOut && !ui.truncated && (ui.windows || []).length > 0;
      const settings = exportSettingsShown(ui);
      if (complete && !settings) settingsLeft = true;
      // Progress seen, then the « Exporter » button back: CapCut returned its sheet to
      // the settings view, which it does once the export is over.
      if (seen && settingsLeft && settings) return { percent: last, done: 'retour à la feuille de réglages' };
      const readings = progressReadings(ui);
      for (const r of readings) if (!first.has(r.key)) first.set(r.key, { pct: r.pct, baseline: false });
      // A reading counts when it is a real progress control, or when it moved, or when
      // it appeared after the click below 100 % (the progress panel starting).
      const live = readings.filter(r => {
        const f = first.get(r.key);
        if (f.baseline && f.pct === r.pct) return false; // on screen before the export, unchanged
        return r.strong || f.pct !== r.pct || (!f.baseline && r.pct < 99.5);
      });
      if (live.length) {
        seen = true; gone = 0;
        const top = live.reduce((a, b) => (b.pct > a.pct ? b : a));
        last = top.pct;
        const f = first.get(top.key), reachedEnd = top.pct >= 99.5 && (f.pct < 99.5 || (top.strong && !f.baseline));
        if (reachedEnd) return { percent: 100, done: '100 %' };
        if (exportFinishedShown(ui)) return { percent: top.pct, done: 'fenêtre de fin' };
        return { percent: top.pct, done: null };
      }
      if (exportFinishedShown(ui)) return { percent: last, done: 'fenêtre de fin' };
      if (seen && complete) {
        gone++;
        if (gone >= 2) return { percent: last, done: 'progression disparue' };
      }
      return { percent: null, done: null };
    },
  };
}

// Control that dismisses what keeps CapCut from quitting once the export is over
// (its "export finished" panel). CapCut 9's identifiers for that panel are not known
// yet, so visible labels and identifiers ending in close/done/finish button are
// accepted. Anything that starts an export (ExportOkBtn, MainWindowTitleBarExportBtn)
// is never returned. Called only after the exported file has been verified.
const CLOSE_TEXTS = ['fermer', 'close', 'terminé', 'terminer', 'done', 'ok', 'annuler', 'cancel', '×'];
const CLOSE_ID = /(close|done|finish|complete|cancel)(btn|button)$/u;
const STARTS_EXPORT = ['exportokbtn', 'mainwindowtitlebarexportbtn'];
export function closePoint(ui) {
  const candidates = [];
  for (const w of usableWindows(ui)) for (const n of w.nodes || []) {
    if (!placed(n) || n.enabled === false || n.visible === false) continue;
    const ls = labels(n);
    if (ls.some(s => STARTS_EXPORT.includes(s))) continue;
    const byId = ls.some(s => CLOSE_ID.test(s)), byText = ls.some(s => CLOSE_TEXTS.includes(s));
    if (byId || byText) candidates.push({ n, rank: (byId ? 0 : 2) + (n.role === 'AXButton' ? 0 : 1) });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const n = candidates[0]?.n;
  return n ? { x: Math.round(n.position[0] + n.size[0] / 2), y: Math.round(n.position[1] + n.size[1] / 2) } : null;
}

// Which CapCut page each window shows, so that a failure says what was really on screen.
function pageOf(w) {
  const items = w.nodes || [];
  if (!usable(w)) return 'petite fenêtre flottante ignorée';
  if (sheetIn(items)) return 'feuille d’export';
  if (isHome(items)) return 'accueil';
  if (has(items, EDITOR_IDS)) return 'éditeur';
  return 'page non reconnue (Studio ou autre)';
}
export function uiSummary(ui) {
  const windows = (ui?.windows || []).map(w => `${w.title || '(fenêtre sans titre)'} [${pageOf(w)}]`).join(' · ') || 'aucune fenêtre lisible';
  const partial = [];
  if (ui?.timedOut) partial.push('lecture partielle (délai de lecture atteint)');
  else if (ui?.truncated) partial.push('lecture partielle (limite d’éléments atteinte)');
  // A read is never "everything on screen": say how much of it was seen, so that a
  // missing control is read as "not reached" and not as "not exposed by CapCut".
  if (partial.length && Number.isFinite(ui?.nodesRead)) {
    partial.push(`${ui.nodesRead} contrôle(s) lu(s)` + (ui?.pruned ? `, timeline exclue (${ui.pruned})` : '') +
      (ui?.cappedBranches ? `, ${ui.cappedBranches} panneau(x) limité(s)` : ''));
  }
  return windows + (partial.length ? ` · ${partial.join(' · ')}` : '');
}

// Automation identifiers actually seen, first ones first. A failure that lists them
// tells which page CapCut really shows, instead of guessing at a missing button.
export function uiIdentifiers(ui, limit = 24) {
  const seen = new Set();
  for (const w of ui?.windows || []) {
    if (!usable(w)) continue;
    for (const n of w.nodes || []) for (const label of [n.description, n.name]) {
      const id = fold(label);
      if (id && !seen.has(id)) seen.add(id);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

export function validFrame(frame) {
  return frame && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(frame[k])) && frame.width > 0 && frame.height > 0;
}
