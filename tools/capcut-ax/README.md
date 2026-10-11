# capcut-ax — l’outil natif du pilote CapCut

## Dernier bouton Exporter : relevé du 11 octobre

Après le lot réel réussi, `press --label automationcloseBtn --mouse` applique le même clic natif au bouton Fermer du panneau final. Cette commande n’est permise que dans la feuille de fin (`done`). Le pilote attend ensuite une lecture complète de l’éditeur avant de demander la sortie normale de CapCut. Le clic de fermeture n’est jamais permis dans la feuille d’encodage.

Le relevé du clic refusé montre que le hit-test renvoie le fond statique `ExportDialog` de l’AXSheet. Ce fond peut être accepté uniquement si c’est exactement celui de la lecture complète, s’il couvre le bouton natif, et si sa chaîne de parents rejoint la même AXSheet. La feuille, le bouton, son cadre et le chemin sont relus après cette vérification. Une simple fenêtre ou un autre contrôle ne suffisent jamais.

Le diagnostic réel de la 0.7.0 corrigée montre deux AXPress acceptés au premier plan sans encodage. Le pilote utilise donc `press --label ExportOkBtn --expect-name <nom> --mouse` : un clic souris unique après relecture du bouton et du chemin, validation du cadre natif et hit-test strict sur le même contrôle. Cette option est refusée pour tous les autres boutons. Elle ne fait jamais AXPress avant le clic ; aucune répétition automatique du dernier Exporter. La réponse décrit une commande postée, pas une preuve de démarrage.

Outil Swift qui lit et commande CapCut 9.3.0 par les API d’accessibilité de macOS. Il est embarqué dans ElpoAiAutoCapcut (`Contents/MacOS/capcut-ax`, compilé par `npm run build:native`) et lancé par l’application, dont il utilise l’autorisation Accessibilité. Aucune lecture JXA/System Events, aucune coordonnée calibrée, jamais la touche Entrée.

Chaque commande répond **un** objet JSON sur la sortie standard. Code de sortie : `0` fait, `3` refusé avant tout envoi à CapCut, `4` envoyé mais résultat incertain. `commandAttempted` dit si quelque chose a été envoyé à CapCut.

## Commandes du pilote

| Commande | Effet |
|---|---|
| `snapshot [--scope sheet] [--budget s]` | Lecture native : fenêtres (les plus grandes d’abord), feuille modale lue entièrement en premier, puis la page. Même format de nœuds que `state` et que les relevés `record` (`path`, `role`, `title`, `description`, `identifier`, `value`, `frame`, `enabled`, `actions`). `--scope sheet` ne lit que la feuille (pendant l’encodage). `sheetComplete` dit si la feuille a été lue sans erreur. |
| `press --label L [--expect-name N]` | AXPress sur **un** bouton d’une liste blanche, retrouvé dans une lecture fraîche de la feuille : `ExportOkBtn` (vue des réglages ; `--expect-name` obligatoire : le fichier annoncé doit être `N.mp4` ou `N(1).mp4`), `automationcancel` (vue des réglages uniquement, jamais pendant un export), `automationcloseBtn` (panneau de fin). Tout autre libellé est refusé (`LABEL_REFUSED`), dont `publish_pc_btn` (« Partager »). |
| `click --x X --y Y --expect L [--double] [--strict]` | Clic souris à un point calculé par ELPO depuis le cadre que CapCut donne pour le contrôle `L`. Vérifié avant : CapCut seul et au premier plan, point dans une fenêtre CapCut et sur un écran, aucune feuille ouverte, élément sous le point appartenant à CapCut (hit-test AX). `hitVerified` dit si `L` a été retrouvé sous le point (`--strict` l’exige). Sert à la vignette du projet (double-clic) et à « Exporter » de l’éditeur, qui n’annoncent pas AXPress dans CapCut 9.3.0. |
| `--self-test` | Contrôles purs : noms annoncés, liste blanche, zone de clic. Aucun appel à CapCut. |

Les décisions (quel écran, quelle vignette, fin de l’export) sont prises par `lib/capcut-screen.js` et `lib/capcut-pilot.js`, testées sur le relevé réel `tests/fixtures/capcut-9.3.0-cycle.json`.

## Observation (inchangée)

- `state` : observation complète, chaque nœud et chaque lecture AX, pour un diagnostic.
- `record [--seconds N] [--output dossier]` : petit panneau qui enregistre un relevé par seconde pendant un cycle manuel dans CapCut, puis un ZIP à envoyer. Observation seule. Compilé en application autonome par `bash tools/capcut-ax/build.sh` (autorisation Accessibilité distincte de celle d’ELPO).

## Identifiants CapCut 9.3.0 relevés le 11 octobre 2026

- Accueil : `HomePageDraft` (vignette, 134×174, sans AXPress), `HomePageDraftTitle:<nom>` (seulement si la vignette est entièrement visible), `HomePageStartProjectDesp`.
- Éditeur : `MainWindowTitleBarExportBtn` (texte dans la barre de titre de CapCut, sans AXPress), `totalProgress|hh:mm:ss:ff`, `MainTimeLineRoot`.
- Feuille d’export, réglages : `ExportDialog`, `ExportFileNameInput`, `ExportPathInput`, chemin complet du fichier, `automationcancel`, `ExportOkBtn` (AXButton, AXPress).
- Même feuille, export : « Exportation », `ExportProgress:38.4%` … `97.4%` (jamais 100 %), un bouton sans nom (annulation : jamais pressé).
- Même feuille, fin : `automationopenFolderBtn`, `publish_pc_btn`, `automationcloseBtn` (AXPress).
- Pendant un changement de page, CapCut répond `cannotComplete` à une lecture.
