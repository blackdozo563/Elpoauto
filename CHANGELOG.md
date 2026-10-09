# Changements

## 0.5.0
- Livraison autonome : dépendances verrouillées, build DMG arm64 sur GitHub Actions, signature ad hoc et vérification native du paquet avant publication.
- Compatibilité FFmpeg 7 : cadence constante rétablie après normalisation des filtres d'assemblage pour permettre le rendu réel des transitions.
- Corrections avant publication : chemins macOS canoniques, mise à jour de l'index global entre les montages d'un lot sans masquer les changements externes, préférence pour les ressources de style disponibles et contrôle de leur présence à l'écriture.
- Interface entièrement refaite : deux modes visibles (Montage complet, Production en lot), page Projets avec couvertures, filtres et sélection multiple, timeline visuelle avec forme d'onde et raccords déplaçables, palette ⌘K, menu macOS natif (⌘C/⌘V rétablis), vibrancy, progression et badge dans le Dock, notifications.
- Mode 1 : étapes Médias → Scènes → Style → Vérifier → Générer & exporter ; export direct du projet généré.
- Mode 2 : montage en lot des timelines vides puis export en lot des projets cochés.
- Export ELPO (FFmpeg) : file d'attente, résolution, images/s, qualité, H.264/HEVC, VideoToolbox, SRT incrusté, nommage sans écrasement.
- Export via CapCut 9.3 : pilotage calibrable (projet en tête de liste, ⌘E, bouton Exporter, détection d'un fichier complet, fermeture de la fenêtre de fin d'export, retour à l'accueil), détection préalable des médias manquants.
- Moteur : panoramiques et Ken Burns, transitions variées (ordre déterministe), effets et filtres recopiés depuis tes projets (par scène ou sur toute la vidéo), musique de fond, favoris (projet « ELPO Favoris » + étoiles), styles enregistrés.
- Toutes les fonctions 0.4.0 conservées : 6 placements, dossier Flow, plan éditable, SRT, JSON, aperçu, sauvegardes, restauration, récupération.
