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
  lsblk: false,
  udisksctl: false,
  mkfs_exfat: false,
  pkexec: false,
  udisksctl_format: false,
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
    btn.classList.toggle("active", btn.dataset.view === id);
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
    setBanner("alert", "Agent is not running. Start the Aegis agent to continue.");
    return;
  }
  if (status && !status.restic_available) {
    setBanner("warn", "Restic is not available. Install or bundle restic to enable backups.");
    return;
  }
  if (status?.running && status?.last_run?.started_epoch) {
    const elapsed = Math.floor(Date.now() / 1000) - status.last_run.started_epoch;
    if (elapsed >= BACKUP_STUCK_THRESHOLD_SEC) {
      setBanner("warn", "Backup has been in progress for a long time. If nothing is happening, try restarting the Aegis agent.");
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
      modalError.textContent = "Name does not match. Type the drive name exactly to confirm.";
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
        modalError.textContent = text && text.trim() ? text.trim() : "Failed to discontinue drive.";
      }
    } catch (err) {
      modalError.textContent = "Request failed.";
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
        modalError.textContent = text && text.trim() ? text.trim() : "Failed to rename.";
      }
    } catch (err) {
      modalError.textContent = "Request failed.";
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

function renderStatus(status) {
  const summaryText = document.getElementById("dashboard-summary-text");
  const summaryVerify = document.getElementById("dashboard-summary-verify");
  const driveDetectEls = document.querySelectorAll(".drive-detect-message");
  const devnode = status.drive?.devnode;

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
      summaryText.textContent = `${total} trusted drive${total !== 1 ? "s" : ""} · ${conn}`;
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
    driveDetectText = `Drive detected${devnode ? ` (${devnode})` : ""} — select a drive below`;
  } else {
    driveDetectText = "Drive detected (not in your trusted list — set up or format in Add drive)";
  }
  driveDetectEls.forEach((el) => { el.textContent = driveDetectText; });

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
        body: "Change the in-app name for this drive (disk name stays the same).",
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
  document.getElementById("edit-folders-overlay").classList.remove("hidden");
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
      document.getElementById("edit-folders-overlay").classList.add("hidden");
      editFoldersPending = null;
      await fetchStatus();
    } else {
      const text = await res.text();
      errEl.textContent = text && text.trim() ? text.trim() : "Failed to update folders.";
    }
  } catch (err) {
    errEl.textContent = "Request failed.";
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
  if (help) help.textContent = "Select a partition or whole disk to mount or set up.";

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
        ? "Whole disk (no partitions)"
        : (device.removable ? `Partition ${part.name}` : "System drive partition");
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
        status.textContent = "Erase & format to create a partition and set up.";
        status.classList.add("warn");
      } else {
        const fstype = part.fstype || "Unformatted";
        status.textContent = mountpoint
          ? `Mounted at ${mountpoint} • ${fstype}`
          : `Not mounted • ${fstype}`;
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
    restic.textContent = preflight.restic ? "Restic: ready" : "Restic: missing";
    restic.className = `preflight-item ${preflight.restic ? "ok" : "warn"}`;
  }
  if (udisks) {
    const ok = preflight.udisksctl && preflight.lsblk;
    udisks.textContent = ok ? "Disk tools: ready" : "Disk tools: missing";
    udisks.className = `preflight-item ${ok ? "ok" : "warn"}`;
  }
  if (exfat) {
    const ok = preflight.udisksctl_format || (preflight.mkfs_exfat && preflight.pkexec);
    if (preflight.udisksctl_format) {
      exfat.textContent = "exFAT formatter: ready (udisksctl)";
    } else if (preflight.mkfs_exfat && preflight.pkexec) {
      exfat.textContent = "exFAT formatter: ready (pkexec)";
    } else if (preflight.mkfs_exfat) {
      exfat.textContent = "exFAT formatter: needs pkexec";
    } else {
      exfat.textContent = "exFAT formatter: missing";
    }
    exfat.className = `preflight-item ${ok ? "ok" : "warn"}`;
  }
  const setupRestic = document.getElementById("setup-drive-preflight-restic");
  const setupUdisks = document.getElementById("setup-drive-preflight-udisks");
  const setupExfat = document.getElementById("setup-drive-preflight-exfat");
  if (setupRestic) {
    setupRestic.textContent = preflight.restic ? "Restic: ready" : "Restic: missing";
    setupRestic.className = `preflight-item ${preflight.restic ? "ok" : "warn"}`;
  }
  if (setupUdisks) {
    const ok = preflight.udisksctl && preflight.lsblk;
    setupUdisks.textContent = ok ? "Disk tools: ready" : "Disk tools: missing";
    setupUdisks.className = `preflight-item ${ok ? "ok" : "warn"}`;
  }
  if (setupExfat) {
    const ok = preflight.udisksctl_format || (preflight.mkfs_exfat && preflight.pkexec);
    if (preflight.udisksctl_format) {
      setupExfat.textContent = "exFAT formatter: ready (udisksctl)";
    } else if (preflight.mkfs_exfat && preflight.pkexec) {
      setupExfat.textContent = "exFAT formatter: ready (pkexec)";
    } else if (preflight.mkfs_exfat) {
      setupExfat.textContent = "exFAT formatter: needs pkexec";
    } else {
      setupExfat.textContent = "exFAT formatter: missing";
    }
    setupExfat.className = `preflight-item ${ok ? "ok" : "warn"}`;
  }
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
  const canMount = agentOnline && preflight.udisksctl && preflight.lsblk;
  const canFormat =
    agentOnline &&
    (preflight.udisksctl_format || (preflight.mkfs_exfat && preflight.pkexec));
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
    if (!agentOnline) message = "Agent not connected.";
    else if (!hasSelection) message = "Select a partition to continue.";
    else if (wantsErase && !canFormat) message = "Formatting requires udisksctl or exFAT tools.";
    else if (!mounted && !canMount) message = "Mounting requires udisksctl.";
    else if (!canSetup) message = "Restic is missing.";
    else if (!mounted && !wantsErase) message = "Mount the drive or enable erase & format.";
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
  const canMount = agentOnline && preflight.udisksctl && preflight.lsblk;
  const canFormat =
    agentOnline &&
    (preflight.udisksctl_format || (preflight.mkfs_exfat && preflight.pkexec));
  const canSetup = agentOnline && preflight.restic;
  const wantsErase = !!eraseOption?.checked;

  if (mountButton) {
    mountButton.disabled = !hasSelection || !hasFilesystem;
    mountButton.title = !hasSelection
      ? "Select a partition to mount."
      : !hasFilesystem
      ? "No filesystem detected. Use erase & format first."
      : mounted
      ? "Already mounted."
      : !canMount
      ? "Mounting requires udisksctl + lsblk."
      : "Mount the selected partition.";
  }
  if (setupButton) {
    setupButton.disabled = !hasSelection;
    setupButton.title = !hasSelection
      ? "Select a partition to continue."
      : !canSetup
      ? "Restic is missing."
      : !hasFilesystem && !wantsErase
      ? "No filesystem detected. Enable erase & format."
      : !mounted && !canMount
      ? "Mounting requires udisksctl + lsblk."
      : wantsErase && !canFormat
      ? "Formatting requires udisksctl + exFAT tools."
      : "Set up this drive.";
  }

  if (status) {
    let message = "";
    if (!agentOnline) {
      message = "Agent not connected.";
    } else if (!hasSelection) {
      message = "Select a partition to continue.";
    } else if (wantsErase && !canFormat) {
      message = "Formatting requires udisksctl + exFAT tools.";
    } else if (!mounted && !canMount) {
      message = "Mounting requires udisksctl.";
    } else if (!canSetup) {
      message = "Restic is missing.";
    } else if (!mounted && !wantsErase) {
      message = "Mount the drive or enable erase & format.";
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
  if (quickVerify) quickVerify.checked = !!config.quick_verify;
  if (autoBackup) autoBackup.checked = !!config.auto_backup_on_insert;
  if (deepVerify) deepVerify.checked = !!config.deep_verify;
  if (remember) remember.checked = !!config.remember_passphrase;
  if (paranoid) paranoid.checked = !!config.paranoid_mode;
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

function validateWizardStep(step) {
  if (step === 1) {
    const passphrase = document.getElementById("passphrase").value;
    const confirm = document.getElementById("passphrase-confirm").value;
    if (!passphrase || passphrase !== confirm) {
      uiAlert("Passphrases do not match.");
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
    `Auto backup on insert: ${document.getElementById("auto-backup")?.checked ? "On" : "Off"}`,
    status.restic_available ? "Backup engine ready" : "Backup engine missing",
    status.drive.connected
      ? status.drive.mount_path
        ? "Drive detected"
        : `Drive detected${status.drive.devnode ? ` (${status.drive.devnode})` : ""} — mount to continue`
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
    uiAlert("Drive detected but not mounted. Please mount or format it first.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Restic is not available. Install or bundle restic first.");
    return;
  }

  const passphrase = document.getElementById("passphrase").value;
  const confirm = document.getElementById("passphrase-confirm").value;
  if (!passphrase || passphrase !== confirm) {
    uiAlert("Passphrases do not match.");
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
    return "System authorization required. A PolicyKit prompt should appear.";
  }
  return detail && detail.trim() ? detail.trim() : (forFormat ? "Format failed." : "Request failed.");
}

async function setupDriveFromSelectionForAddDrive() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert("Select a drive first.");
      return;
    }
    if (!preflight.restic) {
      uiAlert("Restic is missing. Check the preflight panel.");
      return;
    }
    const passphrase = document.getElementById("setup-drive-passphrase")?.value ?? "";
    const confirm = document.getElementById("setup-drive-passphrase-confirm")?.value ?? "";
    if (!passphrase || passphrase !== confirm) {
      uiAlert("Passphrases do not match.");
      return;
    }
    const eraseOption = document.getElementById("setup-drive-erase-option");
    const erasePhrase = document.getElementById("setup-drive-erase-phrase");
    const shouldErase = !!eraseOption?.checked;

    let mountPath = selection.mountpoint || null;
    let devnodeToMount = selection.partition.path;
    const wasWholeDisk = !!selection.partition._wholeDisk;

    if (shouldErase) {
      const canFormat =
        preflight.udisksctl_format || (preflight.mkfs_exfat && preflight.pkexec);
      if (!canFormat) {
        uiAlert(
          "Formatting requires udisksctl format support or mkfs.exfat + pkexec. Check the preflight panel."
        );
        return;
      }
      const confirmErase = (erasePhrase?.value || "").trim();
      if (confirmErase !== "ERASE") {
        uiAlert('Type "ERASE" to confirm formatting.');
        return;
      }
      const confirmMsg = wasWholeDisk
        ? "This will erase the whole disk and create a new partition. Continue?"
        : "This will erase all data on the selected partition. Continue?";
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
        await uiAlert("This partition has no filesystem. Enable erase & format to continue.");
        return;
      }

      if (!mountPath) {
        if (!preflight.udisksctl || !preflight.lsblk) {
          uiAlert("Mounting requires udisksctl and lsblk. Check the preflight panel.");
          return;
        }
        showLoadingOverlay("Mounting…");
        const mountRes = await fetch(`${API}/drives/mount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devnode: devnodeToMount }),
        });
        if (!mountRes.ok) {
          const detail = await mountRes.text();
          uiAlert(formatErrorMessage(detail, false), "Mount failed");
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
    uiAlert("Setup failed due to a connection error.");
  }
}

async function mountSelectedPartition() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert("Select a drive first.");
      return;
    }
    if (!preflight.udisksctl || !preflight.lsblk) {
      uiAlert("Mounting requires udisksctl and lsblk. Check the preflight panel.");
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
          ? "Mounting requires system authorization. A PolicyKit prompt should appear; if it does not, make sure a polkit agent is running."
          : "Mount failed. Check permissions and try again."
      );
      return;
    }
    await fetchStatus();
    await fetchDevices();
  } catch (err) {
    console.error(err);
    uiAlert("Mount failed due to a connection error.");
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
      uiAlert("Restic is missing. Check the preflight panel.");
      return false;
    }
    const eraseOption = document.getElementById("erase-option");
    const erasePhrase = document.getElementById("erase-phrase");
    const shouldErase = !!eraseOption?.checked;

    let mountPath = selection.mountpoint || null;
    let devnodeToMount = selection.partition.path;
    const wasWholeDisk = !!selection.partition._wholeDisk;

    if (shouldErase) {
      const canFormat =
        preflight.udisksctl_format || (preflight.mkfs_exfat && preflight.pkexec);
      if (!canFormat) {
        uiAlert(
          "Formatting requires udisksctl format support or mkfs.exfat + pkexec. Check the preflight panel."
        );
        return false;
      }
      const confirm = (erasePhrase?.value || "").trim();
      if (confirm !== "ERASE") {
        uiAlert('Type "ERASE" to confirm formatting.');
        return false;
      }
      const confirmMsg = wasWholeDisk
        ? "This will erase the whole disk and create a new partition. Continue?"
        : "This will erase all data on the selected partition. Continue?";
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
        await uiAlert("This partition has no filesystem. Enable erase & format to continue.");
        return false;
      }

      if (!mountPath) {
        if (!preflight.udisksctl || !preflight.lsblk) {
          uiAlert("Mounting requires udisksctl and lsblk. Check the preflight panel.");
          return false;
        }
        showLoadingOverlay("Mounting…");
        const mountRes = await fetch(`${API}/drives/mount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devnode: devnodeToMount }),
        });
        if (!mountRes.ok) {
          const detail = await mountRes.text();
          uiAlert(formatErrorMessage(detail, false), "Mount failed");
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
    uiAlert("Setup failed due to a connection error.");
    return false;
  }
}

async function startBackup() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("No trusted drive connected.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Restic is not available. Install or bundle restic first.");
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
    uiAlert("Backup could not be started.");
  }
}

async function loadSnapshots() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Connect a trusted drive to load snapshots.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Restic is not available. Install or bundle restic first.");
    return;
  }
  let payload = { drive_id: currentStatus.drive.drive_id, passphrase: null };
  let res = await fetch(`${API}/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to list snapshots.");
    if (!passphrase) return;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    uiAlert("Unable to load snapshots.");
    return;
  }

  const data = await res.json();
  const list = document.getElementById("snapshot-list");
  list.innerHTML = "";
  data.snapshots.forEach((snap) => {
    const item = document.createElement("div");
    item.className = "snapshot-item";
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "snapshot";
    radio.value = snap.id;
    radio.addEventListener("change", () => fetchSnapshotStats(snap.id));
    label.appendChild(radio);
    const span = document.createElement("span");
    span.textContent = `${new Date(snap.time).toLocaleString()} (${snap.id.slice(0, 8)})`;
    label.appendChild(span);
    item.appendChild(label);
    list.appendChild(item);
  });
}

async function restoreSnapshot() {
  const selected = document.querySelector("input[name='snapshot']:checked");
  if (!selected) {
    uiAlert("Select a snapshot first.");
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert("Restic is not available. Install or bundle restic first.");
    return;
  }
  const target = document.getElementById("restore-target").value;
  if (!target) {
    uiAlert("Choose a restore folder.");
    return;
  }
  if (!confirm("Restore files to a new folder? Aegis will not overwrite existing files.")) {
    return;
  }

  let payload = {
    drive_id: currentStatus.drive.drive_id,
    snapshot_id: selected.value,
    target_path: target,
    include_paths: [],
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
    uiAlert("Restore failed.");
  }
}

async function fetchSnapshotStats(snapshotId) {
  if (!snapshotId) return;
  const summary = document.getElementById("snapshot-summary");
  summary.textContent = "Loading snapshot details…";

  let payload = { drive_id: currentStatus.drive.drive_id, snapshot_id: snapshotId, passphrase: null };
  let res = await fetch(`${API}/snapshots/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const passphrase = await requestPassphrase("Enter your passphrase to view snapshot details.");
    if (!passphrase) return;
    payload.passphrase = passphrase;
    res = await fetch(`${API}/snapshots/stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    summary.textContent = "Unable to load snapshot details.";
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
    uiAlert("Eject failed.");
  }
}

async function exportRecoveryKit() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert("Connect a trusted drive to export a recovery kit.");
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
    uiAlert("Recovery kit export failed.");
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
          uiAlert("Folder picker is available in the desktop app. Type the path manually.");
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

  document.getElementById("save-settings").addEventListener("click", saveConfig);
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
    editFoldersCancel.addEventListener("click", () => {
      document.getElementById("edit-folders-overlay").classList.add("hidden");
      editFoldersPending = null;
    });
  }
  if (editFoldersSave) editFoldersSave.addEventListener("click", saveEditFolders);
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
