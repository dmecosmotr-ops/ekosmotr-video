#!/usr/bin/env bash
# Compile our adapter only against supplied classes. No network/vendor download.
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 2; }
[[ $# -eq 2 ]] || fail 'USAGE_BUILD_RELAY_VENDOR_CLASSPATH_OUTPUT_DIRECTORY'
vendor_classpath="$1"
output="$2"
[[ "$output" = /* && -d "$output" && ! -L "$output" && -w "$output" ]] || fail 'INVALID_RELAY_OUTPUT'
IFS=: read -r -a supplied <<< "$vendor_classpath"
[[ ${#supplied[@]} -gt 0 ]] || fail 'VENDOR_CLASSES_MISSING'
for directory in "${supplied[@]}"; do
  [[ "$directory" = /* && -d "$directory" && ! -L "$directory" ]] || fail 'VENDOR_CLASSES_MISSING'
done
for name in micam/miss/MediaPacket micam/miss/MissClient micam/miss/MissCrypto micam/pppp/InitString micam/pppp/PpppConnection micam/pppp/RelaySession micam/pppp/Uid; do
  found=false
  for directory in "${supplied[@]}"; do
    [[ -f "$directory/$name.class" && ! -L "$directory/$name.class" ]] && found=true
  done
  [[ "$found" = true ]] || fail 'VENDOR_CLASSES_MISSING'
done
command -v javac >/dev/null 2>&1 || fail 'JDK_17_REQUIRED'
source_root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/empty-sourcepath" "$scratch/classes"
# -sourcepath prevents implicitly compiling supplier .java files.
if ! javac --release 17 -implicit:none -sourcepath "$scratch/empty-sourcepath" \
    -classpath "$vendor_classpath" -d "$scratch/classes" \
    "$source_root/tools/RelayLive.java" >/dev/null 2>&1; then
  fail 'RELAY_BUILD_FAILED'
fi
shopt -s nullglob
classes=("$scratch/classes"/RelayLive*.class)
[[ ${#classes[@]} -gt 0 ]] || fail 'RELAY_BUILD_FAILED'
for file in "${classes[@]}"; do install -m 0600 -- "$file" "$output/"; done
printf '%s\n' 'RELAY_BUILD_COMPLETE'
