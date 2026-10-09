#!/bin/bash
# Source this file; rename the staged Electron bundle before signing.
# PLIST_BUDDY is injectable only for the portable regression test.
elpo_set_string() {
  local plist_file="$1" key="$2" value="$3"
  "${PLIST_BUDDY:-/usr/libexec/PlistBuddy}" -c "Delete :$key" "$plist_file" >/dev/null 2>&1 || true
  "${PLIST_BUDDY:-/usr/libexec/PlistBuddy}" -c "Add :$key string $value" "$plist_file"
}
elpo_repair_bundle() {
  local app_dir="$1" plist_file="$1/Contents/Info.plist" old_exec
  old_exec="$("${PLIST_BUDDY:-/usr/libexec/PlistBuddy}" -c 'Print :CFBundleExecutable' "$plist_file")" || return 1
  if [[ "$old_exec" != 'TryAIToday AutoCapCut' || ! -x "$app_dir/Contents/MacOS/$old_exec" ]]; then
    printf 'Exécutable principal du runtime inattendu.\n' >&2; return 1
  fi
  # Check every required helper before changing any path.
  local suffix helper old_name new_name helper_plist helper_exec helper_id
  for suffix in '' ' (Renderer)' ' (GPU)' ' (Plugin)'; do
    old_name="TryAIToday AutoCapCut Helper$suffix"
    helper="$app_dir/Contents/Frameworks/$old_name.app"
    if [[ ! -d "$helper" || ! -x "$helper/Contents/MacOS/$old_name" || ! -f "$helper/Contents/Info.plist" ]]; then
      printf 'Composant Electron absent : %s\n' "$old_name" >&2; return 1
    fi
    helper_exec="$("${PLIST_BUDDY:-/usr/libexec/PlistBuddy}" -c 'Print :CFBundleExecutable' "$helper/Contents/Info.plist")" || return 1
    if [[ "$helper_exec" != "$old_name" ]]; then printf 'Identité du composant inattendue : %s\n' "$old_name" >&2; return 1; fi
  done
  mv "$app_dir/Contents/MacOS/$old_exec" "$app_dir/Contents/MacOS/ElpoAiAutoCapcut" || return 1
  elpo_set_string "$plist_file" CFBundleExecutable ElpoAiAutoCapcut || return 1
  for suffix in '' ' (Renderer)' ' (GPU)' ' (Plugin)'; do
    old_name="TryAIToday AutoCapCut Helper$suffix"; new_name="ElpoAiAutoCapcut Helper$suffix"
    helper="$app_dir/Contents/Frameworks/$old_name.app"; helper_plist="$helper/Contents/Info.plist"
    mv "$helper/Contents/MacOS/$old_name" "$helper/Contents/MacOS/$new_name" || return 1
    elpo_set_string "$helper_plist" CFBundleExecutable "$new_name" || return 1
    elpo_set_string "$helper_plist" CFBundleName "$new_name" || return 1
    elpo_set_string "$helper_plist" CFBundleDisplayName "$new_name" || return 1
    case "$suffix" in '') helper_id='com.elpo.ai.autocapcut.helper';; *) helper_id="com.elpo.ai.autocapcut.helper.${suffix:2:${#suffix}-3}";; esac
    elpo_set_string "$helper_plist" CFBundleIdentifier "$helper_id" || return 1
    mv "$helper" "$app_dir/Contents/Frameworks/$new_name.app" || return 1
  done
  # Electron looks for <application name> Helper[ suffix].app/Contents/MacOS/<name>.
  for suffix in '' ' (Renderer)' ' (GPU)' ' (Plugin)'; do
    new_name="ElpoAiAutoCapcut Helper$suffix"
    if [[ ! -x "$app_dir/Contents/Frameworks/$new_name.app/Contents/MacOS/$new_name" ]]; then
      printf 'Vérification du composant échouée : %s\n' "$new_name" >&2; return 1
    fi
  done
}
