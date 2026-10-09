#!/bin/bash
set -euo pipefail
app_dir="$HOME/Applications/ElpoAiAutoCapcut.app"
if [[ ! -x "$app_dir/Contents/MacOS/ElpoAiAutoCapcut" ]]; then printf 'Installez d’abord ElpoAiAutoCapcut {{VERSION}}.\n'; exit 1; fi
printf 'Lancement avec journal dans cette fenêtre. Quittez Elpo avant ce diagnostic.\n'
"$app_dir/Contents/MacOS/ElpoAiAutoCapcut" --enable-logging=stderr || true
printf '\nCopiez les dernières lignes si le lancement échoue. Entrée pour fermer.\n'
read -r _ || true
