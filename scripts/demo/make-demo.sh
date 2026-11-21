#!/bin/sh
# Re-records docs/images/demo.gif + demo.mp4 from the real app screens (Linux only).
# A scripted Chrome drives apps/ui/frontend against a debug aegis-agent: first-run setup,
# first backup, restore of two files. Everything runs in a user + network + mount namespace
# with a private D-Bus and keychain, a tmpfs "USB stick" and a fake home (/home/ana); nothing
# touches the real system or the Aegis you have running.
# Needs: google-chrome, node, ffmpeg, gnome-keyring-daemon, dbus-run-session, unshare.
# Usage: DEMO_DIR=/somewhere/with/space sh scripts/demo/make-demo.sh
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO_DIR="${DEMO_DIR:-$REPO/target/demo}"
export REPO DEMO_DIR

cargo build -q -p aegis-agent --manifest-path "$REPO/Cargo.toml"
[ -x "$REPO/target/debug/aegis-restic" ] || cp "$REPO"/apps/ui/src-tauri/binaries/aegis-restic-* "$REPO/target/debug/aegis-restic"

rm -rf "$DEMO_DIR/home" "$DEMO_DIR/cfg" "$DEMO_DIR/chrome"
mkdir -p "$DEMO_DIR/home/Documents" "$DEMO_DIR/home/Pictures" "$DEMO_DIR/home/Desktop" "$DEMO_DIR/cfg" "$DEMO_DIR/bin" "$DEMO_DIR/node"
cp "$REPO/scripts/demo/lsblk" "$DEMO_DIR/bin/lsblk"
printf 'Rent: 650\nPower: 48\nInternet: 25\n' > "$DEMO_DIR/home/Documents/Budget 2026.txt"
printf 'Dear Ana,\n\nThank you for the lovely weekend!\n' > "$DEMO_DIR/home/Documents/Letter to Ana.txt"
printf 'Passport renewal: March\nCar service: June\n' > "$DEMO_DIR/home/Documents/Reminders.txt"
for n in Beach Birthday Mountains Garden; do head -c 140000 /dev/urandom > "$DEMO_DIR/home/Pictures/$n.jpg"; done

cp "$REPO/scripts/demo/record.js" "$DEMO_DIR/node/record.js"
[ -d "$DEMO_DIR/node/node_modules/puppeteer-core" ] ||
  (cd "$DEMO_DIR/node" && npm init -y >/dev/null && PUPPETEER_SKIP_DOWNLOAD=1 npm i -s puppeteer-core@23)

unshare -rnm dbus-run-session -- sh -c '
  set -e
  mount -t tmpfs tmpfs /media; mkdir -p /media/ana/SANDISK
  mount -t tmpfs -o size=29g tmpfs /media/ana/SANDISK
  mount -t tmpfs tmpfs /home; mkdir -p /home/ana; mount --bind "$DEMO_DIR/home" /home/ana
  ip link set lo up
  export HOME=/home/ana PATH="$DEMO_DIR/bin:$PATH" AEGIS_CONFIG_DIR="$DEMO_DIR/cfg"
  mkdir -p "$HOME/.local/share/keyrings"
  eval "$(printf demo | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
  "$REPO/target/debug/aegis-agent" > "$DEMO_DIR/agent.log" 2>&1 &
  sleep 2
  node "$DEMO_DIR/node/record.js"
  kill $! 2>/dev/null || true
' 2>"$DEMO_DIR/run.log"

# Frames come only when the screen changes: hold each one until the next.
python3 - <<PY
import json
d = "$DEMO_DIR"; t = json.load(open(f"{d}/frames/times.json"))
out = []
for i, ts in enumerate(t):
    out.append(f"file '{d}/frames/{i:05d}.jpg'\nduration {(t[i+1] - ts) if i + 1 < len(t) else 2.5:.4f}")
out.append(f"file '{d}/frames/{len(t)-1:05d}.jpg'")
open(f"{d}/concat.txt", "w").write("\n".join(out) + "\n")
PY
ffmpeg -v error -y -f concat -safe 0 -i "$DEMO_DIR/concat.txt" -vf "setpts=PTS/1.3,fps=10,scale=820:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "$REPO/docs/images/demo.gif"
ffmpeg -v error -y -f concat -safe 0 -i "$DEMO_DIR/concat.txt" -vf "setpts=PTS/1.3,fps=24,scale=1100:-2" -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart "$REPO/docs/images/demo.mp4"
echo "docs/images/demo.gif and demo.mp4 updated"
