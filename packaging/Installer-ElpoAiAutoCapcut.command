#!/bin/bash
set -euo pipefail

package_dir="$(cd "$(dirname "$0")" && pwd)"
destination="$HOME/Applications/ElpoAiAutoCapcut.app"
mounted=""
stage=""
installed="false"
previous=""
cleanup() {
  if [[ -n "$mounted" ]]; then /usr/bin/hdiutil detach "$mounted" -quiet >/dev/null 2>&1 || true; /bin/rmdir "$mounted" >/dev/null 2>&1 || true; fi
  if [[ -n "$stage" && "$stage" == "$HOME/Applications/.elpo-stage-"* ]]; then /bin/rm -rf "$stage"; fi
  if [[ "$installed" != "true" && -n "$previous" && ! -e "$destination" && -d "$previous" ]]; then /bin/mv "$previous" "$destination"; fi
}
trap cleanup EXIT
trap 'printf "\nInstallation interrompue. Aucun projet CapCut n’a été modifié.\n" >&2' ERR

printf '\nElpoAiAutoCapcut · Installation locale {{VERSION}}\n\n'
if [[ "$(/usr/bin/uname -s)" != 'Darwin' ]]; then printf 'Cet installateur est réservé à macOS.\n' >&2; exit 1; fi
if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || printf 0)" != '1' ]]; then printf 'Ce paquet nécessite un Mac Apple Silicon (M1 ou plus récent).\n' >&2; exit 1; fi
if /usr/bin/pgrep -f '/ElpoAiAutoCapcut\.app/Contents/MacOS/' >/dev/null 2>&1; then printf 'Quittez ElpoAiAutoCapcut avant de l’installer à nouveau.\n' >&2; exit 1; fi

dmg="$package_dir/runtime/TryAIToday.AutoCapCut-0.1.2-arm64.dmg"
asar="$package_dir/payload/app.asar"
if [[ ! -f "$dmg" || ! -f "$asar" || ! -f "$package_dir/payload/header.sha256" ]]; then printf 'Paquet incomplet. Décompressez toute l’archive avant de lancer cet installateur.\n' >&2; exit 1; fi
printf 'Vérification des fichiers du paquet…\n'
(cd "$package_dir" && /usr/bin/shasum -a 256 -c payload/checksums.txt)
header_hash="$(/bin/cat "$package_dir/payload/header.sha256")"
if [[ ! "$header_hash" =~ ^[a-f0-9]{64}$ ]]; then printf 'Empreinte de l’archive applicative invalide.\n' >&2; exit 1; fi

/bin/mkdir -p "$HOME/Applications"
stage="$(/usr/bin/mktemp -d "$HOME/Applications/.elpo-stage-XXXXXX")"
mounted="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/elpo-runtime-XXXXXX")"
printf 'Préparation de l’application…\n'
/usr/bin/hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mounted" -quiet
source_app="$mounted/TryAIToday AutoCapCut.app"
if [[ ! -d "$source_app" ]]; then printf 'L’application de référence est absente du DMG. Installation arrêtée.\n' >&2; exit 1; fi
source_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")"
if [[ "$source_id" != 'com.tryaitoday.autocapcut' ]]; then printf 'Identité du runtime inattendue.\n' >&2; exit 1; fi
staged_app="$stage/ElpoAiAutoCapcut.app"
/usr/bin/ditto "$source_app" "$staged_app"
/bin/cp "$asar" "$staged_app/Contents/Resources/app.asar"
plist="$staged_app/Contents/Info.plist"
set_string() {
  /usr/libexec/PlistBuddy -c "Delete :$1" "$plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"
}
# The application name determines Electron's helper lookup path.
unset PLIST_BUDDY
source "$package_dir/payload/repair_bundle.sh"
elpo_repair_bundle "$staged_app"
set_string CFBundleName ElpoAiAutoCapcut
set_string CFBundleDisplayName ElpoAiAutoCapcut
set_string CFBundleIdentifier com.elpo.ai.autocapcut
set_string CFBundleShortVersionString {{VERSION}}
set_string CFBundleVersion {{VERSION}}
set_string CFBundleIconFile ElpoAiAutoCapcut.icns
# The CapCut pilot sends keystrokes through System Events (Apple Events + Accessibility).
/usr/bin/plutil -replace NSAppleEventsUsageDescription -string "ElpoAiAutoCapcut pilote CapCut pour exporter tes projets en lot." "$plist"
set_string LSMinimumSystemVersion 11.0
/bin/cp "$package_dir/payload/ElpoAiAutoCapcut.icns" "$staged_app/Contents/Resources/ElpoAiAutoCapcut.icns"
/usr/libexec/PlistBuddy -c 'Delete :ElectronAsarIntegrity' "$plist" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c 'Add :ElectronAsarIntegrity dict' "$plist"
/usr/libexec/PlistBuddy -c 'Add :ElectronAsarIntegrity:Resources/app.asar dict' "$plist"
/usr/libexec/PlistBuddy -c 'Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256' "$plist"
/usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity:Resources/app.asar:hash string $header_hash" "$plist"

printf 'Signature locale et vérification du bundle…\n'
# Sign renamed helper bundles before the outer bundle.
for helper_app in "$staged_app/Contents/Frameworks/"*.app; do
  /usr/bin/codesign --force --deep --sign - --entitlements "$package_dir/payload/runtime-entitlements.plist" "$helper_app"
done
/usr/bin/codesign --force --deep --sign - --entitlements "$package_dir/payload/runtime-entitlements.plist" "$staged_app"
/usr/bin/codesign --verify --deep --strict "$staged_app"
copied_hash="$(/usr/bin/shasum -a 256 "$staged_app/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')"
expected_hash="$(/usr/bin/awk '$2 == "payload/app.asar" {print $1}' "$package_dir/payload/checksums.txt")"
if [[ "$copied_hash" != "$expected_hash" ]]; then printf 'La copie applicative ne correspond pas au paquet.\n' >&2; exit 1; fi

if [[ -e "$destination" ]]; then
  previous="$HOME/Applications/ElpoAiAutoCapcut.previous-$(/bin/date +%Y%m%d-%H%M%S).app"
  if [[ -e "$previous" ]]; then printf 'Une sauvegarde d’installation existe déjà. Réessayez plus tard.\n' >&2; exit 1; fi
  /bin/mv "$destination" "$previous"
fi
/bin/mv "$staged_app" "$destination"
installed="true"
printf '\nApplication installée : %s\n' "$destination"
printf 'Signature locale ad hoc ; application non notarisée par Apple.\n'
printf 'Cette installation ne modifie aucun projet CapCut.\n'
printf '\nPremier essai : projet vide contenant deux images et une voix off.\n'
ffmpeg_path=""
for candidate in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg; do if [[ -x "$candidate" ]]; then ffmpeg_path="$candidate"; break; fi; done
if [[ -n "$ffmpeg_path" ]]; then printf 'Export ELPO : FFmpeg trouvé (%s).\n' "$ffmpeg_path"
else printf 'Export ELPO : FFmpeg absent. Pour exporter sans CapCut, installe-le avec Homebrew : brew install ffmpeg\n'; fi
printf 'Export via CapCut : autorise ElpoAiAutoCapcut dans Réglages Système → Confidentialité et sécurité → Accessibilité.\n'
if ! /usr/bin/open "$destination"; then printf 'Ouvrez l’application depuis votre dossier Applications personnel. Consultez le guide si macOS bloque son lancement.\n'; fi
printf '\nAppuyez sur Entrée pour fermer cette fenêtre.\n'
read -r _ || true
