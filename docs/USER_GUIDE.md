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

   Then choose **Remember my passphrase on this computer** (needed for automatic backups) or **Ask for my passphrase every time**. You can change this later in **Settings**.
4. **Plug in a USB drive** and pick it. You can give the backup a **Name** (optional). You can use a drive that already has files; Aegis stores backups in a hidden `.aegis` folder and does not touch your other files. Erasing the drive is optional: only if you want it wiped first, tick **Erase this drive** and type ERASE. If the drive shows up but can't be used yet, click **Open drive**.
5. Click **Run first backup now** (or **Skip for now**). The first backup takes longest; later ones only copy what changed.

## 3. Everyday use

![Dashboard](images/dashboard.png)

- **Plug in your drive → backup starts automatically** (if Aegis remembers your passphrase and **Start Aegis when I log in** is on). Otherwise open Aegis and click **Back up now**.
- The dashboard shows how the last backup went, for example "Last backup finished today at 14:02. Everything was saved." If it didn't finish, the same line says why and what to do.
- Closing the window keeps Aegis running in the tray / menu bar so it can notice your drive. To stop it fully: tray icon → **Quit Aegis**.
- Wait until the backup is done, then click **Eject drive** before unplugging.
- Under **Your drives**, click a drive to see more: **Rename** changes the name Aegis shows for that backup (the drive itself isn't renamed), **Edit folders** changes what is backed up, **Print passphrase sheet** and **Forget on this computer** are explained in [section 6](#6-moving-backups-to-another-computer).
- When an update is ready, a bar at the top offers **Install and restart**. Aegis never updates in the middle of a backup or restore.
- Unplugged mid-backup? No harm. Older backups stay intact; the next backup picks up again.

## 4. Get files back

1. Plug in the drive, open Aegis, go to **Restore**.
2. Click **Show backups** (each backup is listed with its date).
3. Pick one and choose an empty folder: type it, or click **Browse…**.
4. Click **Restore everything** for the whole backup, or click **Restore selected**.

Aegis restores into the folder you choose; it never overwrites your current files. Changed your mind? Click **Stop restore**; the files restored so far stay in that folder.

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

**Advanced → Save drive details** also saves a short note about where your backup is on the drive, to keep with your papers. It contains no passphrase.

Aegis stores backups in the open [restic](https://restic.net) format, so a technical helper can also restore them with your passphrase.

## 6. Moving backups to another computer

A backup belongs to the data, not to a computer. To let another computer take over (for example, you set it up on your laptop and the office PC should continue):

1. On the new computer: install Aegis, plug in the drive, choose **Add drive**, pick the drive and type the backup's passphrase.
2. Aegis finds the existing backup and shows which folders the other computer backed up. If the files live in different folders on this computer, open the drive under **Your drives** and choose **Edit folders**.
3. Earlier backups stay on the drive and can still be restored. On the Restore page, each backup shows which computer made it. Cleaning up old backups on one computer never deletes the other computer's backups.
4. On the old computer: open the drive under **Your drives** and choose **Forget on this computer**. Aegis stops backing up there and forgets the saved passphrase; the backups on the drive are kept. Delete any copies of the files that should not stay on the old computer.

### Passphrase sheet

Under **Your drives**, **Print passphrase sheet** opens a page to print: the backup's name, a blank to write the passphrase on by hand, and restore steps in English and Serbian. Keep it in a safe place, never together with the drive.

## 7. Settings explained

Each page has its own Save button and saves only what is on that page.

**Settings**

| Setting | Meaning |
|---|---|
| Skip these files or folders | Files to skip, e.g. `*.tmp` or `node_modules`. Aegis already skips temporary files and Windows/Mac system clutter. |
| Quickly check each backup after it's made | After each backup, quickly checks that it can be read. Recommended. |
| Back up automatically when your Aegis drive is plugged in | Automatic backups on plug-in. Needs "Remember my passphrase on this computer". |
| Start Aegis when I log in | Aegis starts in the tray / menu bar when you log in, so it notices your drive. Needed for automatic backups. Takes effect right away. |
| Your passphrase: Remember my passphrase on this computer | Keeps the passphrase in your computer's secure storage so backups run without asking. |
| Your passphrase: Ask for my passphrase every time | Never keeps the passphrase; you type it every time. No automatic backups. |
| Remind me to back up after this many days | If your drive hasn't been backed up for this many days, Aegis reminds you. 0 = never. |
| Back up again every this many hours | If you leave the drive plugged in, Aegis backs up again every N hours. 0 = only when plugged in. |

**Advanced**

| Setting | Meaning |
|---|---|
| Check backups thoroughly | Reads back all backup data after each backup. Much slower; catches failing drives. |
| Only back up files like these | Leave empty to back up everything in your folders. Example: `*.docx, *.pdf`. |
| Clean up old backups | How many old backups to keep (newest, daily, weekly, monthly, yearly). Nothing is deleted unless **Automatically delete old backups based on these settings** is ticked. |
| Save drive details | Saves a short note about where your backup is on the drive. No passphrase in it. |
| Open log files | Opens the folder with Aegis's logs, for when you ask for help. |

## 8. Problems?

| Problem | Fix |
|---|---|
| Drive not detected | Unplug and re-plug. Make sure the drive shows up in your file manager. |
| "Wrong passphrase" | Passphrases are case-sensitive. Check Caps Lock. |
| "Saved, but some files were skipped" | Some files were open or couldn't be read. Everything else was saved. Close other apps and back up again. |
| Can't erase drive | Unplug it, plug it back in, and try again. Still failing? Erase it as **exFAT** with Disk Management (Windows) or Disk Utility (Mac), then try again. |
| "Your backup drive is almost full" | Less than 10% free space is left on the drive. Plug in a bigger drive, free up space on it, or turn on automatic cleanup of old backups in **Advanced → Clean up old backups**. |
| Something else | Open an [issue](https://github.com/stcksmsh/aegis/issues) and attach the logs: **Advanced → Open log files**. They are in: Windows `%LOCALAPPDATA%\aegis\Aegis\data\logs`, Mac `~/Library/Application Support/com.aegis.Aegis/logs`, Linux `~/.local/share/aegis/logs`. Logs never contain your passphrase. |
