# Relever l’échec du bouton Exporter dans la 0.6.4

Ce build ajoute un relevé dans l’application. Il ne corrige pas encore le parcours d’export.

1. Installe le DMG nommé `ElpoAiAutoCapcut-0.6.4-diagnostic-arm64.dmg` dans Applications, puis ouvre cette copie.
2. Arrête tout lot dans ELPO. Dans CapCut, ouvre manuellement TESTO et sa fenêtre d’export. Laisse le bouton Exporter affiché, sans lancer le rendu.
3. Dans ELPO, ouvre Réglages → Pilotage de CapCut → Enregistrer le diagnostic CapCut. Laisse cette fenêtre CapCut dans le même état pendant le relevé.
4. Quand la fenêtre d’enregistrement apparaît, enregistre le JSON puis joins-le au rapport avec la version exacte de CapCut. Les noms et chemins des projets figurent dans ce fichier, qui reste local jusqu’à son partage.

Le relevé conserve les trois lectures du pilote, leurs durées et erreurs, les contrôles bruts, le bouton final détecté, le chemin annoncé, le calibrage et les dernières lignes du journal. Aucun clic, activation de CapCut, raccourci ou déplacement de fenêtre n’est effectué.

## Validation de la correction suivante

- Reproduire la détection qui échoue avec ce relevé réel dans les tests. Une lecture partielle doit rester une lecture incertaine.
- Vérifier sur le Mac concerné que le bouton final lance effectivement le rendu et que sa progression est observée.
- Terminer un export TESTO, vérifier que la vidéo est lisible, puis exécuter un lot de deux projets jusqu’à la fermeture et au passage au suivant.
- Publier la correction après cette validation. Les tests simulés et le lancement du DMG sur GitHub Actions ne prouvent pas que CapCut reçoit le clic sur le Mac concerné.
