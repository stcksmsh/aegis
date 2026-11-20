AEGIS BACKUP DRIVE - HOW TO GET YOUR FILES BACK
================================================

This drive holds encrypted backups made by Aegis. Nobody can open them without
the passphrase. Keep the passphrase on paper in a safe place, away from this drive.

THE EASY WAY (Aegis installed)
------------------------------
Plug in the drive, open Aegis, go to "Restore", and follow the steps.

WITHOUT AEGIS (any computer)
----------------------------
Everything needed is in this folder. Your files are restored into a NEW folder
on the Desktop called "Aegis restore <date>". Nothing on the computer is
overwritten.

Windows:
  1. Open this folder (AEGIS-RESTORE) on the drive.
  2. Double-click "restore-windows.bat".
     If Windows shows "Windows protected your PC", click "More info", then "Run anyway".
  3. Type your passphrase and press Enter.
  4. Press Enter to restore the newest backup (or type the ID of an older one).

Mac:
  1. Open this folder (AEGIS-RESTORE) on the drive.
  2. Double-click "restore-mac.command".
     If the Mac refuses to open it: right-click (or Control-click) the file,
     choose "Open", then click "Open" again.
  3. Type your passphrase and press Enter. Nothing appears while you type; that is normal.
  4. Press Enter to restore the newest backup (or type the ID of an older one).

Linux:
  1. Open a terminal in this folder (AEGIS-RESTORE) on the drive.
  2. Run:  bash restore-linux.sh
  3. Type your passphrase and press Enter, then press Enter again for the newest backup.

If one drive holds backups of several companies or computers, the passphrase
decides which one you get: each passphrase opens only its own backup.

WHAT IS IN THIS FOLDER
----------------------
  restore-windows.bat, restore-windows.ps1   restore on Windows
  restore-mac.command                        restore on a Mac
  restore-linux.sh                           restore on Linux
  restic/                                    the restore program (restic, open source,
                                             https://restic.net) for every kind of computer,
                                             with SHA256SUMS to check the files
  PROCITAJ.txt                               these instructions in Serbian
  kit.json                                   version of this folder (Aegis updates it)

Do not delete the hidden ".aegis" folder on this drive: it holds the backups.

For experts: the backups are standard restic repositories in .aegis/repo and
.aegis/instances/<id>/repo. Any restic 0.14 or newer can read them.
