const fs = require("fs");
const path = require("path");
const { SLOT_ORDER, chooseCueEvent, soundDescription } = require("./voice-event-semantics.cjs");

const BASE_URL = (process.argv[2] || "http://127.0.0.1:46120/").replace(/\/+$/, "");
const OUTPUT = path.resolve(process.argv[3] || path.join(__dirname, "soviet-voices-plan.json"));
const SOURCE_ID = process.env.RA2EXP_SOURCE_ID || "";
const KINDS = ["infantry"];
const VOCAL_SLOTS = new Set([
  "select", "create", "move", "attack", "feedback", "special_attack",
  "enter", "capture", "deploy", "harvest", "die",
]);
const WEAPON_SOUND_SLOTS = /^(?:elite_)?(?:primary|secondary|weapon_\d+)$/i;
const USAGE_ORDER = new Map([
  ["buildable", 0],
  ["hero", 1],
  ["scenario", 2],
  ["civilian", 3],
]);
const INFANTRY_PRESENTATION_ORDER = new Map([
  ["e2", 0],
  ["sengineer", 1],
  ["terror", 2],
  ["shk", 3],
  ["ivan", 4],
  ["deso", 5],
  ["boris", 6],
  ["lunr", 7],
  ["dog", 8],
]);

async function fetchJson(route) {
  const response = await fetch(`${BASE_URL}${route}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${route}`);
  return response.json();
}

async function mapLimit(values, limit, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function compactText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function displayText(value) {
  const text = compactText(value);
  if (!text) return "";
  const asteriskCue = text.match(/^\*+\s*(.*?)\s*\*+$/);
  return asteriskCue ? `<${asteriskCue[1]}>` : text;
}

function preserveDescriptionMarkers(original, translation) {
  if (!translation) return "";
  return /^<.*>$/.test(original) && !/^<.*>$/.test(translation)
    ? `<${translation}>`
    : translation;
}

function isUnusedEntity(entity) {
  const identity = `${entity.id} ${entity.display_name} ${entity.internal_name}`.toLowerCase();
  return identity.includes("zzz") || identity.includes("not used") || identity.includes("unused");
}

function componentAsset(entity, role) {
  return entity.components?.find((component) => component.role === role)?.asset || null;
}

function bodySequences(entity) {
  return (entity.media || [])
    .filter((association) => association.kind === "animation" && association.slot === "body_sequence")
    .flatMap((association) => (association.samples || []).map((sample) => ({
      event: compactText(association.event),
      aliases: (association.aliases || []).map(compactText).filter(Boolean),
      assetId: sample.asset?.id || "",
      palette: sample.palette || "unit",
      ...sample.animation,
    })))
    .filter((sequence) => sequence.assetId && Number(sequence.frame_count || 0) > 1);
}

function visualInfo(entity) {
  const cameo = componentAsset(entity, "cameo") || componentAsset(entity, "alt_cameo");
  const body = componentAsset(entity, "body");
  return {
    cameoAssetId: cameo?.id || "",
    bodyAssetId: body?.id || "",
    bodyFormat: body?.format || entity.body_format || "",
    contentFrameCount: entity.preview?.frame_count || 1,
    sourceFrameCount: entity.preview?.source_frame_count || entity.preview?.frame_count || 1,
    facingCount: entity.preview?.facing_count || 1,
    sequences: bodySequences(entity),
  };
}

function voiceCues(entity) {
  const cues = new Map();
  for (const association of entity.media || []) {
    const weaponSound = association.kind === "sound" && WEAPON_SOUND_SLOTS.test(association.slot);
    if (association.kind !== "voice" && !VOCAL_SLOTS.has(association.slot) && !weaponSound) continue;
    for (const sample of association.samples || []) {
      if (!sample.asset) continue;
      const semanticSlot = weaponSound ? "weapon" : compactText(association.slot);
      const description = soundDescription(association.event, semanticSlot);
      const sourceOriginal = displayText(sample.original_text);
      const sourceTranslation = displayText(sample.translated_text) || description.translated;
      const original = (
        weaponSound ? description.original
          : /^<[^<>]+>$/.test(sourceTranslation) && sourceOriginal && !/^<[^<>]+>$/.test(sourceOriginal)
            ? `<${sourceOriginal}>`
            : sourceOriginal || description.original
      );
      const localized = preserveDescriptionMarkers(original, displayText(sample.localized_text));
      const translated = preserveDescriptionMarkers(
        original,
        sourceTranslation,
      );
      const current = cues.get(sample.asset.id) || {
        assetId: sample.asset.id,
        assetName: sample.asset.display_name,
        original,
        localized: localized && localized !== original ? localized : "",
        translated: translated && translated !== original ? translated : "",
        textLabel: translated ? "译文" : localized ? "中文" : "",
        events: [],
      };
      const event = {
        slot: semanticSlot,
        event: compactText(association.event),
        source: compactText(association.source),
        mediaKind: association.kind,
        weaponSlot: weaponSound ? compactText(association.slot) : "",
      };
      if (!current.events.some((item) => item.slot === event.slot && item.event === event.event)) {
        current.events.push(event);
      }
      cues.set(sample.asset.id, current);
    }
  }
  return [...cues.values()].map((cue) => ({
    ...cue,
    primaryEvent: chooseCueEvent(cue, entity.id),
  })).sort((left, right) => {
    const leftSlot = left.primaryEvent?.slot || "";
    const rightSlot = right.primaryEvent?.slot || "";
    return (SLOT_ORDER.get(leftSlot) ?? 50) - (SLOT_ORDER.get(rightSlot) ?? 50)
      || leftSlot.localeCompare(rightSlot)
      || left.assetName.localeCompare(right.assetName);
  });
}

async function supplementalCosmonautDeathCues(sourceId) {
  const params = new URLSearchParams({
    source_id: sourceId,
    q: "LaserCosmoDie",
    language: "zh-CN",
    limit: "100",
  });
  const page = await fetchJson(`/api/media?${params}`);
  return page.items
    .filter((item) => item.events.some((event) => event.toLowerCase() === "lasercosmodie"))
    .map((item) => {
      const description = soundDescription("LaserCosmoDie", "die");
      const original = displayText(item.original_texts?.[0]) || description.original;
      const localized = preserveDescriptionMarkers(original, displayText(item.localized_texts?.[0]));
      const translated = preserveDescriptionMarkers(
        original,
        displayText(item.translated_texts?.[0]) || description.translated,
      );
      return {
        assetId: item.asset.id,
        assetName: item.asset.display_name,
        original,
        localized: localized && localized !== original ? localized : "",
        translated: translated && translated !== original ? translated : "",
        textLabel: translated ? "译文" : localized ? "中文" : "",
        events: [{ slot: "die", event: "LaserCosmoDie", source: "LaserCosmoDie" }],
        primaryEvent: { slot: "die", event: "LaserCosmoDie", source: "LaserCosmoDie" },
        supplemental: true,
      };
    })
    .sort((left, right) => left.assetName.localeCompare(right.assetName));
}

function affiliationLabel(entity) {
  const affiliation = entity.affiliation;
  return affiliation?.display_name || (entity.sides || []).join(" / ") || "苏军";
}

function representativePriority(unit) {
  return [
    unit.renderable ? 0 : 1,
    USAGE_ORDER.get(unit.usage) ?? 9,
    unit.display_name.localeCompare(unit.internal_name) === 0 ? 1 : 0,
    unit.display_name,
  ];
}

function comparePriority(left, right) {
  const leftPriority = representativePriority(left);
  const rightPriority = representativePriority(right);
  for (let index = 0; index < leftPriority.length; index += 1) {
    if (leftPriority[index] === rightPriority[index]) continue;
    if (typeof leftPriority[index] === "number") return leftPriority[index] - rightPriority[index];
    return String(leftPriority[index]).localeCompare(String(rightPriority[index]), "zh-CN");
  }
  return 0;
}

function groupSharedVoiceSets(units) {
  const groups = new Map();
  for (const unit of units) {
    const fingerprint = unit.cues.map((cue) => cue.assetId).sort().join(":");
    if (!fingerprint) continue;
    const key = `${unit.kind}:${fingerprint}`;
    const current = groups.get(key) || {
      kind: unit.kind,
      representative: unit,
      units: [],
      cues: unit.cues,
    };
    current.units.push({
      id: unit.id,
      name: unit.display_name,
      internalName: unit.internal_name,
      affiliation: affiliationLabel(unit),
      usage: unit.usage,
    });
    if (comparePriority(unit, current.representative) < 0) current.representative = unit;
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => ({
    kind: group.kind,
    representative: {
      id: group.representative.id,
      name: group.representative.display_name,
      bodyFormat: group.representative.body_format,
      renderable: group.representative.renderable,
      usage: group.representative.usage,
      preview: group.representative.preview,
      affiliation: affiliationLabel(group.representative),
      visual: visualInfo(group.representative),
    },
    units: group.units.sort((left, right) => (
      (USAGE_ORDER.get(left.usage) ?? 9) - (USAGE_ORDER.get(right.usage) ?? 9)
      || left.name.localeCompare(right.name, "zh-CN")
    )),
    cues: group.cues,
  })).sort((left, right) => (
    (INFANTRY_PRESENTATION_ORDER.get(left.representative.id.toLowerCase()) ?? 99)
      - (INFANTRY_PRESENTATION_ORDER.get(right.representative.id.toLowerCase()) ?? 99)
    || left.representative.name.localeCompare(right.representative.name, "zh-CN")
  ));
}

async function main() {
  const sources = await fetchJson("/api/sources");
  const source = SOURCE_ID
    ? sources.find((item) => item.id === SOURCE_ID)
    : sources.find((item) => item.state === "ready");
  if (!source) throw new Error("没有可用的 RA2 Explorer 资料库");

  const summaries = [];
  for (const kind of KINDS) {
    const params = new URLSearchParams({
      source_id: source.id,
      kind,
      side: "Nod",
      language: "zh-CN",
      limit: "500",
    });
    const page = await fetchJson(`/api/entities?${params}`);
    summaries.push(...page.items);
  }

  const details = await mapLimit(summaries, 6, (entity) => fetchJson(
    `/api/entities/${encodeURIComponent(source.id)}/${encodeURIComponent(entity.id)}?language=zh-CN`,
  ));
  const consideredUnits = details.filter((entity) => !isUnusedEntity(entity));
  const ignoredUnits = details.filter(isUnusedEntity);
  const units = consideredUnits.map((entity) => ({ ...entity, cues: voiceCues(entity) }));
  const lunar = units.find((unit) => unit.id.toLowerCase() === "lunr");
  if (lunar) {
    const known = new Set(lunar.cues.map((cue) => cue.assetId));
    const supplemental = (await supplementalCosmonautDeathCues(source.id))
      .filter((cue) => !known.has(cue.assetId));
    lunar.cues.push(...supplemental);
  }
  const groups = groupSharedVoiceSets(units);
  const allCues = groups.flatMap((group) => group.cues);
  const cueMetadata = new Map((await mapLimit(
    [...new Map(allCues.map((cue) => [cue.assetId, cue])).values()],
    8,
    async (cue) => {
      const metadata = await fetchJson(`/api/assets/${encodeURIComponent(cue.assetId)}/metadata`);
      return [cue.assetId, metadata];
    },
  )).map((entry) => entry));
  for (const group of groups) {
    for (const cue of group.cues) {
      const metadata = cueMetadata.get(cue.assetId) || {};
      cue.durationSeconds = Number(metadata.duration_seconds || 0);
      cue.sizeBytes = Number(metadata.size || 0);
    }
  }
  const cueIds = new Set(groups.flatMap((group) => group.cues.map((cue) => cue.assetId)));
  const audioDurationSeconds = groups.reduce(
    (total, group) => total + group.cues.reduce((sum, cue) => sum + cue.durationSeconds, 0),
    0,
  );
  const audioBytes = [...cueIds].reduce(
    (total, assetId) => total + Number(cueMetadata.get(assetId)?.size || 0),
    0,
  );
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appUrl: BASE_URL,
    appVersion: (await fetchJson("/api/health")).version,
    source: { id: source.id, scannedAt: source.scanned_at },
    selection: {
      side: "Nod",
      kinds: KINDS,
      requiresTranscript: false,
      requiresSpokenWords: false,
      includesVocalSoundSlots: true,
      includesSupplementalCosmonautDeathEvent: true,
      deduplicateSharedVoiceSets: true,
      excludesUnusedEntities: true,
    },
    summary: {
      unitsFound: units.length,
      unitsWithVoices: units.filter((unit) => unit.cues.length > 0).length,
      sharedVoiceGroups: groups.length,
      uniqueVoiceAssets: cueIds.size,
      presentations: groups.reduce((total, group) => total + group.cues.length, 0),
      audioDurationSeconds: Number(audioDurationSeconds.toFixed(3)),
      audioBytes,
      byKind: Object.fromEntries(KINDS.map((kind) => [kind, {
        units: units.filter((unit) => unit.kind === kind).length,
        unitsWithVoices: units.filter((unit) => unit.kind === kind && unit.cues.length > 0).length,
        groups: groups.filter((group) => group.kind === kind).length,
        presentations: groups.filter((group) => group.kind === kind)
          .reduce((total, group) => total + group.cues.length, 0),
      }])),
    },
    groups,
    excludedUnits: [
      ...units.filter((unit) => unit.cues.length === 0).map((unit) => ({
        id: unit.id,
        name: unit.display_name,
        kind: unit.kind,
        reason: "没有单位语音或声音",
      })),
      ...ignoredUnits.map((unit) => ({
        id: unit.id,
        name: unit.display_name,
        kind: unit.kind,
        reason: "游戏规则标记为未使用",
      })),
    ],
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    output: OUTPUT,
    ...output.summary,
    groups: output.groups.map((group) => ({
      kind: group.kind,
      representative: group.representative.name,
      usage: group.representative.usage,
      units: group.units.map((unit) => `${unit.name} [${unit.id}/${unit.usage}]`),
      voices: group.cues.length,
    })),
    excludedUnits: output.excludedUnits,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
