const SLOT_ORDER = new Map([
  ["create", 0],
  ["select", 1],
  ["move", 2],
  ["enter", 3],
  ["capture", 4],
  ["deploy", 5],
  ["attack", 6],
  ["weapon", 7],
  ["special_attack", 8],
  ["feedback", 9],
  ["harvest", 10],
  ["die", 99],
]);

const SLOT_LABELS = {
  create: "出场",
  select: "选中",
  move: "移动",
  enter: "进入",
  capture: "占领",
  deploy: "部署",
  attack: "攻击",
  weapon: "开火",
  special_attack: "特殊攻击",
  feedback: "受击",
  harvest: "采集",
  die: "阵亡",
};

const ASSET_SLOT_PATTERNS = [
  [/(?:sel|se)[a-z]$/i, "select"],
  [/(?:mov|mo)[a-z]$/i, "move"],
  [/(?:atc|at)[a-z]$/i, "attack"],
  [/(?:fea|fe)[a-z]$/i, "feedback"],
  [/die?[a-z]$/i, "die"],
  [/cr[a-z]$/i, "create"],
];

const WEAPON_SOUND_DESCRIPTIONS = new Map([
  ["conscriptattack", { original: "<Rifle fire>", translated: "<步枪开火声>" }],
  ["defusekit", { original: "<Defusing sound>", translated: "<拆弹声>" }],
  ["lasercosmoattack", { original: "<Laser fire>", translated: "<激光发射声>" }],
  ["teslatroopeliteattack", { original: "<Elite electric arc discharge>", translated: "<精英电弧放电声>" }],
  ["teslatroopattack", { original: "<Electric arc discharge>", translated: "<电弧放电声>" }],
  ["teslatrooprechargecoil", { original: "<Coil charging>", translated: "<线圈充能声>" }],
  ["borisattack", { original: "<Assault rifle fire>", translated: "<突击步枪开火声>" }],
  ["dogattack", { original: "<Bite>", translated: "<撕咬声>" }],
  ["desolatorattack", { original: "<Radiation beam fire>", translated: "<辐射射线发射声>" }],
  ["desolatordeploy", { original: "<Radiation burst>", translated: "<辐射爆发声>" }],
]);

function inferredSlotFromAssetName(assetName) {
  const stem = String(assetName || "").replace(/\.[^.]+$/, "");
  return ASSET_SLOT_PATTERNS.find(([expression]) => expression.test(stem))?.[1] || "";
}

function preferredSlotForEventName(eventName) {
  const event = String(eventName || "");
  if (/created|createvoice/i.test(event)) return "create";
  if (/select/i.test(event)) return "select";
  if (/move/i.test(event)) return "move";
  if (/attack/i.test(event)) return "attack";
  if (/fear|feedback/i.test(event)) return "feedback";
  if (/die|death/i.test(event)) return "die";
  if (/capture|liberated|steal/i.test(event)) return "capture";
  if (/deploy|transform/i.test(event)) return "deploy";
  return "";
}

function chooseCueEvent(cue, unitId = "") {
  const events = Array.isArray(cue?.events) ? cue.events : [];
  if (!events.length) return { slot: "select", event: "", source: unitId };

  const inferred = inferredSlotFromAssetName(cue.assetName);
  if (inferred === "attack" && /engineer/i.test(unitId)) {
    const capture = events.find((event) => event.slot === "capture");
    if (capture) return capture;
  }
  if (inferred) {
    const exact = events.find((event) => event.slot === inferred);
    if (exact) return exact;
    if (inferred === "attack") {
      const compatible = events.find((event) => ["capture", "special_attack"].includes(event.slot));
      if (compatible) return compatible;
    }
  }

  for (const event of events) {
    const semanticSlot = preferredSlotForEventName(event.event);
    if (!semanticSlot) continue;
    const exact = events.find((candidate) => candidate.slot === semanticSlot);
    if (exact) return exact;
  }
  return [...events].sort((left, right) => (
    (SLOT_ORDER.get(left.slot) ?? 50) - (SLOT_ORDER.get(right.slot) ?? 50)
  ))[0];
}

function eventLabel(event) {
  if (event?.slot === "feedback" && /fear/i.test(event.event || "")) return "受惊";
  return SLOT_LABELS[event?.slot] || "单位回应";
}

function soundDescription(eventName, slot) {
  if (slot === "weapon") {
    return WEAPON_SOUND_DESCRIPTIONS.get(String(eventName || "").toLowerCase())
      || { original: "<Weapon sound>", translated: "<武器声>" };
  }
  if (slot === "die") return { original: "<Death cry>", translated: "<阵亡声>" };
  return { original: "", translated: "" };
}

function animationMatchesSlot(slot, animationEvent) {
  const patterns = {
    create: /cheer|idle|ready|guard/i,
    select: /idle|ready|guard|cheer/i,
    move: /walk|fly|swim|move/i,
    enter: /walk|enter/i,
    capture: /walk|capture|deploy/i,
    deploy: /deploy|down|idle/i,
    harvest: /work|harvest|walk/i,
    attack: /fire|attack|shoot|deploy/i,
    weapon: /fire|attack|shoot|deploy/i,
    special_attack: /deploy|fire|attack|shoot/i,
    feedback: /down|tumble|idle|panic/i,
    die: /die|death|tumble/i,
  };
  return (patterns[slot] || /preview|idle/i).test(String(animationEvent || ""));
}

module.exports = {
  SLOT_ORDER,
  SLOT_LABELS,
  animationMatchesSlot,
  chooseCueEvent,
  eventLabel,
  inferredSlotFromAssetName,
  soundDescription,
};
