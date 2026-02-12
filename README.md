# Aegis

Aegis is a security-first external USB backup system built on Rust + Tauri, with restic as the backup engine.

Status: early scaffolding. The agent builds and exposes an IPC API, but the UI is still in progress.

## Dev Prereqs
- Rust toolchain (stable)
- restic available via PATH, or a bundled binary
- Tauri v2 Linux deps (WebKitGTK 4.1 + JavaScriptCoreGtk 4.1 dev packages)

## Running the Agent
From the repo root:

```
cargo run -p aegis-agent
```

## restic Resolution Order
The agent looks for restic in this order:
1. `restic_path` in the Aegis config
2. Bundled binary at `resources/restic/restic` relative to the app
3. `restic` in `PATH`

### Bundling restic (dev)
Place a restic binary at:

```
resources/restic/restic
```

Or set `RESTIC_BUNDLE_PATH` to an absolute path to the restic binary. The agent build will copy it into `target/resources/restic/restic`, which is where the runtime lookup expects it in dev.

## Config Location (Linux)
Aegis uses the `directories` crate. On Linux the config file resolves to:

```
~/.config/aegis/config.json
```

## Security Notes
- Passphrases are never written to disk.
- Optional keychain storage is used when enabled.
- Logs are redacted to avoid leaking sensitive paths or secrets.

## Roadmap (Near Term)
- Tauri UI (first-run wizard + dashboard)
- IPC wiring for backups, restore, and recovery kit
- Bundled restic with pinned version
- Linux USB watcher hardening
