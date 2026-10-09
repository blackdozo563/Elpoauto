// Preserve command output/exit status and expose failures in the GitHub Checks API.
const { spawn } = require('node:child_process');
const [file, ...args] = process.argv.slice(2);
if (!file) throw new Error('A command is required');
const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', bytes => { destination.write(bytes); output = (output + bytes).slice(-100000); });
}
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  if (code !== 0) {
    const failures = [...output.matchAll(/not ok [\s\S]*?(?=\n# Subtest:|$)/g)].map(m => m[0]).join('\n');
    const message = (failures || output).slice(-3500).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=ElpoAI command failure::${message}`);
  }
  process.exitCode = code === null ? 1 : code;
});
