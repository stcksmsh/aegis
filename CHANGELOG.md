# Changelog

## Unreleased

- UI now follows your system's light/dark theme automatically.
- Passphrase fields have a show/hide toggle and a strength meter ("Too short" / "Okay" / "Strong"); a new passphrase must be at least 8 characters.
- Advanced page: "Retention policy" renamed to "Clean up old backups" with plain labels for each field; fixed the misaligned "Deep verification" checkbox.
- Accessibility: visible focus outlines, screen-reader labels on form fields, live status/progress announcements, and a modal that traps Tab, closes on Escape, and returns focus to what opened it.
- Empty states: "Add drive" button when no drives are set up yet; "No backups on this drive yet" when restoring from an empty drive.
- Window has a minimum size (900x640) and the layout no longer breaks or scrolls sideways at that size.
- Backup reminders: notifies once a day if a trusted drive hasn't backed up in a while (Settings; default 7 days, 0 = off).
- Optional periodic backups while a drive stays plugged in, on top of the usual backup-on-insert (Settings, 0 = off).
- Dashboard shows free/total space on the connected drive, with a warning when it's almost full; notifies after a backup if under 10% free.
- New configs now skip common junk by default (`node_modules`, `.cache`, `*.tmp`, `Thumbs.db`, `.DS_Store`, `$RECYCLE.BIN`, `.Trash*`, Office lock files).
- Restore never overwrites files already in the target folder.
- Restore: get back just some files. Browse a backup's folders and check the files/folders you want, instead of restoring everything.

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
