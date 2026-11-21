// Desktop-shell extras: tray status + "Back up now", version line, open logs.
(() => {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) return;

  function ago(epoch) {
    if (!epoch) return "never";
    const days = Math.floor((Date.now() / 1000 - epoch) / 86400);
    if (days <= 0) return "today";
    return days === 1 ? "yesterday" : `${days} days ago`;
  }

  function trayText(status) {
    if (status.running) {
      const p = Object.values(status.backup_progress || {})[0];
      return p ? `Backing up… ${Math.round(p.percent_done * 100)}%` : "Backing up…";
    }
    const last = Math.max(0, ...(status.trusted_drives || []).map((d) => d.last_backup_epoch || 0));
    return `Last backup: ${ago(last)}`;
  }

  // Backups on the plugged-in drive, for the tray's per-backup entries.
  function trayBackups(status) {
    const trusted = status.trusted_drives || [];
    const running = status.running_drive_ids || [];
    return (status.drive?.instance_ids || [])
      .map((id) => ({ id, label: trusted.find((d) => d.drive_id === id)?.label, running: running.includes(id) }))
      .filter((b) => b.label);
  }

  // The plugged-in drive's name for the tray ("DataTraveler 3.0 (57.8 GB)"). Looked up only
  // when a different drive appears: listing devices scans the disks.
  let driveName = { mount: null, name: null };
  async function trayDriveName(mount) {
    if (!mount) return null;
    if (driveName.mount !== mount) {
      let name = "USB drive";
      try {
        const res = await fetch("http://127.0.0.1:7878/v1/devices");
        const devices = res.ok ? (await res.json()).devices || [] : [];
        const dev = devices.find((d) => (d.partitions || []).some((p) => (p.mountpoints || []).includes(mount)));
        if (dev) name = `${dev.model || "USB drive"} (${String(dev.size || "").replace(/([0-9.]+)([KMGT])$/, "$1 $2B")})`;
      } catch (_) {
        /* keep the generic name */
      }
      driveName = { mount, name };
    }
    return driveName.name;
  }

  async function refreshTray() {
    try {
      const res = await fetch("http://127.0.0.1:7878/v1/status");
      if (!res.ok) return;
      const status = await res.json();
      const mount = status.drive?.connected ? status.drive?.mount_path : null;
      await invoke("set_tray_status", {
        text: trayText(status),
        backups: trayBackups(status),
        drive: await trayDriveName(mount),
      });
    } catch (_) {
      /* agent starting up; next tick retries */
    }
  }
  refreshTray();
  setInterval(refreshTray, 3000);

  tauri.event?.listen("tray-backup", (event) =>
    event.payload ? startBackup(event.payload) : document.getElementById("backup-now")?.click()
  );
  // Eject from the tray: no window and no extra confirm; Aegis notifies the result.
  tauri.event?.listen("tray-eject", async () => {
    try {
      const res = await fetch("http://127.0.0.1:7878/v1/status");
      const mount = res.ok ? (await res.json()).drive?.mount_path : null;
      if (!mount) return;
      await fetch("http://127.0.0.1:7878/v1/drives/eject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mount_path: mount, notify: true }),
      });
      refreshTray();
    } catch (_) {
      /* agent unreachable; nothing to eject */
    }
  });

  // Version line at the bottom of Settings, for bug reports.
  tauri.app.getVersion().then((v) => {
    const panel = document.querySelector("#settings .panel");
    if (!panel) return;
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = `Aegis ${v}`;
    panel.append(p);
  }).catch(() => {});

  const recovery = document.getElementById("export-recovery")?.closest(".field");
  if (recovery) {
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML =
      '<p class="field-title">Having problems?</p><button class="btn secondary" type="button">Open log files</button>';
    field.querySelector("button").addEventListener("click", () =>
      invoke("open_logs").catch(() => {})
    );
    recovery.after(field);
  }
})();

