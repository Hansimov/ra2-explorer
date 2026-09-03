const fs = require("fs");
const path = require("path");
const { terminalPunctuationKind } = require("./voice-event-semantics.cjs");

const planPath = path.resolve(process.argv[2] || path.join(__dirname, "soviet-voices-plan.json"));
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const unique = new Map();

for (const group of plan.groups || []) {
  for (const cue of group.cues || []) {
    const row = unique.get(cue.assetId) || {
      assetId: cue.assetId,
      assetName: cue.assetName,
      units: [],
      original: cue.original || "",
      localized: cue.localized || "",
      translated: cue.translated || "",
      slots: [],
      events: [],
    };
    if (!row.units.includes(group.representative.name)) row.units.push(group.representative.name);
    for (const event of cue.events || []) {
      if (!row.slots.includes(event.slot)) row.slots.push(event.slot);
      const eventName = [event.event, event.weaponSlot].filter(Boolean).join("/");
      if (eventName && !row.events.includes(eventName)) row.events.push(eventName);
    }
    unique.set(cue.assetId, row);
  }
}

const entries = [...unique.values()].sort((left, right) => (
  left.units.join("/").localeCompare(right.units.join("/"), "zh-CN")
  || left.slots.join("/").localeCompare(right.slots.join("/"))
  || left.assetName.localeCompare(right.assetName)
));
const missingOriginal = entries.filter((entry) => !entry.original);
const missingTranslation = entries.filter((entry) => !entry.translated);
const punctuationMismatches = entries.filter((entry) => (
  entry.translated
  && terminalPunctuationKind(entry.original) !== terminalPunctuationKind(entry.translated)
));
const markerMismatches = entries.filter((entry) => (
  /^<[^<>]+>$/.test(entry.original) !== /^<[^<>]+>$/.test(entry.translated)
));

const result = {
  schemaVersion: 1,
  plan: planPath,
  profile: plan.profile || "soviet",
  summary: {
    uniqueAssets: entries.length,
    withOriginal: entries.length - missingOriginal.length,
    withTranslation: entries.length - missingTranslation.length,
    missingOriginal: missingOriginal.length,
    missingTranslation: missingTranslation.length,
    punctuationMismatches: punctuationMismatches.length,
    markerMismatches: markerMismatches.length,
  },
  missingOriginal,
  missingTranslation,
  punctuationMismatches,
  markerMismatches,
};

if (process.argv.includes("--tsv")) {
  console.log("stem\tunit\tslots\tevents\toriginal\tgame\teditorial");
  for (const entry of entries) {
    console.log([
      entry.assetName.replace(/\.[^.]+$/, ""),
      entry.units.join(" / "),
      entry.slots.join(" / "),
      entry.events.join(" / "),
      entry.original,
      entry.localized,
      entry.translated,
    ].map((value) => String(value).replaceAll("\t", " ").replaceAll("\n", " ")).join("\t"));
  }
} else {
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv.includes("--strict") && (
  missingOriginal.length || missingTranslation.length || punctuationMismatches.length || markerMismatches.length
)) process.exitCode = 1;
