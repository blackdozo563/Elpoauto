# ElpoAiAutoCapcut 0.4.0 — images Flow

Cette version ajoute un dossier d'images externe au moteur 0.3.1. Le dossier sélectionné remplace les visuels du chutier pour le montage ; la voix off reste celle importée dans CapCut. Le choix du dossier est conservé par projet.

## Parcours sur Mac Apple Silicon

1. Créer ou dupliquer un projet CapCut ; importer la voix off et laisser la timeline vide. Quitter CapCut.
2. Sélectionner le projet dans ElpoAI, puis **Choisir le dossier d'images**. Formats : PNG, JPEG et WebP fixes. Les sous-dossiers, fichiers cachés et autres formats ne sont pas importés ; leur nombre est signalé. Une image reconnue mais invalide bloque l'import.
3. Utiliser des noms `001.png`, `002.png`, `010.png` pour un ordre explicite. Sans SRT, choisir **Partir des médias** pour répartir les images sur la durée audio. Avec un SRT, proposer les scènes puis associer les images.
4. Choisir les zooms/transitions disponibles, écouter l'aperçu, confirmer et générer. Les images sont inscrites comme matériaux dans les fichiers projet et ajoutées au chutier local au moment de l'écriture.
5. Rouvrir le projet dans CapCut pour contrôler le rendu. Garder le dossier d'images à son emplacement : cette version référence les fichiers et ne les copie pas.

Changer de source réinitialise le plan après confirmation. Le bouton **Utiliser le chutier** revient aux médias importés dans CapCut. Un dossier supprimé ou invalide reste remplaçable ; sa disparition bloque la génération.

## Développement et validation

Node.js 24 : `npm test`. Le code n'a pas de dépendance Node externe. Le lancement graphique nécessite Electron 32.3.3, fourni par le runtime du paquet Mac d'origine ; `npm start` suppose son exécutable disponible. Le build autonome Electron et l'export en lot restent des étapes suivantes.

Les tests utilisent des projets synthétiques : ils vérifient génération, absence d'écriture lors de l'analyse, métadonnées, conflits et restauration. La lecture des dimensions du conteneur n'est pas un décodage complet ; l'aperçu signale les erreurs de lecture. Le chargement et le rendu réels doivent encore être validés sur la version cible de CapCut.

`scripts/pack_asar.py` empaquette les sources applicatives et vérifie leurs empreintes. Le paquet Mac de développement conserve le runtime original et sa signature ad hoc ; aucune installation macOS n'est exécutée dans cet environnement Linux.

L'application construit la timeline par modification contrôlée des JSON CapCut, avec sauvegarde. Elle ne produit pas encore de fichier vidéo et ne sélectionne pas les images par compréhension sémantique.
