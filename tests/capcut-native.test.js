// Bridge to the native helper: arguments sent, JSON read back, failures named.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeDriver } from '../lib/capcut-native.js';
import { probeDuration, macActions } from '../lib/mac-automation.js';

function helper(answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpo-native-'));
  const binary = path.join(dir, 'capcut-ax'); fs.writeFileSync(binary, '');
  const calls = [];
  const run = (file, args, options, done) => { calls.push({ file, args, options }); answer(args, done); };
  return { binary, calls, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('outil natif : arguments de chaque commande et réponse JSON', async () => {
  const h = helper((args, done) => done(null, `${JSON.stringify({ ok: true, command: args[0] })}\n`, ''));
  try {
    const d = nativeDriver({ binary: h.binary, run: h.run });
    assert.equal(d.available(), true);
    assert.equal((await d.snapshot({ scope: 'sheet' })).command, 'snapshot');
    await d.press({ label: 'ExportOkBtn', expectName: 'Test ELPO' });
    await d.click({ x: 315.4, y: 486.6, double: true, expect: 'HomePageDraft' });
    await d.press({ label: 'automationcloseBtn' });
    assert.deepEqual(h.calls.map(c => c.args), [
      ['snapshot', '--scope', 'sheet', '--budget', '3'],
      ['press', '--label', 'ExportOkBtn', '--expect-name', 'Test ELPO'],
      ['click', '--x', '315', '--y', '487', '--expect', 'HomePageDraft', '--double'],
      ['press', '--label', 'automationcloseBtn'],
    ]);
    assert.ok(h.calls.every(c => c.options.timeout > 0 && c.options.maxBuffer >= 1e6));
  } finally { h.cleanup(); }
});

test('outil natif : un refus (code 3) reste une réponse lisible, pas une exception', async () => {
  const refusal = { ok: false, code: 'TARGET_MISMATCH', message: 'Autre projet.', commandAttempted: false };
  const h = helper((args, done) => done(Object.assign(new Error('exit 3'), { code: 3 }), `${JSON.stringify(refusal)}\n`, ''));
  try {
    assert.deepEqual(await nativeDriver({ binary: h.binary, run: h.run }).press({ label: 'ExportOkBtn', expectName: 'X' }), refusal);
  } finally { h.cleanup(); }
});

test('outil natif : absent, muet ou illisible — erreurs nommées', async () => {
  await assert.rejects(nativeDriver({ binary: '/nulle/part/capcut-ax' }).snapshot(), e => e.code === 'NATIVE_MISSING');
  const slow = helper((args, done) => done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', ''));
  const garbled = helper((args, done) => done(null, 'pas du JSON', 'trace'));
  try {
    await assert.rejects(nativeDriver({ binary: slow.binary, run: slow.run }).snapshot(), e => e.code === 'NATIVE_TIMEOUT');
    await assert.rejects(nativeDriver({ binary: garbled.binary, run: garbled.run }).snapshot(), e => e.code === 'NATIVE_FAILED' && /trace/.test(e.message));
  } finally { slow.cleanup(); garbled.cleanup(); }
});

test('FFprobe : durée, fichier illisible, FFprobe absent', async () => {
  assert.equal(await probeDuration(null, '/x.mp4'), null);
  assert.equal(await probeDuration('/ffprobe', '/x.mp4', async () => '275.733'), 275.733);
  assert.equal(await probeDuration('/ffprobe', '/x.mp4', async () => 'N/A'), 0);
  assert.equal(await probeDuration('/ffprobe', '/x.mp4', async () => { throw new Error('moov atom not found'); }), 0);
  const actions = macActions({ trusted: () => false });
  assert.equal(await actions.accessibility(), false, 'plus de System Events : seule l’autorisation macOS compte');
  for (const removed of ['readUi', 'click', 'key', 'shortcut', 'restoreWindow', 'windowFrame']) assert.equal(actions[removed], undefined, removed);
});

test('outil natif : conserve le retour de la commande, distinct de son effet dans CapCut', async () => {
  const result = { ok: true, commandAttempted: true, pressResult: 'success', focusedPID: 123, target: '/Users/demo/Desktop/projet 1-30sec.mp4' };
  const h = helper((args, done) => done(null, JSON.stringify(result), ''));
  const evidence = [];
  try {
    const d = nativeDriver({ binary: h.binary, run: h.run, onCommand: e => evidence.push(e) });
    await d.press({ label: 'ExportOkBtn', expectName: 'projet 1-30sec' });
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0].result, result);
    assert.equal(evidence[0].args[0], 'press');
    assert.ok(evidence[0].durationMs >= 0);
  } finally { h.cleanup(); }
});
