# Aegis User Guide

Aegis backs up your folders to a USB drive. Backups are encrypted with a passphrase only you know. Plug the drive in → Aegis backs up. Lose your computer → plug the drive into a new one and get your files back.

## 1. Install

Go to the [latest release](https://github.com/stcksmsh/aegis/releases/latest) and download the file for your computer:

| Your computer | Download | Then |
|---|---|---|
| Windows | `Aegis_x.y.z_x64-setup.exe` | Double-click. If Windows says "Windows protected your PC": click **More info → Run anyway**. |
| Mac (Apple chip, 2020+) | `Aegis_x.y.z_aarch64.dmg` | Open, drag Aegis to Applications. First launch: right-click Aegis → **Open** → **Open**. |
| Mac (Intel) | `Aegis_x.y.z_x64.dmg` | Same as above. |
| Linux (Ubuntu, Debian, Mint) | `Aegis_x.y.z_amd64.deb` | Double-click to install, or `sudo apt install ./Aegis_*.deb`. |
| Linux (any other) | `Aegis_x.y.z_amd64.AppImage` | Right-click → Properties → allow executing, then double-click. |

Not sure which Mac you have? Apple menu → **About This Mac**. "Chip: Apple M…" = Apple chip. "Processor: Intel" = Intel.

Nothing else to install. Aegis includes everything it needs.

## 2. First setup (about 2 minutes)

1. Open Aegis. The welcome wizard starts.
2. **Pick folders** to protect (Documents, Pictures, Desktop, or your own).
3. **Choose a passphrase.** Write it down on paper and keep it somewhere safe.
   > ⚠️ Without the passphrase, nobody can open your backups — not even you. There is no reset.
4. **Plug in a USB drive** and pick it. You can use a drive that already has files; Aegis stores backups in a hidden `.aegis` folder and does not touch your other files. Formatting (erasing) is optional.
5. Click **Run first backup now**. The first backup takes longest; later ones only copy what changed.

## 3. Everyday use

- **Plug in your drive → backup starts automatically** (if "Remember on this computer" is on). Otherwise open Aegis and click **Back up now**.
- Closing the window keeps Aegis running in the tray / menu bar so it can notice your drive. To stop it fully: tray icon → **Quit Aegis**.
- Wait for "Backup completed", then click **Eject drive** before unplugging.
- Unplugged mid-backup? No harm. Older backups stay intact; the next backup picks up again.

## 4. Get files back

1. Plug in the drive, open Aegis, go to **Restore**.
2. Click **Show backups** (each backup is listed with its date).
3. Pick one, choose an empty folder, click **Restore selected**.

Aegis restores into the folder you choose; it never overwrites your current files.

### On a new or reinstalled computer

Install Aegis, plug in the drive, choose **Add drive**, pick the drive and type your **original passphrase**. Aegis recognizes the existing backups. Then use **Restore**.

## 5. Recovery kit

Settings → **Export recovery kit** saves a small note describing where your backups live on the drive. It contains no passwords. Keep a copy somewhere other than the drive (email to yourself, print it).

Your backups are standard [restic](https://restic.net) repositories. Even without Aegis, anyone technical can restore them with restic and your passphrase.

## 6. Settings explained

| Setting | Meaning |
|---|---|
| Back up automatically when your Aegis drive is plugged in | Automatic backups on plug-in. Needs "Remember on this computer". |
| Remember on this computer (secure storage) | Stores the passphrase securely on your computer so backups run without asking. |
| Always ask for my passphrase (Paranoid Mode) | Never store the passphrase anywhere; you type it every time. Disables automatic backups. |
| Quick verify | After each backup, quickly checks the backup is readable. Recommended. |
| Deep verify | Reads back all backup data. Slow; catches failing drives. |
| Skip these files or folders | Files to skip, e.g. `*.tmp` or `node_modules`. |
| Retention | How many old backups to keep before cleaning up. Off = keep everything. |

## 7. Problems?

| Problem | Fix |
|---|---|
| Drive not detected | Unplug and re-plug. Make sure the drive shows up in your file manager. |
| "Wrong passphrase" | Passphrases are case-sensitive. Check Caps Lock. |
| Backup says "partial" | Some files were in use or unreadable (e.g. an open database). Everything else was saved. Close apps and back up again. |
| Can't format drive (Windows/Mac) | Format it as **exFAT** with Disk Management (Windows) or Disk Utility (Mac), then try again. |
| Something else | Open an [issue](https://github.com/stcksmsh/aegis/issues). Logs live in: Windows `%LOCALAPPDATA%\aegis\Aegis\data\logs`, Mac `~/Library/Application Support/com.aegis.Aegis/logs`, Linux `~/.local/share/aegis/logs`. Logs never contain your passphrase. |
