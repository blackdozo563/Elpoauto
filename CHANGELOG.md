# Changements

## 0.6.0
- Correctif de pilotage en test : retour sur Accueil depuis le Studio IA, restauration de la géométrie du calibrage, confirmation du projet et du dialogue d'export par Accessibilité, arrêt du lot si l'étape échoue. Aucune commande d'export sur un projet non confirmé. Détection des exports remplaçant un fichier existant et erreur après 90 secondes sans fichier ni encodage confirmé.
- Interface repensée : rail de navigation, **Plateau** en trois zones (chutier, visionneuse, inspecteur) avec la timeline toujours visible, et **Salle de rendu** séparée de la préparation du lot (vidéos en cours, en attente, à revoir, heure de fin estimée).
- Aperçu vivant : après une première analyse, chaque réglage relance l’aperçu (lecture seule) et la visionneuse rejoue les mouvements (zoom, panoramiques, Ken Burns) avec le même calcul que l’écriture CapCut.
- Export automatique (moteur par défaut du lot) : chaque projet, monté par ELPO ou à la main, part sur l’export ELPO s’il est rendu fidèlement, sinon via CapCut, avec la raison affichée (titres, effets, filtres, pistes superposées…).
- Pilotage CapCut : visée plein écran au lieu du compte à rebours, liste « Pilotage prêt ? » avec une action par ligne, HUD au-dessus de CapCut, pause quand la souris bouge (⌥⌘R reprend, ⌥⌘. arrête).
- macOS : icône dans la barre des menus avec la progression, exports qui continuent fenêtre fermée, notification de fin de lot avec « Afficher ».
- Glisser-déposer : un dossier d’images devient la source du projet actif, un SRT ou un plan JSON est chargé dans les scènes.
- Correctifs : calibrage et redétection de FFmpeg n’interrompent plus un pilotage, un seul pilotage à la fois, notification qui ne compte que le lot terminé, forme d’onde calculée par FFmpeg (mémoire constante), CI qui lit la version dans package.json et tests à chaque push.

## 0.5.0
- Livraison autonome : dépendances verrouillées, build DMG arm64 sur GitHub Actions, signature ad hoc et vérification native du paquet avant publication.
- Compatibilité FFmpeg 7 : cadence constante rétablie après normalisation des filtres d'assemblage pour permettre le rendu réel des transitions.
- Corrections avant publication : chemins macOS canoniques, mise à jour de l'index global entre les montages d'un lot sans masquer les changements externes, préférence pour les ressources de style disponibles et contrôle de leur présence à l'écriture.
- Fiabilité : sauvegarde transactionnelle des horodatages pendant le pilotage CapCut, restauration après interruption, vérification de fermeture avant écriture, publication des exports sans écrasement et annulation avant publication.
- Interface entièrement refaite : deux modes visibles (Montage complet, Production en lot), page Projets avec couvertures, filtres et sélection multiple, timeline visuelle avec forme d'onde et raccords déplaçables, palette ⌘K, menu macOS natif (⌘C/⌘V rétablis), vibrancy, progression et badge dans le Dock, notifications.
- Mode 1 : étapes Médias → Scènes → Style → Vérifier → Générer & exporter ; export direct du projet généré.
- Mode 2 : montage en lot des timelines vides puis export en lot des projets cochés.
- Export ELPO (FFmpeg) : file d'attente, résolution, images/s, qualité, H.264/HEVC, VideoToolbox, SRT incrusté, nommage sans écrasement.
- Export via CapCut 9.3 : pilotage calibrable (projet en tête de liste, ⌘E, bouton Exporter, détection d'un fichier complet, fermeture de la fenêtre de fin d'export, retour à l'accueil), détection préalable des médias manquants.
- Moteur : panoramiques et Ken Burns, transitions variées (ordre déterministe), effets et filtres recopiés depuis tes projets (par scène ou sur toute la vidéo), musique de fond, favoris (projet « ELPO Favoris » + étoiles), styles enregistrés.
- Toutes les fonctions 0.4.0 conservées : 6 placements, dossier Flow, plan éditable, SRT, JSON, aperçu, sauvegardes, restauration, récupération.
