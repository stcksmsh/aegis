# Changelog

## Unreleased (1.0.0)

- One drive can hold several separate backups (e.g. one per company), each with its own passphrase. Typing a passphrase finds its backup; a passphrase that opens none asks before creating a new one.
- Every backup drive now carries an AEGIS-RESTORE folder: restore your files on any Windows, Mac or Linux computer without Aegis (instructions in English and Serbian).
- Cleaning up old backups only touches this computer's backups, so several computers can share one drive safely.
- Settings saved by a newer Aegis version are kept when an older one runs.
- Hand a backup over to another computer: type the passphrase there, Aegis shows which folders the old computer backed up, and both computers' history stays restorable. The Restore page shows which computer made each backup.
- "Discontinue drive" is now "Forget on this computer", with a reminder to delete local copies when handing over.
- Print a passphrase sheet per backup (name, a blank for the passphrase, restore steps in English and Serbian). It opens inside Aegis with a Print button, so it doesn't depend on which app your computer uses for web pages.
- Automatic updates (signed): fixes for your version install by themselves when Aegis is idle, never during a backup or restore. Newer versions are offered with one click; security releases install automatically; a new major version never installs by itself. Policy: `update_policy` in the config (`security` default, `all`, `off`).

- The passphrase is asked for only when it's needed, and kept only after it worked. The choice between remembering it and typing it every time is in Settings.
- Settings and Advanced each save only their own fields and keep what you typed while the page refreshes. Advanced is its own page.
- The dashboard shows how the last backup went ("Last backup finished today at 14:02. Everything was saved."), with a progress bar while it runs.
- Restore: **Browse…** to pick the folder, and **Stop restore** to stop one (files restored so far are kept).
- Setup: plainer drive list and steps; setting a drive up again keeps its name and history. "Export recovery kit" is now **Save drive details** (Advanced).
- Erasing a drive asks with a red **Erase drive** button that names the drive. "Forget and erase" erases first, so a failed erase leaves the drive listed.
- Error messages for opening, erasing and updating say what to do next. A failed update can be tried again.
- A backup's name is just **Name** everywhere; **Rename** sits with each drive.
- A backup folder that was moved or deleted no longer looks like "files were open": the backup saves the rest and names the missing folders.
- Only the signed updater offers updates; the separate "Download" bar is gone.
- Old backups are cleaned up by default (one per day for 7 days, per week for 4 weeks, per month for 12 months, always the 3 newest), so the drive stops filling up; deleted files stay restorable for up to a year. A folder removed from the backup list is now cleaned up too (before, its backups were kept forever).
- Windows: notifications show as Aegis instead of Windows PowerShell.
- Each backup has its own card on the dashboard (Back up now, Restore…, its own progress) instead of a "Backup on this drive" list. Backups on the same drive run one after another; **Back up all** starts them all. Restoring one backup works while another backs up.
- Setting up with the passphrase of a backup this computer already uses adds the chosen folders to that backup and says so (before, it silently renamed it and replaced its folders).
- After folders are added to a backup (Edit folders, or that passphrase), it is backed up right away so they're included.
- "Add drive" is now **Add backup**, and "Your drives" **Your backups**: what you add is a backup, on a new drive or one that already has backups.
- **Delete from drive** removes one backup and its files from a drive that holds several; the others stay.
- The tray menu shows the plugged-in drive by name with its backups (back up one or all) and can eject it; ejecting from the tray needs no extra confirm and reports the result as a notification.
- Folders: **Browse…** fills in the location (and a name), **Add** adds it (a folder still in the box is added on Next, Set up or Save); a folder or name can't be added twice; added folders can be renamed.
- A theme button (match system / light / dark). On Linux, dark desktop themes are now detected.
- Erasing a drive removes the backups that were on it from Aegis (before, they stayed listed and failed to open).
- Linux: **Open Aegis** in the tray brings the window to the front, also when it was minimized or behind other windows.
- Linux: plugging in a drive while Aegis runs is noticed again (before, only drives already plugged in when Aegis started were seen, so backup-on-insert and "drive connected" never fired).
- Linux: notifications (backup started/finished, drive connected, reminders) now show on GNOME; before, the desktop removed them right away.
- Keyboard and screen readers: drive cards open with the keyboard, focus isn't lost while lists refresh, and dialogs block the page behind them. Better contrast in the light theme.

## 0.2.0 — internal, never released

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
- Automated end-to-end tests (backup → browse → restore) on Windows, macOS and Linux in CI.
- Restore shows progress and a clear result, opens the restored folder, lists newest backups first, and accepts `~/` folders.
- Fixed: restoring selected files on Windows restored nothing; backup details (file count/size) never loaded; Cancel on restore/eject confirmations was ignored; drive space could show the wrong disk.
- Restore: get back just some files. Browse a backup's folders and check the files/folders you want, instead of restoring everything.

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
- Tray menu shows last backup / progress and has "Back up now"; update-available banner; "Open log files" for support.

## 0.1.0

- Initial agent + UI scaffolding (Linux only).
