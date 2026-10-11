#!/usr/bin/env node
// Native reading of what CapCut shows, for a bug report. To run on the Mac, CapCut
// open on the page to examine, after `npm run build:native`. Read only: nothing is
// pressed or clicked. Writes ./capcut-ax-<timestamp>.json (full observation + snapshot
// + what lib/capcut-screen.js understands of it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeDriver } from '../lib/capcut-native.js';
import { readScreen, describeScreen } from '../lib/capcut-screen.js';

const driver = nativeDriver({ binary: fileURLToPath(new URL('../build/native/capcut-ax', import.meta.url)) });
const report = { at: new Date().toISOString() };
for (const [key, read] of [['helper', () => driver.version()], ['snapshot', () => driver.snapshot()], ['state', () => driver.state()]]) {
  try { report[key] = await read(); } catch (error) { report[key] = { error: { code: error.code ?? null, message: error.message } }; }
}
const screen = report.snapshot?.windows ? readScreen(report.snapshot) : null;
report.understood = screen;
const file = path.resolve(`capcut-ax-${report.at.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`${describeScreen(screen)}\nRelevé écrit : ${file}`);
