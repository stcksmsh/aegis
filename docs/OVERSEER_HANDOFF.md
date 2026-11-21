# Aegis overseer handoff

State for the next session that drives Aegis to its 1.0 release. Read this in full before acting;
`/aegis-overseer` (`.claude/skills/aegis-overseer/SKILL.md`) says how to boot and keep it current.

Last updated: 2026-11-21, **v1.0.0 released**.

## Where things are

| What | Where |
|---|---|
| Work branch | `master` (v1.0.0 = 30f7df3, released 2026-11-21: https://github.com/stcksmsh/aegis/releases/tag/v1.0.0). `claude/linux-test-pass` is merged. Update feeds `track-1.0` and `track-1` exist with all 11 platforms. |
| `master` | local `master` = 2e87425 (13 commits ahead of `origin/master` 05a1407, never pushed). Those 13 are also on the work branch. Merge the branch into `master` when the user says so. |
| Version | `1.0.0` in `tauri.conf.json` + both `Cargo.toml`, CHANGELOG heading "1.0.0 (2026-11-21)" (bump committed on the work branch; not tagged). |
| Linux installer (local) | `target/release/bundle/deb/Aegis_0.2.0_amd64.deb`, build: `cd apps/ui/src-tauri && npm_config_cache=/secondary/aegis-pb-test/npm-cache npx --yes @tauri-apps/cli@2 build --bundles deb`. The user installs it: `sudo apt install --reinstall <deb>` (needs their password, in their own terminal, not `!`). |
| Windows installer | Run 44906730130 (9b3a56b) downloaded to `/secondary/aegis-win-installer/{nsis,msi}/`. Rebuild after fixes:  Every push to `claude/**` or `master` builds installers as CI artifacts; take the newest run on the work branch: `gh run list --branch claude/linux-test-pass -L 1`, then `gh run download <run> -n aegis-x86_64-pc-windows-msvc -D /secondary/aegis-win-installer` (131 MB; slow). |
| Scratch test data | `/secondary/aegis-pb-test/` (test disk image, test files, npm cache). Safe to delete. |

## The user's machine (rules)

- **Never write scratch data, disk images or big downloads under `/home`** (including the job tmp dir): `/home` is nearly full. Use `/secondary`.
- No passwordless sudo; anything needing sudo (apt install) the user runs in their own terminal.
- GNOME 46 on X11 (Ubuntu 24.04 / Mint-Y-Dark-Aqua theme, prefers dark). `gio mime text/html` = Obsidian.
- The user's Aegis runs from the installed .deb; the stick is a Kingston DataTraveler 3.0 (57.8 GB, ~10 MB/s writes), mounted at `/media/stcksmsh/aegis*`. Their backup "AegisElena" (Elena + Music/Tools) is on it.
- Don't drive the user's desktop with xdotool clicks while they work; ask them to click and report.

## Done in this pass (all on the work branch)

Confirmed working by the user on Linux:
- Notifications show on GNOME (one D-Bus connection kept open; GNOME deletes an installed app's notifications when the sender's connection closes).
- Drives plugged in while Aegis runs are noticed (udev socket is nonblocking; the listener used to quit at startup).
- Old-backup cleanup on by default (7 daily / 4 weekly / 12 monthly, 3 newest); a removed folder's backups age out (group by host only).
- Backup cards (Back up now / Restore… / own progress / Waiting), Back up all, per-drive queue (one backup at a time per drive).
- Folder picker: Browse fills, Add adds, no duplicates, rename; a folder left in the box is added on Next / Set up / Save.
- Same passphrase as an existing backup on this computer = join: folders added, name kept, backup starts right away. Edit folders adding a folder also starts a backup.
- "Add drive" → **Add backup**, "Your drives" → **Your backups** (the user suggested "vault"; we keep "backup" everywhere).
- Theme button (system/light/dark; Linux reads the desktop's color-scheme from the settings portal).
- Erasing a drive forgets the backups that were on it. Delete from drive (one backup of several).
- Tray: drive name, Back up "<name>" per backup, Back up all, Eject (no window, result as notification); Open Aegis raises the window on GNOME (hide + show).

Built but **not yet confirmed by the user**:
- Passphrase sheet shown and printed inside Aegis (d5f7e32). Risk: the CSP might block the srcdoc iframe (blank dialog); macOS WKWebView printing from an iframe is unverified.
- Tray Eject notification, Open Aegis raise when the window is merely behind others.
- E2E fix for Windows (8e791cf: `AEGIS_CONFIG_DIR`, test-only). Check the CI run for this push: E2E (windows-latest) must pass.

## Windows VM pass (2026-11-21)

VirtualBox 7.2 VM `WIN10`; xHCI USB enabled, user added to `vboxusers`; stick passed via Devices → USB.
Confirmed: install (no SmartScreen prompt), setup + backup, theme, tray menu, close-to-tray, plug-in
detection, Eject, restore into a folder with files, `restore-windows.bat`.
Found: notifications sometimes show as "Windows PowerShell" → fixed in afad99f (notify-rust `app_id`
= bundle identifier), needs a re-test with a new CI installer. Start at login: user was restarting to test.

## Open questions / decisions

- **Languages built (2026-11-21, not yet hand-tested in the real app):** `locales/en.json`
  (source) + `locales/sr.json` (Cyrillic); `sr-Latn` is transliterated in `apps/agent/src/i18n.rs`.
  Agent serves `GET /v1/i18n`; UI `t()` in app.js; config `language` (None = OS language, Linux
  `@latin` → sr-Latn). Settings → Language reloads the page. Notifications, tray, errors, sheet,
  drive-details note all translated. Checked headless (Chrome in `unshare -rn` netns with a scratch
  agent): Cyrillic and Latin screens render. Serbian: Claude draft + review pass (e048a2b); user to proofread in the app.
  Weblate setup steps in docs/TRANSLATING.md (user must create the account).
- Passphrase sheet: button removed from Your backups; offered once after a **new** backup is set
  up; single language.
- Open: restore kit on the drive still carries README.txt **and** PROCITAJ.txt (both languages).
  Plan said "setup language only"; kept both for now (someone without Aegis may read either).
  Ask the user.
- Restore confirmed working on Linux and macOS (user has a Mac).

- The morning erase of the stick: the user isn't sure they unticked "Erase this drive"; treated as user error. If an erase ever happens without the red "Erase … This can't be undone" confirm, it is a release blocker.
- Joining on Add backup also adds the pre-ticked Documents/Pictures/Desktop unless unticked; asked the user whether the "added" message should list the folders or only custom folders should join. No answer yet.
- Not built (offered): delete oldest backups automatically when the drive is full (Time Machine does); today Aegis warns at 90 %.
- Windows/macOS: no hands-on test yet. Tray submenus, theme detection (uses the web view's own media query there), print dialog, notifications all need a look.

## Decisions 2026-11-21 (user)

- Remaining hand tests (Linux/Windows/Mac leftovers) are "ok for now": not blocking 1.0.
- Join message lists the added folders (done, ed76edb).
- Unsigned installers (SmartScreen / Gatekeeper) are fine for 1.0.
- AEGIS-RESTORE: English README always + PROCITAJ.txt when Aegis runs in Serbian (done).

## After 1.0 (open)

- Logo redesign: brief given to the user (needs app icon 1024 + monochrome tray glyph; tray uses the colour app icon today, wrong for macOS menu bar). When files arrive: `tauri icon`, template tray icon on macOS, replace the CSS "A" badge.
- v1.0.0 was re-released 2026-11-21 on 5a0c6c0 with the new logo (first build had 18 downloads, some ours). README, release notes, repo description/topics and guide screenshots updated (22dd7f6+).
- README demo GIF re-recorded 2026-11-21 by `scripts/demo/make-demo.sh` (sandboxed scripted Chrome + debug agent); re-run after UI changes.
- Unreleased for 1.0.1: "Not now" on the sheet offer (CHANGELOG "Unreleased").
- GitHub social preview image: upload in repo Settings (no API); use assets/brand/wordmark.svg exported as PNG 1280x640.
- Remaining hand tests were waived for 1.0; run them before 1.0.1.
- Weblate setup (docs/TRANSLATING.md), auto-delete oldest when drive full.

## Next steps toward 1.0 (historical)

1. User finishes Linux leftovers (checklist below), confirms the "not yet confirmed" items above.
2. Windows VM pass with the newest CI installer (download a fresh one after the last push).
3. macOS: at least CI builds; hands-on if the user has a Mac.
4. Merge `claude/linux-test-pass` into `master`, push (user's call).
5. Release (CLAUDE.md): bump to 1.0.0 in `tauri.conf.json` + both `Cargo.toml`, CHANGELOG heading "1.0.0", tag `v1.0.0`, push the tag.

## Linux checklist leftovers (not yet run)

- Restore: everything, selected files, into a folder with files (nothing overwritten), Stop restore.
- AEGIS-RESTORE kit without Aegis (`bash restore-linux.sh`).
- Unplug mid-backup → "Interrupted", older backups intact.
- Log out/in: Aegis in tray, plug-in backup works; Start at login off stays off.
- Back up again every N hours.
- Set up with Erase ticked; Forget; Forget and erase (secure wipe, Linux only).
- Two backups on one stick with **different** passphrases: two cards, two tray entries, Back up all queues, restore one while the other backs up, Delete from drive.

## Windows VM checklist

Same as Linux, plus: a USB hard drive (reports as "fixed"), drive detection by polling (~3 s), Eject, notifications, tray menu (names, eject), theme button, print dialog for the passphrase sheet, Start at login (registry Run key), SmartScreen warning on install (unsigned build), restore kit `restore-windows.bat`.
