---
title: "Started Aegis: a USB backup agent that doesn't trust anything"
date: 2026-02-12
tags: [devlog, aegis, rust, tauri]
---

The idea: plug in a specific USB drive, it auto-backs-up whatever you've configured, using restic underneath (encrypted, deduplicated, content-addressed) instead of rolling my own backup format. Rust agent + a Tauri UI, IPC between them.

[First commit](https://github.com/stcksmsh/aegis/commit/dc776a2320d80973e6816965a8bbf894c2ad7f9e) already has the real shape: device detection/trust (`devices.rs`, `usb.rs`), a restic wrapper (`restic.rs`), retention policy handling, recovery, and a keychain module for not writing passphrases to disk. "Security-first" isn't just a tagline here — restic actually does the encryption, I'm just the thing that decides when to run it and on which drive.
