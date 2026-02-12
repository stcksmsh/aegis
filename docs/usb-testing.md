# USB Flow Test Checklist (Linux)

Pre-reqs:
- Agent running
- A USB drive available
- restic available

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
