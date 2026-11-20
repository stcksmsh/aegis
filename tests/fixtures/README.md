# Drive fixtures (compatibility contract)

Real drives written by released Aegis versions, used by `apps/agent/src/compat_tests.rs`.
**Never edit or regenerate these.** Add a new fixture when a release changes what it writes.

| Folder | Written by | Layout |
|---|---|---|
| `drive-format1/` | Aegis 0.2.0 | `drive_format` absent (= 1), one repo at `.aegis/repo` |
| `drive-format2/` | Aegis 1.0 | `drive_format: 2`, one instance under `.aegis/instances/<id>/` |

Each contains one snapshot of a folder with `hello.txt` (`hello from v0.2.0` / `hello from v1.0`).
Passphrase: `fixture-passphrase`. Empty folders restic created are not stored in git; restic
recreates them as needed.
