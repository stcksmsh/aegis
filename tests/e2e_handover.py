#!/usr/bin/env python3
"""End-to-end handover test: computer A backs up, computer B takes over the same backup,
both histories stay restorable, and cleanup on one computer never touches the other's.

Two computers are simulated on one machine with separate config folders (AEGIS_CONFIG_DIR) and AEGIS_HOSTNAME.
Starts and stops the agent itself (stdlib only).

Usage: e2e_handover.py <aegis-agent binary> <drive mount path>
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:7878/v1"
# Unique per run, so reruns on the same drive start a fresh backup.
PASS = "e2e-handover-" + os.urandom(6).hex()


def call(method, path, body=None, expect=200):
    req = urllib.request.Request(
        API + path, method=method,
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


class Computer:
    """One simulated computer: its own config folder, host name and source folder."""

    def __init__(self, agent, work, name):
        self.agent, self.name = agent, name
        self.home = os.path.join(work, name)
        self.src = os.path.join(self.home, "Firma")
        os.makedirs(self.src, exist_ok=True)
        with open(os.path.join(self.src, f"{name}.txt"), "w") as f:
            f.write(f"from {name}")
        self.proc = None

    def __enter__(self):
        env = {**os.environ, "AEGIS_HOSTNAME": self.name,
               "XDG_CONFIG_HOME": os.path.join(self.home, "config"),
               "APPDATA": os.path.join(self.home, "config"),
               "AEGIS_CONFIG_DIR": os.path.join(self.home, "config"),
               "HOME": self.home}
        self.log = open(os.path.join(self.home, "agent.log"), "w")
        self.proc = subprocess.Popen([self.agent], env=env, stdout=self.log, stderr=self.log)
        deadline = time.time() + 30
        while True:
            try:
                call("GET", "/status")
                break
            except Exception:
                assert time.time() < deadline, "agent did not start"
                time.sleep(0.5)
        call("POST", "/config", {
            "backup_sources": [{"label": "Firma", "path": self.src}],
            "include_patterns": [], "exclude_patterns": [],
            "retention": {"enabled": True, "keep_last": 1, "keep_daily": 0, "keep_weekly": 0,
                          "keep_monthly": 0, "keep_yearly": 0, "min_snapshots": 1},
            "quick_verify": False, "deep_verify": False, "auto_backup_on_insert": False,
            "remember_passphrase": False, "paranoid_mode": False,
        })
        return self

    def __exit__(self, *exc):
        self.proc.terminate()
        self.proc.wait(30)
        self.log.close()

    def backup(self, drive_id):
        call("POST", "/backup/run", {"drive_id": drive_id, "passphrase": PASS})
        time.sleep(1)
        deadline = time.time() + 300
        while call("GET", "/status")["running"]:
            assert time.time() < deadline, "backup timed out"
            time.sleep(1)
        last = call("GET", "/status")["last_run"]
        assert last["status"] == "Success", last


def setup(mount, label):
    body = {"mount_path": mount, "label": label, "passphrase": PASS,
            "remember_passphrase": False, "paranoid_mode": False}
    req = urllib.request.Request(API + "/drives/setup", method="POST",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as err:
        assert err.code == 409, err.read()
        # Drive already holds other backups (e.g. from e2e.py): make a separate one.
        return call("POST", "/drives/setup", {**body, "new_instance": True})


def by_host(snaps):
    out = {}
    for s in snaps:
        out.setdefault(s["hostname"], []).append(s)
    return out


def main():
    agent, mount = os.path.abspath(sys.argv[1]), sys.argv[2]
    work = tempfile.mkdtemp(prefix="aegis-handover-")

    step("computer A sets up and backs up twice (keeps 1)")
    with Computer(agent, work, "computer-a") as a:
        res = setup(mount, "Firma A")
        drive_id = res["drive_id"]
        assert not res["existing"], res
        a.backup(drive_id)
        a.backup(drive_id)

    step("computer B types the same passphrase and continues the backup")
    with Computer(agent, work, "computer-b") as b:
        res = setup(mount, "Firma")
        print("  setup:", res)
        assert res["existing"] and res["drive_id"] == drive_id, res
        prev = res["previous_computers"]
        assert prev[0]["host"] == "computer-a" and prev[0]["folders"] == [a.src], prev
        b.backup(drive_id)
        b.backup(drive_id)

        step("both histories kept, cleanup stayed per computer")
        snaps = call("POST", "/snapshots", {"drive_id": drive_id, "passphrase": PASS})["snapshots"]
        hosts = by_host(snaps)
        print("  snapshots per computer:", {h: len(s) for h, s in hosts.items()})
        assert len(hosts["computer-a"]) == 1 and len(hosts["computer-b"]) == 1, hosts

        step("computer B restores computer A's backup")
        target = os.path.join(work, "restored-a")
        call("POST", "/restore", {"drive_id": drive_id, "snapshot_id": hosts["computer-a"][0]["id"],
                                  "target_path": target, "include_paths": [], "passphrase": PASS})
        got = [os.path.join(d, f) for d, _, fs in os.walk(target) for f in fs]
        assert len(got) == 1 and got[0].endswith("computer-a.txt"), got
        with open(got[0]) as f:
            assert f.read() == "from computer-a"

        step("passphrase sheet")
        sheet = call("POST", "/drives/passphrase-sheet", {"drive_id": drive_id})["path"]
        with open(sheet, encoding="utf-8") as f:
            assert "Firma" in f.read()
        os.remove(sheet)

    step("computer A forgets the drive")
    with Computer(agent, work, "computer-a"):
        call("POST", "/drives/discontinue", {"drive_id": drive_id, "confirm_label": "Firma A"})
        status = call("GET", "/status")
        assert not any(d["drive_id"] == drive_id for d in status["trusted_drives"]), status
    with open(os.path.join(mount, ".aegis", "instances", drive_id, "instance.json")) as f:
        repo = os.path.join(mount, *json.load(f)["repo_path"].split("/"))
    assert len(os.listdir(os.path.join(repo, "snapshots"))) == 2, "forgetting must not touch the drive"

    shutil.rmtree(work, ignore_errors=True)
    print("HANDOVER E2E OK")


if __name__ == "__main__":
    main()
