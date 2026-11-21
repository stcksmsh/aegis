# State 2026-11-22

## Goal
Post-1.0 work, shipped as 1.0.1.

## Done
- v1.0.0 released (5a0c6c0).
- Already existed (no work): stale-backup reminder (config reminder_days), quick verify after every backup (deep verify opt-in), update prompt (apps/ui/src-tauri/src/updater.rs).
- prune-when-full: PR #2 merged (f176514).
- shrink-warning: PR #3 merged (034e028).
- Weblate project created: https://hosted.weblate.org/projects/aegis/app/ (component config correct).

## In flight
- release-1.0.1: version bump + changelog, claude/slice-release-1.0.1.

## Next
1. Tag v1.0.1 after the release PR merges (owner confirms; fixes auto-install for 1.0 users).
2. Weblate links in docs/TRANSLATING.md + README once Serbian is detected.

## Waiting on owner
- Weblate: English shows 0 texts, Serbian not detected; import never finished. Owner: Update+Rescan, or let the coordinator look via Chrome.

## Hard-won facts
- Owner decisions 2026-11-21: prune when <10% free, keep 3 newest, on by default with Settings switch; shrink threshold >30% and ≥50 files, warn only.
- Owner 2026-11-22: "continue and merge everything" — coordinator may merge green, reviewed PRs this session.
- Local check_macos impossible here (no Apple cc); CI macOS jobs cover it. `gh pr edit` broken (Projects classic); use gh api.
- Clippy needs fetch_restic + fetch_restore_kit first (UI build script).
- Each push cancels the previous CI run; `gh pr checks --watch` right after a push can report "no checks" — watch the run id instead.
- Weblate: i18nextv4, filemask locales/*.json, template/new_base locales/en.json, vcs github (PRs by Weblate bot), branch master.
- Older context: docs/OVERSEER_HANDOFF.md.
