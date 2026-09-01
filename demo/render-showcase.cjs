const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "showcase.config.json"), "utf8"));
const explicitRun = process.argv[2];
const RUN_DIR = explicitRun
  ? path.resolve(explicitRun)
  : fs.readFileSync(path.join(ROOT, "latest-run.txt"), "utf8").trim();
const OUTPUT_TAG = process.argv[3] || process.env.RA2EXP_DEMO_TAG || `v${CONFIG.appVersion}`;
const OUTPUT_BASENAME = `RA2-Explorer-Complete-Showcase-${OUTPUT_TAG}.mp4`;
const OUTPUT_WIDTH = CONFIG.output.width;
const OUTPUT_HEIGHT = CONFIG.output.height;
const PLAYBACK_RATE = CONFIG.output.playbackRate || 1;
const MANIFEST_PATH = path.join(RUN_DIR, "recording-manifest.json");
const CLIP_DIR = path.join(RUN_DIR, "clips");
const FINAL_DIR = path.join(RUN_DIR, "final");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

for (const directory of [CLIP_DIR, FINAL_DIR]) fs.mkdirSync(directory, { recursive: true });

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: RUN_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${executable} 失败（${result.status}）\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function durationOf(file) {
  const output = run("ffprobe.exe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无法读取视频时长：${file}`);
  return duration;
}

function silenceFilter(duration) {
  return `anullsrc=r=48000:cl=stereo,atrim=duration=${duration.toFixed(3)},asetpts=N/SR/TB[aout]`;
}

function audioFilter(segment, duration) {
  const inputs = [];
  const parts = [];
  const labels = [];
  let inputIndex = 1;

  if (segment.cableCapture) {
    const captureStart = segment.cableCaptureStart || 0;
    const captureLatency = segment.cableCaptureLatency || 0;
    const presentationDelay = segment.cablePresentationDelay || 0;
    const delay = Math.max(0, Math.round(((captureStart - captureLatency + presentationDelay) / PLAYBACK_RATE) * 1000));
    inputs.push("-i", path.join(RUN_DIR, segment.cableCapture));
    parts.push(`[${inputIndex}:a]aresample=48000,atempo=${PLAYBACK_RATE},volume=0.72,alimiter=limit=0.95,adelay=${delay}|${delay},apad,atrim=duration=${duration.toFixed(3)}[game]`);
    labels.push("[game]");
    inputIndex += 1;
  } else if (segment.audioCues?.length) {
    segment.audioCues.forEach((cue, index) => {
      inputs.push("-i", path.join(RUN_DIR, cue.file));
      const label = `cue${index}`;
      const delay = Math.max(0, Math.round(((cue.start + (segment.cablePresentationDelay || 0)) / PLAYBACK_RATE) * 1000));
      parts.push(`[${inputIndex}:a]aresample=48000,volume=0.72,atrim=duration=${cue.maxDuration.toFixed(3)},atempo=${PLAYBACK_RATE},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[${label}]`);
      labels.push(`[${label}]`);
      inputIndex += 1;
    });
  }

  for (const [index, cue] of (segment.narrationCues || []).entries()) {
    if (!cue.file) continue;
    const source = path.join(RUN_DIR, cue.file);
    if (!fs.existsSync(source)) continue;
    inputs.push("-i", source);
    const label = `narration${index}`;
    const narrationDelay = segment.cableCapture ? 0.9 : 0;
    const delay = Math.max(0, Math.round(((cue.start + narrationDelay) / PLAYBACK_RATE) * 1000));
    parts.push(`[${inputIndex}:a]aresample=48000,atempo=${PLAYBACK_RATE},volume=1.0,alimiter=limit=0.95,adelay=${delay}|${delay},apad,atrim=duration=${duration.toFixed(3)}[${label}]`);
    labels.push(`[${label}]`);
    inputIndex += 1;
  }

  if (!labels.length) return { inputs: [], filter: silenceFilter(duration) };
  parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration.toFixed(3)}[base]`);
  parts.push(`[base]${labels.join("")}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0,volume=${labels.length + 1},alimiter=limit=0.95,atrim=duration=${duration.toFixed(3)},asetpts=N/SR/TB[aout]`);
  return { inputs, filter: parts.join(";") };
}

const renderedSegments = [];
let chapterOffset = 0;
for (const segment of manifest.segments) {
  const raw = path.join(RUN_DIR, segment.rawVideo);
  const duration = durationOf(raw) / PLAYBACK_RATE;
  const audio = audioFilter(segment, duration);
  const target = path.join(CLIP_DIR, `${segment.id}.mp4`);
  const fadeOutStart = Math.max(0, duration - 0.6).toFixed(3);
  console.log(`[render] ${segment.index}/${manifest.segments.length} ${segment.title}`);
  run("ffmpeg.exe", [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-i", raw,
    ...audio.inputs,
    "-filter_complex", audio.filter,
    "-map", "0:v:0", "-map", "[aout]",
    "-vf", `setpts=PTS/${PLAYBACK_RATE},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos,fade=t=in:st=0:d=0.45,fade=t=out:st=${fadeOutStart}:d=0.6,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "15",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", "-shortest",
    target,
  ]);
  const renderedDuration = durationOf(target);
  renderedSegments.push({ ...segment, clip: path.relative(RUN_DIR, target).replaceAll("\\", "/"), duration: renderedDuration, chapterStart: chapterOffset });
  chapterOffset += renderedDuration;
}

const concatPath = path.join(RUN_DIR, "concat.txt");
fs.writeFileSync(concatPath, renderedSegments.map((segment) => `file '${path.join(RUN_DIR, segment.clip).replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
const concatenated = path.join(FINAL_DIR, "RA2-Explorer-Complete-Showcase-nochapters.mp4");
run("ffmpeg.exe", ["-hide_banner", "-loglevel", "warning", "-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", concatenated]);

const chapterPath = path.join(RUN_DIR, "chapters.ffmeta");
const chapterLines = [";FFMETADATA1", "title=RA2 Explorer 完整功能演示"];
for (const segment of renderedSegments) {
  chapterLines.push("[CHAPTER]");
  chapterLines.push("TIMEBASE=1/1000");
  chapterLines.push(`START=${Math.round(segment.chapterStart * 1000)}`);
  chapterLines.push(`END=${Math.round((segment.chapterStart + segment.duration) * 1000)}`);
  chapterLines.push(`title=${String(segment.index).padStart(2, "0")} ${segment.title}`);
}
fs.writeFileSync(chapterPath, chapterLines.join("\n"), "utf8");

const finalPath = path.join(FINAL_DIR, OUTPUT_BASENAME);
run("ffmpeg.exe", ["-hide_banner", "-loglevel", "warning", "-y", "-i", concatenated, "-i", chapterPath, "-map", "0", "-map_metadata", "1", "-c", "copy", "-movflags", "+faststart", finalPath]);

const latestPath = path.join(ROOT, OUTPUT_BASENAME);
fs.copyFileSync(finalPath, latestPath);
const finalDuration = durationOf(finalPath);
const output = {
  ...manifest,
  renderedAt: new Date().toISOString(),
  resolution: { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT },
  frameRate: 30,
  playbackRate: PLAYBACK_RATE,
  videoCodec: "H.264",
  audioCodec: "AAC 48 kHz stereo",
  duration: finalDuration,
  size: fs.statSync(finalPath).size,
  finalVideo: path.relative(RUN_DIR, finalPath).replaceAll("\\", "/"),
  latestVideo: latestPath,
  segments: renderedSegments,
};
fs.writeFileSync(path.join(RUN_DIR, "showcase-manifest.json"), JSON.stringify(output, null, 2), "utf8");
fs.writeFileSync(path.join(ROOT, "latest-showcase.json"), JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({ finalVideo: finalPath, latestVideo: latestPath, duration: finalDuration, bytes: output.size, clips: renderedSegments.map((segment) => segment.clip) }, null, 2));
