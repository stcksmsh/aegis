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
  `free_bytes` and `total_bytes` (bytes free/total on that drive's mount, if known)
- `last_run`: last run summary; `drive_almost_full` is true if the drive had under 10% free
  space after this run
- `running`: boolean
- `restic_available`: boolean
- `config`: summary flags, including `reminder_days` and `backup_interval_hours`

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
  "auto_backup_on_insert": true,
  "remember_passphrase": false,
  "paranoid_mode": false,
  "reminder_days": 7,
  "backup_interval_hours": 0
}
```

`reminder_days` (0 = off): notify once per day if a trusted drive hasn't backed up in this many
days and isn't connected. `backup_interval_hours` (0 = off): while a trusted drive stays plugged
in, back it up again automatically once this many hours have passed since its last backup.

## Setup Drive
`POST /v1/drives/setup`

Request:
```
{
  "mount_path": "/media/user/USB",
  "label": "Aegis Backup",
  "passphrase": "...",
  "remember_passphrase": false,
  "paranoid_mode": false
}
```

Response:
```
{
  "drive_id": "...",
  "repository_id": "..."
}
```

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

## Restore
`POST /v1/restore`

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
{"mount_path": "/media/user/USB"}
```

Response:
```
{"status": "ejected"}
```
