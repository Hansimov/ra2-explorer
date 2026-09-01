const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "showcase.config.json"), "utf8"));
const RUN_DIR = path.resolve(process.argv[2]);
const FINAL_VIDEO = path.resolve(process.argv[3]);
const recording = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "recording-manifest.json"), "utf8"));
const showcase = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "showcase-manifest.json"), "utf8"));

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status})\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function probe(file, chapters = false) {
  const args = ["-v", "error", "-show_streams", "-show_format"];
  if (chapters) args.push("-show_chapters");
  args.push("-of", "json", file);
  return JSON.parse(run("ffprobe.exe", args));
}

const failures = [];
const checks = [];
function check(name, condition, details) {
  checks.push({ name, passed: Boolean(condition), details });
  if (!condition) failures.push({ name, details });
}

check("seven recorded chapters", recording.segments?.length === 7, recording.segments?.length);
check("seven rendered chapters", showcase.segments?.length === 7, showcase.segments?.length);

let narrationCount = 0;
let audioCueCount = 0;
let rawDuration = 0;
for (const segment of recording.segments || []) {
  check(`${segment.id}: no page errors`, segment.errors?.length === 0, segment.errors);
  check(`${segment.id}: no failed requests`, segment.failedRequests?.length === 0, segment.failedRequests);
  const rawPath = path.join(RUN_DIR, segment.rawVideo);
  check(`${segment.id}: raw video exists`, fs.existsSync(rawPath), rawPath);
  const rawProbe = probe(rawPath);
  const duration = Number(rawProbe.format.duration);
  rawDuration += duration;
  check(`${segment.id}: raw duration matches frame clock`, Math.abs(duration - segment.capture.duration) < 0.08, {
    media: duration,
    frameClock: segment.capture.duration,
  });
  const video = rawProbe.streams.find((stream) => stream.codec_type === "video");
  check(`${segment.id}: raw source is 1440p`, video?.width === 2560 && video?.height === 1440, { width: video?.width, height: video?.height });
  check(`${segment.id}: raw source is 30 fps`, video?.r_frame_rate === "30/1", video?.r_frame_rate);

  const cues = segment.narrationCues || [];
  narrationCount += cues.length;
  audioCueCount += segment.audioCues?.length || 0;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const cuePath = cue.file ? path.join(RUN_DIR, cue.file) : "";
    check(`${segment.id}: narration ${index + 1} exists`, Boolean(cue.file) && fs.existsSync(cuePath), cue.file);
    if (index + 1 < cues.length) {
      const end = Number(cue.start) + Number(cue.duration || 0);
      check(`${segment.id}: narration ${index + 1} does not overlap`, end <= Number(cues[index + 1].start), {
        end,
        nextStart: cues[index + 1].start,
      });
    }
  }
  if (segment.cableCapture) {
    check(`${segment.id}: CABLE sink applied`, segment.cableRouting?.sinkIdApplied === true && /CABLE Input/i.test(segment.cableRouting?.outputLabel || ""), segment.cableRouting);
    check(`${segment.id}: CABLE capture exists`, fs.existsSync(path.join(RUN_DIR, segment.cableCapture)), segment.cableCapture);
    check(`${segment.id}: measured CABLE latency`, Number(segment.cableCaptureLatency) > 0 && Number(segment.cableCaptureLatency) < 2, segment.cableCaptureLatency);
    check(`${segment.id}: presentation delay applied`, segment.cablePresentationDelay === CONFIG.audio.presentationDelaySeconds, segment.cablePresentationDelay);
  }
}
check("narration cues generated", narrationCount > 0, narrationCount);
check("all 10 game audio cues captured", audioCueCount === 10, audioCueCount);
check("narration overlap audit is empty", recording.narration?.overlaps?.length === 0, recording.narration?.overlaps);
check("IndexTTS 2.5 BF16 recorded", recording.narration?.engine === "IndexTTS 2.5" && recording.narration?.precision === "BF16", recording.narration);
check("configured presentation pace applied", showcase.playbackRate === CONFIG.output.playbackRate, showcase.playbackRate);

const finalProbe = probe(FINAL_VIDEO, true);
const finalVideo = finalProbe.streams.find((stream) => stream.codec_type === "video");
const finalAudio = finalProbe.streams.find((stream) => stream.codec_type === "audio");
check("final video uses configured H.264 resolution", finalVideo?.codec_name === "h264" && finalVideo?.width === CONFIG.output.width && finalVideo?.height === CONFIG.output.height, finalVideo);
check("final video uses configured frame rate", finalVideo?.r_frame_rate === `${CONFIG.output.frameRate}/1`, finalVideo?.r_frame_rate);
check("final audio is AAC 48 kHz stereo", finalAudio?.codec_name === "aac" && finalAudio?.sample_rate === "48000" && finalAudio?.channels === 2, finalAudio);
check("final contains seven chapter markers", finalProbe.chapters?.length === 7, finalProbe.chapters?.map((chapter) => chapter.tags?.title));
check("final duration matches rendered manifest", Math.abs(Number(finalProbe.format.duration) - Number(showcase.duration)) < 0.08, {
  media: Number(finalProbe.format.duration),
  manifest: showcase.duration,
});
check("final duration stays near five minutes", Number(finalProbe.format.duration) >= CONFIG.output.targetDurationSeconds[0] && Number(finalProbe.format.duration) <= CONFIG.output.targetDurationSeconds[1], Number(finalProbe.format.duration));

const report = {
  schemaVersion: 1,
  status: failures.length ? "failed" : "passed",
  checkedAt: new Date().toISOString(),
  recordingDirectory: RUN_DIR,
  finalVideo: FINAL_VIDEO,
  metrics: {
    chapters: recording.segments.length,
    narrationCues: narrationCount,
    gameAudioCues: audioCueCount,
    rawDuration,
    finalDuration: Number(finalProbe.format.duration),
    finalBytes: Number(finalProbe.format.size),
    resolution: { width: finalVideo.width, height: finalVideo.height },
    frameRate: finalVideo.r_frame_rate,
    audio: { codec: finalAudio.codec_name, sampleRate: Number(finalAudio.sample_rate), channels: finalAudio.channels },
  },
  checks,
  failures,
};
fs.writeFileSync(path.join(RUN_DIR, "qa-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ status: report.status, checks: checks.length, failures, metrics: report.metrics }, null, 2));
if (failures.length) process.exitCode = 1;
