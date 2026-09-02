const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "voice-video.config.json"), "utf8"));
const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const BASE_URL = (positional[0] || "http://127.0.0.1:46120/").replace(/\/+$/, "");
const KIND_FILTER = positional[1] || "infantry";
const SMOKE = process.argv.includes("--smoke");
const PLAN_PATH = path.join(ROOT, "soviet-voices-plan.json");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(ROOT, `soviet-voices-${SMOKE ? "smoke-" : ""}${RUN_ID}`);
const RAW_DIR = path.join(RUN_DIR, "raw");
const AUDIO_DIR = path.join(RUN_DIR, "audio");
const POSTER_DIR = path.join(RUN_DIR, "posters");
const WIDTH = CONFIG.viewport.width;
const HEIGHT = CONFIG.viewport.height;
const SOURCE_WIDTH = CONFIG.output.width;
const SOURCE_HEIGHT = CONFIG.output.height;
const FPS = CONFIG.output.frameRate;
const EVENT_LABELS = {
  select: "选择回应",
  create: "出场回应",
  move: "移动指令",
  attack: "攻击指令",
  feedback: "受击反馈",
  special_attack: "特殊指令",
  enter: "进入指令",
  capture: "占领指令",
  deploy: "部署指令",
  harvest: "采集指令",
  die: "阵亡",
};
const SECTION_LABELS = { infantry: "苏军步兵单位语音" };

for (const directory of [RUN_DIR, RAW_DIR, AUDIO_DIR, POSTER_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function runPlanner() {
  const result = spawnSync(process.execPath, [path.join(ROOT, "plan-soviet-voices.cjs"), BASE_URL, PLAN_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`语音清单生成失败（${result.status}）\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  process.stdout.write(result.stdout);
  return JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
}

function mediaUrl(assetId) {
  return `${BASE_URL}/api/assets/${encodeURIComponent(assetId)}/media`;
}

function assetPreviewUrl(assetId, frame, shadowFrame, scale = 12, paletteKind = "unit") {
  const params = new URLSearchParams({
    frame: String(frame),
    scale: String(scale),
    player_color: CONFIG.visual.playerColor,
    palette_kind: paletteKind,
  });
  if (Number.isInteger(shadowFrame)) params.set("shadow_frame", String(shadowFrame));
  return `${BASE_URL}/api/assets/${encodeURIComponent(assetId)}/preview.png?${params}`;
}

function entityPreviewUrl(sourceId, entityId, facing, scale = 8) {
  const params = new URLSearchParams({
    frame: "0",
    facing: String(facing),
    scale: String(scale),
    thumbnail: "true",
    player_color: CONFIG.visual.playerColor,
  });
  return `${BASE_URL}/api/entities/${encodeURIComponent(sourceId)}/${encodeURIComponent(entityId)}/preview.png?${params}`;
}

function sequenceMatches(sequence, expression) {
  return [sequence.event, ...(sequence.aliases || [])].some((value) => expression.test(String(value)));
}

function validSequence(visual, sequence) {
  const pairedShadow = visual.sourceFrameCount === visual.contentFrameCount * 2;
  const limit = pairedShadow ? visual.contentFrameCount : visual.sourceFrameCount;
  const facingOffset = sequence.facing_step ? 5 * Number(sequence.facing_step) : 0;
  const lastFrame = Number(sequence.start_frame || 0)
    + facingOffset
    + (Math.max(1, Number(sequence.frame_count) || 1) - 1) * Math.max(1, Number(sequence.frame_step || 1));
  return lastFrame >= 0 && lastFrame < limit;
}

function sequenceKey(sequence) {
  return [
    sequence.assetId,
    sequence.start_frame,
    sequence.frame_count,
    sequence.facing_step,
    sequence.frame_step,
  ].join(":");
}

function sequenceCandidatesForSlot(visual, slot) {
  const sequences = (visual.sequences || []).filter((sequence) => validSequence(visual, sequence));
  const preferences = {
    select: [/idle1|idle2|ready|guard|cheer/i, /walk/i],
    create: [/cheer|idle1|idle2|ready|guard/i, /walk/i],
    move: [/walk|fly|swim|crawl|move/i, /idle1|idle2|ready|guard/i],
    enter: [/walk|crawl|enter|move/i, /idle1|idle2|ready|guard/i],
    capture: [/walk|capture|deploy|crawl/i, /idle1|idle2|ready|guard/i],
    deploy: [/deploy|deployedfire|down|up/i, /idle1|idle2|ready|guard/i],
    harvest: [/walk|harvest|work/i, /idle1|idle2|ready|guard/i],
    attack: [/fireup|fireprone|deployedfire|firefly|fire|attack|shoot/i, /walk|ready|guard/i],
    special_attack: [/deploy|deployedfire|fireup|fireprone|firefly|fire|attack/i, /walk|ready|guard/i],
    feedback: [/down|crawl|up|tumble|panic/i, /walk|idle1|idle2|ready|guard/i],
    die: [/die1|die2|airdeathstart|airdeathfinish|death|tumble/i, /down|crawl|idle1/i],
  };
  const ordered = [];
  const seen = new Set();
  for (const expression of preferences[slot] || preferences.select) {
    for (const sequence of sequences.filter((candidate) => sequenceMatches(candidate, expression))) {
      const key = sequenceKey(sequence);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(sequence);
    }
  }
  for (const sequence of sequences) {
    const key = sequenceKey(sequence);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(sequence);
  }
  return ordered;
}

function sequenceAnimation(group, slot, sourceId, ordinal) {
  const visual = group.representative.visual;
  if (visual.bodyFormat === "vxl") {
    const facingOrder = [0, 7, 6, 5, 4, 3, 2, 1];
    return {
      event: "facing",
      frames: facingOrder.map((facing) => entityPreviewUrl(sourceId, group.representative.id, facing)),
      intervalMs: CONFIG.visual.voxelFacingIntervalMs,
    };
  }
  const candidates = sequenceCandidatesForSlot(visual, slot);
  const sequence = candidates.length ? candidates[ordinal % candidates.length] : null;
  if (!sequence) {
    return {
      event: "preview",
      frames: [entityPreviewUrl(sourceId, group.representative.id, 5)],
      intervalMs: CONFIG.visual.frameIntervalMs,
    };
  }
  const pairedShadow = visual.sourceFrameCount === visual.contentFrameCount * 2;
  const shadowOffset = pairedShadow ? visual.contentFrameCount : 0;
  const facingOffset = sequence.facing_step
    ? 5 * sequence.facing_step
    : 0;
  const frames = Array.from({ length: Math.min(24, Math.max(1, Number(sequence.frame_count) || 1)) }, (_, index) => {
    const frame = Number(sequence.start_frame || 0)
      + facingOffset
      + index * Math.max(1, Number(sequence.frame_step || 1));
    const shadowFrame = pairedShadow && frame < shadowOffset && frame + shadowOffset < visual.sourceFrameCount
      ? frame + shadowOffset
      : undefined;
    return assetPreviewUrl(sequence.assetId, frame, shadowFrame, 12, sequence.palette || "unit");
  });
  return {
    event: sequence.event,
    frames,
    intervalMs: Number(sequence.rate_ms) > 0 ? Number(sequence.rate_ms) : CONFIG.visual.frameIntervalMs,
  };
}

function prepareGroups(groups, sourceId) {
  return groups.map((group) => {
    const invalidSequenceEvents = (group.representative.visual.sequences || [])
      .filter((sequence) => !validSequence(group.representative.visual, sequence))
      .map((sequence) => sequence.event);
    if (invalidSequenceEvents.length) {
      console.warn(`[visual] ${group.representative.name} 跳过越界动作：${invalidSequenceEvents.join("、")}`);
    }
    const ordinalBySlot = new Map();
    const cues = group.cues.map((cue) => {
      const event = cue.events[0] || {};
      const slot = event.slot || "select";
      const ordinal = ordinalBySlot.get(slot) || 0;
      ordinalBySlot.set(slot, ordinal + 1);
      return {
        ...cue,
        slot,
        eventLabel: EVENT_LABELS[slot] || "单位回应",
        eventName: event.event || "",
        animation: sequenceAnimation(group, slot, sourceId, ordinal),
      };
    });
    return {
      ...group,
      cameoUrl: group.representative.visual.cameoAssetId
        ? assetPreviewUrl(group.representative.visual.cameoAssetId, 0, undefined, 6, "unit")
        : entityPreviewUrl(sourceId, group.representative.id, 5, 5),
      invalidSequenceEvents,
      cues,
    };
  });
}

async function mapLimit(values, limit, operation) {
  let cursor = 0;
  const results = new Array(values.length);
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function prewarmBackend(groups) {
  const visualUrls = [...new Set(groups.flatMap((group) => [
    group.cameoUrl,
    ...group.cues.flatMap((cue) => cue.animation.frames),
  ]).filter(Boolean))];
  const audioUrls = [...new Set(groups.flatMap((group) => group.cues.map((cue) => mediaUrl(cue.assetId))))];
  const urls = [...visualUrls, ...audioUrls];
  console.log(`[prepare] 生成并缓存 ${visualUrls.length} 个单位视觉帧、${audioUrls.length} 条语音`);
  let completed = 0;
  await mapLimit(urls, 4, async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`预览预热失败：${response.status} ${url}`);
    await response.arrayBuffer();
    completed += 1;
    if (completed % 25 === 0 || completed === urls.length) console.log(`[prepare] ${completed}/${urls.length}`);
  });
  return urls;
}

function presentationHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    :root{color-scheme:dark;font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif;background:#080a0d;color:#f5f6f8}
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:radial-gradient(circle at 50% 22%,#27292e 0,#121419 42%,#080a0d 78%)}
    .shell{display:grid;grid-template-rows:238px minmax(0,1fr) 72px;width:100%;height:100%;transition:opacity .28s ease}.carousel{display:grid;place-items:center;padding:38px 34px 28px;border-bottom:1px solid #30343a;background:rgba(13,15,18,.94);overflow:hidden}.unit-track{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.48fr) minmax(0,1fr);align-items:center;gap:20px;width:100%}.unit-peek,.unit-current{display:grid;align-content:center;justify-items:center;min-width:0;height:144px;border-radius:12px;text-align:center;transition:opacity .25s ease,transform .25s ease}.unit-peek{opacity:.3;transform:scale(.82);color:#a7adb7}.unit-peek strong{max-width:100%;overflow:hidden;font-size:25px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.unit-peek span{margin-bottom:10px;color:#717984;font-size:18px}.unit-current{position:relative;padding:21px 24px;border:1px solid rgba(224,75,69,.62);background:linear-gradient(145deg,rgba(125,35,32,.42),rgba(39,25,27,.5));box-shadow:0 22px 60px rgba(0,0,0,.28)}.unit-current strong{max-width:100%;overflow:hidden;font-size:41px;line-height:1.1;text-overflow:ellipsis;white-space:nowrap}.affiliation{margin-top:13px;padding:5px 13px;border:1px solid rgba(224,75,69,.48);border-radius:99px;background:rgba(127,37,33,.26);color:#f08a84;font-size:18px;font-weight:700}
    .content{display:grid;grid-template-rows:minmax(0,1.12fr) minmax(500px,.78fr);gap:30px;min-height:0;padding:34px 46px 28px}.panel{min-height:0;border:1px solid #343941;border-radius:14px;background:rgba(21,24,29,.9);box-shadow:0 28px 80px rgba(0,0,0,.28)}.visual{position:relative;overflow:hidden;background:radial-gradient(circle at 50% 47%,rgba(132,43,39,.27),rgba(22,25,30,.34) 42%,rgba(9,11,14,.76) 79%)}.visual:before{position:absolute;inset:0;content:"";opacity:.15;background:repeating-linear-gradient(0deg,transparent 0,transparent 4px,rgba(255,255,255,.025) 5px);pointer-events:none}.stage-frame{position:absolute;inset:45px 55px 38px;display:grid;place-items:center}.subject{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 27px 24px rgba(0,0,0,.58));transition:opacity .2s ease}.cameo{position:absolute;right:32px;top:30px;width:154px;height:122px;padding:10px;border:1px solid #4a5059;border-radius:8px;background:#101318;object-fit:contain;image-rendering:pixelated;box-shadow:0 15px 38px rgba(0,0,0,.44);transition:opacity .2s ease}
    .voice{display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;padding:35px 42px 38px;transition:opacity .2s ease}.voice-head{display:flex;align-items:center;min-height:54px}.event{display:inline-flex;align-items:center;gap:13px;padding:9px 16px;border:1px solid rgba(224,75,69,.48);border-radius:7px;background:rgba(118,35,32,.25);color:#f37a74;font-size:22px;font-weight:700}.event i{width:9px;height:9px;border-radius:50%;background:#ed5b55;box-shadow:0 0 0 7px rgba(237,91,85,.1)}.transcript{display:grid;align-content:center;gap:30px;min-height:0;padding:26px 2px 4px}.text-block{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:start;gap:22px}.text-label{display:grid;place-items:center;min-height:38px;margin-top:6px;border:1px solid #414750;border-radius:6px;background:#171a1f;color:#9da5af;font-size:17px;font-weight:700}.original,.localized{margin:0;overflow-wrap:anywhere;text-wrap:balance}.original{color:#f7f8fa;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:43px;font-weight:650;line-height:1.32;letter-spacing:.002em}.localized{color:#d1d5db;font-size:36px;font-weight:560;line-height:1.44}.localized-block{padding-top:27px;border-top:1px solid #373c44}.text-block.hidden{display:none}
    .progress-shell{display:grid;align-items:center;padding:0 46px 24px}.progress{height:8px;overflow:hidden;border-radius:99px;background:#292e35;box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}.progress b{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#a93632,#ed5a54);transition:width .22s ease}
    .transition{position:fixed;inset:0;z-index:10;display:grid;place-items:center;background:radial-gradient(circle at 50% 40%,#292b30 0,#121419 48%,#080a0d 100%);opacity:0;pointer-events:none;transition:opacity .42s ease}.transition.visible{opacity:1}.transition-card{width:850px;padding:72px 68px;border:1px solid #3c4149;border-top:4px solid #df4d47;border-radius:10px;background:rgba(20,23,28,.97);box-shadow:0 38px 120px rgba(0,0,0,.56);text-align:center}.transition-card small{display:block;color:#e96a64;font-size:22px;font-weight:700;letter-spacing:.08em}.transition-card small:empty{display:none}.transition-card h2{margin:28px 0 22px;font-size:57px;line-height:1.22}.transition-card p{margin:0;color:#b4bbc5;font-size:29px;line-height:1.62}.transition-card .site{margin-top:42px;color:#858e9a;font-family:"Segoe UI",sans-serif;font-size:21px}
    .changing .unit-track,.changing .subject,.changing .cameo,.changing .voice{opacity:0}.unit-track{transition:opacity .2s ease}
  </style></head><body><div class="shell"><header class="carousel"><div class="unit-track"><div class="unit-peek previous"><span>‹</span><strong></strong></div><div class="unit-current"><strong></strong><span class="affiliation"></span></div><div class="unit-peek next"><span>›</span><strong></strong></div></div></header><main class="content"><section class="panel visual"><div class="stage-frame"><img class="subject" alt="单位动画"></div><img class="cameo" alt="单位图标"></section><section class="panel voice"><div class="voice-head"><span class="event"><i></i><b></b></span></div><div class="transcript"><div class="text-block original-block"><span class="text-label">原文</span><p class="original"></p></div><div class="text-block localized-block"><span class="text-label translation-label"></span><p class="localized"></p></div></div></section></main><footer class="progress-shell"><div class="progress"><b></b></div></footer></div><div class="transition"><div class="transition-card"><small></small><h2></h2><p></p><div class="site"></div></div></div><audio id="voice-audio" preload="auto"></audio><script>
    window.__voiceTimer=0;window.__setFrames=(frames,interval)=>{clearInterval(window.__voiceTimer);const image=document.querySelector('.subject');let index=0;const apply=()=>{image.src=frames[index]||''};apply();if(frames.length>1)window.__voiceTimer=setInterval(()=>{index=(index+1)%frames.length;apply()},Math.max(70,interval||110))};
  </script></body></html>`;
}

async function installPresentation(page, kind, groups) {
  await page.setContent(presentationHtml(), { waitUntil: "domcontentloaded" });
  await page.evaluate(({ kind, groups, pagesUrl }) => {
    document.querySelector(".transition-card .site").textContent = pagesUrl;
    window.__voicePresentation = { kind, groups };
  }, {
    kind,
    groups,
    pagesUrl: CONFIG.pagesUrl,
  });

  const urls = [...new Set(groups.flatMap((group) => [
    group.cameoUrl,
    ...group.cues.flatMap((cue) => cue.animation.frames),
  ]).filter(Boolean))];
  await page.evaluate(async (values) => {
    await Promise.all(values.map((src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => image.decode().catch(() => undefined).finally(resolve);
      image.onerror = () => reject(new Error(`浏览器预载失败：${src}`));
      image.src = src;
    })));
  }, urls);
  const audioAssets = [...new Map(groups.flatMap((group) => group.cues).map((cue) => [
    cue.assetId,
    mediaUrl(cue.assetId),
  ])).entries()];
  console.log(`[prepare] 浏览器预载 ${audioAssets.length} 条语音到内存`);
  await page.evaluate(async (assets) => {
    const objectUrls = {};
    let cursor = 0;
    async function worker() {
      while (cursor < assets.length) {
        const [assetId, url] = assets[cursor];
        cursor += 1;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`语音预载失败：${response.status} ${url}`);
        objectUrls[assetId] = URL.createObjectURL(await response.blob());
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, assets.length) }, worker));
    window.__voiceMediaUrls = objectUrls;
  }, audioAssets);
}

async function showTransition(page, eyebrow, title, detail, durationSeconds) {
  await page.evaluate(({ eyebrow, title, detail }) => {
    const overlay = document.querySelector(".transition");
    overlay.querySelector("small").textContent = eyebrow;
    overlay.querySelector("h2").textContent = title;
    overlay.querySelector("p").textContent = detail;
    overlay.classList.add("visible");
  }, { eyebrow, title, detail });
  await page.waitForTimeout(420);
  await page.waitForTimeout(Math.max(0, durationSeconds * 1000 - 840));
  await page.evaluate(() => document.querySelector(".transition").classList.remove("visible"));
  await page.waitForTimeout(420);
}

async function showUnit(page, groups, groupIndex) {
  await page.evaluate(() => document.body.classList.add("changing"));
  await page.waitForTimeout(210);
  const group = groups[groupIndex];
  const previous = groups[groupIndex - 1]?.representative.name || "";
  const next = groups[groupIndex + 1]?.representative.name || "";
  await page.evaluate(({ group, previous, next }) => {
    document.querySelector(".previous strong").textContent = previous;
    document.querySelector(".next strong").textContent = next;
    document.querySelector(".previous").style.visibility = previous ? "visible" : "hidden";
    document.querySelector(".next").style.visibility = next ? "visible" : "hidden";
    document.querySelector(".unit-current strong").textContent = group.representative.name;
    document.querySelector(".affiliation").textContent = group.representative.affiliation;
    const cameo = document.querySelector(".cameo");
    cameo.src = group.cameoUrl || "";
    cameo.style.display = group.cameoUrl ? "block" : "none";
    const animation = group.cues[0]?.animation || { frames: [], intervalMs: 110 };
    window.__setFrames(animation.frames, animation.intervalMs);
    document.querySelector(".event b").textContent = "";
    document.querySelector(".original").textContent = "";
    document.querySelector(".localized").textContent = "";
    document.querySelector(".translation-label").textContent = "";
    document.querySelector(".original-block").classList.add("hidden");
    document.querySelector(".localized-block").classList.add("hidden");
    document.body.classList.remove("changing");
  }, { group, previous, next });
  await page.waitForTimeout(CONFIG.visual.unitIntroSeconds * 1000);
}

async function showCue(page, group, cue, cueIndex, segmentCueIndex, totalCues) {
  await page.evaluate(({ cue, segmentCueIndex, totalCues }) => {
    const original = cue.original || cue.translated || cue.localized || cue.assetName || "";
    const chinese = cue.translated || cue.localized || "";
    document.querySelector(".event b").textContent = cue.eventLabel;
    document.querySelector(".original").textContent = original;
    document.querySelector(".localized").textContent = chinese;
    document.querySelector(".translation-label").textContent = cue.translated ? "译文" : cue.localized ? "中文" : "";
    document.querySelector(".original-block").classList.toggle("hidden", !original);
    document.querySelector(".localized-block").classList.toggle("hidden", !chinese || chinese === original);
    document.querySelector(".progress b").style.width = `${((segmentCueIndex + 1) / totalCues) * 100}%`;
    window.__setFrames(cue.animation.frames, cue.animation.intervalMs);
  }, {
    cue,
    segmentCueIndex,
    totalCues,
  });
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
    const audio = document.getElementById("voice-audio");
    if (typeof audio.setSinkId !== "function") throw new Error("当前 Chromium 不支持 setSinkId");
    await audio.setSinkId(cable.deviceId);
    window.__voiceCableSinkId = cable.deviceId;
    return { outputLabel: cable.label, sinkIdApplied: audio.sinkId === cable.deviceId };
  });
}

async function playCue(page, cue) {
  return page.evaluate(async ({ assetId, fallbackSrc, expectedDuration }) => {
    const audio = document.getElementById("voice-audio");
    audio.pause();
    const src = window.__voiceMediaUrls?.[assetId] || fallbackSrc;
    audio.src = src;
    audio.currentTime = 0;
    if (window.__voiceCableSinkId && audio.sinkId !== window.__voiceCableSinkId) {
      await audio.setSinkId(window.__voiceCableSinkId);
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`音频载入超时：${src}`)), 12000);
      const ready = () => { clearTimeout(timeout); resolve(); };
      audio.addEventListener("canplaythrough", ready, { once: true });
      audio.addEventListener("error", () => reject(new Error(`音频载入失败：${src}`)), { once: true });
      audio.load();
    });
    const started = new Promise((resolve) => audio.addEventListener("playing", () => resolve(Date.now()), { once: true }));
    const ended = new Promise((resolve) => audio.addEventListener("ended", resolve, { once: true }));
    await audio.play();
    const startedAt = await started;
    await Promise.race([
      ended,
      new Promise((resolve) => setTimeout(resolve, Math.max(2500, (expectedDuration + 2) * 1000))),
    ]);
    audio.pause();
    return startedAt;
  }, {
    assetId: cue.assetId,
    fallbackSrc: mediaUrl(cue.assetId),
    expectedDuration: Number(cue.durationSeconds || 2),
  });
}

async function startCableCapture(target) {
  const child = spawn("ffmpeg.exe", [
    "-hide_banner", "-loglevel", "info", "-y",
    "-thread_queue_size", "512", "-f", "dshow",
    "-i", `audio=${CONFIG.audio.captureDevice}`,
    "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", target,
  ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  const readyAt = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`CABLE 录音设备启动超时：${stderr.slice(-1600)}`));
    }, 10000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!settled && stderr.includes("Output #0")) {
        settled = true;
        clearTimeout(timer);
        resolve(Date.now());
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CABLE 录音进程提前退出（${code}）：${stderr.slice(-1600)}`));
    });
  });
  return { child, target, readyAt, stderr: () => stderr };
}

async function stopCableCapture(capture) {
  if (!capture || capture.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => { capture.child.kill(); resolve(); }, 10000);
    capture.child.once("exit", () => { clearTimeout(timeout); resolve(); });
    capture.child.stdin.write("q\n");
  });
  if (!fs.existsSync(capture.target) || fs.statSync(capture.target).size < 1024) {
    throw new Error(`CABLE 录音文件无效：${capture.stderr().slice(-1600)}`);
  }
}

function measureCableLatency(segment, target) {
  const result = spawnSync("ffmpeg.exe", [
    "-hide_banner", "-i", target,
    "-af", "silencedetect=noise=-45dB:d=0.25", "-f", "null", "NUL",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || !segment.audioCues.length) return 0;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const starts = Array.from(output.matchAll(/silence_end:\s*([0-9.]+)/g), (match) => Number(match[1]));
  const expected = segment.audioCues[0].start - segment.cableCaptureStart;
  const observed = starts.find((value) => value >= Math.max(0, expected - 0.4) && value <= expected + 2);
  return observed === undefined ? 0 : Number(Math.max(0, observed - expected).toFixed(3));
}

async function startHighQualityRecording(context, page, target) {
  const session = await context.newCDPSession(page);
  const child = spawn("ffmpeg.exe", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0",
    "-an", "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "10",
    "-pix_fmt", "yuv420p", "-vf", `scale=${SOURCE_WIDTH}:${SOURCE_HEIGHT}:flags=lanczos`, target,
  ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  let lastFrame;
  let firstTimestamp;
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
    if (child.stdin.writableEnded || child.stdin.destroyed) return reject(new Error(`高清录屏输入管道已关闭：${stderr.slice(-1600)}`));
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
      if (repeat > 0) { enqueue(lastFrame, repeat); emittedFrames += repeat; }
    } else {
      firstTimestamp = timestamp;
    }
    lastFrame = Buffer.from(event.data, "base64");
    if (firstFrameResolve) { firstFrameResolve(); firstFrameResolve = undefined; }
  });
  const startedAt = Date.now();
  await session.send("Page.startScreencast", {
    format: "jpeg", quality: 100, maxWidth: SOURCE_WIDTH, maxHeight: SOURCE_HEIGHT, everyNthFrame: 1,
  });
  await Promise.race([firstFrame, new Promise((_, reject) => setTimeout(() => reject(new Error("高清录屏未收到首帧")), 10000))]);
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
      return { emittedFrames, duration: emittedFrames / FPS };
    },
  };
}

async function recordSection(browser, kind, groups) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: CONFIG.viewport.deviceScaleFactor,
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    if (failure?.errorText !== "net::ERR_ABORTED") failedRequests.push({ url: request.url(), error: failure?.errorText || "failed" });
  });
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await installPresentation(page, kind, groups);
  const routing = await prepareCableAudio(page);
  const rawTarget = path.join(RAW_DIR, `${kind}.mkv`);
  const audioTarget = path.join(AUDIO_DIR, `${kind}-cable.wav`);
  const segment = {
    id: kind,
    index: kind === "infantry" ? 1 : 2,
    title: SECTION_LABELS[kind],
    groups: groups.map((group) => ({
      id: group.representative.id,
      name: group.representative.name,
      units: group.units,
      cueCount: group.cues.length,
      skippedInvalidSequences: group.invalidSequenceEvents,
    })),
    expectedCueCount: groups.reduce((total, group) => total + group.cues.length, 0),
    groupChapters: [],
    audioCues: [],
    errors,
    failedRequests,
    cableRouting: routing,
  };
  let videoCapture;
  let cableCapture;
  try {
    videoCapture = await startHighQualityRecording(context, page, rawTarget);
    segment.startedAt = videoCapture.startedAt;
    cableCapture = await startCableCapture(audioTarget);
    segment.cableCaptureStart = (cableCapture.readyAt - segment.startedAt) / 1000;
    segment.cableCapture = path.relative(RUN_DIR, audioTarget).replaceAll("\\", "/");
    segment.cablePresentationDelay = CONFIG.audio.presentationDelaySeconds;
    await showTransition(
      page,
      "资源支持 · ra2-explorer",
      SECTION_LABELS[kind],
      "逐一展示单位、动作、英文原文与中文译文",
      CONFIG.visual.sectionIntroSeconds,
    );
    let segmentCueIndex = 0;
    for (const [groupIndex, group] of groups.entries()) {
      console.log(`[record] ${SECTION_LABELS[kind]} ${groupIndex + 1}/${groups.length} ${group.representative.name} (${group.cues.length})`);
      const groupStartedAt = Date.now();
      await showUnit(page, groups, groupIndex);
      for (const [cueIndex, cue] of group.cues.entries()) {
        await showCue(page, group, cue, cueIndex, segmentCueIndex, segment.expectedCueCount);
        await page.waitForTimeout(CONFIG.audio.cueLeadSeconds * 1000);
        const startedAt = await playCue(page, cue);
        segment.audioCues.push({
          assetId: cue.assetId,
          unitId: group.representative.id,
          unitName: group.representative.name,
          slot: cue.slot,
          eventLabel: cue.eventLabel,
          original: cue.original,
          localized: cue.localized,
          translated: cue.translated,
          textLabel: cue.textLabel,
          animationEvent: cue.animation.event,
          duration: cue.durationSeconds,
          start: Math.max(0, (startedAt - segment.startedAt) / 1000),
        });
        segmentCueIndex += 1;
        await page.waitForTimeout(CONFIG.audio.cueGapSeconds * 1000);
      }
      segment.groupChapters.push({
        id: group.representative.id,
        title: group.representative.name,
        start: Math.max(0, (groupStartedAt - segment.startedAt) / 1000),
        end: Math.max(0, (Date.now() - segment.startedAt) / 1000),
      });
    }
    await page.screenshot({ path: path.join(POSTER_DIR, `${kind}.png`) });
    await page.evaluate(() => { document.querySelector(".shell").style.opacity = "0"; });
    await page.waitForTimeout(CONFIG.visual.sectionOutroSeconds * 1000);
  } finally {
    if (cableCapture) {
      await stopCableCapture(cableCapture).catch((error) => errors.push(error.stack || String(error)));
      segment.cableCaptureLatency = measureCableLatency(segment, audioTarget);
    }
    if (videoCapture) {
      segment.capture = {
        method: "Chrome DevTools screencast",
        sourceResolution: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
        frameRate: FPS,
        jpegQuality: 100,
        codec: "H.264 CRF 10",
        ...await videoCapture.stop().catch((error) => {
          errors.push(error.stack || String(error));
          return {};
        }),
      };
    }
    await context.close();
  }
  segment.rawVideo = path.relative(RUN_DIR, rawTarget).replaceAll("\\", "/");
  delete segment.startedAt;
  return segment;
}

async function main() {
  if (!["all", "infantry"].includes(KIND_FILTER)) throw new Error(`本期仅录制苏军步兵，未知分类：${KIND_FILTER}`);
  const plan = runPlanner();
  const kinds = ["infantry"];
  const selectedGroups = Object.fromEntries(kinds.map((kind) => {
    const groups = prepareGroups(plan.groups.filter((group) => group.kind === kind), plan.source.id);
    return [kind, SMOKE ? groups.slice(0, 1).map((group) => ({ ...group, cues: group.cues.slice(0, 2) })) : groups];
  }));
  for (const kind of kinds) {
    if (!selectedGroups[kind].length) throw new Error(`${kind} 没有可录制的单位声音`);
    await prewarmBackend(selectedGroups[kind]);
  }
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--mute-audio"],
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const manifest = {
    schemaVersion: 1,
    title: "苏军步兵单位语音全览",
    appUrl: BASE_URL,
    appVersion: plan.appVersion,
    pagesUrl: CONFIG.pagesUrl,
    recordedAt: new Date().toISOString(),
    resolution: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    frameRate: FPS,
    smoke: SMOKE,
    selection: plan.selection,
    planSummary: plan.summary,
    excludedUnits: plan.excludedUnits,
    segments: [],
  };
  try {
    for (const kind of kinds) {
      const segment = await recordSection(browser, kind, selectedGroups[kind]);
      manifest.segments.push(segment);
      fs.writeFileSync(path.join(RUN_DIR, "recording-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(RUN_DIR, "recording-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(ROOT, "latest-soviet-voices.txt"), RUN_DIR, "utf8");
  console.log(JSON.stringify({
    runDirectory: RUN_DIR,
    segments: manifest.segments.map((segment) => ({ id: segment.id, cues: segment.audioCues.length, errors: segment.errors.length })),
  }, null, 2));
  if (manifest.segments.some((segment) => segment.errors.length || segment.audioCues.length !== segment.expectedCueCount)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
