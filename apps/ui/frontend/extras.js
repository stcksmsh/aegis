// Desktop-shell extras: tray status + "Back up now", update check, open logs.
(() => {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) return;
  const REPO = "stcksmsh/aegis";

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

  async function refreshTray() {
    try {
      const res = await fetch("http://127.0.0.1:7878/v1/status");
      if (res.ok) await invoke("set_tray_status", { text: trayText(await res.json()) });
    } catch (_) {
      /* agent starting up; next tick retries */
    }
  }
  refreshTray();
  setInterval(refreshTray, 10000);

  tauri.event?.listen("tray-backup", () => document.getElementById("backup-now")?.click());

  // Newer release on GitHub → banner with download link. Silent on any failure (offline etc.).
  async function checkForUpdate() {
    try {
      const current = await tauri.app.getVersion();
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
      if (!res.ok) return;
      const latest = (await res.json()).tag_name?.replace(/^v/, "");
      if (!latest || !isNewer(latest, current)) return;
      const bar = document.createElement("div");
      bar.className = "status-banner update-banner";
      bar.append(`Aegis ${latest} is available (you have ${current}). `);
      const link = document.createElement("button");
      link.className = "btn secondary";
      link.textContent = "Download";
      link.addEventListener("click", () =>
        invoke("open_url", { url: `https://github.com/${REPO}/releases/latest` })
      );
      bar.append(link);
      document.querySelector("main")?.before(bar);
    } catch (_) {}
  }
  checkForUpdate();

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
      '<label>Having problems?</label><button class="btn secondary" type="button">Open log files</button>';
    field.querySelector("button").addEventListener("click", () =>
      invoke("open_logs").catch(() => {})
    );
    recovery.after(field);
  }
})();

// Numeric semver compare: "0.10.0" > "0.9.1".
function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
