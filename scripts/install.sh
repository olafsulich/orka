#!/usr/bin/env bash
# Put orka on PATH: symlink <dir>/orka -> <repo>/bin/orka.mjs and the transition alias
# <dir>/orca -> <repo>/bin/orca.mjs. Idempotent. Usage: scripts/install.sh [dir]
# (dir defaults to $ORKA_BIN_DIR, then $HOME/bin). Never overwrites a regular file.
set -euo pipefail

# Resolve this script's real location, following symlinks, so it works from any cwd.
src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do
  link="$(readlink "$src")"
  case "$link" in
    /*) src="$link" ;;
    *) src="$(cd -P "$(dirname "$src")" && pwd)/$link" ;;
  esac
done
repo="$(cd -P "$(dirname "$src")/.." && pwd)"

dir="${1:-${ORKA_BIN_DIR:-$HOME/bin}}"
mkdir -p "$dir"
dir="$(cd -P "$dir" && pwd)"

names=(orka orca)
targets=("$repo/bin/orka.mjs" "$repo/bin/orca.mjs")

# Check every destination before changing anything, so a refusal leaves no half install.
for i in "${!names[@]}"; do
  dest="$dir/${names[$i]}"
  if [ ! -e "${targets[$i]}" ]; then
    echo "install: missing ${targets[$i]}" >&2
    exit 1
  fi
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "install: $dest exists and is not a symlink; refusing to overwrite it. Move it away and run again." >&2
    exit 1
  fi
done

for i in "${!names[@]}"; do
  dest="$dir/${names[$i]}"
  target="${targets[$i]}"
  chmod +x "$target"
  if [ -L "$dest" ]; then
    current="$(readlink "$dest")"
    if [ "$current" = "$target" ]; then
      echo "ok: $dest -> $target"
      continue
    fi
    ln -sfn "$target" "$dest"
    echo "replaced: $dest -> $target (was -> $current)"
  else
    ln -s "$target" "$dest"
    echo "linked: $dest -> $target"
  fi
done

on_path=0
IFS=: read -r -a path_dirs <<< "${PATH:-}"
for p in "${path_dirs[@]}"; do
  [ -n "$p" ] && [ -d "$p" ] || continue
  if [ "$(cd -P "$p" && pwd)" = "$dir" ]; then on_path=1; break; fi
done
if [ "$on_path" = 0 ]; then
  {
    echo "warning: $dir is not on PATH. Add this line to ~/.bashrc or ~/.profile, then open a new shell:"
    echo "  export PATH=\"$dir:\$PATH\""
  } >&2
fi

resolved="$(cd -P "$(dirname "$repo/bin/orka.mjs")" && pwd)/orka.mjs"
echo "orka: $dir/orka -> $resolved"
