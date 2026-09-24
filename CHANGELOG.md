# Changelog

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
