# Changelog

## Unreleased

- Backup reminders: notifies once a day if a trusted drive hasn't backed up in a while (Settings, off by default is 7 days; 0 = off).
- Optional periodic backups while a drive stays plugged in, on top of the usual backup-on-insert (Settings, 0 = off).
- Dashboard shows free/total space on the connected drive, with a warning when it's almost full; notifies after a backup if under 10% free.
- New configs now skip common junk by default (`node_modules`, `.cache`, `*.tmp`, `Thumbs.db`, `.DS_Store`, `$RECYCLE.BIN`, `.Trash*`, Office lock files).

## 0.2.0

- Desktop app now runs the backup agent itself — no separate service or terminal needed.
- Tray / menu-bar icon: closing the window keeps Aegis watching for your drive.
- Windows and macOS support (drive detection, eject, notifications).
- restic bundled in installers (pinned version, checksum-verified at build).
- Release pipeline: pushing a `v*` tag publishes installers for Windows, macOS, Linux.
- Security: local API only accepts requests from the Aegis app (blocks websites from talking to it).
- Docs: user guide for non-technical users, contributing guide.
- Restores land as `<folder>/Documents/...` instead of the full original path.
- Clear messages for wrong passphrase and partial backups (files in use); plain-language text across the app.
- Single instance; starts at login (can be turned off in Settings).

## 0.1.0

- Initial agent + UI scaffolding (Linux only).
