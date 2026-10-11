# Consignes pour Codex — pilote CapCut natif (ElpoAiAutoCapcut 0.7.0)

Ce patch remplace le pilotage de CapCut. Il ne touche ni au moteur de montage (mode 1), ni à l’export ELPO/FFmpeg, ni à la file, ni aux écritures protégées des projets. Il s’appuie sur le relevé réel envoyé le 11 octobre 2026 (`capcut-record-1791682164`, CapCut 9.3.0 français, macOS 15.2), conservé anonymisé dans `tests/fixtures/capcut-9.3.0-cycle.json`.

## 1. Appliquer

Base : `codex/capcut-ax-prototype` au commit `4aac259` (« capcut-ax record : borner aussi les appels AX des éléments enfants »).

```sh
git fetch origin codex/capcut-ax-prototype
git checkout -b codex/pilote-natif-0.7 4aac259
git am refonte-pilote-natif-0.7.patch
npm test            # 152 tests attendus, tous verts
```

Ne modifie pas la logique tant qu’un contrôle ne l’exige pas. Si un contrôle échoue, corrige au plus près et dis exactement quoi.

## 2. Ce que fait le patch

- `tools/capcut-ax/Driver.swift` (nouveau) : commandes `snapshot`, `press` (trois boutons autorisés : `ExportOkBtn`, `automationcancel`, `automationcloseBtn`), `click` vérifié (CapCut au premier plan, point dans sa fenêtre, élément sous le point appartenant à CapCut). `main.swift` ne fait plus que répartir les commandes ; le démarrage de l’enregistreur a été déplacé tel quel dans `Recording.swift`. `state` et `record` sont inchangés.
- `tools/capcut-ax/build-helper.sh` : compile l’outil en exécutable simple `build/native/capcut-ax`, signé ad hoc, puis lance `--self-test`. `npm run dist:mac` l’appelle avant electron-builder ; `package.json` le copie dans `Contents/MacOS/capcut-ax` (`extraFiles`) ; `scripts/after-pack.cjs` le signe avant l’app ; `scripts/verify-dmg.mjs` vérifie sa présence, son architecture, sa signature, sa liste blanche et qu’il n’agit pas sans CapCut.
- `lib/capcut-screen.js` (nouveau) : reconnaît accueil, éditeur, réglages, export en cours, fin, feuille inconnue, à partir des identifiants relevés. Choisit la vignette : par son nom exact, ou la première quand CapCut masque les noms (juste après son lancement), le nom du fichier annoncé étant alors le contrôle d’identité.
- `lib/capcut-native.js` (nouveau) : appelle l’outil (une commande, une réponse JSON).
- `lib/capcut-pilot.js` (réécrit) : chaque étape attend l’écran prévu ; au plus un nouvel essai d’un clic ou d’un AXPress, et seulement quand une lecture complète prouve qu’il n’a pas été reçu ; fin d’export = fichier annoncé stable, lu par FFprobe à la durée de la timeline (`totalProgress`) ; « Fermer » par AXPress ; jamais de fermeture forcée pendant un encodage.
- Supprimés : `lib/capcut-ui.js`, `lib/capcut-diagnostic.js`, `scripts/dump-capcut-ui.mjs`, la visée (`renderer/aim.*`, IPC `pilotCalibrate`), le lecteur JXA/System Events et les clics/touches de `lib/mac-automation.js`, et leurs tests.
- Interface : Réglages sans visée, délais en maxima, état de l’outil natif, diagnostic natif (lecture seule). Les réglages 0.6.x sont repris sans leurs points visés.

## 3. Vérifications sans CapCut (CI)

1. Workflow **Tests** (Linux) : `npm test` → 152 tests.
2. Workflow **capcut-ax (outil natif du pilote)** sur macos-14 : compile l’outil et l’enregistreur, `--self-test`, refus sans CapCut (codes de sortie 3, `commandAttempted: false`).
3. Workflow **Build macOS DMG** lancé à la main (`workflow_dispatch`) sur la branche, **sans tag** : il produit le DMG en artefact, sans release. `verify-dmg.mjs` contrôle l’outil dans `Contents/MacOS`.

Le Swift a été vérifié sur Linux contre des déclarations équivalentes du SDK (le code Swift existant de la branche passe la même vérification), puis exécuté pour `--self-test` et les refus. Il n’a pas été compilé avec le SDK macOS : si `xcrun swiftc` signale une erreur, corrige-la sans changer le comportement. `activate(options: [.activateIgnoringOtherApps])` produit un avertissement de dépréciation sur macOS 14+ (sans conséquence).

## 4. Essais sur le Mac de l’utilisateur (deux seulement)

Donne-lui le DMG (artefact) avec exactement ce protocole.

**Préparation, une fois**
1. Quitter ELPO, remplacer l’app dans Applications par celle du DMG, l’ouvrir (clic droit → Ouvrir la première fois).
2. Réglages Système → Confidentialité et sécurité → Accessibilité : décocher puis recocher **ElpoAiAutoCapcut** (nouvelle signature).
3. Dans CapCut : accueil trié par date de modification, format MP4 dans les réglages d’export, puis quitter CapCut.
4. Dans ELPO : Réglages → Pilotage de CapCut → Dossier d’export de CapCut → choisir le dossier indiqué dans la feuille d’export de CapCut (par exemple le Bureau) → Enregistrer.

**Essai A — un projet court (5 à 30 s)**
Projets → cocher le projet → Production en lot → Via CapCut → *Tester sur un projet*. Ne plus toucher la souris. Attendu : CapCut fermé puis relancé, projet ouvert, réglages d’export, export, vidéo vérifiée, panneau fermé, CapCut quitté, ligne « Terminé » dans la Salle de rendu.

**Essai B — trois projets courts**
Cocher trois projets → *Lancer la production*. Attendu : trois vidéos, trois lignes « Terminé ».

**En cas d’échec** : l’erreur dit ce que CapCut affiche. Envoyer (1) le message d’erreur, (2) le *Journal du pilotage CapCut* (Salle de rendu), (3) Réglages → *Enregistrer le diagnostic CapCut*, CapCut laissé sur la page où le lot s’est arrêté.

Aucune release publique avant la réussite de l’essai B.

## 5. Si un essai échoue

- Ajoute le `snapshot` du diagnostic à `tests/fixtures` comme nouvel écran et écris d’abord le test qui échoue (`lib/capcut-screen.js` ou le simulateur `tests/capcut-sim.js`), puis corrige.
- Points à regarder en premier :
  1. `snapshot` répond `NO_ACCESS` alors qu’ELPO est autorisé : l’outil n’hérite pas de l’autorisation d’ELPO. Vérifier qu’il est lancé depuis `Contents/MacOS/capcut-ax` ; en dernier recours, l’ajouter avec « + » dans Accessibilité.
  2. Le projet ne s’ouvre pas : la réponse de `click` contient `hitChain` (ce qui était sous le point) et `hitVerified`.
  3. Les réglages d’export ne s’ouvrent pas : même chose pour `MainWindowTitleBarExportBtn`.
  4. « Exporter » sans effet : la réponse de `press` donne `pressResult` (AXPress a fonctionné sur le prototype le 10 octobre).
  5. Fin non reconnue : comparer le fichier écrit au chemin annoncé (`Fichier annoncé par CapCut` dans le journal).
- Ne réintroduis jamais : lecture System Events/JXA, points calibrés, touche Entrée, ⌘E, fermeture de CapCut pendant un export, clic sur « Partager ».
- Un seul agent, une seule branche (`codex/pilote-natif-0.7`) jusqu’à la réussite de l’essai B.
