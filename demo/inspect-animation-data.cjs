const plan = require("./soviet-voices-plan.json");

const requestedIds = new Set(process.argv.slice(2).map((value) => value.toUpperCase()));
for (const group of plan.groups.filter((candidate) => (
  !requestedIds.size || requestedIds.has(candidate.representative.id)
))) {
  const visual = group.representative.visual;
  console.log(`\n${group.representative.id} ${group.representative.name}`);
  console.log("cues", Object.fromEntries(group.cues.reduce((counts, cue) => {
    const slot = cue.primaryEvent?.slot || "unknown";
    counts.set(slot, (counts.get(slot) || 0) + 1);
    return counts;
  }, new Map())));
  console.table((visual.sequences || []).map((sequence) => ({
    event: sequence.event,
    aliases: (sequence.aliases || []).join(","),
    start: sequence.start_frame,
    count: sequence.frame_count,
    step: sequence.frame_step,
    facing: sequence.facing_step,
    asset: sequence.assetId,
  })));
}
