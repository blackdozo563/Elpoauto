import { homeIsOpen, editorIsOpen, exportDialogIsOpen, exportDialogWindow, exportOkPoint, exportTarget, uiIdentifiers, uiSummary } from './capcut-ui.js';
import { EXPORT_SHEET_IDS, DEEP_READ } from './capcut-pilot.js';

// Read through the installed app's automation context, without activating CapCut,
// changing a window, sending a key or clicking. Keep failed and partial reads too.
export async function captureCapcutDiagnostic(actions, context = {}) {
  const report = { schema: 1, at: new Date().toISOString(), context, results: [] };
  const ladder = [
    ['Sonde de la feuille d’export', { stop: EXPORT_SHEET_IDS, deadlineMs: 6000 }],
    ['Lecture standard', {}],
    ['Lecture approfondie', { ...DEEP_READ }],
  ];
  for (const [label, options] of ladder) {
    const started = Date.now();
    try {
      const ui = await actions.readUi(options);
      report.results.push({ label, options, ms: Date.now() - started, ui,
        analysis: { summary: uiSummary(ui), identifiers: uiIdentifiers(ui, 100),
          home: homeIsOpen(ui), editor: editorIsOpen(ui), exportDialog: exportDialogIsOpen(ui),
          exportWindow: exportDialogWindow(ui)?.title ?? null,
          exportButton: exportOkPoint(ui), exportTarget: exportTarget(ui) } });
    } catch (error) {
      report.results.push({ label, options, ms: Date.now() - started,
        error: { code: error.code ?? null, message: error.message } });
    }
  }
  return report;
}
