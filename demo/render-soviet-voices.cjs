const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { companionPath, demoExportDirectory } = require("./demo-output-paths.cjs");
const { profileKeyFromArguments, voiceVideoProfile } = require("./voice-video-profiles.cjs");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "voice-video.config.json"), "utf8"));
const arguments_ = process.argv.slice(2);
const requestedProfile = voiceVideoProfile(profileKeyFromArguments(arguments_));
const positional = arguments_.filter((value) => !value.startsWith("--"));
const explicitRun = positional[0];
const RUN_DIR = explicitRun
  ? path.resolve(explicitRun)
  : fs.readFileSync(path.join(ROOT, `latest-${requestedProfile.filePrefix}.txt`), "utf8").trim();
const OUTPUT_TAG = positional[1] || process.env.RA2EXP_DEMO_TAG || `v${CONFIG.appVersion}`;
const manifest = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "recording-manifest.json"), "utf8"));
const PROFILE = voiceVideoProfile(manifest.profile || requestedProfile.key);
const CLIP_DIR = path.join(RUN_DIR, "clips");
const FINAL_DIR = path.join(RUN_DIR, "final");
const EXPORT_DIR = demoExportDirectory(ROOT);
const SECTION_NAMES = { infantry: PROFILE.outputName };
for (const directory of [CLIP_DIR, FINAL_DIR, EXPORT_DIR]) fs.mkdirSync(directory, { recursive: true });

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: RUN_DIR,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${executable} 失败（${result.status}）\n${result.stdout || ""}\n${result.stderr || ""}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function durationOf(file) {
  const output = run("ffprobe.exe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无法读取媒体时长：${file}`);
  return duration;
}

function relative(file) {
  return path.relative(RUN_DIR, file).replaceAll("\\", "/");
}

const renderedSegments = [];
let chapterOffset = 0;
for (const segment of manifest.segments) {
  const raw = path.join(RUN_DIR, segment.rawVideo);
  const cable = path.join(RUN_DIR, segment.cableCapture);
  const duration = durationOf(raw);
  const delay = Math.max(0, Math.round((
    Number(segment.cableCaptureStart || 0)
    - Number(segment.cableCaptureLatency || 0)
    + Number(segment.cablePresentationDelay || 0)
  ) * 1000));
  const fadeOutStart = Math.max(0, duration - 0.55).toFixed(3);
  const target = path.join(CLIP_DIR, `RA2-Explorer-${SECTION_NAMES[segment.id]}-${OUTPUT_TAG}.mp4`);
  console.log(`[render] ${segment.title} ${duration.toFixed(1)} 秒`);
  run("ffmpeg.exe", [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-i", raw, "-i", cable,
    "-filter_complex",
    `[1:a]aresample=48000,adelay=${delay}|${delay},apad,atrim=duration=${duration.toFixed(3)},volume=0.92,alimiter=limit=0.96[aout]`,
    "-map", "0:v:0", "-map", "[aout]",
    "-vf", `scale=${CONFIG.output.width}:${CONFIG.output.height}:flags=lanczos,fade=t=out:st=${fadeOutStart}:d=0.55,format=yuv420p`,
    "-r", String(CONFIG.output.frameRate),
    "-c:v", "libx264", "-preset", "slow", "-crf", String(CONFIG.output.videoCrf),
    "-c:a", "aac", "-b:a", CONFIG.output.audioBitrate, "-ar", "48000",
    "-movflags", "+faststart", "-shortest", target,
  ]);
  const renderedDuration = durationOf(target);
  renderedSegments.push({
    ...segment,
    clip: relative(target),
    duration: renderedDuration,
    chapterOffset,
    audioDelayMilliseconds: delay,
  });
  chapterOffset += renderedDuration;
}

const concatPath = path.join(RUN_DIR, `${PROFILE.filePrefix}-concat.txt`);
fs.writeFileSync(
  concatPath,
  renderedSegments.map((segment) => `file '${path.join(RUN_DIR, segment.clip).replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"),
  "utf8",
);
const noChapters = path.join(FINAL_DIR, `RA2-Explorer-${PROFILE.outputName}-nochapters.mp4`);
run("ffmpeg.exe", [
  "-hide_banner", "-loglevel", "warning", "-y",
  "-f", "concat", "-safe", "0", "-i", concatPath,
  "-c", "copy", noChapters,
]);

const chapterPath = path.join(RUN_DIR, `${PROFILE.filePrefix}-chapters.ffmeta`);
const chapterLines = [";FFMETADATA1", `title=RA2 Explorer ${PROFILE.manifestTitle}`];
for (const segment of renderedSegments) {
  const chapters = segment.groupChapters || [];
  chapters.forEach((chapter, index) => {
    const start = index === 0 ? 0 : Number(chapter.start || 0);
    const next = chapters[index + 1];
    const end = next ? Number(next.start) : segment.duration;
    chapterLines.push("[CHAPTER]");
    chapterLines.push("TIMEBASE=1/1000");
    chapterLines.push(`START=${Math.round((segment.chapterOffset + start) * 1000)}`);
    chapterLines.push(`END=${Math.round((segment.chapterOffset + end) * 1000)}`);
    chapterLines.push(`title=${segment.title} · ${chapter.title}`);
  });
}
fs.writeFileSync(chapterPath, chapterLines.join("\n"), "utf8");

const finalPath = path.join(FINAL_DIR, `RA2-Explorer-${PROFILE.outputName}-${OUTPUT_TAG}.mp4`);
run("ffmpeg.exe", [
  "-hide_banner", "-loglevel", "warning", "-y",
  "-i", noChapters, "-i", chapterPath,
  "-map", "0", "-map_metadata", "1", "-c", "copy", "-movflags", "+faststart", finalPath,
]);
const exportedFinal = path.join(EXPORT_DIR, path.basename(finalPath));
fs.copyFileSync(finalPath, exportedFinal);
const output = {
  ...manifest,
  renderedAt: new Date().toISOString(),
  resolution: { width: CONFIG.output.width, height: CONFIG.output.height },
  frameRate: CONFIG.output.frameRate,
  videoCodec: "H.264",
  audioCodec: "AAC 48 kHz stereo",
  duration: durationOf(finalPath),
  size: fs.statSync(finalPath).size,
  finalVideo: relative(finalPath),
  exportedVideo: exportedFinal,
  segments: renderedSegments,
};
const serializedOutput = JSON.stringify(output, null, 2);
fs.writeFileSync(path.join(RUN_DIR, `${PROFILE.filePrefix}-manifest.json`), serializedOutput, "utf8");
fs.writeFileSync(path.join(ROOT, `latest-${PROFILE.filePrefix}.json`), JSON.stringify(output, null, 2), "utf8");
fs.writeFileSync(companionPath(exportedFinal, "manifest"), serializedOutput, "utf8");
console.log(JSON.stringify({
  finalVideo: finalPath,
  exportedVideo: exportedFinal,
  duration: output.duration,
  bytes: output.size,
  clips: renderedSegments.map((segment) => path.join(RUN_DIR, segment.clip)),
}, null, 2));
