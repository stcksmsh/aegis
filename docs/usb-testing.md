# USB Flow Test Checklist

Pre-reqs:
- Aegis app running (embeds the agent; restic is bundled)
- A USB drive available (exFAT recommended so it works on every OS)

Platform notes:
- Linux: drives detected instantly via udev. Unmounted drives can be mounted from the app.
- macOS / Windows: drives detected by polling (~3 s after the drive appears in Finder / Explorer). Drive must be mounted by the OS.
- Windows: USB hard drives/SSDs report as "fixed" disks. Add drive lists every non-system drive; once set up, the drive is recognized by its `.aegis` marker. Test with both a USB stick and a USB HDD.
- Secure wipe is Linux-only; the option is hidden elsewhere.

## Fresh setup
1. Insert USB drive.
2. UI shows "Drive detected" and "Untrusted drive".
3. In wizard, set up drive with passphrase.
4. Verify `.aegis/drive.json` exists on the drive and contains a drive ID (no secrets).
5. Confirm Aegis config lists the drive as trusted.

## Auto backup on insert
1. Enable "Run backup when trusted drive is inserted".
2. Re-insert trusted drive.
3. Confirm backup starts automatically (if passphrase stored).

## Manual backup
1. Click "Back up now".
2. Unplug drive mid-backup.
3. Confirm run status becomes "Interrupted" and previous snapshots are intact.

## Restore
1. Load snapshots.
2. Restore to a new folder.
3. Confirm no overwrites unless explicitly allowed.

## Eject
1. Click "Eject drive".
2. Verify the drive powers off or unmounts cleanly.
