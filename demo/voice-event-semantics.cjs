const SLOT_ORDER = new Map([
  ["create", 0],
  ["select", 1],
  ["move", 2],
  ["enter", 3],
  ["capture", 4],
  ["deploy", 5],
  ["disguise", 5.5],
  ["infiltrate", 5.55],
  ["defuse", 5.6],
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
  disguise: "伪装",
  infiltrate: "渗透",
  defuse: "拆弹",
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
  ["chronolegionattack", { original: "<Chrono beam>", translated: "<超时空射线声>" }],
  ["sealattack", { original: "<Submachine gun fire>", translated: "<冲锋枪开火声>" }],
  ["sealplacebomb", { original: "<Explosive charge placement>", translated: "<安放炸药声>" }],
  ["rocketeerattack", { original: "<20 mm cannon fire>", translated: "<20 毫米机炮开火声>" }],
  ["spyattack", { original: "<Disguise activation>", translated: "<启动伪装声>" }],
  ["sniperattack", { original: "<Sniper rifle fire>", translated: "<狙击步枪开火声>" }],
  ["giattack", { original: "<Rifle fire>", translated: "<步枪开火声>" }],
  ["giattackdeployed", { original: "<Deployed rifle fire>", translated: "<部署姿态步枪开火声>" }],
  ["tanyaattack", { original: "<Pistol fire>", translated: "<手枪开火声>" }],
  ["guardiangideployedattack", { original: "<Rocket launcher fire>", translated: "<火箭筒开火声>" }],
]);

const CUE_ANIMATION_OVERRIDES = new Map([
  ["igiate", ["deploy"]],
  ["igifea", ["crawl"]],
  ["ienafec", ["crawl"]],
  ["iggifee", ["crawl"]],
  ["iggifef", ["crawl"]],
  ["isnimoc", ["crawl"]],
  ["isnimod", ["crawl"]],
  ["isnimoe", ["crawl"]],
  ["isniatb", ["fireprone"]],
  ["isniatc", ["fireprone"]],
  ["isniatta", ["fireprone"]],
]);

function cueStem(assetName) {
  return String(assetName || "").replace(/\.[^.]+$/, "").toLowerCase();
}

function animationIntent(sequenceNames) {
  return {
    key: sequenceNames.join("+"),
    sequenceNames,
  };
}

function animationIntentForCue(cue, options = {}) {
  const slot = String(cue.slot || "select");
  const eventName = String(cue.eventName || "");
  const original = String(cue.original || "");
  const exact = CUE_ANIMATION_OVERRIDES.get(cueStem(cue.assetName));
  if (exact) return animationIntent(exact);

  if (slot === "die" && options.flying) return animationIntent(["airdeathstart+airdeathfinish"]);
  if (slot === "die") return animationIntent(["die1", "die2", "death", "tumble"]);
  if (slot === "create") return animationIntent(["cheer"]);
  if (slot === "select") return animationIntent(["idle1", "idle2", "ready", "guard"]);
  if (slot === "move") {
    if (options.flying) return animationIntent(["fly"]);
    if (options.amphibious && /\bswim\b/i.test(original)) return animationIntent(["swim"]);
    return animationIntent(["walk"]);
  }
  if (["enter", "capture", "infiltrate"].includes(slot)) {
    return animationIntent(["walk"]);
  }
  if (slot === "defuse") return animationIntent(["idle1", "idle2"]);
  if (slot === "disguise") return animationIntent(["idle1", "idle2"]);
  if (slot === "deploy") return animationIntent(["deploy"]);
  if (slot === "feedback") return animationIntent(["panic"]);
  if (["attack", "weapon", "special_attack"].includes(slot)) {
    if (options.flying) return animationIntent(["firefly"]);
    if (options.explosive) return animationIntent(["deploy"]);
    if (/deploy/i.test(eventName)) return animationIntent(["deployedfire"]);
    if (/\bdiggin['’]?\s+in\b/i.test(original)) return animationIntent(["deployedfire"]);
    return animationIntent(["fireup"]);
  }
  if (slot === "harvest") return animationIntent(["work", "harvest", "walk"]);
  return animationIntent(["idle1", "idle2", "ready", "guard"]);
}

function animationMatchesIntent(intent, animationEvent) {
  const event = String(animationEvent || "").toLowerCase();
  return (intent?.sequenceNames || []).some((name) => String(name).toLowerCase() === event);
}

function inferredSlotFromAssetName(assetName) {
  const stem = String(assetName || "").replace(/\.[^.]+$/, "");
  return ASSET_SLOT_PATTERNS.find(([expression]) => expression.test(stem))?.[1] || "";
}

function preferredSlotForEventName(eventName) {
  const event = String(eventName || "");
  if (/created|createvoice/i.test(event)) return "create";
  if (/select/i.test(event)) return "select";
  if (/move/i.test(event)) return "move";
  if (/spyspecialattack|infiltrat/i.test(event)) return "infiltrate";
  if (/spyattack|disguise/i.test(event)) return "disguise";
  if (/defusekit|defus/i.test(event)) return "defuse";
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

  const specialized = events.find((event) => ["disguise", "infiltrate", "defuse"].includes(
    preferredSlotForEventName(event.event),
  ));
  if (specialized) return { ...specialized, slot: preferredSlotForEventName(specialized.event) };

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
  return SLOT_LABELS[event?.slot] || "单位回应";
}

function soundDescription(eventName, slot) {
  const defined = WEAPON_SOUND_DESCRIPTIONS.get(String(eventName || "").toLowerCase());
  if (defined) return defined;
  if (slot === "weapon") {
    return { original: "<Weapon sound>", translated: "<武器声>" };
  }
  if (slot === "die") return { original: "<Death cry>", translated: "<阵亡声>" };
  return { original: "", translated: "" };
}

function terminalPunctuationKind(text) {
  const value = String(text || "").trim();
  if (!value || /^<[^<>]+>$/.test(value)) return "";
  const punctuation = value.match(/(?:\.{2,}|…+|[.!?,;:。！？；：，]+)$/u)?.[0] || "";
  if (!punctuation) return "";
  if (/[?？]/u.test(punctuation) && /[!！]/u.test(punctuation)) return "question_exclamation";
  if (/[?？]/u.test(punctuation)) return "question";
  if (/[!！]/u.test(punctuation)) return "exclamation";
  if (/(?:\.{2,}|…)/u.test(punctuation)) return "ellipsis";
  if (/[;；]/u.test(punctuation)) return "semicolon";
  if (/[:：]/u.test(punctuation)) return "colon";
  if (/[,，]/u.test(punctuation)) return "comma";
  return "period";
}

function alignTranslationPunctuation(original, translation) {
  const value = String(translation || "").trim();
  if (!value) return "";
  if (/^<[^<>]+>$/.test(String(original || "").trim()) && /^<[^<>]+>$/.test(value)) return value;
  const punctuation = {
    question_exclamation: "？！",
    question: "？",
    exclamation: "！",
    ellipsis: "……",
    semicolon: "；",
    colon: "：",
    comma: "，",
    period: "。",
  }[terminalPunctuationKind(original)] || "";
  const content = value.replace(/(?:\.{2,}|…+|[.!?,;:。！？；：，]+)$/u, "").trimEnd();
  return `${content}${punctuation}`;
}

function animationMatchesSlot(slot, animationEvent) {
  const patterns = {
    create: /cheer|idle|ready|guard/i,
    select: /idle|ready|guard|cheer/i,
    move: /walk|fly|swim|move|crawl/i,
    enter: /walk|enter/i,
    capture: /walk|capture|deploy/i,
    deploy: /deploy|crawl|idle/i,
    disguise: /walk|idle|ready|guard/i,
    infiltrate: /walk|enter|idle|ready|guard/i,
    defuse: /deploy|walk|capture|idle/i,
    harvest: /work|harvest|walk/i,
    attack: /fire|attack|shoot|deploy/i,
    weapon: /fire|attack|shoot|deploy/i,
    special_attack: /deploy|fire|attack|shoot/i,
    feedback: /crawl|panic|hit|fear/i,
    die: /die|death|tumble/i,
  };
  return (patterns[slot] || /preview|idle/i).test(String(animationEvent || ""));
}

module.exports = {
  SLOT_ORDER,
  SLOT_LABELS,
  animationIntentForCue,
  animationMatchesSlot,
  animationMatchesIntent,
  chooseCueEvent,
  eventLabel,
  inferredSlotFromAssetName,
  alignTranslationPunctuation,
  soundDescription,
  terminalPunctuationKind,
};
