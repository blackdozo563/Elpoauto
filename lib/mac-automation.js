// macOS process actions of the CapCut pilot: launch, quit, terminate, and FFprobe.
// Reading CapCut and acting on its controls is the native helper's job
// (lib/capcut-native.js → tools/capcut-ax): no System Events, no JXA UI scripting.
import { execFile, execFileSync } from 'node:child_process';

export const CAPCUT_ID = 'com.lemon.lvoverseas';
export function automationFailure(error, stderr, timeout) {
  if (error.killed && error.signal) return Object.assign(new Error(`La commande macOS n’a pas répondu dans le délai de ${timeout / 1000} secondes.`), { code: 'MAC_TIMEOUT', signal: error.signal, cause: error });
  const detail = String(stderr || '').trim();
  const denied = /-1743|-25211|not authorized|not allowed|pas autorisé|non autorisé/i.test(detail);
  return Object.assign(new Error(detail || `La commande macOS a échoué (code ${error.code ?? 'inconnu'}${error.signal ? `, signal ${error.signal}` : ''}).`), { code: denied ? 'MAC_PERMISSION' : error.code, signal: error.signal, cause: error });
}
const exec = (file, args, timeout = 20000) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout }, (error, stdout, stderr) => error ? reject(automationFailure(error, stderr, timeout)) : resolve(String(stdout).trim())));
const osa = script => exec('/usr/bin/osascript', ['-e', script]);

// Duration in seconds of a finished video: a number > 0; 0 when FFprobe cannot read it
// (not written completely yet); null when FFprobe is not installed.
export async function probeDuration(ffprobe, file, run = exec) {
  if (!ffprobe) return null;
  try {
    const seconds = Number(await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 30000));
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch { return 0; }
}

export function macActions({ ffprobe = null, trusted = () => true } = {}) {
  return {
    accessibility: async () => !!trusted(),
    isRunning: async () => {
      try { await exec('/usr/bin/pgrep', ['-x', 'CapCut']); return true; }
      catch (e) { if (e.code === 1) return false; throw Object.assign(new Error('Impossible de vérifier la fermeture de CapCut.'), { code: 'PROCESS_UNKNOWN' }); }
    },
    assertClosed: () => {
      try { execFileSync('/usr/bin/pgrep', ['-x', 'CapCut'], { stdio: 'ignore', timeout: 5000 }); }
      catch (e) { if (e.status === 1) return; throw Object.assign(new Error('Impossible de vérifier la fermeture de CapCut.'), { code: 'PROCESS_UNKNOWN' }); }
      throw Object.assign(new Error('CapCut est ouvert : aucune écriture autorisée.'), { code: 'CAPCUT_OPEN' });
    },
    launch: () => exec('/usr/bin/open', ['-b', CAPCUT_ID]),
    activate: () => osa(`tell application id "${CAPCUT_ID}" to activate`),
    // A polite quit. While CapCut shows a modal panel it refuses to quit and the Apple
    // event would block until osascript is killed: the request is sent without waiting
    // for an answer, and the caller polls the process instead.
    quit: () => osa(`ignoring application responses\ntell application id "${CAPCUT_ID}" to quit\nend ignoring`).catch(() => null),
    // Last resort once the project files are protected: SIGTERM, then SIGKILL when `hard`.
    // pkill exits with 1 when no CapCut process is left, which is the goal.
    forceQuit: async (hard = false) => {
      try { await exec('/usr/bin/pkill', [hard ? '-KILL' : '-TERM', '-x', 'CapCut'], 5000); }
      catch (e) { if (e.code !== 1) throw e; }
    },
    duration: file => probeDuration(ffprobe, file),
  };
}
