#!/usr/bin/env bash
# Downloads the restic programs Aegis copies onto every backup drive (the restore kit),
# so backups can be restored on any computer without Aegis. Each file is checked against
# the SHA256 pinned in scripts/restic.sha256 (bump both together with fetch-restic.sh).
#
# Output: apps/ui/src-tauri/restore-kit/ (bundled with the app as a resource).
# Usage: scripts/fetch-restore-kit.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
sums="$script_dir/restic.sha256"
out_dir="$repo_root/apps/ui/src-tauri/restore-kit"
mkdir -p "$out_dir"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

while read -r expected name; do
  [ -n "$name" ] || continue
  dest="$out_dir/$name"
  if [ -f "$dest" ] && [ "$(sha256 "$dest")" = "$expected" ]; then
    continue
  fi
  version="${name#restic_}"; version="${version%%_*}"
  echo "fetch-restore-kit.sh: downloading $name..."
  curl -sSfL "https://github.com/restic/restic/releases/download/v${version}/${name}" -o "$dest.part"
  actual="$(sha256 "$dest.part")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest.part"
    echo "fetch-restore-kit.sh: checksum mismatch for $name (expected $expected, got $actual)" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
done < "$sums"

cp "$sums" "$out_dir/SHA256SUMS"
cp "$repo_root/apps/agent/kit/restic-LICENSE.txt" "$out_dir/LICENSE.txt"
echo "fetch-restore-kit.sh: kit ready in $out_dir"
