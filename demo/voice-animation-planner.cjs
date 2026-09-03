function animationSectionKey(cue) {
  const slot = cue.slot || "select";
  const intent = cue.animationIntent?.key || "";
  if (!["weapon", "deploy", "special_attack"].includes(slot)) {
    return [slot, intent].filter(Boolean).join(":").toLowerCase();
  }
  return [slot, cue.eventName || "", cue.weaponTier || "", intent].join(":").toLowerCase();
}

function splitAnimationSections(cues) {
  const sections = [];
  for (const cue of cues) {
    const key = animationSectionKey(cue);
    const current = sections.at(-1);
    if (!current || current.key !== key) sections.push({ key, slot: cue.slot, cues: [cue] });
    else current.cues.push(cue);
  }
  return sections;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate?.sequenceId || seen.has(candidate.sequenceId)) return false;
    seen.add(candidate.sequenceId);
    return true;
  });
}

function rotateToPrevious(candidates, previous) {
  if (!previous || previous.playbackMode !== "loop") return candidates;
  const index = candidates.findIndex((candidate) => candidate.sequenceId === previous.sequenceId);
  return index > 0 ? [...candidates.slice(index), ...candidates.slice(0, index)] : candidates;
}

function plannedAnimationCount(cueCount, candidateCount, minimumRunLength) {
  if (cueCount <= 1 || candidateCount <= 1) return 1;
  return Math.min(candidateCount, Math.max(1, Math.ceil(cueCount / minimumRunLength)));
}

function planAnimationSections(cues, options) {
  const {
    getCandidates,
    getTransition,
    minimumRunLength = 2,
    unitId = "unit",
  } = options;
  const usage = new Map();
  const assignments = [];
  let previous;
  let runSerial = 0;

  for (const [sectionIndex, section] of splitAnimationSections(cues).entries()) {
    let candidates = uniqueCandidates(getCandidates(section));
    if (!candidates.length) throw new Error(`${unitId}/${section.key} 没有可用的主体动作`);
    candidates = rotateToPrevious(candidates, previous);
    const deathSection = section.slot === "die";
    const animationCount = deathSection
      ? Math.min(candidates.length, section.cues.length)
      : plannedAnimationCount(section.cues.length, candidates.length, minimumRunLength);
    const selected = candidates.slice(0, animationCount);

    for (const [cueIndex, cue] of section.cues.entries()) {
      const candidateIndex = deathSection
        ? cueIndex % selected.length
        : Math.min(selected.length - 1, Math.floor(cueIndex * selected.length / section.cues.length));
      const candidate = selected[candidateIndex];
      const canContinueRun = !deathSection
        && previous?.playbackMode === "loop"
        && candidate.playbackMode === "loop"
        && previous.sequenceId === candidate.sequenceId;
      if (!canContinueRun) runSerial += 1;
      const transition = !canContinueRun && !deathSection && previous?.slot !== "die"
        ? getTransition(previous?.posture || "normal", candidate.posture || "normal")
        : null;
      const introFrames = transition?.frames || [];
      const loopFrames = candidate.frames || [];
      const reuseCount = usage.get(candidate.sequenceId) || 0;
      usage.set(candidate.sequenceId, reuseCount + 1);
      const animation = {
        ...candidate,
        frames: [...new Set([...introFrames, ...loopFrames])],
        introFrames,
        loopFrames,
        transitionEvents: transition ? [transition.event] : [],
        introIntervalMs: transition?.intervalMs || candidate.intervalMs,
        runId: `${unitId}:${runSerial}`,
        reuseCount,
        candidateCount: candidates.length,
        sectionKey: section.key,
        sectionIndex,
        sectionCueIndex: cueIndex,
        sectionCueCount: section.cues.length,
        sectionAnimationCount: selected.length,
      };
      assignments.push({ ...cue, animation });
      previous = { ...animation, slot: cue.slot };
    }
  }
  return assignments;
}

module.exports = {
  animationSectionKey,
  planAnimationSections,
  plannedAnimationCount,
  splitAnimationSections,
};
