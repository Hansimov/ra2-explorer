const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");
const {
  animationIntentForCue,
  animationMatchesIntent,
  animationMatchesSlot,
  chooseCueEvent,
  eventLabel,
  terminalPunctuationKind,
} = require("./voice-event-semantics.cjs");
const { planAnimationSections } = require("./voice-animation-planner.cjs");
const { profileKeyFromArguments, voiceVideoProfile } = require("./voice-video-profiles.cjs");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "voice-video.config.json"), "utf8"));
const arguments_ = process.argv.slice(2);
const PROFILE = voiceVideoProfile(profileKeyFromArguments(arguments_));
const positional = arguments_.filter((value) => !value.startsWith("--"));
const BASE_URL = (positional[0] || "http://127.0.0.1:46120/").replace(/\/+$/, "");
const KIND_FILTER = positional[1] || "infantry";
const SMOKE = process.argv.includes("--smoke");
const PLAN_ONLY = process.argv.includes("--plan-only");
const unitFilterArgument = process.argv.find((value) => value.startsWith("--units="));
const UNIT_FILTER = new Set((unitFilterArgument?.slice("--units=".length) || "")
  .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
const PLAN_PATH = path.join(ROOT, `${PROFILE.filePrefix}-plan.json`);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(ROOT, `${PROFILE.filePrefix}-${SMOKE ? "smoke-" : ""}${RUN_ID}`);
const RAW_DIR = path.join(RUN_DIR, "raw");
const AUDIO_DIR = path.join(RUN_DIR, "audio");
const POSTER_DIR = path.join(RUN_DIR, "posters");
const WIDTH = CONFIG.viewport.width;
const HEIGHT = CONFIG.viewport.height;
const SOURCE_WIDTH = CONFIG.output.width;
const SOURCE_HEIGHT = CONFIG.output.height;
const FPS = CONFIG.output.frameRate;
const SECTION_LABELS = { infantry: PROFILE.sectionTitle };
const SUBJECT_HEADER_OVERLAP = Number(CONFIG.visual.subjectHeaderOverlap) || 380;
const SUBJECT_CANVAS_BASE_HEIGHT = Number(CONFIG.visual.subjectCanvasBaseHeight) || 1200;
const SUBJECT_BASELINE_NORMAL = 765;
const SUBJECT_BASELINE_LOW = 721;

for (const directory of [RUN_DIR, RAW_DIR, AUDIO_DIR, POSTER_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function runPlanner() {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "plan-soviet-voices.cjs"), BASE_URL, PLAN_PATH, `--profile=${PROFILE.key}`,
  ], {
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
  const { paletteKind = "unit", paletteId = "", playerColor = PROFILE.playerColor } = options;
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
    player_color: PROFILE.playerColor,
  });
  return `${BASE_URL}/api/entities/${encodeURIComponent(sourceId)}/${encodeURIComponent(entityId)}/preview.png?${params}`;
}

function subjectLayerUrl(previewUrl) {
  const parsed = new URL(previewUrl);
  parsed.searchParams.delete("shadow_frame");
  return parsed.toString();
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

function loopableSequence(sequence, slot) {
  const event = String(sequence.event || "").toLowerCase();
  if (["down", "up"].includes(event)) return false;
  if (!["die", "crashing", "impact_land"].includes(slot)
    && Number(sequence.frame_count || 0) < 3) return false;
  return Number(sequence.frame_count || 0) >= 2;
}

function sequencePreferences(slot, unitId, eventName) {
  if (slot === "move" && PROFILE.flyingUnits.includes(unitId)) return [["fly"]];
  if (["attack", "weapon", "special_attack"].includes(slot) && PROFILE.flyingUnits.includes(unitId)) {
    return [["firefly"]];
  }
  if (["attack", "weapon", "special_attack"].includes(slot) && PROFILE.explosiveUnits.includes(unitId)) {
    return [["deploy"]];
  }
  if (slot === "weapon" && /deploy/i.test(String(eventName || ""))) {
    return [["deployedfire"], ["deploy"], ["fireup"]];
  }
  const amphibiousAttack = PROFILE.amphibiousUnits.includes(unitId)
    ? [["fireup"], ["fireprone"], ["wetattack"], ["deployedfire"]]
    : [["fireup"], ["fireprone"], ["deployedfire"]];
  const preferences = {
    select: [["idle1"], ["idle2"], ["ready", "guard"]],
    create: [["cheer"], ["idle1"], ["idle2"], ["ready", "guard"]],
    move: [["walk", "swim"], ["crawl"]],
    enter: [["walk", "enter"]],
    capture: [["walk", "capture"], ["deploy"]],
    deploy: [["deploy"], ["deployedfire"], ["crawl"]],
    disguise: [["walk"], ["idle1"], ["idle2"], ["ready", "guard"]],
    infiltrate: [["walk", "enter"], ["idle1"], ["idle2"], ["ready", "guard"]],
    defuse: [["deploy"], ["walk"], ["idle1"], ["idle2"]],
    harvest: [["work", "harvest"], ["walk"], ["idle1"], ["idle2"]],
    attack: amphibiousAttack,
    weapon: amphibiousAttack,
    special_attack: [["deploy"], ["deployedfire"], ["fireup", "firefly"]],
    feedback: PROFILE.flyingUnits.includes(unitId) ? [["panic"]] : [["panic"], ["crawl"]],
    crashing: [["airdeathstart"], ["tumble"]],
    impact_land: [["airdeathfinish"]],
    die: [["die1"], ["die2"], ["death"], ["tumble"]],
  };
  return preferences[slot] || preferences.select;
}

function sequenceCandidatesForSlot(visual, slot, unitId, eventName, intent) {
  const sequences = (visual.sequences || [])
    .filter((sequence) => validSequence(visual, sequence) && loopableSequence(sequence, slot));
  if (intent?.sequenceNames?.length) {
    if (intent.selectionMode === "first-available") {
      for (const name of intent.sequenceNames) {
        const intended = sequences.filter((candidate) => sequenceNamed(candidate, [name]));
        if (intended.length) return intended;
      }
      return [];
    }
    const intended = [];
    const intendedKeys = new Set();
    for (const name of intent.sequenceNames) {
      for (const sequence of sequences.filter((candidate) => sequenceNamed(candidate, [name]))) {
        const key = sequenceKey(sequence);
        if (intendedKeys.has(key)) continue;
        intendedKeys.add(key);
        intended.push(sequence);
      }
    }
    return intended;
  }
  const matched = [];
  const seen = new Set();
  for (const names of sequencePreferences(slot, unitId, eventName)) {
    for (const sequence of sequences.filter((candidate) => sequenceNamed(candidate, names))) {
      const key = sequenceKey(sequence);
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(sequence);
    }
  }
  if (matched.length) return matched;
  return sequences.filter((sequence) => animationMatchesSlot(slot, semanticAnimationEvent(sequence, slot))).slice(0, 1);
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

function stableSubjectReferenceFrames(group) {
  const visual = group.representative.visual;
  if (visual.bodyFormat === "vxl") {
    return (group.cues[0]?.animation.frames || []).map(subjectLayerUrl);
  }
  const valid = (visual.sequences || []).filter((sequence) => validSequence(visual, sequence));
  const stable = valid.filter((sequence) => sequenceNamed(sequence, [
    "idle1", "idle2", "idle", "ready", "guard", "walk", "fly", "swim",
  ]));
  const selected = stable.length ? stable : valid.slice(0, 1);
  return [...new Set(selected.flatMap((sequence) => sequenceFrames(visual, sequence)).map(subjectLayerUrl))];
}

function animationPosture(event) {
  return /crawl|prone|die|death|tumble|deploy/i.test(String(event)) ? "low" : "normal";
}

function semanticAnimationEvent(sequence, slot, intent) {
  const values = [sequence.event, ...(sequence.aliases || [])];
  const intended = (intent?.sequenceNames || []).find((name) => (
    values.some((value) => String(value).toLowerCase() === String(name).toLowerCase())
  ));
  if (intended) return intended;
  if (slot === "feedback") {
    for (const preferred of ["crawl", "panic", "hit", "fear"]) {
      const matched = values.find((value) => String(value).toLowerCase() === preferred);
      if (matched) return matched;
    }
  }
  if (animationMatchesSlot(slot, sequence.event)) return sequence.event;
  return (sequence.aliases || []).find((alias) => animationMatchesSlot(slot, alias))
    || sequence.event;
}

function sequenceDescriptor(visual, sequence, slot, intent) {
  const event = semanticAnimationEvent(sequence, slot, intent);
  return {
    event,
    frames: sequenceFrames(visual, sequence),
    intervalMs: Number(sequence.rate_ms) > 0 ? Number(sequence.rate_ms) : CONFIG.visual.frameIntervalMs,
    posture: animationPosture(event),
    sequenceId: sequenceKey(sequence),
    playbackMode: ["die", "crashing", "impact_land"].includes(slot)
      || /^deploy$/i.test(String(event)) ? "once-hold" : "loop",
  };
}

function compositeSequenceDescriptor(visual, names, event) {
  const sequences = names.map((name) => (visual.sequences || []).find((sequence) => (
    validSequence(visual, sequence) && String(sequence.event || "").toLowerCase() === name
  )));
  if (sequences.some((sequence) => !sequence)) return null;
  return {
    event,
    frames: sequences.flatMap((sequence) => sequenceFrames(visual, sequence)),
    intervalMs: CONFIG.visual.frameIntervalMs,
    posture: "low",
    sequenceId: sequences.map(sequenceKey).join("+"),
    playbackMode: "once-hold",
  };
}

function animationCandidates(group, section, sourceId) {
  const visual = group.representative.visual;
  if (visual.bodyFormat === "vxl") {
    const facingOrder = [0, 7, 6, 5, 4, 3, 2, 1];
    return [{
      event: "facing",
      frames: facingOrder.map((facing) => entityPreviewUrl(sourceId, group.representative.id, facing)),
      intervalMs: CONFIG.visual.voxelFacingIntervalMs,
      posture: "normal",
      sequenceId: "vxl:facing",
      playbackMode: "loop",
    }];
  }
  const cue = section.cues[0];
  const slot = section.slot;
  const candidates = sequenceCandidatesForSlot(
    visual,
    slot,
    group.representative.id,
    cue.eventName,
    cue.animationIntent,
  ).map((sequence) => sequenceDescriptor(visual, sequence, slot, cue.animationIntent));
  if (PROFILE.flyingUnits.includes(group.representative.id)) {
    const compositeNames = slot === "crashing"
      ? ["airdeathstart", "airdeathfalling"]
      : slot === "die"
        ? ["airdeathstart", "airdeathfalling", "airdeathfinish"]
        : null;
    if (compositeNames) {
      const composite = compositeSequenceDescriptor(visual, compositeNames, compositeNames.join("+"));
      if (composite) candidates.push(composite);
    }
  }
  return candidates;
}

function postureTransition(visual, from, to) {
  if (from === to || !["normal", "low"].includes(from) || !["normal", "low"].includes(to)) return null;
  const event = from === "normal" && to === "low" ? "down" : "up";
  const sequence = (visual.sequences || []).find((candidate) => (
    validSequence(visual, candidate)
    && String(candidate.event || "").toLowerCase() === event
    && Number(candidate.frame_count || 0) >= 2
  ));
  if (!sequence) return null;
  return {
    event,
    frames: sequenceFrames(visual, sequence),
    intervalMs: Number(sequence.rate_ms) > 0 ? Number(sequence.rate_ms) : CONFIG.visual.frameIntervalMs,
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
    const semanticCues = group.cues.map((cue) => {
      const event = cue.primaryEvent || chooseCueEvent(cue, group.representative.id);
      const slot = event.slot || "select";
      const semanticCue = {
        ...cue,
        slot,
        eventLabel: eventLabel(event),
        eventName: event.event || "",
      };
      return {
        ...semanticCue,
        animationIntent: animationIntentForCue(semanticCue, {
          amphibious: PROFILE.amphibiousUnits.includes(group.representative.id),
          explosive: PROFILE.explosiveUnits.includes(group.representative.id),
          flying: PROFILE.flyingUnits.includes(group.representative.id),
          unitId: group.representative.id,
        }),
      };
    });
    const cues = planAnimationSections(semanticCues, {
      unitId: group.representative.id,
      minimumRunLength: Number(CONFIG.visual.animationMinimumRunLength) || 2,
      getCandidates: (section) => animationCandidates(group, section, sourceId),
      getTransition: (from, to) => postureTransition(group.representative.visual, from, to),
    }).map((cue) => {
      const animation = { ...cue.animation };
      if (animation.playbackMode === "once-hold" && animation.loopFrames.length > 1) {
        const availableMs = (
          Number(cue.durationSeconds || 0)
          + Number(CONFIG.audio.cueLeadSeconds || 0)
          + Number(CONFIG.audio.cueGapSeconds || 0)
        ) * 1000;
        animation.intervalMs = Math.max(70, Math.min(
          animation.intervalMs,
          availableMs / Math.max(1, animation.loopFrames.length - 1),
        ));
      }
      if (!animationMatchesSlot(cue.slot, animation.event)) {
        throw new Error(`${group.representative.name}/${cue.assetName} 的 ${cue.slot} 事件错误匹配到 ${animation.event}`);
      }
      if (!animationMatchesIntent(cue.animationIntent, animation.event)) {
        throw new Error(`${group.representative.name}/${cue.assetName} 的细分动作 ${cue.animationIntent.key} 错误匹配到 ${animation.event}`);
      }
      return {
        ...cue,
        animation,
      };
    });
    const uniqueAnimationCount = new Set(cues.map((cue) => cue.animation.sequenceId)).size;
    const animationRunCount = new Set(cues.map((cue) => cue.animation.runId)).size;
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
      animationCoverage: {
        assigned: cues.length,
        unique: uniqueAnimationCount,
        runs: animationRunCount,
        sections: new Set(cues.map((cue) => cue.animation.sectionKey)).size,
      },
      cues,
    };
  });
}

function validateDescriptionMarkers(groups) {
  for (const group of groups) {
    for (const cue of group.cues) {
      const translation = cue.translated || "";
      const originalHasCue = /<[^<>]+>/.test(cue.original || "");
      if (!cue.original) {
        throw new Error(`${cue.assetName} 缺少原文或英文音效描述`);
      }
      if (!translation) {
        throw new Error(`${cue.assetName} 尚未完成编辑译文`);
      }
      if (terminalPunctuationKind(cue.original) !== terminalPunctuationKind(translation)) {
        throw new Error(`${cue.assetName} 的译文句末标点与原文不一致：${translation}`);
      }
      if (originalHasCue && !/<[^<>]+>/.test(translation)) {
        throw new Error(`${cue.assetName} 的译文没有保留原文提示尖括号：${translation}`);
      }
    }
  }
}

function smokeSelection(groups) {
  return groups.map((group) => {
    const slots = new Set([
      group.cues[0]?.slot,
      ...(PROFILE.smokeSlots[group.representative.id] || []),
    ].filter(Boolean));
    const selected = [...new Map(group.cues
      .filter((cue) => slots.has(cue.slot))
      .map((cue) => [`${cue.slot}:${cue.animation.runId}`, cue])).values()];
    return {
      ...group,
      animationCoverage: {
        assigned: selected.length,
        unique: new Set(selected.map((cue) => cue.animation.sequenceId)).size,
        runs: new Set(selected.map((cue) => cue.animation.runId)).size,
        sections: new Set(selected.map((cue) => cue.animation.sectionKey)).size,
      },
      cues: selected,
    };
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
  const subjectCanvasHeight = SUBJECT_CANVAS_BASE_HEIGHT + SUBJECT_HEADER_OVERLAP;
  const subjectStageTop = 500 + 8 - SUBJECT_HEADER_OVERLAP;
  const normalBaseline = SUBJECT_BASELINE_NORMAL + SUBJECT_HEADER_OVERLAP;
  const lowBaseline = SUBJECT_BASELINE_LOW + SUBJECT_HEADER_OVERLAP;
  const eventGapBelowName = Number(CONFIG.visual.eventGapBelowName) || 45;
  const unitFadeSeconds = Number(CONFIG.visual.unitFadeSeconds) || 0.38;
  const unitSlideSeconds = Number(CONFIG.visual.unitSlideSeconds) || 0.56;
  const colors = PROFILE.colors;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    :root{color-scheme:dark;font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif;background:#080a0d;color:#f5f6f8}
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:radial-gradient(circle at 50% 22%,#27292e 0,#121419 42%,#080a0d 78%)}
    .shell{position:relative;display:grid;grid-template-rows:500px minmax(0,1fr) 64px;width:100%;height:100%;transition:opacity .28s ease}.carousel{position:relative;z-index:2;display:grid;place-items:center;padding:16px 24px 8px;overflow:visible}.unit-track{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr);align-items:end;gap:14px;width:100%;height:350px}.unit-peek,.unit-current{display:grid;grid-template-rows:auto auto;align-content:end;justify-items:center;min-width:0;text-align:center;transition:opacity .25s ease,transform .25s ease}.unit-peek{opacity:.22;transform:scale(.82);color:#a7adb7}.unit-peek img{visibility:hidden;width:129px;height:102px;margin-bottom:24px;object-fit:contain;image-rendering:pixelated}.unit-peek strong{max-width:100%;overflow:hidden;font-size:36px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}.unit-current{position:relative;padding:4px 16px}.unit-current img{visibility:hidden;width:225px;height:177px;margin-bottom:40px;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 12px 25px rgba(0,0,0,.58))}.unit-current-label{position:relative;width:100%;max-width:100%}.unit-current strong{display:block;max-width:100%;overflow:hidden;color:${colors.primary};font-size:78px;line-height:1.06;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 8px 32px ${colors.primaryShadow}}
    .content{position:relative;z-index:1;display:grid;grid-template-rows:minmax(0,1fr) 440px;min-height:0;padding:0 40px 14px}.panel{min-height:0}.visual{position:relative;overflow:visible;background:radial-gradient(circle at 50% 66%,${colors.glow},rgba(20,23,28,.16) 42%,transparent 76%)}.visual:before{position:absolute;inset:0;content:"";opacity:.1;background:repeating-linear-gradient(0deg,transparent 0,transparent 4px,rgba(255,255,255,.022) 5px);pointer-events:none}.stage-frame{position:absolute;top:${subjectStageTop}px;right:40px;left:40px;z-index:6;height:${subjectCanvasHeight}px;pointer-events:none}.subject{width:100%;height:100%;background:transparent;image-rendering:pixelated;filter:drop-shadow(0 28px 25px rgba(0,0,0,.62));transition:opacity ${unitFadeSeconds}s ease,transform ${unitSlideSeconds}s cubic-bezier(.22,.7,.22,1);transform-origin:center;will-change:opacity,transform}.voice-head{position:absolute;top:470px;left:50%;z-index:4;display:flex;align-items:center;justify-content:center;transform:translateX(-50%);transition:opacity ${unitFadeSeconds}s ease}.event{display:inline-flex;align-items:center;color:${colors.event};font-size:44px;font-weight:700;line-height:1.1;letter-spacing:.035em;text-shadow:0 5px 18px rgba(0,0,0,.52);white-space:nowrap}.event i{display:none}
    .voice{position:relative;z-index:2;display:grid;overflow:visible;padding:0 42px 18px;transition:opacity ${unitFadeSeconds}s ease}.transcript{display:grid;align-content:start;justify-items:center;gap:28px;min-height:0;padding:30px 4px 0}.text-block{display:block;width:100%;text-align:center}.original,.localized{margin:0 auto;overflow-wrap:anywhere;text-align:center;text-wrap:balance}.original{display:inline-block;max-width:none;color:${colors.primary};font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:66px;font-weight:670;line-height:1.24;letter-spacing:0;white-space:nowrap;text-shadow:0 8px 28px ${colors.textShadow}}.localized{max-width:980px;color:${colors.secondary};font-size:58px;font-weight:590;line-height:1.34}.text-block.hidden{display:none}
    .progress-shell{display:grid;align-items:center;padding:0 46px 24px}.progress{height:8px;overflow:hidden;border-radius:99px;background:#292e35;box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}.progress b{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,${colors.accentStart},${colors.accentEnd});transition:width .22s ease}
    .transition{position:fixed;inset:0;z-index:10;display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,#292b30 0,#121419 48%,#080a0d 100%);opacity:0;pointer-events:none;transition:opacity .42s ease}.transition.instant{transition:none}.transition.visible{opacity:1}.transition-card{width:960px;padding:56px 34px;text-align:center}.transition-card small{display:block;color:${colors.secondary};font-size:42px;font-weight:700;letter-spacing:.07em}.transition-card small:empty{display:none}.transition-card h2{margin:34px 0 0;color:${colors.primary};font-size:98px;line-height:1.2;text-shadow:0 14px 42px ${colors.titleShadow}}.transition-card p{display:none}.transition-card .site{margin-top:50px;color:${colors.event};font-family:"Segoe UI",sans-serif;font-size:34px;font-weight:600}
    .unit-track{transition:opacity ${unitFadeSeconds}s ease,transform ${unitSlideSeconds}s cubic-bezier(.22,.7,.22,1),filter ${unitFadeSeconds}s ease;will-change:opacity,transform,filter}.unit-leaving .unit-track{opacity:0;transform:translateX(-110px) scale(.965);filter:blur(3px)}.unit-entering .unit-track{opacity:0;transform:translateX(110px) scale(.965);filter:blur(3px)}.unit-leaving .subject{opacity:0;transform:translateX(-54px) scale(.985)}.unit-entering .subject{opacity:0;transform:translateX(54px) scale(.985)}.unit-leaving .voice-head,.unit-leaving .voice,.unit-entering .voice-head,.unit-entering .voice{opacity:0}
  </style></head><body><div class="shell"><header class="carousel"><div class="unit-track"><div class="unit-peek previous"><img alt=""><strong></strong></div><div class="unit-current"><img alt=""><div class="unit-current-label"><strong></strong></div></div><div class="unit-peek next"><img alt=""><strong></strong></div></div></header><div class="voice-head"><span class="event"><i></i><b></b></span></div><main class="content"><section class="panel visual"></section><section class="panel voice"><div class="transcript"><div class="text-block original-block"><p class="original"></p></div><div class="text-block localized-block"><p class="localized"></p></div></div></section></main><div class="stage-frame"><canvas class="subject" width="1000" height="${subjectCanvasHeight}" aria-label="单位动画"></canvas></div><footer class="progress-shell"><div class="progress"><b></b></div></footer></div><div class="transition"><div class="transition-card"><small></small><h2></h2><p></p><div class="site"></div></div></div><audio id="voice-audio" preload="auto"></audio><script>
    window.__voiceTimer = 0;
    window.__voiceRunId = '';
    window.__voiceFrames = {};
    window.__voiceLayouts = {};
    window.__positionVoiceHead = () => {
      const unitName = document.querySelector('.unit-current strong');
      const voiceHead = document.querySelector('.voice-head');
      voiceHead.style.top = (unitName.getBoundingClientRect().bottom + ${eventGapBelowName}) + 'px';
    };
    window.__animationPlacement = (animationChanged) => {
      const unitName = document.querySelector('.unit-current strong');
      const voiceHead = document.querySelector('.voice-head');
      const stage = document.querySelector('.stage-frame');
      const voice = document.querySelector('.voice');
      const nameRect = unitName.getBoundingClientRect();
      const headRect = voiceHead.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const voiceRect = voice.getBoundingClientRect();
      const stageZ = Number(getComputedStyle(stage).zIndex);
      const voiceZ = Number(getComputedStyle(voice).zIndex);
      return {
        strategy: 'fixed-under-unit-name',
        gapFromUnitName: headRect.top - nameRect.bottom,
        centerX: headRect.left + headRect.width / 2,
        top: headRect.top,
        insideViewport: headRect.left >= 0 && headRect.top >= 0
          && headRect.right <= window.innerWidth && headRect.bottom <= window.innerHeight,
        subjectLayerAboveTranscript: stageZ > voiceZ,
        subjectCanvasCrossesTranscript: stageRect.bottom > voiceRect.top,
        animationChanged,
      };
    };
    window.__setAnimation = (animation, unitId, forceRestart = false) => {
      const sameRun = !forceRestart && animation.runId && window.__voiceRunId === animation.runId;
      if (sameRun) return window.__animationPlacement(false);
      clearTimeout(window.__voiceTimer);
      window.__voiceRunId = animation.runId || '';
      const canvas = document.querySelector('.subject');
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = false;
      const layout = window.__voiceLayouts[unitId] || {
        scale: 1, anchorX: 0, anchorY: 0, referenceWidth: 1, referenceHeight: 1,
      };
      const intro = (animation.introFrames || []).map((src) => window.__voiceFrames[src]).filter(Boolean);
      const loop = (animation.loopFrames || animation.frames || []).map((src) => window.__voiceFrames[src]).filter(Boolean);
      const scale = layout.scale;
      const baseline = animation.posture === 'low' ? ${lowBaseline} : ${normalBaseline};
      const drawLeft = canvas.width / 2 - layout.anchorX * scale;
      const drawTop = baseline - layout.anchorY * scale;
      let phase = intro.length ? 'intro' : 'loop';
      let index = 0;
      const draw = (frame) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (!frame) return;
        context.drawImage(
          frame.image,
          drawLeft,
          drawTop,
          frame.image.naturalWidth * scale,
          frame.image.naturalHeight * scale,
        );
      };
      const schedule = () => {
        const interval = phase === 'intro' ? animation.introIntervalMs : animation.intervalMs;
        window.__voiceTimer = setTimeout(advance, Math.max(70, interval || 110));
      };
      const advance = () => {
        if (phase === 'intro') {
          if (index + 1 < intro.length) index += 1;
          else {
            phase = 'loop';
            index = 0;
          }
        } else if (animation.playbackMode === 'once-hold') {
          if (index + 1 >= loop.length) return;
          index += 1;
        } else {
          index = loop.length ? (index + 1) % loop.length : 0;
        }
        draw(phase === 'intro' ? intro[index] : loop[index]);
        if (phase === 'intro' || animation.playbackMode !== 'once-hold' || index + 1 < loop.length) schedule();
      };
      draw(phase === 'intro' ? intro[0] : loop[0]);
      if ((phase === 'intro' && intro.length) || loop.length > 1) schedule();
      return window.__animationPlacement(true);
    };
    window.__fitOriginal = () => {
      const text = document.querySelector('.original');
      const base = 66;
      const limit = window.innerWidth * .8;
      text.style.fontSize = base + 'px';
      const width = text.getBoundingClientRect().width;
      if (width > limit) text.style.fontSize = Math.max(28, base * limit / width) + 'px';
    };
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

  const frameGroups = groups.map((group) => ({
    unitId: group.representative.id,
    referenceFrames: stableSubjectReferenceFrames(group),
  }));
  const urls = [...new Set(groups.flatMap((group) => [
    group.cameoUrl,
    ...group.cues.flatMap((cue) => cue.animation.frames),
  ]).concat(frameGroups.flatMap((group) => group.referenceFrames)).filter(Boolean))];
  const animations = [...new Map(groups.flatMap((group) => group.cues).map((cue) => [
    cue.animation.sequenceId,
    {
      sequenceId: cue.animation.sequenceId,
      playbackMode: cue.animation.playbackMode,
      loopFrames: cue.animation.loopFrames,
    },
  ])).values()];
  const targetSpan = Number(CONFIG.visual.subjectSpan) || 576;
  const headerOverlap = SUBJECT_HEADER_OVERLAP;
  const lowBaseline = SUBJECT_BASELINE_LOW + SUBJECT_HEADER_OVERLAP;
  const scaleReferenceUnit = PROFILE.scaleReferenceUnit;
  const horizontalScaleUnits = PROFILE.horizontalScaleUnits;
  const visualScaleByUnit = PROFILE.visualScaleByUnit;
  const visualAudit = await page.evaluate(async ({
    values, frameGroups, animations, targetSpan, headerOverlap,
    scaleReferenceUnit, horizontalScaleUnits, visualScaleByUnit,
  }) => {
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
      let visibleSamples = 0;
      let positionMoment = 0;
      let colorMoment = 0;
      for (let y = 0; y < scratch.height; y += 2) {
        for (let x = 0; x < scratch.width; x += 2) {
          const offset = (y * scratch.width + x) * 4;
          const alpha = pixels[offset + 3];
          const brightness = pixels[offset] + pixels[offset + 1] + pixels[offset + 2];
          if (alpha >= 40 && brightness >= 18) {
            visibleSamples += 1;
            positionMoment = (positionMoment + (x + 3) * 17 + (y + 5) * 31) % 2147483647;
            colorMoment = (
              colorMoment
              + pixels[offset] * 3
              + pixels[offset + 1] * 5
              + pixels[offset + 2] * 7
              + alpha * 11
              + (x + 1) * (y + 1)
            ) % 2147483647;
          }
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
      records[src].motionSignature = [
        scratch.width,
        scratch.height,
        visibleSamples,
        positionMoment,
        colorMoment,
      ].join(":");
      measured.set(src, bounds);
      return bounds;
    };
    const median = (values) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
    };
    const quantile = (values, ratio) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] : 1;
    };
    const samples = frameGroups.map((group) => {
      const references = [...new Set(group.referenceFrames)]
        .map((src) => ({ src, bounds: boundsFor(src) }))
        .filter((sample) => sample.bounds);
      return {
        unitId: group.unitId,
        references,
        referenceHeight: quantile(references.map((sample) => sample.bounds.height), 0.7),
        referenceWidth: quantile(references.map((sample) => sample.bounds.width), 0.7),
        anchorX: median(references.map((sample) => (sample.bounds.left + sample.bounds.right) / 2)),
        anchorY: median(references.map((sample) => sample.bounds.bottom)),
      };
    });
    const scaleReference = samples.find((sample) => sample.unitId === scaleReferenceUnit);
    values.forEach(boundsFor);
    const layouts = {};
    for (const sample of samples) {
      const horizontalScale = horizontalScaleUnits.includes(sample.unitId);
      const dimension = horizontalScale ? sample.referenceWidth : sample.referenceHeight;
      const visualScale = Number(visualScaleByUnit[sample.unitId]) || 1;
      const scale = Math.min(4.4, Math.max(1.6, targetSpan / Math.max(1, dimension) * visualScale));
      layouts[sample.unitId] = {
        scale,
        visualScale,
        anchorX: sample.anchorX,
        anchorY: sample.anchorY,
        referenceHeight: sample.referenceHeight,
        referenceWidth: sample.referenceWidth,
        displaySpan: dimension * scale,
        basis: horizontalScale ? "width" : "height",
        targetUnit: scaleReference?.unitId || scaleReferenceUnit,
        headerOverlap,
      };
    }
    const animationMotion = Object.fromEntries(animations.map((animation) => {
      const signatures = animation.loopFrames
        .map((src) => records[src]?.motionSignature)
        .filter(Boolean);
      return [animation.sequenceId, {
        playbackMode: animation.playbackMode,
        loopFrameCount: signatures.length,
        distinctLoopFrames: new Set(signatures).size,
      }];
    }));
    window.__voiceFrames = records;
    window.__voiceLayouts = layouts;
    const stage = document.querySelector(".stage-frame");
    const voice = document.querySelector(".voice");
    const stageRect = stage.getBoundingClientRect();
    const voiceRect = voice.getBoundingClientRect();
    return {
      visualLayouts: layouts,
      animationMotion,
      presentationLayout: {
        subjectLayerZ: Number(getComputedStyle(stage).zIndex),
        transcriptLayerZ: Number(getComputedStyle(voice).zIndex),
        subjectCanvasBottom: stageRect.bottom,
        transcriptTop: voiceRect.top,
        subjectCanvasCrossesTranscript: stageRect.bottom > voiceRect.top,
      },
    };
  }, {
    values: urls,
    frameGroups,
    animations,
    targetSpan,
    headerOverlap,
    scaleReferenceUnit,
    horizontalScaleUnits,
    visualScaleByUnit,
  });
  const { visualLayouts } = visualAudit;
  console.log(`[visual] 以${PROFILE.scaleReferenceLabel}为主体尺度基准 ${Object.entries(visualLayouts).map(([id, layout]) => `${id}:${layout.scale.toFixed(2)}x/${layout.displaySpan.toFixed(0)}px`).join(" ")}`);
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
  return visualAudit;
}

async function prepareInitialTransition(page, eyebrow, title, detail) {
  return page.evaluate(async ({ eyebrow, title, detail }) => {
    const overlay = document.querySelector(".transition");
    overlay.querySelector("small").textContent = eyebrow;
    overlay.querySelector("h2").textContent = title;
    overlay.querySelector("p").textContent = detail;
    overlay.classList.add("instant", "visible");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const titleRect = overlay.querySelector("h2").getBoundingClientRect();
    return {
      preparedBeforeCapture: true,
      title,
      opacity: Number(getComputedStyle(overlay).opacity),
      titleVisible: titleRect.width > 0 && titleRect.height > 0,
    };
  }, { eyebrow, title, detail });
}

async function finishInitialTransition(page, captureStartedAt, durationSeconds) {
  const fadeMs = 420;
  await page.evaluate(() => document.querySelector(".transition").classList.remove("instant"));
  const elapsedMs = Date.now() - captureStartedAt;
  await page.waitForTimeout(Math.max(0, durationSeconds * 1000 - elapsedMs - fadeMs));
  await page.evaluate(() => document.querySelector(".transition").classList.remove("visible"));
  await page.waitForTimeout(fadeMs);
}

async function showUnit(page, groups, groupIndex) {
  await page.evaluate(() => {
    document.body.classList.remove("unit-entering");
    document.body.classList.add("unit-leaving");
  });
  const totalMs = Math.max(900, CONFIG.visual.unitIntroSeconds * 1000);
  const leaveMs = Math.min(totalMs - 100, (Number(CONFIG.visual.unitFadeSeconds) || 0.38) * 1000);
  const stageMs = 40;
  await page.waitForTimeout(leaveMs);
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
    const first = group.cues[0]?.animation || { frames: [], loopFrames: [], intervalMs: 110 };
    const animation = {
      ...first,
      introFrames: [],
      loopFrames: first.loopFrames || first.frames || [],
      playbackMode: "loop",
    };
    window.__setAnimation(animation, group.representative.id, true);
    document.querySelector(".event b").textContent = "";
    document.querySelector(".original").textContent = "";
    window.__fitOriginal();
    document.querySelector(".localized").textContent = "";
    document.querySelector(".original-block").classList.add("hidden");
    document.querySelector(".localized-block").classList.add("hidden");
    document.body.classList.remove("unit-leaving");
    document.body.classList.add("unit-entering");
  }, { group, previous, next });
  await page.waitForTimeout(stageMs);
  await page.evaluate(() => document.body.classList.remove("unit-entering"));
  await page.waitForTimeout(Math.max(
    (Number(CONFIG.visual.unitSlideSeconds) || 0.56) * 1000,
    totalMs - leaveMs - stageMs,
  ));
  await page.evaluate(() => window.__positionVoiceHead());
}

async function showCue(page, group, cue, cueIndex, segmentCueIndex, totalCues) {
  return page.evaluate(({ cue, unitId, segmentCueIndex, totalCues }) => {
    const original = cue.original || cue.translated || cue.localized || cue.assetName || "";
    const chinese = cue.translated || cue.localized || "";
    document.querySelector(".event b").textContent = cue.eventLabel;
    document.querySelector(".original").textContent = original;
    window.__fitOriginal();
    document.querySelector(".localized").textContent = chinese;
    document.querySelector(".original-block").classList.toggle("hidden", !original);
    document.querySelector(".localized-block").classList.toggle("hidden", !chinese || chinese === original);
    document.querySelector(".progress b").style.width = `${((segmentCueIndex + 1) / totalCues) * 100}%`;
    return window.__setAnimation(cue.animation, unitId);
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
  const visualAudit = await installPresentation(page, kind, groups);
  const staticLoops = Object.entries(visualAudit.animationMotion)
    .filter(([, motion]) => motion.playbackMode === "loop" && Number(motion.distinctLoopFrames) < 2)
    .map(([sequenceId]) => sequenceId);
  if (staticLoops.length) {
    throw new Error(`录制前发现静止主体循环：${staticLoops.join("、")}`);
  }
  const routing = await prepareCableAudio(page);
  const initialTransition = await prepareInitialTransition(
    page,
    "资源支持 · ra2-explorer",
    SECTION_LABELS[kind],
    "",
  );
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
      animationCoverage: group.animationCoverage,
    })),
    expectedCueCount: groups.reduce((total, group) => total + group.cues.length, 0),
    visualLayouts: visualAudit.visualLayouts,
    animationMotion: visualAudit.animationMotion,
    presentationLayout: visualAudit.presentationLayout,
    initialTransition,
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
    await finishInitialTransition(page, segment.startedAt, CONFIG.visual.sectionIntroSeconds);
    let segmentCueIndex = 0;
    for (const [groupIndex, group] of groups.entries()) {
      console.log(`[record] ${SECTION_LABELS[kind]} ${groupIndex + 1}/${groups.length} ${group.representative.name} (${group.cues.length})`);
      const groupStartedAt = Date.now();
      await showUnit(page, groups, groupIndex);
      for (const [cueIndex, cue] of group.cues.entries()) {
        const eventPlacement = await showCue(page, group, cue, cueIndex, segmentCueIndex, segment.expectedCueCount);
        await page.waitForTimeout(CONFIG.audio.cueLeadSeconds * 1000);
        const startedAt = await playCue(page, cue);
        segment.audioCues.push({
          assetId: cue.assetId,
          unitId: group.representative.id,
          unitName: group.representative.name,
          slot: cue.slot,
          weaponTier: cue.weaponTier,
          eventName: cue.eventName,
          eventLabel: cue.eventLabel,
          original: cue.original,
          localized: cue.localized,
          translated: cue.translated,
          textLabel: cue.textLabel,
          animationEvent: cue.animation.event,
          animationIntent: cue.animationIntent.key,
          animationIntentNames: cue.animationIntent.sequenceNames,
          animationSequence: cue.animation.sequenceId,
          animationRunId: cue.animation.runId,
          animationPlaybackMode: cue.animation.playbackMode,
          animationTransitionEvents: cue.animation.transitionEvents,
          animationIntroFrameCount: cue.animation.introFrames.length,
          animationLoopFrameCount: cue.animation.loopFrames.length,
          animationDistinctLoopFrames: visualAudit.animationMotion[cue.animation.sequenceId]?.distinctLoopFrames,
          animationSectionKey: cue.animation.sectionKey,
          animationSectionIndex: cue.animation.sectionIndex,
          animationSectionCueIndex: cue.animation.sectionCueIndex,
          animationSectionCueCount: cue.animation.sectionCueCount,
          animationSectionCount: cue.animation.sectionAnimationCount,
          animationReuseCount: cue.animation.reuseCount,
          animationCandidateCount: cue.animation.candidateCount,
          eventPlacement,
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
  if (!["all", "infantry"].includes(KIND_FILTER)) {
    throw new Error(`本期仅录制${PROFILE.sideLabel}步兵，未知分类：${KIND_FILTER}`);
  }
  const plan = runPlanner();
  const cameoPaletteId = await findCameoPaletteId(plan.source.id);
  if (!cameoPaletteId) throw new Error("没有找到当前资料库的 CAMEO.PAL");
  const kinds = ["infantry"];
  const selectedGroups = Object.fromEntries(kinds.map((kind) => {
    const groups = prepareGroups(plan.groups.filter((group) => (
      group.kind === kind
      && (!UNIT_FILTER.size || UNIT_FILTER.has(group.representative.id))
    )), plan.source.id, cameoPaletteId);
    validateDescriptionMarkers(groups);
    return [kind, SMOKE ? smokeSelection(groups) : groups];
  }));
  if (PLAN_ONLY) {
    const animationPlan = {
      createdAt: new Date().toISOString(),
      units: [...UNIT_FILTER],
      groups: selectedGroups.infantry.map((group) => ({
        id: group.representative.id,
        name: group.representative.name,
        skippedInvalidSequences: group.invalidSequenceEvents,
        animationCoverage: group.animationCoverage,
        cues: group.cues.map((cue) => ({
          assetId: cue.assetId,
          slot: cue.slot,
          eventName: cue.eventName,
          animationEvent: cue.animation.event,
          animationIntent: cue.animationIntent.key,
          animationIntentNames: cue.animationIntent.sequenceNames,
          animationSequence: cue.animation.sequenceId,
          animationRunId: cue.animation.runId,
          animationSectionKey: cue.animation.sectionKey,
          animationSectionIndex: cue.animation.sectionIndex,
          playbackMode: cue.animation.playbackMode,
          transitionEvents: cue.animation.transitionEvents,
          introFrameCount: cue.animation.introFrames.length,
          loopFrameCount: cue.animation.loopFrames.length,
        })),
      })),
    };
    const target = path.join(RUN_DIR, "animation-plan.json");
    fs.writeFileSync(target, JSON.stringify(animationPlan, null, 2), "utf8");
    console.log(JSON.stringify({ animationPlan: target, groups: animationPlan.groups.length }, null, 2));
    return;
  }
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
    profile: PROFILE.key,
    title: PROFILE.manifestTitle,
    appUrl: BASE_URL,
    appVersion: plan.appVersion,
    pagesUrl: CONFIG.pagesUrl,
    recordedAt: new Date().toISOString(),
    resolution: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    frameRate: FPS,
    smoke: SMOKE,
    unitFilter: [...UNIT_FILTER],
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
  fs.writeFileSync(path.join(ROOT, `latest-${PROFILE.filePrefix}.txt`), RUN_DIR, "utf8");
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
