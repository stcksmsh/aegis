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

function showLoadingOverlay(message) {
  if (loadingMessage) loadingMessage.textContent = message || "Working…";
  if (loadingOverlay) loadingOverlay.classList.remove("hidden");
  document.body.classList.add("setup-loading");
  setSetupButtonsDisabled(true);
}

function hideLoadingOverlay() {
  if (loadingOverlay) loadingOverlay.classList.add("hidden");
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
    "setup-drive-remember",
    "setup-drive-paranoid",
    "setup-drive-label",
    "mount-drive",
    "setup-drive",
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
  if (el) el.disabled = disabled;
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
  const setupThisDriveBtn = document.getElementById("setup-this-drive-btn");
  if (setupThisDriveBtn) {
    setupThisDriveBtn.classList.toggle("hidden", !driveConnected || trusted);
  }
  updateDeviceActions();
  updateSetupDriveActions();
}

const BACKUP_STUCK_THRESHOLD_SEC = 30 * 60; // 30 minutes

function renderBanner(status) {
  if (!agentOnline) {
    setBanner("alert", "Can't connect to Aegis right now. Try restarting the app.");
    return;
  }
  if (status && !status.restic_available) {
    setBanner("warn", "Backup engine missing — please reinstall Aegis.");
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

function openModal({ title, body, mode, drive_id, drive_label }) {
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
      modalConfirm.textContent = "Confirm";
      modalCancel.classList.remove("hidden");
    } else if (mode === "discontinue") {
      modalConfirm.textContent = "Discontinue";
      modalCancel.classList.remove("hidden");
    } else if (mode === "rename-drive") {
      modalConfirm.textContent = "Save";
      modalCancel.classList.remove("hidden");
    } else {
      modalConfirm.textContent = "Continue";
      modalCancel.classList.remove("hidden");
    }

    modalOpenerElement = document.activeElement;
    modalOverlay.classList.remove("hidden");
    setTimeout(() => {
      if (needsPassphrase) {
        modalPassphrase.focus();
      } else if (needsDiscontinue && discontinueInput) {
        discontinueInput.focus();
      } else if (needsRename && renameInput) {
        renameInput.focus();
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

function uiConfirm(message, title = "Confirm") {
  return openModal({ title, body: message, mode: "confirm" });
}

function requestPassphrase(message) {
  if (sessionPassphrase && !currentStatus?.config?.paranoid_mode) {
    return Promise.resolve(sessionPassphrase);
  }
  return openModal({ title: "Passphrase required", body: message, mode: "passphrase" });
}

function closeModal(value) {
  modalOverlay.classList.add("hidden");
  if (modalOpenerElement && typeof modalOpenerElement.focus === "function") {
    modalOpenerElement.focus();
  }
  modalOpenerElement = null;
  if (modalResolve) {
    const resolver = modalResolve;
    modalResolve = null;
    resolver(value);
  }
}

async function confirmModal() {
  if (modalMode === "passphrase") {
    const value = modalPassphrase.value.trim();
    if (!value) {
      modalError.textContent = "Passphrase required.";
      return;
    }
    if (!currentStatus?.config?.paranoid_mode) {
      sessionPassphrase = value;
    }
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
      modalError.textContent = "That name doesn't match. Type the drive name exactly to confirm.";
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
      } else {
        const text = await res.text();
        modalError.textContent = text && text.trim() ? text.trim() : "Couldn't discontinue the drive. Please try again.";
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
      modalError.textContent = "Enter a drive name.";
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
        modalError.textContent = text && text.trim() ? text.trim() : "Couldn't rename the drive. Please try again.";
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

function renderStatus(status) {
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
      summaryText.textContent = "No drives set up";
    } else {
      const conn = connected === 0 ? "none connected" : `${connected} connected`;
      summaryText.textContent = `${total} drive${total !== 1 ? "s" : ""} set up · ${conn}`;
    }
  }
  if (summaryVerify) {
    summaryVerify.textContent = status.config?.quick_verify ? " · Quick verify on" : "";
  }

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
    driveDetectText = total === 0 ? "Add a drive to get started" : "Plug in a drive to back up";
  } else if (status.drive.trusted) {
    driveDetectText = `${status.drive.label || "Drive"} connected — ready to back up`;
  } else if (!status.drive.mount_path) {
    driveDetectText = "Drive detected — select a drive below";
  } else {
    driveDetectText = "Drive detected — not set up yet. Go to Add drive to set it up.";
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

function renderBackupTargets(trustedDrives, status) {
  const list = document.getElementById("backup-targets-list");
  const empty = document.getElementById("backup-targets-empty");
  if (!list || !empty) return;
  const runningDriveIds = new Set((status && status.running_drive_ids) || []);
  const progressMap = (status && status.backup_progress && typeof status.backup_progress === "object") ? status.backup_progress : {};
  const expandedIds = new Set(
    Array.from(list.querySelectorAll(".backup-target-row.expanded"))
      .map((row) => row.dataset.driveId)
      .filter(Boolean)
  );
  list.innerHTML = "";
  if (!Array.isArray(trustedDrives) || trustedDrives.length === 0) {
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

    const header = document.createElement("div");
    header.className = "backup-target-header";
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
    renameBtn.title = !d.is_connected ? "Connect this drive to rename" : isDrivingBackingUp ? "Backup in progress" : "";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      openModal({
        title: "Rename drive",
        body: "Change the name Aegis uses for this drive. This doesn't rename the drive itself.",
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
    driveActions.appendChild(renameBtn);
    driveActions.appendChild(editFoldersBtn);
    expanded.appendChild(driveActions);
    const discontinueBtn = document.createElement("button");
    discontinueBtn.type = "button";
    discontinueBtn.className = "btn ghost backup-target-discontinue";
    discontinueBtn.textContent = "Discontinue drive";
    discontinueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal({
        title: "Discontinue drive",
        body: "This will remove the drive from Aegis. Backups on the drive are not deleted. Type the drive name to confirm:",
        mode: "discontinue",
        drive_id: d.drive_id,
        drive_label: d.label || "",
      });
    });
    expanded.appendChild(discontinueBtn);
    row.appendChild(expanded);

    header.addEventListener("click", () => {
      expanded.classList.toggle("hidden");
      row.classList.toggle("expanded", !expanded.classList.contains("hidden"));
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
    removeBtn.setAttribute("aria-label", "Remove");
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
  if (updated) updated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;

  if (!deviceList.length) {
    if (empty) empty.classList.remove("hidden");
    if (help) help.textContent = "Insert a removable drive to continue.";
    return false;
  }
  if (empty) empty.classList.add("hidden");
  if (help) help.textContent = "Select a drive below to open or set up.";

  let hasSelection = false;
  deviceList.forEach((device) => {
    const deviceTitle = device.model || "Removable drive";
    const deviceMeta = `${device.size} • ${device.path}`;
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

    partsToShow.forEach((part) => {
      const mountpoint = part.mountpoints?.[0] || "";
      const subtitle = `${part.path} • ${part.size}`;
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
      titleEl.textContent = isWholeDisk
        ? "Whole drive (needs setup)"
        : (device.removable ? `Drive section ${part.name}` : "System drive (not usable for backups)");
      const sub = document.createElement("div");
      sub.className = "partition-subtitle";
      sub.textContent = subtitle;
      details.appendChild(titleEl);
      details.appendChild(sub);
      const status = document.createElement("div");
      status.className = "partition-status";
      if (!device.removable) {
        status.textContent = "Not selectable";
        status.classList.add("warn");
      } else if (isWholeDisk) {
        status.textContent = "Erase & format this drive to set it up for Aegis.";
        status.classList.add("warn");
      } else {
        const fstype = part.fstype || "Unformatted";
        status.textContent = mountpoint
          ? `Open at ${mountpoint} • ${fstype}`
          : `Not open • ${fstype}`;
        if (!part.fstype) {
          status.classList.add("warn");
        }
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

function renderDevices() {
  const list = document.getElementById("device-list");
  const empty = document.getElementById("device-empty");
  const help = document.getElementById("device-help");
  const updated = document.getElementById("device-updated");
  if (!list || !empty) return;
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

function renderPreflight() {
  const restic = document.getElementById("preflight-restic");
  const udisks = document.getElementById("preflight-udisks");
  const exfat = document.getElementById("preflight-exfat");
  if (restic) {
    restic.textContent = preflight.restic ? "Backup engine: ready" : "Backup engine: missing";
    restic.className = `preflight-item ${preflight.restic ? "ok" : "warn"}`;
  }
  if (udisks) {
    udisks.textContent = preflight.can_mount ? "Drive tools: ready" : "Drive tools: unavailable";
    udisks.className = `preflight-item ${preflight.can_mount ? "ok" : "warn"}`;
  }
  if (exfat) {
    exfat.textContent = preflight.can_format ? "Drive formatting: ready" : "Drive formatting: unavailable";
    exfat.className = `preflight-item ${preflight.can_format ? "ok" : "warn"}`;
  }
  const setupRestic = document.getElementById("setup-drive-preflight-restic");
  const setupUdisks = document.getElementById("setup-drive-preflight-udisks");
  const setupExfat = document.getElementById("setup-drive-preflight-exfat");
  if (setupRestic) {
    setupRestic.textContent = preflight.restic ? "Backup engine: ready" : "Backup engine: missing";
    setupRestic.className = `preflight-item ${preflight.restic ? "ok" : "warn"}`;
  }
  if (setupUdisks) {
    setupUdisks.textContent = preflight.can_mount ? "Drive tools: ready" : "Drive tools: unavailable";
    setupUdisks.className = `preflight-item ${preflight.can_mount ? "ok" : "warn"}`;
  }
  if (setupExfat) {
    setupExfat.textContent = preflight.can_format ? "Drive formatting: ready" : "Drive formatting: unavailable";
    setupExfat.className = `preflight-item ${preflight.can_format ? "ok" : "warn"}`;
  }
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
    else if (!hasSelection) message = "Select a drive to continue.";
    else if (wantsErase && !canFormat) message = "Aegis can't format drives on this computer.";
    else if (!mounted && !canMount) message = "Aegis can't open drives on this computer.";
    else if (!canSetup) message = "Backup engine missing — please reinstall Aegis.";
    else if (!mounted && !wantsErase) message = "Open the drive, or turn on erase & format.";
    else if (wantsErase && (erasePhrase?.value || "").trim() !== "ERASE") {
      message = 'Type "ERASE" to confirm formatting.';
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
      ? "Select a drive to open."
      : !hasFilesystem
      ? "This drive isn't formatted yet. Use erase & format first."
      : mounted
      ? "Already open."
      : !canMount
      ? "Aegis can't open drives on this computer."
      : "Open the selected drive.";
  }
  if (setupButton) {
    setupButton.disabled = !hasSelection;
    setupButton.title = !hasSelection
      ? "Select a drive to continue."
      : !canSetup
      ? "Backup engine missing — please reinstall Aegis."
      : !hasFilesystem && !wantsErase
      ? "This drive isn't formatted yet. Enable erase & format."
      : !mounted && !canMount
      ? "Aegis can't open drives on this computer."
      : wantsErase && !canFormat
      ? "Aegis can't format drives on this computer."
      : "Set up this drive.";
  }

  if (status) {
    let message = "";
    if (!agentOnline) {
      message = "Not connected to Aegis.";
    } else if (!hasSelection) {
      message = "Select a drive to continue.";
    } else if (wantsErase && !canFormat) {
      message = "Aegis can't format drives on this computer.";
    } else if (!mounted && !canMount) {
      message = "Aegis can't open drives on this computer.";
    } else if (!canSetup) {
      message = "Backup engine missing — please reinstall Aegis.";
    } else if (!mounted && !wantsErase) {
      message = "Open the drive, or turn on erase & format.";
    } else if (wantsErase && (erasePhrase?.value || "").trim() !== "ERASE") {
      message = 'Type "ERASE" to confirm formatting.';
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

function syncConfigUI(status) {
  if (!status?.config) return;
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
  if (wizardNext) wizardNext.classList.toggle("hidden", wizardStep === wizardSteps.length - 1);
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
// "okay", "strong").
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
    return { score: 1, label: "Too short" };
  }
  const long = value.length >= 20 || wordCount >= 4;
  const decent = value.length >= 12 || variety >= 3;
  if (long && (variety >= 2 || wordCount >= 4)) {
    return { score: 3, label: "Strong" };
  }
  if (decent) {
    return { score: 2, label: "Okay" };
  }
  return { score: 1, label: "Too short" };
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
  const summaryItems = [
    `Sources: ${sources.map((s) => s.label).join(", ") || "None"}`,
    `Quick verify: ${document.getElementById("quick-verify")?.checked ? "On" : "Off"}`,
    `Automatic backup: ${document.getElementById("auto-backup")?.checked ? "On" : "Off"}`,
    status.restic_available ? "Backup engine ready" : "Backup engine missing",
    status.drive.connected
      ? status.drive.mount_path
        ? "Drive detected"
        : "Drive detected — select it below to continue"
      : "Waiting for drive",
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
    removeBtn.setAttribute("aria-label", "Remove");
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
    removeBtn.setAttribute("aria-label", "Remove");
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

async function saveConfig() {
  const retentionEnabled = document.getElementById("retention-enabled").checked;
  const retention = {
    enabled: retentionEnabled,
    keep_last: parseInt(document.getElementById("keep-last").value || "0", 10),
    keep_daily: parseInt(document.getElementById("keep-daily").value || "0", 10),
    keep_weekly: parseInt(document.getElementById("keep-weekly").value || "0", 10),
    keep_monthly: parseInt(document.getElementById("keep-monthly").value || "0", 10),
    keep_yearly: parseInt(document.getElementById("keep-yearly").value || "0", 10),
    min_snapshots: 3,
  };

  const excludeRaw = document.getElementById("exclude-patterns").value || "";
  const excludePatterns = excludeRaw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const includeRaw = document.getElementById("include-patterns")?.value || "";
  const includePatterns = includeRaw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const payload = {
    backup_sources: buildBackupSources(),
    include_patterns: includePatterns,
    exclude_patterns: excludePatterns,
    retention,
    quick_verify: document.getElementById("quick-verify").checked,
    deep_verify: document.getElementById("deep-verify").checked,
    auto_backup_on_insert: document.getElementById("auto-backup").checked,
    remember_passphrase: document.getElementById("remember-passphrase").checked,
    paranoid_mode: document.getElementById("paranoid-mode").checked,
    reminder_days: parseInt(document.getElementById("reminder-days")?.value || "0", 10),
    backup_interval_hours: parseInt(document.getElementById("backup-interval-hours")?.value || "0", 10),
  };

  const res = await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    currentStatus = await res.json();
    renderStatus(currentStatus);
  } else {
    uiAlert("Could not save settings.");
  }
}

async function setupDriveWithMount(mountPath) {
  if (!mountPath) {
    uiAlert("Drive detected but not open yet. Please open or format it first.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Backup engine missing — please reinstall Aegis.");
    return;
  }

  const passphrase = document.getElementById("passphrase").value;
  const confirm = document.getElementById("passphrase-confirm").value;
  const passphraseError = checkNewPassphrase(passphrase, confirm);
  if (passphraseError) {
    uiAlert(passphraseError);
    return;
  }

  const payload = {
    mount_path: mountPath,
    label: document.getElementById("drive-label")?.value?.trim() || null,
    backup_sources: buildBackupSources(),
    passphrase,
    remember_passphrase: document.getElementById("remember-passphrase").checked,
    paranoid_mode: document.getElementById("paranoid-mode").checked,
  };

  const res = await fetch(`${API}/drives/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    const data = await res.json();
    await saveConfig();
    if (currentStatus?.drive) {
      currentStatus.drive.trusted = true;
      currentStatus.drive.drive_id = data.drive_id;
      currentStatus.drive.label = currentStatus.drive.label || payload.label;
    }
    renderStatus(currentStatus);
    notify("Drive ready", "Aegis set up the drive successfully.");
  } else {
    const detail = await res.text();
    uiAlert(
      detail && detail.trim() ? detail.trim() : "Drive setup failed. Check the passphrase and try again.",
      "Setup failed"
    );
  }
}

async function setupDrive() {
  await setupDriveFromSelection();
}

function formatErrorMessage(detail, forFormat) {
  const lower = (detail || "").toLowerCase();
  if (lower.includes("authorization") || lower.includes("not authorized")) {
    return "Your computer will ask for your password to allow this.";
  }
  return detail && detail.trim() ? detail.trim() : (forFormat ? "Formatting failed." : "Something went wrong. Please try again.");
}

async function setupDriveFromSelectionForAddDrive() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert("Select a drive first.");
      return;
    }
    if (!preflight.restic) {
      uiAlert("Backup engine missing — please reinstall Aegis.");
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
          "Aegis can't format drives on this computer. Format it as exFAT using your system's disk tool, then try again."
        );
        return;
      }
      const confirmErase = (erasePhrase?.value || "").trim();
      if (confirmErase !== "ERASE") {
        uiAlert('Type "ERASE" to confirm formatting.');
        return;
      }
      const confirmMsg = wasWholeDisk
        ? "This will erase the whole drive and set it up fresh. Continue?"
        : "This will erase all data on the selected drive. Continue?";
      if (!(await uiConfirm(confirmMsg))) {
        return;
      }
    }

    showLoadingOverlay("Preparing…");

    try {
      if (shouldErase) {
        showLoadingOverlay("Formatting drive…");
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
        await uiAlert("This drive isn't formatted. Enable erase & format to continue.");
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
      remember_passphrase: !!document.getElementById("setup-drive-remember")?.checked,
      paranoid_mode: !!document.getElementById("setup-drive-paranoid")?.checked,
    };

    showLoadingOverlay("Setting up drive…");
    const res = await fetch(`${API}/drives/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      await fetchStatus();
      if (currentStatus?.drive) {
        currentStatus.drive.trusted = true;
        currentStatus.drive.drive_id = data.drive_id;
        currentStatus.drive.label = currentStatus.drive.label || payload.label;
      }
      renderStatus(currentStatus);
      notify("Drive ready", "Aegis set up the drive successfully.");
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
      uiAlert("Select a drive first.");
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
          ? "Your computer will ask for your password to allow this."
          : "Couldn't open the drive. Check permissions and try again."
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
      uiAlert("Select a drive first.");
      return false;
    }
    if (!preflight.restic) {
      uiAlert("Backup engine missing — please reinstall Aegis.");
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
          "Aegis can't format drives on this computer. Format it as exFAT using your system's disk tool, then try again."
        );
        return false;
      }
      const confirm = (erasePhrase?.value || "").trim();
      if (confirm !== "ERASE") {
        uiAlert('Type "ERASE" to confirm formatting.');
        return false;
      }
      const confirmMsg = wasWholeDisk
        ? "This will erase the whole drive and set it up fresh. Continue?"
        : "This will erase all data on the selected drive. Continue?";
      if (!(await uiConfirm(confirmMsg))) {
        return false;
      }
    }

    showLoadingOverlay("Preparing…");

    try {
      if (shouldErase) {
        showLoadingOverlay("Formatting drive…");
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
        await uiAlert("This drive isn't formatted. Enable erase & format to continue.");
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
      await setupDriveWithMount(mountPath);
      return true;
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
    uiAlert("Backup engine missing — please reinstall Aegis.");
    return;
  }

  let payload = { drive_id: currentStatus.drive.drive_id, passphrase: null };
  let res = await fetch(`${API}/backup/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to start the backup.");
    if (!passphrase) return;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/backup/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (res.ok) {
    notify("Backup started", "Aegis is running your backup.");
  } else {
    uiAlert("Couldn't start the backup. Please try again.");
  }
}

async function loadSnapshots() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Connect your Aegis drive to see your backups.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Backup engine missing — please reinstall Aegis.");
    return;
  }
  let payload = { drive_id: currentStatus.drive.drive_id, passphrase: null };
  let res = await fetch(`${API}/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to see your backups.");
    if (!passphrase) return;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    uiAlert("Couldn't load your backups. Please try again.");
    return;
  }

  const data = await res.json();
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
    span.textContent = `Backup from ${new Date(snap.time).toLocaleString()}`;
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
  let payload = { drive_id: currentStatus.drive.drive_id, snapshot_id: snapshotId, path: path || null, passphrase: null };
  let res = await fetch(`${API}/snapshots/browse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to browse this backup.");
    if (!passphrase) return null;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/snapshots/browse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  if (!res.ok) {
    uiAlert("Couldn't read the contents of this backup.");
    return null;
  }
  return (await res.json()).entries;
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
    uiAlert("Backup engine missing — please reinstall Aegis.");
    return;
  }
  const target = document.getElementById("restore-target").value;
  if (!target) {
    uiAlert("Choose a restore folder.");
    return;
  }
  if (!confirm(confirmMessage)) {
    return;
  }

  let payload = {
    drive_id: currentStatus.drive.drive_id,
    snapshot_id: selected.value,
    target_path: target,
    include_paths: includePaths,
    passphrase: null,
  };

  let res = await fetch(`${API}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to restore.");
    if (!passphrase) return;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (res.ok) {
    notify("Restore complete", "Aegis restored your files.");
  } else {
    uiAlert("Restore failed. Please try again.");
  }
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

  let payload = { drive_id: currentStatus.drive.drive_id, snapshot_id: snapshotId, passphrase: null };
  let res = await fetch(`${API}/snapshots/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to view backup details.");
    if (!passphrase) return;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/snapshots/stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    summary.textContent = "Couldn't load backup details.";
    return;
  }

  const stats = await res.json();
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
  if (!confirm("Eject the drive now?")) return;
  const res = await fetch(`${API}/drives/eject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mount_path: currentStatus.drive.mount_path }),
  });
  if (res.ok) {
    notify("Drive ejected", "You can safely remove the USB drive.");
  } else {
    uiAlert("Couldn't eject the drive. Please try again.");
  }
}

async function exportRecoveryKit() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Connect your Aegis drive to export a recovery kit.");
    return;
  }
  const destination = document.getElementById("recovery-destination").value.trim();
  if (!destination) {
    uiAlert("Choose a folder for the Recovery Kit.");
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
    notify("Recovery kit created", "Store it somewhere safe.");
  } else {
    uiAlert("Couldn't create the recovery kit. Please try again.");
  }
}

function notify(title, body) {
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          new Notification(title, { body });
        }
      });
    }
  }
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

  document.getElementById("add-custom").addEventListener("click", () => {
    const label = document.getElementById("custom-label").value.trim();
    const path = document.getElementById("custom-path").value.trim();
    if (!label || !path) return;
    customSources.push({ label, path });
    document.getElementById("custom-label").value = "";
    document.getElementById("custom-path").value = "";
    renderCustomSources();
    updateWizardSummary(currentStatus || { drive: { connected: false } });
  });

  const setupDriveAddCustom = document.getElementById("setup-drive-add-custom");
  if (setupDriveAddCustom) {
    setupDriveAddCustom.addEventListener("click", () => {
      const label = document.getElementById("setup-drive-custom-label")?.value?.trim() ?? "";
      const path = document.getElementById("setup-drive-custom-path")?.value?.trim() ?? "";
      if (!label || !path) return;
      setupDriveCustomSources.push({ label, path });
      const labelEl = document.getElementById("setup-drive-custom-label");
      const pathEl = document.getElementById("setup-drive-custom-path");
      if (labelEl) labelEl.value = "";
      if (pathEl) pathEl.value = "";
      renderSetupDriveCustomSources();
    });
  }
  const setupDriveBrowse = document.getElementById("setup-drive-browse");
  if (setupDriveBrowse) {
    setupDriveBrowse.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
        if (typeof invoke !== "function") {
          uiAlert("Folder picker is available in the desktop app. Please type the path manually.");
          return;
        }
        const selection = await invoke("select_folder");
        if (typeof selection === "string") {
          const pathEl = document.getElementById("setup-drive-custom-path");
          const labelEl = document.getElementById("setup-drive-custom-label");
          if (pathEl) pathEl.value = selection;
          if (labelEl && !labelEl.value.trim()) {
            const parts = selection.split(/[\\/]/).filter(Boolean);
            if (parts.length > 0) labelEl.value = parts[parts.length - 1];
          }
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  if (browseFolder) {
    browseFolder.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
        if (typeof invoke !== "function") {
          uiAlert("Folder picker is available in the desktop app. Please type the path manually.");
          return;
        }
        const selection = await invoke("select_folder");
        if (typeof selection === "string") {
          document.getElementById("custom-path").value = selection;
          const parts = selection.split(/[\\/]/).filter(Boolean);
          if (parts.length > 0) {
            document.getElementById("custom-label").value ||= parts[parts.length - 1];
          }
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  const setupDriveBtn = document.getElementById("setup-drive");
  if (setupDriveBtn) {
    setupDriveBtn.addEventListener("click", (event) => {
      event.preventDefault();
      console.info("[click] use this drive");
      setupDrive();
    });
  } else {
    console.warn("[init] setup-drive button not found");
  }
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
    await saveConfig();
    await startBackup();
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

  document.getElementById("backup-now").addEventListener("click", startBackup);
  document.getElementById("restore-btn").addEventListener("click", () => showView("restore"));
  document.getElementById("eject-btn").addEventListener("click", ejectDrive);

  document.getElementById("load-snapshots").addEventListener("click", loadSnapshots);
  document.getElementById("restore-run").addEventListener("click", restoreSnapshot);
  document.getElementById("restore-selected-run").addEventListener("click", restoreSelected);

  document.getElementById("save-settings").addEventListener("click", saveConfig);
  initAutostartToggle();
  document.getElementById("save-advanced").addEventListener("click", saveConfig);
  document.getElementById("export-recovery").addEventListener("click", exportRecoveryKit);

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
  modalPassphrase.addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirmModal();
    if (event.key === "Escape") closeModal(null);
  });
  const modalDiscontinueInput = document.getElementById("modal-discontinue-input");
  if (modalDiscontinueInput) {
    modalDiscontinueInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") confirmModal();
      if (event.key === "Escape") closeModal(null);
    });
  }

  const editFoldersCancel = document.getElementById("edit-folders-cancel");
  const editFoldersSave = document.getElementById("edit-folders-save");
  const editFoldersAdd = document.getElementById("edit-folders-add");
  if (editFoldersCancel) {
    editFoldersCancel.addEventListener("click", closeEditFoldersModal);
  }
  if (editFoldersSave) editFoldersSave.addEventListener("click", saveEditFolders);
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
