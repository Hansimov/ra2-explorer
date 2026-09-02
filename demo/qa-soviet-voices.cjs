const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "voice-video.config.json"), "utf8"));
const RUN_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.readFileSync(path.join(ROOT, "latest-soviet-voices.txt"), "utf8").trim();
const showcase = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "soviet-voices-manifest.json"), "utf8"));
const FINAL_VIDEO = process.argv[3]
  ? path.resolve(process.argv[3])
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

const checks = [];
const failures = [];
function check(name, condition, details) {
  checks.push({ name, passed: Boolean(condition), details });
  if (!condition) failures.push({ name, details });
}

let cueCount = 0;
let groupCount = 0;
let rawDuration = 0;
check("仅包含苏军步兵片段", showcase.segments?.length === 1 && showcase.segments[0]?.id === "infantry", (showcase.segments || []).map((segment) => segment.id));
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
  for (const cue of segment.audioCues || []) {
    check(`${segment.id}/${cue.assetId}: 含可展示文本`, Boolean(cue.original || cue.translated || cue.localized), { original: cue.original, translated: cue.translated, localized: cue.localized });
    check(`${segment.id}/${cue.assetId}: 含中文译文或原生中文`, Boolean(cue.translated || cue.localized), { translated: cue.translated, localized: cue.localized });
    check(`${segment.id}/${cue.assetId}: 时长有效`, Number(cue.duration) > 0, cue.duration);
  }
  const rawPath = path.join(RUN_DIR, segment.rawVideo);
  const rawProbe = probe(rawPath);
  const video = rawProbe.streams.find((stream) => stream.codec_type === "video");
  const duration = Number(rawProbe.format.duration);
  rawDuration += duration;
  check(`${segment.id}: 原始画面为 ${CONFIG.output.width}×${CONFIG.output.height}`, video?.width === CONFIG.output.width && video?.height === CONFIG.output.height, { width: video?.width, height: video?.height });
  check(`${segment.id}: 原始画面为 30 fps`, video?.r_frame_rate === "30/1", video?.r_frame_rate);
  check(`${segment.id}: 帧时钟与媒体时长一致`, Math.abs(duration - Number(segment.capture?.duration || 0)) < 0.08, { media: duration, frameClock: segment.capture?.duration });
}
const expectedGroups = showcase.smoke ? 1 : 9;
const expectedCues = showcase.smoke ? 2 : 168;
check(`覆盖 ${expectedGroups} 个苏军步兵组`, groupCount === expectedGroups, groupCount);
check(`覆盖 ${expectedCues} 条单位声音`, cueCount === expectedCues, cueCount);

const finalProbe = probe(FINAL_VIDEO, true);
const finalVideo = finalProbe.streams.find((stream) => stream.codec_type === "video");
const finalAudio = finalProbe.streams.find((stream) => stream.codec_type === "audio");
check(`最终视频为 H.264 ${CONFIG.output.width}×${CONFIG.output.height}`, finalVideo?.codec_name === "h264" && finalVideo?.width === CONFIG.output.width && finalVideo?.height === CONFIG.output.height, finalVideo);
check("最终视频为 30 fps", finalVideo?.r_frame_rate === `${CONFIG.output.frameRate}/1`, finalVideo?.r_frame_rate);
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
    resolution: { width: finalVideo?.width, height: finalVideo?.height },
    frameRate: finalVideo?.r_frame_rate,
  },
  checks,
  failures,
};
fs.writeFileSync(path.join(RUN_DIR, "qa-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ status: report.status, checks: checks.length, failures, metrics: report.metrics }, null, 2));
if (failures.length) process.exitCode = 1;
