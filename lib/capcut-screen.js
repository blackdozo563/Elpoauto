// What CapCut 9.3.0 shows, read from a native accessibility snapshot: the output of
// `capcut-ax snapshot` during a run, or the frames of `capcut-ax record`.
//
// Every label below was observed on a real CapCut 9.3.0 cycle (French interface,
// 11 October 2026, tests/fixtures/capcut-9.3.0-cycle.json). They are CapCut's own
// automation names, exposed in AXDescription or AXTitle, independent of the language.
//
//   home              HomePageDraft (one per project tile, 134×174), HomePageDraftTitle:<name>
//                     (only while the tile is entirely visible), HomePageStartProjectDesp
//   editor            MainWindowTitleBarExportBtn (« Exporter », a static text without AXPress,
//                     drawn in CapCut's own title bar), totalProgress|hh:mm:ss:ff, MainTimeLineRoot
//   export-settings   modal AXSheet: ExportDialog, ExportFileNameInput, ExportPathInput, the full
//                     output path as a static text, automationcancel and ExportOkBtn (AXButton, AXPress)
//   exporting         the same sheet: « Exportation », ExportProgress:38.4% … 97.4%, an unnamed
//                     AXButton (its cancel button: never pressed). It never showed 100 %.
//   export-done       the same sheet: automationopenFolderBtn, publish_pc_btn (« Partager »: never
//                     pressed), automationcloseBtn (« Fermer »)
//   busy              CapCut answers cannotComplete while it switches pages (one read in a row)
//   no-sheet          a sheet-only read found no sheet (the page behind is not read)

export const LABELS = Object.freeze({
  tile: 'HomePageDraft', title: 'HomePageDraftTitle:', start: 'HomePageStartProjectDesp',
  editorExport: 'MainWindowTitleBarExportBtn', timeline: 'MainTimeLineRoot', duration: 'totalProgress|',
  dialog: 'ExportDialog', ok: 'ExportOkBtn', cancel: 'automationcancel', progress: 'ExportProgress:',
  close: 'automationcloseBtn', publish: 'publish_pc_btn', openFolder: 'automationopenFolderBtn',
});

export const fold = value => String(value ?? '').normalize('NFC').trim().toLocaleLowerCase();
const strings = n => [n?.title, n?.description, n?.identifier, typeof n?.value === 'string' ? n.value : null]
  .filter(s => typeof s === 'string' && s.length > 0);
const named = (n, label) => strings(n).includes(label);
const prefixed = (n, prefix) => strings(n).find(s => s.startsWith(prefix)) ?? null;
export const validFrame = f => !!f && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(f[k])) && f.width > 0 && f.height > 0;
const isMain = w => validFrame(w?.frame) && w.frame.width >= 400 && w.frame.height >= 300;
const OUTPUT = /^\/.+\.(mp4|mov|m4v)$/iu;
const PERCENT = /^ExportProgress:(\d{1,3}(?:\.\d+)?)%$/u;

// CapCut names the file after the project and adds "(1)" when that file exists; a
// project may itself be called "0920 (1)". Both readings are accepted (same rule as
// targetMatches in tools/capcut-ax/Driver.swift).
export function targetMatches(file, name) {
  const expected = fold(name);
  if (!expected) return false;
  const base = fold(String(file).split('/').pop().replace(/\.[^./]+$/u, ''));
  return base === expected || base.replace(/\s*\(\d+\)$/u, '') === expected;
}

// hh:mm:ss:ff of CapCut's « totalProgress » → seconds (frames counted at 30/s: < 1 s off).
export function timecodeSeconds(text) {
  const m = /(\d+):(\d{2}):(\d{2})(?::(\d{1,3}))?$/u.exec(String(text ?? ''));
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 30 : 0);
  return Number.isFinite(s) && s > 0 ? s : null;
}

// Visible, clickable part of a rectangle inside a window, or null below 40×40 points.
export function visiblePart(windowFrame, r) {
  if (!validFrame(r)) return null;
  let l = r.x, t = r.y, right = r.x + r.width, b = r.y + r.height;
  if (validFrame(windowFrame)) {
    l = Math.max(l, windowFrame.x + 2); right = Math.min(right, windowFrame.x + windowFrame.width - 2);
    t = Math.max(t, windowFrame.y + 2); b = Math.min(b, windowFrame.y + windowFrame.height - 10);
  }
  return right - l >= 40 && b - t >= 40 ? { x: Math.round((l + right) / 2), y: Math.round((t + b) / 2) } : null;
}
export const center = f => ({ x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) });

// Node lists per main window, the window's modal sheet(s) apart.
function layout(snapshot) {
  const windows = (snapshot?.windows || []).filter(isMain).map(w => {
    const nodes = Array.isArray(w.nodes) ? w.nodes : [];
    const sheets = nodes.filter(n => n.role === 'AXSheet');
    const inSheet = n => sheets.some(s => n.path?.startsWith(`${s.path}/`));
    return { frame: w.frame, title: w.title, nodes, sheets, sheet: nodes.filter(inSheet), page: nodes.filter(n => n.role !== 'AXSheet' && !inSheet(n)) };
  }).sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height);
  return windows;
}

// The screen CapCut shows. `reliable` says whether a read that does NOT show
// something may be taken as proof that it is absent.
export function readScreen(snapshot) {
  const s = snapshot || {};
  const out = { screen: 'unknown', reliable: false, frontmost: s.frontmost ?? null, labels: [] };
  if (s.trusted === false || s.code === 'NO_ACCESS') return { ...out, screen: 'no-access', reliable: true };
  if (s.runningInstances === 0 || s.code === 'NOT_RUNNING') return { ...out, screen: 'not-running', reliable: true };
  if (s.runningInstances > 1 || s.code === 'SEVERAL_INSTANCES') return { ...out, screen: 'several', reliable: true };
  const windows = layout(s);
  const complete = s.complete === true;
  if (!windows.length) return { ...out, screen: 'busy', reasons: s.incompleteReasons || [] };
  const withSheet = windows.find(w => w.sheets.length);
  if (withSheet) {
    const sheet = withSheet.sheet;
    const sheetReliable = (s.sheetComplete ?? complete) === true && withSheet.sheets.length === 1;
    const labels = [...new Set(sheet.flatMap(strings))];
    const targets = [...new Set(sheet.flatMap(strings).filter(v => OUTPUT.test(v)))];
    const base = { ...out, reliable: sheetReliable, labels: labels.slice(0, 40), window: withSheet.frame };
    if (sheet.some(n => named(n, LABELS.ok))) {
      const button = sheet.find(n => n.role === 'AXButton' && named(n, LABELS.ok)) || null;
      return { ...base, screen: 'export-settings', targets, target: targets.length === 1 ? targets[0] : null,
        okEnabled: button ? button.enabled !== false : null, okPress: button ? (button.actions || []).includes('AXPress') : null };
    }
    const progress = sheet.map(n => prefixed(n, LABELS.progress)).filter(Boolean);
    if (progress.length) {
      const values = [...new Set(progress.map(p => PERCENT.exec(p)?.[1]).filter(Boolean).map(Number))].filter(v => v >= 0 && v <= 100);
      return { ...base, screen: 'exporting', percent: values.length === 1 ? values[0] : null };
    }
    if (sheet.some(n => named(n, LABELS.close) || named(n, LABELS.publish) || named(n, LABELS.openFolder))) {
      const button = sheet.find(n => n.role === 'AXButton' && named(n, LABELS.close)) || null;
      return { ...base, screen: 'export-done', closePress: button ? (button.actions || []).includes('AXPress') : null };
    }
    return { ...base, screen: 'sheet' };
  }
  // A sheet-only read (capcut-ax snapshot --scope sheet) cannot tell the page behind.
  if (s.scope === 'sheet') return { ...out, screen: 'no-sheet', reliable: complete && (s.sheetComplete ?? true) === true, window: windows[0].frame };
  const main = windows[0];
  const page = windows.flatMap(w => w.page);
  const labels = [...new Set(page.flatMap(strings))];
  const editorWindow = windows.find(w => w.page.some(n => named(n, LABELS.editorExport)));
  if (editorWindow) {
    const button = editorWindow.page.find(n => named(n, LABELS.editorExport));
    const total = editorWindow.page.map(n => prefixed(n, LABELS.duration)).find(Boolean);
    return { ...out, screen: 'editor', reliable: complete, labels: labels.slice(0, 40), window: editorWindow.frame,
      exportButton: validFrame(button.frame) ? button.frame : null, durationSeconds: total ? timecodeSeconds(total) : null };
  }
  const homeWindow = windows.find(w => w.page.some(n => named(n, LABELS.tile) || named(n, LABELS.start)));
  if (homeWindow) {
    const tiles = homeWindow.page.filter(n => named(n, LABELS.tile) && validFrame(n.frame) && n.frame.height >= 60).map(n => n.frame)
      .sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x));
    const titles = homeWindow.page.map(n => ({ text: prefixed(n, LABELS.title), frame: n.frame }))
      .filter(t => t.text && validFrame(t.frame)).map(t => ({ name: t.text.slice(LABELS.title.length), frame: t.frame }));
    return { ...out, screen: 'home', reliable: complete, labels: labels.slice(0, 40), window: homeWindow.frame, tiles, titles };
  }
  return { ...out, screen: complete ? 'unknown' : 'busy', reliable: complete, labels: labels.slice(0, 40), window: main.frame };
}

// Where to double-click to open `name` on the home page, or why not. Tiles are
// static texts without AXPress: a mouse double-click is the only way in, aimed at
// the thumbnail part of the tile CapCut itself reports (never at the name label,
// where a double-click may start renaming the project).
//   method 'title'      : the tile is identified by its exact name;
//   method 'first-tile' : CapCut exposes no name (tiles cut by the window bottom right
//                         after launch); allowed only when ELPO has just placed the
//                         project first, and checked again on the export sheet.
export function chooseTile(home, name, { allowFirst = false } = {}) {
  if (home?.screen !== 'home') return { point: null, reason: 'L’accueil de CapCut n’est pas affiché.' };
  const thumb = f => ({ x: f.x, y: f.y, width: f.width, height: Math.max(10, f.height - 30) });
  const tileOf = t => home.tiles.find(f => t.frame.x + t.frame.width / 2 >= f.x && t.frame.x + t.frame.width / 2 <= f.x + f.width &&
    t.frame.y + t.frame.height / 2 >= f.y && t.frame.y + t.frame.height / 2 <= f.y + f.height) || null;
  if (home.titles.length) {
    const wanted = fold(name);
    const matches = home.titles.filter(t => fold(t.name) === wanted);
    const visible = home.titles.slice(0, 8).map(t => t.name).join(', ');
    if (!matches.length) return { point: null, reason: `La vignette « ${name} » n’est pas visible sur l’accueil CapCut (projets visibles : ${visible}). Dans CapCut, trie l’accueil par date de modification. Aucun clic envoyé.` };
    const tiles = matches.map(tileOf).filter(Boolean);
    let tile = tiles.length === 1 ? tiles[0] : null;
    // Two projects with the same name: the one ELPO placed first is the first tile.
    if (!tile && tiles.length > 1 && allowFirst && tiles.includes(home.tiles[0])) tile = home.tiles[0];
    if (!tile) return { point: null, reason: matches.length > 1 ? `Plusieurs projets s’appellent « ${name} » sur l’accueil CapCut. Renomme-les. Aucun clic envoyé.` : `La vignette de « ${name} » n’a pas de cadre lisible. Aucun clic envoyé.` };
    const point = visiblePart(home.window, thumb(tile));
    return point ? { point, method: 'title', tile } : { point: null, reason: `La vignette « ${name} » est trop peu visible pour être ouverte. Agrandis la fenêtre CapCut. Aucun clic envoyé.` };
  }
  if (!allowFirst) return { point: null, reason: 'CapCut n’expose pas les noms des vignettes : projet impossible à identifier. Aucun clic envoyé.' };
  // Only the very first tile can be the project ELPO has just placed first.
  const first = home.tiles[0];
  const point = first ? visiblePart(home.window, thumb(first)) : null;
  return point ? { point, method: 'first-tile', tile: first }
    : { point: null, reason: 'La première vignette de l’accueil CapCut n’est pas visible. Agrandis la fenêtre CapCut (sans plein écran). Aucun clic envoyé.' };
}

export function describeScreen(screen) {
  if (!screen) return 'aucune lecture';
  const names = { home: 'accueil', editor: 'éditeur', 'export-settings': 'réglages d’export', exporting: 'export en cours', 'export-done': 'fin d’export',
    sheet: 'fenêtre CapCut inattendue', 'no-sheet': 'aucune feuille d’export', busy: 'CapCut occupé (lecture impossible)', unknown: 'page non reconnue', 'not-running': 'CapCut fermé',
    'no-access': 'accessibilité refusée', several: 'plusieurs CapCut ouverts' };
  const labels = screen.labels?.length ? ` · éléments : ${screen.labels.slice(0, 12).join(', ')}` : '';
  return `${names[screen.screen] || screen.screen}${screen.reliable ? '' : ' (lecture partielle)'}${labels}`;
}
