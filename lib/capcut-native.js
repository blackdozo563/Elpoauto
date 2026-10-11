import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macActions } from './mac-automation.js';

const execute = promisify(execFile);
// UI commands are deliberately absent from the retained shutdown adapter.
export function nativeActions({ binary, ffprobe, trusted = () => true, onActionStart = () => {}, onActionEnd = () => {} }) {
  const retained = macActions();
  async function invoke(args, signal, action = false) {
    if (!binary || !fs.existsSync(binary)) throw Object.assign(new Error('Outil natif capcut-ax absent du paquet.'), { code: 'AX_BINARY' });
    if (action) onActionStart();
    let response;
    try {
      let stdout;
      try { ({ stdout } = await execute(binary, args, { encoding: 'utf8', timeout: action ? 8000 : 2500, maxBuffer: 12 * 1024 * 1024, signal })); }
      catch (error) {
        if (!error.stdout) throw Object.assign(new Error(`capcut-ax n’a pas répondu : ${error.message}. Aucun nouvel essai automatique.`), { code: signal?.aborted ? 'CANCELLED' : 'AX_RPC_UNCERTAIN', commandAttempted: action });
        stdout = error.stdout;
      }
      try { response = JSON.parse(stdout); }
      catch { throw Object.assign(new Error('Réponse JSON native invalide. Aucun nouvel essai automatique.'), { code: 'AX_RPC_UNCERTAIN', commandAttempted: action }); }
      if (action && response.ok !== true) throw Object.assign(new Error(response.error || 'Commande native refusée.'), { code: response.code || 'AX_ACTION', evidence: response, commandAttempted: response.commandAttempted });
      return response;
    } finally { if (action) onActionEnd(response); }
  }
  return {
    isRunning: retained.isRunning, assertClosed: retained.assertClosed, launch: retained.launch,
    quit: retained.quit, forceQuit: retained.forceQuit,
    accessibility: async () => trusted() && (await invoke(['state'])).trusted === true,
    probeAvailable: () => !!ffprobe && path.isAbsolute(ffprobe) && fs.existsSync(ffprobe),
    state: signal => invoke(['state'], signal),
    openProject: (name, signal) => invoke(['open-project', name.normalize('NFC')], signal, true),
    openExport: signal => invoke(['open-export'], signal, true),
    pressExport: (name, dir, signal) => invoke(['press-export', '--name', name.normalize('NFC'), '--dir', dir.normalize('NFC')], signal, true),
    closeDone: signal => invoke(['close-done'], signal, true),
    probeDuration: async (file, signal) => {
      if (!ffprobe || !fs.existsSync(ffprobe)) throw Object.assign(new Error('ffprobe est requis pour valider la durée du MP4.'), { code: 'FFPROBE_REQUIRED' });
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', file], { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, signal });
      const result = JSON.parse(stdout);
      return { duration: Number(result.format?.duration), video: result.streams?.some(s => s.codec_type === 'video') === true };
    },
  };
}
