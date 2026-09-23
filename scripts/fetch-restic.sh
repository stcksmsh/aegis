#!/usr/bin/env bash
# Downloads a pinned restic release, verifies its SHA256SUMS, and places the
# binary where Tauri's `bundle.externalBin` sidecar expects it:
#   apps/ui/src-tauri/binaries/restic-<target-triple>[.exe]
#
# Usage: scripts/fetch-restic.sh <rust-target-triple>
set -euo pipefail

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
dest="$out_dir/restic-${triple}${dest_suffix}"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "fetch-restic.sh: looking up latest restic release..."
release_json="$work_dir/release.json"
curl -sSf https://api.github.com/repos/restic/restic/releases/latest -o "$release_json"
version="$(jq -r '.tag_name' "$release_json" | sed 's/^v//')"
echo "fetch-restic.sh: latest restic version is $version"

asset_name="restic_${version}_${asset_os_arch}.${ext}"
download_url="$(jq -r --arg name "$asset_name" '.assets[] | select(.name == $name) | .browser_download_url' "$release_json")"
sums_url="$(jq -r '.assets[] | select(.name | test("^SHA256SUMS$")) | .browser_download_url' "$release_json")"

if [ -z "$download_url" ] || [ -z "$sums_url" ]; then
  echo "fetch-restic.sh: could not find asset $asset_name or SHA256SUMS in latest release" >&2
  exit 1
fi

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
  unzip -p "$work_dir/$asset_name" "restic_${version}_${asset_os_arch}.exe" > "$dest"
fi

echo "fetch-restic.sh: wrote $dest"
