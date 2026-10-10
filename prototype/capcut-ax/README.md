# CapCut AX Prototype — preuve d’export sur Mac

Prototype autonome Swift, séparé d’Electron et du moteur de montage. Cible : CapCut 9.3.0 français, Apple Silicon ARM64, macOS 12 ou ultérieur. Aucune dépendance externe. Aucune release de l’application ELPO n’est publiée par ce workflow.

## Test réel

1. Décompresse `CapCut-AX-Prototype-arm64.zip`, copie `CapCut AX Prototype.app` dans Applications et ouvre cette copie. Signature ad hoc : si macOS bloque son ouverture, utilise Réglages Système → Confidentialité et sécurité → Ouvrir quand même pour cette app téléchargée.
2. Clique « Autoriser ce prototype » et accorde l’Accessibilité à **CapCut AX Prototype**. L’autorisation d’ELPO est distincte. Reviens dans le prototype. Aucune autorisation de capture d’écran ou d’Automatisation n’est utilisée.
3. Dans CapCut, ouvre TESTO et sa feuille de réglages d’export. Configure le format MP4 et le dossier avant le test. Le prototype n’ouvre pas de projet et ne règle pas l’export.
4. Dans le prototype, vérifie le nom attendu, puis clique **Lancer le test d’export**. Ensuite, ne clique plus dans CapCut. Le prototype active CapCut, relit la même feuille et le même chemin, puis tente une seule commande.
5. Le rapport est créé automatiquement dans **Bureau → Rapports CapCut AX** et actualisé pendant le test. Le bouton « Afficher le rapport JSON » le retrouve à la fin. Joins ce JSON pour établir la preuve ou analyser l’échec.

Laisse le Mac éveillé et déverrouillé pendant le test. La validation décode intégralement la vidéo et l’audio ; elle peut prendre plusieurs minutes après la fin du rendu. Les limites sont 120 secondes pour un premier signe d’encodage, deux heures d’observation et trente minutes pour le décodage.

## Commande unique et coordonnées

- Recherche de `AXSheet` par les API natives, puis parcours de ses seuls enfants. Le bouton est reconnu exclusivement par l’identifiant connu `ExportOkBtn` exposé dans AXIdentifier, AXDescription ou AXTitle, éventuellement sur le texte enfant d’un bouton.
- Si `AXPress` est annoncé, une seule tentative est faite. Même si son retour est une erreur, **aucun clic de secours n’est envoyé ensuite** : l’appel peut avoir eu un effet.
- Sinon, le clic de secours doit être autorisé avant le test. Ses coordonnées proviennent du contrôle natif relu, en points macOS sans multiplication Retina. Son rectangle doit appartenir à la feuille et à l’écran ; le contrôle réellement sous le point est vérifié par hit-test AX ; CapCut doit être au premier plan.
- Pas de coordonnées calibrées, de reconnaissance visuelle, de touche Entrée, d’annulation d’export ou de fermeture de CapCut.
- Un verrou persistant est enregistré avant la commande. En cas d’échec ou d’arrêt d’observation, un nouveau test reste bloqué. Il ne se réinitialise qu’après une vérification explicite dans CapCut. Le bouton de réinitialisation sert à préparer un prochain test, jamais à poursuivre automatiquement celui en cours.

## Lecture du rapport

- `commandAttempted` : une tentative a consommé l’autorisation unique ; `commandResult` distingue AXPress accepté, retour incertain ou événements de clic postés.
- `encodingDetected` : activité observée dans les fichiers temporaires CapCut, progression native modifiée ou nouveau fichier final. Le rapport indique la source exacte, notamment quand l’encodage est déduit du fichier écrit.
- `exportFinished` : maximum atteint après une progression inférieure, ou fin établie par un fichier final stable et entièrement décodé. `capcutUICompletionObserved` distingue ces deux preuves.
- `mp4Validated` : fichier nouveau ou modifié depuis la commande, atoms MP4 complets, vidéo lisible, durée positive, pistes vidéo et audio entièrement décodées, fichier inchangé pendant la validation.
- `functionalProof: true` et `status: export_reel_valide` : tous les contrôles de l’export réel ont réussi. **Les contrôles CI ne positionnent jamais cette preuve à true.**

Le JSON détaille les attributs lus, erreurs AX, actions, positions et temps. Il conserve les 30 000 premières lectures détaillées, les statistiques de toutes les lectures et les premiers/derniers relevés ; les omissions sont comptées. Les noms et chemins des projets restent dans ce fichier local ; aucun envoi réseau n’est effectué.

Si le bouton est absent, le rapport documente l’échec natif avant toute proposition de reconnaissance visuelle. Une compilation ou un test de média synthétique ne prouve pas que CapCut expose ni accepte le bouton.

## Compilation et contrôles techniques

Sur un Mac ARM64 avec les outils développeur Apple :

```sh
bash prototype/capcut-ax/build.sh
"dist/capcut-ax-prototype/CapCut AX Prototype.app/Contents/MacOS/CapCutAXPrototype" --self-test
"dist/capcut-ax-prototype/CapCut AX Prototype.app/Contents/MacOS/CapCutAXPrototype" --verify-mp4 /chemin/video.mp4
```

`--verify-mp4` teste uniquement la validation du média et produit `functionalProof: false`, même si le fichier est valide. `--smoke-ui` ouvre brièvement l’interface sans lancer de test CapCut. Le workflow GitHub ne lance aucune commande Exporter.
