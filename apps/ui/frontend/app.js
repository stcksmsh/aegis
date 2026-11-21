const API = "http://127.0.0.1:7878/v1";

// Texts come from the agent (locales/*.json) in the chosen language; English fills any gap.
// Translations are plain text: always set with textContent, never innerHTML.
let STRINGS = {};
let LANG = "en";
function t(key, args = {}) {
  let s = STRINGS[key];
  if (typeof args.count === "number") {
    const form = new Intl.PluralRules(LANG).select(args.count);
    s = STRINGS[`${key}_${form}`] ?? STRINGS[`${key}_other`] ?? s;
  }
  if (s == null) s = key === "agent_offline" ? "Can't connect to Aegis right now. Try restarting the app." : key;
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in args ? String(args[name]) : m));
}
function applyStrings() {
  for (const [attr, target] of [["i18n", null], ["i18nPlaceholder", "placeholder"], ["i18nAria", "aria-label"], ["i18nTitle", "title"]]) {
    const sel = "[data-" + attr.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + "]";
    document.querySelectorAll(sel).forEach((el) => {
      const text = t(el.dataset[attr]);
      if (target) el.setAttribute(target, text);
      else el.textContent = text;
    });
  }
  document.documentElement.lang = LANG;
  // Someone who picked a language they can't read can still find this setting.
  const label = document.getElementById("language-label");
  if (label && LANG !== "en") label.textContent = `${t("language")} (Language)`;
}
async function loadStrings() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`${API}/i18n`);
      if (res.ok) {
        const data = await res.json();
        STRINGS = data.strings || {};
        LANG = data.lang || "en";
        break;
      }
    } catch (_) {
      /* agent still starting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  applyStrings();
}
const stringsReady = loadStrings();

// Theme: "system" (default), "light" or "dark", picked with the button in the top bar.
// Linux web views misreport the system setting, so the app is asked first.
const THEME_MODES = ["system", "light", "dark"];
const THEME_LABELS = {
  system: ["◐", "theme_match_system_click_to_ch"],
  light: ["☀", "theme_light_click_to_change"],
  dark: ["☾", "theme_dark_click_to_change"],
};
async function applyTheme() {
  const mode = localStorage.getItem("aegis-theme") || "system";
  let dark = mode === "dark";
  if (mode === "system") {
    const invoke = window.__TAURI__?.core?.invoke;
    const fromApp = invoke ? await invoke("system_dark").catch(() => null) : null;
    dark = fromApp ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const button = document.getElementById("theme-toggle");
  if (button) {
    const [icon, key] = THEME_LABELS[mode] || THEME_LABELS.system;
    const label = t(key);
    button.textContent = icon;
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}
stringsReady.then(applyTheme);
window.addEventListener("focus", applyTheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const mode = localStorage.getItem("aegis-theme") || "system";
  localStorage.setItem("aegis-theme", THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]);
  applyTheme();
});
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
  if (loadingMessage) loadingMessage.textContent = message || t("working");
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
  const idle = idleConnectedBackups(status);
  setDisabled("backup-now", !canOperate || idle.length === 0);
  const backupNow = document.getElementById("backup-now");
  if (backupNow && backupNow.dataset.busy !== "1") {
    backupNow.textContent = idle.length > 1 ? t("back_up_all") : t("back_up_now");
  }
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
    t("update_available", { version: event.payload });
  banner.classList.remove("hidden");
});
document.getElementById("update-install")?.addEventListener("click", async () => {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  const button = document.getElementById("update-install");
  button.disabled = true;
  button.textContent = t("installing");
  try {
    await invoke("install_update"); // restarts Aegis on success
  } catch (err) {
    uiAlert(String(err), t("update_not_installed"));
    button.disabled = false;
    button.textContent = t("install_and_restart");
  }
});

const BACKUP_STUCK_THRESHOLD_SEC = 30 * 60; // 30 minutes

function renderBanner(status) {
  if (!agentOnline) {
    setBanner("alert", t("agent_offline"));
    return;
  }
  if (status && !status.restic_available) {
    setBanner("warn", t("aegis_is_missing_a_part_it_nee"));
    return;
  }
  if (status?.running && status?.last_run?.started_epoch) {
    const elapsed = Math.floor(Date.now() / 1000) - status.last_run.started_epoch;
    if (elapsed >= BACKUP_STUCK_THRESHOLD_SEC) {
      setBanner("warn", t("backup_has_been_running_for_a"));
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
    const typeName = mode === "discontinue" || mode === "delete-backup";
    discontinueDrivePending = typeName && drive_id && drive_label ? { drive_id, drive_label } : null;
    renameDrivePending = mode === "rename-drive" && drive_id ? { drive_id, drive_label: drive_label || "" } : null;

    const needsPassphrase = mode === "passphrase";
    const needsDiscontinue = typeName;
    const needsRename = mode === "rename-drive";
    if (modalField) modalField.classList.toggle("hidden", !needsPassphrase);
    const discontinueField = document.getElementById("modal-discontinue-field");
    const discontinueInput = document.getElementById("modal-discontinue-input");
    const discontinueWipe = document.getElementById("modal-discontinue-wipe");
    if (discontinueField) {
      discontinueField.classList.toggle("hidden", !needsDiscontinue);
      discontinueField.classList.toggle("deleting", mode === "delete-backup");
    }
    if (discontinueInput) {
      discontinueInput.value = "";
      discontinueInput.placeholder = drive_label || "";
      document.getElementById("modal-discontinue-label").textContent = t("type_name_to_confirm", { name: drive_label });
    }
    if (discontinueWipe) discontinueWipe.checked = false;
    const renameField = document.getElementById("modal-rename-field");
    const renameInput = document.getElementById("modal-rename-input");
    if (renameField) renameField.classList.toggle("hidden", !needsRename);
    if (renameInput) {
      renameInput.value = renameDrivePending?.drive_label ?? "";
    }

    if (mode === "alert") {
      modalConfirm.textContent = t("ok");
      modalCancel.classList.add("hidden");
    } else if (mode === "confirm") {
      modalConfirm.textContent = confirmText || t("confirm");
      modalCancel.classList.remove("hidden");
    } else if (mode === "discontinue" || mode === "delete-backup") {
      modalConfirm.textContent = mode === "discontinue" ? t("forget") : t("delete_backup");
      modalCancel.classList.remove("hidden");
    } else if (mode === "rename-drive") {
      modalConfirm.textContent = t("save");
      modalCancel.classList.remove("hidden");
    } else {
      modalConfirm.textContent = t("continue");
      modalCancel.classList.remove("hidden");
    }

    // Risky actions use a red button, and Enter/Space start on Cancel.
    modalConfirm.classList.toggle("danger", !!danger || typeName);
    modalConfirm.classList.toggle("primary", !danger && !typeName);
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

// "Type ERASE to confirm": the English word always works, as does the translated one.
// Accents don't count, so OBRISI works for OBRIŠI.
function isEraseWord(value) {
  const fold = (s) => (s || "").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return fold(value) === "ERASE" || fold(value) === fold(t("erase_word"));
}

function uiAlert(message, title = t("notice")) {
  return openModal({ title, body: message, mode: "alert" });
}

function uiConfirm(message, title = t("confirm"), options = {}) {
  return openModal({ title, body: message, mode: "confirm", ...options });
}

let passphrasePrompt = null;

function requestPassphrase(message) {
  if (!passphrasePrompt) {
    modalPassphrase.value = "";
    // A "Restoring…" overlay would hide the prompt; bring it back once answered.
    const wasLoading = loadingOverlay && !loadingOverlay.classList.contains("hidden");
    if (wasLoading) loadingOverlay.classList.add("hidden");
    passphrasePrompt = openModal({ title: t("passphrase_required"), body: message, mode: "passphrase" })
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
      message = t("that_passphrase_didn_t_open_th");
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
      modalError.textContent = t("enter_your_passphrase");
      return;
    }
    modalPassphrase.value = "";
    closeModal(value);
    return;
  }
  if (modalMode === "discontinue" || modalMode === "delete-backup") {
    const deleting = modalMode === "delete-backup";
    const input = document.getElementById("modal-discontinue-input");
    const value = (input?.value ?? "").trim();
    if (!discontinueDrivePending) {
      closeModal(false);
      return;
    }
    if (value !== discontinueDrivePending.drive_label) {
      modalError.textContent = t("that_name_doesn_t_match_type_t");
      return;
    }
    modalError.textContent = "";
    const wipe = !deleting && (document.getElementById("modal-discontinue-wipe")?.checked ?? false);
    if (wipe) showLoadingOverlay(t("wiping_drive"));
    if (deleting) showLoadingOverlay(t("deleting_backup"));
    try {
      const res = await fetch(`${API}/drives/${deleting ? "delete-backup" : "discontinue"}`, {
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
        showToast(
          deleting
            ? t("the_backup_was_deleted_from_th")
            : t("this_computer_forgot_the_drive")
        );
      } else {
        const text = await res.text();
        modalError.textContent =
          text && text.trim() ? text.trim() : deleting ? t("couldn_t_delete_the_backup_ple") : t("couldn_t_forget_the_drive_plea");
      }
    } catch (err) {
      modalError.textContent = t("something_went_wrong_please_tr");
    } finally {
      if (wipe || deleting) hideLoadingOverlay();
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
      modalError.textContent = t("enter_a_name");
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
        modalError.textContent = text && text.trim() ? text.trim() : t("couldn_t_change_the_name_pleas");
      }
    } catch (err) {
      modalError.textContent = t("something_went_wrong_please_tr");
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
    // Check drive tools as soon as the agent answers, not 5 s later.
    if (!agentOnline) {
      agentOnline = true;
      fetchPreflight();
    }
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
  if (epoch == null) return t("never");
  const d = new Date(epoch * 1000);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return t("today");
  if (diffDays === 1) return t("yesterday");
  if (diffDays < 7) return t("days_ago", { count: diffDays });
  return d.toLocaleDateString(LANG);
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
        summaryText.textContent = t("backups_in_progress", { count: n });
      } else {
        summaryText.textContent = msg ? t("backup_in_progress_msg", { msg }) : t("backup_in_progress_dots");
      }
    } else if (total === 0) {
      summaryText.textContent = "";
    } else {
      // A drive can hold several backups, so count backups rather than drives.
      const conn = connected === 0 ? t("none_connected") : t("n_connected", { count: connected });
      summaryText.textContent = `${t("backups_set_up", { count: total })} · ${conn}`;
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
  let driveDetectText = t("waiting_for_drive");
  if (status.running && status.drive?.trusted) {
    driveDetectText = currentDriveRunning
      ? t("backing_up_to", { name: status.drive.label || t("drive") })
      : t("connected_other_backing_up", { name: status.drive.label || t("drive") });
  } else if (!status.drive?.connected) {
    driveDetectText = total === 0 ? "" : t("plug_in_your_aegis_drive_to_ba");
  } else if (status.drive.trusted) {
    driveDetectText = status.restic_available
      ? t("connected_ready", { name: status.drive.label || t("drive") })
      : t("name_connected", { name: status.drive.label || t("drive") });
  } else if (!status.drive.mount_path) {
    driveDetectText = t("a_usb_drive_is_plugged_in");
  } else {
    driveDetectText = t("a_usb_drive_is_plugged_in_that");
  }
  driveDetectEls.forEach((el) => { el.textContent = driveDetectText; });

  const driveSpaceEl = document.getElementById("dashboard-drive-space");
  if (driveSpaceEl) {
    const free = status.drive?.free_bytes;
    const totalBytes = status.drive?.total_bytes;
    if (status.drive?.connected && status.drive?.trusted && typeof free === "number" && typeof totalBytes === "number" && totalBytes > 0) {
      const almostFull = free < totalBytes * 0.1;
      driveSpaceEl.textContent = t("gb_free", { free: formatGB(free), total: formatGB(totalBytes) });
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
      ctaHint.textContent = t("ready_click_back_up", { name: label });
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
  }
  // Setup ends first_run while the wizard is up; it stays until the user leaves its last step.
  updateWizardSummary(status);
  renderBanner(status);
  updateActionState(status);
  applyFirstRunMode(status);
  renderBackupTargets(status.trusted_drives || [], status);
}

function formatWhen(epoch) {
  const day = formatLastBackup(epoch);
  const time = new Date(epoch * 1000).toLocaleTimeString(LANG, { hour: "2-digit", minute: "2-digit" });
  if (day === t("today")) return t("today_at", { time });
  if (day === t("yesterday")) return t("yesterday_at", { time });
  return day;
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
      ? t("last_backup_failed", { when, msg: run.message })
      : t("last_backup_finished", { when, msg: run.message });
  if (run.drive_almost_full) {
    text += " " + t("the_drive_is_almost_full_turn");
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
    const waiting = isDrivingBackingUp && /^Waiting/.test(progressMap[d.drive_id]?.message || "");
    if (isDrivingBackingUp) {
      statusBadge.className = "backup-target-badge backing-up";
      statusBadge.textContent = waiting ? t("waiting") : t("backing_up");
    } else {
      statusBadge.className = d.is_connected ? "backup-target-badge connected" : "backup-target-badge";
      statusBadge.textContent = d.is_connected ? t("connected") : t("not_connected");
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
      const msg = prog.message || t("backing_up_pct", { pct });
      summary.textContent = labels.length > 0 ? `${labels.join(", ")} · ${msg}` : msg;
    } else {
      summary.textContent = labels.length > 0 ? `${labels.join(", ")} · ${t("last_backup_when", { when: lastBackupStr })}` : t("last_backup_when", { when: lastBackupStr });
    }
    header.appendChild(summary);
    row.appendChild(header);
    if (isDrivingBackingUp && prog && !waiting) {
      const track = document.createElement("div");
      track.className = "backup-progress-track card-progress";
      const bar = document.createElement("div");
      bar.className = "backup-progress-bar";
      bar.style.width = `${Math.round((prog.percent_done || 0) * 100)}%`;
      track.appendChild(bar);
      row.appendChild(track);
    }
    if (d.is_connected) {
      const quick = document.createElement("div");
      quick.className = "backup-target-quick";
      const backupBtn = document.createElement("button");
      backupBtn.type = "button";
      backupBtn.className = "btn primary";
      backupBtn.textContent = t("back_up_now");
      backupBtn.disabled = isDrivingBackingUp;
      backupBtn.addEventListener("click", () => startBackup(d.drive_id));
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "btn secondary";
      restoreBtn.textContent = t("restore_dots");
      restoreBtn.addEventListener("click", () => {
        if (pickedInstanceId !== d.drive_id) {
          pickedInstanceId = d.drive_id;
          document.getElementById("snapshot-list").innerHTML = "";
          document.getElementById("snapshot-summary").textContent = "";
          browseTreeReset();
        }
        showView("restore");
        if (currentStatus) renderStatus(currentStatus);
      });
      quick.appendChild(backupBtn);
      quick.appendChild(restoreBtn);
      row.appendChild(quick);
    }

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
    renameBtn.textContent = t("rename");
    renameBtn.disabled = !canEdit;
    renameBtn.title = !d.is_connected ? t("connect_this_drive_to_change_i") : isDrivingBackingUp ? t("backup_in_progress") : "";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      openModal({
        title: t("rename"),
        body: t("change_the_name_aegis_shows_fo"),
        mode: "rename-drive",
        drive_id: d.drive_id,
        drive_label: d.label || "",
      });
    });
    const editFoldersBtn = document.createElement("button");
    editFoldersBtn.type = "button";
    editFoldersBtn.className = "btn ghost";
    editFoldersBtn.textContent = t("edit_folders");
    editFoldersBtn.disabled = !canEdit;
    editFoldersBtn.title = !d.is_connected ? t("connect_this_drive_to_change_f") : isDrivingBackingUp ? t("backup_in_progress") : "";
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
    discontinueBtn.textContent = t("forget_on_this_computer");
    discontinueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal({
        title: t("forget_this_drive_on_this_comp"),
        body:
          t("forget_body"),
        mode: "discontinue",
        drive_id: d.drive_id,
        drive_label: d.label || "",
      });
    });
    expanded.appendChild(discontinueBtn);
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn ghost backup-target-discontinue";
    deleteBtn.textContent = t("delete_from_drive");
    deleteBtn.disabled = !canEdit;
    deleteBtn.title = !d.is_connected ? t("connect_this_drive_to_delete_t") : isDrivingBackingUp ? t("backup_in_progress") : "";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      openModal({
        title: t("delete_from_drive_title", { name: d.label || t("this_backup") }),
        body: t("delete_from_drive_body"),
        mode: "delete-backup",
        drive_id: d.drive_id,
        drive_label: d.label || "",
      });
    });
    expanded.appendChild(deleteBtn);
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
  { label: t("documents"), path: "~/Documents" },
  { label: t("pictures"), path: "~/Pictures" },
  { label: t("desktop"), path: "~/Desktop" },
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
  if (title) title.textContent = `${t("edit_folders")} — ${editFoldersPending.drive_label || t("drive")}`;
  document.getElementById("edit-folders-error").textContent = "";
  document.getElementById("edit-folders-custom-label").value = "";
  document.getElementById("edit-folders-custom-path").value = "";
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
  renderFolderChips(document.getElementById("edit-folders-custom-list"), editFoldersCustomSources, renderEditFoldersCustomList);
}

async function saveEditFolders() {
  if (!editFoldersPending) return;
  addPendingFolders();
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
      const driveId = editFoldersPending.drive_id;
      const before = new Set((editFoldersPending.backup_sources || []).map((s) => s.path));
      const added = backup_sources.some((s) => !before.has(s.path));
      closeEditFoldersModal();
      await fetchStatus();
      // New folders aren't in any backup yet: back up now if the drive is here.
      const connected = (currentStatus?.trusted_drives || []).some((d) => d.drive_id === driveId && d.is_connected);
      if (added && connected) {
        showToast(t("folders_saved_backing_up_now_t"));
        startBackup(driveId);
      }
    } else {
      const text = await res.text();
      errEl.textContent = text && text.trim() ? text.trim() : t("couldn_t_update_folders_please");
    }
  } catch (err) {
    errEl.textContent = t("something_went_wrong_please_tr");
  }
}

// Native folder picker (desktop app). Returns the chosen path, or null.
async function pickFolder() {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (typeof invoke !== "function") {
    uiAlert(t("type_the_folder_location_in_th"));
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

// A folder picked or typed but not yet added with Add is added when the user moves on
// (Next, Set up, Save), so it isn't silently left out.
function addPendingFolders() {
  [
    [customSources, "custom-label", "custom-path", renderCustomSources],
    [setupDriveCustomSources, "setup-drive-custom-label", "setup-drive-custom-path", renderSetupDriveCustomSources],
    [editFoldersCustomSources, "edit-folders-custom-label", "edit-folders-custom-path", renderEditFoldersCustomList],
  ].forEach(([list, labelId, pathId, render]) => {
    if (document.getElementById(pathId)?.value.trim()) addCustomFolder(list, labelId, pathId, render);
  });
}

function folderName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || t("folder");
}

// "Add" next to a custom folder: the name defaults to the folder's own name.
function addCustomFolder(list, labelId, pathId, render) {
  const labelEl = document.getElementById(labelId);
  const pathEl = document.getElementById(pathId);
  const path = pathEl.value.trim();
  if (!path) {
    uiAlert(t("choose_a_folder_first"));
    return;
  }
  const label = labelEl.value.trim() || folderName(path);
  const clash = folderClash(list, label, path);
  if (clash) {
    uiAlert(clash, t("add_folder"));
    return;
  }
  list.push({ label, path });
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
    uiAlert(typeof err === "string" ? err : t("could_not_open_path"), t("open_folder"));
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
    if (help) help.textContent = t("plug_in_a_usb_drive");
    return false;
  }
  if (empty) empty.classList.add("hidden");
  if (help) help.textContent = t("choose_the_drive_to_back_up_to");

  let hasSelection = false;
  deviceList.forEach((device) => {
    const deviceTitle = `${device.model || t("usb_drive")} (${device.size})`;
    const deviceMeta = device.removable ? "" : t("this_computer_s_own_drive");
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
        ? t("can_t_be_used_for_backups")
        : severalParts
        ? t("part_of_drive", { n: partIndex + 1 })
        : t("whole_drive");
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
        status.textContent = t("needs_erasing_before_aegis_can");
        status.classList.add("warn");
      } else {
        status.textContent = mountpoint ? t("ready_to_use") : t("not_opened_yet");
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
    restic: preflight.restic ? "" : t("aegis_is_missing_a_part_it_nee"),
    udisks: preflight.can_mount
      ? ""
      : t("aegis_can_t_open_drives_by_its"),
    exfat: preflight.can_format
      ? ""
      : t("aegis_can_t_erase_drives_on_th"),
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
    if (!agentOnline) message = t("not_connected_to_aegis");
    else if (!hasSelection) message = t("choose_a_drive_to_continue");
    else if (wantsErase && !canFormat) message = t("aegis_can_t_erase_drives_on_th2");
    else if (!mounted && !canMount) message = t("aegis_can_t_open_drives_on_thi");
    else if (!canSetup) message = t("aegis_is_missing_a_part_it_nee");
    else if (!mounted && !wantsErase) message = t("click_open_drive_or_tick_erase");
    else if (wantsErase && !isEraseWord(erasePhrase?.value)) {
      message = t("type_erase_in_the_box_to_confi");
    } else message = t("ready_to_set_up_this_drive");
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
      ? t("choose_a_drive_to_open")
      : !hasFilesystem
      ? t("tick_erase_this_drive_first")
      : mounted
      ? t("already_open")
      : !canMount
      ? t("aegis_can_t_open_drives_on_thi")
      : t("open_the_selected_drive");
  }
  if (setupButton) {
    setupButton.disabled = !hasSelection;
    setupButton.title = !hasSelection
      ? t("choose_a_drive_to_continue")
      : !canSetup
      ? t("aegis_is_missing_a_part_it_nee")
      : !hasFilesystem && !wantsErase
      ? t("tick_erase_this_drive_first")
      : !mounted && !canMount
      ? t("aegis_can_t_open_drives_on_thi")
      : wantsErase && !canFormat
      ? t("aegis_can_t_erase_drives_on_th2")
      : t("set_up_this_drive2");
  }

  if (status) {
    let message = "";
    if (!agentOnline) {
      message = t("not_connected_to_aegis");
    } else if (!hasSelection) {
      message = t("choose_a_drive_to_continue");
    } else if (wantsErase && !canFormat) {
      message = t("aegis_can_t_erase_drives_on_th2");
    } else if (!mounted && !canMount) {
      message = t("aegis_can_t_open_drives_on_thi");
    } else if (!canSetup) {
      message = t("aegis_is_missing_a_part_it_nee");
    } else if (!mounted && !wantsErase) {
      message = t("click_open_drive_or_tick_erase");
    } else if (wantsErase && !isEraseWord(erasePhrase?.value)) {
      message = t("type_erase_in_the_box_to_confi");
    } else {
      message = t("ready_to_set_up_this_drive");
    }
    status.textContent = message;
  }
}

function applyFirstRunMode(status) {
  const inWizard = currentView === "wizard";
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
    wizardProgress.textContent = t("step_of", { n: wizardStep + 1, total: wizardSteps.length });
  }
  // The last step comes after the drive is set up: there's nothing to go back to.
  if (wizardBack) wizardBack.disabled = wizardStep === 0 || wizardStep === wizardSteps.length - 1;
  if (wizardNext) {
    wizardNext.classList.toggle("hidden", wizardStep === wizardSteps.length - 1);
    wizardNext.textContent = wizardStep === 2 ? t("set_up_this_drive") : t("next");
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
    return { score: 1, label: t("too_short") };
  }
  if (hasCommonWord) {
    return { score: 1, label: t("easy_to_guess") };
  }
  const long = value.length >= 20 || wordCount >= 4;
  const decent = value.length >= 12 || variety >= 3;
  if (long && (variety >= 2 || wordCount >= 4)) {
    return { score: 3, label: t("strong") };
  }
  if (decent) {
    return { score: 2, label: t("okay") };
  }
  return { score: 1, label: t("weak") };
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
      btn.textContent = showing ? t("show") : t("hide");
      btn.setAttribute("aria-label", showing ? t("show_passphrase") : t("hide_passphrase"));
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
    return t("passphrase_too_short", { n: MIN_PASSPHRASE_LENGTH });
  }
  if (passphrase !== confirm) {
    return t("passphrases_do_not_match");
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
  addPendingFolders();
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
    t("aegis_backs_up", { folders: sources.map((s) => s.label).join(", ") || t("nothing_yet_add_folders") }),
    auto
      ? t("backups_start_by_themselves_wh")
      : t("plug_in_the_drive_and_click_ba"),
    remember
      ? t("your_passphrase_is_remembered")
      : t("aegis_asks_for_your_passphrase"),
    t("to_get_files_back_use_restore"),
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
    sources.push({ label: t("documents"), path: "~/Documents" });
  }
  if (document.getElementById("src-pics")?.checked) {
    sources.push({ label: t("pictures"), path: "~/Pictures" });
  }
  if (document.getElementById("src-desktop")?.checked) {
    sources.push({ label: t("desktop"), path: "~/Desktop" });
  }
  customSources.forEach((item) => sources.push(item));
  return sources;
}

function buildSetupDriveBackupSources() {
  const sources = [];
  if (document.getElementById("setup-drive-src-docs")?.checked) {
    sources.push({ label: t("documents"), path: "~/Documents" });
  }
  if (document.getElementById("setup-drive-src-pics")?.checked) {
    sources.push({ label: t("pictures"), path: "~/Pictures" });
  }
  if (document.getElementById("setup-drive-src-desktop")?.checked) {
    sources.push({ label: t("desktop"), path: "~/Desktop" });
  }
  setupDriveCustomSources.forEach((item) => sources.push(item));
  return sources;
}

// Folder chips (wizard, Add backup, Edit folders): name · location, rename (✎) and remove (×).
function renderFolderChips(listEl, list, rerender) {
  if (!listEl) return;
  listEl.innerHTML = "";
  list.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "chip";
    const span = document.createElement("span");
    span.className = "chip-text";
    span.textContent = `${item.label} · ${item.path}`;
    span.title = item.path;
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "chip-remove chip-rename";
    renameBtn.textContent = "✎";
    renameBtn.title = t("rename");
    renameBtn.setAttribute("aria-label", t("rename_name", { name: item.label }));
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.className = "chip-input";
      input.value = item.label;
      input.setAttribute("aria-label", t("new_name_for", { name: item.label }));
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (save && name && name !== item.label) {
          const clash = folderClash(list, name, null, item);
          if (clash) uiAlert(clash, t("rename_folder"));
          else item.label = name;
        }
        rerender();
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
      span.replaceWith(input);
      renameBtn.remove();
      input.focus();
      input.select();
    });
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.setAttribute("aria-label", t("remove_name", { name: item.label }));
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      list.splice(index, 1);
      rerender();
    });
    li.appendChild(span);
    li.appendChild(renameBtn);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
  });
}

// Why a folder can't be added (or renamed) to `list`, or null. Default folders count as taken.
function folderClash(list, label, path, skip) {
  const norm = (p) => (p || "").trim().replace(/[\\/]+$/, "");
  const taken = [...DEFAULT_SOURCES, ...list].filter((s) => s !== skip);
  if (path && taken.some((s) => norm(s.path) === norm(path))) return t("that_folder_is_already_in_the");
  if (taken.some((s) => s.label.toLowerCase() === label.toLowerCase()))
    return t("folder_name_taken", { name: label });
  return null;
}

function renderSetupDriveCustomSources() {
  renderFolderChips(document.getElementById("setup-drive-custom-list"), setupDriveCustomSources, renderSetupDriveCustomSources);
}

function renderCustomSources() {
  renderFolderChips(document.getElementById("custom-list"), customSources, () => {
    renderCustomSources();
    updateWizardSummary(currentStatus || { drive: { connected: false } });
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
      uiAlert((await res.text()).trim() || t("couldn_t_save_settings_please"));
      return false;
    }
    currentStatus = await res.json();
    if (currentStatus.config?.paranoid_mode) sessionPassphrase = null;
    configFormsFilled = false;
    renderStatus(currentStatus);
    const note = savedNoteId && document.getElementById(savedNoteId);
    if (note) {
      note.textContent = t("saved");
      setTimeout(() => { note.textContent = ""; }, 4000);
    }
    return true;
  } catch (_) {
    uiAlert(t("agent_offline"));
    return false;
  }
}

// After "Add backup" opened a backup that other computers already use (e.g. a handover):
// show their folders so the user can pick the matching ones on this computer.
function showHandoverInfo(data) {
  if (data?.joined) {
    const name = (currentStatus?.trusted_drives || []).find((d) => d.drive_id === data.drive_id)?.label || t("your_backup");
    // Back up right away, so the added folders are in a backup.
    startBackup(data.drive_id);
    uiAlert(
      t("joined_body", { name }),
      t("added_to_an_existing_backup")
    );
    return;
  }
  if (!data?.existing) {
    // A new backup: offer the sheet once, while the passphrase is fresh in mind.
    uiConfirm(t("sheet_offer_body"), t("print_passphrase_sheet"), {
      confirmText: t("print_passphrase_sheet"),
    }).then((yes) => yes && openPassphraseSheet(data.drive_id));
    return;
  }
  if (!(data.previous_computers || []).length) return;
  const lines = data.previous_computers.map(
    (c) =>
      `• ${t("computer_last_backup", { host: c.host || t("unknown_computer"), date: new Date(c.last_backup).toLocaleDateString(LANG) })}:\n    ` +
      c.folders.join("\n    ")
  );
  uiAlert(
    t("handover_body", { folders: lines.join("\n") }),
    t("continuing_an_existing_backup")
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
    const { html } = await res.json();
    // Shown and printed inside Aegis: opening an .html file depends on whatever app the
    // desktop has picked for it.
    document.getElementById("sheet-frame").srcdoc = html;
    document.getElementById("sheet-overlay").classList.remove("hidden");
    setBackgroundInert(true);
    document.getElementById("sheet-print").focus();
  } catch (err) {
    console.error(err);
    uiAlert(t("couldn_t_open_the_passphrase_s"));
  }
}

function closePassphraseSheet() {
  document.getElementById("sheet-overlay").classList.add("hidden");
  document.getElementById("sheet-frame").srcdoc = "";
  setBackgroundInert(false);
}

document.getElementById("sheet-close").addEventListener("click", closePassphraseSheet);
document.getElementById("sheet-print").addEventListener("click", () =>
  document.getElementById("sheet-frame").contentWindow?.print()
);
document.getElementById("sheet-overlay").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePassphraseSheet();
});

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
    t("separate_backup_body"),
    t("create_a_separate_backup"),
    { confirmText: t("create_separate_backup"), focusCancel: true }
  );
  if (!ok) return null;
  showLoadingOverlay(t("setting_up_drive"));
  return send({ ...payload, new_instance: true });
}

// Returns true only when the drive was set up.
async function setupDriveWithMount(mountPath) {
  if (!mountPath) {
    uiAlert(t("the_drive_isn_t_open_yet_click"));
    return false;
  }
  if (!currentStatus?.restic_available) {
    uiAlert(t("aegis_is_missing_a_part_it_nee"));
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
    detail && detail.trim() ? detail.trim() : t("drive_setup_failed_check_the_p"),
    t("setup_failed")
  );
  return false;
}

function formatErrorMessage(detail, forFormat) {
  const lower = (detail || "").toLowerCase();
  if (lower.includes("authorization") || lower.includes("not authorized")) {
    return t("aegis_needs_your_computer_s_pa");
  }
  return detail && detail.trim() ? detail.trim() : (forFormat ? t("formatting_failed") : t("something_went_wrong_please_tr"));
}

async function setupDriveFromSelectionForAddDrive() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert(t("choose_a_drive_first"));
      return;
    }
    if (!preflight.restic) {
      uiAlert(t("aegis_is_missing_a_part_it_nee"));
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
          t("aegis_can_t_erase_drives_on_th3")
        );
        return;
      }
      const confirmErase = (erasePhrase?.value || "").trim();
      if (!isEraseWord(confirmErase)) {
        uiAlert(t("type_erase_in_the_box_to_confi"));
        return;
      }
      const confirmMsg =
        t("erase_confirm", { name: `${selection.device.model || t("usb_drive")} (${selection.device.size})` });
      if (!(await uiConfirm(confirmMsg, t("erase_drive"), { confirmText: t("erase_drive"), danger: true, focusCancel: true }))) {
        return;
      }
    }

    showLoadingOverlay(t("preparing"));

    try {
      if (shouldErase) {
        showLoadingOverlay(t("erasing_drive"));
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
          uiAlert(formatErrorMessage(detail, true), t("format_failed"));
          return;
        }
        showLoadingOverlay(t("refreshing_device_list"));
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
        await uiAlert(t("this_drive_needs_erasing_first"));
        return;
      }

      if (!mountPath) {
        if (!preflight.can_mount) {
          uiAlert(t("aegis_can_t_open_drives_on_thi"));
          return;
        }
        showLoadingOverlay(t("opening_drive"));
        const mountRes = await fetch(`${API}/drives/mount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devnode: devnodeToMount }),
        });
        if (!mountRes.ok) {
          const detail = await mountRes.text();
          uiAlert(formatErrorMessage(detail, false), t("couldn_t_open_the_drive"));
          return;
        }
        const data = await mountRes.json();
        mountPath = data.mount_path;
        await fetchDevices();
        await fetchStatus();
      }

    addPendingFolders();
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

    showLoadingOverlay(t("setting_up_drive"));
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
      uiAlert(formatErrorMessage(detail, false) || t("drive_setup_failed_check_the_p"), t("setup_failed"));
    }
    } finally {
      hideLoadingOverlay();
    }
  } catch (err) {
    hideLoadingOverlay();
    console.error(err);
    uiAlert(t("setup_failed_check_your_connec"));
  }
}

async function mountSelectedPartition() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert(t("choose_a_drive_first"));
      return;
    }
    if (!preflight.can_mount) {
      uiAlert(t("aegis_can_t_open_drives_on_thi"));
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
          ? t("aegis_needs_your_computer_s_pa")
          : detail.trim() || t("couldn_t_open_the_drive_unplug")
      );
      return;
    }
    await fetchStatus();
    await fetchDevices();
  } catch (err) {
    console.error(err);
    uiAlert(t("couldn_t_open_the_drive_due_to"));
  }
}

async function setupDriveFromSelection() {
  try {
    const selection = getSelectedPartition();
    if (!selection) {
      uiAlert(t("choose_a_drive_first"));
      return false;
    }
    if (!preflight.restic) {
      uiAlert(t("aegis_is_missing_a_part_it_nee"));
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
          t("aegis_can_t_erase_drives_on_th3")
        );
        return false;
      }
      const confirm = (erasePhrase?.value || "").trim();
      if (!isEraseWord(confirm)) {
        uiAlert(t("type_erase_in_the_box_to_confi"));
        return false;
      }
      const confirmMsg =
        t("erase_confirm", { name: `${selection.device.model || t("usb_drive")} (${selection.device.size})` });
      if (!(await uiConfirm(confirmMsg, t("erase_drive"), { confirmText: t("erase_drive"), danger: true, focusCancel: true }))) {
        return false;
      }
    }

    showLoadingOverlay(t("preparing"));

    try {
      if (shouldErase) {
        showLoadingOverlay(t("erasing_drive"));
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
          uiAlert(formatErrorMessage(detail, true), t("format_failed"));
          return false;
        }
        showLoadingOverlay(t("refreshing_device_list"));
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
        await uiAlert(t("this_drive_needs_erasing_first"));
        return false;
      }

      if (!mountPath) {
        if (!preflight.can_mount) {
          uiAlert(t("aegis_can_t_open_drives_on_thi"));
          return false;
        }
        showLoadingOverlay(t("opening_drive"));
        const mountRes = await fetch(`${API}/drives/mount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devnode: devnodeToMount }),
        });
        if (!mountRes.ok) {
          const detail = await mountRes.text();
          uiAlert(formatErrorMessage(detail, false), t("couldn_t_open_the_drive"));
          return false;
        }
        const data = await mountRes.json();
        mountPath = data.mount_path;
        await fetchDevices();
        await fetchStatus();
      }

      showLoadingOverlay(t("setting_up_drive"));
      return await setupDriveWithMount(mountPath);
    } finally {
      hideLoadingOverlay();
    }
  } catch (err) {
    hideLoadingOverlay();
    console.error(err);
    uiAlert(t("setup_failed_check_your_connec"));
    return false;
  }
}

// Backups on the plugged-in drive that could start now (set up here, not already running).
function idleConnectedBackups(status = currentStatus) {
  const running = status?.running_drive_ids || [];
  const trusted = status?.trusted_drives || [];
  return (status?.drive?.instance_ids || []).filter(
    (id) => trusted.some((d) => d.drive_id === id) && !running.includes(id)
  );
}

// One backup (from its card), or every idle backup on the plugged-in drive. Backups on the
// same drive run one after another; the agent queues them.
async function startBackup(driveId) {
  const ids = typeof driveId === "string" ? [driveId] : idleConnectedBackups();
  if (!ids.length) {
    uiAlert(t("connect_your_aegis_drive_first"));
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert(t("aegis_is_missing_a_part_it_nee"));
    return;
  }
  for (const id of ids) {
    const name = (currentStatus?.trusted_drives || []).find((d) => d.drive_id === id)?.label || t("this_backup");
    const result = await postWithPassphrase(
      "/backup/run",
      { drive_id: id },
      ids.length > 1 || typeof driveId === "string"
        ? t("enter_passphrase_for", { name })
        : t("enter_your_passphrase_to_start"),
      { verifies: false }
    );
    if (!result) return;
    if (!result.res.ok) {
      uiAlert(result.detail || t("couldn_t_start_the_backup_plea"), t("backup_not_started"));
    }
  }
}

async function loadSnapshots() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert(t("connect_your_aegis_drive_to_se"));
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert(t("aegis_is_missing_a_part_it_nee"));
    return;
  }
  const result = await postWithPassphrase(
    "/snapshots",
    { drive_id: currentStatus.drive.drive_id },
    t("enter_your_passphrase_to_see_y")
  );
  if (!result) return;
  if (!result.res.ok) {
    uiAlert(result.detail || t("couldn_t_load_your_backups_ple"));
    return;
  }

  const data = await result.res.json();
  const list = document.getElementById("snapshot-list");
  list.innerHTML = "";
  browseTreeReset();
  if (!data.snapshots || data.snapshots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = t("no_backups_on_this_drive_yet");
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
    span.textContent = t("backup_from", { date: new Date(snap.time).toLocaleString(LANG) }) +
      (severalComputers && snap.hostname ? ` · ${t("computer_name", { name: snap.hostname })}` : "");
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
    t("enter_your_passphrase_to_brows")
  );
  if (!result) return null;
  if (!result.res.ok) {
    uiAlert(result.detail || t("couldn_t_read_the_contents_of"));
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
  loading.textContent = t("loading");
  listEl.appendChild(loading);
  const entries = await fetchBrowseEntries(browseSnapshotId, path);
  listEl.innerHTML = "";
  if (!entries) return;
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = t("nothing_here");
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
    toggle.setAttribute("aria-label", t("show_contents_of", { name: entry.name }));
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
    uiAlert(t("select_a_backup_first"));
    return;
  }
  if (!currentStatus?.restic_available) {
    uiAlert(t("aegis_is_missing_a_part_it_nee"));
    return;
  }
  const target = document.getElementById("restore-target").value;
  if (!target) {
    uiAlert(t("choose_a_restore_folder"));
    return;
  }
  if (!(await uiConfirm(confirmMessage, t("restore_files")))) {
    return;
  }

  showLoadingOverlay(t("restoring_your_files_this_can"));
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
      t("enter_your_passphrase_to_resto")
    );
    hideLoadingOverlay();
    if (!result) return;
    if (!result.res.ok) {
      uiAlert(
        result.detail || t("restore_failed_please_try_agai"),
        result.res.status === 409 ? t("restore_stopped") : t("restore_failed")
      );
      return;
    }
  } catch (_) {
    hideLoadingOverlay();
    uiAlert(t("agent_offline"), t("restore_failed"));
    return;
  } finally {
    stop?.classList.add("hidden");
  }
  await uiAlert(t("restore_done", { folder: target }), t("restore_complete"));
  openFolderPath(target);
}

function restoreSnapshot() {
  return runRestore([], t("restore_all_files_to_a_new_fol"));
}

function restoreSelected() {
  if (browseSelectedPaths.size === 0) {
    uiAlert(t("check_at_least_one_file_or_fol"));
    return;
  }
  return runRestore(
    Array.from(browseSelectedPaths),
    t("restore_the_checked_files_to_a")
  );
}

async function fetchSnapshotStats(snapshotId) {
  if (!snapshotId) return;
  const summary = document.getElementById("snapshot-summary");
  summary.textContent = t("loading_backup_details");

  const result = await postWithPassphrase(
    "/snapshots/stats",
    { drive_id: currentStatus.drive.drive_id, snapshot_id: snapshotId },
    t("enter_your_passphrase_to_view")
  );
  if (!result || !result.res.ok) {
    summary.textContent = t("couldn_t_load_backup_details");
    return;
  }

  const stats = await result.res.json();
  summary.textContent = t("files_size", { files: stats.total_file_count.toLocaleString(LANG), size: formatBytes(stats.total_size) });
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
    uiAlert(t("no_drive_to_eject"));
    return;
  }
  if (!(await uiConfirm(t("eject_the_drive_now"), t("eject_drive")))) return;
  const res = await fetch(`${API}/drives/eject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mount_path: currentStatus.drive.mount_path }),
  });
  if (res.ok) {
    showToast(t("it_s_now_safe_to_unplug_the_dr"));
  } else {
    uiAlert((await res.text()).trim() || t("couldn_t_eject_the_drive_pleas"));
  }
}

async function exportRecoveryKit() {
  if (!currentStatus?.drive?.drive_id) {
    uiAlert(t("plug_in_your_aegis_drive_first"));
    return;
  }
  const destination = document.getElementById("recovery-destination").value.trim();
  if (!destination) {
    uiAlert(t("choose_a_folder_to_save_the_dr"));
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
    showToast(t("drive_details_saved_keep_them"));
  } else {
    uiAlert(t("couldn_t_save_the_drive_detail"));
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
  const editFoldersAdd = () =>
    addCustomFolder(editFoldersCustomSources, "edit-folders-custom-label", "edit-folders-custom-path", renderEditFoldersCustomList);
  document.getElementById("edit-folders-add-custom").addEventListener("click", editFoldersAdd);
  // Browse… fills in the location (and the name, if empty); Add adds it.
  [
    ["browse-folder", "custom-path", "custom-label", "add-custom"],
    ["setup-drive-browse", "setup-drive-custom-path", "setup-drive-custom-label", "setup-drive-add-custom"],
    ["edit-folders-browse", "edit-folders-custom-path", "edit-folders-custom-label", "edit-folders-add-custom"],
  ].forEach(([buttonId, pathId, labelId, addId]) => {
    document.getElementById(buttonId).addEventListener("click", async () => {
      const path = await pickFolder();
      if (!path) return;
      document.getElementById(pathId).value = path;
      const labelEl = document.getElementById(labelId);
      if (!labelEl.value.trim()) labelEl.value = folderName(path);
      document.getElementById(addId).focus();
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
    if (!(await saveConfig(wizardPayload()))) return;
    wizardDismissed = true;
    showView("dashboard");
    applyFirstRunMode(currentStatus);
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

  document.getElementById("backup-now").addEventListener("click", () =>
    withBusy("backup-now", t("starting"), () => startBackup())
  );
  document.getElementById("restore-btn").addEventListener("click", () => showView("restore"));
  document.getElementById("eject-btn").addEventListener("click", () =>
    withBusy("eject-btn", t("ejecting"), ejectDrive)
  );

  document.getElementById("load-snapshots").addEventListener("click", () =>
    withBusy("load-snapshots", t("loading_backups"), loadSnapshots)
  );
  document.getElementById("restore-run").addEventListener("click", restoreSnapshot);
  document.getElementById("restore-selected-run").addEventListener("click", restoreSelected);

  document.getElementById("save-settings").addEventListener("click", () =>
    withBusy("save-settings", t("saving"), () => saveConfig(settingsPayload(), "settings-saved"))
  );
  initAutostartToggle();
  document.getElementById("save-advanced").addEventListener("click", () =>
    withBusy("save-advanced", t("saving"), () => saveConfig(advancedPayload(), "advanced-saved"))
  );
  document.getElementById("export-recovery").addEventListener("click", () =>
    withBusy("export-recovery", t("saving"), exportRecoveryKit)
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
  if (editFoldersCancel) {
    editFoldersCancel.addEventListener("click", closeEditFoldersModal);
  }
  if (editFoldersSave) {
    editFoldersSave.addEventListener("click", () => withBusy("edit-folders-save", t("saving"), saveEditFolders));
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
stringsReady.then(() => {
  const view = sessionStorage.getItem("aegis-view");
  if (view) {
    sessionStorage.removeItem("aegis-view");
    showView(view);
  }
  fetchStatus();
  fetchDevices();
  fetchPreflight();
  setInterval(fetchStatus, 1500);
  setInterval(fetchDevices, 1500);
  setInterval(fetchPreflight, 5000);
});

// Language: saved right away; the page reloads to show every text in the new language.
(() => {
  const select = document.getElementById("language");
  if (!select) return;
  stringsReady.then(async () => {
    try {
      const res = await fetch(`${API}/status`);
      if (res.ok) select.value = (await res.json()).config?.language || "system";
    } catch (_) {
      /* stays on "system" */
    }
  });
  select.addEventListener("change", async () => {
    try {
      const res = await fetch(`${API}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: select.value }),
      });
      if (!res.ok) throw new Error(await res.text());
      sessionStorage.setItem("aegis-view", "settings");
      location.reload();
    } catch (_) {
      uiAlert(t("couldn_t_save_settings_please"));
    }
  });
})();

// "Start at login" lives in the desktop shell, not the agent config; applies immediately.
function initAutostartToggle() {
  const box = document.getElementById("autostart");
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!box || !invoke) return;
  invoke("get_autostart").then((on) => (box.checked = !!on)).catch(() => {});
  box.addEventListener("change", () => {
    invoke("set_autostart", { enabled: box.checked }).catch(() => {
      box.checked = !box.checked;
      uiAlert(t("couldn_t_change_the_login_sett"));
    });
  });
}
