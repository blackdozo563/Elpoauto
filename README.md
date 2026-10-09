# ElpoAiAutoCapcut 0.5.0 — studio d'automontage CapCut

Application Electron pour Mac Apple Silicon qui **construit des timelines CapCut** (images, vidéos, voix off, musique, mouvements, transitions, effets, filtres) et **exporte les vidéos en lot**. Elle travaille sur les fichiers de projet CapCut (`draft_info.json`, `draft_meta_info.json`, index global) avec aperçu, sauvegarde et vérification avant toute écriture.

## Deux modes

**Mode 1 — Montage complet** (un projet, de bout en bout) : Médias → Scènes → Style → Vérifier → Générer & exporter.
- Médias : chutier CapCut ou dossier d'images externe (Flow), voix off, musique de fond (bouclée ou coupée, volume réglable), son des clips.
- Scènes : 6 placements (plan éditable depuis SRT ou médias, durées égales, horaires dans les noms, un visuel par bloc SRT, liste d'horaires, plan JSON). Timeline visuelle avec forme d'onde : raccords déplaçables à la souris, clic pour retrouver une scène.
- Style : 9 mouvements (fixe, zoom avant/arrière, alterné, 4 panoramiques, Ken Burns), transitions en boucle ou variées, effets (par scène ou sur toute la vidéo), filtres, styles enregistrés réutilisables.
- Vérifier : lecteur synchronisé voix + visuels, points de contrôle, déroulé des scènes.
- Générer puis exporter ce projet (export ELPO ou via CapCut).

**Mode 2 — Production en lot** : coche des projets dans *Projets*, puis
1. *Monter les timelines vides* (optionnel) : placement automatique, style, règle de voix off/musique ; chaque projet est analysé, montré, sauvegardé et écrit séparément ;
2. *Exporter* avec l'un des deux moteurs :
   - **Export ELPO** (FFmpeg) : automatique, en arrière-plan, sans CapCut. Images, vidéos, mouvements, transitions (équivalents xfade), sons, SRT incrusté. Résolution, images/s, qualité, H.264/HEVC, accélération VideoToolbox, exports simultanés, modèle de nom, file avec progression/annulation, notification et progression dans le Dock. Ne reproduit pas les effets ni les filtres CapCut.
   - **Via CapCut** (pilotage) : rendu identique à CapCut. Pour chaque projet : vérification des médias (fenêtre « Relier des fichiers » évitée), fermeture de CapCut, projet placé en tête de l'accueil, lancement, ouverture de la première vignette, ⌘E puis Exporter, attente d'un fichier complet et lisible (sous-dossiers compris, .mp4/.mov), fermeture de la fenêtre de fin d'export, sortie de CapCut. Nécessite l'autorisation Accessibilité et un calibrage (Réglages).

## Bibliothèque : transitions, effets, filtres

ELPO n'invente aucune ressource : il réutilise celles déjà présentes dans tes projets CapCut (téléchargées en local) et les recopie avec de nouveaux identifiants. Favoris d'abord, sinon les éléments disponibles :
- crée dans CapCut un projet nommé **ELPO Favoris**, applique depuis l'onglet ★ Favoris chaque élément préféré, ferme CapCut : ELPO les marque comme favoris ;
- ou utilise l'étoile dans *Bibliothèque*.
L'option « Mes favoris automatiquement » applique les favoris ; pour les transitions, à défaut, toutes les disponibles.

## Installation (paquet Mac)

1. Télécharger `ElpoAiAutoCapcut-0.5.0-arm64.dmg` depuis la release GitHub, ouvrir le DMG et copier l'application dans Applications. Premier lancement : clic droit → Ouvrir, car cette version est signée ad hoc et non notarisée.
2. Pour l'export ELPO : `brew install ffmpeg` (détecté automatiquement, ou à choisir dans Réglages).
3. Pour l'export via CapCut : Réglages Système → Confidentialité et sécurité → Accessibilité → cocher ElpoAiAutoCapcut. Dans CapCut, trier l'accueil par date de modification. Dans ELPO → Réglages : calibrer la première vignette et le bouton Exporter, indiquer le dossier d'export de CapCut, puis *Production en lot → Tester sur un projet*.

Le DMG autonome utilise Electron 32.3.3 installé depuis npm. L'ancien paquet ZIP avec installateur réutilise le runtime du DMG TryAIToday AutoCapCut 0.1.2 (voir ATTRIBUTION.md) ; il reste une méthode de packaging distincte.

## Raccourcis

⌘K palette de commandes · ⌘1 à ⌘5 pages · ⌘↩ analyser · Espace lecture · ⌘A tout cocher · ⌘, réglages.

## Développement

Node.js 22+ : `npm ci`, puis `npm test` (90 tests, dont un rendu FFmpeg réel si FFmpeg est installé). Aucune dépendance npm d'exécution ; Electron et electron-builder sont des dépendances de développement verrouillées par package-lock.json. `npm start` lance Electron installé localement.
- `lib/engine.js` : analyse, plan, construction du draft (mouvements, transitions, effets, filtres, musique), lot.
- `lib/render.js` + `lib/export-queue.js` : export ELPO (plan lu depuis le draft, commandes FFmpeg pures et testées, file).
- `lib/capcut-pilot.js` + `lib/mac-automation.js` : pilotage de CapCut (séquence testable, actions macOS via osascript/CoreGraphics).
- `lib/storage.js` : écritures atomiques, transactions avec sauvegarde, restauration.
- `renderer/` : interface (HTML/CSS/JS sans framework), `scripts/create_preview.py` : démo HTML autonome.
- DMG autonome : `npm ci` puis `npm run dist:mac` sur un Mac Apple Silicon (electron-builder, signature ad hoc via `scripts/after-pack.cjs`). Le workflow `.github/workflows/build-mac.yml` fait la même chose sur GitHub (runner macos-14, Node 22) à chaque tag `v*`. Il vérifie le contenu du DMG, codesign, les entitlements et le démarrage natif avec interface et IPC avant d'attacher le DMG, son empreinte et le rapport à la release.
- Paquet « installateur » (comme 0.4.0, runtime TryAIToday) : `python3 scripts/build_release.py PAQUET_PRECEDENT_DECOMPRESSE SORTIE resultats-tests.txt`.

## Limites connues

- La compatibilité JSON est validée sur des projets synthétiques : contrôler le premier rendu dans CapCut 9.3.0 (surtout panoramiques, effets et filtres recopiés).
- Le pilotage de CapCut dépend de l'interface de CapCut : calibrer après chaque mise à jour de CapCut.
- La timeline cible doit être vide : ELPO ne modifie pas un montage existant.
