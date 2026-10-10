import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCapcutDiagnostic } from '../lib/capcut-diagnostic.js';

test('Diagnostic : lecture seule, relevé brut et coordonnées du bouton final conservés', async () => {
  const ui = { windows: [{ title: 'Exporter-TESTO', frame: { x: 10, y: 20, width: 1000, height: 700 }, nodes: [
    { role: 'AXButton', name: 'ExportOkBtn', position: [800, 650], size: [100, 40], enabled: true, visible: true },
    { role: 'AXTextField', name: 'ExportPathInput', value: '/Users/macbook/Desktop/TESTO.mp4' },
  ] }], truncated: false };
  const reads = [];
  const actions = new Proxy({ readUi: async options => { reads.push(options); return ui; } }, {
    get(target, key) { assert.equal(key, 'readUi', `Action interdite pendant le diagnostic : ${String(key)}`); return target[key]; },
  });
  const report = await captureCapcutDiagnostic(actions, { version: '0.6.4' });
  assert.equal(reads.length, 3);
  assert.ok(reads[0].stop.includes('exportokbtn'));
  assert.equal(reads[2].deadlineMs, 25000);
  assert.equal(report.context.version, '0.6.4');
  assert.doesNotThrow(() => JSON.stringify(report));
  for (const r of report.results) {
    assert.deepEqual(r.ui, ui);
    assert.deepEqual(r.analysis.exportButton, { x: 850, y: 670 });
    assert.equal(r.analysis.exportTarget, '/Users/macbook/Desktop/TESTO.mp4');
  }
});

test('Diagnostic : une erreur de permission et une lecture partielle restent exploitables', async () => {
  let calls = 0;
  const partial = { windows: [], truncated: true, timedOut: true, nodesRead: 17 };
  const report = await captureCapcutDiagnostic({ readUi: async () => {
    if (++calls === 1) throw Object.assign(new Error('Autorisation refusée'), { code: 'MAC_PERMISSION' });
    return partial;
  } });
  assert.equal(calls, 3);
  assert.deepEqual(report.results[0].error, { code: 'MAC_PERMISSION', message: 'Autorisation refusée' });
  assert.deepEqual(report.results[1].ui, partial);
  assert.equal(report.results[1].analysis.exportButton, null);
  assert.equal(report.results[2].ui.timedOut, true);
});
