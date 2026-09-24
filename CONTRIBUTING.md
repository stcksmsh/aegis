# Contributing to Aegis

## Setup

- Rust stable (`rustup`)
- Linux: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libudev-dev patchelf pkg-config`
- macOS: Xcode command line tools. Windows: MSVC build tools + WebView2 (preinstalled on Win 10/11).
- restic for local dev: `bash scripts/fetch-restic.sh <target-triple>` (e.g. `x86_64-unknown-linux-gnu`) — downloads the pinned, checksum-verified binary where the app build expects it. Or install restic on `PATH`.

## Run

```bash
cargo run -p aegis-ui        # desktop app (starts embedded agent)
cargo run -p aegis-agent     # agent only (headless; API on 127.0.0.1:7878)
```

If an agent is already running (e.g. as a service), the app reuses it.

## Check before pushing

```bash
cargo fmt --all
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

Cross-OS compile check (catches `cfg` mistakes):

```bash
rustup target add x86_64-pc-windows-gnu x86_64-apple-darwin
cargo check -p aegis-agent --target x86_64-pc-windows-gnu
cargo check -p aegis-agent --target x86_64-apple-darwin
```

Manual USB flow: [docs/usb-testing.md](docs/usb-testing.md). API: [docs/ipc.md](docs/ipc.md).

## Release

1. Bump `version` in `apps/ui/src-tauri/tauri.conf.json`, `apps/ui/src-tauri/Cargo.toml`, `apps/agent/Cargo.toml`.
2. Add entry to `CHANGELOG.md`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`

`.github/workflows/release.yml` builds Windows, macOS (Apple chip + Intel) and Linux installers with restic bundled and publishes the GitHub Release.

Installers are intentionally not code-signed (paid certificates). macOS builds are ad-hoc signed so they open via Privacy & Security → Open Anyway; the one-time warning is explained in the user guide and release notes. If signing is ever added: Apple Developer ID / Windows certificate via tauri-action secrets.

## Style

See [CLAUDE.md](CLAUDE.md). Short version: simplest code that works, no jargon in anything a user reads, never weaken passphrase handling.
