# CLAUDE.md — Aegis maintainer rules

## Product goal

Non-technical person downloads installer from GitHub Release → backs up folders to USB drive on Windows, macOS, Linux. No terminal, no extra installs. Every change serves that.

## Layout

```
apps/agent/          Rust lib + bin. Backup engine: USB watcher, restic wrapper, local HTTP API (127.0.0.1:7878).
  src/lib.rs         run() = bind API + start watcher. Embedded by UI, or run standalone (aegis-agent).
  src/ipc.rs         HTTP routes. CORS limited to Tauri origins + loopback Host check. See docs/ipc.md.
  src/usb.rs         Drive detection (Linux: udev; macOS/Windows: polling).
  src/devices.rs     List/mount/format/wipe drives per OS.
  src/restic.rs      restic CLI wrapper. Passphrase only via env RESTIC_PASSWORD.
apps/ui/src-tauri/   Tauri v2 shell. Embeds agent, tray icon, folder picker.
apps/ui/frontend/    Vanilla HTML/JS/CSS. No build step. Talks to agent over HTTP.
scripts/             fetch-restic.sh — downloads + SHA256-verifies pinned restic for bundling.
docs/                USER_GUIDE.md (end users), ipc.md (API), AGENT_SERVICE.md, usb-testing.md.
.github/workflows/   ci.yml (fmt, clippy, test, build), release.yml (tag v* → installers).
```

## Rules

- **User docs are product.** README top + docs/USER_GUIDE.md must be readable by non-programmer. No jargon (no "udev", "restic repo", "IPC") in user-facing text or UI messages. Feature added/removed → update guide.
- **Laziest correct code.** Reuse existing helpers → stdlib → existing deps → new dep last. No speculative abstraction. Shortest diff that fixes root cause.
- **Never simplify away:** passphrase secrecy (never on disk, never in logs, never CLI args), drive-marker sanitization (removable media is untrusted), API origin/Host checks, restore-never-overwrites.
- **Cross-platform:** any OS-specific call gated by `cfg(target_os)`. Check non-Linux compiles: `cargo check -p aegis-agent --target x86_64-pc-windows-gnu` / `--target x86_64-apple-darwin`.
- **Versions in sync:** `apps/ui/src-tauri/tauri.conf.json` `version` = release tag without `v`. Release CI fails otherwise.

## Before commit

```
cargo fmt --all
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

Non-trivial logic ships one small unit test. Trivial code needs none.

## Release

Bump version in `tauri.conf.json` + both `Cargo.toml` → update `CHANGELOG.md` → tag `vX.Y.Z` → push tag. `release.yml` builds installers for all OSes and publishes the GitHub Release.
