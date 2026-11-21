# Aegis IPC API (Local)

Base address:
```
http://127.0.0.1:7878
```

Notes:
- Local-only; no auth layer yet.
- Passphrases are accepted only in-memory per request.
- Sensitive paths are not returned by default.

## Preflight
`GET /v1/preflight`

Reports what this computer can do, so the UI can gate actions without knowing about
platform-specific tools. All fields are plain capability flags, not tool names.

Response fields:
- `restic`: boolean — restic binary is available
- `can_list`: boolean — the agent can list removable drives
- `can_mount`: boolean — the agent can mount a drive
- `can_format`: boolean — the agent can format a drive as exFAT
- `can_wipe`: boolean — the agent can securely wipe a drive (Linux only for now)
- `platform`: `"linux" | "macos" | "windows"`

## Status
`GET /v1/status`

Response fields:
- `first_run`: boolean
- `drive`: connected/trusted status + mount path; when connected and trusted also includes
  `free_bytes` and `total_bytes` (bytes free/total on that drive's mount, if known).
  `instance_ids` lists the backups on the connected drive that this computer uses; `drive_id`
  is the first of them (or the drive's own id when none is set up here).
- `last_run`: last run summary; `drive_almost_full` is true if the drive had under 10% free
  space after this run
- `running`: boolean
- `restic_available`: boolean
- `config`: summary flags, including `reminder_days`, `backup_interval_hours`,
  `update_policy` (`"security" | "all" | "off"`) and `language` (`null` = the computer's language)

Note: every `drive_id` in requests is a backup id ("instance", see COMPATIBILITY.md). For drives
set up before 1.0 it equals the drive's own id.

## Update Config
`POST /v1/config`

Request:
```
{
  "backup_sources": [{"label": "Documents", "path": "~/Documents"}],
  "include_patterns": [],
  "exclude_patterns": [],
  "retention": {"enabled": false, "keep_last": 0, "keep_daily": 0, "keep_weekly": 0, "keep_monthly": 0, "keep_yearly": 0, "min_snapshots": 3},
  "quick_verify": true,
  "deep_verify": false,
  "delete_oldest_when_full": true,
  "auto_backup_on_insert": true,
  "remember_passphrase": false,
  "paranoid_mode": false,
  "reminder_days": 7,
  "backup_interval_hours": 0,
  "language": "sr"
}
```

Every field is optional: only the fields sent are changed. The status `config` includes the full
`retention` policy.

`reminder_days` (0 = off): notify once per day if a trusted drive hasn't backed up in this many
days and isn't connected. `backup_interval_hours` (0 = off): while a trusted drive stays plugged
in, back it up again automatically once this many hours have passed since its last backup.
`delete_oldest_when_full` (default true): before each backup, while the drive has under 10% free,
delete this computer's oldest backups one at a time (never the 3 newest) and notify.
`language`: `"en"`, `"sr"` (Cyrillic), `"sr-Latn"`, or `"system"` (anything else also means the
computer's language). Applies right away to notifications, tray, messages and `GET /v1/i18n`.

## Texts
`GET /v1/i18n`

Every user-facing text in the current language, English where a translation is missing:
`{"lang": "sr", "strings": {"back_up_now": "Направи копију сада", "days_ago_few": "…", …}}`.
Keys come from `locales/*.json` (see docs/TRANSLATING.md); plural forms end in `_one`, `_few`,
`_other`; `{{name}}` marks a value filled in by the app.

## Setup Drive
`POST /v1/drives/setup`

Request:
```
{
  "mount_path": "/media/user/USB",
  "label": "Aegis Backup",
  "passphrase": "...",
  "remember_passphrase": false,
  "paranoid_mode": false,
  "new_instance": false
}
```

The passphrase is tried against every backup on the drive. If one opens, this computer uses it.
If the drive has backups but none opens, the response is `409` unless `new_instance` is true
(then a separate backup is created). If the passphrase opens a backup this computer already
uses, the two join: it keeps its name and the given folders are added to its own (`joined: true`).

Response:
```
{
  "drive_id": "...",
  "repository_id": "...",
  "existing": true,
  "previous_computers": [
    {"host": "laptop", "folders": ["/home/k/Firma"], "last_backup": "2026-11-20T10:00:00Z"}
  ]
}
```
`existing` is true when an existing backup was opened (e.g. handover to a new computer);
`previous_computers` lists the newest backup of each computer that used it; `joined` is true when it
was already used by this computer, and then `added_folders` names the folders that were new to it.

## Start Backup
`POST /v1/backup/run`

Request:
```
{
  "drive_id": "...",
  "passphrase": "..."
}
```

Response:
```
{"status": "started"}
```

## List Snapshots
`POST /v1/snapshots`

Request:
```
{
  "drive_id": "...",
  "passphrase": "..."
}
```

Response:
```
{"snapshots": [{"id": "...", "time": "..."}]}
```

## Snapshot Stats
`POST /v1/snapshots/stats`

Request:
```
{
  "drive_id": "...",
  "snapshot_id": "...",
  "passphrase": "..."
}
```

Response:
```
{"total_size": 0, "total_file_count": 0}
```

## Browse Snapshot
`POST /v1/snapshots/browse`

Lists one directory level inside a snapshot (not the whole tree), so the UI can build an
expandable folder view. Omit `path` (or send `null`/`""`) to list the top level, which is
the backed-up folders' common parent (e.g. shows "Documents", "Pictures", ...) rather than
the whole filesystem root. Pass a `path` from a previous response's `entries[].path` to list
that folder's contents.

Request:
```
{
  "drive_id": "...",
  "snapshot_id": "...",
  "path": null,
  "passphrase": "..."
}
```

Response:
```
{
  "entries": [
    {"name": "Documents", "path": "/home/user/Documents", "type": "dir", "size": null, "mtime": null},
    {"name": "notes.txt", "path": "/home/user/notes.txt", "type": "file", "size": 1234, "mtime": "2026-01-01T00:00:00Z"}
  ]
}
```

## Restore
`POST /v1/restore`

`include_paths` entries are full snapshot-internal paths as returned by the browse API
(`entries[].path`), for files and/or folders. Leave `include_paths` empty to restore
everything. Either way, files land relative to the backed-up folders' common parent (e.g.
`<target_path>/Documents/notes.txt`, not `<target_path>/home/user/Documents/notes.txt`).

Request:
```
{
  "drive_id": "...",
  "snapshot_id": "...",
  "target_path": "/home/user/Restore",
  "include_paths": [],
  "passphrase": "..."
}
```

Response:
```
{"status": "completed"}
```

## Recovery Kit
`POST /v1/recovery-kit`

Request:
```
{
  "drive_id": "...",
  "destination_dir": "/home/user/Desktop/Aegis-Recovery"
}
```

Response:
```
{"status": "created"}
```

## Eject Drive
`POST /v1/drives/eject`

Request:
```
{"mount_path": "/media/user/USB", "notify": false}
```
`notify` (optional): also report the result as a desktop notification (used by the tray menu).

Response:
```
{"status": "ejected"}
```

## Delete Backup
`POST /v1/drives/delete-backup`

Deletes one backup (its folder and repository) from the plugged-in drive and forgets it on this
computer, including the saved passphrase. Other backups on the drive are kept. Fails with `400`
if the name doesn't match, the drive isn't plugged in, or this backup is backing up or restoring.

Request: `{"drive_id": "...", "confirm_label": "<the backup's name>"}` → Response: status, as
`GET /v1/status`.

## Passphrase Sheet
`POST /v1/drives/passphrase-sheet`

Returns a printable page (backup name, blank for the passphrase, restore steps) as HTML in the
current language; the app offers it once, right after a new backup is set up, and prints it.
Contains no secrets.

Request: `{"drive_id": "..."}` → Response: `{"html": "<!doctype html>…"}`

## Cancel Restore
`POST /v1/restore/cancel`

Stops the running restore, if any. The pending `POST /v1/restore` then fails with `409`
"Restore stopped…". Response: `204`.

## Maintenance Hold
`POST /v1/maintenance`

Used by the app before installing an update. `{"hold": true}` fails with `409` while a backup,
restore or drive setup runs; once held, new ones are refused with `503`. `{"hold": false}` releases it. Response: `204`.
