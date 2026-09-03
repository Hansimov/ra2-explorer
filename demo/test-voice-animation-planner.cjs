const assert = require("assert");
const { planAnimationSections, plannedAnimationCount } = require("./voice-animation-planner.cjs");
const {
  animationIntentForCue,
  animationMatchesIntent,
  animationMatchesSlot,
  chooseCueEvent,
  eventLabel,
  soundDescription,
} = require("./voice-event-semantics.cjs");

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

const semanticCue = (eventName, slot = "attack") => ({
  assetName: `${eventName}.wav`,
  events: [{ event: eventName, slot }],
});

assert.equal(chooseCueEvent(semanticCue("SpyAttackCommand"), "SPY").slot, "disguise");
assert.equal(chooseCueEvent(semanticCue("SpySpecialAttack"), "SPY").slot, "infiltrate");
assert.equal(chooseCueEvent(semanticCue("DefuseKit"), "ENGINEER").slot, "defuse");
assert.equal(eventLabel({ slot: "disguise" }), "伪装");
assert.equal(eventLabel({ slot: "infiltrate" }), "渗透");
assert.equal(eventLabel({ slot: "defuse" }), "拆弹");
assert.ok(animationMatchesSlot("disguise", "walk"));
assert.ok(animationMatchesSlot("infiltrate", "enter"));
assert.ok(animationMatchesSlot("defuse", "deploy"));
assert.deepEqual(soundDescription("ChronoLegionAttack", "weapon"), {
  original: "<Chrono beam>",
  translated: "<超时空射线声>",
});
assert.deepEqual(soundDescription("GuardianGIDeployedAttack", "weapon"), {
  original: "<Rocket launcher fire>",
  translated: "<火箭筒开火声>",
});

const intentFor = (assetName, slot, eventName, original, options = {}) => animationIntentForCue({
  assetName,
  slot,
  eventName,
  original,
}, options);
assert.equal(intentFor("igimod.wav", "move", "GIMove", "Double time!").key, "walk");
assert.equal(intentFor("igiat2a.wav", "weapon", "GIAttackDeployed", "<Deployed rifle fire>").key, "deployedfire");
assert.equal(intentFor("igiat1a.wav", "weapon", "GIAttack", "<Rifle fire>").key, "fireup");
assert.equal(intentFor("igiate.wav", "attack", "GIAttackCommand", "Diggin' in!").key, "deploy");
assert.equal(intentFor("gdefuse.wav", "defuse", "DefuseKit", "<Defusing sound>").key, "idle1+idle2");
assert.equal(intentFor("iseamoc.wav", "move", "SEALMove", "How about a swim?", { amphibious: true }).key, "swim");
assert.equal(intentFor("itapmoc.wav", "move", "TanyaMove", "Let's get to it", { amphibious: true }).key, "walk");
assert.equal(intentFor("igifea.wav", "feedback", "GIFear", "<Fear sound>").key, "crawl");
assert.equal(intentFor("isniatta.wav", "attack", "SniperAttackCommand", "Give me a target").key, "fireprone");
assert.equal(intentFor("ilasdia.wav", "die", "LunarDie", "<Death cry>", { flying: true }).key, "airdeathstart+airdeathfinish");
assert.ok(animationMatchesIntent({ sequenceNames: ["deployedfire"] }, "deployedfire"));
assert.ok(!animationMatchesIntent({ sequenceNames: ["deployedfire"] }, "fireup"));

const fineSections = planAnimationSections([
  { assetId: "move-run", slot: "move", eventName: "Move", animationIntent: { key: "walk" } },
  { assetId: "move-crawl", slot: "move", eventName: "Move", animationIntent: { key: "crawl" } },
], {
  unitId: "TEST",
  getCandidates: (section) => section.key.endsWith("crawl")
    ? [candidate("crawl", "low")]
    : [candidate("walk")],
  getTransition: (from, to) => from === to ? null : { event: "down", frames: ["down-1", "down-2"], intervalMs: 90 },
});
assert.deepEqual(fineSections.map((cue) => cue.animation.sequenceId), ["walk", "crawl"]);
assert.deepEqual(fineSections[1].animation.transitionEvents, ["down"]);

console.log("voice animation planner: passed");
