// Drives the real Aegis screens (served from the repo, talking to a scratch agent) and
// records a screencast: frames/<n>.jpg + frames/times.json.
const puppeteer = require("puppeteer-core");
const fs = require("fs");

const OUT = process.env.DEMO_DIR + "/frames";
const PAGE = "file://" + process.env.REPO + "/apps/ui/frontend/index.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    userDataDir: process.env.DEMO_DIR + "/chrome",
    args: ["--no-sandbox", "--disable-web-security", "--force-dark-mode", "--hide-scrollbars",
      "--window-size=1100,760"],
    defaultViewport: { width: 1100, height: 760, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // A visible mouse pointer that follows Puppeteer's mouse.
  await page.evaluateOnNewDocument(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const c = document.createElement("div");
      c.style.cssText =
        "position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;pointer-events:none;" +
        "transform:translate(-100px,-100px);transition:none";
      c.innerHTML =
        '<svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1 L1 17 L5 13 L8 20 L11 19 L8 12 L14 12 Z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>';
      document.body.appendChild(c);
      document.addEventListener("mousemove", (e) => {
        c.style.transform = `translate(${e.clientX - 1}px,${e.clientY - 1}px)`;
      }, true);
    });
  });

  const frames = [];
  const cdp = await page.createCDPSession();
  cdp.on("Page.screencastFrame", async (f) => {
    const n = frames.length;
    fs.writeFileSync(`${OUT}/${String(n).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64"));
    frames.push(f.metadata.timestamp);
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });

  let mouse = { x: 550, y: 380 };
  async function moveTo(sel) {
    const el = await page.waitForSelector(sel, { visible: true, timeout: 60000 });
    await el.scrollIntoView();
    await sleep(250);
    const b = await el.boundingBox();
    const x = b.x + Math.min(b.width / 2, 40), y = b.y + b.height / 2;
    await page.mouse.move(x, y, { steps: 18 });
    mouse = { x, y };
    return el;
  }
  async function click(sel, pause = 500) {
    await moveTo(sel);
    await sleep(200);
    await page.mouse.click(mouse.x, mouse.y);
    await sleep(pause);
  }
  async function type(sel, text) {
    await click(sel, 150);
    await page.keyboard.type(text, { delay: 45 });
    await sleep(300);
  }
  const visible = (sel) => page.$eval(sel, (e) => !e.closest(".hidden") && e.offsetParent !== null).catch(() => false);
  async function answerPassphrase() {
    if (await visible("#modal-passphrase")) {
      await type("#modal-passphrase", PASS);
      await click("#modal-confirm", 800);
    }
  }
  const PASS = "maple-orbit-candle-river";

  await page.goto(PAGE);
  await page.waitForSelector("#wizard:not(.hidden)", { timeout: 30000 });
  await page.mouse.move(mouse.x, mouse.y);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });
  await sleep(2200);

  // 1. Folders (defaults), 2. passphrase.
  await click("#wizard-next", 900);
  await type("#passphrase", PASS);
  await type("#passphrase-confirm", PASS);
  await sleep(700);
  await click("#wizard-next", 900);

  // 3. The USB drive, with a name.
  await moveTo(".partition-row");
  await sleep(600);
  await type("#drive-label", "Family backup");
  await click("#wizard-next", 400);
  await page.waitForSelector("#run-first-backup:not(.hidden)", { visible: true, timeout: 60000 });
  await sleep(1800);

  // The passphrase sheet is offered once: not now.
  await page.waitForSelector("#modal-overlay:not(.hidden)", { visible: true, timeout: 30000 });
  await sleep(2600);
  await click("#modal-cancel", 900);

  // 4. First backup.
  await click("#run-first-backup", 500);
  await answerPassphrase();
  await page.waitForFunction(() => {
    const el = document.getElementById("last-run-line");
    return el && !el.classList.contains("hidden") && el.textContent.length > 0;
  }, { timeout: 120000 });
  await sleep(2800);

  // Restore two files.
  await click('.nav-btn[data-view="restore"]', 700);
  await click("#load-snapshots", 600);
  await answerPassphrase();
  await click(".snapshot-item input", 900);
  for (const name of ["Documents"]) {
    const sel = `xpath///li[contains(@class,"browse-node")]/div[label[text()="${name}"]]/button`;
    const found = await page.waitForSelector(sel, { visible: true, timeout: 20000 }).catch(() => null);
    if (found) await click(sel, 700);
  }
  for (const f of ["Letter to Ana.txt", "Budget 2026.txt"]) {
    await click(`xpath///label[text()="${f}"]`, 400);
  }
  await type("#restore-target", "/home/ana/Restored");
  await click("#restore-selected-run", 700);
  await click("#modal-confirm", 600);
  await answerPassphrase();
  await page.waitForFunction(() => document.getElementById("modal-title")?.textContent.length > 0 &&
    !document.getElementById("modal-overlay").classList.contains("hidden") &&
    document.getElementById("modal-cancel").classList.contains("hidden"), { timeout: 60000 });
  await sleep(3500);
  await click("#modal-confirm", 1500);

  await cdp.send("Page.stopScreencast");
  fs.writeFileSync(`${OUT}/times.json`, JSON.stringify(frames));
  console.log("frames", frames.length, "seconds", (frames.at(-1) - frames[0]).toFixed(1));
  await browser.close();
})().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
