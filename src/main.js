import "./style.css";

const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, reduce.matches ? Math.min(ms, 40) : ms));
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

/* ================= plug-in simulation ================= */
const FILES = [
  { path: "Documents/thesis-draft.docx", v: 1 },
  { path: "Documents/budget.xlsx", v: 1 },
  { path: "Pictures/hike-0412.jpg", v: 1 },
  { path: "Pictures/grandma-80th.jpg", v: 1 },
  { path: "Desktop/todo.txt", v: 1 },
];
const saved = new Map(); // path -> version last backed up
const snaps = [];
let plugged = false;
let run = 0; // increments to cancel an in-flight backup

const filesEl = $("files");
const statusEl = $("status");
const barEl = $("bar");
const usb = $("usb");
const port = $("port");
const usbLabel = $("usb-label");

function renderFiles() {
  filesEl.replaceChildren(
    ...FILES.map((f) => {
      const li = document.createElement("li");
      li.dataset.path = f.path;
      const dirty = saved.get(f.path) !== f.v;
      li.className = dirty ? "dirty" : "safe";
      li.innerHTML = `<span class="ic" aria-hidden="true"></span><span class="nm mono"></span><span class="st mono"></span>`;
      li.querySelector(".nm").textContent = f.path;
      li.querySelector(".st").textContent = dirty ? (saved.has(f.path) ? "changed" : "not backed up") : "backed up";
      return li;
    }),
  );
}

const rowOf = (path) => filesEl.querySelector(`li[data-path="${CSS.escape(path)}"]`);

async function scramble(li, myRun) {
  const nm = li.querySelector(".nm");
  const text = nm.textContent;
  li.className = "sending";
  li.querySelector(".st").textContent = "encrypting";
  const steps = reduce.matches ? 1 : 10;
  for (let i = 1; i <= steps; i++) {
    if (myRun !== run) return false;
    const keep = Math.floor(text.length * (1 - i / steps));
    nm.textContent = text.slice(0, keep) + hex(Math.ceil((text.length - keep) / 2)).slice(0, text.length - keep);
    await sleep(45);
  }
  nm.textContent = text;
  return true;
}

async function backup() {
  const myRun = ++run;
  const todo = FILES.filter((f) => saved.get(f.path) !== f.v);
  setStatus(todo.length ? `Drive connected · backing up ${todo.length} changed file${todo.length > 1 ? "s" : ""}` : "Drive connected · nothing changed");
  setBar(0);
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    const ok = await scramble(rowOf(f.path), myRun);
    if (!ok || myRun !== run) return;
    await sleep(160);
    if (myRun !== run) return;
    setBar((i + 1) / todo.length);
    const li = rowOf(f.path);
    li.className = "copied";
    li.querySelector(".st").textContent = "on drive";
  }
  setStatus("Verifying backup…");
  await sleep(600);
  if (myRun !== run) return;
  const versions = {};
  for (const f of todo) saved.set(f.path, f.v);
  for (const f of FILES) versions[f.path] = saved.get(f.path);
  snaps.unshift({ at: new Date(), copied: todo.length, versions });
  renderSnaps();
  renderFiles();
  setBar(1);
  setStatus(`Backed up · verified · ${todo.length} file${todo.length === 1 ? "" : "s"} copied`);
  $("steal").disabled = false;
  pulse(usb);
}

function setStatus(t) {
  statusEl.textContent = t;
}
function setBar(p) {
  barEl.style.transform = `scaleX(${p})`;
}
function pulse(el) {
  el.classList.remove("blink");
  void el.offsetWidth;
  el.classList.add("blink");
}

function renderSnaps() {
  const ol = $("snaps");
  if (!snaps.length) return;
  ol.replaceChildren(
    ...snaps.map((s, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-expanded", "false");
      const t = s.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      b.innerHTML = `<span class="mono"></span><span></span>`;
      b.firstChild.textContent = t;
      b.lastChild.textContent = i === snaps.length - 1 ? `first backup · ${s.copied} files` : `${s.copied} changed`;
      const ul = document.createElement("ul");
      ul.hidden = true;
      for (const [p, v] of Object.entries(s.versions)) {
        const x = document.createElement("li");
        x.className = "mono";
        x.textContent = `${p}  v${v}`;
        ul.appendChild(x);
      }
      b.addEventListener("click", () => {
        ul.hidden = !ul.hidden;
        b.setAttribute("aria-expanded", String(!ul.hidden));
      });
      li.append(b, ul);
      if (i === 0) li.classList.add("new");
      return li;
    }),
  );
}

/* plug / unplug */
function plugOffset() {
  const u = usb.querySelector(".plug").getBoundingClientRect();
  const p = port.getBoundingClientRect();
  const cur = new DOMMatrix(getComputedStyle(usb).transform);
  return {
    x: p.left + p.width / 2 - (u.left + u.width / 2) + cur.e,
    y: p.bottom - 6 - u.top + cur.f,
  };
}
function setPlugged(on) {
  if (on === plugged) return;
  plugged = on;
  usb.classList.toggle("in", on);
  port.classList.toggle("live", on);
  usbLabel.textContent = on ? "Unplug the drive" : "Plug in the drive";
  if (on) {
    const o = plugOffset();
    usb.style.transform = `translate(${o.x}px, ${o.y}px)`;
    backup();
  } else {
    usb.style.transform = "";
    const wasRunning = statusEl.textContent.startsWith("Drive connected · backing") || statusEl.textContent.startsWith("Verifying");
    run++;
    renderFiles();
    setBar(0);
    setStatus(wasRunning ? (snaps.length ? "Unplugged mid-backup · earlier backups untouched" : "Unplugged mid-backup · nothing damaged") : "Drive safely removed");
  }
}
window.addEventListener("resize", () => {
  if (!plugged) return;
  usb.style.transition = "none";
  usb.style.transform = "";
  const o = plugOffset();
  usb.style.transform = `translate(${o.x}px, ${o.y}px)`;
  requestAnimationFrame(() => (usb.style.transition = ""));
});

// Drag the drive to the port; a press without much movement toggles.
let drag = null;
usb.addEventListener("pointerdown", (e) => {
  if (plugged || e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, moved: false };
  usb.setPointerCapture(e.pointerId);
  usb.classList.add("dragging");
});
usb.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 6) drag.moved = true;
  usb.style.transform = `translate(${dx}px, ${dy}px)`;
  const u = usb.querySelector(".plug").getBoundingClientRect();
  const p = port.getBoundingClientRect();
  port.classList.toggle("near", Math.hypot(u.left + u.width / 2 - (p.left + p.width / 2), u.top - p.bottom) < 70);
});
function endDrag() {
  if (!drag) return;
  usb.classList.remove("dragging");
  const near = port.classList.contains("near");
  port.classList.remove("near");
  const moved = drag.moved;
  drag = null;
  if (near || !moved) setPlugged(true);
  else usb.style.transform = "";
  usb.dataset.skipClick = "1";
}
usb.addEventListener("pointerup", endDrag);
usb.addEventListener("pointercancel", () => {
  drag = null;
  usb.classList.remove("dragging");
  usb.style.transform = "";
});
usb.addEventListener("click", () => {
  if (usb.dataset.skipClick) return delete usb.dataset.skipClick;
  setPlugged(!plugged);
});

$("edit").addEventListener("click", () => {
  const f = FILES[Math.floor(Math.random() * FILES.length)];
  f.v++;
  renderFiles();
  const li = rowOf(f.path);
  li.querySelector(".st").textContent = `edited · v${f.v}`;
  pulse(li);
  if (plugged && !statusEl.textContent.startsWith("Drive connected · backing")) {
    setStatus("Changed a file · backing up again");
    setTimeout(() => plugged && backup(), 500);
  }
});

$("steal").addEventListener("click", () => {
  const peek = $("peek");
  peek.hidden = !peek.hidden;
  $("steal").textContent = peek.hidden ? "Look inside the drive" : "Hide drive contents";
  if (peek.hidden) return;
  const lines = [".aegis/drive.json        (no secrets)", "config", "keys/" + hex(32)];
  for (let i = 0; i < snaps.length; i++) lines.push("snapshots/" + hex(32));
  lines.push("index/" + hex(32));
  const packs = Math.max(2, Math.ceil(FILES.length / 2) + snaps.length);
  for (let i = 0; i < packs; i++) {
    const h = hex(32);
    lines.push(`data/${h.slice(0, 2)}/${h}`);
  }
  $("peek-body").textContent = lines.join("\n") + "\n\nNo file names. No contents. Only encrypted blobs in restic's format.";
});

renderFiles();

/* ================= Web Crypto illustration ================= */
const enc = new TextEncoder();
const dec = new TextDecoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
let sealed = null;

async function keyFrom(pass) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function seal() {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom($("pass").value);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode($("secret").value));
  sealed = { iv, ct };
  const h = toHex(iv) + toHex(ct);
  $("cipher").textContent = h.match(/.{1,32}/g).map((l) => l.match(/.{1,2}/g).join(" ")).join("\n");
  tryGuess();
}
async function tryGuess() {
  const g = $("guess").value;
  const v = $("verdict");
  if (!g || !sealed) {
    v.textContent = "";
    v.className = "verdict mono";
    return;
  }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, await keyFrom(g), sealed.ct);
    v.textContent = "✓ unlocked: " + dec.decode(pt).split("\n")[0];
    v.className = "verdict mono ok";
  } catch {
    v.textContent = "✗ wrong passphrase. Nothing readable.";
    v.className = "verdict mono bad";
  }
}
const debounce = (fn, ms) => {
  let t;
  return () => (clearTimeout(t), (t = setTimeout(fn, ms)));
};
$("secret").addEventListener("input", debounce(seal, 250));
$("pass").addEventListener("input", debounce(seal, 250));
$("guess").addEventListener("input", debounce(tryGuess, 250));
if (crypto.subtle) seal();
else $("cipher").textContent = "(Web Crypto needs a secure context)";

/* ================= demo video ================= */
const video = $("demo");
const play = $("play");
function syncPlay() {
  play.textContent = video.paused ? "▶" : "❚❚";
  play.setAttribute("aria-label", video.paused ? "Play demo video" : "Pause demo video");
  play.classList.toggle("on", !video.paused);
}
play.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
video.addEventListener("play", syncPlay);
video.addEventListener("pause", syncPlay);
if (!reduce.matches && "IntersectionObserver" in window) {
  new IntersectionObserver(
    ([en]) => {
      if (en.isIntersecting && video.paused && !video.dataset.userPaused) video.play().catch(() => {});
      else if (!en.isIntersecting && !video.paused) video.pause();
    },
    { threshold: 0.5 },
  ).observe(video);
  play.addEventListener("click", () => (video.dataset.userPaused = video.paused ? "" : "1"));
}

/* ================= download: real release, if one exists ================= */
const ua = navigator.userAgent;
const os = /Windows/.test(ua) ? ["win"] : /Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua) ? ["mac-arm", "mac-intel"] : /Linux/.test(ua) && !/Android/.test(ua) ? ["deb", "linux"] : [];
for (const k of os) document.querySelector(`tr[data-os="${k}"]`)?.classList.add("you");

const PATTERNS = {
  win: /x64-setup\.exe$/i,
  "mac-arm": /aarch64\.dmg$/i,
  "mac-intel": /x64\.dmg$/i,
  deb: /amd64\.deb$/i,
  linux: /amd64\.AppImage$/i,
};
fetch("https://api.github.com/repos/stcksmsh/aegis/releases?per_page=10", { headers: { Accept: "application/vnd.github+json" } })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((list) => {
    const rel = list.find((x) => !x.draft && !x.prerelease);
    if (!rel) return Promise.reject("none");
    const note = $("rel-note");
    note.textContent = "";
    const a = document.createElement("a");
    a.href = rel.html_url;
    a.textContent = rel.tag_name;
    note.append("Latest release: ", a, `, ${new Date(rel.published_at).toLocaleDateString()}. Everything Aegis needs is inside the installer.`);
    for (const [k, re] of Object.entries(PATTERNS)) {
      const asset = rel.assets.find((x) => re.test(x.name));
      const cell = document.querySelector(`tr[data-os="${k}"] td:last-child`);
      if (!asset || !cell) continue;
      const link = document.createElement("a");
      link.href = asset.browser_download_url;
      link.textContent = asset.name;
      cell.replaceChildren(link);
    }
  })
  .catch((status) => {
    if (status !== "none") return; // network/rate limit: keep the generic note
    $("rel-note").innerHTML =
      'The first release isn\'t published yet. Installers will appear on the <a href="https://github.com/stcksmsh/aegis/releases">releases page</a>; until then, build from source below.';
  });

/* ================= reveal on scroll ================= */
if (!reduce.matches && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (es) => es.forEach((en) => en.isIntersecting && (en.target.classList.add("in"), io.unobserve(en.target))),
    { threshold: 0.1 },
  );
  document.querySelectorAll(".band > *").forEach((c) => (c.classList.add("rv"), io.observe(c)));
}
