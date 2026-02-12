const API = "http://127.0.0.1:7878/v1";
let currentStatus = null;
let customSources = [];
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
let currentView = "dashboard";
const wizardSteps = Array.from(document.querySelectorAll(".wizard-step"));
const wizardProgress = document.getElementById("wizard-progress");
const wizardBack = document.getElementById("wizard-back");
const wizardNext = document.getElementById("wizard-next");
const wizardFinish = document.getElementById("run-first-backup");
const wizardSkip = document.getElementById("wizard-skip");
const topNav = document.getElementById("top-nav");
const browseFolder = document.getElementById("browse-folder");

function showView(id) {
  views.forEach((view) => {
    view.classList.toggle("hidden", view.id !== id);
  });
  navButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === id);
  });
  currentView = id;
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
  const running = !!status?.running;
  const canOperate = agentOnline && resticReady;

  setDisabled("run-first-backup", !canOperate || !trusted || running);
  setDisabled("backup-now", !canOperate || !trusted || running);
  setDisabled("restore-btn", !canOperate || !trusted);
  setDisabled("load-snapshots", !canOperate || !trusted);
  setDisabled("restore-run", !canOperate || !trusted);
  setDisabled("eject-btn", !agentOnline || !driveConnected);
  setDisabled("export-recovery", !agentOnline || !trusted);
  updateDeviceActions();
}

function renderBanner(status) {
  if (!agentOnline) {
    setBanner("alert", "Agent is not running. Start the Aegis agent to continue.");
    return;
  }
  if (status && !status.restic_available) {
    setBanner("warn", "Restic is not available. Install or bundle restic to enable backups.");
    return;
  }
  clearBanner();
}

function openModal({ title, body, mode }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalMode = mode;
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modalError.textContent = "";

    const needsPassphrase = mode === "passphrase";
    if (modalField) modalField.classList.toggle("hidden", !needsPassphrase);
    if (modalPassphrase) modalPassphrase.value = "";

    if (mode === "alert") {
      modalConfirm.textContent = "OK";
      modalCancel.classList.add("hidden");
    } else if (mode === "confirm") {
      modalConfirm.textContent = "Confirm";
      modalCancel.classList.remove("hidden");
    } else {
      modalConfirm.textContent = "Continue";
      modalCancel.classList.remove("hidden");
    }

    modalOverlay.classList.remove("hidden");
    setTimeout(() => {
      if (needsPassphrase) {
        modalPassphrase.focus();
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

function confirmModal() {
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

function renderStatus(status) {
  const driveStatus = document.getElementById("drive-status");
  const driveMeta = document.getElementById("drive-meta");
  const lastBackup = document.getElementById("last-backup");
  const lastResult = document.getElementById("last-result");
  const verifyStatus = document.getElementById("verify-status");
  const driveDetect = document.getElementById("drive-detect");
  const devnode = status.drive.devnode;

  if (status.drive.connected) {
    if (status.drive.trusted) {
      driveStatus.textContent = "Trusted drive connected";
      driveMeta.textContent = status.drive.label || "Ready for backup";
    } else {
      driveStatus.textContent = "Untrusted drive";
      driveMeta.textContent = status.drive.mount_path
        ? "Set up this drive in the wizard"
        : `Drive detected${devnode ? ` (${devnode})` : ""} but not mounted`;
    }
  } else {
    driveStatus.textContent = "Not connected";
    driveMeta.textContent = "Insert your trusted USB drive";
  }

  if (status.last_run) {
    lastBackup.textContent = new Date(status.last_run.started_epoch * 1000).toLocaleString();
    lastResult.textContent = status.last_run.message;
  } else {
    lastBackup.textContent = "Never";
    lastResult.textContent = "—";
  }

  verifyStatus.textContent = status.config.quick_verify ? "Quick verify enabled" : "Verification off";

  if (driveDetect) {
    if (!status.drive.connected) {
      driveDetect.textContent = "Waiting for drive…";
    } else if (status.drive.trusted) {
      driveDetect.textContent = "Trusted drive detected";
    } else if (!status.drive.mount_path) {
      driveDetect.textContent = `Drive detected${devnode ? ` (${devnode})` : ""} — select a drive below`;
    } else {
      driveDetect.textContent = "Drive detected";
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
}

function renderDevices() {
  const list = document.getElementById("device-list");
  const empty = document.getElementById("device-empty");
  const help = document.getElementById("device-help");
  const updated = document.getElementById("device-updated");
  if (!list || !empty) return;
  list.innerHTML = "";
  partitionIndex = new Map();
  if (updated) {
    updated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  }

  if (!deviceList.length) {
    empty.classList.remove("hidden");
    if (help) {
      help.textContent = "Insert a removable drive to continue.";
    }
    selectedPartitionPath = null;
    updateDeviceActions();
    return;
  }
  empty.classList.add("hidden");
  if (help) {
    help.textContent = "Select a partition to mount or set up.";
  }

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

    if (!device.partitions || device.partitions.length === 0) {
      const row = document.createElement("div");
      row.className = "partition-row";
      row.innerHTML = `<div></div><div class="partition-details"><div class="partition-title">No partitions found</div><div class="partition-subtitle">Create a partition before formatting.</div></div><div class="partition-status">—</div>`;
      card.appendChild(row);
      list.appendChild(card);
      return;
    }

    device.partitions.forEach((part) => {
      const mountpoint = part.mountpoints?.[0] || "";
      const subtitle = `${part.path} • ${part.size}`;
      const row = document.createElement("label");
      row.className = "partition-row";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "device-partition";
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
        }
      });
      const details = document.createElement("div");
      details.className = "partition-details";
      const title = document.createElement("div");
      title.className = "partition-title";
      title.textContent = device.removable ? `Partition ${part.name}` : `System drive partition`;
      const sub = document.createElement("div");
      sub.className = "partition-subtitle";
      sub.textContent = subtitle;
      details.appendChild(title);
      details.appendChild(sub);
      const status = document.createElement("div");
      status.className = "partition-status";
      if (!device.removable) {
        status.textContent = "Not selectable";
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
    list.appendChild(card);
  });

  if (!hasSelection && partitionIndex.size > 0) {
    const first = partitionIndex.keys().next().value;
    selectedPartitionPath = first;
  }
  if (selectedPartitionPath && !partitionIndex.has(selectedPartitionPath)) {
    selectedPartitionPath = partitionIndex.keys().next().value || null;
  }
  updateDeviceActions();
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
  if (erasePhrase) {
    erasePhrase.disabled = !hasSelection;
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
  if (document.getElementById("src-docs").checked) {
    sources.push({ label: "Documents", path: "~/Documents" });
  }
  if (document.getElementById("src-pics").checked) {
    sources.push({ label: "Pictures", path: "~/Pictures" });
  }
  if (document.getElementById("src-desktop").checked) {
    sources.push({ label: "Desktop", path: "~/Desktop" });
  }
  customSources.forEach((item) => sources.push(item));
  return sources;
}

function renderCustomSources() {
  const list = document.getElementById("custom-list");
  list.innerHTML = "";
  customSources.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "chip";
    li.textContent = item.label;
    li.onclick = () => {
      customSources.splice(index, 1);
      renderCustomSources();
    };
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
    label: document.getElementById("drive-label").value || null,
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
    uiAlert("Drive setup failed. Check the passphrase and try again.");
  }
}

async function setupDrive() {
  await setupDriveFromSelection();
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
      if (!await uiConfirm("This will erase all data on the selected partition. Continue?")) {
        return false;
      }
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
        uiAlert(
          detail === "authorization required"
            ? "Formatting requires system authorization. A PolicyKit prompt should appear; if it does not, make sure a polkit agent is running."
            : "Format failed. Check permissions and try again."
        );
        return false;
      }
      await fetchDevices();
      mountPath = null;
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
      const mountRes = await fetch(`${API}/drives/mount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devnode: selection.partition.path }),
      });
      if (!mountRes.ok) {
        const detail = await mountRes.text();
        uiAlert(
          detail === "authorization required"
            ? "Mounting requires system authorization. A PolicyKit prompt should appear; if it does not, make sure a polkit agent is running."
            : "Mount failed. Check permissions and try again."
        );
        return false;
      }
      const data = await mountRes.json();
      mountPath = data.mount_path;
      await fetchDevices();
      await fetchStatus();
    }

    await setupDriveWithMount(mountPath);
    return true;
  } catch (err) {
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
