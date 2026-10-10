#!/usr/bin/env node
// Relevé de l'interface CapCut, pour diagnostiquer un pilotage qui ne trouve pas ses
// boutons. À lancer sur le Mac, CapCut ouvert sur la page à examiner (accueil,
// éditeur, ou éditeur avec la feuille d'export affichée).
//
//   node scripts/dump-capcut-ui.mjs            # les trois profondeurs de lecture
//   node scripts/dump-capcut-ui.mjs --json     # + le relevé brut en JSON
//
// Le relevé brut est écrit dans ./capcut-ui-<horodatage>.json : c'est ce fichier qu'il
// faut joindre à un rapport de panne, car il donne les vrais identifiants d'automatisation
// exposés par la version de CapCut installée (ils changent d'une version à l'autre).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { capcutUiScript } from '../lib/mac-automation.js';
import { homeIsOpen, editorIsOpen, exportDialogIsOpen, exportDialogWindow, exportOkPoint, exportTarget, uiIdentifiers, uiSummary } from '../lib/capcut-ui.js';
import { EXPORT_SHEET_IDS, DEEP_READ } from '../lib/capcut-pilot.js';

const run = script => new Promise((resolve, reject) =>
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 90000 },
    (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout).trim())));

const LADDER = [
  ['sonde (arrêt au 1er identifiant de feuille)', { stop: EXPORT_SHEET_IDS, deadlineMs: 6000 }],
  ['lecture standard', {}],
  ['lecture approfondie', DEEP_READ],
];

const started = Date.now();
const results = [];
for (const [label, options] of LADDER) {
  const at = Date.now();
  try {
    const ui = JSON.parse(await run(capcutUiScript(options)));
    results.push({ label, options, ui, ms: Date.now() - at });
  } catch (error) {
    results.push({ label, options, error: error.message, ms: Date.now() - at });
  }
}

console.log(`CapCut — relevé d'interface (${((Date.now() - started) / 1000).toFixed(1)} s au total)\n`);
for (const r of results) {
  console.log(`── ${r.label} · ${r.ms} ms`);
  if (r.error) { console.log(`   ÉCHEC : ${r.error}\n`); continue; }
  const { ui } = r;
  console.log(`   ${uiSummary(ui)}`);
  console.log(`   accueil=${homeIsOpen(ui)} · éditeur=${editorIsOpen(ui)} · feuille d'export=${exportDialogIsOpen(ui)}`);
  if (exportDialogIsOpen(ui)) {
    console.log(`   bouton « Exporter » de la feuille : ${JSON.stringify(exportOkPoint(ui))}`);
    console.log(`   fichier annoncé : ${exportTarget(ui) || '(non exposé)'}`);
    console.log(`   fenêtre de la feuille : « ${exportDialogWindow(ui)?.title || 'sans titre'} »`);
  }
  if (process.argv.includes('--json') || ui?.windows?.some(w => (w.nodes || []).length)) {
    console.log(`   identifiants vus : ${uiIdentifiers(ui, 40).join(', ') || 'aucun'}`);
  }
  console.log('');
}

const best = results.find(r => r.ui && exportDialogIsOpen(r.ui)) || results.find(r => r.ui) || results[0];
const file = path.resolve(`capcut-ui-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`Relevé brut : ${file}`);
console.log(best?.error ? 'Aucune lecture n’a abouti : vérifie l’autorisation Accessibilité.' : 'Joins ce fichier à ton rapport si le pilotage échoue encore.');
