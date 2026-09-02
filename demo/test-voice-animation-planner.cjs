const assert = require("assert");
const { planAnimationSections, plannedAnimationCount } = require("./voice-animation-planner.cjs");

const candidate = (sequenceId, posture = "normal", playbackMode = "loop") => ({
  sequenceId,
  event: sequenceId,
  frames: [`${sequenceId}-1`, `${sequenceId}-2`, `${sequenceId}-3`],
  intervalMs: 100,
  posture,
  playbackMode,
});
const cues = (slot, count) => Array.from({ length: count }, (_, index) => ({
  assetId: `${slot}-${index}`,
  slot,
  eventName: slot,
}));

assert.equal(plannedAnimationCount(5, 3, 2), 3);
assert.equal(plannedAnimationCount(4, 3, 2), 2);

const stable = planAnimationSections(cues("move", 5), {
  unitId: "TEST",
  minimumRunLength: 2,
  getCandidates: () => [candidate("walk"), candidate("crawl", "prone")],
  getTransition: (from, to) => from === to ? null : { event: "down", frames: ["down-1", "down-2"], intervalMs: 90 },
});
assert.deepEqual(stable.map((cue) => cue.animation.sequenceId), ["walk", "walk", "walk", "crawl", "crawl"]);
assert.equal(stable[0].animation.runId, stable[1].animation.runId);
assert.notEqual(stable[2].animation.runId, stable[3].animation.runId);
assert.deepEqual(stable[3].animation.transitionEvents, ["down"]);
assert.equal(stable[3].animation.introFrames.length, 2);
assert.equal(stable[4].animation.introFrames.length, 0);

const deaths = planAnimationSections(cues("die", 5), {
  unitId: "TEST",
  getCandidates: () => [candidate("die1", "low", "once-hold"), candidate("die2", "low", "once-hold")],
  getTransition: () => null,
});
assert.deepEqual(deaths.map((cue) => cue.animation.sequenceId), ["die1", "die2", "die1", "die2", "die1"]);
assert.ok(deaths.every((cue, index) => index === 0 || cue.animation.runId !== deaths[index - 1].animation.runId));
assert.ok(deaths.every((cue) => cue.animation.transitionEvents.length === 0));

const continuous = planAnimationSections([
  ...cues("attack", 2),
  ...cues("weapon", 2).map((cue) => ({ ...cue, eventName: "same" })),
], {
  unitId: "TEST",
  getCandidates: () => [candidate("fireup")],
  getTransition: () => null,
});
assert.ok(continuous.every((cue) => cue.animation.runId === continuous[0].animation.runId));

console.log("voice animation planner: passed");
