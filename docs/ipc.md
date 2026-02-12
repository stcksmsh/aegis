# Aegis IPC API (Local)

Base address:
```
http://127.0.0.1:7878
```

Notes:
- Local-only; no auth layer yet.
- Passphrases are accepted only in-memory per request.
- Sensitive paths are not returned by default.

## Status
`GET /v1/status`

Response fields:
- `first_run`: boolean
- `drive`: connected/trusted status + mount path
- `last_run`: last run summary
- `running`: boolean
- `restic_available`: boolean
- `config`: summary flags

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
  "paranoid_mode": false
}
```

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
