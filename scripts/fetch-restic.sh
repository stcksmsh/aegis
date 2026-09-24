#!/usr/bin/env bash
# Downloads a pinned restic release, verifies its SHA256SUMS, and places the
# binary where Tauri's `bundle.externalBin` sidecar expects it:
#   apps/ui/src-tauri/binaries/aegis-restic-<target-triple>[.exe]
#
# Usage: scripts/fetch-restic.sh <rust-target-triple>
set -euo pipefail

# Bump deliberately; checksum verified against the release's SHA256SUMS.
RESTIC_VERSION=0.19.1

triple="${1:?usage: fetch-restic.sh <target-triple>}"

case "$triple" in
  x86_64-unknown-linux-gnu) asset_os_arch=linux_amd64 ;;
  aarch64-unknown-linux-gnu) asset_os_arch=linux_arm64 ;;
  x86_64-pc-windows-msvc) asset_os_arch=windows_amd64 ;;
  x86_64-apple-darwin) asset_os_arch=darwin_amd64 ;;
  aarch64-apple-darwin) asset_os_arch=darwin_arm64 ;;
  *)
    echo "fetch-restic.sh: unsupported target triple: $triple" >&2
    exit 1
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
out_dir="$repo_root/apps/ui/src-tauri/binaries"
mkdir -p "$out_dir"

case "$asset_os_arch" in
  windows_*) ext=zip; dest_suffix=.exe ;;
  *) ext=bz2; dest_suffix= ;;
esac
dest="$out_dir/aegis-restic-${triple}${dest_suffix}"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

asset_name="restic_${RESTIC_VERSION}_${asset_os_arch}.${ext}"
base_url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}"
download_url="$base_url/$asset_name"
sums_url="$base_url/SHA256SUMS"

echo "fetch-restic.sh: downloading $asset_name..."
curl -sSfL "$download_url" -o "$work_dir/$asset_name"
curl -sSfL "$sums_url" -o "$work_dir/SHA256SUMS"

echo "fetch-restic.sh: verifying checksum..."
expected="$(grep " ${asset_name}\$" "$work_dir/SHA256SUMS" | awk '{print $1}')"
if [ -z "$expected" ]; then
  echo "fetch-restic.sh: no checksum entry for $asset_name in SHA256SUMS" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work_dir/$asset_name" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$work_dir/$asset_name" | awk '{print $1}')"
fi
if [ "$expected" != "$actual" ]; then
  echo "fetch-restic.sh: checksum mismatch for $asset_name (expected $expected, got $actual)" >&2
  exit 1
fi

echo "fetch-restic.sh: extracting..."
if [ "$ext" = "bz2" ]; then
  bzip2 -dc "$work_dir/$asset_name" > "$dest"
  chmod +x "$dest"
else
  unzip -p "$work_dir/$asset_name" "restic_${RESTIC_VERSION}_${asset_os_arch}.exe" > "$dest"
fi

echo "fetch-restic.sh: wrote $dest"
