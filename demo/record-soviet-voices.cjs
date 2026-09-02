const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");
const { animationMatchesSlot, chooseCueEvent, eventLabel } = require("./voice-event-semantics.cjs");

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

function assetPreviewUrl(assetId, frame, shadowFrame, scale = 12, options = {}) {
  const { paletteKind = "unit", paletteId = "", playerColor = CONFIG.visual.playerColor } = options;
  const params = new URLSearchParams({
    frame: String(frame),
    scale: String(scale),
  });
  if (playerColor) params.set("player_color", playerColor);
  if (paletteKind) params.set("palette_kind", paletteKind);
  if (paletteId) params.set("palette_id", paletteId);
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

function sequenceNamed(sequence, names) {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  return [sequence.event, ...(sequence.aliases || [])]
    .some((value) => accepted.has(String(value).toLowerCase()));
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

function sequenceCandidatesForSlot(visual, slot, unitId, eventName) {
  const sequences = (visual.sequences || []).filter((sequence) => validSequence(visual, sequence));
  const flying = sequences.some((sequence) => sequenceNamed(sequence, ["fly"]));
  const weaponPreferences = /deploy/i.test(String(eventName || ""))
    ? [["deployedfire"], ["deploy"], ["fireup"]]
    : unitId === "LUNR" ? [["firefly"], ["fireup"]]
      : ["TERROR", "IVAN"].includes(unitId) ? [["deploy"], ["fireup"]]
        : [["fireup"], ["deployedfire"], ["fireprone"]];
  const preferences = {
    select: [["idle1", "idle2", "ready", "guard"], ["cheer"], ["walk"]],
    create: [["cheer"], ["idle1", "idle2"], ["walk"]],
    move: flying ? [["fly"], ["walk"]] : [["walk", "swim"], ["idle1", "idle2"]],
    enter: [["walk", "enter"], ["idle1", "idle2"]],
    capture: [["walk", "capture"], ["deploy"], ["idle1", "idle2"]],
    deploy: [["deploy"], ["deployedfire"], ["down"], ["idle1", "idle2"]],
    harvest: [["work", "harvest"], ["walk"], ["idle1", "idle2"]],
    attack: (
      unitId === "LUNR" ? [["firefly"], ["fireup"]]
        : ["TERROR", "IVAN"].includes(unitId) ? [["deploy"], ["fireup"]]
          : [["fireup"], ["deployedfire"], ["fireprone"]]
    ),
    weapon: weaponPreferences,
    special_attack: [["deploy", "deployedfire"], ["firefly", "fireup"], ["idle1", "idle2"]],
    feedback: (
      unitId === "LUNR" ? [["tumble"], ["down"], ["idle2", "idle1"]]
        : unitId === "DOG" ? [["idle2", "idle1"]]
          : [["down"], ["idle2", "idle1"]]
    ),
    die: unitId === "LUNR" ? [["airdeathstart"]] : [["die1", "die2"], ["death"]],
  };
  for (const names of preferences[slot] || preferences.select) {
    const matched = [];
    const seen = new Set();
    for (const sequence of sequences.filter((candidate) => sequenceNamed(candidate, names))) {
      const key = sequenceKey(sequence);
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(sequence);
    }
    if (matched.length) return matched;
  }
  return sequences.slice(0, 1);
}

function sequenceFrames(visual, sequence) {
  const pairedShadow = visual.sourceFrameCount === visual.contentFrameCount * 2;
  const shadowOffset = pairedShadow ? visual.contentFrameCount : 0;
  const facingOffset = sequence.facing_step ? 5 * sequence.facing_step : 0;
  return Array.from({ length: Math.min(24, Math.max(1, Number(sequence.frame_count) || 1)) }, (_, index) => {
    const frame = Number(sequence.start_frame || 0)
      + facingOffset
      + index * Math.max(1, Number(sequence.frame_step || 1));
    const shadowFrame = pairedShadow && frame < shadowOffset && frame + shadowOffset < visual.sourceFrameCount
      ? frame + shadowOffset
      : undefined;
    return assetPreviewUrl(sequence.assetId, frame, shadowFrame, 8, { paletteKind: sequence.palette || "unit" });
  });
}

function animationPosture(event) {
  return /down|crawl|up|prone|die|death|tumble|deploy/i.test(String(event)) ? "low" : "normal";
}

function sequenceAnimation(group, slot, sourceId, ordinal, eventName) {
  const visual = group.representative.visual;
  if (visual.bodyFormat === "vxl") {
    const facingOrder = [0, 7, 6, 5, 4, 3, 2, 1];
    return {
      event: "facing",
      frames: facingOrder.map((facing) => entityPreviewUrl(sourceId, group.representative.id, facing)),
      intervalMs: CONFIG.visual.voxelFacingIntervalMs,
      posture: "normal",
    };
  }
  if (slot === "die" && group.representative.id === "LUNR") {
    const airDeath = ["airdeathstart", "airdeathfinish"]
      .map((name) => (visual.sequences || []).find((sequence) => (
        validSequence(visual, sequence) && sequenceNamed(sequence, [name])
      )))
      .filter(Boolean);
    if (airDeath.length === 2) {
      return {
        event: "airdeathstart+airdeathfinish",
        frames: airDeath.flatMap((sequence) => sequenceFrames(visual, sequence)),
        intervalMs: CONFIG.visual.frameIntervalMs,
        posture: "low",
      };
    }
  }
  const candidates = sequenceCandidatesForSlot(visual, slot, group.representative.id, eventName);
  const sequence = candidates.length ? candidates[ordinal % candidates.length] : null;
  if (!sequence) {
    return {
      event: "preview",
      frames: [entityPreviewUrl(sourceId, group.representative.id, 5)],
      intervalMs: CONFIG.visual.frameIntervalMs,
      posture: "normal",
    };
  }
  return {
    event: sequence.event,
    frames: sequenceFrames(visual, sequence),
    intervalMs: Number(sequence.rate_ms) > 0 ? Number(sequence.rate_ms) : CONFIG.visual.frameIntervalMs,
    posture: animationPosture(sequence.event),
  };
}

function prepareGroups(groups, sourceId, cameoPaletteId) {
  return groups.map((group) => {
    const invalidSequenceEvents = (group.representative.visual.sequences || [])
      .filter((sequence) => !validSequence(group.representative.visual, sequence))
      .map((sequence) => sequence.event);
    if (invalidSequenceEvents.length) {
      console.warn(`[visual] ${group.representative.name} 跳过越界动作：${invalidSequenceEvents.join("、")}`);
    }
    const ordinalBySlot = new Map();
    const cues = group.cues.map((cue) => {
      const event = cue.primaryEvent || chooseCueEvent(cue, group.representative.id);
      const slot = event.slot || "select";
      const ordinal = ordinalBySlot.get(slot) || 0;
      ordinalBySlot.set(slot, ordinal + 1);
      const animation = sequenceAnimation(group, slot, sourceId, ordinal, event.event);
      if (!animationMatchesSlot(slot, animation.event)) {
        throw new Error(`${group.representative.name}/${cue.assetName} 的 ${slot} 事件错误匹配到 ${animation.event}`);
      }
      return {
        ...cue,
        slot,
        eventLabel: eventLabel(event),
        eventName: event.event || "",
        animation,
      };
    });
    return {
      ...group,
      cameoUrl: group.representative.visual.cameoAssetId
        ? assetPreviewUrl(group.representative.visual.cameoAssetId, 0, undefined, 6, {
          paletteKind: "",
          paletteId: cameoPaletteId,
          playerColor: "",
        })
        : entityPreviewUrl(sourceId, group.representative.id, 5, 5),
      invalidSequenceEvents,
      cues,
    };
  });
}

function validateDescriptionMarkers(groups) {
  for (const group of groups) {
    for (const cue of group.cues) {
      const translation = cue.translated || cue.localized || "";
      const originalHasCue = /<[^<>]+>/.test(cue.original || "");
      if (!cue.original) {
        throw new Error(`${cue.assetName} 缺少原文或英文音效描述`);
      }
      if (originalHasCue && !/<[^<>]+>/.test(translation)) {
        throw new Error(`${cue.assetName} 的译文没有保留原文提示尖括号：${translation}`);
      }
    }
  }
}

function smokeSelection(groups) {
  const extraSlots = {
    E2: ["weapon", "feedback", "die"],
    LUNR: ["move", "weapon", "feedback", "die"],
    DOG: ["weapon", "feedback", "die"],
    DESO: ["weapon", "die"],
  };
  return groups.map((group) => {
    const slots = [group.cues[0]?.slot, ...(extraSlots[group.representative.id] || [])].filter(Boolean);
    const cues = slots.map((slot) => group.cues.find((cue) => cue.slot === slot)).filter(Boolean);
    return { ...group, cues: [...new Map(cues.map((cue) => [cue.assetId, cue])).values()] };
  });
}

async function findCameoPaletteId(sourceId) {
  const params = new URLSearchParams({ source_id: sourceId, q: "CAMEO.PAL", limit: "20" });
  const response = await fetch(`${BASE_URL}/api/assets?${params}`);
  if (!response.ok) throw new Error(`CAMEO.PAL 查询失败：${response.status}`);
  const page = await response.json();
  return page.items.find((asset) => asset.source_id === sourceId && asset.display_name.toLowerCase() === "cameo.pal")?.id || "";
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
    .shell{display:grid;grid-template-rows:500px minmax(0,1fr) 64px;width:100%;height:100%;transition:opacity .28s ease}.carousel{display:grid;place-items:center;padding:16px 24px 8px;overflow:hidden}.unit-track{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr);align-items:end;gap:14px;width:100%;height:350px}.unit-peek,.unit-current{display:grid;grid-template-rows:auto auto;align-content:end;justify-items:center;min-width:0;text-align:center;transition:opacity .25s ease,transform .25s ease}.unit-peek{opacity:.22;transform:scale(.82);color:#a7adb7}.unit-peek img{visibility:hidden;width:129px;height:102px;margin-bottom:24px;object-fit:contain;image-rendering:pixelated}.unit-peek strong{max-width:100%;overflow:hidden;font-size:36px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}.unit-current{position:relative;padding:4px 16px}.unit-current img{visibility:hidden;width:225px;height:177px;margin-bottom:40px;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 12px 25px rgba(0,0,0,.58))}.unit-current strong{max-width:100%;overflow:hidden;color:#ef625c;font-size:78px;line-height:1.06;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 8px 32px rgba(156,35,31,.32)}
    .content{display:grid;grid-template-rows:minmax(0,1fr) 440px;min-height:0;padding:0 40px 14px}.panel{min-height:0}.visual{position:relative;overflow:hidden;background:radial-gradient(circle at 50% 66%,rgba(139,42,38,.28),rgba(20,23,28,.16) 42%,transparent 76%)}.visual:before{position:absolute;inset:0;content:"";opacity:.1;background:repeating-linear-gradient(0deg,transparent 0,transparent 4px,rgba(255,255,255,.022) 5px);pointer-events:none}.stage-frame{position:absolute;inset:8px 0 18px;display:grid;place-items:center}.subject{width:100%;height:100%;image-rendering:pixelated;filter:drop-shadow(0 28px 25px rgba(0,0,0,.62));transition:opacity .28s ease}.voice-head{position:absolute;left:calc(50% + 160px);top:220px;z-index:2;display:flex;align-items:center;justify-content:flex-start;transition:opacity .28s ease}.event{display:inline-flex;align-items:center;color:#dc8a85;font-size:44px;font-weight:700;letter-spacing:.035em;text-shadow:0 5px 18px rgba(0,0,0,.52)}.event i{display:none}
    .voice{display:grid;overflow:hidden;padding:0 42px 18px;transition:opacity .28s ease}.transcript{display:grid;align-content:start;justify-items:center;gap:28px;min-height:0;padding:30px 4px 0}.text-block{display:block;width:100%;text-align:center}.original,.localized{margin:0 auto;overflow-wrap:anywhere;text-align:center;text-wrap:balance}.original{display:inline-block;max-width:none;color:#ef625c;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:66px;font-weight:670;line-height:1.24;letter-spacing:0;white-space:nowrap;text-shadow:0 8px 28px rgba(153,35,31,.22)}.localized{max-width:980px;color:#ffb0aa;font-size:58px;font-weight:590;line-height:1.34}.text-block.hidden{display:none}
    .progress-shell{display:grid;align-items:center;padding:0 46px 24px}.progress{height:8px;overflow:hidden;border-radius:99px;background:#292e35;box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}.progress b{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#a93632,#ed5a54);transition:width .22s ease}
    .transition{position:fixed;inset:0;z-index:10;display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,#292b30 0,#121419 48%,#080a0d 100%);opacity:0;pointer-events:none;transition:opacity .42s ease}.transition.visible{opacity:1}.transition-card{width:960px;padding:56px 34px;text-align:center}.transition-card small{display:block;color:#ffb0aa;font-size:38px;font-weight:700;letter-spacing:.07em}.transition-card small:empty{display:none}.transition-card h2{margin:34px 0 0;color:#ef625c;font-size:88px;line-height:1.2;text-shadow:0 14px 42px rgba(132,25,22,.38)}.transition-card p{display:none}.transition-card .site{margin-top:50px;color:#d96a65;font-family:"Segoe UI",sans-serif;font-size:32px;font-weight:600}
    .unit-track{transition:opacity .28s ease,transform .34s cubic-bezier(.22,.7,.22,1);will-change:opacity,transform}.unit-leaving .unit-track{opacity:0;transform:translateX(-82px) scale(.985)}.unit-entering .unit-track{opacity:0;transform:translateX(82px) scale(.985)}.unit-leaving .subject,.unit-leaving .voice-head,.unit-leaving .voice,.unit-entering .subject,.unit-entering .voice-head,.unit-entering .voice{opacity:0}
  </style></head><body><div class="shell"><header class="carousel"><div class="unit-track"><div class="unit-peek previous"><img alt=""><strong></strong></div><div class="unit-current"><img alt=""><strong></strong></div><div class="unit-peek next"><img alt=""><strong></strong></div></div></header><main class="content"><section class="panel visual"><div class="stage-frame"><canvas class="subject" width="1000" height="850" aria-label="单位动画"></canvas></div><div class="voice-head"><span class="event"><i></i><b></b></span></div></section><section class="panel voice"><div class="transcript"><div class="text-block original-block"><p class="original"></p></div><div class="text-block localized-block"><p class="localized"></p></div></div></section></main><footer class="progress-shell"><div class="progress"><b></b></div></footer></div><div class="transition"><div class="transition-card"><small></small><h2></h2><p></p><div class="site"></div></div></div><audio id="voice-audio" preload="auto"></audio><script>
    window.__voiceTimer=0;window.__voiceFrames={};window.__voiceLayouts={};window.__setFrames=(frames,interval,posture,unitId)=>{clearInterval(window.__voiceTimer);const canvas=document.querySelector('.subject');const context=canvas.getContext('2d');context.imageSmoothingEnabled=false;const layout=window.__voiceLayouts[unitId]||{scale:1};const sequence=frames.map(src=>window.__voiceFrames[src]).filter(Boolean);const widest=Math.max(1,...sequence.map(frame=>frame.bounds.width));const tallest=Math.max(1,...sequence.map(frame=>frame.bounds.height));const scale=Math.min(layout.scale,900/widest,720/tallest);let index=0;const apply=()=>{context.clearRect(0,0,canvas.width,canvas.height);const frame=sequence[index];if(frame){const bounds=frame.bounds;const baseline=posture==='low'?700:742;const center=(bounds.left+bounds.right)/2;context.drawImage(frame.image,canvas.width/2-center*scale,baseline-bounds.bottom*scale,frame.image.naturalWidth*scale,frame.image.naturalHeight*scale)}};apply();if(sequence.length>1)window.__voiceTimer=setInterval(()=>{index=(index+1)%sequence.length;apply()},Math.max(70,interval||110))};window.__fitOriginal=()=>{const text=document.querySelector('.original');const base=66;const limit=window.innerWidth*.8;text.style.fontSize=base+'px';const width=text.getBoundingClientRect().width;if(width>limit)text.style.fontSize=Math.max(28,base*limit/width)+'px'};
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
  const frameGroups = groups.map((group) => ({
    unitId: group.representative.id,
    referenceFrames: group.cues[0]?.animation.frames || [],
  }));
  const frameUrls = [...new Set(groups.flatMap((group) => group.cues.flatMap((cue) => cue.animation.frames)))];
  const visualLayouts = await page.evaluate(async ({ values, frameGroups, frameUrls }) => {
    const records = {};
    await Promise.all(values.map((src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => image.decode().catch(() => undefined).finally(() => {
        records[src] = { image };
        resolve();
      });
      image.onerror = () => reject(new Error(`浏览器预载失败：${src}`));
      image.src = src;
    })));
    const scratch = document.createElement("canvas");
    const context = scratch.getContext("2d", { willReadFrequently: true });
    const measured = new Map();
    const boundsFor = (src) => {
      if (measured.has(src)) return measured.get(src);
      const image = records[src]?.image;
      if (!image) return null;
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
      context.clearRect(0, 0, scratch.width, scratch.height);
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
      let left = scratch.width;
      let top = scratch.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < scratch.height; y += 2) {
        for (let x = 0; x < scratch.width; x += 2) {
          const offset = (y * scratch.width + x) * 4;
          const alpha = pixels[offset + 3];
          const brightness = pixels[offset] + pixels[offset + 1] + pixels[offset + 2];
          if (alpha < 40 || brightness < 36) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      const bounds = right >= left
        ? { left, top, right: right + 1, bottom: bottom + 1, width: right - left + 1, height: bottom - top + 1 }
        : { left: 0, top: 0, right: image.naturalWidth, bottom: image.naturalHeight, width: image.naturalWidth, height: image.naturalHeight };
      records[src].bounds = bounds;
      measured.set(src, bounds);
      return bounds;
    };
    const median = (values) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
    };
    for (const src of frameUrls) boundsFor(src);
    const layouts = {};
    for (const group of frameGroups) {
      const selected = [
        group.referenceFrames[0],
        group.referenceFrames[Math.floor(group.referenceFrames.length / 2)],
        group.referenceFrames.at(-1),
      ].filter(Boolean);
      const references = [...new Set(selected)]
        .map((src) => ({ src, bounds: boundsFor(src) }))
        .filter((sample) => sample.bounds);
      const referenceHeight = median(references.map((sample) => sample.bounds.height));
      layouts[group.unitId] = {
        scale: Math.min(3.4, 640 / referenceHeight),
        anchorX: median(references.map((sample) => (sample.bounds.left + sample.bounds.right) / 2)),
        anchorY: median(references.map((sample) => sample.bounds.bottom)),
        referenceHeight,
      };
    }
    window.__voiceFrames = records;
    window.__voiceLayouts = layouts;
    return layouts;
  }, { values: urls, frameGroups, frameUrls });
  console.log(`[visual] 单位归一化 ${Object.entries(visualLayouts).map(([id, layout]) => `${id}:${layout.scale.toFixed(2)}x`).join(" ")}`);
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
  await page.evaluate(() => {
    document.body.classList.remove("unit-entering");
    document.body.classList.add("unit-leaving");
  });
  await page.waitForTimeout(180);
  const group = groups[groupIndex];
  const previousGroup = groups[groupIndex - 1];
  const nextGroup = groups[groupIndex + 1];
  const previous = previousGroup ? { name: previousGroup.representative.name, cameoUrl: previousGroup.cameoUrl } : null;
  const next = nextGroup ? { name: nextGroup.representative.name, cameoUrl: nextGroup.cameoUrl } : null;
  await page.evaluate(({ group, previous, next }) => {
    document.querySelector(".previous strong").textContent = previous?.name || "";
    document.querySelector(".previous img").src = previous?.cameoUrl || "";
    document.querySelector(".previous img").style.visibility = previous?.cameoUrl ? "visible" : "hidden";
    document.querySelector(".next strong").textContent = next?.name || "";
    document.querySelector(".next img").src = next?.cameoUrl || "";
    document.querySelector(".next img").style.visibility = next?.cameoUrl ? "visible" : "hidden";
    document.querySelector(".previous").style.visibility = previous ? "visible" : "hidden";
    document.querySelector(".next").style.visibility = next ? "visible" : "hidden";
    document.querySelector(".unit-current strong").textContent = group.representative.name;
    document.querySelector(".unit-current img").src = group.cameoUrl || "";
    document.querySelector(".unit-current img").style.visibility = group.cameoUrl ? "visible" : "hidden";
    const animation = group.cues[0]?.animation || { frames: [], intervalMs: 110 };
    window.__setFrames(animation.frames, animation.intervalMs, animation.posture, group.representative.id);
    document.querySelector(".event b").textContent = "";
    document.querySelector(".original").textContent = "";
    window.__fitOriginal();
    document.querySelector(".localized").textContent = "";
    document.querySelector(".original-block").classList.add("hidden");
    document.querySelector(".localized-block").classList.add("hidden");
    document.body.classList.remove("unit-leaving");
    document.body.classList.add("unit-entering");
  }, { group, previous, next });
  await page.waitForTimeout(34);
  await page.evaluate(() => document.body.classList.remove("unit-entering"));
  await page.waitForTimeout(Math.max(0, CONFIG.visual.unitIntroSeconds * 1000 - 214));
}

async function showCue(page, group, cue, cueIndex, segmentCueIndex, totalCues) {
  await page.evaluate(({ cue, unitId, segmentCueIndex, totalCues }) => {
    const original = cue.original || cue.translated || cue.localized || cue.assetName || "";
    const chinese = cue.translated || cue.localized || "";
    document.querySelector(".event b").textContent = cue.eventLabel;
    document.querySelector(".original").textContent = original;
    window.__fitOriginal();
    document.querySelector(".localized").textContent = chinese;
    document.querySelector(".original-block").classList.toggle("hidden", !original);
    document.querySelector(".localized-block").classList.toggle("hidden", !chinese || chinese === original);
    document.querySelector(".progress b").style.width = `${((segmentCueIndex + 1) / totalCues) * 100}%`;
    window.__setFrames(cue.animation.frames, cue.animation.intervalMs, cue.animation.posture, unitId);
  }, {
    cue,
    unitId: group.representative.id,
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
      "",
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
  const cameoPaletteId = await findCameoPaletteId(plan.source.id);
  if (!cameoPaletteId) throw new Error("没有找到当前资料库的 CAMEO.PAL");
  const kinds = ["infantry"];
  const selectedGroups = Object.fromEntries(kinds.map((kind) => {
    const groups = prepareGroups(plan.groups.filter((group) => group.kind === kind), plan.source.id, cameoPaletteId);
    validateDescriptionMarkers(groups);
    return [kind, SMOKE ? smokeSelection(groups) : groups];
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
