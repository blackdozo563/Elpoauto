// Read-only diagnostic from the same native context used by the pilot.
export async function captureCapcutDiagnostic(actions, context = {}) {
  const report = { schema: 2, at: new Date().toISOString(), context, results: [] };
  for (let index = 0; index < 3; index++) {
    const started = Date.now();
    try {
      const ui = await actions.state();
      report.results.push({ label: `Relevé natif ${index + 1}`, ms: Date.now() - started, ui, analysis: ui.state });
    } catch (error) { report.results.push({ label: `Relevé natif ${index + 1}`, ms: Date.now() - started, error: { code: error.code ?? null, message: error.message } }); }
  }
  return report;
}
