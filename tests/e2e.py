#!/usr/bin/env python3
"""End-to-end test: drives a running aegis-agent over its HTTP API against a real
(virtual) drive. Stdlib only, so it runs on every CI OS.

Usage: e2e.py <drive mount path> [--eject]
Needs the agent listening on 127.0.0.1:7878 with restic available.
"""
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:7878/v1"
PASS = "e2e-orbit-candle-river"


def call(method, path, body=None, expect=200):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            status, text = res.status, res.read().decode()
    except urllib.error.HTTPError as err:
        status, text = err.code, err.read().decode()
    assert status == expect, f"{method} {path}: HTTP {status} (want {expect}): {text}"
    try:
        return json.loads(text)
    except ValueError:
        return text


def step(msg):
    print(f"--- {msg}", flush=True)


def wait_for(what, check, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(1)
    raise AssertionError(f"timed out waiting for {what}")


def main():
    mount = sys.argv[1]
    eject = "--eject" in sys.argv

    step("agent up")
    wait_for("agent", lambda: _try(lambda: call("GET", "/status")))
    print(call("GET", "/preflight"))

    work = tempfile.mkdtemp(prefix="aegis-e2e-")
    src = os.path.join(work, "Docs")
    os.makedirs(os.path.join(src, "Taxes"))
    files = {
        "a.txt": b"hello",
        os.path.join("Taxes", "2025 return [final].pdf"): os.urandom(200_000),
        "notes.md": b"# notes",
    }
    for rel, data in files.items():
        with open(os.path.join(src, rel), "wb") as f:
            f.write(data)

    step("config")
    call("POST", "/config", {
        "backup_sources": [{"label": "Docs", "path": src}],
        "include_patterns": [], "exclude_patterns": [],
        "retention": {"enabled": False, "keep_last": 0, "keep_daily": 0, "keep_weekly": 0,
                      "keep_monthly": 0, "keep_yearly": 0, "min_snapshots": 3},
        "quick_verify": True, "deep_verify": False, "auto_backup_on_insert": False,
        "remember_passphrase": False, "paranoid_mode": False,
    })

    if sys.platform != "linux":
        step("drive listed in Add drive")
        def listed():
            devs = call("GET", "/devices")["devices"]
            mounts = [m for d in devs for p in d["partitions"] for m in p["mountpoints"]]
            print("  mounts:", mounts)
            return any(os.path.normcase(m.rstrip("\\/")) == os.path.normcase(mount.rstrip("\\/")) for m in mounts)
        wait_for("drive in /devices", listed, 30)

    step("setup drive")
    drive_id = call("POST", "/drives/setup", {
        "mount_path": mount, "label": "E2E", "passphrase": PASS,
        "remember_passphrase": False, "paranoid_mode": False,
    })["drive_id"]
    assert os.path.exists(os.path.join(mount, ".aegis", "drive.json"))

    step("backup")
    call("POST", "/backup/run", {"drive_id": drive_id, "passphrase": PASS})
    wait_for("backup to finish", lambda: not call("GET", "/status")["running"], 300)
    last = call("GET", "/status")["last_run"]
    print("  last_run:", last)
    assert last["status"] == "Success", last

    step("snapshots + stats")
    snaps = call("POST", "/snapshots", {"drive_id": drive_id, "passphrase": PASS})["snapshots"]
    assert len(snaps) == 1, snaps
    snap = snaps[0]["id"]
    stats = call("POST", "/snapshots/stats", {"drive_id": drive_id, "snapshot_id": snap, "passphrase": PASS})
    assert stats["total_file_count"] >= len(files), stats

    step("wrong passphrase")
    msg = call("POST", "/snapshots", {"drive_id": drive_id, "passphrase": "nope"}, expect=400)
    assert "Wrong passphrase" in str(msg), msg

    step("browse")
    root = call("POST", "/snapshots/browse", {"drive_id": drive_id, "snapshot_id": snap, "passphrase": PASS})["entries"]
    print("  root:", [e["name"] for e in root])
    docs = next(e for e in root if e["name"] == "Docs")
    inner = call("POST", "/snapshots/browse", {"drive_id": drive_id, "snapshot_id": snap,
                                               "path": docs["path"], "passphrase": PASS})["entries"]
    taxes = next(e for e in inner if e["name"] == "Taxes")
    tax_files = call("POST", "/snapshots/browse", {"drive_id": drive_id, "snapshot_id": snap,
                                                   "path": taxes["path"], "passphrase": PASS})["entries"]
    pdf = next(e for e in tax_files if e["name"].endswith(".pdf"))
    print("  pdf path:", pdf["path"])

    step("restore one plain file")
    plain = next(e for e in inner if e["name"] == "a.txt")
    print("  include path:", plain["path"])
    t0 = os.path.join(work, "Plain")
    call("POST", "/restore", {"drive_id": drive_id, "snapshot_id": snap, "target_path": t0,
                              "include_paths": [plain["path"]], "passphrase": PASS})
    got = sorted(os.path.relpath(os.path.join(d, f), t0) for d, _, fs in os.walk(t0) for f in fs)
    print("  restored:", got)
    assert got == [os.path.join("Docs", "a.txt")], got

    step("restore one file (name has [ ])")
    target = os.path.join(work, "Restored")
    call("POST", "/restore", {"drive_id": drive_id, "snapshot_id": snap, "target_path": target,
                              "include_paths": [pdf["path"]], "passphrase": PASS})
    got = sorted(os.path.relpath(os.path.join(d, f), target) for d, _, fs in os.walk(target) for f in fs)
    print("  restored:", got)
    want = os.path.join("Docs", "Taxes", "2025 return [final].pdf")
    assert got == [want], got
    with open(os.path.join(target, want), "rb") as f:
        assert f.read() == files[os.path.join("Taxes", "2025 return [final].pdf")]

    step("restore everything never overwrites")
    mine = os.path.join(target, want)
    with open(mine, "wb") as f:
        f.write(b"MINE")
    call("POST", "/restore", {"drive_id": drive_id, "snapshot_id": snap, "target_path": target,
                              "include_paths": [], "passphrase": PASS})
    with open(mine, "rb") as f:
        assert f.read() == b"MINE", "restore overwrote an existing file"
    with open(os.path.join(target, "Docs", "a.txt"), "rb") as f:
        assert f.read() == b"hello"

    step("status shows drive + space")
    drive = call("GET", "/status")["drive"]
    print("  drive:", drive)
    assert drive["connected"] and drive["trusted"], drive

    if eject:
        step("eject")
        call("POST", "/drives/eject", {"mount_path": mount})
        wait_for("volume gone", lambda: not os.path.exists(mount), 30)
        wait_for("status disconnected", lambda: not call("GET", "/status")["drive"]["connected"], 30)

    print("E2E OK")


def _try(fn):
    try:
        return fn()
    except Exception:
        return None


if __name__ == "__main__":
    main()
