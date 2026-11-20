# Compatibility contract

Backup drives outlive app versions, and one drive is often used by computers running different
Aegis versions. These rules keep that safe. CI enforces the ones marked **(tested)**.

## Versions

Aegis follows SemVer:

- **Patch (1.0.x):** fixes only. No change to what is written on drives or in the config.
- **Minor (1.x):** additive only. New optional fields and new API endpoints. Every 1.x reads
  what any other 1.x wrote.
- **Major (x.0):** may change the drive format, repo version or config incompatibly. Only with
  explicit user consent and a migration that keeps a working copy until it succeeds.

## Drive format

`.aegis/drive.json` has a `drive_format` integer (`src/drive.rs`, `DRIVE_FORMAT`).

| Format | Written by | Layout |
|---|---|---|
| 2 | 1.x | `instances: [id…]`; each has `.aegis/instances/<id>/instance.json` with `repo_path` |

- An app reads every format up to its own maximum. **(tested: fixtures)**
- Format 2 is the first public format (there is no format 1 in the wild; pre-1.0 drives are
  not supported).
- A drive with a newer format than the app knows is never written to. **(tested)**
- Unknown fields in `drive.json` and `instance.json` are kept on rewrite. **(tested)**
- `instance.json` reserves `label_enc`, `label_kdf`, `label_nonce` (encrypted labels, planned
  for 1.0.x). Readers must ignore them until they are used.
- Everything read from a drive is untrusted: ids are hex-only, `repo_path` must be
  `.aegis/instances/<id>/repo`, labels are sanitized.

## restic repositories

- Repositories use restic repo **version 2** (readable by restic 0.14+).
- The bundled restic (`scripts/restic.sha256`, pinned SHA256) may only be upgraded to a version
  that reads and writes repo version 2 without migrating it.
- Snapshots record the computer's name as host; cleanup only prunes this computer's snapshots,
  grouped by host + folders. **(tested with two hosts)**

## Agent config

`config.json` has `config_version` (`src/config.rs`, `CONFIG_VERSION`; absent = 1).

- Newer versions migrate older configs forward on load.
- Unknown fields at the top level and in each trusted-drive entry are kept on save, so an older
  1.x can run after a newer one (downgrade within a major still starts). **(tested)**
  New settings must go in one of those two places.

## Restore kit on the drive

`AEGIS-RESTORE/kit.json` has `kit_version` (`src/kit.rs`, `KIT_VERSION`). Bump it whenever a
script or README changes. Aegis refreshes older kits after a backup and never downgrades a newer
one. **(tested)**

## Agent ↔ UI API

Today the UI embeds the agent, so both always match. Before the agent ships separately (Windows
service, 1.1), add an `api_version` handshake to `/v1/status`.

## Fixtures

`tests/fixtures/` holds real drives written by each release that changed the on-disk layout.
`src/compat_tests.rs` opens, restores and backs up each one. **Never edit a fixture**; add a new
one when a release writes something new.
