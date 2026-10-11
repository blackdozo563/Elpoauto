// Bridge to tools/capcut-ax, the native helper shipped inside the app
// (Contents/MacOS/capcut-ax). Each call runs one command and reads its single JSON
// answer. The helper runs as a child of ElpoAiAutoCapcut, so macOS applies ELPO's own
// Accessibility permission to it; no System Events, no AppleScript UI scripting.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const failure = (code, message) => Object.assign(new Error(message), { code });

export function nativeDriver({ binary, run = execFile, timeoutMs = 20000, onCommand = () => {} } = {}) {
  const available = () => typeof binary === 'string' && binary.length > 0 && fs.existsSync(binary);
  const call = (args, ms = timeoutMs) => new Promise((resolve, reject) => {
    const started = Date.now();
    const record = fields => {
      if (!['press', 'click'].includes(args[0])) return;
      try { onCommand({ at: new Date(started).toISOString(), args: [...args], durationMs: Date.now() - started, ...fields }); } catch { /* observation cannot trigger another command */ }
    };
    if (!available()) {
      reject(failure('NATIVE_MISSING', 'L’outil natif capcut-ax est absent de l’application : réinstalle ElpoAiAutoCapcut depuis le DMG.'));
      return;
    }
    run(binary, args, { timeout: ms, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A refusal exits with 3 and an uncertain command with 4: both still answer JSON.
      const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
      let answer = null;
      try { answer = lines.length ? JSON.parse(lines.at(-1)) : null; } catch { answer = null; }
      if (answer && typeof answer === 'object') { record({ result: answer }); resolve(answer); return; }
      record({ error: { code: error?.killed ? 'NATIVE_TIMEOUT' : 'NATIVE_FAILED', message: String(stderr || error?.message || 'aucune sortie').slice(0, 300) }, outcomeUnknown: true });
      if (error?.killed) { reject(failure('NATIVE_TIMEOUT', `L’outil natif n’a pas répondu en ${Math.round(ms / 1000)} s (${args[0]}).`)); return; }
      reject(failure('NATIVE_FAILED', `Réponse illisible de l’outil natif (${args[0]}) : ${String(stderr || error?.message || lines.at(-1) || 'aucune sortie').trim().slice(0, 300)}`));
    });
  });
  const num = v => String(Math.round(Number(v)));
  return {
    binary,
    available,
    // Native read; `scope: 'sheet'` reads only CapCut's modal export sheet (faster while it encodes).
    snapshot: ({ scope = 'all', budget = 3 } = {}) => call(['snapshot', ...(scope === 'sheet' ? ['--scope', 'sheet'] : []), '--budget', String(budget)]),
    // AXPress on an allow-listed control (ExportOkBtn, automationcancel, automationcloseBtn).
    press: ({ label, expectName, mouse = false } = {}) => call(['press', '--label', String(label ?? ''), ...(expectName ? ['--expect-name', String(expectName)] : []), ...(mouse ? ['--mouse'] : [])]),
    // Mouse click at a point read from CapCut's frame of `expect`, checked again by the helper.
    click: ({ x, y, double = false, expect, strict = false } = {}) => call(['click', '--x', num(x), '--y', num(y), '--expect', String(expect ?? ''), ...(double ? ['--double'] : []), ...(strict ? ['--strict'] : [])]),
    // Full observation of every node and every AX read, for the diagnostic file.
    state: () => call(['state'], 30000),
    version: () => call(['--version'], 10000),
  };
}
