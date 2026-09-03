const PROFILES = {
  soviet: {
    key: "soviet",
    side: "Nod",
    sideLabel: "苏军",
    sectionTitle: "苏军步兵单位语音",
    manifestTitle: "苏军步兵单位语音全览",
    outputName: "Soviet-Infantry-Voices",
    filePrefix: "soviet-voices",
    playerColor: "red",
    scaleReferenceUnit: "IVAN",
    scaleReferenceLabel: "疯狂伊文",
    horizontalScaleUnits: ["DOG"],
    visualScaleByUnit: {},
    flyingUnits: ["LUNR"],
    amphibiousUnits: [],
    explosiveUnits: ["TERROR", "IVAN"],
    supplementalCosmonautDeath: true,
    presentationOrder: [
      "E2", "SENGINEER", "TERROR", "SHK", "IVAN", "DESO", "BORIS", "LUNR", "DOG",
    ],
    smokeSlots: {
      E2: ["weapon", "feedback", "die"],
      SENGINEER: ["move", "capture", "weapon", "feedback", "die"],
      TERROR: ["move", "attack", "feedback", "die"],
      SHK: ["move", "weapon", "feedback", "die"],
      IVAN: ["move", "attack", "die"],
      DESO: ["move", "attack", "weapon", "die"],
      BORIS: ["create", "move", "attack", "weapon", "feedback", "die"],
      LUNR: ["move", "attack", "weapon", "feedback", "die"],
      DOG: ["weapon", "feedback", "die"],
    },
    colors: {
      primary: "#ef625c",
      secondary: "#ffb0aa",
      event: "#dc8a85",
      accentStart: "#a93632",
      accentEnd: "#ed5a54",
      glow: "rgba(139,42,38,.28)",
      primaryShadow: "rgba(156,35,31,.32)",
      textShadow: "rgba(153,35,31,.22)",
      titleShadow: "rgba(132,25,22,.38)",
    },
  },
  allied: {
    key: "allied",
    side: "GDI",
    sideLabel: "盟军",
    sectionTitle: "盟军步兵单位语音",
    manifestTitle: "盟军步兵单位语音全览",
    outputName: "Allied-Infantry-Voices",
    filePrefix: "allied-voices",
    playerColor: "blue",
    scaleReferenceUnit: "E1",
    scaleReferenceLabel: "美国大兵",
    horizontalScaleUnits: ["ADOG"],
    visualScaleByUnit: {
      SPY: 0.9,
      TANY: 1.12,
      ADOG: 0.85,
    },
    flyingUnits: ["JUMPJET"],
    amphibiousUnits: ["GHOST", "TANY"],
    explosiveUnits: [],
    supplementalCosmonautDeath: false,
    presentationOrder: [
      "E1", "ENGINEER", "GGI", "JUMPJET", "SNIPE", "SPY", "GHOST", "CLEG", "TANY", "ADOG",
    ],
    smokeSlots: {
      E1: ["move", "attack", "weapon", "feedback", "die"],
      ENGINEER: ["move", "capture", "weapon", "feedback", "die"],
      GGI: ["move", "attack", "weapon", "feedback", "die"],
      JUMPJET: ["move", "attack", "weapon", "feedback", "die"],
      SNIPE: ["move", "attack", "weapon", "feedback", "die"],
      SPY: ["move", "capture", "feedback", "die"],
      GHOST: ["move", "attack", "weapon", "feedback", "die"],
      CLEG: ["move", "attack", "weapon", "feedback", "die"],
      TANY: ["create", "move", "attack", "weapon", "feedback", "die"],
      ADOG: ["weapon", "feedback", "die"],
    },
    colors: {
      primary: "#67b5ff",
      secondary: "#b8ddff",
      event: "#8bc5f5",
      accentStart: "#2d72b8",
      accentEnd: "#67b5ff",
      glow: "rgba(40,103,166,.30)",
      primaryShadow: "rgba(35,99,164,.34)",
      textShadow: "rgba(38,105,171,.24)",
      titleShadow: "rgba(27,78,132,.42)",
    },
  },
};

function profileKeyFromArguments(arguments_) {
  const option = arguments_.find((value) => value.startsWith("--profile="));
  return (option?.slice("--profile=".length) || "soviet").toLowerCase();
}

function voiceVideoProfile(key) {
  const profile = PROFILES[String(key || "soviet").toLowerCase()];
  if (!profile) throw new Error(`未知语音演示阵营：${key}`);
  return profile;
}

module.exports = { PROFILES, profileKeyFromArguments, voiceVideoProfile };
