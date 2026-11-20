const API = "http://127.0.0.1:7878/v1";
let currentStatus = null;
let customSources = [];
let setupDriveCustomSources = [];
let sessionPassphrase = null;
let agentOnline = false;
let wizardStep = 0;
let wizardDismissed = false;
let securityTouched = false;
let deviceList = [];
let partitionIndex = new Map();
let selectedPartitionPath = null;
let preflight = {
  restic: false,
  can_list: false,
  can_mount: false,
  can_format: false,
  can_wipe: false,
  platform: "linux",
};

const views = Array.from(document.querySelectorAll(".view"));
const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const statusBanner = document.getElementById("status-banner");
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalField = document.getElementById("modal-field");
const modalPassphrase = document.getElementById("modal-passphrase");
const modalError = document.getElementById("modal-error");
const modalConfirm = document.getElementById("modal-confirm");
const modalCancel = document.getElementById("modal-cancel");
let modalResolve = null;
let modalMode = "passphrase";
let modalOpenerElement = null;
let discontinueDrivePending = null;
let renameDrivePending = null;
let editFoldersPending = null;
let currentView = "dashboard";
const wizardSteps = Array.from(document.querySelectorAll(".wizard-step"));
const wizardProgress = document.getElementById("wizard-progress");
const wizardBack = document.getElementById("wizard-back");
const wizardNext = document.getElementById("wizard-next");
const wizardFinish = document.getElementById("run-first-backup");
const wizardSkip = document.getElementById("wizard-skip");
const topNav = document.getElementById("top-nav");
const browseFolder = document.getElementById("browse-folder");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingMessage = document.getElementById("loading-message");

// While a dialog or the loading overlay is up, the page behind can't be focused or clicked.
function setBackgroundInert(on) {
  document.querySelectorAll("#app > :not(#modal-overlay)").forEach((el) => {
    el.toggleAttribute("inert", on);
  });
}

function showLoadingOverlay(message) {
  if (loadingMessage) loadingMessage.textContent = message || "Working…";
  if (loadingOverlay) loadingOverlay.classList.remove("hidden");
  setBackgroundInert(true);
  document.body.classList.add("setup-loading");
  setSetupButtonsDisabled(true);
}

function hideLoadingOverlay() {
  if (loadingOverlay) loadingOverlay.classList.add("hidden");
  if (modalOverlay.classList.contains("hidden")) setBackgroundInert(false);
  document.body.classList.remove("setup-loading");
  setSetupButtonsDisabled(false);
}

function setSetupButtonsDisabled(disabled) {
  const ids = [
    "setup-drive-setup-btn",
    "setup-drive-mount",
    "setup-drive-erase-option",
    "setup-drive-erase-phrase",
    "setup-drive-passphrase",
    "setup-drive-passphrase-confirm",
    "setup-drive-label",
    "mount-drive",
    "erase-option",
    "erase-phrase",
    "drive-label",
    "wizard-next",
    "wizard-back",
    "run-first-backup",
  ];
  ids.forEach((id) => setDisabled(id, disabled));
}

function showView(id) {
  views.forEach((view) => {
    view.classList.toggle("hidden", view.id !== id);
  });
  navButtons.forEach((btn) => {
    const active = btn.dataset.view === id;
    btn.classList.toggle("active", active);
    if (active) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });
  currentView = id;
  if (id === "setup-drive") {
    fetchDevices();
    fetchPreflight();
  }
}

function setBanner(kind, message) {
  if (!statusBanner) return;
  statusBanner.textContent = message;
  statusBanner.classList.remove("hidden", "warn", "alert");
  if (kind) statusBanner.classList.add(kind);
}

function clearBanner() {
  if (!statusBanner) return;
  statusBanner.classList.add("hidden");
}

function setDisabled(id, disabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = disabled || el.dataset.busy === "1";
}

// Disables a button and shows what's happening until `fn` finishes (no double clicks).
async function withBusy(id, busyText, fn) {
  const button = document.getElementById(id);
  if (!button || button.dataset.busy === "1") return;
  const text = button.textContent;
  button.dataset.busy = "1";
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await fn();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = text;
    if (currentStatus) updateActionState(currentStatus);
  }
}

function updateActionState(status) {
  const resticReady = !!status?.restic_available;
  const driveConnected = !!status?.drive?.connected;
  const trusted = !!status?.drive?.trusted;
  const runningDriveIds = status?.running_drive_ids || [];
  const currentDriveRunning = !!(
    status?.drive?.drive_id &&
    Array.isArray(runningDriveIds) &&
    runningDriveIds.includes(status.drive.drive_id)
  );
  const canOperate = agentOnline && resticReady;

  setDisabled("run-first-backup", !canOperate || !trusted || currentDriveRunning);
  setDisabled("backup-now", !canOperate || !trusted || currentDriveRunning);
  setDisabled("restore-btn", !canOperate || !trusted);
  setDisabled("load-snapshots", !canOperate || !trusted);
  setDisabled("restore-run", !canOperate || !trusted);
  setDisabled("restore-selected-run", !canOperate || !trusted);
  setDisabled("eject-btn", !agentOnline || !driveConnected);
  setDisabled("export-recovery", !agentOnline || !trusted);
  document.getElementById("restore-hint")?.classList.toggle("hidden", !agentOnline || (driveConnected && trusted));
  const setupThisDriveBtn = document.getElementById("setup-this-drive-btn");
  if (setupThisDriveBtn) {
    setupThisDriveBtn.classList.toggle("hidden", !driveConnected || trusted);
  }
  updateDeviceActions();
  updateSetupDriveActions();
}

// The app announces an update it won't install by itself (newer version, not a fix for this
// one); the user installs it with one click. Never shown in a browser without Tauri.
window.__TAURI__?.event?.listen("update-available", (event) => {
  const banner = document.getElementById("update-banner");
  document.getElementById("update-banner-text").textContent =
    `Aegis ${event.payload} is available.`;
  banner.classList.remove("hidden");
});
document.getElementById("update-install")?.addEventListener("click", async () => {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  const button = document.getElementById("update-install");
  button.disabled = true;
  button.textContent = "Installing…";
  try {
    await invoke("install_update"); // restarts Aegis on success
  } catch (err) {
    uiAlert(String(err), "Update not installed");
    button.disabled = false;
    button.textContent = "Install and restart";
  }
});

const BACKUP_STUCK_THRESHOLD_SEC = 30 * 60; // 30 minutes

function renderBanner(status) {
  if (!agentOnline) {
    setBanner("alert", "Can't connect to Aegis right now. Try restarting the app.");
    return;
  }
  if (status && !status.restic_available) {
    setBanner("warn", "Aegis is missing a part it needs. Please reinstall Aegis.");
    return;
  }
  if (status?.running && status?.last_run?.started_epoch) {
    const elapsed = Math.floor(Date.now() / 1000) - status.last_run.started_epoch;
    if (elapsed >= BACKUP_STUCK_THRESHOLD_SEC) {
      setBanner("warn", "Backup has been running for a long time. If nothing seems to be happening, try restarting Aegis.");
      return;
    }
  }
  clearBanner();
}

function openModal({ title, body, mode, drive_id, drive_label, confirmText, danger, focusCancel }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalMode = mode;
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modalError.textContent = "";
    discontinueDrivePending = mode === "discontinue" && drive_id && drive_label ? { drive_id, drive_label } : null;
    renameDrivePending = mode === "rename-drive" && drive_id ? { drive_id, drive_label: drive_label || "" } : null;

    const needsPassphrase = mode === "passphrase";
    const needsDiscontinue = mode === "discontinue";
    const needsRename = mode === "rename-drive";
    if (modalField) modalField.classList.toggle("hidden", !needsPassphrase);
    const discontinueField = document.getElementById("modal-discontinue-field");
    const discontinueInput = document.getElementById("modal-discontinue-input");
    const discontinueWipe = document.getElementById("modal-discontinue-wipe");
    if (discontinueField) discontinueField.classList.toggle("hidden", !needsDiscontinue);
    if (discontinueInput) {
      discontinueInput.value = "";
      discontinueInput.placeholder = drive_label || "";
    }
    if (discontinueWipe) discontinueWipe.checked = false;
    const renameField = document.getElementById("modal-rename-field");
    const renameInput = document.getElementById("modal-rename-input");
    if (renameField) renameField.classList.toggle("hidden", !needsRename);
    if (renameInput) {
      renameInput.value = renameDrivePending?.drive_label ?? "";
    }

    if (mode === "alert") {
      modalConfirm.textContent = "OK";
      modalCancel.classList.add("hidden");
    } else if (mode === "confirm") {
      modalConfirm.textContent = confirmText || "Confirm";
      modalCancel.classList.remove("hidden");
    } else if (mode === "discontinue") {
      modalConfirm.textContent = "Forget";
      modalCancel.classList.remove("hidden");
    } else if (mode === "rename-drive") {
      modalConfirm.textContent = "Save";
      modalCancel.classList.remove("hidden");
    } else {
      modalConfirm.textContent = "Continue";
      modalCancel.classList.remove("hidden");
    }

    // Risky actions use a red button, and Enter/Space start on Cancel.
    modalConfirm.classList.toggle("danger", !!danger || mode === "discontinue");
    modalConfirm.classList.toggle("primary", !danger && mode !== "discontinue");
    modalOpenerElement = document.activeElement;
    setBackgroundInert(true);
    modalOverlay.classList.remove("hidden");
    setTimeout(() => {
      if (needsPassphrase) {
        modalPassphrase.focus();
      } else if (needsDiscontinue && discontinueInput) {
        discontinueInput.focus();
      } else if (needsRename && renameInput) {
        renameInput.focus();
      } else if (focusCancel) {
        modalCancel.focus();
      } else {
        modalConfirm.focus();
      }
    }, 0);
  });
}

// Keeps Tab from leaving the modal while it's open (a basic focus trap).
function trapModalTab(event) {
  if (event.key !== "Tab") return;
  const card = modalOverlay.querySelector(".modal-card");
  if (!card) return;
  const focusable = Array.from(
    card.querySelectorAll('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function uiAlert(message, title = "Notice") {
  return openModal({ title, body: message, mode: "alert" });
}

function uiConfirm(message, title = "Confirm", options = {}) {
  return openModal({ title, body: message, mode: "confirm", ...options });
}

let passphrasePrompt = null;

function requestPassphrase(message) {
  if (!passphrasePrompt) {
    modalPassphrase.value = "";
    // A "Restoring…" overlay would hide the prompt; bring it back once answered.
    const wasLoading = loadingOverlay && !loadingOverlay.classList.contains("hidden");
    if (wasLoading) loadingOverlay.classList.add("hidden");
    passphrasePrompt = openModal({ title: "Passphrase required", body: message, mode: "passphrase" })
      .finally(() => {
        passphrasePrompt = null;
        if (wasLoading) loadingOverlay.classList.remove("hidden");
      });
  }
  return passphrasePrompt;
}

// POSTs to an endpoint that needs the backup passphrase. Tries the passphrase this session
// already proved (or the one saved on this computer) first, and asks only when the agent says
// the passphrase is missing or wrong. A passphrase is kept for the session only after the agent
// accepted it, so a typo never sticks. `verifies: false` for calls that accept any passphrase
// up front (starting a backup checks it later). Returns { res, detail }, or null if cancelled.
async function postWithPassphrase(path, payload, promptMessage, { verifies = true } = {}) {
  const post = (passphrase) =>
    fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, passphrase }),
    });
  let res = await post(sessionPassphrase);
  let detail = res.ok ? "" : await res.text();
  let message = promptMessage;
  while (!res.ok && /passphrase/i.test(detail)) {
    if (/wrong/i.test(detail)) {
      sessionPassphrase = null;
      message = "That passphrase didn't open this backup. Passphrases are case-sensitive. Try again.";
    }
    const passphrase = await requestPassphrase(message);
    if (!passphrase) return null;
    res = await post(passphrase);
    detail = res.ok ? "" : await res.text();
    if (res.ok && verifies && !currentStatus?.config?.paranoid_mode) {
      sessionPassphrase = passphrase;
    }
  }
  return { res, detail: detail.trim() };
}

function closeModal(value) {
  modalOverlay.classList.add("hidden");
  setBackgroundInert(false);
  const opener = modalOpenerElement;
  modalOpenerElement = null;
  if (opener && typeof opener.focus === "function") setTimeout(() => opener.focus(), 0);
  if (modalResolve) {
    const resolver = modalResolve;
    modalResolve = null;
    resolver(value);
  }
}

async function confirmModal() {
  if (modalMode === "passphrase") {
    const value = modalPassphrase.value;
    if (!value.trim()) {
      modalError.textContent = "Enter your passphrase.";
      return;
    }
    modalPassphrase.value = "";
    closeModal(value);
    return;
  }
  if (modalMode === "discontinue") {
    const input = document.getElementById("modal-discontinue-input");
    const value = (input?.value ?? "").trim();
    if (!discontinueDrivePending) {
      closeModal(false);
      return;
    }
    if (value !== discontinueDrivePending.drive_label) {
      modalError.textContent = "That name doesn't match. Type the name exactly as shown.";
      return;
    }
    modalError.textContent = "";
    const wipe = document.getElementById("modal-discontinue-wipe")?.checked ?? false;
    if (wipe) showLoadingOverlay("Wiping drive…");
    try {
      const res = await fetch(`${API}/drives/discontinue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drive_id: discontinueDrivePending.drive_id,
          confirm_label: value,
          wipe,
        }),
      });
      if (res.ok) {
        closeModal(true);
        await fetchStatus();
        showToast("This computer forgot the drive. The backups on it are kept.");
      } else {
        const text = await res.text();
        modalError.textContent = text && text.trim() ? text.trim() : "Couldn't forget the drive. Please try again.";
      }
    } catch (err) {
      modalError.textContent = "Something went wrong. Please try again.";
    } finally {
      if (wipe) hideLoadingOverlay();
    }
    return;
  }
  if (modalMode === "rename-drive") {
    const renameInput = document.getElementById("modal-rename-input");
    const value = (renameInput?.value ?? "").trim();
    if (!renameDrivePending) {
      closeModal(false);
      return;
    }
    if (!value) {
      modalError.textContent = "Enter a name.";
      return;
    }
    modalError.textContent = "";
    try {
      const res = await fetch(`${API}/drives/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drive_id: renameDrivePending.drive_id, label: value }),
      });
      if (res.ok) {
        closeModal(true);
        await fetchStatus();
      } else {
        const text = await res.text();
        modalError.textContent = text && text.trim() ? text.trim() : "Couldn't change the name. Please try again.";
      }
    } catch (err) {
      modalError.textContent = "Something went wrong. Please try again.";
    }
    return;
  }
  closeModal(true);
}

async function fetchStatus() {
  try {
    const res = await fetch(`${API}/status`);
    if (!res.ok) throw new Error("status failed");
    currentStatus = await res.json();
    agentOnline = true;
    renderStatus(currentStatus);
  } catch (err) {
    agentOnline = false;
    renderBanner(null);
    updateActionState(null);
    const summaryText = document.getElementById("dashboard-summary-text");
    if (summaryText) summaryText.textContent = "";
    document.querySelectorAll(".drive-detect-message").forEach((el) => { el.textContent = ""; });
    document.getElementById("last-run-line")?.classList.add("hidden");
    console.error(err);
  }
}

async function fetchDevices() {
  try {
    if (!agentOnline) return;
    const res = await fetch(`${API}/devices`);
    if (!res.ok) throw new Error("devices failed");
    const data = await res.json();
    deviceList = Array.isArray(data.devices) ? data.devices : [];
    renderDevices();
  } catch (err) {
    console.error(err);
  }
}

async function fetchPreflight() {
  try {
    if (!agentOnline) return;
    const res = await fetch(`${API}/preflight`);
    if (!res.ok) throw new Error("preflight failed");
    preflight = await res.json();
    renderPreflight();
    updateDeviceActions();
  } catch (err) {
    console.error(err);
  }
}

function formatLastBackup(epoch) {
  if (epoch == null) return "Never";
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString();
}

function formatGB(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

// A drive can hold several backups (e.g. one per company). The UI acts on one at a time:
// the one picked here, else the agent's default (status.drive.drive_id).
let pickedInstanceId = null;

function applyPickedInstance(status) {
  const ids = status?.drive?.instance_ids || [];
  const trusted = status?.trusted_drives || [];
  if (pickedInstanceId && ids.includes(pickedInstanceId)) {
    status.drive.drive_id = pickedInstanceId;
    const t = trusted.find((d) => d.drive_id === pickedInstanceId);
    if (t) status.drive.label = t.label;
  }
  document.querySelectorAll(".instance-picker-row").forEach((row) => {
    row.classList.toggle("hidden", ids.length < 2);
  });
  document.querySelectorAll(".instance-picker").forEach((sel) => {
    const want = ids.join(",");
    if (sel.dataset.ids !== want) {
      sel.dataset.ids = want;
      sel.replaceChildren(
        ...ids.map((id) => {
          const opt = document.createElement("option");
          opt.value = id;
          opt.textContent = trusted.find((d) => d.drive_id === id)?.label || id.slice(0, 8);
          return opt;
        })
      );
    }
    if (status?.drive?.drive_id) sel.value = status.drive.drive_id;
  });
}

document.addEventListener("change", (e) => {
  if (!e.target.classList?.contains("instance-picker")) return;
  pickedInstanceId = e.target.value;
  // The backup list on Restore belongs to the previous backup: clear it.
  document.getElementById("snapshot-list").innerHTML = "";
  document.getElementById("snapshot-summary").textContent = "";
  browseTreeReset();
  if (currentStatus) renderStatus(currentStatus);
});

function renderStatus(status) {
  applyPickedInstance(status);
  const summaryText = document.getElementById("dashboard-summary-text");
  const summaryVerify = document.getElementById("dashboard-summary-verify");
  const driveDetectEls = document.querySelectorAll(".drive-detect-message");

  const trusted = status.trusted_drives || [];
  const total = trusted.length;
  const connected = trusted.filter((d) => d.is_connected).length;

  if (summaryText) {
    if (status.running) {
      const n = (status.running_drive_ids || []).length;
      const msg = status.last_run?.message;
      if (n > 1) {
        summaryText.textContent = `${n} backups in progress`;
      } else {
        summaryText.textContent = msg ? `Backup in progress: ${msg}` : "Backup in progress…";
      }
    } else if (total === 0) {
      summaryText.textContent = "";
    } else {
      // A drive can hold several backups, so count backups rather than drives.
      const conn = connected === 0 ? "none connected" : `${connected} connected`;
      summaryText.textContent = `${total} backup${total !== 1 ? "s" : ""} set up · ${conn}`;
    }
  }
  if (summaryVerify) summaryVerify.textContent = "";
  renderLastRun(status);

  const progressWrap = document.getElementById("backup-progress-wrap");
  const progressBar = document.getElementById("backup-progress-bar");
  const progressText = document.getElementById("backup-progress-text");
  const progressMap = status.backup_progress && typeof status.backup_progress === "object" ? status.backup_progress : {};
  const prog =
    status.drive?.drive_id && progressMap[status.drive.drive_id]
      ? progressMap[status.drive.drive_id]
      : Object.values(progressMap)[0];
  if (progressWrap && progressBar && progressText) {
    if (status.running && prog) {
      const pct = Math.round((prog.percent_done || 0) * 100);
      progressBar.style.width = `${pct}%`;
      let text = prog.message || `${pct}%`;
      const mbTotal = Math.round((prog.total_bytes || 0) / 1024 / 1024);
      if (mbTotal > 0) {
        const mbDone = Math.round((prog.bytes_done || 0) / 1024 / 1024);
        text += ` · ${mbDone} / ${mbTotal} MB`;
      }
      progressText.textContent = text;
      progressWrap.classList.remove("hidden");
    } else {
      progressBar.style.width = "0%";
      progressText.textContent = "";
      progressWrap.classList.add("hidden");
    }
  }

  const runningDriveIds = status.running_drive_ids || [];
  const currentDriveRunning =
    status.drive?.drive_id && runningDriveIds.includes(status.drive.drive_id);
  let driveDetectText = "Waiting for drive…";
  if (status.running && status.drive?.trusted) {
    driveDetectText = currentDriveRunning
      ? `Backing up to ${status.drive.label || "drive"}…`
      : `${status.drive.label || "Drive"} connected — another drive is backing up`;
  } else if (!status.drive?.connected) {
    driveDetectText = total === 0 ? "" : "Plug in your Aegis drive to back up.";
  } else if (status.drive.trusted) {
    driveDetectText = status.restic_available
      ? `${status.drive.label || "Drive"} connected — ready to back up`
      : `${status.drive.label || "Drive"} connected`;
  } else if (!status.drive.mount_path) {
    driveDetectText = "A USB drive is plugged in.";
  } else {
    driveDetectText = "A USB drive is plugged in that Aegis doesn't use yet.";
  }
  driveDetectEls.forEach((el) => { el.textContent = driveDetectText; });

  const driveSpaceEl = document.getElementById("dashboard-drive-space");
  if (driveSpaceEl) {
    const free = status.drive?.free_bytes;
    const totalBytes = status.drive?.total_bytes;
    if (status.drive?.connected && status.drive?.trusted && typeof free === "number" && typeof totalBytes === "number" && totalBytes > 0) {
      const almostFull = free < totalBytes * 0.1;
      driveSpaceEl.textContent = `${formatGB(free)} GB free of ${formatGB(totalBytes)} GB`;
      driveSpaceEl.classList.toggle("drive-space-warning", almostFull);
      driveSpaceEl.classList.remove("hidden");
    } else {
      driveSpaceEl.textContent = "";
      driveSpaceEl.classList.add("hidden");
      driveSpaceEl.classList.remove("drive-space-warning");
    }
  }

  const ctaHint = document.getElementById("dashboard-cta-hint");
  if (ctaHint) {
    const canBackup =
      status.restic_available &&
      status.drive?.connected &&
      status.drive?.trusted &&
      !(status.running_drive_ids || []).includes(status.drive?.drive_id);
    if (canBackup) {
      const label = status.drive.label || "drive";
      ctaHint.textContent = `Ready — click Back up now to back up to ${label}.`;
      ctaHint.classList.remove("hidden");
    } else {
      ctaHint.textContent = "";
      ctaHint.classList.add("hidden");
    }
  }

  syncConfigUI(status);

  // The welcome wizard is for the very first start only, not after forgetting the last drive.
  if (!status.first_run) wizardDismissed = true;
  if (status.first_run && !wizardDismissed) {
    showView("wizard");
    renderWizard();
  } else if (currentView === "wizard") {
    showView("dashboard");
  }
  updateWizardSummary(status);
  renderBanner(status);
  updateActionState(status);
  applyFirstRunMode(status);
  renderBackupTargets(status.trusted_drives || [], status);
}

function formatWhen(epoch) {
  const day = formatLastBackup(epoch);
  const time = new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return day === "Today" || day === "Yesterday" ? `${day.toLowerCase()} at ${time}` : day;
}

// "Last backup finished today at 14:02. Everything was saved." The agent's message already says
// what happened and what to do next; the line is colored by how it went.
function renderLastRun(status) {
  const el = document.getElementById("last-run-line");
  if (!el) return;
  const run = status.last_run;
  if (status.running || !run?.finished_epoch) {
    el.classList.add("hidden");
    return;
  }
  const when = formatWhen(run.finished_epoch);
  let text =
    run.status === "Failed"
      ? `Last backup (${when}) didn't finish. ${run.message}`
      : `Last backup finished ${when}. ${run.message}`;
  if (run.drive_almost_full) {
    text += " The drive is almost full: turn on cleanup of old backups in Advanced, or use a bigger drive.";
  }
  el.textContent = text;
  el.classList.remove("hidden", "warn", "alert");
  if (run.status === "Failed") el.classList.add("alert");
  else if (run.status === "Partial" || run.drive_almost_full) el.classList.add("warn");
}

function renderBackupTargets(trustedDrives, status) {
  const list = document.getElementById("backup-targets-list");
  const empty = document.getElementById("backup-targets-empty");
  if (!list || !empty) return;
  // Rebuild only when something shown changed, so keyboard focus isn't lost every refresh.
  const key = JSON.stringify([trustedDrives, status?.running_drive_ids, status?.backup_progress]);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  const runningDriveIds = new Set((status && status.running_drive_ids) || []);
  const progressMap = (status && status.backup_progress && typeof status.backup_progress === "object") ? status.backup_progress : {};
  const expandedIds = new Set(
    Array.from(list.querySelectorAll(".backup-target-row.expanded"))
      .map((row) => row.dataset.driveId)
      .filter(Boolean)
  );
  list.innerHTML = "";
  const noDrives = !Array.isArray(trustedDrives) || trustedDrives.length === 0;
  // Nothing to back up to yet: hide drive actions instead of showing them disabled.
  document.getElementById("backup-now")?.closest(".actions")?.classList.toggle("no-drives", noDrives);
  if (noDrives) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  trustedDrives.forEach((d) => {
    const row = document.createElement("div");
    row.className = "backup-target-row";
    row.dataset.driveId = d.drive_id;
    row.dataset.driveLabel = d.label || "";
    if (expandedIds.has(d.drive_id)) {
      row.classList.add("expanded");
    }

    const header = document.createElement("button");
    header.type = "button";
    header.className = "backup-target-header";
    header.setAttribute("aria-expanded", String(expandedIds.has(d.drive_id)));
    const top = document.createElement("div");
    top.className = "backup-target-top";
    const name = document.createElement("div");
    name.className = "backup-target-name";
    name.textContent = d.label || d.drive_id;
    const statusBadge = document.createElement("span");
    const isDrivingBackingUp = runningDriveIds.has(d.drive_id);
    if (isDrivingBackingUp) {
      statusBadge.className = "backup-target-badge backing-up";
      statusBadge.textContent = "Backing up";
    } else {
      statusBadge.className = d.is_connected ? "backup-target-badge connected" : "backup-target-badge";
      statusBadge.textContent = d.is_connected ? "Connected" : "Not connected";
    }
    top.appendChild(name);
    top.appendChild(statusBadge);
    header.appendChild(top);
    const summary = document.createElement("div");
    summary.className = "backup-target-sources";
    const labels = Array.isArray(d.backup_source_labels) ? d.backup_source_labels : [];
    const lastBackupStr = formatLastBackup(d.last_backup_epoch);
    const prog = progressMap[d.drive_id];
    if (isDrivingBackingUp && prog) {
      const pct = Math.round((prog.percent_done || 0) * 100);
      summary.textContent = labels.length > 0
        ? `${labels.join(", ")} · Backing up: ${pct}%`
        : `Backing up: ${pct}%`;
    } else {
      summary.textContent = labels.length > 0 ? `${labels.join(", ")} · Last backup: ${lastBackupStr}` : `Last backup: ${lastBackupStr}`;
    }
    header.appendChild(summary);
    row.appendChild(header);

    const expanded = document.createElement("div");
    expanded.className = expandedIds.has(d.drive_id) ? "backup-target-expanded" : "backup-target-expanded hidden";
    const sourcesList = document.createElement("div");
    sourcesList.className = "backup-target-sources-list";
    const sources = Array.isArray(d.backup_sources) ? d.backup_sources : [];
    if (sources.length > 0) {
      sources.forEach((src) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "backup-source-link";
        item.textContent = `${src.label} — ${src.path}`;
        item.title = src.path;
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          openFolderPath(src.path);
        });
        sourcesList.appendChild(item);
      });
    } else {
      const fallback = document.createElement("span");
      fallback.className = "muted";
      fallback.textContent = labels.length > 0 ? labels.join(", ") : "—";
      sourcesList.appendChild(fallback);
    }
    expanded.appendChild(sourcesList);
    const driveActions = document.createElement("div");
    driveActions.className = "backup-target-actions";
    const canEdit = d.is_connected && !isDrivingBackingUp;
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "btn ghost";
    renameBtn.textContent = "Rename";
    renameBtn.disabled = !canEdit;
    renameBtn.title = !d.is_connected ? "Connect this drive to change its name" : isDrivingBackingUp ? "Backup in progress" : "";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      openModal({
        title: "Rename",
        body: "Change the name Aegis shows for this backup. The drive itself isn't renamed.",
        mode: "rename-drive",
        drive_id: d.drive_id,
        drive_label: d.label || "",
      });
    });
    const editFoldersBtn = document.createElement("button");
    editFoldersBtn.type = "button";
    editFoldersBtn.className = "btn ghost";
    editFoldersBtn.textContent = "Edit folders";
    editFoldersBtn.disabled = !canEdit;
    editFoldersBtn.title = !d.is_connected ? "Connect this drive to change folders" : isDrivingBackingUp ? "Backup in progress" : "";
    editFoldersBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      openEditFoldersModal(d);
    });
    const sheetBtn = document.createElement("button");
    sheetBtn.type = "button";
    sheetBtn.className = "btn ghost";
    sheetBtn.textContent = "Print passphrase sheet";
    sheetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPassphraseSheet(d.drive_id);
    });
    driveActions.appendChild(renameBtn);
    driveActions.appendChild(editFoldersBtn);
    driveActions.appendChild(sheetBtn);
    expanded.appendChild(driveActions);
    const discontinueBtn = document.createElement("button");
    discontinueBtn.type = "button";
    discontinueBtn.className = "btn ghost backup-target-discontinue";
    discontinueBtn.textContent = "Forget on this computer";
    discontinueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal({
        title: "Forget this drive on this computer",
        body:
          "This computer stops backing up to this drive and forgets its saved passphrase. " +
          "The backups on the drive are kept, and other computers can keep using it.\n\n" +
          "Handing the drive over to someone else? Also delete any copies of the backed-up files " +
          "that should not stay on this computer.\n\nType its name to confirm:",
        mode: "discontinue",
        drive_id: d.drive_id,
        drive_label: d.label || "",
      });
    });
    expanded.appendChild(discontinueBtn);
    row.appendChild(expanded);

    header.addEventListener("click", () => {
      expanded.classList.toggle("hidden");
      const open = !expanded.classList.contains("hidden");
      row.classList.toggle("expanded", open);
      header.setAttribute("aria-expanded", String(open));
    });
    list.appendChild(row);
  });
}

const DEFAULT_SOURCES = [
  { label: "Documents", path: "~/Documents" },
  { label: "Pictures", path: "~/Pictures" },
  { label: "Desktop", path: "~/Desktop" },
];

function pathMatches(pathA, pathB) {
  const n = (s) => (s || "").replace(/\/$/, "");
  const a = n(pathA);
  const b = n(pathB);
  if (a === b) return true;
  const lastB = b.split("/").filter(Boolean).pop() || b;
  return a === lastB || a.endsWith("/" + lastB);
}

function openEditFoldersModal(d) {
  editFoldersPending = {
    drive_id: d.drive_id,
    drive_label: d.label || "",
    backup_sources: Array.isArray(d.backup_sources) ? d.backup_sources : [],
  };
  const docs = document.getElementById("edit-folders-docs");
  const pics = document.getElementById("edit-folders-pics");
  const desktop = document.getElementById("edit-folders-desktop");
  if (docs) docs.checked = editFoldersPending.backup_sources.some((s) => pathMatches(s.path, "~/Documents"));
  if (pics) pics.checked = editFoldersPending.backup_sources.some((s) => pathMatches(s.path, "~/Pictures"));
  if (desktop) desktop.checked = editFoldersPending.backup_sources.some((s) => pathMatches(s.path, "~/Desktop"));
  editFoldersCustomSources = editFoldersPending.backup_sources.filter(
    (s) =>
      !pathMatches(s.path, "~/Documents") &&
      !pathMatches(s.path, "~/Pictures") &&
      !pathMatches(s.path, "~/Desktop")
  );
  renderEditFoldersCustomList();
  const title = document.getElementById("edit-folders-title");
  if (title) title.textContent = `Edit folders — ${editFoldersPending.drive_label || "Drive"}`;
  document.getElementById("edit-folders-error").textContent = "";
  editFoldersOpenerElement = document.activeElement;
  document.getElementById("edit-folders-overlay").classList.remove("hidden");
  setTimeout(() => docs?.focus(), 0);
}

let editFoldersOpenerElement = null;

function closeEditFoldersModal() {
  document.getElementById("edit-folders-overlay").classList.add("hidden");
  editFoldersPending = null;
  if (editFoldersOpenerElement && typeof editFoldersOpenerElement.focus === "function") {
    editFoldersOpenerElement.focus();
  }
  editFoldersOpenerElement = null;
}

let editFoldersCustomSources = [];

function renderEditFoldersCustomList() {
  const list = document.getElementById("edit-folders-custom-list");
  if (!list) return;
  list.innerHTML = "";
  if (editFoldersCustomSources.length === 0) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "None yet. Click Add folder to choose one.";
    list.appendChild(hint);
  }
  editFoldersCustomSources.forEach((item, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const text = document.createElement("span");
    text.className = "chip-text";
    text.textContent = `${item.label} · ${item.path}`;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${item.label}`);
    removeBtn.addEventListener("click", () => {
      editFoldersCustomSources.splice(index, 1);
      renderEditFoldersCustomList();
    });
    chip.appendChild(text);
    chip.appendChild(removeBtn);
    list.appendChild(chip);
  });
}

async function saveEditFolders() {
  if (!editFoldersPending) return;
  const docs = document.getElementById("edit-folders-docs");
  const pics = document.getElementById("edit-folders-pics");
  const desktop = document.getElementById("edit-folders-desktop");
  const backup_sources = [];
  if (docs?.checked) backup_sources.push(DEFAULT_SOURCES[0]);
  if (pics?.checked) backup_sources.push(DEFAULT_SOURCES[1]);
  if (desktop?.checked) backup_sources.push(DEFAULT_SOURCES[2]);
  backup_sources.push(...editFoldersCustomSources);
  const errEl = document.getElementById("edit-folders-error");
  try {
    const res = await fetch(`${API}/drives/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drive_id: editFoldersPending.drive_id,
        backup_sources,
      }),
    });
    if (res.ok) {
      closeEditFoldersModal();
      await fetchStatus();
    } else {
      const text = await res.text();
      errEl.textContent = text && text.trim() ? text.trim() : "Couldn't update folders. Please try again.";
    }
  } catch (err) {
    errEl.textContent = "Something went wrong. Please try again.";
  }
}

// Native folder picker (desktop app). Returns the chosen path, or null.
async function pickFolder() {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (typeof invoke !== "function") {
    uiAlert("Type the folder location in the box instead.");
    return null;
  }
  try {
    const path = await invoke("select_folder");
    return typeof path === "string" && path ? path : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

function folderName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || "Folder";
}

// "Add" next to a custom folder: the name defaults to the folder's own name.
function addCustomFolder(list, labelId, pathId, render) {
  const labelEl = document.getElementById(labelId);
  const pathEl = document.getElementById(pathId);
  const path = pathEl.value.trim();
  if (!path) {
    uiAlert("Choose a folder first.");
    return;
  }
  list.push({ label: labelEl.value.trim() || folderName(path), path });
  labelEl.value = "";
  pathEl.value = "";
  render();
}

function openFolderPath(path) {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (typeof invoke !== "function") {
    return;
  }
  invoke("open_path", { path }).catch((err) => {
    console.error(err);
    uiAlert(typeof err === "string" ? err : "Could not open path.", "Open folder");
  });
}

function renderDeviceListInto(listEl, emptyEl, helpEl, updatedEl, radioName) {
  if (!listEl) return false;
  const empty = emptyEl || document.getElementById("setup-drive-device-empty");
  const help = helpEl || document.getElementById("setup-drive-help");
  const updated = updatedEl || document.getElementById("setup-drive-updated");
  listEl.innerHTML = "";

  if (!deviceList.length) {
    if (empty) empty.classList.remove("hidden");
    if (help) help.textContent = "Plug in a USB drive.";
    return false;
  }
  if (empty) empty.classList.add("hidden");
  if (help) help.textContent = "Choose the drive to back up to.";

  let hasSelection = false;
  deviceList.forEach((device) => {
    const deviceTitle = `${device.model || "USB drive"} (${device.size})`;
    const deviceMeta = device.removable ? "" : "This computer's own drive";
    const card = document.createElement("div");
    card.className = "device-card";
    const header = document.createElement("div");
    header.className = "device-card-header";
    const title = document.createElement("div");
    title.className = "device-card-title";
    title.textContent = deviceTitle;
    const meta = document.createElement("div");
    meta.className = "device-card-meta";
    meta.textContent = deviceMeta;
    header.appendChild(title);
    header.appendChild(meta);
    card.appendChild(header);

    const partsToShow = (device.partitions && device.partitions.length > 0)
      ? device.partitions
      : [{
          path: device.path,
          name: device.name,
          size: device.size,
          fstype: null,
          mountpoints: [],
          _wholeDisk: true,
        }];

    const severalParts = partsToShow.length > 1;
    partsToShow.forEach((part, partIndex) => {
      const mountpoint = part.mountpoints?.[0] || "";
      const subtitle = severalParts ? part.size : "";
      const isWholeDisk = !!part._wholeDisk;
      const row = document.createElement("label");
      row.className = "partition-row";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = radioName;
      input.value = part.path;
      if (!device.removable) {
        input.disabled = true;
        row.classList.add("disabled");
      } else {
        if (!selectedPartitionPath) {
          selectedPartitionPath = part.path;
        }
        input.checked = selectedPartitionPath === part.path;
        if (input.checked) hasSelection = true;
      }
      input.addEventListener("change", () => {
        if (!input.disabled) {
          selectedPartitionPath = part.path;
          console.info("[devices] selected", part.path);
          updateDeviceActions();
          updateSetupDriveActions();
        }
      });
      const details = document.createElement("div");
      details.className = "partition-details";
      const titleEl = document.createElement("div");
      titleEl.className = "partition-title";
      titleEl.textContent = !device.removable
        ? "Can't be used for backups"
        : severalParts
        ? `Part ${partIndex + 1} of this drive`
        : "Whole drive";
      const sub = document.createElement("div");
      sub.className = "partition-subtitle";
      sub.textContent = subtitle;
      details.appendChild(titleEl);
      details.appendChild(sub);
      const status = document.createElement("div");
      status.className = "partition-status";
      if (!device.removable) {
        status.textContent = "";
      } else if (isWholeDisk || !part.fstype) {
        status.textContent = "Needs erasing before Aegis can use it";
        status.classList.add("warn");
      } else {
        status.textContent = mountpoint ? "Ready to use" : "Not opened yet";
      }
      row.appendChild(input);
      row.appendChild(details);
      row.appendChild(status);
      card.appendChild(row);
      if (device.removable) {
        partitionIndex.set(part.path, {
          device,
          partition: part,
          mountpoint,
        });
      }
    });
    listEl.appendChild(card);
  });

  if (!hasSelection && partitionIndex.size > 0) {
    const first = partitionIndex.keys().next().value;
    selectedPartitionPath = first;
  }
  if (selectedPartitionPath && !partitionIndex.has(selectedPartitionPath)) {
    selectedPartitionPath = partitionIndex.keys().next().value || null;
  }
  return true;
}

let renderedDevicesKey = null;

function renderDevices() {
  const list = document.getElementById("device-list");
  const empty = document.getElementById("device-empty");
  const help = document.getElementById("device-help");
  const updated = document.getElementById("device-updated");
  if (!list || !empty) return;
  const key = JSON.stringify(deviceList);
  if (key === renderedDevicesKey) return;
  renderedDevicesKey = key;
  partitionIndex = new Map();
  renderDeviceListInto(list, empty, help, updated, "device-partition");
  const setupList = document.getElementById("setup-drive-device-list");
  if (setupList) {
    renderDeviceListInto(
      setupList,
      document.getElementById("setup-drive-device-empty"),
      document.getElementById("setup-drive-help"),
      document.getElementById("setup-drive-updated"),
      "setup-drive-partition"
    );
  }
  updateDeviceActions();
  updateSetupDriveActions();
}

// Shows only what's missing, with what to do about it.
function renderPreflight() {
  const problems = {
    restic: preflight.restic ? "" : "Aegis is missing a part it needs. Please reinstall Aegis.",
    udisks: preflight.can_mount
      ? ""
      : "Aegis can't open drives by itself on this computer. Open the drive in your file manager first, then come back.",
    exfat: preflight.can_format
      ? ""
      : "Aegis can't erase drives on this computer. You can still use a drive that already works in your file manager.",
  };
  Object.entries(problems).forEach(([key, text]) => {
    [`preflight-${key}`, `setup-drive-preflight-${key}`].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = `preflight-item warn${text ? "" : " hidden"}`;
    });
  });
  const wipeOptions = document.querySelectorAll(".wipe-option");
  wipeOptions.forEach((el) => el.classList.toggle("hidden", !preflight.can_wipe));
}

function updateSetupDriveActions() {
  const mountButton = document.getElementById("setup-drive-mount");
  const setupButton = document.getElementById("setup-drive-setup-btn");
  const eraseOption = document.getElementById("setup-drive-erase-option");
  const erasePhrase = document.getElementById("setup-drive-erase-phrase");
  const status = document.getElementById("setup-drive-status");
  const selection = getSelectedPartition();
  const hasSelection = !!selection;
  const mounted = !!selection?.mountpoint;
  const hasFilesystem = !!selection?.partition?.fstype;
  const canMount = agentOnline && preflight.can_mount;
  const canFormat = agentOnline && preflight.can_format;
  const canSetup = agentOnline && preflight.restic;
  const wantsErase = !!eraseOption?.checked;

  if (mountButton) {
    mountButton.disabled = !hasSelection || !hasFilesystem;
  }
  if (setupButton) {
    setupButton.disabled = !hasSelection;
  }

  if (status) {
    let message = "";
    if (!agentOnline) message = "Not connected to Aegis.";
    else if (!hasSelection) message = "Choose a drive to continue.";
    else if (wantsErase && !canFormat) message = "Aegis can't erase drives on this computer.";
    else if (!mounted && !canMount) message = "Aegis can't open drives on this computer.";
    else if (!canSetup) message = "Aegis is missing a part it needs. Please reinstall Aegis.";
    else if (!mounted && !wantsErase) message = "Click Open drive, or tick \"Erase this drive\".";
    else if (wantsErase && (erasePhrase?.value || "").trim() !== "ERASE") {
      message = 'Type ERASE in the box to confirm erasing.';
    } else message = "Ready to set up this drive.";
    status.textContent = message;
  }
}

function getSelectedPartition() {
  if (!selectedPartitionPath) return null;
  return partitionIndex.get(selectedPartitionPath) || null;
}

function updateDeviceActions() {
  const mountButton = document.getElementById("mount-drive");
  const setupButton = document.getElementById("setup-drive");
  const eraseOption = document.getElementById("erase-option");
  const erasePhrase = document.getElementById("erase-phrase");
  const status = document.getElementById("device-status");
  const selection = getSelectedPartition();
  const hasSelection = !!selection;
  const mounted = !!selection?.mountpoint;
  const hasFilesystem = !!selection?.partition?.fstype;
  const canMount = agentOnline && preflight.can_mount;
  const canFormat = agentOnline && preflight.can_format;
  const canSetup = agentOnline && preflight.restic;
  const wantsErase = !!eraseOption?.checked;

  if (mountButton) {
    mountButton.disabled = !hasSelection || !hasFilesystem;
    mountButton.title = !hasSelection
      ? "Choose a drive to open."
      : !hasFilesystem
      ? "Tick \"Erase this drive\" first."
      : mounted
      ? "Already open."
      : !canMount
      ? "Aegis can't open drives on this computer."
      : "Open the selected drive.";
  }
  if (setupButton) {
    setupButton.disabled = !hasSelection;
    setupButton.title = !hasSelection
      ? "Choose a drive to continue."
      : !canSetup
      ? "Aegis is missing a part it needs. Please reinstall Aegis."
      : !hasFilesystem && !wantsErase
      ? "Tick \"Erase this drive\" first."
      : !mounted && !canMount
      ? "Aegis can't open drives on this computer."
      : wantsErase && !canFormat
      ? "Aegis can't erase drives on this computer."
      : "Set up this drive.";
  }

  if (status) {
    let message = "";
    if (!agentOnline) {
      message = "Not connected to Aegis.";
    } else if (!hasSelection) {
      message = "Choose a drive to continue.";
    } else if (wantsErase && !canFormat) {
      message = "Aegis can't erase drives on this computer.";
    } else if (!mounted && !canMount) {
      message = "Aegis can't open drives on this computer.";
    } else if (!canSetup) {
      message = "Aegis is missing a part it needs. Please reinstall Aegis.";
    } else if (!mounted && !wantsErase) {
      message = "Click Open drive, or tick \"Erase this drive\".";
    } else if (wantsErase && (erasePhrase?.value || "").trim() !== "ERASE") {
      message = 'Type ERASE in the box to confirm erasing.';
    } else {
      message = "Ready to set up this drive.";
    }
    status.textContent = message;
  }
}

function applyFirstRunMode(status) {
  const inWizard = status?.first_run && !wizardDismissed;
  if (topNav) topNav.classList.toggle("hidden", inWizard);
}

// Settings forms are filled from the saved config once, and again after each save, never
// on the regular status refresh (that would throw away what the user is typing).
let configFormsFilled = false;

function syncConfigUI(status) {
  if (!status?.config || configFormsFilled) return;
  configFormsFilled = true;
  const config = status.config;
  const excludeField = document.getElementById("exclude-patterns");
  const includeField = document.getElementById("include-patterns");
  if (excludeField && Array.isArray(config.exclude_patterns)) {
    excludeField.value = config.exclude_patterns.join(", ");
  }
  if (includeField && Array.isArray(config.include_patterns)) {
    includeField.value = config.include_patterns.join(", ");
  }
  const quickVerify = document.getElementById("quick-verify");
  const autoBackup = document.getElementById("auto-backup");
  const deepVerify = document.getElementById("deep-verify");
  const remember = document.getElementById("remember-passphrase");
  const paranoid = document.getElementById("paranoid-mode");
  const reminderDays = document.getElementById("reminder-days");
  const backupIntervalHours = document.getElementById("backup-interval-hours");
  if (quickVerify) quickVerify.checked = !!config.quick_verify;
  if (autoBackup) autoBackup.checked = !!config.auto_backup_on_insert;
  if (deepVerify) deepVerify.checked = !!config.deep_verify;
  if (remember) remember.checked = !!config.remember_passphrase;
  if (paranoid) paranoid.checked = !!config.paranoid_mode;
  if (reminderDays) reminderDays.value = config.reminder_days ?? 7;
  if (backupIntervalHours) backupIntervalHours.value = config.backup_interval_hours ?? 0;
  const settingsRemember = document.getElementById("settings-remember");
  const settingsAsk = document.getElementById("settings-ask");
  if (settingsRemember) settingsRemember.checked = !!config.remember_passphrase;
  if (settingsAsk) settingsAsk.checked = !config.remember_passphrase;
  const retention = config.retention || {};
  const retentionEnabled = document.getElementById("retention-enabled");
  if (retentionEnabled) retentionEnabled.checked = !!retention.enabled;
  ["keep_last", "keep_daily", "keep_weekly", "keep_monthly", "keep_yearly"].forEach((key) => {
    const input = document.getElementById(key.replace("_", "-"));
    if (input) input.value = retention[key] ?? 0;
  });
  if (status.first_run && remember && paranoid && !remember.checked && !paranoid.checked) {
    remember.checked = true;
  }
}

function renderWizard() {
  wizardSteps.forEach((step, index) => {
    step.classList.toggle("hidden", index !== wizardStep);
  });
  if (wizardProgress) {
    wizardProgress.textContent = `Step ${wizardStep + 1} of ${wizardSteps.length}`;
  }
  if (wizardBack) wizardBack.disabled = wizardStep === 0;
  if (wizardNext) {
    wizardNext.classList.toggle("hidden", wizardStep === wizardSteps.length - 1);
    wizardNext.textContent = wizardStep === 2 ? "Set up this drive" : "Next";
  }
  if (wizardFinish) wizardFinish.classList.toggle("hidden", wizardStep !== wizardSteps.length - 1);

  if (wizardStep === wizardSteps.length - 1) {
    updateWizardSummary(currentStatus || { drive: { connected: false }, restic_available: false });
  }

  if (wizardStep === 1 && currentStatus?.first_run && !securityTouched) {
    const remember = document.getElementById("remember-passphrase");
    const paranoid = document.getElementById("paranoid-mode");
    if (remember && paranoid) {
      remember.checked = true;
      paranoid.checked = false;
    }
  }
}

const MIN_PASSPHRASE_LENGTH = 8;
const COMMON_PASSPHRASE_WORDS = [
  "password",
  "123456",
  "qwerty",
  "letmein",
  "welcome",
  "admin",
  "iloveyou",
  "dragon",
  "monkey",
  "football",
  "abc123",
];

// Simple heuristic: length + character variety, with a penalty for common words.
// No library, just plain rules so the label stays easy to explain ("too short",
// "easy to guess", "weak", "okay", "strong").
function passphraseStrength(value) {
  if (!value) return { score: 0, label: "" };
  const lower = value.toLowerCase();
  const tooShort = value.length < MIN_PASSPHRASE_LENGTH;
  const hasCommonWord = COMMON_PASSPHRASE_WORDS.some((word) => lower.includes(word));

  let variety = 0;
  if (/[a-z]/.test(value)) variety++;
  if (/[A-Z]/.test(value)) variety++;
  if (/[0-9]/.test(value)) variety++;
  if (/[^a-zA-Z0-9]/.test(value)) variety++;
  const wordCount = value.split(/[\s-_]+/).filter(Boolean).length;

  if (tooShort) {
    return { score: 1, label: "Too short" };
  }
  if (hasCommonWord) {
    return { score: 1, label: "Easy to guess" };
  }
  const long = value.length >= 20 || wordCount >= 4;
  const decent = value.length >= 12 || variety >= 3;
  if (long && (variety >= 2 || wordCount >= 4)) {
    return { score: 3, label: "Strong" };
  }
  if (decent) {
    return { score: 2, label: "Okay" };
  }
  return { score: 1, label: "Weak" };
}

function updatePassphraseMeter(inputId, barId, labelId) {
  const input = document.getElementById(inputId);
  const bar = document.getElementById(barId);
  const label = document.getElementById(labelId);
  if (!input || !bar || !label) return;
  const { score, label: text } = passphraseStrength(input.value);
  const pct = [0, 33, 66, 100][score] ?? 0;
  bar.style.width = `${pct}%`;
  label.textContent = input.value ? text : "";
  label.classList.remove("weak", "okay", "strong");
  bar.classList.remove("weak", "okay", "strong");
  if (score <= 1 && input.value) {
    label.classList.add("weak");
    bar.classList.add("weak");
  }
  if (score === 2) {
    label.classList.add("okay");
    bar.classList.add("okay");
  }
  if (score === 3) {
    label.classList.add("strong");
    bar.classList.add("strong");
  }
}

function wirePassphraseMeter(inputId, barId, labelId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener("input", () => updatePassphraseMeter(inputId, barId, labelId));
}

function wirePassphraseToggles() {
  document.querySelectorAll(".password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.toggleFor;
      const input = document.getElementById(targetId);
      if (!input) return;
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-label", showing ? "Show passphrase" : "Hide passphrase");
    });
  });
}

// Shared check used before creating a new passphrase (wizard step 2 and the
// Add-drive form). Returns an error message, or null when the passphrase is OK.
function clearPassphraseFields(...ids) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

function checkNewPassphrase(passphrase, confirm) {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Your passphrase needs to be at least ${MIN_PASSPHRASE_LENGTH} characters. Try 4+ random words, like "maple-orbit-candle-river".`;
  }
  if (passphrase !== confirm) {
    return "Passphrases do not match.";
  }
  return null;
}

function validateWizardStep(step) {
  if (step === 1) {
    const passphrase = document.getElementById("passphrase").value;
    const confirm = document.getElementById("passphrase-confirm").value;
    const error = checkNewPassphrase(passphrase, confirm);
    if (error) {
      uiAlert(error);
      return false;
    }
  }
  return true;
}

function goWizardNext() {
  if (!validateWizardStep(wizardStep)) return;
  if (wizardStep === 2) {
    setupDriveFromSelection().then((ok) => {
      if (!ok) return;
      wizardStep = Math.min(wizardStep + 1, wizardSteps.length - 1);
      renderWizard();
    });
    return;
  }
  wizardStep = Math.min(wizardStep + 1, wizardSteps.length - 1);
  renderWizard();
}

function goWizardBack() {
  wizardStep = Math.max(wizardStep - 1, 0);
  renderWizard();
}

function updateWizardSummary(status) {
  const summary = document.getElementById("wizard-summary");
  if (!summary) return;
  summary.innerHTML = "";
  const sources = buildBackupSources();
  const remember = !!document.getElementById("remember-passphrase")?.checked;
  const auto = !!status.config?.auto_backup_on_insert && remember;
  const summaryItems = [
    `Aegis backs up: ${sources.map((s) => s.label).join(", ") || "nothing yet (add folders under Your drives)"}.`,
    auto
      ? "Backups start by themselves whenever you plug in this drive."
      : "Plug in the drive and click Back up now to make a backup.",
    remember
      ? "Your passphrase is remembered on this computer."
      : "Aegis asks for your passphrase every time.",
    "To get files back, use Restore. Without Aegis, use the AEGIS-RESTORE folder on the drive.",
  ];
  summaryItems.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    summary.appendChild(li);
  });
}

function buildBackupSources() {
  const sources = [];
  if (document.getElementById("src-docs")?.checked) {
    sources.push({ label: "Documents", path: "~/Documents" });
  }
  if (document.getElementById("src-pics")?.checked) {
    sources.push({ label: "Pictures", path: "~/Pictures" });
  }
  if (document.getElementById("src-desktop")?.checked) {
    sources.push({ label: "Desktop", path: "~/Desktop" });
  }
  customSources.forEach((item) => sources.push(item));
  return sources;
}

function buildSetupDriveBackupSources() {
  const sources = [];
  if (document.getElementById("setup-drive-src-docs")?.checked) {
    sources.push({ label: "Documents", path: "~/Documents" });
  }
  if (document.getElementById("setup-drive-src-pics")?.checked) {
    sources.push({ label: "Pictures", path: "~/Pictures" });
  }
  if (document.getElementById("setup-drive-src-desktop")?.checked) {
    sources.push({ label: "Desktop", path: "~/Desktop" });
  }
  setupDriveCustomSources.forEach((item) => sources.push(item));
  return sources;
}

function renderSetupDriveCustomSources() {
  const list = document.getElementById("setup-drive-custom-list");
  if (!list) return;
  list.innerHTML = "";
  setupDriveCustomSources.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "chip";
    const span = document.createElement("span");
    span.className = "chip-text";
    span.textContent = `${item.label} · ${item.path}`;
    span.title = item.path;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.setAttribute("aria-label", `Remove ${item.label}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setupDriveCustomSources.splice(index, 1);
      renderSetupDriveCustomSources();
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
}

function renderCustomSources() {
  const list = document.getElementById("custom-list");
  if (!list) return;
  list.innerHTML = "";
  customSources.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "chip";
    const span = document.createElement("span");
    span.className = "chip-text";
    span.textContent = `${item.label} · ${item.path}`;
    span.title = item.path;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.setAttribute("aria-label", `Remove ${item.label}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      customSources.splice(index, 1);
      renderCustomSources();
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
}

function splitList(id) {
  return (document.getElementById(id)?.value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Blank or invalid number field: leave the saved value as it is.
function numberField(id) {
  const raw = document.getElementById(id)?.value ?? "";
  const n = parseInt(raw, 10);
  return raw.trim() === "" || Number.isNaN(n) || n < 0 ? undefined : n;
}

function settingsPayload() {
  const remember = !!document.getElementById("settings-remember")?.checked;
  return {
    exclude_patterns: splitList("exclude-patterns"),
    quick_verify: document.getElementById("quick-verify").checked,
    auto_backup_on_insert: document.getElementById("auto-backup").checked,
    remember_passphrase: remember,
    paranoid_mode: !remember,
    reminder_days: numberField("reminder-days"),
    backup_interval_hours: numberField("backup-interval-hours"),
  };
}

function advancedPayload() {
  const saved = currentStatus?.config?.retention || {};
  const keep = (id, key) => numberField(id) ?? saved[key] ?? 0;
  return {
    include_patterns: splitList("include-patterns"),
    deep_verify: document.getElementById("deep-verify").checked,
    retention: {
      enabled: document.getElementById("retention-enabled").checked,
      keep_last: keep("keep-last", "keep_last"),
      keep_daily: keep("keep-daily", "keep_daily"),
      keep_weekly: keep("keep-weekly", "keep_weekly"),
      keep_monthly: keep("keep-monthly", "keep_monthly"),
      keep_yearly: keep("keep-yearly", "keep_yearly"),
      min_snapshots: saved.min_snapshots ?? 3,
    },
  };
}

// First-run wizard: folders and passphrase choice.
function wizardPayload() {
  return {
    backup_sources: buildBackupSources(),
    remember_passphrase: document.getElementById("remember-passphrase").checked,
    paranoid_mode: document.getElementById("paranoid-mode").checked,
  };
}

// Saves only the given settings; the agent keeps everything else. Returns true on success.
async function saveConfig(payload, savedNoteId) {
  try {
    const res = await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      uiAlert((await res.text()).trim() || "Couldn't save settings. Please try again.");
      return false;
    }
    currentStatus = await res.json();
    if (currentStatus.config?.paranoid_mode) sessionPassphrase = null;
    configFormsFilled = false;
    renderStatus(currentStatus);
    const note = savedNoteId && document.getElementById(savedNoteId);
    if (note) {
      note.textContent = "Saved.";
      setTimeout(() => { note.textContent = ""; }, 4000);
    }
    return true;
  } catch (_) {
    uiAlert("Can't connect to Aegis right now. Try restarting the app.");
    return false;
  }
}

// After "Add drive" opened a backup that other computers already use (e.g. a handover):
// show their folders so the user can pick the matching ones on this computer.
function showHandoverInfo(data) {
  if (!data?.existing || !(data.previous_computers || []).length) return;
  const lines = data.previous_computers.map(
    (c) =>
      `• ${c.host || "unknown computer"} (last backup ${new Date(c.last_backup).toLocaleDateString()}):\n    ` +
      c.folders.join("\n    ")
  );
  uiAlert(
    "This computer now continues an existing backup. Earlier backups stay on the drive and can still be restored.\n\n" +
      "Folders backed up so far:\n" + lines.join("\n") +
      "\n\nIf this computer keeps the same files in other folders, open the drive under Your drives and choose Edit folders.",
    "Continuing an existing backup"
  );
}

async function openPassphraseSheet(driveId) {
  try {
    const res = await fetch(`${API}/drives/passphrase-sheet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drive_id: driveId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { path } = await res.json();
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    await invoke("open_path", { path });
  } catch (err) {
    console.error(err);
    uiAlert("Couldn't open the passphrase sheet.");
  }
}

// POST /drives/setup. If the drive already has backups that this passphrase doesn't open,
// ask before creating a separate one, so a typo never silently starts a new backup.
// Returns null if the user declined.
async function postDriveSetup(payload) {
  const send = (p) =>
    fetch(`${API}/drives/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
  const res = await send(payload);
  if (res.status !== 409) return res;
  hideLoadingOverlay();
  const ok = await uiConfirm(
    "This drive already has backups, but this passphrase doesn't open any of them.\n\n" +
      "If you mistyped it, choose Cancel and try again.\n" +
      'Choose "Create separate backup" only if you want a separate new backup on this drive, protected by this passphrase.',
    "Create a separate backup?",
    { confirmText: "Create separate backup", focusCancel: true }
  );
  if (!ok) return null;
  showLoadingOverlay("Setting up drive…");
  return send({ ...payload, new_instance: true });
}

// Returns true only when the drive was set up.
async function setupDriveWithMount(mountPath) {
  if (!mountPath) {
    uiAlert("The drive isn't open yet. Click Open drive, or tick \"Erase this drive\".");
    return false;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Aegis is missing a part it needs. Please reinstall Aegis.");
    return false;
  }

  const passphrase = document.getElementById("passphrase").value;
  const confirm = document.getElementById("passphrase-confirm").value;
  const passphraseError = checkNewPassphrase(passphrase, confirm);
  if (passphraseError) {
    uiAlert(passphraseError);
    return false;
  }

  const payload = {
    mount_path: mountPath,
    label: document.getElementById("drive-label")?.value?.trim() || null,
    backup_sources: buildBackupSources(),
    passphrase,
    remember_passphrase: document.getElementById("remember-passphrase").checked,
    paranoid_mode: document.getElementById("paranoid-mode").checked,
  };

  const res = await postDriveSetup(payload);
  if (!res) return false;

  if (res.ok) {
    const data = await res.json();
    await saveConfig(wizardPayload());
    if (currentStatus?.drive) {
      currentStatus.drive.trusted = true;
      currentStatus.drive.drive_id = data.drive_id;
      pickedInstanceId = data.drive_id;
      showHandoverInfo(data);
      currentStatus.drive.label = currentStatus.drive.label || payload.label;
    }
    renderStatus(currentStatus);
    clearPassphraseFields("passphrase", "passphrase-confirm");
    return true;
  }
  const detail = await res.text();
  uiAlert(
    detail && detail.trim() ? detail.trim() : "Drive setup failed. Check the passphrase and try again.",
    "Setup failed"
  );
  return false;
}

function formatErrorMessage(detail, forFormat) {
  const lower = (detail || "").toLowerCase();
  if (lower.includes("authorization") || lower.includes("not authorized")) {
    return "Aegis needs your computer's password to do this. Try again and enter it when your computer asks.";
  }
  return detail && detail.trim() ? detail.trim() : (forFormat ? "Formatting failed." : "Something went wrong. Please try again.");
}

async function setupDriveFromSelectionForAddDrive() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert("Choose a drive first.");
      return;
    }
    if (!preflight.restic) {
      uiAlert("Aegis is missing a part it needs. Please reinstall Aegis.");
      return;
    }
    const passphrase = document.getElementById("setup-drive-passphrase")?.value ?? "";
    const confirm = document.getElementById("setup-drive-passphrase-confirm")?.value ?? "";
    const passphraseError = checkNewPassphrase(passphrase, confirm);
    if (passphraseError) {
      uiAlert(passphraseError);
      return;
    }
    const eraseOption = document.getElementById("setup-drive-erase-option");
    const erasePhrase = document.getElementById("setup-drive-erase-phrase");
    const shouldErase = !!eraseOption?.checked;

    let mountPath = selection.mountpoint || null;
    let devnodeToMount = selection.partition.path;
    const wasWholeDisk = !!selection.partition._wholeDisk;

    if (shouldErase) {
      const canFormat = preflight.can_format;
      if (!canFormat) {
        uiAlert(
          "Aegis can't erase drives on this computer. Erase it with your computer's disk tool (choose \"exFAT\"), then try again."
        );
        return;
      }
      const confirmErase = (erasePhrase?.value || "").trim();
      if (confirmErase !== "ERASE") {
        uiAlert('Type ERASE in the box to confirm erasing.');
        return;
      }
      const confirmMsg =
        `Erase "${selection.device.model || "USB drive"} (${selection.device.size})"? ` +
        "Everything on it will be deleted. This can't be undone.";
      if (!(await uiConfirm(confirmMsg, "Erase drive", { confirmText: "Erase drive", danger: true, focusCancel: true }))) {
        return;
      }
    }

    showLoadingOverlay("Preparing…");

    try {
      if (shouldErase) {
        showLoadingOverlay("Erasing drive…");
        const res = await fetch(`${API}/drives/format`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            devnode: selection.partition.path,
            label: document.getElementById("setup-drive-label")?.value || null,
          }),
        });
        if (!res.ok) {
          const detail = await res.text();
          uiAlert(formatErrorMessage(detail, true), "Format failed");
          return;
        }
        showLoadingOverlay("Refreshing device list…");
        await fetchDevices();
        mountPath = null;
        if (wasWholeDisk) {
          const device = deviceList.find((d) => d.path === selection.partition.path);
          if (device?.partitions?.length > 0) {
            devnodeToMount = device.partitions[0].path;
          }
        }
      }

      if (!selection.partition.fstype && !shouldErase) {
        await uiAlert("This drive needs erasing first. Tick \"Erase this drive\".");
        return;
      }

      if (!mountPath) {
        if (!preflight.can_mount) {
          uiAlert("Aegis can't open drives on this computer.");
          return;
        }
        showLoadingOverlay("Opening drive…");
        const mountRes = await fetch(`${API}/drives/mount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devnode: devnodeToMount }),
        });
        if (!mountRes.ok) {
          const detail = await mountRes.text();
          uiAlert(formatErrorMessage(detail, false), "Couldn't open the drive");
          return;
        }
        const data = await mountRes.json();
        mountPath = data.mount_path;
        await fetchDevices();
        await fetchStatus();
      }

    const labelRaw = document.getElementById("setup-drive-label")?.value?.trim();
    const payload = {
      mount_path: mountPath,
      label: labelRaw || null,
      backup_sources: buildSetupDriveBackupSources(),
      passphrase,
      // Keep this computer's passphrase choice (Settings), don't change it per drive.
      remember_passphrase: !!currentStatus?.config?.remember_passphrase,
      paranoid_mode: !!currentStatus?.config?.paranoid_mode,
    };

    showLoadingOverlay("Setting up drive…");
    const res = await postDriveSetup(payload);
    if (!res) return;

    if (res.ok) {
      const data = await res.json();
      await fetchStatus();
      if (currentStatus?.drive) {
        currentStatus.drive.trusted = true;
        currentStatus.drive.drive_id = data.drive_id;
        pickedInstanceId = data.drive_id;
        showHandoverInfo(data);
        currentStatus.drive.label = currentStatus.drive.label || payload.label;
      }
      renderStatus(currentStatus);
      clearPassphraseFields("setup-drive-passphrase", "setup-drive-passphrase-confirm");
      showView("dashboard");
    } else {
      const detail = await res.text();
      uiAlert(formatErrorMessage(detail, false) || "Drive setup failed. Check the passphrase and try again.", "Setup failed");
    }
    } finally {
      hideLoadingOverlay();
    }
  } catch (err) {
    hideLoadingOverlay();
    console.error(err);
    uiAlert("Setup failed — check your connection and try again.");
  }
}

async function mountSelectedPartition() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert("Choose a drive first.");
      return;
    }
    if (!preflight.can_mount) {
      uiAlert("Aegis can't open drives on this computer.");
      return;
    }
    const res = await fetch(`${API}/drives/mount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devnode: selection.partition.path }),
    });
    if (!res.ok) {
      const detail = await res.text();
      uiAlert(
        detail === "authorization required"
          ? "Aegis needs your computer's password to do this. Try again and enter it when your computer asks."
          : detail.trim() || "Couldn't open the drive. Unplug it, plug it back in, and try again."
      );
      return;
    }
    await fetchStatus();
    await fetchDevices();
  } catch (err) {
    console.error(err);
    uiAlert("Couldn't open the drive due to a connection error.");
  }
}

async function setupDriveFromSelection() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert("Choose a drive first.");
      return false;
    }
    if (!preflight.restic) {
      uiAlert("Aegis is missing a part it needs. Please reinstall Aegis.");
      return false;
    }
    const eraseOption = document.getElementById("erase-option");
    const erasePhrase = document.getElementById("erase-phrase");
    const shouldErase = !!eraseOption?.checked;

    let mountPath = selection.mountpoint || null;
    let devnodeToMount = selection.partition.path;
    const wasWholeDisk = !!selection.partition._wholeDisk;

    if (shouldErase) {
      const canFormat = preflight.can_format;
      if (!canFormat) {
        uiAlert(
          "Aegis can't erase drives on this computer. Erase it with your computer's disk tool (choose \"exFAT\"), then try again."
        );
        return false;
      }
      const confirm = (erasePhrase?.value || "").trim();
      if (confirm !== "ERASE") {
        uiAlert('Type ERASE in the box to confirm erasing.');
        return false;
      }
      const confirmMsg =
        `Erase "${selection.device.model || "USB drive"} (${selection.device.size})"? ` +
        "Everything on it will be deleted. This can't be undone.";
      if (!(await uiConfirm(confirmMsg, "Erase drive", { confirmText: "Erase drive", danger: true, focusCancel: true }))) {
        return false;
      }
    }

    showLoadingOverlay("Preparing…");

    try {
      if (shouldErase) {
        showLoadingOverlay("Erasing drive…");
        const res = await fetch(`${API}/drives/format`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            devnode: selection.partition.path,
            label: document.getElementById("drive-label").value || null,
          }),
        });
        if (!res.ok) {
          const detail = await res.text();
          uiAlert(formatErrorMessage(detail, true), "Format failed");
          return false;
        }
        showLoadingOverlay("Refreshing device list…");
        await fetchDevices();
        mountPath = null;
        if (wasWholeDisk) {
          const device = deviceList.find((d) => d.path === selection.partition.path);
          if (device?.partitions?.length > 0) {
            devnodeToMount = device.partitions[0].path;
          }
        }
      }

      if (!selection.partition.fstype && !shouldErase) {
        await uiAlert("This drive needs erasing first. Tick \"Erase this drive\".");
        return false;
      }

      if (!mountPath) {
        if (!preflight.can_mount) {
          uiAlert("Aegis can't open drives on this computer.");
          return false;
        }
        showLoadingOverlay("Opening drive…");
        const mountRes = await fetch(`${API}/drives/mount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devnode: devnodeToMount }),
        });
        if (!mountRes.ok) {
          const detail = await mountRes.text();
          uiAlert(formatErrorMessage(detail, false), "Couldn't open the drive");
          return false;
        }
        const data = await mountRes.json();
        mountPath = data.mount_path;
        await fetchDevices();
        await fetchStatus();
      }

      showLoadingOverlay("Setting up drive…");
      return await setupDriveWithMount(mountPath);
    } finally {
      hideLoadingOverlay();
    }
  } catch (err) {
    hideLoadingOverlay();
    console.error(err);
    uiAlert("Setup failed — check your connection and try again.");
    return false;
  }
}

async function startBackup() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Connect your Aegis drive first.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Aegis is missing a part it needs. Please reinstall Aegis.");
    return;
  }

  const result = await postWithPassphrase(
    "/backup/run",
    { drive_id: currentStatus.drive.drive_id },
    "Enter your passphrase to start the backup.",
    { verifies: false }
  );
  if (!result) return;
  if (!result.res.ok) {
    uiAlert(result.detail || "Couldn't start the backup. Please try again.", "Backup not started");
  }
}

async function loadSnapshots() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Connect your Aegis drive to see your backups.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Aegis is missing a part it needs. Please reinstall Aegis.");
    return;
  }
  const result = await postWithPassphrase(
    "/snapshots",
    { drive_id: currentStatus.drive.drive_id },
    "Enter your passphrase to see your backups."
  );
  if (!result) return;
  if (!result.res.ok) {
    uiAlert(result.detail || "Couldn't load your backups. Please try again.");
    return;
  }

  const data = await result.res.json();
  const list = document.getElementById("snapshot-list");
  list.innerHTML = "";
  browseTreeReset();
  if (!data.snapshots || data.snapshots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No backups on this drive yet.";
    list.appendChild(empty);
    return;
  }
  // Newest first: that's almost always the one people want.
  data.snapshots.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  const severalComputers = new Set(data.snapshots.map((s) => s.hostname)).size > 1;
  data.snapshots.forEach((snap) => {
    const item = document.createElement("div");
    item.className = "snapshot-item";
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "snapshot";
    radio.value = snap.id;
    radio.addEventListener("change", () => {
      fetchSnapshotStats(snap.id);
      loadBrowseTree(snap.id);
    });
    label.appendChild(radio);
    const span = document.createElement("span");
    span.textContent = `Backup from ${new Date(snap.time).toLocaleString()}` +
      (severalComputers && snap.hostname ? ` · computer: ${snap.hostname}` : "");
    label.appendChild(span);
    item.appendChild(label);
    list.appendChild(item);
  });
}

// Paths (as returned by the browse API) the user has checked for a selective restore.
let browseSelectedPaths = new Set();
let browseSnapshotId = null;

function browseTreeReset() {
  browseSelectedPaths = new Set();
  browseSnapshotId = null;
  const tree = document.getElementById("browse-tree");
  if (tree) tree.innerHTML = "";
  const section = document.getElementById("browse-section");
  if (section) section.classList.add("hidden");
}

async function fetchBrowseEntries(snapshotId, path) {
  const result = await postWithPassphrase(
    "/snapshots/browse",
    { drive_id: currentStatus.drive.drive_id, snapshot_id: snapshotId, path: path || null },
    "Enter your passphrase to browse this backup."
  );
  if (!result) return null;
  if (!result.res.ok) {
    uiAlert(result.detail || "Couldn't read the contents of this backup.");
    return null;
  }
  return (await result.res.json()).entries;
}

async function loadBrowseTree(snapshotId) {
  browseSelectedPaths = new Set();
  browseSnapshotId = snapshotId;
  const tree = document.getElementById("browse-tree");
  const section = document.getElementById("browse-section");
  if (!tree || !section) return;
  section.classList.remove("hidden");
  await loadBrowseChildren(null, tree);
}

async function loadBrowseChildren(path, listEl) {
  listEl.innerHTML = "";
  const loading = document.createElement("li");
  loading.className = "muted";
  loading.textContent = "Loading…";
  listEl.appendChild(loading);
  const entries = await fetchBrowseEntries(browseSnapshotId, path);
  listEl.innerHTML = "";
  if (!entries) return;
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "(nothing here)";
    listEl.appendChild(empty);
    return;
  }
  entries.forEach((entry) => listEl.appendChild(buildBrowseNode(entry)));
}

function buildBrowseNode(entry) {
  const li = document.createElement("li");
  li.className = "browse-node";
  const row = document.createElement("div");
  row.className = "browse-row";
  const isDir = entry.type === "dir";

  let toggle = null;
  if (isDir) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "browse-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▸";
    toggle.setAttribute("aria-label", `Show contents of ${entry.name}`);
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "browse-toggle-spacer";
    row.appendChild(spacer);
  }

  const checkboxId = `browse-cb-${Math.random().toString(36).slice(2)}`;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = checkboxId;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) browseSelectedPaths.add(entry.path);
    else browseSelectedPaths.delete(entry.path);
  });
  row.appendChild(checkbox);

  const label = document.createElement("label");
  label.htmlFor = checkboxId;
  label.textContent = entry.name;
  row.appendChild(label);

  if (!isDir && typeof entry.size === "number") {
    const size = document.createElement("span");
    size.className = "muted browse-size";
    size.textContent = formatBytes(entry.size);
    row.appendChild(size);
  }

  li.appendChild(row);

  if (isDir) {
    const childList = document.createElement("ul");
    childList.className = "browse-list browse-children hidden";
    li.appendChild(childList);
    let loaded = false;
    toggle.addEventListener("click", async () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      if (expanded) {
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "▸";
        childList.classList.add("hidden");
        return;
      }
      toggle.setAttribute("aria-expanded", "true");
      toggle.textContent = "▾";
      childList.classList.remove("hidden");
      if (!loaded) {
        loaded = true;
        await loadBrowseChildren(entry.path, childList);
      }
    });
  }

  return li;
}

async function runRestore(includePaths, confirmMessage) {
  const selected = document.querySelector("input[name='snapshot']:checked");
  if (!selected) {
    uiAlert("Select a backup first.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Aegis is missing a part it needs. Please reinstall Aegis.");
    return;
  }
  const target = document.getElementById("restore-target").value;
  if (!target) {
    uiAlert("Choose a restore folder.");
    return;
  }
  if (!(await uiConfirm(confirmMessage, "Restore files"))) {
    return;
  }

  showLoadingOverlay("Restoring your files… This can take a while for large backups. Keep the drive plugged in.");
  const stop = document.getElementById("loading-cancel");
  stop?.classList.remove("hidden");
  try {
    const result = await postWithPassphrase(
      "/restore",
      {
        drive_id: currentStatus.drive.drive_id,
        snapshot_id: selected.value,
        target_path: target,
        include_paths: includePaths,
      },
      "Enter your passphrase to restore."
    );
    hideLoadingOverlay();
    if (!result) return;
    if (!result.res.ok) {
      uiAlert(
        result.detail || "Restore failed. Please try again.",
        result.res.status === 409 ? "Restore stopped" : "Restore failed"
      );
      return;
    }
  } catch (_) {
    hideLoadingOverlay();
    uiAlert("Can't connect to Aegis right now. Try restarting the app.", "Restore failed");
    return;
  } finally {
    stop?.classList.add("hidden");
  }
  await uiAlert(`Your files are back in ${target}. Existing files were left untouched.`, "Restore complete");
  openFolderPath(target);
}

function restoreSnapshot() {
  return runRestore([], "Restore all files to a new folder? Aegis will not overwrite existing files.");
}

function restoreSelected() {
  if (browseSelectedPaths.size === 0) {
    uiAlert('Check at least one file or folder first, or use "Restore everything".');
    return;
  }
  return runRestore(
    Array.from(browseSelectedPaths),
    "Restore the checked files to a new folder? Aegis will not overwrite existing files."
  );
}

async function fetchSnapshotStats(snapshotId) {
  if (!snapshotId) return;
  const summary = document.getElementById("snapshot-summary");
  summary.textContent = "Loading backup details…";

  const result = await postWithPassphrase(
    "/snapshots/stats",
    { drive_id: currentStatus.drive.drive_id, snapshot_id: snapshotId },
    "Enter your passphrase to view backup details."
  );
  if (!result || !result.res.ok) {
    summary.textContent = "Couldn't load backup details.";
    return;
  }

  const stats = await result.res.json();
  summary.textContent = `Files: ${stats.total_file_count.toLocaleString()} · Size: ${formatBytes(stats.total_size)}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

async function ejectDrive() {
  if (!currentStatus?.drive?.mount_path) {
    uiAlert("No drive to eject.");
    return;
  }
  if (!(await uiConfirm("Eject the drive now?", "Eject drive"))) return;
  const res = await fetch(`${API}/drives/eject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mount_path: currentStatus.drive.mount_path }),
  });
  if (res.ok) {
    showToast("It's now safe to unplug the drive.");
  } else {
    uiAlert((await res.text()).trim() || "Couldn't eject the drive. Please try again.");
  }
}

async function exportRecoveryKit() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Plug in your Aegis drive first.");
    return;
  }
  const destination = document.getElementById("recovery-destination").value.trim();
  if (!destination) {
    uiAlert("Choose a folder to save the drive details in.");
    return;
  }
  const res = await fetch(`${API}/recovery-kit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      drive_id: currentStatus.drive.drive_id,
      destination_dir: destination,
    }),
  });
  if (res.ok) {
    showToast("Drive details saved. Keep them somewhere safe.");
  } else {
    uiAlert("Couldn't save the drive details. Check that the folder exists and try again.");
  }
}

// Short in-app confirmation. (Backup results come as desktop notifications from Aegis itself.)
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000);
}

function setupListeners() {
  console.info("[init] setupListeners called");
  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  wirePassphraseToggles();
  wirePassphraseMeter("passphrase", "passphrase-meter-bar", "passphrase-meter-label");
  wirePassphraseMeter(
    "setup-drive-passphrase",
    "setup-drive-passphrase-meter-bar",
    "setup-drive-passphrase-meter-label"
  );

  const wizardAdd = () => {
    addCustomFolder(customSources, "custom-label", "custom-path", renderCustomSources);
    updateWizardSummary(currentStatus || { drive: { connected: false } });
  };
  const addDriveAdd = () =>
    addCustomFolder(setupDriveCustomSources, "setup-drive-custom-label", "setup-drive-custom-path", renderSetupDriveCustomSources);
  document.getElementById("add-custom").addEventListener("click", wizardAdd);
  document.getElementById("setup-drive-add-custom").addEventListener("click", addDriveAdd);
  // A folder picked with Browse… is added right away.
  [
    ["browse-folder", "custom-path", wizardAdd],
    ["setup-drive-browse", "setup-drive-custom-path", addDriveAdd],
  ].forEach(([buttonId, pathId, add]) => {
    document.getElementById(buttonId).addEventListener("click", async () => {
      const path = await pickFolder();
      if (!path) return;
      document.getElementById(pathId).value = path;
      add();
    });
  });
  [
    ["restore-browse", "restore-target"],
    ["recovery-browse", "recovery-destination"],
  ].forEach(([buttonId, inputId]) => {
    document.getElementById(buttonId).addEventListener("click", async () => {
      const path = await pickFolder();
      if (path) document.getElementById(inputId).value = path;
    });
  });

  const mountDrive = document.getElementById("mount-drive");
  if (mountDrive)
    mountDrive.addEventListener("click", (event) => {
      event.preventDefault();
      console.info("[click] mount drive");
      mountSelectedPartition();
    });
  else console.warn("[init] mount-drive button not found");

  const setupDriveSetupBtn = document.getElementById("setup-drive-setup-btn");
  if (setupDriveSetupBtn) {
    setupDriveSetupBtn.addEventListener("click", (event) => {
      event.preventDefault();
      setupDriveFromSelectionForAddDrive();
    });
  }
  const setupDriveMountBtn = document.getElementById("setup-drive-mount");
  if (setupDriveMountBtn) {
    setupDriveMountBtn.addEventListener("click", (event) => {
      event.preventDefault();
      mountSelectedPartition();
    });
  }
  const setupDriveEraseOption = document.getElementById("setup-drive-erase-option");
  const setupDriveErasePhraseField = document.getElementById("setup-drive-erase-phrase-field");
  if (setupDriveEraseOption) {
    setupDriveEraseOption.addEventListener("change", () => {
      if (setupDriveErasePhraseField) setupDriveErasePhraseField.classList.toggle("hidden", !setupDriveEraseOption.checked);
      updateSetupDriveActions();
    });
  }
  const setupDriveErasePhrase = document.getElementById("setup-drive-erase-phrase");
  if (setupDriveErasePhrase) setupDriveErasePhrase.addEventListener("input", updateSetupDriveActions);

  const setupThisDriveBtn = document.getElementById("setup-this-drive-btn");
  if (setupThisDriveBtn) {
    setupThisDriveBtn.addEventListener("click", () => showView("setup-drive"));
  }
  const backupTargetsEmptyAdd = document.getElementById("backup-targets-empty-add");
  if (backupTargetsEmptyAdd) {
    backupTargetsEmptyAdd.addEventListener("click", () => showView("setup-drive"));
  }

  const erasePhrase = document.getElementById("erase-phrase");
  if (erasePhrase) erasePhrase.addEventListener("input", updateDeviceActions);
  const eraseOption = document.getElementById("erase-option");
  if (eraseOption)
    eraseOption.addEventListener("change", () => {
      const field = document.getElementById("erase-phrase-field");
      if (field) field.classList.toggle("hidden", !eraseOption.checked);
      updateDeviceActions();
    });
  if (eraseOption) {
    const field = document.getElementById("erase-phrase-field");
    if (field) field.classList.toggle("hidden", !eraseOption.checked);
  }
  document.getElementById("run-first-backup").addEventListener("click", async () => {
    if (await saveConfig(wizardPayload())) await startBackup();
  });
  if (wizardBack) wizardBack.addEventListener("click", goWizardBack);
  if (wizardNext)
    wizardNext.addEventListener("click", (event) => {
      event.preventDefault();
      console.info("[click] wizard next");
      goWizardNext();
    });
  else console.warn("[init] wizard-next button not found");
  if (wizardSkip)
    wizardSkip.addEventListener("click", () => {
      wizardDismissed = true;
      showView("dashboard");
      applyFirstRunMode(currentStatus);
    });

  document.getElementById("backup-now").addEventListener("click", () =>
    withBusy("backup-now", "Starting…", startBackup)
  );
  document.getElementById("restore-btn").addEventListener("click", () => showView("restore"));
  document.getElementById("eject-btn").addEventListener("click", () =>
    withBusy("eject-btn", "Ejecting…", ejectDrive)
  );

  document.getElementById("load-snapshots").addEventListener("click", () =>
    withBusy("load-snapshots", "Loading backups…", loadSnapshots)
  );
  document.getElementById("restore-run").addEventListener("click", restoreSnapshot);
  document.getElementById("restore-selected-run").addEventListener("click", restoreSelected);

  document.getElementById("save-settings").addEventListener("click", () =>
    withBusy("save-settings", "Saving…", () => saveConfig(settingsPayload(), "settings-saved"))
  );
  initAutostartToggle();
  document.getElementById("save-advanced").addEventListener("click", () =>
    withBusy("save-advanced", "Saving…", () => saveConfig(advancedPayload(), "advanced-saved"))
  );
  document.getElementById("export-recovery").addEventListener("click", () =>
    withBusy("export-recovery", "Saving…", exportRecoveryKit)
  );

  const remember = document.getElementById("remember-passphrase");
  const paranoid = document.getElementById("paranoid-mode");
  paranoid.addEventListener("change", () => {
    if (paranoid.checked) remember.checked = false;
    if (paranoid.checked) sessionPassphrase = null;
    securityTouched = true;
  });
  remember.addEventListener("change", () => {
    if (remember.checked) paranoid.checked = false;
    securityTouched = true;
  });

  document.getElementById("loading-cancel").addEventListener("click", () => {
    fetch(`${API}/restore/cancel`, { method: "POST" }).catch(() => {});
  });

  modalConfirm.addEventListener("click", confirmModal);
  modalCancel.addEventListener("click", () => {
    if (modalMode === "confirm") {
      closeModal(false);
    } else {
      closeModal(null);
    }
  });
  modalOverlay.addEventListener("click", (event) => {
    if (event.target === modalOverlay) {
      closeModal(null);
    }
  });
  modalOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal(modalMode === "confirm" ? false : null);
      return;
    }
    trapModalTab(event);
  });
  // Enter in a dialog field confirms. preventDefault so the same key press can't also
  // activate the button that focus returns to.
  ["modal-passphrase", "modal-discontinue-input", "modal-rename-input"].forEach((id) => {
    document.getElementById(id)?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      confirmModal();
    });
  });

  const editFoldersCancel = document.getElementById("edit-folders-cancel");
  const editFoldersSave = document.getElementById("edit-folders-save");
  const editFoldersAdd = document.getElementById("edit-folders-add");
  if (editFoldersCancel) {
    editFoldersCancel.addEventListener("click", closeEditFoldersModal);
  }
  if (editFoldersSave) {
    editFoldersSave.addEventListener("click", () => withBusy("edit-folders-save", "Saving…", saveEditFolders));
  }
  const editFoldersOverlay = document.getElementById("edit-folders-overlay");
  if (editFoldersOverlay) {
    editFoldersOverlay.addEventListener("click", (event) => {
      if (event.target === editFoldersOverlay) closeEditFoldersModal();
    });
    editFoldersOverlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeEditFoldersModal();
        return;
      }
      if (event.key !== "Tab") return;
      const card = editFoldersOverlay.querySelector(".modal-card");
      if (!card) return;
      const focusable = Array.from(
        card.querySelectorAll('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled && el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }
  if (editFoldersAdd) {
    editFoldersAdd.addEventListener("click", async () => {
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
      if (typeof invoke !== "function") {
        document.getElementById("edit-folders-error").textContent = "Folder picker not available.";
        return;
      }
      try {
        const path = await invoke("select_folder");
        if (path) {
          const label = path.split(/[/\\]/).filter(Boolean).pop() || "Folder";
          editFoldersCustomSources.push({ label, path });
          renderEditFoldersCustomList();
        }
      } catch (err) {
        document.getElementById("edit-folders-error").textContent = "Could not select folder.";
      }
    });
  }
}

setupListeners();
console.info("[init] app.js loaded");
(() => {
  const toggle = document.getElementById("devtools-toggle");
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!toggle || typeof invoke !== "function") return;
  invoke("is_dev_build")
    .then((isDev) => {
      console.info("[devtools] is_dev_build", isDev);
      if (isDev) {
        toggle.classList.remove("hidden");
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          invoke("toggle_devtools");
        });
      }
    })
    .catch((err) => {
      console.error("[devtools] failed", err);
    });
})();
fetchStatus();
fetchDevices();
fetchPreflight();
setInterval(fetchStatus, 1500);
setInterval(fetchDevices, 1500);
setInterval(fetchPreflight, 5000);

// "Start at login" lives in the desktop shell, not the agent config; applies immediately.
function initAutostartToggle() {
  const box = document.getElementById("autostart");
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!box || !invoke) return;
  invoke("get_autostart").then((on) => (box.checked = !!on)).catch(() => {});
  box.addEventListener("change", () => {
    invoke("set_autostart", { enabled: box.checked }).catch(() => {
      box.checked = !box.checked;
      uiAlert("Couldn't change the login setting. Please try again.");
    });
  });
}
