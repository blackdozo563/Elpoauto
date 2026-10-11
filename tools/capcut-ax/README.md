# capcut-ax record — relevés avant la refonte du pilote

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

**Aucun AXPress, événement souris, raccourci, Entrée, activation, fermeture, décodage de média ou écriture dans les projets CapCut.** L’outil ne fait aucune lecture JXA/System Events. Les actions `open-project`, `open-export`, `press-export` et `close-done` seront implémentées et vérifiées contre ces relevés avant les essais automatiques. Pour l’instant, elles retournent une erreur JSON sans agir.

## Contrat prévu pour le pilote

- Base : `codex/capcut-ax-prototype`. Conserver le moteur, le rendu, la file, l’interface, `bumpProject` et les protections `quit`/`forceClose`.
- Remplacer le chemin d’export par des actions natives suivies de l’état attendu sous un délai précis ; erreur avec relevé sinon.
- Bouton final : AXPress annoncé, sinon coordonnées AX relues et hit-test vérifié. Aucun second clic incertain, aucun point calibré, jamais Entrée.
- Fin : fichier MP4 **annoncé** nouvellement apparu et durée ffprobe cohérente avec le projet. La progression native n’est qu’un affichage. Aucun décodage intégral.
- Après la fin validée : fermeture native du résultat, `quit` existant, relance, projet suivant.
- Deux essais automatiques prévus : un projet, puis trois. Aucune release publique avant le lot de trois réussi.
