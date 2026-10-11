# capcut-ax — pilote natif sur relevés réels

Étape préalable demandée : enregistrer un cycle **manuel** CapCut 9.3.0 avec un projet de **5 secondes**. Ce relevé prépare le pilote ; ce n’est aucun des deux essais automatiques (un projet, puis trois projets). Aucune release publique.

## Sans Terminal

1. Décompresse l’archive et copie **capcut-ax.app** dans Applications. Ouvre cette copie. Si macOS bloque cette app à signature ad hoc, utilise Confidentialité et sécurité → Ouvrir quand même.
2. Clique **Autoriser l’Accessibilité de capcut-ax** et active cette app dans les réglages. Son autorisation est distincte de celle d’ELPO et de l’ancien prototype.
3. Dans CapCut, prépare un projet vidéo de 5 secondes avec un nom unique, par exemple **AX-CYCLE-5S**, puis reviens sur Accueil. Ferme ELPO pour qu’aucun autre pilote n’agisse pendant le relevé.
4. Dans capcut-ax, clique **Démarrer l’enregistrement**. Tu peux réduire sa fenêtre ; il continue à observer.
5. Dans CapCut, fais toi-même le cycle suivant : **Accueil → ouvrir le projet → ouvrir les réglages d’export → Exporter → attendre la fin → fermer le panneau de résultat**. Utilise MP4 et un fichier de sortie neuf. Reste environ deux secondes sur Accueil, dans l’éditeur, dans les réglages et sur le résultat pour conserver plusieurs relevés de chaque étape. Ne quitte pas CapCut avant la fin de l’enregistrement.
6. Reviens dans capcut-ax et clique **Terminer l’enregistrement**, puis **Afficher le ZIP à envoyer**. Envoie le ZIP `capcut-record-….zip`. Il contient `record.json` et **tous** les relevés horodatés dans `frames.jsonl`.

L’enregistrement dure au maximum trois minutes par défaut. Fermer ou quitter l’enregistreur pendant le cycle demande sa finalisation, sans interrompre CapCut. Les fichiers sont dans `~/Library/Application Support/CapCutAX/Enregistrements`. Les relevés contiennent les noms et chemins exposés par CapCut ; aucun envoi réseau automatique.

## Ligne de commande

```sh
"/Applications/capcut-ax.app/Contents/MacOS/capcut-ax" state
"/Applications/capcut-ax.app/Contents/MacOS/capcut-ax" record --seconds 180
```

`state` retourne un JSON avec les fenêtres, nœuds AX, rôles, identifiants, descriptions, valeurs, cadres en points macOS, actions annoncées, codes d’erreur et durées. Le budget de lecture est de 850 ms, avec un timeout natif de 250 ms par appel : la réponse vise environ une seconde, sans masquer un dépassement. `complete: false` et `incompleteReasons` rendent les lectures partielles explicites. Une lecture partielle ne confirme jamais l’absence d’un contrôle.

`record` ouvre le petit panneau de contrôle de l’enregistrement et émet immédiatement un accusé JSON `event: pret`. Après démarrage dans ce panneau, il observe sans chevauchement environ une fois par seconde et conserve chaque relevé. Sa sortie est un flux JSON par ligne : prêt, démarrage, résultat final. `--output dossier` change uniquement le dossier des relevés, pas celui de CapCut.

Les commandes `state` et `record` restent strictement en lecture seule. Les commandes d’action sont maintenant :

```sh
capcut-ax open-project "LIYO"
capcut-ax open-export
capcut-ax press-export --name "LIYO" --dir "/Users/recording/Desktop"
capcut-ax close-done
```

Chaque action vérifie l’état natif complet, active CapCut, relit la cible, puis utilise AXPress annoncé ou un point natif avec hit-test strict. Aucun texte visible deviné, point calibré, raccourci ou Entrée. Un titre exact est associé au rectangle natif HomePageDraft qui le contient ; aucun double-clic sur le titre. Sans titre exposé, la première vignette native visible est utilisée après `bumpProject` ; l’identité du projet reste obligatoirement vérifiée par le fichier annoncé avant Exporter.

`press-export` vérifie le nom, le dossier et l’absence du fichier annoncé ; il ne modifie pas les réglages CapCut. La tentative consomme un verrou persistant propre à l’instance CapCut, avant la commande. Un retour AX incertain ne déclenche jamais un clic de secours. Seule une nouvelle instance de CapCut autorise une nouvelle tentative. Les réponses distinguent commande tentée et résultat de l’API ; elles ne déclarent jamais l’export terminé.

Le moteur Electron attend l’apparition du MP4 exact et vérifie avec ffprobe la présence d’une piste vidéo et la durée attendue de la timeline (tolérance : au moins 0,1 s, ou deux images). Aucun décodage intégral. Il attend ensuite le panneau de résultat, appelle close-done, confirme l’éditeur, puis utilise le quit et les protections des fichiers projet conservés. Tout état inconnu arrivé au délai interrompt le lot et produit un rapport dans le dossier de sauvegardes utilisateur, sous capcut-native-reports.

`--replay tests/fixtures/capcut-native-cycle.json` vérifie les états et plans sans CapCut, sans commandes réelles et sans preuve fonctionnelle. Le jeu vient des 76 relevés fournis le 11 octobre : dix relevés représentatifs, chemins personnels anonymisés. Les tests de l’ancien chemin d’export JXA/Entrée ont été remplacés par les vérifications du contrat natif ; les tests des protections de fermeture et du moteur sont maintenus.

## Contrat prévu pour le pilote

- Base : `codex/capcut-ax-prototype`. Conserver le moteur, le rendu, la file, l’interface, `bumpProject` et les protections `quit`/`forceClose`.
- Remplacer le chemin d’export par des actions natives suivies de l’état attendu sous un délai précis ; erreur avec relevé sinon.
- Bouton final : AXPress annoncé, sinon coordonnées AX relues et hit-test vérifié. Aucun second clic incertain, aucun point calibré, jamais Entrée.
- Fin : fichier MP4 **annoncé** nouvellement apparu et durée ffprobe cohérente avec le projet. La progression native n’est qu’un affichage. Aucun décodage intégral.
- Après la fin validée : fermeture native du résultat, `quit` existant, relance, projet suivant.
- Deux essais automatiques prévus : un projet, puis trois. Aucune release publique avant le lot de trois réussi.
