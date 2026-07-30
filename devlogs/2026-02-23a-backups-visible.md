---
title: Making backups actually visible while they run
date: 2026-02-23
tags: [devlog, aegis, rust, ux]
---

Up to now the dashboard just said "Drive / Last backup / Protection" and gave you nothing while a backup was actually happening. [Added a real progress bar and log stream](https://github.com/stcksmsh/aegis/commit/2ae95026f042ecdbc87b7d48150ab49db6f2447d) — parse restic's `--json` status output and push a state + log update every 5%, instead of the UI just sitting there looking frozen. Also fixed the copy contradicting itself ("Backup in progress" next to "ready to back up" at the same time, which is exactly as confusing as it sounds), and added a "backup may be stuck" hint after 30 minutes idle.

Bigger one: parallel backups. Multiple drives can each run their own backup now — `running_drive_ids` + a per-drive progress map — but I had a race where two backups could grab the same drive slot if they started close together, fixed by reserving the drive before spawning the actual restic process instead of after.

Also hardened what happens if you yank the drive mid-backup: each backup/restore gets a cancellation token now, and pulling the drive kills the restic subprocess and cleans up state instead of leaving it in some half-finished limbo. Added Linux desktop notifications (started/finished/failed/interrupted, plus "trusted device connected") and a systemd user service so the agent can just run as a background service instead of needing to be launched manually.
