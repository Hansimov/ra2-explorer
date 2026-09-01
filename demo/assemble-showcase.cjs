const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname);
const runDirectories = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^showcase-\d{4}-/.test(entry.name))
  .map((entry) => path.join(ROOT, entry.name))
  .sort((left, right) => right.localeCompare(left));

const narrationSources = new Map();
for (const runDirectory of runDirectories) {
  const manifestPath = path.join(runDirectory, "recording-manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const segment of manifest.segments || []) {
    for (const cue of segment.narrationCues || []) {
      if (!cue.text || !cue.file || !fs.existsSync(path.join(runDirectory, cue.file))) continue;
      if (!narrationSources.has(cue.text)) narrationSources.set(cue.text, { runDirectory, cue });
    }
  }
}

const selected = new Map();
for (const runDirectory of runDirectories) {
  const manifestPath = path.join(runDirectory, "recording-manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const segment of manifest.segments || []) {
    if (selected.has(segment.index) || segment.errors?.length) continue;
    if (!fs.existsSync(path.join(runDirectory, segment.rawVideo))) continue;
    selected.set(segment.index, { runDirectory, manifest, segment });
  }
}

const missing = Array.from({ length: 7 }, (_, index) => index + 1).filter((index) => !selected.has(index));
if (missing.length) throw new Error(`缺少有效章节：${missing.join(", ")}`);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const targetRoot = path.join(ROOT, `showcase-final-${runId}`);
for (const directory of [targetRoot, path.join(targetRoot, "raw"), path.join(targetRoot, "audio"), path.join(targetRoot, "narration"), path.join(targetRoot, "posters")]) {
  fs.mkdirSync(directory, { recursive: true });
}

const segments = [];
for (const index of Array.from(selected.keys()).sort((left, right) => left - right)) {
  const { runDirectory, segment } = selected.get(index);
  const copied = JSON.parse(JSON.stringify(segment));
  const rawName = path.basename(segment.rawVideo);
  fs.copyFileSync(path.join(runDirectory, segment.rawVideo), path.join(targetRoot, "raw", rawName));
  copied.rawVideo = `raw/${rawName}`;
  if (segment.cableCapture) {
    const audioName = path.basename(segment.cableCapture);
    fs.copyFileSync(path.join(runDirectory, segment.cableCapture), path.join(targetRoot, "audio", audioName));
    copied.cableCapture = `audio/${audioName}`;
  }
  copied.audioCues = (segment.audioCues || []).map((cue) => {
    const audioName = path.basename(cue.file);
    fs.copyFileSync(path.join(runDirectory, cue.file), path.join(targetRoot, "audio", audioName));
    return { ...cue, file: `audio/${audioName}` };
  });
  copied.narrationCues = (segment.narrationCues || []).map((cue) => {
    const source = cue.file && fs.existsSync(path.join(runDirectory, cue.file))
      ? { runDirectory, cue }
      : narrationSources.get(cue.text);
    if (!source) return { ...cue };
    const narrationName = `${String(index).padStart(2, "0")}-${path.basename(source.cue.file)}`;
    fs.copyFileSync(path.join(source.runDirectory, source.cue.file), path.join(targetRoot, "narration", narrationName));
    return { ...source.cue, ...cue, file: `narration/${narrationName}` };
  });
  const posterCandidates = [
    path.join(runDirectory, "posters", `${segment.id}.png`),
    path.join(runDirectory, "posters", `${segment.id}-failed.png`),
  ];
  const poster = posterCandidates.find((candidate) => fs.existsSync(candidate));
  if (poster) fs.copyFileSync(poster, path.join(targetRoot, "posters", `${segment.id}.png`));
  copied.sourceRun = path.basename(runDirectory);
  segments.push(copied);
}

const first = selected.get(1).manifest;
const narrationOverlaps = [];
for (const segment of segments) {
  const cues = segment.narrationCues || [];
  for (let cueIndex = 0; cueIndex < cues.length - 1; cueIndex += 1) {
    const end = Number(cues[cueIndex].start || 0) + Number(cues[cueIndex].duration || 0);
    const nextStart = Number(cues[cueIndex + 1].start || 0);
    if (end > nextStart) narrationOverlaps.push({ segment: segment.id, cue: cueIndex + 1, overlapSeconds: Number((end - nextStart).toFixed(3)) });
  }
}
const manifest = {
  schemaVersion: 1,
  title: first.title,
  appUrl: first.appUrl,
  appVersion: first.appVersion,
  resolution: first.resolution,
  recordedAt: new Date().toISOString(),
  assembledFromQualifiedSegments: true,
  runDirectory: targetRoot,
  narration: { ...(first.narration || {}), overlaps: narrationOverlaps },
  segments,
};
fs.writeFileSync(path.join(targetRoot, "recording-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
fs.writeFileSync(path.join(ROOT, "latest-run.txt"), targetRoot, "utf8");
console.log(JSON.stringify({ runDirectory: targetRoot, segments: segments.map((segment) => ({ index: segment.index, id: segment.id, sourceRun: segment.sourceRun })) }, null, 2));
