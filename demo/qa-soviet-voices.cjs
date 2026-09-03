const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { SLOT_ORDER, animationMatchesSlot, terminalPunctuationKind } = require("./voice-event-semantics.cjs");
const { profileKeyFromArguments, voiceVideoProfile } = require("./voice-video-profiles.cjs");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "voice-video.config.json"), "utf8"));
const arguments_ = process.argv.slice(2);
const requestedProfile = voiceVideoProfile(profileKeyFromArguments(arguments_));
const positional = arguments_.filter((value) => !value.startsWith("--"));
const RUN_DIR = positional[0]
  ? path.resolve(positional[0])
  : fs.readFileSync(path.join(ROOT, `latest-${requestedProfile.filePrefix}.txt`), "utf8").trim();
const recording = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "recording-manifest.json"), "utf8"));
const PROFILE = voiceVideoProfile(recording.profile || requestedProfile.key);
const showcase = JSON.parse(fs.readFileSync(path.join(RUN_DIR, `${PROFILE.filePrefix}-manifest.json`), "utf8"));
const FINAL_VIDEO = positional[1]
  ? path.resolve(positional[1])
  : path.join(RUN_DIR, showcase.finalVideo);

function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${executable} 失败（${result.status}）\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function probe(file, chapters = false) {
  const args = ["-v", "error", "-show_streams", "-show_format"];
  if (chapters) args.push("-show_chapters");
  args.push("-of", "json", file);
  return JSON.parse(run("ffprobe.exe", args));
}

function firstFrameLuma(file) {
  const result = spawnSync("ffmpeg.exe", [
    "-hide_banner", "-loglevel", "info", "-i", file,
    "-vf", "signalstats,metadata=print", "-frames:v", "1", "-f", "null", "NUL",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`无法检查首帧亮度\n${result.stderr || result.stdout}`);
  return Number(`${result.stdout || ""}\n${result.stderr || ""}`.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1]);
}

const checks = [];
const failures = [];
function check(name, condition, details) {
  checks.push({ name, passed: Boolean(condition), details });
  if (!condition) failures.push({ name, details });
}

let cueCount = 0;
let groupCount = 0;
let rawDuration = 0;
let minimumCueSeparation = Infinity;
check("使用语音自然时长", CONFIG.audio.timingMode === "natural", CONFIG.audio.timingMode);
check(`仅包含${PROFILE.sideLabel}步兵片段`, showcase.profile === PROFILE.key
  && showcase.segments?.length === 1
  && showcase.segments[0]?.id === "infantry", {
  profile: showcase.profile,
  segments: (showcase.segments || []).map((segment) => segment.id),
});
for (const segment of showcase.segments || []) {
  cueCount += segment.audioCues?.length || 0;
  groupCount += segment.groups?.length || 0;
  check(`${segment.id}: 所有计划语音均已播放`, segment.audioCues?.length === segment.expectedCueCount, {
    expected: segment.expectedCueCount,
    actual: segment.audioCues?.length,
  });
  check(`${segment.id}: 页面无运行错误`, segment.errors?.length === 0, segment.errors);
  check(`${segment.id}: 网络请求无失败`, segment.failedRequests?.length === 0, segment.failedRequests);
  check(`${segment.id}: CABLE 输出路由生效`, segment.cableRouting?.sinkIdApplied === true && /CABLE Input/i.test(segment.cableRouting?.outputLabel || ""), segment.cableRouting);
  check(`${segment.id}: CABLE 延迟在合理范围`, Number(segment.cableCaptureLatency) >= 0 && Number(segment.cableCaptureLatency) < 1.5, segment.cableCaptureLatency);
  check(`${segment.id}: 海报存在`, fs.existsSync(path.join(RUN_DIR, "posters", `${segment.id}.png`)), path.join(RUN_DIR, "posters", `${segment.id}.png`));
  check(`${segment.id}: 首帧录制前已显示标题`, segment.initialTransition?.preparedBeforeCapture === true
    && segment.initialTransition?.title === PROFILE.sectionTitle
    && segment.initialTransition?.titleVisible === true
    && Number(segment.initialTransition?.opacity) === 1, segment.initialTransition);
  check(`${segment.id}: 主体画布位于文本图层上方`, Number(segment.presentationLayout?.subjectLayerZ) > Number(segment.presentationLayout?.transcriptLayerZ), segment.presentationLayout);
  check(`${segment.id}: 主体画布覆盖字幕所在高度`, segment.presentationLayout?.subjectCanvasCrossesTranscript === true, segment.presentationLayout);
  const referenceLayout = segment.visualLayouts?.[PROFILE.scaleReferenceUnit];
  check(`${segment.id}: 使用${PROFILE.scaleReferenceLabel}主体尺度基准`, referenceLayout
    ? referenceLayout.targetUnit === PROFILE.scaleReferenceUnit && referenceLayout.basis === "height"
    : Object.values(segment.visualLayouts || {}).every((layout) => (
      layout.targetUnit === PROFILE.scaleReferenceUnit
    )), referenceLayout || segment.visualLayouts);
  const targetSpan = Number(CONFIG.visual.subjectSpan);
  for (const group of segment.groups || []) {
    const groupCues = (segment.audioCues || []).filter((cue) => cue.unitId === group.id);
    const slotOrder = groupCues.map((cue) => SLOT_ORDER.get(cue.slot) ?? 50);
    const weaponTiers = groupCues.filter((cue) => cue.slot === "weapon").map((cue) => cue.weaponTier);
    const layout = segment.visualLayouts?.[group.id];
    const animationSequences = new Set(groupCues.map((cue) => cue.animationSequence));
    check(`${segment.id}/${group.id}: 主体尺度独立于整帧环境`, Math.abs(Number(layout?.displaySpan) - targetSpan) <= 1, layout);
    check(`${segment.id}/${group.id}: 主体锚点有效`, [layout?.anchorX, layout?.anchorY, layout?.scale].every(Number.isFinite), layout);
    check(`${segment.id}/${group.id}: 非人形单位采用横向尺度`, !PROFILE.horizontalScaleUnits.includes(group.id)
      || layout?.basis === "width", layout);
    check(`${segment.id}/${group.id}: 透明主体画布可跨入顶部区域`, Number(layout?.headerOverlap) === Number(CONFIG.visual.subjectHeaderOverlap), layout);
    check(`${segment.id}/${group.id}: 完整源帧上沿不被画布裁切`, Number(layout?.sourceTopAtLowPosture) >= -1, layout);
    check(`${segment.id}/${group.id}: 事件顺序符合游戏流程`, slotOrder.every((value, index) => index === 0 || value >= slotOrder[index - 1]), slotOrder);
    check(`${segment.id}/${group.id}: 精英武器声音位于普通武器之后`, weaponTiers.every((tier, index) => (
      index === 0 || weaponTiers[index - 1] !== "elite" || tier === "elite"
    )), weaponTiers);
    check(`${segment.id}/${group.id}: 动作覆盖统计与实际录制一致`, animationSequences.size === Number(group.animationCoverage?.unique), {
      expected: group.animationCoverage,
      actualUnique: animationSequences.size,
    });
    check(`${segment.id}/${group.id}: 多条声音使用多种兼容动作`, groupCues.length < 2
      || !groupCues.some((cue) => Number(cue.animationCandidateCount) > 1)
      || animationSequences.size > 1, {
      cueCount: groupCues.length,
      animationSequences: [...animationSequences],
    });
    const sectionKeys = [...new Set(groupCues.map((cue) => cue.animationSectionKey))];
    for (const sectionKey of sectionKeys) {
      const sectionCues = groupCues.filter((cue) => cue.animationSectionKey === sectionKey);
      const plannedCount = Number(sectionCues[0]?.animationSectionCount || 1);
      const runIds = new Set(sectionCues.map((cue) => cue.animationRunId));
      const sectionSequences = new Set(sectionCues.map((cue) => cue.animationSequence));
      check(`${segment.id}/${group.id}/${sectionKey}: 动作种类符合预计算`, sectionSequences.size <= plannedCount, {
        cueCount: sectionCues.length,
        plannedCount,
        sequences: [...sectionSequences],
        runs: [...runIds],
      });
      if (sectionCues[0]?.slot !== "die" && sectionCues.length > plannedCount) {
        check(`${segment.id}/${group.id}/${sectionKey}: 相邻语音保留稳定动作`, sectionCues.some((cue, index) => (
          index > 0 && cue.animationRunId === sectionCues[index - 1].animationRunId
        )), sectionCues.map((cue) => cue.animationRunId));
      }
    }
    const deathCues = groupCues.filter((cue) => cue.slot === "die");
    check(`${segment.id}/${group.id}: 相邻阵亡声音尽量交替动作`, deathCues.every((cue, index) => (
      index === 0
      || Number(cue.animationCandidateCount) <= 1
      || cue.animationSequence !== deathCues[index - 1].animationSequence
    )), deathCues.map((cue) => cue.animationSequence));
  }
  for (const [cueIndex, cue] of (segment.audioCues || []).entries()) {
    const translation = cue.translated || cue.localized || "";
    const originalHasCue = /<[^<>]+>/.test(cue.original || "");
    check(`${segment.id}/${cue.assetId}: 含可展示文本`, Boolean(cue.original || cue.translated || cue.localized), { original: cue.original, translated: cue.translated, localized: cue.localized });
    check(`${segment.id}/${cue.assetId}: 原文或英文音效描述完整`, Boolean(cue.original), cue.original);
    check(`${segment.id}/${cue.assetId}: 含中文译文或原生中文`, Boolean(cue.translated || cue.localized), { translated: cue.translated, localized: cue.localized });
    if (cue.translated) {
      check(`${segment.id}/${cue.assetId}: 译文句末标点与原文一致`, terminalPunctuationKind(cue.original) === terminalPunctuationKind(cue.translated), {
        original: cue.original,
        translated: cue.translated,
      });
    }
    if (!cue.original) {
      check(`${segment.id}/${cue.assetId}: 无原文音效保留尖括号`, /^<[^<>]+>$/.test(translation), translation);
    } else if (originalHasCue) {
      check(`${segment.id}/${cue.assetId}: 译文保留原文提示尖括号`, /<[^<>]+>/.test(translation), { original: cue.original, translation });
    }
    check(`${segment.id}/${cue.assetId}: 主体动作匹配声音事件`, animationMatchesSlot(cue.slot, cue.animationEvent), {
      slot: cue.slot,
      animationEvent: cue.animationEvent,
    });
    check(`${segment.id}/${cue.assetId}: 动作候选与复用统计有效`, Number(cue.animationCandidateCount) >= 1
      && Number(cue.animationReuseCount) >= 0, {
      candidateCount: cue.animationCandidateCount,
      reuseCount: cue.animationReuseCount,
      sequence: cue.animationSequence,
    });
    check(`${segment.id}/${cue.assetId}: 事件文字固定在单位名称下方 45px`, cue.eventPlacement?.strategy === "fixed-under-unit-name"
      && Math.abs(Number(cue.eventPlacement?.gapFromUnitName) - Number(CONFIG.visual.eventGapBelowName)) < 1
      && Math.abs(Number(cue.eventPlacement?.centerX) - Number(CONFIG.viewport.width) / 2) < 1, cue.eventPlacement);
    check(`${segment.id}/${cue.assetId}: 事件文字完整位于画面内`, cue.eventPlacement?.insideViewport === true, cue.eventPlacement);
    check(`${segment.id}/${cue.assetId}: 动画主体可覆盖字幕文字`, cue.eventPlacement?.subjectLayerAboveTranscript === true
      && cue.eventPlacement?.subjectCanvasCrossesTranscript === true, cue.eventPlacement);
    check(`${segment.id}/${cue.assetId}: 主循环不是姿态过渡片段`, !/^(?:down|up)$/i.test(cue.animationEvent)
      && (cue.animationPlaybackMode === "once-hold" || Number(cue.animationLoopFrameCount) >= 3), {
      animationEvent: cue.animationEvent,
      playbackMode: cue.animationPlaybackMode,
      loopFrames: cue.animationLoopFrameCount,
    });
    check(`${segment.id}/${cue.assetId}: 两帧姿态动作只作为过渡`, (cue.animationTransitionEvents || []).every((event) => /^(?:down|up)$/i.test(event))
      && (!(cue.animationTransitionEvents || []).length || Number(cue.animationIntroFrameCount) === 2), {
      transitionEvents: cue.animationTransitionEvents,
      introFrames: cue.animationIntroFrameCount,
    });
    check(`${segment.id}/${cue.assetId}: 循环动作具有可见帧变化`, cue.animationPlaybackMode !== "loop"
      || Number(cue.animationDistinctLoopFrames) >= 2, {
      sequence: cue.animationSequence,
      frames: cue.animationLoopFrameCount,
      distinctFrames: cue.animationDistinctLoopFrames,
    });
    check(`${segment.id}/${cue.assetId}: 反馈事件名称遵循 VoiceFeedback 规则字段`, cue.slot !== "feedback" || cue.eventLabel === "受击", {
      eventName: cue.eventName,
      expected: "受击",
      actual: cue.eventLabel,
    });
    check(`${segment.id}/${cue.assetId}: 阵亡动作仅用于阵亡声音`, cue.slot === "die"
      || !/die|death|airdeath|tumble/i.test(cue.animationEvent), {
      slot: cue.slot,
      animationEvent: cue.animationEvent,
    });
    check(`${segment.id}/${cue.assetId}: 时长有效`, Number(cue.duration) > 0, cue.duration);
    if (cueIndex > 0) {
      const previous = segment.audioCues[cueIndex - 1];
      if (cue.animationRunId === previous.animationRunId) {
        check(`${segment.id}/${cue.assetId}: 同一动作段不中途重启动画`, cue.eventPlacement?.animationChanged === false, {
          runId: cue.animationRunId,
          animationChanged: cue.eventPlacement?.animationChanged,
        });
      }
      minimumCueSeparation = Math.min(
        minimumCueSeparation,
        Number(cue.start) - Number(previous.start) - Number(previous.duration),
      );
    }
  }
  const expectedSeparation = Number(CONFIG.audio.cueLeadSeconds) + Number(CONFIG.audio.cueGapSeconds);
  check(`${segment.id}: 相邻声音留有舒适间隔`, !Number.isFinite(minimumCueSeparation)
    || minimumCueSeparation >= expectedSeparation - 0.12, {
    expected: expectedSeparation,
    minimum: minimumCueSeparation,
  });
  const rawPath = path.join(RUN_DIR, segment.rawVideo);
  const rawProbe = probe(rawPath);
  const video = rawProbe.streams.find((stream) => stream.codec_type === "video");
  const duration = Number(rawProbe.format.duration);
  rawDuration += duration;
  const lastCueEnd = Math.max(0, ...(segment.audioCues || []).map((cue) => Number(cue.start) + Number(cue.duration)));
  check(`${segment.id}: 最后一条声音完整保留`, duration >= lastCueEnd, { media: duration, lastCueEnd });
  check(`${segment.id}: 原始画面为 ${CONFIG.output.width}×${CONFIG.output.height}`, video?.width === CONFIG.output.width && video?.height === CONFIG.output.height, { width: video?.width, height: video?.height });
  check(`${segment.id}: 原始画面为 30 fps`, video?.r_frame_rate === "30/1", video?.r_frame_rate);
  check(`${segment.id}: 帧时钟与媒体时长一致`, Math.abs(duration - Number(segment.capture?.duration || 0)) < 0.08, { media: duration, frameClock: segment.capture?.duration });
}
const expectedGroups = showcase.smoke
  ? showcase.segments.reduce((total, segment) => total + Number(segment.groups?.length || 0), 0)
  : showcase.planSummary.sharedVoiceGroups;
const expectedCues = showcase.smoke
  ? showcase.segments.reduce((total, segment) => total + Number(segment.expectedCueCount || 0), 0)
  : showcase.planSummary.presentations;
check(`覆盖 ${expectedGroups} 个${PROFILE.sideLabel}步兵组`, groupCount === expectedGroups, groupCount);
check(`覆盖 ${expectedCues} 条单位声音`, cueCount === expectedCues, cueCount);

const finalProbe = probe(FINAL_VIDEO, true);
const finalVideo = finalProbe.streams.find((stream) => stream.codec_type === "video");
const finalAudio = finalProbe.streams.find((stream) => stream.codec_type === "audio");
const finalFirstFrameLuma = firstFrameLuma(FINAL_VIDEO);
check(`最终视频为 H.264 ${CONFIG.output.width}×${CONFIG.output.height}`, finalVideo?.codec_name === "h264" && finalVideo?.width === CONFIG.output.width && finalVideo?.height === CONFIG.output.height, finalVideo);
check("最终视频为 30 fps", finalVideo?.r_frame_rate === `${CONFIG.output.frameRate}/1`, finalVideo?.r_frame_rate);
check("最终视频从首帧直接显示片头", finalFirstFrameLuma > 25, finalFirstFrameLuma);
check("最终音频为 AAC 48 kHz 双声道", finalAudio?.codec_name === "aac" && finalAudio?.sample_rate === "48000" && finalAudio?.channels === 2, finalAudio);
check("单位章节数正确", finalProbe.chapters?.length === groupCount, { expected: groupCount, actual: finalProbe.chapters?.length });
check("最终时长与清单一致", Math.abs(Number(finalProbe.format.duration) - Number(showcase.duration)) < 0.08, { media: finalProbe.format.duration, manifest: showcase.duration });
check("最终视频包含声音", Number(finalAudio?.duration || finalProbe.format.duration) > 0, finalAudio?.duration);

const report = {
  schemaVersion: 1,
  status: failures.length ? "failed" : "passed",
  checkedAt: new Date().toISOString(),
  runDirectory: RUN_DIR,
  finalVideo: FINAL_VIDEO,
  metrics: {
    segments: showcase.segments.length,
    units: groupCount,
    voiceCues: cueCount,
    rawDuration,
    finalDuration: Number(finalProbe.format.duration),
    finalBytes: Number(finalProbe.format.size),
    chapters: finalProbe.chapters?.length || 0,
    minimumCueSeparation: Number.isFinite(minimumCueSeparation) ? minimumCueSeparation : null,
    resolution: { width: finalVideo?.width, height: finalVideo?.height },
    frameRate: finalVideo?.r_frame_rate,
  },
  checks,
  failures,
};
fs.writeFileSync(path.join(RUN_DIR, "qa-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ status: report.status, checks: checks.length, failures, metrics: report.metrics }, null, 2));
if (failures.length) process.exitCode = 1;
