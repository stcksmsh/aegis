# Changelog

## Unreleased

- Desktop app now runs the backup agent itself — no separate service or terminal needed.
- Tray / menu-bar icon: closing the window keeps Aegis watching for your drive.
- Windows and macOS support (drive detection, eject, notifications).
- restic bundled in installers (pinned version, checksum-verified at build).
- Release pipeline: pushing a `v*` tag publishes installers for Windows, macOS, Linux.
- Security: local API only accepts requests from the Aegis app (blocks websites from talking to it).
- Docs: user guide for non-technical users, contributing guide.

## 0.1.0

- Initial agent + UI scaffolding (Linux only).
