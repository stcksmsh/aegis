---
name: aegis-overseer
description: >
  Start or resume the Aegis overseer: the session that drives Aegis to its 1.0 release with the
  user (hands-on testing on Linux/Windows/macOS, triage, fixes, installers, release). Use for
  /aegis-overseer, "aegis overseer", "resume Aegis", or "continue the Aegis test pass".
---

# Aegis overseer

Canonical copy: `.claude/skills/aegis-overseer/SKILL.md` in `github.com:stcksmsh/aegis`, on the
current work branch (see the handoff). All state lives in the repo, in `docs/OVERSEER_HANDOFF.md`,
never only in a session or a local folder. git on origin is the only durable store.

## Boot

1. Repo: `/secondary/Programming/Github/aegis`.
   ```sh
   cd /secondary/Programming/Github/aegis && git fetch -q origin && git status -sb && git log --oneline -5
   ```
   Check out the work branch named in the handoff (`git switch <branch> && git pull --ff-only`).
   Don't discard uncommitted changes you didn't make; ask.
2. **Read `docs/OVERSEER_HANDOFF.md` in full and follow it.** Also `CLAUDE.md` (maintainer rules).
3. Check before acting:
   - `gh run list -L 3` for CI on the work branch (E2E on all three OSes must pass);
   - `pgrep -x aegis-ui` and `ls -la /usr/bin/aegis-ui` (is the user running the newest build?);
   - `tail ~/.local/share/aegis/logs/agent.log.$(date -u +%F)` when the user reports a problem.
4. First reply: a short status (branch, CI, what's waiting on the user, next step) and one question.

## Working rules

- Never write scratch data or big downloads under `/home` (nearly full); use `/secondary`.
- The user installs builds themselves (`sudo apt install --reinstall <deb>` in their own terminal).
- Read the log and the code before guessing; test against a scratch agent on `/secondary` when the
  user's Aegis isn't using port 7878.
- Before every commit: `cargo fmt --all`, `cargo clippy --workspace -- -D warnings`,
  `cargo test --workspace`, `cargo check -p aegis-agent --target x86_64-pc-windows-gnu`,
  `node --check` on changed JS. User-facing text: plain words, update `docs/USER_GUIDE.md` and
  `CHANGELOG.md` with the change.

## Keep state durable

- After each finished chunk, before ending, before a context clear, and whenever the user says
  "save state": rewrite `docs/OVERSEER_HANDOFF.md` (state, paths, open questions, next steps,
  lessons), commit and **push**. An unpushed change is not saved.
- If you change this skill, commit and push it, then copy it to `~/.claude/skills/aegis-overseer/`
  and `~/.claude-alt/skills/aegis-overseer/` so `/aegis-overseer` works from every launch point.
- Durable lessons about the user also go into memory.

If arguments are given (`/aegis-overseer <text>`), treat them as the user's first message after the
first reply.
