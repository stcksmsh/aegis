# Aegis User Guide

Aegis backs up your folders to a USB drive. Backups are encrypted with a passphrase only you know. Plug the drive in → Aegis backs up. Lose your computer → plug the drive into a new one and get your files back.

## 1. Install

Go to the [latest release](https://github.com/stcksmsh/aegis/releases/latest) and download the file for your computer:

| Your computer | Download | Then |
|---|---|---|
| Windows | `Aegis_x.y.z_x64-setup.exe` | Double-click. If Windows says "Windows protected your PC": click **More info → Run anyway**. |
| Mac (Apple chip, 2020+) | `Aegis_x.y.z_aarch64.dmg` | Open, drag Aegis to Applications. First launch: see [below](#first-launch-warning). |
| Mac (Intel) | `Aegis_x.y.z_x64.dmg` | Same as above. |
| Linux (Ubuntu, Debian, Mint) | `Aegis_x.y.z_amd64.deb` | Double-click to install, or `sudo apt install ./Aegis_*.deb`. |
| Linux (any other) | `Aegis_x.y.z_amd64.AppImage` | Right-click → Properties → allow executing, then double-click. |

Not sure which Mac you have? Apple menu → **About This Mac**. "Chip: Apple M…" = Apple chip. "Processor: Intel" = Intel.

### First-launch warning

Aegis is free and isn't signed with a paid Apple or Microsoft certificate, so your computer warns you the first time. This happens once.

- **Windows** — "Windows protected your PC": click **More info**, then **Run anyway**.
- **Mac** — "Aegis can't be opened" / "Apple could not verify…":
  1. Click **Done** (not "Move to Trash").
  2. Open **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to Aegis, and confirm with your password.
  3. On older macOS (14 and earlier) you can instead right-click Aegis in Applications → **Open** → **Open**.

Nothing else to install. Aegis includes everything it needs.

**Mac:** the first time Aegis backs up, macOS asks whether Aegis may access your Documents, Desktop, or removable drives. Click **Allow**, or those folders can't be backed up. Changed your mind? System Settings → Privacy & Security → Files and Folders → Aegis.

## 2. First setup (about 2 minutes)

![Welcome wizard](images/welcome.png)

1. Open Aegis. The welcome wizard starts.
2. **Pick folders** to protect (Documents, Pictures, Desktop, or your own).
3. **Choose a passphrase.** Write it down on paper and keep it somewhere safe.
   > ⚠️ Without the passphrase, nobody can open your backups — not even you. There is no reset.
4. **Plug in a USB drive** and pick it. You can use a drive that already has files; Aegis stores backups in a hidden `.aegis` folder and does not touch your other files. Formatting (erasing) is optional.
5. Click **Run first backup now**. The first backup takes longest; later ones only copy what changed.

## 3. Everyday use

![Dashboard](images/dashboard.png)

- **Plug in your drive → backup starts automatically** (if "Remember on this computer" is on). Otherwise open Aegis and click **Back up now**.
- Closing the window keeps Aegis running in the tray / menu bar so it can notice your drive. To stop it fully: tray icon → **Quit Aegis**.
- Wait for "Backup completed", then click **Eject drive** before unplugging.
- Unplugged mid-backup? No harm. Older backups stay intact; the next backup picks up again.

## 4. Get files back

1. Plug in the drive, open Aegis, go to **Restore**.
2. Click **Show backups** (each backup is listed with its date).
3. Pick one and choose an empty folder.
4. Click **Restore everything** for the whole backup, or click **Restore selected**.

Aegis restores into the folder you choose; it never overwrites your current files.

### Getting back just some files

If you only lost a few files or one folder, you don't need to restore everything:

1. After picking a backup, a list of its folders appears below it.
2. Click the arrow next to a folder to look inside it.
3. Check the boxes next to the files or folders you want back.
4. Choose an empty folder, then click **Restore selected**.

### On a new or reinstalled computer

Install Aegis, plug in the drive, choose **Add drive**, pick the drive and type your **original passphrase**. Aegis finds the backup that this passphrase opens. Then use **Restore**.

### Several backups on one drive

One drive can hold separate backups, for example one per company. Each has its own passphrase, and each passphrase opens only its own backup.

To add another one, choose **Add drive** on a drive that already has backups and type a **new** passphrase. Aegis asks before it creates a separate backup, so a mistyped passphrase never starts a new one by accident. If this computer backs up to more than one of them, pick the one you want under **Backup on this drive** on the dashboard and on the Restore page.

## 5. Restoring without Aegis

After each backup, Aegis keeps a folder called **AEGIS-RESTORE** on the drive up to date. It lets you get your files back on any Windows, Mac or Linux computer, even one without Aegis:

1. Open **AEGIS-RESTORE** on the drive and read **README.txt** (in Serbian: **PROCITAJ.txt**).
2. Double-click **restore-windows.bat** (Windows) or **restore-mac.command** (Mac). On Linux, run `bash restore-linux.sh`.
3. Type your passphrase and press Enter twice.

Your files go into a new folder on the Desktop called "Aegis restore" followed by the date. Nothing on the computer is overwritten.

Settings → **Export recovery kit** also saves a small note describing where your backups live on the drive. It contains no passwords.

Your backups are standard [restic](https://restic.net) repositories, so anyone technical can also restore them with restic and your passphrase.

## 6. Moving backups to another computer

A backup belongs to the data, not to a computer. To let another computer take over (for example, you set it up on your laptop and the office PC should continue):

1. On the new computer: install Aegis, plug in the drive, choose **Add drive**, pick the drive and type the backup's passphrase.
2. Aegis finds the existing backup and shows which folders the other computer backed up. If the files live in different folders on this computer, open the drive under **Your drives** and choose **Edit folders**.
3. Earlier backups stay on the drive and can still be restored. On the Restore page, each backup shows which computer made it. Cleaning up old backups on one computer never deletes the other computer's backups.
4. On the old computer: open the drive under **Your drives** and choose **Forget on this computer**. Aegis stops backing up there and forgets the saved passphrase; the backups on the drive are kept. Delete any copies of the files that should not stay on the old computer.

### Passphrase sheet

Under **Your drives**, **Print passphrase sheet** opens a page to print: the backup's name, a blank to write the passphrase on by hand, and restore steps in English and Serbian. Keep it in a safe place, never together with the drive.

## 7. Settings explained

| Setting | Meaning |
|---|---|
| Back up automatically when your Aegis drive is plugged in | Automatic backups on plug-in. Needs "Remember on this computer". |
| Remember on this computer (secure storage) | Stores the passphrase securely on your computer so backups run without asking. |
| Always ask for my passphrase (Paranoid Mode) | Never store the passphrase anywhere; you type it every time. Disables automatic backups. |
| Quick verify | After each backup, quickly checks the backup is readable. Recommended. |
| Deep verify | Reads back all backup data. Slow; catches failing drives. |
| Skip these files or folders | Files to skip, e.g. `*.tmp` or `node_modules`. Aegis already skips common junk like `node_modules`, `.cache`, temporary files, and Windows/Mac system clutter by default. |
| Clean up old backups | How many old backups to keep before removing older ones. Off = keep everything. |
| Remind me to back up after [N] days | If your Aegis drive hasn't been plugged in and backed up for this many days, Aegis reminds you with a notification. 0 turns reminders off. |
| Back up every [N] hours while plugged in | If you leave the drive plugged in, Aegis backs up again automatically every N hours instead of only once. 0 means back up once per plug-in. |

## 8. Problems?

| Problem | Fix |
|---|---|
| Drive not detected | Unplug and re-plug. Make sure the drive shows up in your file manager. |
| "Wrong passphrase" | Passphrases are case-sensitive. Check Caps Lock. |
| Backup says "partial" | Some files were in use or unreadable (e.g. an open database). Everything else was saved. Close apps and back up again. |
| Can't format drive (Windows/Mac) | Format it as **exFAT** with Disk Management (Windows) or Disk Utility (Mac), then try again. |
| "Your backup drive is almost full" | Less than 10% free space is left on the drive. Plug in a bigger drive, free up space on it, or turn on automatic cleanup of old backups in **Settings → Advanced → Clean up old backups**. |
| Something else | Open an [issue](https://github.com/stcksmsh/aegis/issues). Logs live in: Windows `%LOCALAPPDATA%\aegis\Aegis\data\logs`, Mac `~/Library/Application Support/com.aegis.Aegis/logs`, Linux `~/.local/share/aegis/logs`. Logs never contain your passphrase. |
