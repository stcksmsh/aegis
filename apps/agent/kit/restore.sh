#!/bin/bash
# Aegis emergency restore (macOS and Linux). Works without Aegis installed.
# Restores one backup from this drive into a NEW folder; never overwrites existing files.
set -u

pause() { printf '\nPress Enter to close this window.'; read -r _; }
fail() { printf '\n%s\n' "$1"; pause; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
drive="$(cd "$here/.." && pwd)"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) arch=darwin_arm64 ;;
  Darwin-*) arch=darwin_amd64 ;;
  Linux-x86_64) arch=linux_amd64 ;;
  Linux-aarch64 | Linux-arm64) arch=linux_arm64 ;;
  *) fail "Sorry, this kind of computer is not supported: $(uname -sm)" ;;
esac

src="$(ls "$here"/restic/restic_*_"$arch".bz2 2>/dev/null | head -n 1)"
[ -n "$src" ] || fail "The restore program for this computer is missing from the drive."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bunzip2 -c "$src" >"$tmp/restic" || fail "Couldn't unpack the restore program."
chmod +x "$tmp/restic"
restic="$tmp/restic"

repos=()
for r in "$drive/.aegis/repo" "$drive"/.aegis/instances/*/repo; do
  [ -f "$r/config" ] && repos+=("$r")
done
[ ${#repos[@]} -gt 0 ] || fail "No Aegis backups were found on this drive."

echo "Aegis emergency restore"
echo
printf 'Type your backup passphrase (nothing appears while you type), then press Enter: '
read -rs RESTIC_PASSWORD
echo
export RESTIC_PASSWORD

repo=""
for r in "${repos[@]}"; do
  if "$restic" -r "$r" cat config >/dev/null 2>&1; then
    repo="$r"
    break
  fi
done
[ -n "$repo" ] || fail "That passphrase doesn't open any backup on this drive. Check it and try again."

echo
echo "Backups on this drive (newest at the bottom):"
"$restic" -r "$repo" snapshots --compact || fail "Couldn't read the list of backups."
echo
printf 'Type the ID of the backup to restore, or just press Enter for the newest: '
read -r snap
snap="${snap:-latest}"
if [ "$snap" != latest ] && ! [[ "$snap" =~ ^[0-9a-fA-F]{4,64}$ ]]; then
  fail "That doesn't look like a backup ID (letters a-f and numbers only)."
fi

base="$HOME/Desktop"
[ -d "$base" ] || base="$HOME"
target="$base/Aegis restore $(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$target" || fail "Couldn't create the folder $target"

echo
echo "Restoring into: $target"
if "$restic" -r "$repo" restore "$snap" --target "$target"; then
  unset RESTIC_PASSWORD
  echo
  echo "Done. Your files are in: $target"
  if command -v open >/dev/null 2>&1; then open "$target"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$target" >/dev/null 2>&1; fi
  pause
else
  fail "The restore did not finish. Files restored so far are in: $target"
fi
