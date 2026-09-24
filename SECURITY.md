# Security

Aegis protects people's personal files, so security reports are taken seriously.

## Reporting

Please report vulnerabilities **privately** via [GitHub security advisories](https://github.com/stcksmsh/aegis/security/advisories/new), not public issues. Expect a first reply within a few days.

## Design summary

- **Encryption:** backups are [restic](https://restic.net) repositories (AES-256-CTR + Poly1305, scrypt key derivation). Aegis adds no crypto of its own.
- **Passphrase:** never written to disk or logs, never passed on a command line (environment variable to restic only). Optional storage in the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service). Paranoid mode disables storage entirely.
- **Local API:** the backup engine listens on `127.0.0.1:7878` only. Requests must come from the Aegis window (CORS allowlist) and carry a loopback `Host` header (blocks DNS rebinding from websites). Values passed to restic are validated so they cannot be read as options.
- **Removable media is untrusted:** drive markers (`.aegis/drive.json`) contain no secrets and their contents are sanitized when read.
- **Restore never overwrites** existing files (`--overwrite never`).
- **Supply chain:** the bundled restic binary is a pinned release, verified against restic's published SHA256 checksums at build time.

## Out of scope

Aegis cannot protect against malware already running as your user, or someone who forces you to reveal your passphrase.
