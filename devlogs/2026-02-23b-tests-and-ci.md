---
title: Finally added tests and CI
date: 2026-02-23
tags: [devlog, aegis, rust, ci]
---

Same day as the dashboard work, different mood: [16 unit tests](https://github.com/stcksmsh/aegis/commit/3fa6d8419fe987b1f7cc86e7b5011a2a904c5488) for the boring-but-load-bearing stuff (label sanitizing, repository path resolution, restic's retention-flag construction, JSON parsing, marker-path logic), a GitHub Actions workflow (fmt, clippy, test, release build for the agent; Tauri deps + release build for the UI), and `.gitignore`d the bundled restic binary so it stops nearly getting committed. Should've done this on day one, did it on the day I finally got annoyed enough.
