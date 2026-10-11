# Essai 1 : un seul projet, avant le lot de trois

Cette compilation utilise le pilote natif préparé sur les relevés du 11 octobre. Version affichée inchangée : 0.6.4. Le paquet est un artefact de test sur GitHub Actions ; aucune release publique ni tag.

## Préparer avant de lancer

- Quitte l’ancienne app ELPO et installe cette copie dans Applications. CapCut doit rester en version 9.3.0.
- Vérifie l’autorisation Accessibilité d’ELPO. Le paquet contient également `capcut-ax.app` dans `ElpoAiAutoCapcut.app/Contents/Resources`. Si nécessaire, ouvre cet outil, utilise son bouton d’autorisation, puis quitte son panneau sans enregistrer. L’outil doit être autorisé avant le test.
- Vérifie que FFmpeg est détecté dans les réglages existants. **ffprobe est obligatoire**, dans le même dossier que FFmpeg ; le pilote refuse de commencer s’il manque. Aucune installation ni permission n’est demandée après une commande d’export.
- Le projet choisi doit être enregistré, ses médias disponibles et sa durée connue. Choisis le même dossier de sortie dans CapCut et dans ELPO. Le pilote ne change pas le format ou le dossier : prépare MP4 manuellement avant le test.
- Évite un fichier de sortie déjà présent. Le nom annoncé peut avoir le suffixe CapCut `(1)` ; c’est ce chemin exact qui sera surveillé.

## Lancer une seule fois

Sélectionne **un seul projet** et utilise le bouton existant **Tester sur un projet**. Le pilote ferme CapCut avec les protections conservées, place le projet en tête, relance CapCut, ouvre la vignette native, ouvre l’export et tente AXPress une seule fois. Ensuite il attend le MP4 annoncé et sa durée ffprobe, ferme le résultat par AXPress, confirme l’éditeur et quitte CapCut.

Garde le Mac éveillé et déverrouillé. Le calibrage n’est pas utilisé. Aucun clic manuel après lancement, aucune Entrée, aucun second clic Exporter.

## Renvoyer le résultat

Le journal indique **Rapport natif : …/capcut-native-reports/….json**. Le fichier est placé dans le dossier utilisateur de l’app, sous `backups/capcut-native-reports`. Envoie ce JSON et le résultat affiché : Terminé, ou l’erreur exacte.

En cas d’échec d’état ou de commande, CapCut reste ouvert, les projets suivants ne sont pas lancés et le rapport conserve le relevé. Ne relance pas ce test avant l’analyse. Le second et dernier essai sera le lot de trois, après réussite de celui-ci.

Les vérifications CI rejouent les états/actions prévus sur les données AX réelles et testent les délais, erreurs et protections avec des adaptateurs de test. Elles ne constituent pas une preuve d’export automatisé sur ton Mac.
