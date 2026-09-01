const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "showcase.config.json"), "utf8"));
const BASE_URL = process.argv[2] || "http://127.0.0.1:46120/";
const PAGES_URL = process.env.RA2EXP_PAGES_URL || CONFIG.pagesUrl;
const APP_VERSION = process.env.RA2EXP_DEMO_VERSION || CONFIG.appVersion;
const WIDTH = CONFIG.viewport.width;
const HEIGHT = CONFIG.viewport.height;
const SOURCE_WIDTH = CONFIG.output.width;
const SOURCE_HEIGHT = CONFIG.output.height;
const DEVICE_SCALE_FACTOR = CONFIG.viewport.deviceScaleFactor || SOURCE_WIDTH / WIDTH;
const FPS = CONFIG.output.frameRate;
const AUDIO_PRESENTATION_DELAY = CONFIG.audio.presentationDelaySeconds;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(ROOT, `showcase-${RUN_ID}`);
const RAW_DIR = path.join(RUN_DIR, "raw");
const AUDIO_DIR = path.join(RUN_DIR, "audio");
const POSTER_DIR = path.join(RUN_DIR, "posters");
const TOTAL_CHAPTERS = 7;
const SCENE_FILTER = (process.argv[3] || "").split(",").map((value) => value.trim()).filter(Boolean);

for (const directory of [RUN_DIR, RAW_DIR, AUDIO_DIR, POSTER_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function chapterPage(scene) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#0d0f12;color:#f3f4f6;font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif}
    body{display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,#22262c 0,#111419 44%,#090b0e 100%)}
    .scan{position:fixed;inset:0;opacity:.16;background:repeating-linear-gradient(0deg,transparent 0,transparent 3px,rgba(255,255,255,.025) 4px);pointer-events:none}
    .frame{width:min(1120px,82vw);padding:74px 82px 68px;border:1px solid #343941;border-top:3px solid #e04b45;background:rgba(20,23,28,.94);box-shadow:0 38px 100px rgba(0,0,0,.5)}
    .eyebrow{display:flex;align-items:center;gap:14px;color:#e66a64;font-size:20px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
    .eyebrow i{display:block;width:48px;height:2px;background:#e04b45}.eyebrow span{color:#8b929d;font-weight:500}
    h1{margin:34px 0 18px;font-size:58px;line-height:1.14;letter-spacing:.02em}p{max-width:900px;margin:0;color:#b6bcc6;font-size:25px;line-height:1.65}
    .brand{display:flex;align-items:center;gap:14px;margin-top:48px;color:#d5d8dd;font-size:20px;font-weight:700}.mark{display:grid;place-items:center;width:46px;height:46px;border:1px solid #9e3835;background:#391b1b;color:#fff;font-family:Georgia,serif;font-size:27px;font-style:italic}.site{margin-top:14px;color:#8f96a1;font-size:17px}.progress{height:3px;margin-top:24px;background:#2e333b}.progress b{display:block;width:${(scene.index / TOTAL_CHAPTERS) * 100}%;height:100%;background:#d84a44}
  </style></head><body><div class="scan"></div><main class="frame"><div class="eyebrow"><i></i>第 ${String(scene.index).padStart(2, "0")} 章 <span>/ ${String(TOTAL_CHAPTERS).padStart(2, "0")}</span></div><h1>${escapeHtml(scene.title)}</h1><p>${escapeHtml(scene.subtitle)}</p><div class="brand"><span class="mark">R</span>RA2 Explorer · 红色警戒 2 资产浏览器</div><div class="site">${PAGES_URL}</div><div class="progress"><b></b></div></main></body></html>`;
}

const overlayCss = `
  * { cursor: none !important; }
  #ra2-demo-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif; }
  #ra2-demo-badge { position: absolute; left: 264px; bottom: 18px; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 7px 12px; border: 1px solid rgba(224,75,69,.8); border-radius: 3px; background: rgba(18,20,24,.9); color: #e7e9ed; box-shadow: 0 8px 28px rgba(0,0,0,.35); font-size: 14px; font-weight: 700; letter-spacing: .04em; backdrop-filter: blur(8px); }
  #ra2-demo-badge b { color: #ef645e; }
  #ra2-demo-caption { position: absolute; left: 50%; top: 50%; width: min(720px, calc(100vw - 96px)); padding: 22px 26px 23px; border: 1px solid rgba(224,75,69,.78); border-left: 4px solid #e04b45; border-radius: 3px; background: rgba(15,17,21,.95); box-shadow: 0 22px 70px rgba(0,0,0,.56); opacity: 0; transform: translate(-50%,-46%) scale(.985); transition: opacity .24s ease, transform .24s ease; backdrop-filter: blur(12px); }
  #ra2-demo-caption.visible { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  #ra2-demo-caption strong { display: block; color: #fff; font-size: 24px; line-height: 1.35; text-align: center; }
  #ra2-demo-caption span { display: block; margin-top: 8px; color: #c6cad1; font-size: 17px; line-height: 1.6; text-align: center; }
  #ra2-demo-transition { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 42%,#22262c 0,#111419 44%,#090b0e 100%); opacity: 1; transition: opacity .62s ease; }
  #ra2-demo-transition.hidden { opacity: 0; }
  #ra2-demo-transition.blank { background: #090b0e; }
  #ra2-demo-transition .frame { width: min(1120px,82vw); padding: 74px 82px 68px; border: 1px solid #343941; border-top: 3px solid #e04b45; background: rgba(20,23,28,.94); box-shadow: 0 38px 100px rgba(0,0,0,.5); }
  #ra2-demo-transition .eyebrow { display:flex;align-items:center;gap:14px;color:#e66a64;font-size:20px;font-weight:700;letter-spacing:.12em;text-transform:uppercase }
  #ra2-demo-transition .eyebrow i { display:block;width:48px;height:2px;background:#e04b45 }
  #ra2-demo-transition .eyebrow span { color:#8b929d;font-weight:500 }
  #ra2-demo-transition h1 { margin:34px 0 18px;color:#f3f4f6;font-size:58px;line-height:1.14;letter-spacing:.02em }
  #ra2-demo-transition p { max-width:900px;margin:0;color:#b6bcc6;font-size:25px;line-height:1.65 }
  #ra2-demo-transition .brand { display:flex;align-items:center;gap:14px;margin-top:54px;color:#d5d8dd;font-size:20px;font-weight:700 }
  #ra2-demo-transition .mark { display:grid;place-items:center;width:46px;height:46px;border:1px solid #9e3835;background:#391b1b;color:#fff;font-family:Georgia,serif;font-size:27px;font-style:italic }
  #ra2-demo-transition .site { margin-top:14px;color:#8f96a1;font-size:17px }
  #ra2-demo-transition .progress { height:3px;margin-top:24px;background:#2e333b }
  #ra2-demo-transition .progress b { display:block;height:100%;background:#d84a44 }
  #ra2-demo-highlight { position: absolute; display: none; border: 2px solid #f05a54; border-radius: 5px; box-shadow: 0 0 0 4px rgba(224,75,69,.17), 0 10px 34px rgba(0,0,0,.35); transition: left .22s ease, top .22s ease, width .22s ease, height .22s ease; }
  #ra2-demo-highlight.visible { display: block; animation: ra2DemoPulse 1.35s ease-in-out infinite; }
  #ra2-demo-highlight em { position: absolute; left: -2px; top: -31px; max-width: 360px; height: 27px; padding: 4px 9px; overflow: hidden; border-radius: 3px 3px 0 0; background: #e04b45; color: white; font-size: 13px; font-style: normal; font-weight: 700; line-height: 19px; text-overflow: ellipsis; white-space: nowrap; }
  #ra2-demo-cursor { position: absolute; left: 0; top: 0; width: 28px; height: 34px; opacity: 0; transform: translate(-3px,-3px); transition: left .22s cubic-bezier(.2,.8,.2,1), top .22s cubic-bezier(.2,.8,.2,1), opacity .15s ease; filter: drop-shadow(0 2px 4px rgba(0,0,0,.8)); }
  #ra2-demo-cursor.visible { opacity: 1; }
  #ra2-demo-cursor svg { width: 100%; height: 100%; }
  .ra2-demo-ripple { position: absolute; width: 14px; height: 14px; margin: -7px; border: 2px solid #ff6a63; border-radius: 50%; animation: ra2DemoRipple .55s ease-out forwards; }
  #settings-sources .settings-source-list, #settings-sources .settings-discoveries { visibility: hidden !important; }
  #settings-sources input { color: transparent !important; text-shadow: none !important; }
  @keyframes ra2DemoPulse { 0%,100%{box-shadow:0 0 0 4px rgba(224,75,69,.14),0 10px 34px rgba(0,0,0,.35)}50%{box-shadow:0 0 0 8px rgba(224,75,69,.05),0 10px 34px rgba(0,0,0,.35)} }
  @keyframes ra2DemoRipple { from{opacity:1;transform:scale(.5)}to{opacity:0;transform:scale(4)} }
`;

async function installOverlay(page, scene) {
  await page.addStyleTag({ content: overlayCss });
  await page.evaluate(({ index, total, title, subtitle, pagesUrl }) => {
    document.getElementById("ra2-demo-layer")?.remove();
    const layer = document.createElement("div");
    layer.id = "ra2-demo-layer";
    layer.innerHTML = `
      <div id="ra2-demo-badge"><b>${String(index).padStart(2, "0")}</b><span>${title}</span><i>/ ${String(total).padStart(2, "0")}</i></div>
      <div id="ra2-demo-caption"><strong></strong><span></span></div>
      <div id="ra2-demo-highlight"><em></em></div>
      <div id="ra2-demo-cursor"><svg viewBox="0 0 28 34" aria-hidden="true"><path d="M3 2 24 20l-10 1 5 10-5 2-5-10-6 7Z" fill="#f7f7f8" stroke="#111318" stroke-width="2" stroke-linejoin="round"/></svg></div>
      <div id="ra2-demo-transition"><main class="frame"><div class="eyebrow"><i></i>章节 ${String(index).padStart(2, "0")} <span>/ ${String(total).padStart(2, "0")}</span></div><h1>${title}</h1><p></p><div class="brand"><span class="mark">R</span>RA2 Explorer · 红色警戒 2 资产浏览器</div><div class="site">${pagesUrl}</div><div class="progress"><b style="width:${(index / total) * 100}%"></b></div></main></div>`;
    document.body.appendChild(layer);
    layer.querySelector("#ra2-demo-transition p").textContent = subtitle;
  }, { index: scene.index, total: TOTAL_CHAPTERS, title: scene.title, subtitle: scene.subtitle, pagesUrl: PAGES_URL });
}

function narrationHold(text, fallback) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return fallback;
  return Math.max(fallback, Math.min(6500, 700 + compact.length * 175));
}

async function caption(page, title, detail, hold = 1500) {
  const startedAt = Date.now();
  const segment = page.__ra2DemoSegment;
  if (segment && detail) {
    segment.narrationCues.push({ title, text: detail, start: Math.max(0, (startedAt - segment.startedAt) / 1000) });
  }
  await page.evaluate(({ title, detail }) => {
    const box = document.getElementById("ra2-demo-caption");
    if (!box) return;
    box.querySelector("strong").textContent = title;
    box.querySelector("span").textContent = detail || "";
    box.classList.add("visible");
  }, { title, detail });
  await page.waitForTimeout(narrationHold(detail, hold));
  await page.evaluate(() => document.getElementById("ra2-demo-caption")?.classList.remove("visible"));
  await page.waitForTimeout(240);
}

async function centerOf(locator) {
  await locator.first().waitFor({ state: "visible", timeout: 30000 });
  await locator.first().scrollIntoViewIfNeeded();
  const box = await locator.first().boundingBox();
  if (!box) throw new Error("目标控件没有可见边界");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function moveCursor(page, locator) {
  const target = await centerOf(locator);
  await page.evaluate(({ x, y }) => {
    const cursor = document.getElementById("ra2-demo-cursor");
    if (!cursor) return;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    cursor.classList.add("visible");
  }, target);
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.waitForTimeout(280);
  return target;
}

async function ripple(page, x, y) {
  await page.evaluate(({ x, y }) => {
    const layer = document.getElementById("ra2-demo-layer");
    if (!layer) return;
    const node = document.createElement("i");
    node.className = "ra2-demo-ripple";
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    layer.appendChild(node);
    window.setTimeout(() => node.remove(), 650);
  }, { x, y });
}

async function clickDemo(page, locator, after = 700) {
  const target = await moveCursor(page, locator);
  await ripple(page, target.x, target.y);
  await locator.first().click({ timeout: 30000 });
  await page.waitForTimeout(after);
}

async function callout(page, locator, title, detail, hold = 1500) {
  const target = await centerOf(locator);
  await page.evaluate(({ box, title }) => {
    const highlight = document.getElementById("ra2-demo-highlight");
    if (!highlight) return;
    const pad = 5;
    highlight.style.left = `${Math.max(2, box.x - pad)}px`;
    highlight.style.top = `${Math.max(2, box.y - pad)}px`;
    highlight.style.width = `${Math.min(window.innerWidth - box.x + pad - 2, box.width + pad * 2)}px`;
    highlight.style.height = `${Math.min(window.innerHeight - box.y + pad - 2, box.height + pad * 2)}px`;
    highlight.querySelector("em").textContent = title;
    highlight.classList.add("visible");
  }, { box: target.box, title });
  await caption(page, title, detail, hold);
  await page.evaluate(() => document.getElementById("ra2-demo-highlight")?.classList.remove("visible"));
}

async function smoothScroll(page, locator, top, hold = 1100) {
  await moveCursor(page, locator);
  await locator.first().evaluate((element, nextTop) => element.scrollTo({ top: nextTop, behavior: "smooth" }), top);
  await page.waitForTimeout(hold);
}

async function drag(page, locator, deltaX, deltaY) {
  const { x, y } = await moveCursor(page, locator);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 20; step += 1) {
    const nextX = x + (deltaX * step) / 20;
    const nextY = y + (deltaY * step) / 20;
    await page.evaluate(({ x, y }) => {
      const cursor = document.getElementById("ra2-demo-cursor");
      if (cursor) {
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
      }
    }, { x: nextX, y: nextY });
    await page.mouse.move(nextX, nextY);
    await page.waitForTimeout(24);
  }
  await page.mouse.up();
  await ripple(page, x + deltaX, y + deltaY);
  await page.waitForTimeout(650);
}

async function waitForEntity(page, expected) {
  await page.waitForFunction((name) => document.querySelector(".entity-detail-title h2")?.textContent?.includes(name), expected, { timeout: 30000 });
  await page.waitForTimeout(650);
}

async function searchAndSelectEntity(page, query, optionName) {
  const input = page.locator('input[aria-label="搜索单位和声音"]');
  await input.fill("");
  await input.pressSequentially(query, { delay: 95 });
  const option = page.getByRole("option", { name: optionName }).first();
  await option.waitFor({ timeout: 30000 });
  await clickDemo(page, option, 900);
}

async function clearSearch(page) {
  const clear = page.getByRole("button", { name: "清除搜索" }).first();
  if (await clear.count() && await clear.isEnabled()) await clickDemo(page, clear, 450);
}

async function captureAudioCue(segment, page, locator, label, maxDuration) {
  const before = await page.evaluate(() => window.__ra2DemoAudioEvents?.length || 0);
  await page.evaluate(() => { window.__ra2DemoBlockAudio = false; });
  await clickDemo(page, locator, 150);
  await page.waitForFunction((count) => (window.__ra2DemoAudioEvents?.length || 0) > count, before, { timeout: 15000 });
  const event = await page.evaluate(() => window.__ra2DemoAudioEvents.at(-1));
  const absoluteUrl = new URL(event.src, page.url()).href;
  let contentType;
  let body;
  if (absoluteUrl.startsWith("blob:")) {
    const payload = await page.evaluate(async (src) => {
      const response = await fetch(src);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return { type: blob.type, base64: String(dataUrl).split(",", 2)[1] };
    }, absoluteUrl);
    contentType = payload.type || "";
    body = Buffer.from(payload.base64, "base64");
  } else {
    const response = await page.context().request.get(absoluteUrl);
    if (!response.ok()) throw new Error(`音频下载失败：${response.status()} ${absoluteUrl}`);
    contentType = response.headers()["content-type"] || "";
    body = await response.body();
  }
  const extension = contentType.includes("wav") ? "wav" : contentType.includes("mpeg") ? "mp3" : contentType.includes("ogg") ? "ogg" : "audio";
  const cueIndex = segment.audioCues.length + 1;
  const filename = `${segment.id}-cue-${cueIndex}.${extension}`;
  const target = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(target, body);
  segment.audioCues.push({
    label,
    file: path.relative(RUN_DIR, target).replaceAll("\\", "/"),
    start: Math.max(0, (event.at - segment.startedAt) / 1000),
    maxDuration,
  });
  await page.waitForTimeout(Math.round(maxDuration * 1000));
  await stopAllDemoAudio(page);
  await page.evaluate(() => { window.__ra2DemoBlockAudio = true; });
}

async function stopAllDemoAudio(page) {
  await page.evaluate(() => {
    for (const audio of window.__ra2DemoAudios || []) {
      audio.pause();
      try { audio.currentTime = 0; } catch {}
    }
  });
  await page.waitForTimeout(320);
}

async function prepareCableAudio(page) {
  return page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    stream.getTracks().forEach((track) => track.stop());
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    const cable = outputs.find((device) => /^CABLE Input \(VB-Audio Virtual Cable\)$/i.test(device.label))
      || outputs.find((device) => /CABLE Input/i.test(device.label));
    if (!cable) throw new Error(`未找到 CABLE Input；可用输出：${outputs.map((device) => device.label || "未命名").join("、")}`);
    window.__ra2DemoCableSinkId = cable.deviceId;
    window.__ra2DemoBlockAudio = true;
    for (const audio of window.__ra2DemoAudios || []) {
      if (typeof audio.setSinkId === "function") await audio.setSinkId(cable.deviceId);
    }
    const probe = document.createElement("audio");
    if (typeof probe.setSinkId !== "function") throw new Error("当前 Chromium 不支持 setSinkId");
    await probe.setSinkId(cable.deviceId);
    return { outputLabel: cable.label, sinkIdApplied: probe.sinkId === cable.deviceId };
  });
}

async function startCableCapture(target) {
  const child = spawn("ffmpeg.exe", [
    "-hide_banner",
    "-loglevel", "info",
    "-y",
    "-thread_queue_size", "512",
    "-f", "dshow",
    "-i", "audio=CABLE Output (VB-Audio Virtual Cable)",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "pcm_s16le",
    target,
  ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  const readyAt = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`CABLE 录音设备启动超时：${stderr.slice(-1200)}`));
    }, 10000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!settled && stderr.includes("Output #0")) {
        settled = true;
        clearTimeout(timer);
        resolve(Date.now());
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CABLE 录音进程提前退出（${code}）：${stderr.slice(-1200)}`));
    });
  });
  return { child, target, readyAt, stderr: () => stderr };
}

async function stopCableCapture(capture) {
  if (!capture || capture.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      capture.child.kill();
      resolve();
    }, 10000);
    capture.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    capture.child.stdin.write("q\n");
  });
  if (!fs.existsSync(capture.target) || fs.statSync(capture.target).size < 1024) {
    throw new Error(`CABLE 录音文件无效：${capture.stderr().slice(-1200)}`);
  }
}

function measureCableCaptureLatency(segment, target) {
  if (!segment.audioCues?.length) return 0;
  const result = spawnSync("ffmpeg.exe", [
    "-hide_banner",
    "-i", target,
    "-af", "silencedetect=noise=-45dB:d=0.4",
    "-f", "null",
    "NUL",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) return 0;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const signalStarts = Array.from(output.matchAll(/silence_end:\s*([0-9.]+)/g), (match) => Number(match[1]));
  const expectedStarts = segment.audioCues.map((cue) => cue.start - segment.cableCaptureStart);
  const offsets = expectedStarts
    .map((expected, index) => signalStarts[index] - expected)
    .filter((offset) => Number.isFinite(offset) && offset >= 0 && offset <= 2);
  if (!offsets.length) return 0;
  offsets.sort((left, right) => left - right);
  const middle = Math.floor(offsets.length / 2);
  const median = offsets.length % 2 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
  return Number(median.toFixed(3));
}

async function startHighQualityRecording(context, page, target) {
  const session = await context.newCDPSession(page);
  const child = spawn("ffmpeg.exe", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "image2pipe",
    "-framerate", String(FPS),
    "-c:v", "mjpeg",
    "-i", "pipe:0",
    "-an",
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "10",
    "-pix_fmt", "yuv420p",
    "-vf", `scale=${SOURCE_WIDTH}:${SOURCE_HEIGHT}:flags=lanczos`,
    target,
  ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  let lastFrame;
  let firstTimestamp;
  let lastWallTime = Date.now();
  let emittedFrames = 0;
  let stopping = false;
  let writeChain = Promise.resolve();
  let firstFrameResolve;
  const firstFrame = new Promise((resolve) => { firstFrameResolve = resolve; });
  const exit = new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`高清录屏编码失败（${code}）：${stderr.slice(-1600)}`)));
  });
  const writeFrame = (buffer) => new Promise((resolve, reject) => {
    if (child.stdin.writableEnded || child.stdin.destroyed) {
      reject(new Error(`高清录屏输入管道已关闭：${stderr.slice(-1600)}`));
      return;
    }
    child.stdin.write(buffer, (error) => error ? reject(error) : resolve());
  });
  child.stdin.on("error", () => undefined);
  const enqueue = (buffer, count) => {
    writeChain = writeChain.then(async () => {
      for (let index = 0; index < count; index += 1) await writeFrame(buffer);
    });
  };
  session.on("Page.screencastFrame", (event) => {
    session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    if (stopping) return;
    const timestamp = event.metadata.timestamp || Date.now() / 1000;
    if (lastFrame) {
      const targetFrames = Math.max(1, Math.round(FPS * (timestamp - firstTimestamp)));
      const repeat = Math.max(0, targetFrames - emittedFrames);
      if (repeat > 0) {
        enqueue(lastFrame, repeat);
        emittedFrames += repeat;
      }
    } else {
      firstTimestamp = timestamp;
    }
    lastFrame = Buffer.from(event.data, "base64");
    lastWallTime = Date.now();
    if (firstFrameResolve) {
      firstFrameResolve();
      firstFrameResolve = undefined;
    }
  });
  const startedAt = Date.now();
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 100,
    maxWidth: SOURCE_WIDTH,
    maxHeight: SOURCE_HEIGHT,
    everyNthFrame: 1,
  });
  await Promise.race([
    firstFrame,
    new Promise((_, reject) => setTimeout(() => reject(new Error("高清录屏未收到首帧")), 10000)),
  ]);
  return {
    startedAt,
    async stop() {
      stopping = true;
      await session.send("Page.stopScreencast").catch(() => undefined);
      if (lastFrame) {
        const targetFrames = Math.max(1, Math.round(FPS * (Date.now() - startedAt) / 1000));
        const repeat = Math.max(1, targetFrames - emittedFrames);
        enqueue(lastFrame, repeat);
        emittedFrames += repeat;
      }
      await writeChain;
      child.stdin.end();
      await exit;
      await session.detach().catch(() => undefined);
      if (!fs.existsSync(target) || fs.statSync(target).size < 1024) throw new Error(`高清录屏文件无效：${target}`);
      return { emittedFrames, duration: emittedFrames / FPS, idleTailMilliseconds: Date.now() - lastWallTime };
    },
  };
}

async function showFinalCard(page) {
  await page.evaluate(({ version, pagesUrl }) => {
    const layer = document.getElementById("ra2-demo-layer");
    if (!layer) return;
    const card = document.createElement("div");
    card.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;background:rgba(9,11,14,.96);opacity:0;transition:opacity .45s ease;";
    card.innerHTML = `<div style="width:min(980px,78vw);padding:64px 72px;border:1px solid #353a42;border-top:3px solid #e04b45;background:#15181d;box-shadow:0 34px 100px rgba(0,0,0,.55)"><div style="color:#e45a54;font-size:17px;font-weight:700;letter-spacing:.12em">RA2 EXPLORER</div><h2 style="margin:25px 0 14px;color:#fff;font-size:50px;line-height:1.2">完整功能演示结束</h2><p style="margin:0;color:#bbc0c9;font-size:23px;line-height:1.65">单位、模型、帧动画、声音与全局检索，都可以在浏览器中直接体验。</p><div style="margin-top:30px;color:#a7adb6;font-size:18px">${pagesUrl}</div><div style="margin-top:14px;color:#7f8792;font-size:16px">感谢观看 · v${version}</div></div>`;
    layer.appendChild(card);
    requestAnimationFrame(() => { card.style.opacity = "1"; });
  }, { version: APP_VERSION, pagesUrl: PAGES_URL });
  await page.waitForTimeout(3400);
}

async function showChapterIntro(page, scene) {
  const segment = page.__ra2DemoSegment;
  if (segment) {
    segment.narrationCues.push({
      title: scene.title,
      text: scene.subtitle,
      start: Math.max(0, (Date.now() - segment.startedAt) / 1000),
    });
  }
  await page.waitForTimeout(narrationHold(scene.subtitle, 2600));
  await page.evaluate(() => document.getElementById("ra2-demo-transition")?.classList.add("hidden"));
  await page.waitForTimeout(720);
  await page.evaluate(() => {
    const transition = document.getElementById("ra2-demo-transition");
    if (transition) transition.style.display = "none";
  });
}

async function fadeChapterOut(page) {
  await page.evaluate(() => {
    const transition = document.getElementById("ra2-demo-transition");
    if (!transition) return;
    transition.innerHTML = "";
    transition.classList.add("blank", "hidden");
    transition.style.display = "grid";
    requestAnimationFrame(() => requestAnimationFrame(() => transition.classList.remove("hidden")));
  });
  await page.waitForTimeout(720);
}

async function openApp(page, scene) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".entity-card", { timeout: 60000 });
  await page.waitForTimeout(900);
  await installOverlay(page, scene);
}

const scenes = [
  {
    id: "01-overview-navigation",
    index: 1,
    title: "单位与声音资料库",
    subtitle: "从真实游戏数据进入载具、航空器、步兵、建筑与声音资料库。",
    async run(segment, page) {
      await caption(page, "真实单位预览", "首页以高密度网格展示单位外观、名称与所属阵营。", 1500);
      await callout(page, page.locator(".library-tree"), "按游戏内容浏览", "分类树覆盖载具、航空器、步兵、建筑，以及游戏语音和音效。", 1500);
      const list = page.locator(".entity-panel .asset-list");
      await smoothScroll(page, list, 720, 1200);
      await smoothScroll(page, list, 0, 800);

      for (const title of ["航空器", "步兵", "建筑"]) {
        await clickDemo(page, page.getByTitle(title), 850);
        await caption(page, title, "", 700);
      }
    },
  },
  {
    id: "02-search-filter-sort",
    index: 2,
    captureCable: true,
    title: "全局搜索与结果浏览",
    subtitle: "用中文、英文、拼音和混合输入同时查找单位与声音。",
    async run(segment, page) {
      await page.keyboard.press("Control+K");
      const input = page.locator('input[aria-label="搜索单位和声音"]');
      await callout(page, input, "快捷键 Ctrl+K", "", 700);
      await input.pressSequentially("yuri", { delay: 125 });
      await page.getByRole("option", { name: /尤里X.*Yuri Prime/ }).waitFor({ timeout: 30000 });
      await callout(page, page.locator(".entity-search-suggestions"), "英文与拼音补全", "输入 yuri 即可定位尤里X，也会列出相关声音。", 1400);
      await clickDemo(page, page.getByRole("option", { name: /尤里X.*Yuri Prime/ }).first(), 950);
      await waitForEntity(page, "尤里X");

      await clearSearch(page);
      await input.pressSequentially("基luo夫", { delay: 130 });
      await page.getByText("基洛夫空艇", { exact: true }).first().waitFor({ timeout: 30000 });
      await callout(page, page.locator(".entity-search-suggestions"), "中英文混合输入", "中文与拼音可以自由混输，候选会在输入过程中即时更新。", 1500);

      await clearSearch(page);
      await input.pressSequentially("kirov", { delay: 120 });
      await page.getByText("Kirov reporting.", { exact: true }).first().waitFor({ timeout: 30000 });
      await callout(page, page.locator(".entity-search-suggestions"), "单位与声音一起返回", "候选列表同时展示基洛夫空艇及其对应的单位语音。", 1500);
      await clickDemo(page, page.getByRole("button", { name: "搜索", exact: true }).first(), 850);
      await page.locator(".search-results-panel").waitFor({ state: "visible", timeout: 30000 });
      await callout(page, page.locator(".search-results-scroll"), "完整搜索结果", "结果页分别展示单位和声音，并提供结果内筛选。", 1500);
      const kirovVoice = page.locator(".search-media-card").filter({ hasText: "Kirov reporting." }).first();
      await callout(page, kirovVoice, "试听基洛夫语音", "", 650);
      await page.waitForTimeout(550);
      await captureAudioCue(segment, page, kirovVoice, "基洛夫单位语音", 2.3);

      await clickDemo(page, page.getByTitle("载具"), 850);
      const soviet = page.locator('.entity-panel .tag-filter button').filter({ hasText: "苏军" }).first();
      await callout(page, soviet, "按阵营筛选载具", "盟军、苏军、尤里和无阵营单位都可以单独查看。", 1200);
      await clickDemo(page, soviet, 850);

      const sort = page.locator(".entity-panel .sort-control select");
      await moveCursor(page, sort);
      await sort.selectOption("cost_desc");
      await page.waitForTimeout(950);
      await caption(page, "游戏属性排序", "单位可以按建造栏、阵营、造价、生命值和名称排序。", 1300);
    },
  },
  {
    id: "03-vxl-model-details",
    index: 3,
    title: "三维单位模型",
    subtitle: "查看组合体素模型、玩家配色、自由旋转缩放和单位资料。",
    async run(segment, page) {
      const card = page.locator(".entity-card").filter({ hasText: "战斗要塞" }).first();
      await callout(page, card, "选择战斗要塞", "", 650);
      await clickDemo(page, card, 900);
      await waitForEntity(page, "战斗要塞");
      const canvas = page.locator(".voxel-canvas canvas");
      await canvas.waitFor({ state: "visible", timeout: 60000 });
      await page.waitForFunction(() => !document.querySelector(".voxel-status"), null, { timeout: 60000 }).catch(() => undefined);
      await callout(page, page.locator(".voxel-viewer"), "游戏风格体素模型", "车体、炮塔与武器组件按游戏装配关系组合，并呈现原作明暗风格。", 1700);

      await caption(page, "自由观察", "拖动鼠标旋转视角，滚轮缩放，重置按钮随时恢复默认构图。", 1300);
      await drag(page, canvas, 185, -35);
      await drag(page, canvas, -90, 65);
      await moveCursor(page, canvas);
      await page.mouse.wheel(0, -520);
      await page.waitForTimeout(850);
      await page.mouse.wheel(0, 260);
      await page.waitForTimeout(700);

      const color = page.locator('select[aria-label="玩家颜色"]');
      if (await color.count()) {
        await moveCursor(page, color);
        await color.selectOption({ index: 3 });
        await caption(page, "切换玩家配色", "", 700);
        await color.selectOption({ index: 0 });
        await page.waitForTimeout(500);
      }
      await clickDemo(page, page.locator(".voxel-reset"), 750);

      await clickDemo(page, page.getByRole("tab", { name: /数据/ }), 650);
      await callout(page, page.locator(".entity-detail-sections"), "完整单位资料", "标签、规则属性和资源文件集中呈现，便于查阅造价、生命值与武器信息。", 1500);
      await clickDemo(page, page.getByRole("tab", { name: /声音/ }), 650);
      await caption(page, "单位声音", "选中、移动、攻击和受击回应按事件分组展示。", 1300);
    },
  },
  {
    id: "04-shp-unit-animation",
    index: 4,
    title: "步兵与建筑帧动画",
    subtitle: "浏览步兵动作，以及建筑的建造和运行效果。",
    async run(segment, page) {
      await searchAndSelectEntity(page, "美国大兵", /美国大兵/);
      await waitForEntity(page, "美国大兵");
      await clickDemo(page, page.getByRole("tab", { name: /动画/ }), 650);
      await callout(page, page.locator(".animation-kind-groups"), "按动作事件浏览", "待机、行走、卧倒、开火和阵亡分别显示为可播放动作。", 1500);
      const walk = page.locator(".animation-association-list button").filter({ hasText: "walk · 行走" }).first();
      await clickDemo(page, walk, 500);
      await page.locator(".frame-controls").waitFor({ state: "visible", timeout: 30000 });
      await caption(page, "播放行走动作", "连续播放可以直接观察角色的朝向与动作节奏。", 1900);
      const pause = page.locator('.frame-controls button[aria-label="暂停"]');
      if (await pause.count()) await clickDemo(page, pause, 450);
      const next = page.locator('.frame-controls button[aria-label="下一帧"]');
      const previous = page.locator('.frame-controls button[aria-label="上一帧"]');
      if (await next.isEnabled()) await clickDemo(page, next, 550);
      if (await previous.isEnabled()) await clickDemo(page, previous, 550);
      await caption(page, "逐帧查看", "", 700);

      await clearSearch(page);
      await searchAndSelectEntity(page, "磁爆线圈", /磁爆线圈/);
      await waitForEntity(page, "磁爆线圈");
      await clickDemo(page, page.getByRole("tab", { name: /动画/ }), 650);
      await callout(page, page.locator(".animation-kind-groups"), "建筑动画", "建造序列、运行附属层和主体状态按用途分组。", 1400);
      const construction = page.locator(".animation-association-list button").filter({ hasText: "建造" }).first();
      await clickDemo(page, construction, 450);
      await caption(page, "建造过程", "", 1100);
      const operation = page.locator(".animation-association-list button").filter({ hasText: "运行层一" }).first();
      await clickDemo(page, operation, 450);
      await caption(page, "运行效果", "", 1100);
    },
  },
  {
    id: "05-unit-voices",
    index: 5,
    captureCable: true,
    title: "单位语音与事件分组",
    subtitle: "从单位详情试听选中、移动、攻击、受击与阵亡回应。",
    async run(segment, page) {
      await searchAndSelectEntity(page, "美国大兵", /美国大兵/);
      await waitForEntity(page, "美国大兵");
      await clickDemo(page, page.getByRole("tab", { name: /声音/ }), 650);
      await callout(page, page.locator(".entity-sounds"), "按游戏事件分组", "每组语音都带有事件名称、音频编号、英文原文和简体中文。", 1500);
      const grid = page.locator('.entity-detail-title button[aria-label="网格视图"]');
      if (await grid.count()) await clickDemo(page, grid, 650);

      const samples = [
        ["igisea", "选中回应", 1.9],
        ["igimoa", "移动指令", 1.9],
        ["igiatc", "攻击指令", 2.1],
        ["igifea", "受击反馈", 2.0],
        ["igidia", "阵亡语音", 2.1],
      ];
      for (const [id, title, duration] of samples) {
        const control = page.getByRole("button", { name: `播放 ${id}` });
        await callout(page, control, title, "", 600);
        await page.waitForTimeout(500);
        await captureAudioCue(segment, page, control, `美国大兵 ${title}`, duration);
      }
      await caption(page, "直接试听更多单位", "其他步兵、载具和航空器也可以用同样方式浏览完整语音组。", 1300);
    },
  },
  {
    id: "06-sound-browser",
    index: 6,
    captureCable: true,
    title: "声音分类与任务对白",
    subtitle: "按声音用途、游戏事件和具体任务浏览语音与音效。",
    async run(segment, page) {
      await clickDemo(page, page.getByTitle("游戏语音"), 900);
      await page.waitForSelector(".media-card", { timeout: 60000 });
      await callout(page, page.locator(".media-filter-strip"), "声音用途与事件", "单位回应、EVA 播报、任务对白、多人通讯和场景播报都可以继续细分。", 1600);

      await clickDemo(page, page.getByTitle("任务对白"), 900);
      const mission = page.locator(".media-filter-strip button").filter({ hasText: "尤里的复仇 · 盟军战役 · 第 1 关" }).first();
      await callout(page, mission, "按具体任务查找", "任务对白按战役、阵营、关卡名称和剧情事件组织。", 1500);
      await clickDemo(page, mission, 850);
      const dialogue = page.locator(".media-filter-strip button").filter({ hasText: "剧情对白" }).first();
      await clickDemo(page, dialogue, 750);
      await callout(page, page.locator(".media-group-section").first(), "光阴似箭", "同一任务中的简报、剧情对白、目标指引与战况警告可以分别查看。", 1400);
      await stopAllDemoAudio(page);
      const missionVoice = page.locator(".media-card").first();
      await callout(page, missionVoice, "试听任务对白", "", 650);
      await page.waitForTimeout(500);
      await captureAudioCue(segment, page, missionVoice, "任务对白", 3.2);

      await clickDemo(page, page.getByTitle("EVA 播报"), 900);
      await page.locator(".media-card").first().waitFor({ state: "visible", timeout: 30000 });
      await stopAllDemoAudio(page);
      await caption(page, "EVA 播报", "建造完成、资源不足、基地受袭和任务状态等播报集中在这里。", 1300);
      for (const [index, label] of [[0, "EVA 播报一"], [1, "EVA 播报二"]]) {
        const card = page.locator(".media-card").nth(index);
        if (!await card.count()) continue;
        await callout(page, card, label, "", 550);
        await page.waitForTimeout(500);
        await captureAudioCue(segment, page, card, label, 2.4);
      }

      await clickDemo(page, page.getByTitle("游戏音效"), 900);
      await page.waitForSelector(".media-card", { timeout: 60000 });
      const superweapon = page.getByTitle("超级武器");
      await clickDemo(page, superweapon, 900);
      await stopAllDemoAudio(page);
      const effect = page.locator(".media-card").first();
      await callout(page, effect, "超级武器音效", "", 650);
      await page.waitForTimeout(500);
      await captureAudioCue(segment, page, effect, "超级武器音效", 2.8);

      const associationTab = page.getByRole("tab", { name: /关联/ });
      if (await associationTab.count()) {
        await clickDemo(page, associationTab, 550);
        await caption(page, "查看声音关联", "详情会列出使用这条声音的单位、武器或场景事件。", 1300);
      }
    },
  },
  {
    id: "07-settings-layout",
    index: 7,
    title: "设置与本地资源",
    subtitle: "配置显示方式，并在浏览器中解析原版目录或导入派生资源包。",
    async run(segment, page) {
      await clickDemo(page, page.locator(".sidebar-settings"), 700);
      await page.waitForSelector(".settings-dialog", { timeout: 30000 });
      await callout(page, page.locator("#settings-display"), "显示偏好", "详情布局、简繁文本、单位默认角度和声音分组标题都可以调整。", 1500);
      const rightLayout = page.locator('#settings-display .layout-choice button').filter({ hasText: "左右" }).first();
      await clickDemo(page, rightLayout, 500);
      const angle = page.locator('#settings-display select[aria-label="单位默认预览角度"]');
      await moveCursor(page, angle);
      await angle.selectOption("7");
      await caption(page, "默认预览角度", "", 700);

      const sourceNav = page.locator(".settings-nav button").filter({ hasText: "游戏目录" });
      await clickDemo(page, sourceNav, 550);
      await callout(page, page.locator("#settings-sources"), "解析官方安装目录", "选择本机的红色警戒 2 或尤里的复仇目录，即可建立资源资料库。", 1500);
      const packNav = page.locator(".settings-nav button").filter({ hasText: "资源包" });
      await clickDemo(page, packNav, 500);
      await callout(page, page.locator("#settings-packs"), "派生资源包", "解析结果可以导入、导出和复用，适合在不同电脑间迁移。", 1400);
      const updateNav = page.locator(".settings-nav button").filter({ hasText: "应用更新" });
      await clickDemo(page, updateNav, 500);
      await callout(page, page.locator("#settings-updates"), "版本与更新", `当前演示版本为 ${APP_VERSION}，可以在这里检查并下载新版本。`, 1400);

      await clickDemo(page, page.locator(".settings-dialog .button.primary").filter({ hasText: "完成" }), 850);
      await page.waitForTimeout(900);
      await showFinalCard(page);
    },
  },
];

async function recordScene(browser, scene) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: "zh-CN",
    colorScheme: "dark",
    acceptDownloads: true,
  });
  if (scene.captureCable) {
    await context.grantPermissions(["microphone"], { origin: new URL(BASE_URL).origin });
  }
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
    window.__ra2DemoAudioEvents = [];
    window.__ra2DemoAudios = [];
    window.__ra2DemoCableSinkId = "";
    window.__ra2DemoBlockAudio = false;
    const NativeAudio = window.Audio;
    if (NativeAudio && !NativeAudio.__ra2DemoPatched) {
      function DemoAudio(src) {
        const audio = new NativeAudio(src);
        window.__ra2DemoAudios.push(audio);
        audio.addEventListener("playing", () => {
          window.__ra2DemoAudioEvents.push({ src: audio.currentSrc || audio.src || src, at: Date.now() });
        });
        return audio;
      }
      DemoAudio.prototype = NativeAudio.prototype;
      Object.setPrototypeOf(DemoAudio, NativeAudio);
      DemoAudio.__ra2DemoPatched = true;
      window.Audio = DemoAudio;
    }
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function ra2DemoCablePlay() {
      if (window.__ra2DemoBlockAudio) return Promise.resolve();
      const sinkId = window.__ra2DemoCableSinkId;
      if (sinkId && typeof this.setSinkId === "function" && this.sinkId !== sinkId) {
        return this.setSinkId(sinkId).then(() => nativePlay.call(this));
      }
      return nativePlay.call(this);
    };
  });

  const errors = [];
  const failedRequests = [];
  const page = await context.newPage();
  const rawTarget = path.join(RAW_DIR, `${scene.id}.mkv`);
  const segment = {
    id: scene.id,
    index: scene.index,
    title: scene.title,
    subtitle: scene.subtitle,
    startedAt: 0,
    audioCues: [],
    narrationCues: [],
    errors,
    failedRequests,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    if (failure?.errorText !== "net::ERR_ABORTED") failedRequests.push({ url: request.url(), error: failure?.errorText || "failed" });
  });

  let sceneError;
  let cableCapture;
  let videoCapture;
  try {
    await openApp(page, scene);
    videoCapture = await startHighQualityRecording(context, page, rawTarget);
    segment.startedAt = videoCapture.startedAt;
    segment.capture = {
      method: "Chrome DevTools screencast",
      sourceResolution: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
      frameRate: FPS,
      jpegQuality: 100,
      codec: "H.264 CRF 10",
    };
    page.__ra2DemoSegment = segment;
    await showChapterIntro(page, scene);
    if (scene.captureCable) {
      segment.cableRouting = await prepareCableAudio(page);
      const cableTarget = path.join(AUDIO_DIR, `${scene.id}-cable.wav`);
      cableCapture = await startCableCapture(cableTarget);
      segment.cableCaptureStart = (cableCapture.readyAt - segment.startedAt) / 1000;
      segment.cablePresentationDelay = AUDIO_PRESENTATION_DELAY;
      segment.cableCapture = path.relative(RUN_DIR, cableTarget).replaceAll("\\", "/");
    }
    await scene.run(segment, page);
    await page.evaluate(() => {
      document.getElementById("ra2-demo-highlight")?.classList.remove("visible");
      document.getElementById("ra2-demo-caption")?.classList.remove("visible");
    });
    await page.screenshot({ path: path.join(POSTER_DIR, `${scene.id}.png`) });
    await fadeChapterOut(page);
  } catch (error) {
    sceneError = error;
    errors.push(error.stack || error.message || String(error));
    await page.screenshot({ path: path.join(POSTER_DIR, `${scene.id}-failed.png`) }).catch(() => undefined);
  } finally {
    if (videoCapture) {
      try {
        Object.assign(segment.capture, await videoCapture.stop());
      } catch (error) {
        errors.push(error.stack || error.message || String(error));
        if (!sceneError) sceneError = error;
      }
    }
    if (cableCapture) {
      try {
        await stopCableCapture(cableCapture);
        segment.cableCaptureLatency = measureCableCaptureLatency(segment, cableCapture.target);
      } catch (error) {
        errors.push(error.stack || error.message || String(error));
        if (!sceneError) sceneError = error;
      }
    }
    await context.close();
  }

  segment.rawVideo = path.relative(RUN_DIR, rawTarget).replaceAll("\\", "/");
  segment.finishedAt = Date.now();
  delete segment.startedAt;
  if (sceneError) throw Object.assign(sceneError, { segment });
  return segment;
}

async function main() {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--mute-audio"], args: ["--use-fake-ui-for-media-stream"] });
  const manifest = {
    schemaVersion: 1,
    title: "RA2 Explorer 完整功能演示",
    appUrl: BASE_URL,
    appVersion: APP_VERSION,
    resolution: { width: WIDTH, height: HEIGHT },
    recordedAt: new Date().toISOString(),
    runDirectory: RUN_DIR,
    segments: [],
  };
  try {
    const selectedScenes = SCENE_FILTER.length > 0
      ? scenes.filter((scene) => SCENE_FILTER.some((value) => scene.id === value || String(scene.index) === value))
      : scenes;
    if (selectedScenes.length === 0) throw new Error(`没有匹配的章节：${SCENE_FILTER.join(", ")}`);
    for (const scene of selectedScenes) {
      console.log(`[record] ${scene.index}/${TOTAL_CHAPTERS} ${scene.title}`);
      const segment = await recordScene(browser, scene);
      manifest.segments.push(segment);
      fs.writeFileSync(path.join(RUN_DIR, "recording-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      console.log(`[saved] ${segment.rawVideo}`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(ROOT, "latest-run.txt"), RUN_DIR, "utf8");
  fs.writeFileSync(path.join(RUN_DIR, "recording-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify({ runDirectory: RUN_DIR, segmentCount: manifest.segments.length, errors: manifest.segments.flatMap((segment) => segment.errors).length }, null, 2));
}

main().catch((error) => {
  if (error.segment) console.error(JSON.stringify(error.segment, null, 2));
  console.error(error.stack || error);
  process.exitCode = 1;
});
