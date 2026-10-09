# Prompt pour ChatGPT Codex — ElpoAiAutoCapcut 0.5.0

Copie tout le bloc ci-dessous dans Codex, avec le dépôt (le contenu de `ElpoAiAutoCapcut-0.5.0-sources.zip`) poussé sur GitHub.

---

Tu reprends le dépôt **ElpoAiAutoCapcut 0.5.0**, une application Electron pour Mac Apple Silicon (interface en français) qui automatise le montage dans **CapCut 9.3.0** et exporte des vidéos en lot. Le code est complet et testé (82 tests Node). Ta mission : **le publier proprement sur GitHub et produire un DMG installable**, sans changer la logique métier ni l'interface.

## Ce que fait l'application (à préserver)

1. **Mode 1 — Montage complet** : pour un projet CapCut dont la timeline est vide, ELPO lit le chutier (ou un dossier d'images externe), construit un plan de scènes calé sur la voix off (6 modes : plan éditable depuis SRT/médias, durées égales, horaires dans les noms, un visuel par bloc SRT, liste d'horaires, plan JSON), applique un style (9 mouvements dont panoramiques et Ken Burns, transitions, effets, filtres, musique de fond), montre un aperçu, puis **écrit la timeline directement dans les fichiers JSON du projet CapCut** (`draft_info.json`/`draft_content.json`, miroir `Timelines/…`, `draft_meta_info.json`, `root_meta_info.json`).
2. **Mode 2 — Production en lot** : projets cochés → montage des timelines vides (optionnel) → export en lot, soit par **FFmpeg** (« Export ELPO », sans CapCut), soit en **pilotant CapCut** (« Via CapCut » : quitter CapCut, placer le projet en tête de l'accueil en mettant à jour `tm_draft_modified`, relancer, double-cliquer la première vignette calibrée, ⌘E, bouton Exporter calibré, attendre un fichier .mp4/.mov complet et lisible, Échap, quitter).
3. **Bibliothèque** : transitions/effets/filtres ne sont jamais inventés ; ils sont recopiés depuis les projets CapCut de l'utilisateur (ressources déjà téléchargées). Favoris = éléments d'un projet nommé « ELPO Favoris » + étoiles enregistrées dans ELPO.

## Règles de sécurité non négociables (déjà codées, ne pas affaiblir)

- Aucune écriture si CapCut est ouvert (`pgrep -x CapCut`), si la timeline n'est pas vide, si un fichier a changé depuis l'aperçu (empreintes SHA-256), ou si une récupération est en attente.
- Toute écriture passe par `lib/storage.js` (`transact`) : sauvegarde des originaux, écriture atomique, vérification, rollback, restauration avec détection de conflit.
- Le pilotage CapCut ne touche que les horodatages du projet et refuse les projets aux médias manquants (sauf option explicite).
- L'export ELPO écrit un `.partial` puis renomme ; jamais d'écrasement (`uniquePath`).

## Architecture

- `electron/main.js` (processus principal, IPC filtré par origine, menu macOS, Dock, notifications), `electron/preload.cjs` (API `window.elpo`).
- `lib/worker.js` exécute `lib/engine.js` hors du thread principal. `lib/render.js` (plan de rendu lu depuis le draft + commandes FFmpeg **pures**), `lib/export-queue.js` (file d'exports), `lib/capcut-pilot.js` (séquence de pilotage, actions injectées), `lib/mac-automation.js` (osascript/System Events/CoreGraphics), `lib/media-server.js` (protocole `elpo-media://` à jetons).
- `renderer/` : HTML/CSS/JS sans framework ni dépendance, CSP stricte (`script-src 'self'`).
- Tests : `npm test` (node:test). `tests/render.test.js` fait un vrai rendu si FFmpeg est installé.
- Aucune dépendance d'exécution : seuls `electron@32.3.3` et `electron-builder` en devDependencies.

## Tâches

1. Initialise le dépôt GitHub (branche `main`), garde `.gitignore` (pas de `node_modules/`, `dist/`). Ne versionne pas les gros binaires (`downloads/`, DMG TryAIToday).
2. `npm install`, puis `npm test` : les 82 tests doivent passer. Si un test échoue, corrige la cause, pas le test.
3. Vérifie `.github/workflows/build-mac.yml` (runner `macos-14`, Node 22, `brew install ffmpeg`, tests, `npm run dist:mac`, DMG en artefact et attaché aux releases sur tag `v*`). Pousse un tag `v0.5.0` pour produire `ElpoAiAutoCapcut-0.5.0-arm64.dmg`.
4. Signature : pas d'identifiant Apple Developer → `mac.identity: null` + `scripts/after-pack.cjs` qui signe **ad hoc** avant la création du DMG (obligatoire sur Apple Silicon). Si un certificat Developer ID est fourni plus tard, remplace par une vraie signature + notarisation (hardenedRuntime true, entitlements de `packaging/runtime-entitlements.plist`, dont `com.apple.security.automation.apple-events`).
5. Vérifie dans le DMG : `Info.plist` contient `NSAppleEventsUsageDescription`, l'icône `packaging/icon.icns`, et l'app démarre (`codesign --verify --deep --strict`).
6. Rédige la release GitHub en français à partir de `CHANGELOG.md` et rappelle à l'utilisateur : premier lancement par clic droit → Ouvrir (app non notarisée), `brew install ffmpeg` pour l'export ELPO, autorisation Accessibilité pour le pilotage de CapCut, calibrage dans Réglages.

## À ne pas faire

- Ne pas ajouter de framework front (React, etc.), de télémétrie, ni d'appel réseau : tout reste local.
- Ne pas changer le format des fichiers CapCut écrits, ni les identifiants d'IPC, ni le texte français de l'interface sans raison.
- Ne pas désactiver les contrôles (`check(...)`) pour « faire passer » un cas.

Livrables attendus : dépôt GitHub propre, workflow vert, release `v0.5.0` avec le DMG arm64, et un court rapport de ce qui a été vérifié.
