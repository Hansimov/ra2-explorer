const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "voice-video.config.json"), "utf8"));
const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const BASE_URL = (positional[0] || "http://127.0.0.1:46120/").replace(/\/+$/, "");
const KIND_FILTER = positional[1] || "all";
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
};
const SECTION_LABELS = { infantry: "苏军步兵语音", vehicle: "苏军载具语音" };

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

function assetPreviewUrl(assetId, frame, shadowFrame, scale = 12) {
  const params = new URLSearchParams({
    frame: String(frame),
    scale: String(scale),
    player_color: CONFIG.visual.playerColor,
    palette_kind: "unit",
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

function sequenceForSlot(visual, slot) {
  const sequences = visual.sequences || [];
  const preferences = {
    attack: [/fireup|fireprone|fire|attack|shoot/i, /walk|ready|guard/i],
    move: [/walk|fly|swim|crawl|move/i, /idle|ready|guard/i],
    feedback: [/ready|guard|idle|walk/i],
    select: [/idle|ready|guard|walk/i],
    create: [/idle|ready|guard|walk/i],
  };
  for (const expression of preferences[slot] || preferences.select) {
    const match = sequences.find((sequence) => sequenceMatches(sequence, expression));
    if (match) return match;
  }
  return sequences[0] || null;
}

function sequenceUrls(group, slot, sourceId) {
  const visual = group.representative.visual;
  if (visual.bodyFormat === "vxl") {
    const facingOrder = [0, 7, 6, 5, 4, 3, 2, 1];
    return facingOrder.map((facing) => entityPreviewUrl(sourceId, group.representative.id, facing));
  }
  const sequence = sequenceForSlot(visual, slot);
  if (!sequence) return [entityPreviewUrl(sourceId, group.representative.id, 5)];
  const pairedShadow = visual.sourceFrameCount === visual.contentFrameCount * 2;
  const shadowOffset = pairedShadow ? visual.contentFrameCount : 0;
  const facingOffset = sequence.facing_step
    ? 5 * sequence.facing_step
    : 0;
  return Array.from({ length: Math.min(24, Math.max(1, Number(sequence.frame_count) || 1)) }, (_, index) => {
    const frame = Number(sequence.start_frame || 0)
      + facingOffset
      + index * Math.max(1, Number(sequence.frame_step || 1));
    return assetPreviewUrl(sequence.assetId, frame, pairedShadow ? frame + shadowOffset : undefined);
  });
}

function prepareGroups(groups, sourceId) {
  return groups.map((group) => {
    const slots = [...new Set(group.cues.map((cue) => cue.events[0]?.slot || "select"))];
    const framesBySlot = Object.fromEntries(slots.map((slot) => [slot, sequenceUrls(group, slot, sourceId)]));
    const cues = group.cues.map((cue) => {
      const event = cue.events[0] || {};
      return {
        ...cue,
        slot: event.slot || "select",
        eventLabel: EVENT_LABELS[event.slot] || "单位回应",
        eventName: event.event || "",
      };
    });
    return {
      ...group,
      cameoUrl: entityPreviewUrl(sourceId, group.representative.id, group.representative.visual.bodyFormat === "vxl" ? 0 : 5, 5),
      framesBySlot,
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
    ...Object.values(group.framesBySlot).flat(),
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
    :root{color-scheme:dark;font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif;background:#090b0e;color:#f4f5f7}
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:radial-gradient(circle at 64% 18%,#26272a 0,#121419 37%,#090b0e 74%)}
    .shell{display:grid;grid-template-columns:300px 1fr;width:100%;height:100%}.sidebar{display:grid;grid-template-rows:auto auto 1fr auto;border-right:1px solid #30343a;background:rgba(13,15,18,.96);box-shadow:14px 0 50px rgba(0,0,0,.22)}
    .brand{display:flex;align-items:center;gap:14px;padding:25px 24px 20px;border-bottom:1px solid #282c32}.mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid #a63d38;background:#3b1a1a;color:#fff;font-family:Georgia,serif;font-size:25px;font-style:italic}.brand strong{display:block;font-size:19px;letter-spacing:.025em}.brand span{display:block;margin-top:3px;color:#858c97;font-size:12px}
    .section{padding:20px 24px 12px;color:#ef645e;font-size:14px;font-weight:700;letter-spacing:.12em}.unit-list{min-height:0;padding:0 13px 14px;overflow:hidden}.unit{display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:10px;width:100%;min-height:49px;margin:3px 0;padding:7px 10px;border:1px solid transparent;border-radius:5px;background:transparent;color:#aeb4bd;text-align:left}.unit.active{border-color:rgba(224,75,69,.58);background:linear-gradient(90deg,rgba(128,35,32,.38),rgba(50,29,30,.22));color:#fff}.unit.done{color:#737b86}.unit img{width:36px;height:30px;object-fit:contain;image-rendering:pixelated}.unit span{overflow:hidden;font-size:14px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.unit b{color:#747c87;font-size:11px;font-weight:600}.unit.active b{color:#e4716c}
    .sidebar-foot{padding:14px 22px 21px;border-top:1px solid #282c32;color:#737b86;font-size:12px;line-height:1.7}.sidebar-foot strong{color:#b7bdc6;font-weight:600}
    main{display:grid;grid-template-rows:76px 1fr 64px;min-width:0;min-height:0}.top{display:flex;align-items:center;justify-content:space-between;padding:0 34px;border-bottom:1px solid #30343a;background:rgba(18,20,24,.82)}.top h1{margin:0;font-size:22px;letter-spacing:.02em}.top h1 span{margin-left:12px;color:#7d858f;font-size:14px;font-weight:500}.counter{color:#a7adb6;font-size:14px}.counter strong{color:#f0f1f3;font-size:18px}
    .content{display:grid;grid-template-columns:minmax(500px,.9fr) minmax(650px,1.1fr);gap:28px;min-height:0;padding:28px 34px 24px}.panel{min-height:0;border:1px solid #333840;border-radius:7px;background:rgba(21,24,29,.88);box-shadow:0 26px 70px rgba(0,0,0,.25)}
    .visual{position:relative;display:grid;grid-template-rows:1fr auto;overflow:hidden;background:radial-gradient(circle at 50% 45%,rgba(115,42,39,.27),rgba(21,24,29,.22) 42%,rgba(10,12,15,.65) 78%)}.visual:before{position:absolute;inset:0;content:"";opacity:.17;background:repeating-linear-gradient(0deg,transparent 0,transparent 3px,rgba(255,255,255,.025) 4px);pointer-events:none}.stage{position:relative;display:grid;min-height:0;place-items:center;padding:32px 34px 12px}.subject{max-width:92%;max-height:92%;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 22px 20px rgba(0,0,0,.54));transition:opacity .16s ease}.cameo{position:absolute;right:22px;bottom:17px;width:112px;height:90px;padding:7px;border:1px solid #444a53;border-radius:4px;background:#101318;object-fit:contain;image-rendering:pixelated;box-shadow:0 12px 30px rgba(0,0,0,.42)}
    .unit-meta{position:relative;padding:17px 22px 20px;border-top:1px solid #333840;background:rgba(14,16,20,.85)}.unit-line{display:flex;align-items:center;gap:12px;min-width:0}.unit-name{margin:0;font-size:28px;line-height:1.25}.affiliation{padding:4px 9px;border:1px solid rgba(224,75,69,.48);border-radius:99px;background:rgba(127,37,33,.25);color:#f18a85;font-size:12px;font-weight:700}.shared{margin-top:8px;overflow:hidden;color:#949ba5;font-size:13px;text-overflow:ellipsis;white-space:nowrap}
    .voice{display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;padding:28px 34px 25px}.voice-head{display:flex;align-items:center;justify-content:space-between;gap:18px}.event{display:inline-flex;align-items:center;gap:9px;padding:7px 12px;border:1px solid rgba(224,75,69,.45);border-radius:4px;background:rgba(118,35,32,.24);color:#f07771;font-size:15px;font-weight:700}.event i{width:7px;height:7px;border-radius:50%;background:#ed5b55;box-shadow:0 0 0 5px rgba(237,91,85,.1)}.voice-index{color:#747c87;font-size:13px}.voice-index strong{color:#d7dbe0;font-size:17px}
    .quote{display:grid;align-content:center;min-height:0;padding:28px 0}.original{margin:0;color:#fff;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:42px;font-weight:650;line-height:1.27;letter-spacing:.005em;text-wrap:balance}.original:before{content:"“";margin-right:5px;color:#e15751}.original:after{content:"”";margin-left:5px;color:#e15751}.localized{margin:24px 0 0;padding-top:22px;border-top:1px solid #343941;color:#c6cbd2;font-size:27px;line-height:1.5;text-wrap:balance}.localized:empty{display:none}
    .voice-foot{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:18px;padding-top:18px;border-top:1px solid #343941}.wave{display:flex;align-items:center;gap:4px;width:80px;height:25px}.wave i{display:block;width:4px;height:7px;border-radius:2px;background:#5d646e}.wave.playing i{background:#e25a54;animation:meter .72s ease-in-out infinite alternate}.wave i:nth-child(2n){animation-delay:-.24s}.wave i:nth-child(3n){animation-delay:-.42s}.voice-id{overflow:hidden;color:#79818c;font-family:Consolas,monospace;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.duration{color:#969da7;font-size:13px}
    .bottom{display:grid;grid-template-columns:1fr auto;align-items:center;gap:24px;padding:0 34px;border-top:1px solid #30343a;background:#101217}.progress{height:4px;overflow:hidden;border-radius:2px;background:#2d3239}.progress b{display:block;width:0;height:100%;background:linear-gradient(90deg,#b53d38,#ee625c);transition:width .25s ease}.bottom span{color:#858c96;font-size:13px}
    .transition{position:fixed;inset:0;z-index:10;display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,#282a2f 0,#121419 45%,#090b0e 100%);opacity:0;pointer-events:none;transition:opacity .38s ease}.transition.visible{opacity:1}.transition-card{width:min(980px,76vw);padding:58px 66px;border:1px solid #3b4048;border-top:3px solid #df4d47;background:rgba(20,23,28,.96);box-shadow:0 36px 110px rgba(0,0,0,.54)}.transition-card small{color:#e96660;font-size:16px;font-weight:700;letter-spacing:.14em}.transition-card h2{margin:24px 0 12px;font-size:49px;line-height:1.2}.transition-card p{margin:0;color:#aeb5bf;font-size:22px;line-height:1.6}.transition-card .site{margin-top:34px;color:#7f8792;font-size:15px}
    .changing .subject,.changing .unit-meta,.changing .voice{opacity:.18}.subject,.unit-meta,.voice{transition:opacity .2s ease}
    @keyframes meter{from{height:6px}to{height:24px}}
  </style></head><body><div class="shell"><aside class="sidebar"><div class="brand"><span class="mark">R</span><div><strong>RA2 Explorer</strong><span>红色警戒 2 资产浏览器</span></div></div><div class="section"></div><div class="unit-list"></div><div class="sidebar-foot"><strong>带台词的单位语音</strong><br>按游戏事件顺序逐条播放</div></aside><main><header class="top"><h1></h1><div class="counter">语音 <strong>0 / 0</strong></div></header><section class="content"><article class="panel visual"><div class="stage"><img class="subject" alt="单位动画"><img class="cameo" alt="单位图标"></div><div class="unit-meta"><div class="unit-line"><h2 class="unit-name"></h2><span class="affiliation"></span></div><div class="shared"></div></div></article><article class="panel voice"><div class="voice-head"><span class="event"><i></i><b></b></span><span class="voice-index"><strong>0</strong> / 0</span></div><div class="quote"><p class="original"></p><p class="localized"></p></div><div class="voice-foot"><span class="wave">${"<i></i>".repeat(13)}</span><span class="voice-id"></span><span class="duration"></span></div></article></section><footer class="bottom"><div class="progress"><b></b></div><span></span></footer></main></div><div class="transition"><div class="transition-card"><small></small><h2></h2><p></p><div class="site"></div></div></div><audio id="voice-audio" preload="auto"></audio><script>
    window.__voiceTimer=0;window.__setFrames=(frames,interval)=>{clearInterval(window.__voiceTimer);const image=document.querySelector('.subject');let index=0;image.src=frames[0]||'';if(frames.length>1)window.__voiceTimer=setInterval(()=>{index=(index+1)%frames.length;image.src=frames[index]},interval)};
  </script></body></html>`;
}

async function installPresentation(page, kind, groups) {
  await page.setContent(presentationHtml(), { waitUntil: "domcontentloaded" });
  await page.evaluate(({ kind, groups, sectionLabel, pagesUrl, appVersion, totalCues }) => {
    document.querySelector(".section").textContent = sectionLabel;
    document.querySelector(".top h1").innerHTML = `${sectionLabel}<span>带台词语音逐条展示</span>`;
    document.querySelector(".sidebar-foot").lastChild.textContent = ` · v${appVersion}`;
    const list = document.querySelector(".unit-list");
    groups.forEach((group, index) => {
      const row = document.createElement("div");
      row.className = "unit";
      row.dataset.index = String(index);
      const image = document.createElement("img");
      if (group.cameoUrl) image.src = group.cameoUrl;
      const name = document.createElement("span");
      name.textContent = group.representative.name;
      const count = document.createElement("b");
      count.textContent = String(group.cues.length);
      row.append(image, name, count);
      list.appendChild(row);
    });
    document.querySelector(".transition-card .site").textContent = pagesUrl;
    document.querySelector(".counter strong").textContent = `0 / ${totalCues}`;
    window.__voicePresentation = { kind, groups };
  }, {
    kind,
    groups,
    sectionLabel: SECTION_LABELS[kind],
    pagesUrl: CONFIG.pagesUrl,
    appVersion: CONFIG.appVersion,
    totalCues: groups.reduce((total, group) => total + group.cues.length, 0),
  });

  const urls = [...new Set(groups.flatMap((group) => [
    group.cameoUrl,
    ...Object.values(group.framesBySlot).flat(),
  ]).filter(Boolean))];
  await page.evaluate(async (values) => {
    await Promise.all(values.map((src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
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

async function showUnit(page, group, groupIndex, completedGroups) {
  await page.evaluate(({ group, groupIndex, completedGroups, interval }) => {
    document.body.classList.add("changing");
    document.querySelectorAll(".unit").forEach((row, index) => {
      row.classList.toggle("active", index === groupIndex);
      row.classList.toggle("done", index < completedGroups);
    });
    document.querySelector(".unit-name").textContent = group.representative.name;
    document.querySelector(".affiliation").textContent = group.representative.affiliation;
    const shared = group.units.map((unit) => unit.name).filter((name, index, values) => values.indexOf(name) === index);
    document.querySelector(".shared").textContent = shared.length > 1 ? `共同语音：${shared.join(" · ")}` : group.representative.usage === "hero" ? "英雄单位" : "";
    const cameo = document.querySelector(".cameo");
    cameo.src = group.cameoUrl || "";
    cameo.style.display = group.cameoUrl ? "block" : "none";
    const firstSlot = group.cues[0]?.slot || "select";
    window.__setFrames(group.framesBySlot[firstSlot] || Object.values(group.framesBySlot)[0] || [], interval);
    document.querySelector(".event b").textContent = "语音清单";
    document.querySelector(".voice-index strong").textContent = "00";
    document.querySelector(".voice-index").lastChild.textContent = ` / ${String(group.cues.length).padStart(2, "0")}`;
    document.querySelector(".original").textContent = `共 ${group.cues.length} 条带台词语音`;
    document.querySelector(".localized").textContent = "";
    document.querySelector(".voice-id").textContent = "";
    document.querySelector(".duration").textContent = "";
    setTimeout(() => document.body.classList.remove("changing"), 210);
  }, { group, groupIndex, completedGroups, interval: group.representative.visual.bodyFormat === "vxl" ? CONFIG.visual.voxelFacingIntervalMs : CONFIG.visual.frameIntervalMs });
  await page.waitForTimeout(CONFIG.visual.unitIntroSeconds * 1000);
}

async function showCue(page, group, cue, cueIndex, segmentCueIndex, totalCues) {
  const frames = group.framesBySlot[cue.slot] || Object.values(group.framesBySlot)[0] || [];
  await page.evaluate(({ cue, cueIndex, cueCount, segmentCueIndex, totalCues, frames, interval }) => {
    document.querySelector(".event b").textContent = cue.eventLabel;
    document.querySelector(".voice-index strong").textContent = String(cueIndex + 1).padStart(2, "0");
    document.querySelector(".voice-index").lastChild.textContent = ` / ${String(cueCount).padStart(2, "0")}`;
    document.querySelector(".original").textContent = cue.original || cue.localized;
    document.querySelector(".localized").textContent = cue.localized || "";
    document.querySelector(".voice-id").textContent = "";
    document.querySelector(".duration").textContent = `${Number(cue.durationSeconds || 0).toFixed(1)} 秒`;
    document.querySelector(".counter strong").textContent = `${segmentCueIndex + 1} / ${totalCues}`;
    document.querySelector(".progress b").style.width = `${((segmentCueIndex + 1) / totalCues) * 100}%`;
    document.querySelector(".bottom span").textContent = `${cue.eventLabel} · ${cueIndex + 1}/${cueCount}`;
    document.querySelector(".wave").classList.remove("playing");
    window.__setFrames(frames, interval);
  }, {
    cue,
    cueIndex,
    cueCount: group.cues.length,
    segmentCueIndex,
    totalCues,
    frames,
    interval: group.representative.visual.bodyFormat === "vxl" ? CONFIG.visual.voxelFacingIntervalMs : CONFIG.visual.frameIntervalMs,
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
    document.querySelector(".wave").classList.add("playing");
    await audio.play();
    const startedAt = await started;
    await Promise.race([
      ended,
      new Promise((resolve) => setTimeout(resolve, Math.max(2500, (expectedDuration + 2) * 1000))),
    ]);
    audio.pause();
    document.querySelector(".wave").classList.remove("playing");
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
      kind === "infantry" ? "INFANTRY VOICES" : "VEHICLE VOICES",
      SECTION_LABELS[kind],
      `共 ${groups.length} 组单位、${segment.expectedCueCount} 条带台词语音`,
      CONFIG.visual.sectionIntroSeconds,
    );
    let segmentCueIndex = 0;
    for (const [groupIndex, group] of groups.entries()) {
      console.log(`[record] ${SECTION_LABELS[kind]} ${groupIndex + 1}/${groups.length} ${group.representative.name} (${group.cues.length})`);
      const groupStartedAt = Date.now();
      await showUnit(page, group, groupIndex, groupIndex);
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
    await showTransition(page, "RA2 EXPLORER", `${SECTION_LABELS[kind]}展示完成`, `${segment.expectedCueCount} 条带台词语音已全部播放`, CONFIG.visual.sectionOutroSeconds);
    await page.screenshot({ path: path.join(POSTER_DIR, `${kind}.png`) });
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
  if (!["all", "infantry", "vehicle"].includes(KIND_FILTER)) throw new Error(`未知分类：${KIND_FILTER}`);
  const plan = runPlanner();
  const kinds = KIND_FILTER === "all" ? ["infantry", "vehicle"] : [KIND_FILTER];
  const selectedGroups = Object.fromEntries(kinds.map((kind) => {
    const groups = prepareGroups(plan.groups.filter((group) => group.kind === kind), plan.source.id);
    return [kind, SMOKE ? groups.slice(0, 1).map((group) => ({ ...group, cues: group.cues.slice(0, 2) })) : groups];
  }));
  for (const kind of kinds) {
    if (!selectedGroups[kind].length) throw new Error(`${kind} 没有可录制的带台词语音`);
    await prewarmBackend(selectedGroups[kind]);
  }
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--mute-audio"],
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const manifest = {
    schemaVersion: 1,
    title: "RA2 Explorer 苏军单位语音全览",
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
