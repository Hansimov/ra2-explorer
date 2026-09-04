import {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  lazy,
  memo,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Suspense,
  UIEvent as ReactUIEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  api,
  Asset,
  AssetAssociationPage,
  AssetMetadata,
  AssetSort,
  CountryFacet,
  DiscoveryResult,
  EntityDependency,
  EntityKind,
  EntitySummary,
  EntityUsage,
  GameEntity,
  GameLanguage,
  GameInstallation,
  MediaAssociation,
  MediaItem,
  MediaKind,
  MediaSample,
  MediaSort,
  PlayerColor,
  ResourcePack,
  Source,
  Stats,
  TextAsset,
  UpdateInfo,
  isStaticSnapshot,
  staticPopoutUrl,
} from "./api";
import {
  getAudioPlaybackState,
  pauseAudioAsset,
  subscribeAudioPlayback,
  toggleAudioAsset,
  useAudioPlayback,
} from "./audioPlayback";
import {
  hasLoadedCardPreview,
  pauseCardPreviewBackground,
  preloadAudioResource,
  preloadAudioResourceGroup,
  preloadCardPreview,
  preloadCardPreviewGroup,
} from "./resourcePreload";

let voxelViewerModulePromise: Promise<typeof import("./VoxelViewer")> | null = null;

function loadVoxelViewerModule() {
  voxelViewerModulePromise ||= import("./VoxelViewer").then((module) => {
    module.configureVoxelPreload(true);
    return module;
  });
  return voxelViewerModulePromise;
}

const VoxelViewer = lazy(async () => ({ default: (await loadVoxelViewerModule()).VoxelViewer }));

function VoxelPreview({ url, label, viewKey, previewAngle = DEFAULT_PREVIEW_ANGLE, resetAngle = previewAngle, onPreviewAngleChange }: {
  url: string;
  label: string;
  viewKey: string;
  previewAngle?: PreviewAngle;
  resetAngle?: PreviewAngle;
  onPreviewAngleChange?: (angle: PreviewAngle) => void;
}) {
  const finishPriorityRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const finish = pauseCardPreviewBackground();
    finishPriorityRef.current = finish;
    return () => {
      if (finishPriorityRef.current === finish) finishPriorityRef.current = null;
      finish();
    };
  }, [url]);
  const finishPriority = useCallback(() => {
    finishPriorityRef.current?.();
    finishPriorityRef.current = null;
  }, []);
  return <Suspense fallback={<div className="voxel-viewer"><div className="voxel-status">正在载入三维视图…</div></div>}><VoxelViewer url={url} label={label} viewKey={viewKey} previewAngle={previewAngle} resetAngle={resetAngle} onPreviewAngleChange={onPreviewAngleChange} onLoadSettled={finishPriority} /></Suspense>;
}

type IconName =
  | "aircraft"
  | "archive"
  | "building"
  | "chevron"
  | "close"
  | "download"
  | "file"
  | "filter"
  | "folder"
  | "grid"
  | "image"
  | "infantry"
  | "info"
  | "list"
  | "pause"
  | "play"
  | "popout"
  | "search"
  | "settings"
  | "sound"
  | "spark"
  | "swatch"
  | "unit"
  | "voice";

const iconPaths: Record<IconName, ReactNode> = {
    aircraft: <><path d="m3 14 8-3V5l2-2 1 8 7 3v2l-7-1.5-1 6.5h-2l-1-6.5L3 16z" /></>,
    archive: <><path d="M4 7.5h16v12H4z" /><path d="M3 4.5h18v3H3zM9 11h6" /></>,
    building: <><path d="M5 21V4h10v17M15 9h4v12M8 8h4M8 12h4M8 16h4M3 21h18" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 20h14" /></>,
    file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
    folder: <path d="M3 6h7l2 2h9v11H3z" />,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m4 17 5-4 4 3 3-2 4 3" /></>,
    infantry: <><circle cx="12" cy="5" r="2" /><path d="M12 7v6m0-3-4 3m4-3 4 3m-4 0-3 7m3-7 3 7" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    pause: <><path d="M9 7v10M15 7v10" /></>,
    play: <path d="m9 7 8 5-8 5z" />,
    popout: <><path d="M13 4h7v7M20 4l-9 9" /><path d="M18 13v7H4V6h7" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.55-1.03H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.55V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.55 1.03H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></>,
    sound: <><path d="M4 10h3l4-4v12l-4-4H4zM15 9c1.5 1.5 1.5 4.5 0 6M18 6c3.5 3.5 3.5 8.5 0 12" /></>,
    spark: <><path d="m12 3 1.1 4.2L17 9l-3.9 1.8L12 15l-1.1-4.2L7 9l3.9-1.8z" /><path d="m19 15 .6 2.4L22 18.5l-2.4 1.1L19 22l-.6-2.4-2.4-1.1 2.4-1.1z" /></>,
    swatch: <><path d="M4 4h6v16H4zM10 7h5v13h-5zM15 10h5v10h-5z" /><path d="M7 16h.01M12.5 16h.01M17.5 16h.01" /></>,
    unit: <><path d="M5 10h11l3 3v4H5z" /><path d="M8 10V7h6l2 3M14 7l3-2M4 17h16" /><circle cx="8" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
    voice: <><path d="M5 5h14v11H9l-4 4z" /><path d="M9 9h6M9 12h4" /></>,
};

const Icon = memo(function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{iconPaths[name]}</g>
    </svg>
  );
});

function SidebarToggle({ initialCollapsed, onChange }: {
  initialCollapsed: boolean;
  onChange: (collapsed: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    onChange(next);
  }
  return (
    <button
      className="sidebar-toggle"
      type="button"
      onClick={toggle}
      title={collapsed ? "展开导航" : "收起导航"}
      aria-label={collapsed ? "展开导航" : "收起导航"}
      aria-expanded={!collapsed}
    >
      <Icon name="chevron" size={16} />
    </button>
  );
}

const formatLabels: Record<string, string> = {
  shp: "SHP 动画",
  pal: "PAL 配色表",
  mix: "MIX 归档",
  ini: "INI 配置",
  csf: "CSF 文本",
  vxl: "VXL 模型",
  hva: "HVA 动画",
  tmp: "TMP 地块",
  pcx: "PCX 图像",
  map: "地图配置",
  text: "文本",
  wav: "WAV 音频",
  bag_audio: "BAG 音频",
  aud: "AUD 音频",
  bag: "音频包",
  idx: "音频索引",
  vpl: "VPL 光照",
  fnt: "游戏字体",
  video: "过场视频",
  binary: "二进制",
  unknown: "其他",
};

const entityKindLabels: Record<EntityKind, string> = {
  vehicle: "载具",
  infantry: "步兵",
  aircraft: "航空器",
  building: "建筑",
};

const componentRoleLabels: Record<string, string> = {
  body: "主体",
  body_hva: "主体动画",
  turret: "炮塔",
  turret_hva: "炮塔动画",
  barrel: "炮管",
  barrel_hva: "炮管动画",
  cameo: "建造图标",
  alt_cameo: "升级图标",
};

const ruleLabels: Record<string, string> = {
  cost: "造价",
  strength: "生命值",
  armor: "装甲",
  speed: "速度",
  sight: "视野",
  tech_level: "科技等级",
  category: "分类",
  owner: "阵营",
  prerequisite: "前置建筑",
  primary: "主武器",
  secondary: "副武器",
  elite_primary: "精英主武器",
  elite_secondary: "精英副武器",
  movement_zone: "移动区域",
};

const dependencyKindLabels: Record<EntityDependency["kind"], string> = {
  weapon: "武器",
  projectile: "弹体",
  warhead: "弹头",
};

const dependencySlotLabels: Record<string, string> = {
  primary: "主武器",
  secondary: "副武器",
  elite_primary: "精英主武器",
  elite_secondary: "精英副武器",
  destruction: "摧毁武器",
};

const dependencyPropertyLabels: Record<string, string> = {
  damage: "伤害",
  rate_of_fire: "射速",
  range: "射程",
  minimum_range: "最近射程",
  burst: "连发",
  speed: "速度",
  projectile: "弹体",
  warhead: "弹头",
  report: "音效",
  animation: "动画",
  image: "图像",
  arcing: "抛物线",
  invisible: "不可见",
  proximity: "近炸",
  rotation: "转向",
  acceleration: "加速度",
  inaccurate: "散布",
  verses: "装甲倍率",
  cell_spread: "范围",
  percent_at_max: "边缘伤害",
  infantry_death: "步兵死亡",
  animation_list: "命中动画",
  wall: "墙体",
  wood: "木质",
  radiation: "辐射",
};

const mediaSlotLabels: Record<string, string> = {
  select: "选中",
  move: "移动",
  attack: "攻击",
  feedback: "受击",
  special_attack: "特殊攻击",
  capture: "占领",
  harvest: "采集",
  die: "阵亡",
  create: "建造完成",
  deploy: "部署",
  deploy_sound: "部署音效",
  undeploy: "取消部署",
  enter: "进入目标",
  enter_transport: "进入载具",
  leave_transport: "离开载具",
  movement: "行驶",
  start_moving: "开始移动",
  stop_moving: "停止移动",
  turret_rotate: "炮塔转动",
  activate: "启动",
  deactivate: "关闭",
  cloak: "隐形",
  uncloak: "解除隐形",
  chrono_in: "超时空进入",
  chrono_out: "超时空离开",
  crashing: "坠毁",
  impact_land: "撞击地面",
  sinking: "沉没",
  impact_water: "落水",
  primary: "主武器",
  secondary: "副武器",
  elite_primary: "精英主武器",
  elite_secondary: "精英副武器",
  destruction: "DeathWeapon",
  body_animation: "主体动画",
  body_hva: "主体动作",
  turret_hva: "炮塔动作",
  barrel_hva: "炮管动作",
  body_sequence: "主体动作",
  sound_event: "声音事件",
  eva_allied: "盟军",
  eva_soviet: "苏军",
  eva_yuri: "尤里",
  advisor_eva: "EVA 介绍",
  advisor_sofia: "索菲亚介绍",
  multiplayer_funds: "资源不足",
  multiplayer_attack: "准备进攻",
  multiplayer_help: "请求支援",
  multiplayer_coordination: "协同作战",
  taunt_surrender: "劝降",
  taunt_laugh: "嘲笑",
  taunt_retort: "回击",
  taunt_victory: "胜利挑衅",
  mission_briefing: "任务简报",
  mission_objective: "目标指引",
  mission_introduction: "人物与单位介绍",
  mission_warning: "战况警告",
  mission_progress: "任务进展",
  mission_failure: "失败与损失",
  mission_dialogue: "剧情对白",
  buildup: "建造",
  activeanim: "运转",
  activeanimtwo: "辅助运转",
  activeanimthree: "运转层三",
  activeanimfour: "运转层四",
  productionanim: "生产",
  idleanim: "待机",
  idleanimtwo: "待机层二",
  idleanimthree: "待机层三",
  idleanimfour: "待机层四",
  specialanim: "特殊动作开始",
  specialanimtwo: "特殊动作持续",
  specialanimthree: "特殊动作结束",
  specialanimfour: "特殊动作附加",
  superanim: "未充能待机",
  superanimtwo: "充能启动",
  superanimthree: "充能就绪",
  superanimfour: "发射后复位",
  deployinganim: "生产展开",
  underdooranim: "下层门体",
  roofdeployinganim: "屋顶展开",
  underroofdooranim: "屋顶门体",
  bibshape: "地基",
  taunt: "多人嘲讽",
  ambient: "场景播报",
  explosion: "爆炸",
  interface: "界面与过场",
};

const missionTitles: Record<string, string> = {
  "ra2:allied:1": "孤独守卫 · Lone Guardian",
  "ra2:allied:2": "鹰击长空 · Eagle Dawn",
  "ra2:allied:3": "最高长官 · Hail to the Chief",
  "ra2:allied:4": "最后机会 · Last Chance",
  "ra2:allied:5": "暗夜 · Dark Night",
  "ra2:allied:6": "自由 · Liberty",
  "ra2:allied:7": "深海 · Deep Sea",
  "ra2:allied:8": "自由门户 · Free Gateway",
  "ra2:allied:9": "太阳神殿 · Sun Temple",
  "ra2:allied:10": "海市蜃楼 · Mirage",
  "ra2:allied:11": "核爆辐射尘 · Fallout",
  "ra2:allied:12": "超时空风暴 · Chrono Storm",
  "ra2:soviet:1": "红色黎明 · Red Dawn",
  "ra2:soviet:2": "危机四伏 · Hostile Shore",
  "ra2:soviet:3": "大苹果 · Big Apple",
  "ra2:soviet:4": "家乡前线 · Home Front",
  "ra2:soviet:5": "灯火之城 · City of Lights",
  "ra2:soviet:6": "划分 · Sub-Divide",
  "ra2:soviet:7": "超时空防御战 · Chrono Defense",
  "ra2:soviet:8": "首都之辱 · Desecration",
  "ra2:soviet:9": "狐狸与猎犬 · The Fox and the Hound",
  "ra2:soviet:10": "风云同盟 · Weathered Alliance",
  "ra2:soviet:11": "红色革命 · Red Revolution",
  "ra2:soviet:12": "北极风暴 · Polar Storm",
  "yr:allied:1": "光阴似箭 · Time Lapse",
  "yr:allied:2": "好莱坞梦一场 · Hollywood and Vain",
  "yr:allied:3": "电力竞赛 · Power Play",
  "yr:allied:4": "古墓突袭 · Tomb Raided",
  "yr:allied:5": "澳洲克隆战 · Clones Down Under",
  "yr:allied:6": "条约陷阱 · Trick or Treaty",
  "yr:allied:7": "脑死 · Brain Dead",
  "yr:soviet:1": "时空转移 · Time Shift",
  "yr:soviet:2": "似曾相识 · Deja Vu",
  "yr:soviet:3": "洗脑行动 · Brain Wash",
  "yr:soviet:4": "罗曼诺夫出逃 · Romanov on the Run",
  "yr:soviet:5": "逃逸速度 · Escape Velocity",
  "yr:soviet:6": "飞向月球 · To the Moon",
  "yr:soviet:7": "首脑游戏 · Head Games",
};

function numberedWeaponSlotLabel(slot: string) {
  const match = /^(elite_)?weapon_(\d+)$/.exec(slot);
  return match ? `${match[1] ? "精英" : ""}武器 ${match[2]}` : null;
}

function missionLabel(mission: NonNullable<MediaItem["mission"]>) {
  const game = mission.game === "ra2" ? "红色警戒 2" : "尤里的复仇";
  const campaign = {
    allied: "盟军战役",
    soviet: "苏军战役",
    tutorial: "教程",
    coop: "合作任务",
  }[mission.campaign];
  const number = mission.campaign === "coop" ? mission.number + 1 : mission.number;
  const title = missionTitles[mission.key];
  return `${game} · ${campaign} · 第 ${number} 关${title ? ` · ${title}` : ""}`;
}

function missionSlotLabel(slot: string) {
  const match = /^mission:(ra2|yr):(allied|soviet|tutorial|coop):(\d+)$/.exec(slot);
  if (!match) return null;
  return missionLabel({
    key: slot.slice("mission:".length),
    game: match[1] as "ra2" | "yr",
    campaign: match[2] as "allied" | "soviet" | "tutorial" | "coop",
    number: Number(match[3]),
  });
}

function mediaSlotLabel(slot: string) {
  return mediaSlotLabels[slot] || missionSlotLabel(slot) || numberedWeaponSlotLabel(slot) || slot;
}

function dependencySlotLabel(slot: string) {
  return dependencySlotLabels[slot] || numberedWeaponSlotLabel(slot) || slot;
}

const animationEventLabels: Record<string, string> = {
  ready: "准备",
  guard: "警戒",
  prone: "卧姿",
  walk: "行走",
  fireup: "站立开火",
  fireprone: "卧姿开火",
  firedown: "卧倒开火",
  crawl: "匍匐",
  up: "起身",
  down: "卧倒",
  idle1: "待机一",
  idle2: "待机二",
  die1: "阵亡一",
  die2: "阵亡二",
  die3: "阵亡三",
  die4: "阵亡四",
  die5: "阵亡五",
  cheer: "欢呼",
  paradrop: "空降",
  deploy: "部署",
  undeploy: "取消部署",
  deployed: "已部署",
  deployedfire: "部署开火",
  panic: "惊慌奔跑",
  fly: "飞行",
  hover: "悬停",
  fire: "开火",
  firefly: "空中开火",
  tumble: "失控翻滚",
  airdeathstart: "空中阵亡",
  airdeathfalling: "坠落",
  airdeathfinish: "落地",
  secondaryfire: "副武器开火",
  secondaryprone: "卧姿副武器",
};

function animationEventLabel(event: string) {
  return animationEventLabels[event.toLowerCase()] || event;
}

function animationEventTitle(event: string) {
  const label = animationEventLabel(event);
  return label === event ? event : `${event} · ${label}`;
}

function ruleFieldName(ruleField: string | null) {
  const normalized = (ruleField || "").toLowerCase().replaceAll("_", "");
  const labels: Record<string, string> = {
    "arttype.buildup": "建造",
    "arttype.activeanim": "运行层一",
    "arttype.activeanimtwo": "运行层二",
    "arttype.activeanimthree": "运行层三",
    "arttype.activeanimfour": "运行层四",
    "arttype.idleanim": "待机层一",
    "arttype.idleanimtwo": "待机层二",
    "arttype.idleanimthree": "待机层三",
    "arttype.idleanimfour": "待机层四",
    "arttype.productionanim": "生产",
    "arttype.specialanim": "特殊动作开始",
    "arttype.specialanimtwo": "特殊动作持续",
    "arttype.specialanimthree": "特殊动作结束",
    "arttype.specialanimfour": "特殊动作附加",
    "arttype.superanim": "未充能待机",
    "arttype.superanimtwo": "充能启动",
    "arttype.superanimthree": "充能就绪",
    "arttype.superanimfour": "发射后复位",
    "arttype.deployinganim": "生产展开",
    "arttype.underdooranim": "下层门体",
    "arttype.roofdeployinganim": "屋顶展开",
    "arttype.underroofdooranim": "屋顶门体",
    "weapontype.anim": "开火效果",
    "warheadtype.animlist": "命中特效",
    "warheadtype.splashlist": "水面命中特效",
    "technotype.debristypes": "飞散残骸",
    "technotype.debrisanims": "飞散残骸",
    "general.metallicdebris": "金属残骸",
  };
  if (labels[normalized]) return labels[normalized];
  const fields = ruleField?.split(".") || [];
  return fields[fields.length - 1] || "动画引用";
}

const mediaGroupLabels: Record<string, string> = {
  selection_voice: "选中回应",
  movement_voice: "移动指令",
  combat_voice: "攻击指令",
  feedback_voice: "受击与反馈",
  death_voice: "阵亡语音",
  ability_voice: "部署与技能",
  unit_voice: "单位语音",
  eva_voice: "EVA 播报",
  unit_intel_voice: "单位介绍",
  world_domination_voice: "全球征服播报",
  mission_voice: "任务对白",
  multiplayer_voice: "多人通讯",
  taunt_voice: "多人嘲讽",
  ambient_voice: "场景播报",
  other_voice: "其他语音",
  weapon_sound: "武器开火",
  death_sound: "阵亡与毁坏",
  movement_sound: "移动与机械",
  action_sound: "单位动作与操作",
  impact_sound: "撞击与坠毁",
  destruction_sound: "爆炸与摧毁",
  unit_sound: "单位动作",
  ambient_sound: "环境音效",
  notification_sound: "提示与奖励",
  structure_sound: "建筑运转",
  superweapon_sound: "超级武器",
  interface_sound: "界面与过场",
  other_sound: "其他音效",
  unclassified: "未关联音频",
};

const mediaGroupOrder = [
  "selection_voice", "movement_voice", "combat_voice", "feedback_voice", "death_voice", "ability_voice",
  "unit_voice", "eva_voice", "unit_intel_voice", "world_domination_voice", "mission_voice",
  "multiplayer_voice", "taunt_voice", "ambient_voice", "other_voice",
  "weapon_sound", "death_sound", "movement_sound", "action_sound", "impact_sound",
  "destruction_sound", "superweapon_sound", "structure_sound", "unit_sound",
  "notification_sound", "ambient_sound", "interface_sound", "other_sound",
  "unclassified",
];

function orderedMediaGroups(groups: Array<{ group: string; count: number }>) {
  return [...groups].sort((left, right) => {
    const leftRank = mediaGroupOrder.indexOf(left.group);
    const rightRank = mediaGroupOrder.indexOf(right.group);
    return (leftRank < 0 ? mediaGroupOrder.length : leftRank)
      - (rightRank < 0 ? mediaGroupOrder.length : rightRank)
      || left.group.localeCompare(right.group);
  });
}

const sideLabels: Record<string, string> = {
  GDI: "盟军",
  Nod: "苏军",
  ThirdSide: "尤里",
  unaffiliated: "无阵营",
  Civilian: "平民",
  Mutant: "特殊",
};

const primarySideOrder = ["GDI", "Nod", "ThirdSide"];

function affiliationClassId(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

const mapObjectLabels: Record<string, string> = {
  structure: "建筑",
  unit: "载具",
  infantry: "步兵",
  aircraft: "航空器",
  terrain: "地形对象",
  waypoint: "路径点",
};

const playerColorLabels: Record<string, string> = {
  red: "红色",
  blue: "蓝色",
  green: "绿色",
  yellow: "黄色",
  orange: "橙色",
  purple: "紫色",
  cyan: "青色",
  gray: "灰色",
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatDuration(value: number) {
  const total = Math.max(0, Math.round(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function canUseCompactTextTag(value: string) {
  if (value.includes("\n")) return false;
  const widthHint = Array.from(value.trim()).reduce((total, character) => {
    const point = character.codePointAt(0) || 0;
    return total + (point >= 0x2e80 ? 2 : 1);
  }, 0);
  return widthHint <= 48;
}

function crcLabel(value: number | null) {
  return value === null ? "—" : value.toString(16).toUpperCase().padStart(8, "0");
}

function assetIcon(format: string): IconName {
  if (["vxl", "hva"].includes(format)) return "unit";
  if (["shp", "tmp", "pcx"].includes(format)) return "image";
  if (format === "map") return "grid";
  if (format === "video") return "play";
  if (format === "pal") return "swatch";
  if (format === "mix") return "archive";
  if (["wav", "aud", "bag_audio"].includes(format)) return "play";
  return "file";
}

type LayoutMode = "list" | "grid";
type DetailPlacement = "right" | "bottom";
type MediaHeaderAlignment = "left" | "center";
type VoiceTextPreference = "translation" | "game";
type EntitySort = "cameo" | "faction" | "name_asc" | "name_desc" | "cost_asc" | "cost_desc" | "strength_asc" | "strength_desc";
type CatalogSearchTarget = "entities" | "media";
type PreviewAngle = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

type CatalogSearchSuggestion = {
  key: string;
  target: CatalogSearchTarget;
  title: string;
  subtitle: string;
  meta: string;
  score: number;
  entity?: EntitySummary;
  media?: MediaItem;
};

type CatalogRecentItem = Omit<CatalogSearchSuggestion, "score"> & { sourceId: string };

type CatalogListFocus = {
  sequence: number;
  target: CatalogSearchTarget;
  itemId: string;
  media?: MediaItem;
};

const DEFAULT_PREVIEW_ANGLE: PreviewAngle = 1;
const entitySortValues: EntitySort[] = ["cameo", "faction", "name_asc", "name_desc", "cost_asc", "cost_desc", "strength_asc", "strength_desc"];

function staticBuildInfo(currentVersion: string) {
  const tag = import.meta.env.VITE_RA2EXP_BUILD_TAG?.trim();
  const commit = import.meta.env.VITE_RA2EXP_BUILD_COMMIT?.trim();
  const timestamp = import.meta.env.VITE_RA2EXP_BUILD_TIME?.trim();
  const stableTag = import.meta.env.VITE_RA2EXP_STABLE_TAG?.trim();
  const ahead = Number.parseInt(import.meta.env.VITE_RA2EXP_STABLE_AHEAD || "", 10);
  const behind = Number.parseInt(import.meta.env.VITE_RA2EXP_STABLE_BEHIND || "", 10);
  const repositoryUrl = import.meta.env.VITE_RA2EXP_REPOSITORY_URL?.trim().replace(/\/$/, "");
  const revision = tag
    ? `稳定版 ${tag}`
    : commit
      ? `预览版 ${commit.slice(0, 8)}`
      : `本地版 v${currentVersion || "—"}`;
  const commitUrl = commit && repositoryUrl ? `${repositoryUrl}/commit/${commit}` : "";
  const revisionUrl = tag && repositoryUrl
    ? `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`
    : commitUrl;
  const revisionTitle = tag || commit || revision;
  const stableDistance = stableTag && Number.isFinite(ahead) && Number.isFinite(behind)
    ? ahead === 0 && behind === 0
      ? `与最新稳定版 ${stableTag} 一致`
      : ahead > 0 && behind === 0
        ? `比最新稳定版 ${stableTag} 提前 ${ahead} 个提交`
        : behind > 0 && ahead === 0
          ? `比最新稳定版 ${stableTag} 落后 ${behind} 个提交`
          : `与最新稳定版 ${stableTag} 分叉：提前 ${ahead}、落后 ${behind} 个提交`
    : "";
  let updated = "";
  if (timestamp) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      updated = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: false,
      }).format(date);
    }
  }
  return { revision, revisionUrl, revisionTitle, stableDistance, updated };
}
const previewAngleOptions: Array<{ value: PreviewAngle; label: string }> = [
  { value: 0, label: "正面" },
  { value: 1, label: "右前侧（推荐）" },
  { value: 2, label: "右侧" },
  { value: 3, label: "右后侧" },
  { value: 4, label: "背面" },
  { value: 5, label: "左后侧" },
  { value: 6, label: "左侧" },
  { value: 7, label: "左前侧" },
];

function normalizePreviewAngle(value: number): PreviewAngle {
  const normalized = ((Math.round(value) % 8) + 8) % 8;
  return normalized as PreviewAngle;
}

function shpFacingForPreviewAngle(angle: PreviewAngle) {
  return (4 + angle) % 8;
}

function vxlFacingForPreviewAngle(angle: PreviewAngle) {
  return (1 - angle + 8) % 8;
}

function entityFacingForPreviewAngle(facingFormat: string | null, angle: PreviewAngle) {
  return facingFormat === "vxl"
    ? vxlFacingForPreviewAngle(angle)
    : shpFacingForPreviewAngle(angle);
}

type BrowsingLocation = {
  view: "assets" | "entities";
  sourceId: string;
  assetCategory: string;
  assetFormatTag: string;
  mediaGroup: string;
  mediaEventType: string;
  entityKind: EntityKind;
  entityUsage: EntityUsage | "";
  entitySide: string;
  searchQuery: string;
  searchTargets: CatalogSearchTarget[];
  selectedAssetId: string;
  selectedEntityId: string;
  assetQuery: string;
  entityQuery: string;
  assetSort: AssetSort;
  entitySort: EntitySort;
  entityBuildableFirst: boolean;
  mediaSort: MediaSort;
};

const audioFormats = ["bag_audio", "wav", "aud"];
const imageFormats = ["shp", "tmp", "pcx", "pal", "map"];
const defaultVisibleFormats = ["bag_audio", "wav", "aud"];

function preloadEntityAudioResources(entity: GameEntity) {
  const primaryUrls: string[] = [];
  const remainingUrls: string[] = [];
  const seen = new Set<string>();
  for (const association of entity.media) {
    if (association.kind !== "voice" && association.kind !== "sound") continue;
    let foundPrimary = false;
    for (const sample of association.samples) {
      if (!sample.asset || !audioFormats.includes(sample.asset.format)) continue;
      const url = api.mediaUrl(sample.asset.id);
      if (seen.has(url)) continue;
      seen.add(url);
      if (!foundPrimary) {
        primaryUrls.push(url);
        foundPrimary = true;
      } else {
        remainingUrls.push(url);
      }
    }
  }
  for (const url of primaryUrls.slice(0, 8)) {
    void preloadAudioResource(url, "foreground");
  }
  preloadAudioResourceGroup([...primaryUrls.slice(8), ...remainingUrls]);
}
const assetCategories: Array<{
  id: string;
  label: string;
  formats: string[];
  icon: IconName;
}> = [
  { id: "voices", label: "游戏语音", formats: ["bag_audio", "wav", "aud"], icon: "play" },
  { id: "sounds", label: "游戏音效", formats: ["bag_audio", "wav", "aud"], icon: "play" },
  { id: "maps", label: "地图", formats: ["map"], icon: "grid" },
  { id: "images", label: "图像", formats: ["pcx"], icon: "image" },
  { id: "terrain", label: "地形素材", formats: ["tmp"], icon: "image" },
  { id: "rules", label: "规则文本", formats: ["ini", "csf", "text"], icon: "file" },
];

const entityKindOrder: EntityKind[] = ["vehicle", "aircraft", "infantry", "building"];
const entityKindIcons: Record<EntityKind, IconName> = {
  vehicle: "unit",
  aircraft: "aircraft",
  infantry: "infantry",
  building: "building",
};

const entityUsageOrder: EntityUsage[] = ["buildable", "hero", "tech", "civilian", "scenario"];
const entityUsageLabels: Record<EntityKind, Partial<Record<EntityUsage, string>>> = {
  vehicle: { buildable: "可建造", scenario: "任务 / 衍生" },
  aircraft: { buildable: "可建造", scenario: "任务 / 衍生" },
  infantry: { buildable: "常规部队", hero: "英雄单位", civilian: "平民 / 生物", scenario: "任务 / 特殊" },
  building: { buildable: "玩家可建造", tech: "中立科技", civilian: "场景建筑", scenario: "任务 / 特殊" },
};
function rememberedSearchTargets(value: unknown): CatalogSearchTarget[] {
  const order: CatalogSearchTarget[] = ["entities", "media"];
  if (!Array.isArray(value)) return order;
  const selected = order.filter((target) => value.includes(target));
  return selected.length > 0 ? selected : order;
}

function entityUsageLabel(kind: EntityKind, usage: EntityUsage) {
  return entityUsageLabels[kind][usage] || usage;
}

function orderedSideFacets(facets: Array<{ id: string; count: number }>, selected: string) {
  const result = [...facets];
  if (selected && !result.some((side) => side.id === selected)) {
    result.push({ id: selected, count: 0 });
  }
  return result.sort((left, right) => {
    const known = Object.keys(sideLabels);
    const leftIndex = known.indexOf(left.id);
    const rightIndex = known.indexOf(right.id);
    return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex)
      || left.id.localeCompare(right.id);
  });
}

function entityBodyStatusLabel(entity: EntitySummary) {
  return entity.body_status === "not_defined" ? "规则对象无独立图像" : "游戏文件未提供主体";
}

function readBrowsingLocation(): Partial<BrowsingLocation> {
  try {
    const stored = JSON.parse(window.localStorage.getItem("ra2exp-browsing-location-v1") || "null");
    return stored && typeof stored === "object" ? stored as Partial<BrowsingLocation> : {};
  } catch {
    return {};
  }
}

const ENTITY_SELECTIONS_STORAGE_KEY = "ra2exp-entity-selections-v2";
const ASSET_SELECTIONS_STORAGE_KEY = "ra2exp-asset-selections-v2";
const SEARCH_HISTORY_STORAGE_KEY = "ra2exp-search-history-v1";
const SEARCH_RECENTS_STORAGE_KEY = "ra2exp-search-recents-v1";
const MAX_STORED_SELECTIONS = 256;
const MAX_SEARCH_HISTORY = 12;
const MAX_SEARCH_RECENTS = 10;

function writeStoredList(storageKey: string, values: unknown[]) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(values));
  } catch {
    // Browsing remains available when storage is disabled or full.
  }
}

function readStoredSearchHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

function readStoredSearchRecents() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SEARCH_RECENTS_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((value): value is CatalogRecentItem => {
      if (!value || typeof value !== "object") return false;
      const item = value as Partial<CatalogRecentItem>;
      if (
        typeof item.key !== "string"
        || typeof item.sourceId !== "string"
        || (item.target !== "entities" && item.target !== "media")
        || typeof item.title !== "string"
        || typeof item.subtitle !== "string"
        || typeof item.meta !== "string"
      ) return false;
      return item.target === "entities" ? Boolean(item.entity?.id) : Boolean(item.media?.asset.id);
    }).slice(0, MAX_SEARCH_RECENTS);
  } catch {
    return [];
  }
}

function entitySelectionKey(sourceId: string, kind: EntityKind, usage: EntityUsage | "" = "") {
  return `${sourceId}:${kind}:${usage || "all"}`;
}

function assetSelectionKey(sourceId: string, category: string, group = "") {
  return `${sourceId}:${category}:${group || "all"}`;
}

function initialSelectionMap(storageKey: string, fallbacks: Array<[string, string]>) {
  const selections = new Map<string, string>();
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored).slice(-MAX_STORED_SELECTIONS)) {
        if (typeof value === "string" && value) selections.set(key, value);
      }
    }
  } catch {
    // Ignore malformed browsing preferences.
  }
  for (const [key, value] of fallbacks) {
    if (key && value && !selections.has(key)) selections.set(key, value);
  }
  return selections;
}

function rememberSelection(
  selections: Map<string, string>,
  storageKey: string,
  key: string,
  value: string,
) {
  if (!key || !value) return;
  selections.delete(key);
  selections.set(key, value);
  while (selections.size > MAX_STORED_SELECTIONS) {
    const oldest = selections.keys().next().value as string | undefined;
    if (!oldest) break;
    selections.delete(oldest);
  }
  window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(selections)));
}

function readStoredNumber(key: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(window.localStorage.getItem(key) || "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const AUDIO_DETAIL_BOTTOM_SIZE_KEY = "ra2exp-detail-bottom-audio-size-v2";
const LEGACY_AUDIO_DETAIL_BOTTOM_SIZE_KEY = "ra2exp-detail-bottom-audio-size";
const LEGACY_AUDIO_DETAIL_BOTTOM_DEFAULT = 270;

function defaultAudioDetailBottomSize() {
  const preferred = Math.max(320, Math.round(window.innerHeight * 0.36));
  return Math.min(600, Math.max(180, Math.min(window.innerHeight - 246, preferred)));
}

function readStoredAudioDetailBottomSize() {
  const fallback = defaultAudioDetailBottomSize();
  const current = window.localStorage.getItem(AUDIO_DETAIL_BOTTOM_SIZE_KEY);
  if (current !== null) {
    return readStoredNumber(AUDIO_DETAIL_BOTTOM_SIZE_KEY, fallback, 180, 600);
  }
  const legacy = Number.parseInt(
    window.localStorage.getItem(LEGACY_AUDIO_DETAIL_BOTTOM_SIZE_KEY) || "",
    10,
  );
  if (Number.isFinite(legacy) && legacy !== LEGACY_AUDIO_DETAIL_BOTTOM_DEFAULT) {
    return Math.min(600, Math.max(180, legacy));
  }
  return fallback;
}

function audioDisplayName(value: string) {
  return value.replace(/\.(?:wav|aud)$/i, "");
}

function assetDisplayName(asset: Pick<Asset, "display_name" | "format">) {
  return audioFormats.includes(asset.format) ? audioDisplayName(asset.display_name) : asset.display_name;
}

function includeFocusedMedia(
  items: MediaItem[],
  focus: CatalogListFocus | null,
  kind: MediaKind,
  sort: MediaSort,
  voiceTextPreference: VoiceTextPreference,
) {
  const target = focus?.target === "media" ? focus.media : undefined;
  if (
    !target
    || (target.kind !== kind && !(target.kind === "unknown" && kind === "sound"))
    || items.some((item) => item.asset.id === target.asset.id)
  ) return items;
  const next = [...items, target];
  next.sort((left, right) => {
    const leftValue = sort === "description_asc"
      ? mediaPrimaryText(left, voiceTextPreference) : assetDisplayName(left.asset);
    const rightValue = sort === "description_asc"
      ? mediaPrimaryText(right, voiceTextPreference) : assetDisplayName(right.asset);
    const compared = leftValue.localeCompare(rightValue, "zh-CN", { numeric: true });
    return sort === "name_desc" ? -compared : compared;
  });
  return next;
}

function libraryDisplayName(value: string) {
  return /^ra2md(?:-官方安装)?$/i.test(value.trim())
    ? "红色警戒 2 与尤里的复仇"
    : value;
}

function sourceDisplayName(source: Source) {
  return libraryDisplayName(source.name);
}

function ruleColumnSpan(label: string, value: string) {
  const width = [...`${label}${value}`].reduce(
    (total, character) => total + (character.charCodeAt(0) > 255 ? 2 : 1),
    0,
  );
  return width > 72 ? 3 : width > 34 ? 2 : 1;
}

const appliedRememberedScrollResets = new Map<string, number>();

function useRememberedScroll<
  T extends HTMLElement = HTMLDivElement,
  A extends HTMLElement = T,
>(
  key: string,
  itemCount: number,
  resetRevision = 0,
) {
  const ref = useRef<T | null>(null);
  const alternateRef = useRef<A | null>(null);
  const activeKey = useRef("");
  const activeResetRevision = useRef(resetRevision);
  const target = useRef(0);
  const restoring = useRef(false);
  const ready = useRef(false);

  if (activeKey.current !== key || activeResetRevision.current !== resetRevision) {
    const reset = Boolean(key)
      && resetRevision > (appliedRememberedScrollResets.get(key) || 0);
    if (reset) appliedRememberedScrollResets.set(key, resetRevision);
    activeKey.current = key;
    activeResetRevision.current = resetRevision;
    target.current = key && !reset
      ? Math.max(0, Number.parseInt(window.localStorage.getItem(`ra2exp-scroll:${key}`) || "0", 10) || 0)
      : 0;
    restoring.current = target.current > 0;
    ready.current = false;
  }

  useLayoutEffect(() => {
    const elements = [ref.current, alternateRef.current].filter(
      (element): element is T | A => element !== null,
    );
    if (!key || elements.length === 0) return;
    ready.current = false;
    for (const element of elements) element.scrollTop = target.current;
    const frame = window.requestAnimationFrame(() => {
      if (activeKey.current !== key) return;
      for (const element of elements) element.scrollTop = target.current;
      restoring.current = elements.some(
        (element) => element.scrollHeight > element.clientHeight
          && Math.abs(element.scrollTop - target.current) >= 2,
      );
      ready.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [key, itemCount, resetRevision]);

  function remember<E extends HTMLElement>(event: ReactUIEvent<E>) {
    if (!key || !ready.current) return;
    const top = event.currentTarget.scrollTop;
    if (restoring.current && Math.abs(top - target.current) >= 2) return;
    restoring.current = false;
    target.current = top;
    window.localStorage.setItem(`ra2exp-scroll:${key}`, String(Math.round(top)));
  }

  return { ref, alternateRef, remember };
}

function useResponsiveDetailPageReset(
  key: string,
  panelRef: { current: HTMLElement | null },
) {
  const previousKey = useRef(key);
  useLayoutEffect(() => {
    const changed = Boolean(previousKey.current) && previousKey.current !== key;
    previousKey.current = key;
    const panel = panelRef.current;
    const scrollingElement = document.scrollingElement;
    if (!changed || !panel || !scrollingElement) return;
    const pageScrollable = scrollingElement.scrollHeight > window.innerHeight + 2;
    const panelScrollable = panel.scrollHeight > panel.clientHeight + 2;
    const panelTop = window.scrollY + panel.getBoundingClientRect().top;
    if (pageScrollable && !panelScrollable && window.scrollY > panelTop + 2) {
      window.scrollTo({ top: panelTop, behavior: "auto" });
    }
  }, [key, panelRef]);
}

function sortEntities(
  entities: EntitySummary[],
  sort: EntitySort,
  language: GameLanguage,
  buildableFirst: boolean,
  selectedSide: string,
) {
  const selected = [...entities];
  const numeric = (value: string | null) => {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const compareNames = (left: EntitySummary, right: EntitySummary) => left.display_name.localeCompare(
    right.display_name,
    language,
    { numeric: true },
  ) || left.id.localeCompare(right.id, undefined, { numeric: true });
  const compareNumbers = (left: string | null, right: string | null, ascending: boolean) => {
    const leftValue = numeric(left);
    const rightValue = numeric(right);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return ascending ? leftValue - rightValue : rightValue - leftValue;
  };
  const knownSides = primarySideOrder;
  const planningSide = (entity: EntitySummary) => {
    const configured = numeric(entity.ai_base_planning_side ?? null);
    if (configured !== null && configured >= 0 && configured < knownSides.length) return configured;
    const affiliatedSide = entity.affiliation?.kind === "side"
      ? entity.affiliation.id
      : entity.affiliation?.kind === "country" && entity.sides.length === 1
        ? entity.sides[0]
        : "";
    const index = knownSides.indexOf(affiliatedSide);
    return index >= 0 ? index : null;
  };
  const compareFactions = (left: EntitySummary, right: EntitySummary) => {
    const leftSide = planningSide(left);
    const rightSide = planningSide(right);
    if (leftSide !== null || rightSide !== null) {
      if (leftSide === null) return 1;
      if (rightSide === null) return -1;
      if (leftSide !== rightSide) return leftSide - rightSide;
    }
    const leftLabel = left.affiliation?.display_name || sideLabels.unaffiliated;
    const rightLabel = right.affiliation?.display_name || sideLabels.unaffiliated;
    return leftLabel.localeCompare(rightLabel, language, { numeric: true });
  };
  const compareCameos = (left: EntitySummary, right: EntitySummary) => {
    const selectedPlanningSide = knownSides.indexOf(selectedSide);
    if (selectedPlanningSide >= 0) {
      const leftMatches = planningSide(left) === selectedPlanningSide ? 0 : 1;
      const rightMatches = planningSide(right) === selectedPlanningSide ? 0 : 1;
      if (leftMatches !== rightMatches) return leftMatches - rightMatches;
    } else {
      const faction = compareFactions(left, right);
      if (faction) return faction;
    }
    if (["vehicle", "aircraft"].includes(left.kind) && ["vehicle", "aircraft"].includes(right.kind)) {
      const naval = Number(Boolean(left.naval)) - Number(Boolean(right.naval));
      if (naval) return naval;
      const aircraft = Number(Boolean(left.considered_aircraft)) - Number(Boolean(right.considered_aircraft));
      if (aircraft) return aircraft;
    }
    const leftTechLevel = numeric(left.tech_level ?? null);
    const rightTechLevel = numeric(right.tech_level ?? null);
    return compareNumbers(
      leftTechLevel !== null && leftTechLevel >= 0 ? String(leftTechLevel) : null,
      rightTechLevel !== null && rightTechLevel >= 0 ? String(rightTechLevel) : null,
      true,
    )
      || compareNumbers(left.cost, right.cost, true)
      || compareNames(left, right);
  };
  selected.sort((left, right) => {
    if (buildableFirst) {
      const leftBuildable = left.usage === "buildable" || left.usage === "hero" ? 0 : 1;
      const rightBuildable = right.usage === "buildable" || right.usage === "hero" ? 0 : 1;
      if (leftBuildable !== rightBuildable) return leftBuildable - rightBuildable;
    }
    if (sort === "cameo") return compareCameos(left, right);
    if (sort === "faction") return compareFactions(left, right) || compareCameos(left, right);
    if (sort.startsWith("cost_")) return compareNumbers(left.cost, right.cost, sort === "cost_asc") || compareNames(left, right);
    if (sort.startsWith("strength_")) return compareNumbers(left.strength, right.strength, sort === "strength_asc") || compareNames(left, right);
    const compared = compareNames(left, right);
    return sort === "name_desc" ? -compared : compared;
  });
  return selected;
}

function initialVisibleFormats() {
  if (isStaticSnapshot) return defaultVisibleFormats;
  try {
    const stored = JSON.parse(window.localStorage.getItem("ra2exp-visible-formats-v2") || "null");
    if (Array.isArray(stored) && stored.every((item) => typeof item === "string")) return stored as string[];
  } catch {
    // Ignore invalid local preferences and use the product defaults.
  }
  return defaultVisibleFormats;
}

function storedGameLanguage(): GameLanguage {
  return window.localStorage.getItem("ra2exp-game-language-v1") === "zh-TW"
    ? "zh-TW"
    : "zh-CN";
}

function storedVoiceTextPreference(): VoiceTextPreference {
  return window.localStorage.getItem("ra2exp-voice-text-preference-v1") === "game"
    ? "game"
    : "translation";
}

function storedPreviewAngle(): PreviewAngle {
  const value = window.localStorage.getItem("ra2exp-preview-angle-v1");
  if (value === null) return DEFAULT_PREVIEW_ANGLE;
  const stored = Number(value);
  return Number.isInteger(stored) && stored >= 0 && stored <= 7
    ? normalizePreviewAngle(stored)
    : DEFAULT_PREVIEW_ANGLE;
}

function storedAutomaticUpdateCheck() {
  return window.localStorage.getItem("ra2exp-auto-update-check-v1") === "true";
}

function storedMediaHeaderAlignment(): MediaHeaderAlignment {
  return window.localStorage.getItem("ra2exp-media-header-alignment-v1") === "center"
    ? "center"
    : "left";
}

function categoryCount(stats: Stats, formats: string[]) {
  const selected = new Set(formats);
  return stats.formats.reduce(
    (total, item) => total + (selected.has(item.format) ? item.count : 0),
    0,
  );
}

function ExplorerApp() {
  const [rememberedLocation] = useState(readBrowsingLocation);
  const rememberedSearchQuery = rememberedLocation.searchQuery
    || rememberedLocation.entityQuery
    || (["voices", "sounds"].includes(rememberedLocation.assetCategory || "")
      ? rememberedLocation.assetQuery || ""
      : "");
  const entitySelectionsRef = useRef(initialSelectionMap(
    ENTITY_SELECTIONS_STORAGE_KEY,
    rememberedLocation.sourceId && rememberedLocation.entityKind && rememberedLocation.selectedEntityId
      ? [
        [entitySelectionKey(rememberedLocation.sourceId, rememberedLocation.entityKind), rememberedLocation.selectedEntityId],
        [entitySelectionKey(rememberedLocation.sourceId, rememberedLocation.entityKind, rememberedLocation.entityUsage || ""), rememberedLocation.selectedEntityId],
      ]
      : [],
  ));
  const assetSelectionsRef = useRef(initialSelectionMap(
    ASSET_SELECTIONS_STORAGE_KEY,
    rememberedLocation.sourceId && rememberedLocation.assetCategory && rememberedLocation.selectedAssetId
      ? [
        [assetSelectionKey(rememberedLocation.sourceId, rememberedLocation.assetCategory), rememberedLocation.selectedAssetId],
        [assetSelectionKey(rememberedLocation.sourceId, rememberedLocation.assetCategory, rememberedLocation.mediaGroup || ""), rememberedLocation.selectedAssetId],
      ]
      : [],
  ));
  const [view, setView] = useState<"assets" | "entities">(
    rememberedLocation.view === "assets" ? "assets" : "entities",
  );
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetPageLoading, setAssetPageLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats>({ total_assets: 0, formats: [] });
  const [palettes, setPalettes] = useState<Asset[]>([]);
  const [playerColors, setPlayerColors] = useState<PlayerColor[]>([]);
  const [assetQuery, setAssetQuery] = useState(rememberedLocation.assetQuery || "");
  const [assetCategory, setAssetCategory] = useState(
    rememberedLocation.assetCategory && rememberedLocation.assetCategory !== "animations"
      ? rememberedLocation.assetCategory
      : "voices",
  );
  const [assetFormatTag, setAssetFormatTag] = useState(rememberedLocation.assetFormatTag || "");
  const [assetSort, setAssetSort] = useState<AssetSort>(rememberedLocation.assetSort || "name_asc");
  const [enabledFormats, setEnabledFormats] = useState<string[]>(initialVisibleFormats);
  const [layout, setLayout] = useState<LayoutMode>(() =>
    window.localStorage.getItem("ra2exp-layout") === "list" ? "list" : "grid",
  );
  const [listScrollResetRevision, setListScrollResetRevision] = useState(0);
  const [detailPlacement, setDetailPlacement] = useState<DetailPlacement>(() =>
    window.localStorage.getItem("ra2exp-detail-placement") === "right" ? "right" : "bottom",
  );
  const [gameLanguage, setGameLanguage] = useState<GameLanguage>(storedGameLanguage);
  const [voiceTextPreference, setVoiceTextPreference] = useState<VoiceTextPreference>(
    storedVoiceTextPreference,
  );
  const [previewAngle, setPreviewAngle] = useState<PreviewAngle>(storedPreviewAngle);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [entityTotal, setEntityTotal] = useState(0);
  const [entityKinds, setEntityKinds] = useState<Array<{ kind: EntityKind; count: number }>>([]);
  const [entityUsages, setEntityUsages] = useState<Array<{ usage: EntityUsage; count: number }>>([]);
  const [entitySides, setEntitySides] = useState<Array<{ id: string; count: number }>>([]);
  const [entityKind, setEntityKind] = useState<EntityKind | "">(
    entityKindOrder.includes(rememberedLocation.entityKind as EntityKind)
      ? rememberedLocation.entityKind as EntityKind
      : "vehicle",
  );
  const [searchQuery, setSearchQuery] = useState(rememberedSearchQuery);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [searchTargets, setSearchTargets] = useState<CatalogSearchTarget[]>(
    () => rememberedSearchTargets(rememberedLocation.searchTargets),
  );
  const [searchHistory, setSearchHistory] = useState(readStoredSearchHistory);
  const [searchRecents, setSearchRecents] = useState(readStoredSearchRecents);
  const catalogListFocusRef = useRef<CatalogListFocus | null>(null);
  const catalogListFocusSequence = useRef(0);
  const [catalogListFocus, setCatalogListFocus] = useState<CatalogListFocus | null>(null);
  const [entityUsage, setEntityUsage] = useState<EntityUsage | "">(
    entityUsageOrder.includes(rememberedLocation.entityUsage as EntityUsage)
      ? rememberedLocation.entityUsage as EntityUsage
      : "",
  );
  const [entitySide, setEntitySide] = useState(rememberedLocation.entitySide || "");
  const [entitySort, setEntitySort] = useState<EntitySort>(() => {
    const stored = window.localStorage.getItem("ra2exp-entity-sort-v2") as EntitySort | null;
    return stored && entitySortValues.includes(stored) ? stored : "cameo";
  });
  const [entityBuildableFirst, setEntityBuildableFirst] = useState(
    () => window.localStorage.getItem("ra2exp-entity-buildable-first-v2") !== "false",
  );
  const [selectedEntityId, setSelectedEntityId] = useState(rememberedLocation.selectedEntityId || "");
  const [selectedEntity, setSelectedEntity] = useState<GameEntity | null>(null);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityDetailLoading, setEntityDetailLoading] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaTotal, setMediaTotal] = useState(0);
  const mediaLoadedCountRef = useRef(0);
  const [mediaGroups, setMediaGroups] = useState<Array<{ group: string; count: number }>>([]);
  const [mediaEventTypes, setMediaEventTypes] = useState<Array<{ event_type: string; count: number }>>([]);
  const [mediaCountries, setMediaCountries] = useState<CountryFacet[]>([]);
  const [mediaKindCounts, setMediaKindCounts] = useState<Array<{ kind: MediaKind; count: number }>>([]);
  const [searchEntityItems, setSearchEntityItems] = useState<EntitySummary[]>([]);
  const [searchEntityTotal, setSearchEntityTotal] = useState(0);
  const [searchMediaItems, setSearchMediaItems] = useState<MediaItem[]>([]);
  const [searchMediaTotal, setSearchMediaTotal] = useState(0);
  const [searchSuggestionLoading, setSearchSuggestionLoading] = useState(false);
  const [mediaGroup, setMediaGroup] = useState(rememberedLocation.mediaGroup || "");
  const [mediaEventType, setMediaEventType] = useState(rememberedLocation.mediaEventType || "");
  const [mediaGrouped, setMediaGrouped] = useState(
    () => window.localStorage.getItem("ra2exp-media-grouped-v1") !== "false",
  );
  const [mediaHeaderAlignment, setMediaHeaderAlignment] = useState<MediaHeaderAlignment>(
    storedMediaHeaderAlignment,
  );
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaSort, setMediaSort] = useState<MediaSort>(rememberedLocation.mediaSort || "name_asc");
  const [playingMediaId, setPlayingMediaId] = useState("");
  const [selectedId, setSelectedId] = useState(rememberedLocation.selectedAssetId || "");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [metadata, setMetadata] = useState<AssetMetadata | null>(null);
  const [associations, setAssociations] = useState<AssetAssociationPage | null>(null);
  const [textAsset, setTextAsset] = useState<TextAsset | null>(null);
  const [textQuery, setTextQuery] = useState("");
  const [frame, setFrame] = useState(0);
  const [paletteId, setPaletteId] = useState("");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resourcePacks, setResourcePacks] = useState<ResourcePack[]>([]);
  const [currentVersion, setCurrentVersion] = useState("");
  const [hosted, setHosted] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [automaticUpdateCheck, setAutomaticUpdateCheck] = useState(
    storedAutomaticUpdateCheck,
  );
  const updateRequestRef = useRef(false);
  const sidebarCollapsedRef = useRef(
    window.localStorage.getItem("ra2exp-sidebar-collapsed") === "true",
  );
  const workspaceRef = useRef<HTMLElement>(null);
  const [detailBottomSize, setDetailBottomSize] = useState(
    () => readStoredNumber("ra2exp-detail-bottom-size", Math.round(window.innerHeight * 0.42), 220, 900),
  );
  const [audioDetailBottomSize, setAudioDetailBottomSize] = useState(
    readStoredAudioDetailBottomSize,
  );
  const [detailRightSize, setDetailRightSize] = useState(
    () => readStoredNumber("ra2exp-detail-right-size", 430, 320, 900),
  );
  const [discovery, setDiscovery] = useState<DiscoveryResult>({ candidates: [], checked_locations: [], official_sources: [] });
  const [discoveryLoaded, setDiscoveryLoaded] = useState(false);

  const activeSource = sources.find((item) => item.id === sourceId) ?? null;
  const sourceRevision = activeSource?.scanned_at || "";
  const availableFormatNames = new Set(
    stats.formats.filter((item) => item.count > 0).map((item) => item.format),
  );
  const visibleCategories = assetCategories.filter((item) =>
    item.formats.some((formatName) => (
      enabledFormats.includes(formatName) && availableFormatNames.has(formatName)
    )),
  );
  const selectedCategory = visibleCategories.find((item) => item.id === assetCategory)
    || visibleCategories[0]
    || null;
  const selectedCategoryId = selectedCategory?.id || "";
  const isMediaCategory = selectedCategoryId === "voices" || selectedCategoryId === "sounds";
  const mediaKind: MediaKind = selectedCategoryId === "voices" ? "voice" : "sound";
  const categoryFormats = (selectedCategory?.formats || [])
    .filter((formatName) => enabledFormats.includes(formatName));
  const assetFormats = assetFormatTag && categoryFormats.includes(assetFormatTag)
    ? [assetFormatTag]
    : categoryFormats;
  const assetFormatKey = assetFormats.join(",");
  const entitySideFacets = useMemo(
    () => orderedSideFacets(entitySides, entitySide),
    [entitySides, entitySide],
  );
  const visibleEntities = useMemo(
    () => sortEntities(
      entities,
      entitySort,
      gameLanguage,
      entityBuildableFirst,
      entitySide,
    ),
    [entities, entitySort, gameLanguage, entityBuildableFirst, entitySide],
  );
  const catalogSearchSuggestions = useMemo<CatalogSearchSuggestion[]>(() => {
    const compareSuggestions = (left: CatalogSearchSuggestion, right: CatalogSearchSuggestion) => {
      const leftScore = Number.isFinite(left.score) ? left.score : 100;
      const rightScore = Number.isFinite(right.score) ? right.score : 100;
      return leftScore - rightScore || left.title.localeCompare(right.title, gameLanguage, { numeric: true });
    };
    const entitySuggestions: CatalogSearchSuggestion[] = searchEntityItems.map((entity) => ({
      key: `entity:${entity.id}`,
      target: "entities" as const,
      title: entity.display_name,
      subtitle: `${entity.internal_name} · ${entityKindLabels[entity.kind]}`,
      meta: entity.search_aliases
        ? `${entity.search_aliases.pinyin} · ${entity.search_aliases.pinyin_initials}`
        : entity.id,
      score: entitySuggestionScore(entity, searchQuery)
        - (view === "entities" ? 0.6 : 0)
        - (view === "entities" && entity.kind === entityKind ? 0.25 : 0),
      entity,
    })).sort(compareSuggestions);
    const mediaSuggestions: CatalogSearchSuggestion[] = searchMediaItems.map((media) => ({
      key: `media:${media.asset.id}`,
      target: "media" as const,
      title: mediaPrimaryText(media, voiceTextPreference),
      subtitle: `${assetDisplayName(media.asset)} · ${media.kind === "voice" ? "语音" : "音效"}`,
      meta: media.slots.slice(0, 2).map(mediaSlotLabel).join(" · ") || mediaGroupLabels[media.groups[0]] || "声音",
      score: mediaSuggestionScore(media, searchQuery)
        - (view === "assets" && isMediaCategory ? 0.6 : 0)
        - (view === "assets" && isMediaCategory && media.kind === mediaKind ? 0.25 : 0)
        - (view === "assets" && mediaGroup && media.groups.includes(mediaGroup) ? 0.1 : 0),
      media,
    })).sort(compareSuggestions);
    const queues = view === "entities"
      ? [entitySuggestions, mediaSuggestions]
      : [mediaSuggestions, entitySuggestions];
    const result: CatalogSearchSuggestion[] = [];
    let index = 0;
    while (result.length < 10 && queues.some((queue) => index < queue.length)) {
      for (const queue of queues) {
        if (queue[index] && result.length < 10) result.push(queue[index]);
      }
      index += 1;
    }
    return result;
  }, [
    searchEntityItems, searchMediaItems, searchQuery, gameLanguage, voiceTextPreference, view,
    entityKind, isMediaCategory, mediaKind, mediaGroup,
  ]);
  const compactAudioDetail = view === "assets" && isMediaCategory;
  const detailSize = detailPlacement === "bottom"
    ? compactAudioDetail ? audioDetailBottomSize : detailBottomSize
    : detailRightSize;
  const workspaceStyle = {
    "--sidebar-width": sidebarCollapsedRef.current ? "58px" : "224px",
    "--detail-panel-size": `${detailSize}px`,
  } as CSSProperties;
  const assetScrollKey = [sourceId, selectedCategoryId, assetFormatTag, mediaEventType, isMediaCategory ? "" : assetQuery, assetSort, layout]
    .map((value) => encodeURIComponent(value))
    .join(":");
  const assetListScroll = useRememberedScroll(
    `assets:${assetScrollKey}`,
    assets.length,
    listScrollResetRevision,
  );
  const libraryTreeScroll = useRememberedScroll(
    `library:${sourceId}:${gameLanguage}`,
    visibleCategories.length + entityKinds.length + mediaGroups.length,
  );

  function requestRememberedListScrollReset() {
    setListScrollResetRevision((current) => current + 1);
  }

  function updateLayout(next: LayoutMode) {
    setLayout(next);
    window.localStorage.setItem("ra2exp-layout", next);
  }

  function updateDetailPlacement(next: DetailPlacement) {
    setDetailPlacement(next);
    window.localStorage.setItem("ra2exp-detail-placement", next);
  }

  function updateGameLanguage(next: GameLanguage) {
    setGameLanguage(next);
    window.localStorage.setItem("ra2exp-game-language-v1", next);
  }

  function updateVoiceTextPreference(next: VoiceTextPreference) {
    setVoiceTextPreference(next);
    window.localStorage.setItem("ra2exp-voice-text-preference-v1", next);
  }

  function updatePreviewAngle(next: PreviewAngle) {
    setPreviewAngle(next);
    window.localStorage.setItem("ra2exp-preview-angle-v1", String(next));
  }

  function updateMediaHeaderAlignment(next: MediaHeaderAlignment) {
    setMediaHeaderAlignment(next);
    window.localStorage.setItem("ra2exp-media-header-alignment-v1", next);
  }

  function updateEntitySort(next: EntitySort) {
    setEntitySort(next);
    window.localStorage.setItem("ra2exp-entity-sort-v2", next);
  }

  function updateEntityBuildableFirst(next: boolean) {
    setEntityBuildableFirst(next);
    window.localStorage.setItem("ra2exp-entity-buildable-first-v2", String(next));
  }

  function updateSidebarCollapsed(next: boolean) {
    const resumeCardPreviews = pauseCardPreviewBackground();
    sidebarCollapsedRef.current = next;
    window.localStorage.setItem("ra2exp-sidebar-collapsed", String(next));
    const workspace = workspaceRef.current;
    if (!workspace) {
      resumeCardPreviews();
      return;
    }
    workspace.classList.toggle("sidebar-collapsed", next);
    workspace.style.setProperty("--sidebar-width", next ? "58px" : "224px");
    window.requestAnimationFrame(() => window.requestAnimationFrame(resumeCardPreviews));
  }

  function clampDetailSize(value: number, placement: DetailPlacement, bounds: DOMRect, audioCompact = compactAudioDetail) {
    if (placement === "bottom") {
      const minimum = audioCompact ? 180 : 220;
      return Math.round(Math.min(Math.max(minimum, bounds.height - 246), Math.max(minimum, value)));
    }
    const sidebarWidth = sidebarCollapsedRef.current ? 58 : 224;
    return Math.round(Math.min(
      Math.max(320, bounds.width - sidebarWidth - 366),
      Math.max(320, value),
    ));
  }

  function setCurrentDetailSize(value: number, placement: DetailPlacement, persist = false, audioCompact = compactAudioDetail) {
    if (placement === "bottom" && audioCompact) setAudioDetailBottomSize(value);
    else if (placement === "bottom") setDetailBottomSize(value);
    else setDetailRightSize(value);
    if (persist) {
      const key = placement === "bottom" && audioCompact
        ? AUDIO_DETAIL_BOTTOM_SIZE_KEY
        : `ra2exp-detail-${placement}-size`;
      window.localStorage.setItem(key, String(value));
    }
  }

  function beginDetailResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const placement = detailPlacement;
    const audioCompact = compactAudioDetail;
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    let latest = detailSize;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = placement === "bottom" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => {
      const requested = placement === "bottom"
        ? bounds.bottom - moveEvent.clientY
        : bounds.right - moveEvent.clientX;
      latest = clampDetailSize(requested, placement, bounds, audioCompact);
      setCurrentDetailSize(latest, placement, false, audioCompact);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      setCurrentDetailSize(latest, placement, true, audioCompact);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function resizeDetailWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const grows = detailPlacement === "bottom" ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const shrinks = detailPlacement === "bottom" ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!grows && !shrinks) return;
    event.preventDefault();
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    const next = clampDetailSize(detailSize + (grows ? 20 : -20), detailPlacement, bounds, compactAudioDetail);
    setCurrentDetailSize(next, detailPlacement, true, compactAudioDetail);
  }

  function updateEnabledFormats(next: string[]) {
    const unique = [...new Set(next)];
    setEnabledFormats(unique);
    window.localStorage.setItem("ra2exp-visible-formats-v2", JSON.stringify(unique));
  }

  useEffect(() => {
    if (loading || !sourceId) return;
    const location: BrowsingLocation = {
      view,
      sourceId,
      assetCategory,
      assetFormatTag,
      mediaGroup,
      mediaEventType,
      entityKind: entityKind || "vehicle",
      entityUsage,
      entitySide,
      searchQuery,
      searchTargets,
      selectedAssetId: selectedId,
      selectedEntityId,
      assetQuery,
      entityQuery: searchQuery,
      assetSort,
      entitySort,
      entityBuildableFirst,
      mediaSort,
    };
    window.localStorage.setItem("ra2exp-browsing-location-v1", JSON.stringify(location));
  }, [
    loading, sourceId, view, assetCategory, assetFormatTag, mediaGroup, mediaEventType, entityKind, entityUsage,
    entitySide, searchQuery, searchTargets, selectedId, selectedEntityId, assetQuery, assetSort,
    entitySort, entityBuildableFirst, mediaSort,
  ]);

  function selectEntityKind(kind: EntityKind) {
    cancelCatalogListFocus();
    if (view !== "entities" || kind !== entityKind || entityUsage) {
      requestRememberedListScrollReset();
    }
    pauseAudioAsset();
    setSearchResultsOpen(false);
    if (kind !== entityKind) {
      setEntitySide("");
    }
    const queryChanges = kind !== entityKind || Boolean(entityUsage);
    setView("entities");
    setEntityKind(kind);
    setEntityUsage("");
    if (queryChanges) setEntityLoading(true);
    setSelectedEntityId(entitySelectionsRef.current.get(entitySelectionKey(sourceId, kind)) || "");
  }

  function selectEntityUsage(usage: EntityUsage | "") {
    cancelCatalogListFocus();
    requestRememberedListScrollReset();
    setSearchResultsOpen(false);
    const next = entityUsage === usage ? "" : usage;
    setEntityUsage(next);
    if (next !== entityUsage) setEntityLoading(true);
    setSelectedEntityId(entityKind
      ? entitySelectionsRef.current.get(entitySelectionKey(sourceId, entityKind, next)) || ""
      : "");
  }

  function selectAssetCategory(category: string) {
    cancelCatalogListFocus();
    if (view !== "assets" || category !== assetCategory || mediaGroup || mediaEventType) {
      requestRememberedListScrollReset();
    }
    pauseAudioAsset();
    setSearchResultsOpen(false);
    setView("assets");
    setAssetCategory(category);
    setAssetFormatTag("");
    setMediaGroup("");
    setMediaEventType("");
    if (["voices", "sounds"].includes(category)) setMediaLoading(true);
    else setAssetPageLoading(true);
    setMediaItems([]);
    setSelectedId(assetSelectionsRef.current.get(assetSelectionKey(sourceId, category)) || "");
    setPlayingMediaId("");
  }

  function selectMediaGroup(group: string) {
    cancelCatalogListFocus();
    const next = group;
    requestRememberedListScrollReset();
    pauseAudioAsset();
    setSearchResultsOpen(false);
    setMediaGroup(next);
    setMediaEventType("");
    setMediaLoading(true);
    setMediaItems([]);
    setSelectedId(assetSelectionsRef.current.get(assetSelectionKey(sourceId, selectedCategoryId, next)) || "");
    setPlayingMediaId("");
  }

  function rememberEntityCard(id: string, kind: EntityKind, usage: EntityUsage | "") {
    rememberSelection(
      entitySelectionsRef.current,
      ENTITY_SELECTIONS_STORAGE_KEY,
      entitySelectionKey(sourceId, kind, usage),
      id,
    );
    if (usage) {
      rememberSelection(
        entitySelectionsRef.current,
        ENTITY_SELECTIONS_STORAGE_KEY,
        entitySelectionKey(sourceId, kind),
        id,
      );
    }
  }

  function rememberAssetCard(id: string, category: string, group: string) {
    rememberSelection(
      assetSelectionsRef.current,
      ASSET_SELECTIONS_STORAGE_KEY,
      assetSelectionKey(sourceId, category, group),
      id,
    );
    if (group) {
      rememberSelection(
        assetSelectionsRef.current,
        ASSET_SELECTIONS_STORAGE_KEY,
        assetSelectionKey(sourceId, category),
        id,
      );
    }
  }

  function selectEntityCard(id: string) {
    cancelCatalogListFocus();
    const entity = visibleEntities.find((item) => item.id === id);
    if (entity) rememberEntityCard(id, entity.kind, entityUsage);
    setSelectedEntityId(id);
  }

  function selectAssetCard(id: string) {
    cancelCatalogListFocus();
    rememberAssetCard(id, selectedCategoryId, mediaGroup);
    setSelectedId(id);
  }

  function selectMediaCard(id: string) {
    selectAssetCard(id);
    toggleAudioAsset(id, api.mediaUrl(id));
  }

  function updateSearchTargets(next: CatalogSearchTarget[]) {
    if (next.length > 0) setSearchTargets(next);
  }

  function rememberSearchHistory(value: string) {
    const normalized = value.trim();
    if (!normalized) return;
    setSearchHistory((current) => {
      const next = [normalized, ...current.filter(
        (item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
      )].slice(0, MAX_SEARCH_HISTORY);
      writeStoredList(SEARCH_HISTORY_STORAGE_KEY, next);
      return next;
    });
  }

  function removeSearchHistory(value: string) {
    setSearchHistory((current) => {
      const next = current.filter((item) => item !== value);
      writeStoredList(SEARCH_HISTORY_STORAGE_KEY, next);
      return next;
    });
  }

  function clearSearchHistory() {
    setSearchHistory([]);
    writeStoredList(SEARCH_HISTORY_STORAGE_KEY, []);
  }

  function rememberSearchRecent(item: CatalogRecentItem) {
    setSearchRecents((current) => {
      const next = [item, ...current.filter((entry) => entry.key !== item.key)]
        .slice(0, MAX_SEARCH_RECENTS);
      writeStoredList(SEARCH_RECENTS_STORAGE_KEY, next);
      return next;
    });
  }

  function removeSearchRecent(key: string) {
    setSearchRecents((current) => {
      const next = current.filter((item) => item.key !== key);
      writeStoredList(SEARCH_RECENTS_STORAGE_KEY, next);
      return next;
    });
  }

  function clearSearchRecents() {
    setSearchRecents([]);
    writeStoredList(SEARCH_RECENTS_STORAGE_KEY, []);
  }

  function queueCatalogListFocus(suggestion: CatalogSearchSuggestion) {
    const itemId = suggestion.entity?.id || suggestion.media?.asset.id;
    if (!itemId) return;
    const focus: CatalogListFocus = {
      sequence: ++catalogListFocusSequence.current,
      target: suggestion.target,
      itemId,
      media: suggestion.media,
    };
    catalogListFocusRef.current = focus;
    setCatalogListFocus(focus);
  }

  const finishCatalogListFocus = useCallback((sequence: number) => {
    if (catalogListFocusRef.current?.sequence !== sequence) return;
    catalogListFocusRef.current = null;
    setCatalogListFocus((current) => current?.sequence === sequence ? null : current);
  }, []);

  function cancelCatalogListFocus() {
    catalogListFocusRef.current = null;
    setCatalogListFocus(null);
  }

  function updateCatalogSearchQuery(next: string) {
    setSearchQuery(next);
    if (!next.trim()) setSearchResultsOpen(false);
  }

  function submitCatalogSearch() {
    if (!searchQuery.trim()) return;
    rememberSearchHistory(searchQuery);
    setSearchResultsOpen(true);
  }

  function navigateCatalogSuggestion(suggestion: CatalogSearchSuggestion) {
    requestRememberedListScrollReset();
    queueCatalogListFocus(suggestion);
    if (suggestion.entity) {
      const entity = suggestion.entity;
      pauseAudioAsset();
      setSearchResultsOpen(false);
      setView("entities");
      setEntityKind(entity.kind);
      setEntityUsage("");
      setEntitySide("");
      if (entity.kind !== entityKind || entityUsage || entitySide) setEntityLoading(true);
      rememberEntityCard(entity.id, entity.kind, "");
      setSelectedEntityId(entity.id);
      return;
    }
    if (suggestion.media) {
      const media = suggestion.media;
      const category = media.kind === "voice" ? "voices" : "sounds";
      setSearchResultsOpen(false);
      setView("assets");
      setAssetCategory(category);
      setAssetFormatTag("");
      setMediaGroup("");
      setMediaEventType("");
      setMediaLoading(true);
      setMediaItems([]);
      rememberAssetCard(media.asset.id, category, "");
      setSelectedId(media.asset.id);
      toggleAudioAsset(media.asset.id, api.mediaUrl(media.asset.id));
    }
  }

  function selectCatalogSuggestion(suggestion: CatalogSearchSuggestion) {
    rememberSearchHistory(searchQuery);
    rememberSearchRecent({
      key: suggestion.key,
      sourceId,
      target: suggestion.target,
      title: suggestion.title,
      subtitle: suggestion.subtitle,
      meta: suggestion.meta,
      entity: suggestion.entity,
      media: suggestion.media,
    });
    navigateCatalogSuggestion(suggestion);
  }

  function selectCatalogRecent(item: CatalogRecentItem) {
    rememberSearchRecent(item);
    navigateCatalogSuggestion({
      key: item.key,
      target: item.target,
      title: item.title,
      subtitle: item.subtitle,
      meta: item.meta,
      score: 0,
      entity: item.entity,
      media: item.media,
    });
  }

  function updateAutomaticUpdateCheck(next: boolean) {
    setAutomaticUpdateCheck(next);
    window.localStorage.setItem("ra2exp-auto-update-check-v1", String(next));
    if (next && !updateInfo) void checkLatestUpdate();
  }

  async function refreshResourcePacks() {
    try {
      setResourcePacks(await api.resourcePacks());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取本机资源包");
    }
  }

  async function checkLatestUpdate() {
    if (updateRequestRef.current) return;
    updateRequestRef.current = true;
    setUpdateChecking(true);
    setUpdateError("");
    try {
      setUpdateInfo(await api.latestUpdate());
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : "检查更新失败");
    } finally {
      updateRequestRef.current = false;
      setUpdateChecking(false);
    }
  }

  function openSettings() {
    setSettingsOpen(true);
    if (!hosted) void refreshResourcePacks();
    if (!hosted && !discoveryLoaded) {
      setDiscoveryLoaded(true);
      api.discovery()
        .then(setDiscovery)
        .catch(() => setDiscovery({ candidates: [], checked_locations: [], official_sources: [] }));
    }
    if (!isStaticSnapshot && automaticUpdateCheck && !updateInfo && !updateChecking) void checkLatestUpdate();
  }

  useEffect(() => {
    if (selectedCategoryId && selectedCategoryId !== assetCategory) {
      setAssetCategory(selectedCategoryId);
    }
  }, [assetCategory, selectedCategoryId]);

  useEffect(() => {
    if (assetFormatTag && !categoryFormats.includes(assetFormatTag)) setAssetFormatTag("");
  }, [assetFormatTag, categoryFormats]);

  useEffect(() => {
    if (view !== "entities" || entityLoading) return;
    if (visibleEntities.length === 0) {
      if (selectedEntityId) setSelectedEntityId("");
      return;
    }
    if (visibleEntities.some((entity) => entity.id === selectedEntityId)) return;
    const remembered = entityKind
      ? entitySelectionsRef.current.get(entitySelectionKey(sourceId, entityKind, entityUsage)) || ""
      : "";
    const next = visibleEntities.find((entity) => entity.id === remembered)?.id
      || visibleEntities[0].id;
    setSelectedEntityId(next);
    if (entityKind) rememberEntityCard(next, entityKind, entityUsage);
  }, [
    view, entityLoading, visibleEntities, selectedEntityId, sourceId, entityKind, entityUsage,
  ]);

  async function refreshSources(preferredId?: string) {
    const next = await api.sources();
    setSources(next);
    const candidate = preferredId || sourceId;
    setSourceId(next.some((item) => item.id === candidate) ? candidate : next[0]?.id || "");
  }

  useEffect(() => {
    Promise.all([
      api.sources(),
      isStaticSnapshot ? Promise.resolve([] as PlayerColor[]) : api.playerColors().catch(() => []),
      api.health().catch(() => null),
    ])
      .then(([nextSources, nextPlayerColors, appInfo]) => {
        setSources(nextSources);
        setSourceId(nextSources.some((source) => source.id === rememberedLocation.sourceId)
          ? rememberedLocation.sourceId || ""
          : nextSources[0]?.id || "");
        setPlayerColors(nextPlayerColors);
        setCurrentVersion(appInfo?.version || "");
        setHosted(appInfo?.mode === "hosted");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isStaticSnapshot && storedAutomaticUpdateCheck()) void checkLatestUpdate();
  }, []);

  useEffect(() => {
    const focusCatalogSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      setSearchFocusToken((current) => current + 1);
    };
    window.addEventListener("keydown", focusCatalogSearch);
    return () => window.removeEventListener("keydown", focusCatalogSearch);
  }, []);

  useEffect(() => subscribeAudioPlayback(() => {
    const playback = getAudioPlaybackState();
    setPlayingMediaId(playback.playing || playback.loading ? playback.assetId : "");
  }), []);

  useEffect(() => {
    setSelected(null);
    setSelectedEntity(null);
    setAssociations(null);
    setAssets([]);
    setEntities([]);
    setEntityTotal(0);
    setEntityKinds([]);
    setEntityUsages([]);
    setEntitySides([]);
    setMediaItems([]);
    setMediaGroups([]);
    setMediaKindCounts([]);
    setMediaEventTypes([]);
    setMediaCountries([]);
    setSearchEntityItems([]);
    setSearchEntityTotal(0);
    setSearchMediaItems([]);
    setSearchMediaTotal(0);
    setSearchResultsOpen(false);
    setTotal(0);
    setMediaTotal(0);
    if (!sourceId) {
      setStats({ total_assets: 0, formats: [] });
      setPalettes([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      api.stats(sourceId),
      isStaticSnapshot ? Promise.resolve([] as Asset[]) : api.palettes(sourceId),
    ])
      .then(([nextStats, nextPalettes]) => {
        if (cancelled) return;
        setStats(nextStats);
        setPalettes(nextPalettes);
        setMediaKindCounts(nextStats.media_kinds || []);
        setMediaGroups(orderedMediaGroups(nextStats.media_groups || []));
        setMediaEventTypes(nextStats.media_event_types || []);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => { cancelled = true; };
  }, [sourceId, sourceRevision, gameLanguage]);

  useEffect(() => {
    if (!sourceId || view !== "assets" || isMediaCategory) return;
    if (!assetFormats.length) {
      setAssets([]);
      setTotal(0);
      setSelectedId("");
      setAssetPageLoading(false);
      return;
    }
    let cancelled = false;
    setAssetPageLoading(true);
    setAssets([]);
    setTotal(0);
    const timer = window.setTimeout(() => {
      api.assets(sourceId, assetQuery, assetFormatKey ? assetFormatKey.split(",") : [], 0, 500, assetSort)
        .then((page) => {
          if (cancelled) return;
          setAssets(page.items);
          setTotal(page.total);
          const remembered = assetSelectionsRef.current.get(assetSelectionKey(sourceId, selectedCategoryId)) || "";
          setSelectedId((current) => {
            const next = page.items.some((asset) => asset.id === current)
              ? current
              : page.items.some((asset) => asset.id === remembered) ? remembered : page.items[0]?.id || "";
            if (next) rememberAssetCard(next, selectedCategoryId, "");
            return next;
          });
        })
        .catch((reason: Error) => !cancelled && setError(reason.message))
        .finally(() => !cancelled && setAssetPageLoading(false));
    }, assetQuery ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sourceId, sourceRevision, selectedCategoryId, assetQuery, assetFormatKey, assetSort, view, isMediaCategory]);

  useEffect(() => {
    if (!sourceId || view !== "assets" || !isMediaCategory) return;
    let cancelled = false;
    mediaLoadedCountRef.current = 0;
    setMediaLoading(true);
    setMediaItems([]);
    setMediaTotal(0);
    setPlayingMediaId("");
    pauseAudioAsset();
    const timer = window.setTimeout(() => {
      api.media(sourceId, {
        kind: mediaKind,
        group: mediaGroup,
        eventType: mediaEventType,
        offset: 0,
        limit: 500,
        sort: mediaSort,
        language: gameLanguage,
      })
        .then((page) => {
          if (cancelled) return;
          const nextItems = includeFocusedMedia(
            page.items,
            catalogListFocusRef.current,
            mediaKind,
            mediaSort,
            voiceTextPreference,
          );
          setMediaItems(nextItems);
          mediaLoadedCountRef.current = page.items.length;
          setMediaTotal(page.total);
          setMediaGroups(orderedMediaGroups(page.groups));
          setMediaKindCounts(page.kinds);
          setMediaEventTypes(page.event_types || []);
          setMediaCountries(page.countries || []);
          const remembered = assetSelectionsRef.current.get(
            assetSelectionKey(sourceId, selectedCategoryId, mediaGroup),
          ) || "";
          setSelectedId((current) => {
            const next = nextItems.some((item) => item.asset.id === current)
              ? current
              : nextItems.some((item) => item.asset.id === remembered)
                ? remembered
                : nextItems[0]?.asset.id || "";
            if (next) rememberAssetCard(next, selectedCategoryId, mediaGroup);
            return next;
          });
        })
        .catch((reason: Error) => !cancelled && setError(reason.message))
        .finally(() => !cancelled && setMediaLoading(false));
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    sourceId, sourceRevision, selectedCategoryId, mediaKind, mediaGroup, mediaEventType,
    mediaSort, gameLanguage, voiceTextPreference, view, isMediaCategory,
  ]);

  useEffect(() => {
    if (view !== "assets" || !isMediaCategory || mediaItems.length === 0) return;
    const preloadCount = isStaticSnapshot ? 12 : 4;
    const urls = mediaItems.slice(0, preloadCount).map((item) => api.mediaUrl(item.asset.id));
    const timer = window.setTimeout(() => preloadAudioResourceGroup(urls), 80);
    return () => window.clearTimeout(timer);
  }, [view, isMediaCategory, mediaItems]);

  useEffect(() => {
    if (!sourceId) {
      setEntityLoading(false);
      return;
    }
    let cancelled = false;
    setEntityLoading(true);
    const timer = window.setTimeout(() => {
      api.entities(sourceId, {
        kind: entityKind,
        usage: entityUsage,
        side: entitySide,
        language: gameLanguage,
      })
        .then((page) => {
          if (cancelled) return;
          setEntities(page.items);
          setEntityTotal(page.total);
          setEntityKinds(page.kinds);
          setEntityUsages(page.usages);
          setEntitySides(page.sides);
        })
        .catch((reason: Error) => !cancelled && setError(reason.message))
        .finally(() => !cancelled && setEntityLoading(false));
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sourceId, sourceRevision, entityKind, entityUsage, entitySide, gameLanguage]);

  useEffect(() => {
    if (!sourceId || !searchQuery.trim()) {
      setSearchEntityItems([]);
      setSearchEntityTotal(0);
      setSearchMediaItems([]);
      setSearchMediaTotal(0);
      setSearchSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    setSearchSuggestionLoading(true);
    const timer = window.setTimeout(() => {
      let pendingRequests = 0;
      const requestFinished = () => {
        pendingRequests -= 1;
        if (!cancelled && pendingRequests === 0) setSearchSuggestionLoading(false);
      };
      const reportFailure = (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "搜索失败");
      };

      if (searchTargets.includes("entities")) {
        pendingRequests += 1;
        void api.entities(sourceId, {
          query: searchQuery,
          language: gameLanguage,
        })
          .then((entityPage) => {
            if (cancelled) return;
            setSearchEntityItems(entityPage.items);
            setSearchEntityTotal(entityPage.total);
          })
          .catch(reportFailure)
          .finally(requestFinished);
      } else {
        setSearchEntityItems([]);
        setSearchEntityTotal(0);
      }

      if (searchTargets.includes("media")) {
        pendingRequests += 1;
        void api.media(sourceId, {
          query: searchQuery,
          limit: searchResultsOpen ? 500 : 80,
          language: gameLanguage,
        })
          .then((mediaPage) => {
            if (cancelled) return;
            setSearchMediaItems(mediaPage.items);
            setSearchMediaTotal(mediaPage.total);
          })
          .catch(reportFailure)
          .finally(requestFinished);
      } else {
        setSearchMediaItems([]);
        setSearchMediaTotal(0);
      }

      if (pendingRequests === 0) setSearchSuggestionLoading(false);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    sourceId, sourceRevision, searchQuery, searchTargets, searchResultsOpen, gameLanguage,
  ]);

  useEffect(() => {
    if (view !== "entities" || !sourceId || !sourceRevision || visibleEntities.length === 0) return;
    const urls = visibleEntities
      .filter((entity) => entity.renderable && !entity.thumbnail_atlas)
      .map((entity) => entityCardPreviewUrl(entity, sourceId, previewAngle, sourceRevision));
    for (const url of urls.slice(0, 12)) void preloadCardPreview(url, "foreground");
    const timer = window.setTimeout(
      () => preloadCardPreviewGroup(urls.slice(12)),
      isStaticSnapshot ? 1_600 : 400,
    );
    return () => window.clearTimeout(timer);
  }, [view, sourceId, sourceRevision, visibleEntities, previewAngle]);

  useEffect(() => {
    if (!isStaticSnapshot) return;
    const atlas = entities.find((entity) => entity.search_thumbnail_atlas)?.search_thumbnail_atlas;
    if (!atlas) return;
    const atlasAngle = Math.min(Math.max(0, previewAngle), Math.max(0, atlas.facing_count - 1));
    const primaryUrl = api.entityThumbnailAtlasUrl(atlas.path, atlasAngle);
    const fallbackUrl = api.entityThumbnailAtlasFallbackUrl(atlas.path, atlasAngle);
    void preloadThumbnailAtlas(primaryUrl).then((loaded) => {
      if (!loaded && fallbackUrl !== primaryUrl) void preloadThumbnailAtlas(fallbackUrl);
    });
  }, [entities, previewAngle]);

  useEffect(() => {
    if (view !== "entities" || !sourceId || visibleEntities.length === 0) return;
    const selectedIndex = Math.max(0, visibleEntities.findIndex((entity) => entity.id === selectedEntityId));
    const nearbyIndexes = [selectedIndex, selectedIndex + 1, selectedIndex - 1, selectedIndex + 2, selectedIndex - 2];
    const nearby = nearbyIndexes
      .map((index) => visibleEntities[index])
      .filter((entity, index, items): entity is EntitySummary => Boolean(entity)
        && items.findIndex((item) => item?.id === entity.id) === index);
    const timer = window.setTimeout(() => {
      for (const entity of nearby) {
        void api.entity(sourceId, entity.id, gameLanguage, sourceRevision).catch(() => undefined);
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [view, sourceId, sourceRevision, visibleEntities, selectedEntityId, gameLanguage]);

  useEffect(() => {
    if (view !== "assets" || !isMediaCategory || mediaItems.length === 0) return;
    const selectedIndex = Math.max(0, mediaItems.findIndex((item) => item.asset.id === selectedId));
    const nearbyIndexes = [selectedIndex, selectedIndex + 1, selectedIndex - 1];
    const nearby = nearbyIndexes
      .map((index) => mediaItems[index])
      .filter((item, index, items): item is MediaItem => Boolean(item)
        && items.findIndex((candidate) => candidate?.asset.id === item.asset.id) === index);
    const timer = window.setTimeout(() => {
      for (const item of nearby) {
        void Promise.all([
          api.asset(item.asset.id, sourceRevision),
          api.metadata(item.asset.id, sourceRevision),
          api.assetAssociations(item.asset.id, gameLanguage, sourceRevision),
        ]).catch(() => undefined);
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [view, isMediaCategory, mediaItems, selectedId, sourceRevision, gameLanguage]);

  useEffect(() => {
    if (view !== "entities" || !sourceId || !sourceRevision || !selectedEntityId || entities.length === 0) return;
    const controller = new AbortController();
    const selectedIndex = Math.max(0, entities.findIndex((entity) => entity.id === selectedEntityId));
    const nearbyIndexes = [selectedIndex, selectedIndex + 1, selectedIndex - 1, selectedIndex + 2, selectedIndex - 2];
    const ordered = nearbyIndexes.map((index) => entities[index]).filter(Boolean);
    const seen = new Set<string>();
    const urls = ordered
      .filter((entity) => entity.voxel && entity.renderable && !seen.has(entity.id) && seen.add(entity.id))
      .map((entity) => api.entityModelUrl(sourceId, entity.id, { revision: sourceRevision }));
    const timer = window.setTimeout(() => {
      void loadVoxelViewerModule().then((module) => module.preloadVoxelScenes(urls, controller.signal));
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [view, sourceId, sourceRevision, entities, selectedEntityId]);

  useEffect(() => {
    if (!sourceId || !selectedEntityId || view !== "entities") {
      setSelectedEntity(null);
      setEntityDetailLoading(false);
      return;
    }
    let cancelled = false;
    setEntityDetailLoading(true);
    api.entity(sourceId, selectedEntityId, gameLanguage, sourceRevision)
      .then((entity) => {
        if (cancelled) return;
        preloadEntityAudioResources(entity);
        setSelectedEntity(entity);
      })
      .catch((reason: Error) => {
        if (cancelled) return;
        setSelectedEntity(null);
        setError(reason.message);
      })
      .finally(() => !cancelled && setEntityDetailLoading(false));
    return () => { cancelled = true; };
  }, [sourceId, sourceRevision, selectedEntityId, gameLanguage, view]);

  useEffect(() => {
    setFrame(0);
    setPlaying(false);
    setMetadata(null);
    setTextAsset(null);
    setTextQuery("");
    setPaletteId("");
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    Promise.all([api.asset(selectedId, sourceRevision), api.metadata(selectedId, sourceRevision)])
      .then(([asset, nextMetadata]) => {
        if (cancelled) return;
        setSelected(asset);
        setMetadata(nextMetadata);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => { cancelled = true; };
  }, [selectedId, sourceRevision]);

  useEffect(() => {
    setAssociations(null);
    if (!selected || ![...audioFormats, "shp", "hva", "vxl", "video"].includes(selected.format)) {
      return;
    }
    let cancelled = false;
    api.assetAssociations(selected.id, gameLanguage, sourceRevision)
      .then((result) => !cancelled && setAssociations(result))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selected, gameLanguage, sourceRevision]);

  useEffect(() => {
    const playbackFrameCount = assetPlaybackFrameCount(selected?.format, metadata);
    if (!playing || !selected || !["shp", "hva"].includes(selected.format) || playbackFrameCount < 2) return;
    const timer = window.setInterval(
      () => setFrame((current) => (current + 1) % playbackFrameCount),
      selected.format === "hva" ? 350 : 140,
    );
    return () => window.clearInterval(timer);
  }, [playing, metadata, selected]);

  useEffect(() => {
    if (!selected || !["ini", "map", "text", "csf"].includes(selected.format)) {
      setTextAsset(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.text(selected.id, textQuery)
        .then((result) => !cancelled && setTextAsset(result))
        .catch((reason: Error) => !cancelled && setError(reason.message));
    }, textQuery ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected, textQuery]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const previewUrl = useMemo(() => {
    if (!selected || !imageFormats.includes(selected.format)) return "";
    const scale = selected.format === "pcx" ? 1 : selected.format === "pal" ? 3 : selected.format === "shp" ? 5 : 4;
    if (selected.format !== "shp") return api.previewUrl(selected.id, frame, paletteId, scale);
    const playbackFrames = shpPlaybackFrames(metadata);
    const sourceFrame = playbackFrames[frame % Math.max(1, playbackFrames.length)] ?? 0;
    const shadowFrame = metadata?.frames?.[sourceFrame]?.paired_shadow_frame ?? undefined;
    return api.previewUrl(selected.id, sourceFrame, paletteId, scale, "", { shadowFrame });
  }, [selected, frame, paletteId, metadata]);

  async function runAction(action: () => Promise<Source>, message: string) {
    setBusy(true);
    setError("");
    try {
      const source = await action();
      await refreshSources(source.id);
      setNotice(message);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function importResourcePack(file: File) {
    setBusy(true);
    setError("");
    try {
      const result = await api.importResourcePack(file);
      await refreshSources(result.source.id);
      setNotice(`已导入 ${result.installed_files.toLocaleString("zh-CN")} 个派生产物`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资源包导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function exportResourcePack(selectedSourceId: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api.exportResourcePack(selectedSourceId);
      await refreshResourcePacks();
      setNotice(`${result.filename} 已保存到本机`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资源包导出失败");
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreAssets() {
    if (assetPageLoading || assets.length >= total || !sourceId || !assetFormats.length) return;
    setAssetPageLoading(true);
    try {
      const page = await api.assets(sourceId, assetQuery, assetFormats, assets.length, 500, assetSort);
      setAssets((current) => {
        const known = new Set(current.map((asset) => asset.id));
        return [...current, ...page.items.filter((asset) => !known.has(asset.id))];
      });
      setTotal(page.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "载入失败");
    } finally {
      setAssetPageLoading(false);
    }
  }

  async function loadMoreMedia() {
    if (mediaLoading || mediaLoadedCountRef.current >= mediaTotal || !sourceId) return;
    setMediaLoading(true);
    try {
      const page = await api.media(sourceId, {
        kind: mediaKind,
        group: mediaGroup,
        eventType: mediaEventType,
        offset: mediaLoadedCountRef.current,
        limit: 500,
        sort: mediaSort,
        language: gameLanguage,
      });
      setMediaItems((current) => {
        const known = new Set(current.map((item) => item.asset.id));
        return [...current, ...page.items.filter((item) => !known.has(item.asset.id))];
      });
      mediaLoadedCountRef.current += page.items.length;
      setMediaTotal(page.total);
      setMediaEventTypes(page.event_types || []);
      setMediaCountries(page.countries || []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "载入失败");
    } finally {
      setMediaLoading(false);
    }
  }

  async function loadMoreSearchMedia() {
    if (
      searchSuggestionLoading
      || !searchResultsOpen
      || !searchQuery.trim()
      || searchMediaItems.length >= searchMediaTotal
      || !sourceId
    ) return;
    setSearchSuggestionLoading(true);
    try {
      const page = await api.media(sourceId, {
        query: searchQuery,
        offset: searchMediaItems.length,
        limit: 500,
        language: gameLanguage,
      });
      setSearchMediaItems((current) => {
        const known = new Set(current.map((item) => item.asset.id));
        return [...current, ...page.items.filter((item) => !known.has(item.asset.id))];
      });
      setSearchMediaTotal(page.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "载入搜索结果失败");
    } finally {
      setSearchSuggestionLoading(false);
    }
  }

  const catalogSearch: CatalogSearchBarProps = {
    query: searchQuery,
    setQuery: updateCatalogSearchQuery,
    targets: searchTargets,
    setTargets: updateSearchTargets,
    suggestions: catalogSearchSuggestions,
    suggestionsLoading: searchSuggestionLoading,
    onSelectSuggestion: selectCatalogSuggestion,
    onSubmit: submitCatalogSearch,
    focusToken: searchFocusToken,
    sourceId,
    sourceRevision,
    previewAngle,
    history: searchHistory,
    recents: searchRecents,
    onSelectRecent: selectCatalogRecent,
    onRemoveHistory: removeSearchHistory,
    onClearHistory: clearSearchHistory,
    onRemoveRecent: removeSearchRecent,
    onClearRecents: clearSearchRecents,
  };

  if (loading) {
    return <div className="boot"><div className="radar"><span /></div><p>正在载入资料库…</p></div>;
  }

  return (
    <div className="app-shell">
      {sources.length === 0 ? (
        <EmptyLibrary onOpenSettings={openSettings} />
      ) : (
        <main ref={workspaceRef} className={`workspace detail-${detailPlacement} ${sidebarCollapsedRef.current ? "sidebar-collapsed" : ""} ${searchResultsOpen ? "search-results-open" : ""}`} style={workspaceStyle}>
          <aside className="source-panel panel">
            <div className="sidebar-brand">
              <div className="brand-mark" aria-hidden="true"><span>R</span><i /></div>
              <strong>RA2 Explorer</strong>
              <SidebarToggle initialCollapsed={sidebarCollapsedRef.current} onChange={updateSidebarCollapsed} />
            </div>
            {sources.length > 1 && <section className="source-heading">
              <label className="source-select-wrap" title="选择资料库">
                <Icon name="archive" size={17} />
                <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} aria-label="选择资料库">
                  {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                </select>
                <Icon name="chevron" size={15} />
              </label>
            </section>}

            <nav ref={libraryTreeScroll.ref} onScroll={libraryTreeScroll.remember} className="library-tree" aria-label="浏览分类" tabIndex={0}>
              <section className="tree-branch">
                <div className="tree-parent"><Icon name="unit" /><strong>单位</strong><em>{entityKinds.reduce((count, item) => count + item.count, 0)}</em></div>
                <div className="tree-children">
                  {entityKindOrder.map((kind) => {
                    const count = entityKinds.find((item) => item.kind === kind)?.count || 0;
                    const active = view === "entities" && entityKind === kind;
                    return <div className="tree-child-group" key={kind}>
                      <button title={entityKindLabels[kind]} className={active && !entityUsage ? "active" : ""} onClick={() => selectEntityKind(kind)}><span><Icon name={entityKindIcons[kind]} /><b>{entityKindLabels[kind]}</b></span><em>{count}</em></button>
                      {active && entityUsageOrder.map((usage) => {
                        const usageCount = entityUsages.find((item) => item.usage === usage)?.count || 0;
                        const label = entityUsageLabels[kind][usage];
                        return label && usageCount > 0 ? <button title={label} className={`tree-grandchild ${entityUsage === usage ? "active" : ""}`} key={usage} onClick={() => selectEntityUsage(usage)}><span><Icon name={entityKindIcons[kind]} /><b>{label}</b></span><em>{usageCount}</em></button> : null;
                      })}
                    </div>;
                  })}
                </div>
              </section>
              {visibleCategories.some((item) => ["voices", "sounds"].includes(item.id)) && <section className="tree-branch media-tree-branch">
                <div className="tree-parent"><Icon name="play" /><strong>声音</strong><em>{mediaKindCounts.reduce((count, item) => count + item.count, 0) || categoryCount(stats, audioFormats)}</em></div>
                <div className="tree-children">
                  {visibleCategories.filter((item) => ["voices", "sounds"].includes(item.id)).map((item) => <div className="tree-child-group" key={item.id}>
                    <button title={item.label} className={view === "assets" && assetCategory === item.id && !mediaGroup ? "active" : ""} onClick={() => selectAssetCategory(item.id)}><span><Icon name={item.id === "voices" ? "voice" : "sound"} /><b>{item.label}</b></span>{mediaKindCounts.length > 0 && <em>{mediaKindCounts.find((count) => count.kind === (item.id === "voices" ? "voice" : "sound"))?.count || 0}</em>}</button>
                    {view === "assets" && assetCategory === item.id && mediaGroups.filter((group) => group.group.endsWith(item.id === "voices" ? "_voice" : "_sound")).map((group) => <button title={mediaGroupLabels[group.group] || group.group} className={`tree-grandchild ${mediaGroup === group.group ? "active" : ""}`} key={group.group} onClick={() => selectMediaGroup(mediaGroup === group.group ? "" : group.group)}><span><Icon name={item.id === "voices" ? "voice" : "sound"} /><b>{mediaGroupLabels[group.group] || group.group}</b></span><em>{group.count}</em></button>)}
                  </div>)}
                </div>
              </section>}
              {visibleCategories.filter((item) => !["voices", "sounds"].includes(item.id)).map((item) => (
                <button key={item.id} title={item.label} className={`tree-leaf ${view === "assets" && assetCategory === item.id ? "active" : ""}`} onClick={() => selectAssetCategory(item.id)}>
                  <span><Icon name={item.icon} /><b>{item.label}</b></span><em>{categoryCount(stats, item.formats.filter((formatName) => enabledFormats.includes(formatName)))}</em>
                </button>
              ))}
            </nav>
            <button className="sidebar-settings" type="button" onClick={openSettings} title={updateInfo?.update_available ? "设置 · 有可用更新" : "设置"}><Icon name="settings" /><span>设置</span>{updateInfo?.update_available && <i aria-label="有可用更新" />}</button>
          </aside>

          {searchResultsOpen ? <SearchResultsPanel
            search={catalogSearch}
            query={searchQuery.trim()}
            loading={searchSuggestionLoading}
            entities={searchEntityItems}
            entityTotal={searchEntityTotal}
            media={searchMediaItems}
            mediaTotal={searchMediaTotal}
            sourceId={sourceId}
            sourceRevision={sourceRevision}
            previewAngle={previewAngle}
            voiceTextPreference={voiceTextPreference}
            originView={view}
            originEntityKind={entityKind}
            originMediaKind={mediaKind}
            onSelectSuggestion={selectCatalogSuggestion}
            onClose={() => setSearchResultsOpen(false)}
            onLoadMoreMedia={loadMoreSearchMedia}
          /> : view === "assets" ? <>{isMediaCategory ? <MediaListPanel
            items={mediaItems}
            total={mediaTotal}
            loading={mediaLoading}
            search={catalogSearch}
            groups={mediaGroups.filter((group) => group.group.endsWith(mediaKind === "voice" ? "_voice" : "_sound"))}
            countries={mediaCountries}
            selectedGroup={mediaGroup}
            setSelectedGroup={selectMediaGroup}
            eventTypes={mediaEventTypes}
            selectedEventType={mediaEventType}
            setSelectedEventType={setMediaEventType}
            grouped={mediaGrouped}
            setGrouped={(next) => {
              setMediaGrouped(next);
              window.localStorage.setItem("ra2exp-media-grouped-v1", String(next));
            }}
            headerAlignment={mediaHeaderAlignment}
            voiceTextPreference={voiceTextPreference}
            selectedId={selectedId}
            onSelect={selectMediaCard}
            playingId={playingMediaId}
            sort={mediaSort}
            setSort={setMediaSort}
            layout={layout}
            setLayout={updateLayout}
            onLoadMore={loadMoreMedia}
            scrollKey={`media:${assetScrollKey}:${mediaGroup}:${mediaEventType}:${mediaGrouped}`}
            scrollResetRevision={listScrollResetRevision}
            catalogFocus={catalogListFocus}
            onCatalogFocusComplete={finishCatalogListFocus}
          /> : <section className="asset-panel panel">
            <div className="asset-toolbar">
              <label className="search-box"><Icon name="search" /><input value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder="搜索名称或 CRC…" aria-label="搜索资产" />{assetQuery && <button onClick={() => setAssetQuery("")} aria-label="清除搜索"><Icon name="close" size={15} /></button>}</label>
              <LayoutToggle layout={layout} onChange={updateLayout} />
            </div>
            <div className="filter-strip">
              <div className="tag-filter" role="group" aria-label="按格式筛选">
                {categoryFormats.length > 1 && <button className={!assetFormatTag ? "active" : ""} onClick={() => setAssetFormatTag("")}>不限格式</button>}
                {categoryFormats.map((formatName) => <button key={formatName} className={assetFormatTag === formatName || categoryFormats.length === 1 ? "active" : ""} onClick={() => setAssetFormatTag(categoryFormats.length === 1 ? "" : formatName)}>
                  {formatLabels[formatName] || formatName.toUpperCase()}<em>{stats.formats.find((item) => item.format === formatName)?.count || 0}</em>
                </button>)}
              </div>
              <div className="media-filter-actions asset-filter-actions">
                <span className="result-count">显示 {assets.length} / {total}</span>
                <label className="sort-control"><span>排序</span><select value={assetSort} onChange={(event) => setAssetSort(event.target.value as AssetSort)}>
                  <option value="name_asc">名称 A–Z</option>
                  <option value="name_desc">名称 Z–A</option>
                  <option value="size_desc">体积从大到小</option>
                  <option value="size_asc">体积从小到大</option>
                </select></label>
              </div>
            </div>
            <div ref={assetListScroll.ref} className={`asset-list ${layout === "grid" ? "asset-grid" : "list-columns"}`} tabIndex={0} aria-label="资产列表" onScroll={(event) => { assetListScroll.remember(event); const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) void loadMoreAssets(); }}>
              {layout === "list" ? assets.map((asset) => (
                <button key={asset.id} className={`asset-row ${selectedId === asset.id ? "selected" : ""}`} onClick={() => selectAssetCard(asset.id)}>
                  <span className={`file-icon format-${asset.format}`}><Icon name={assetIcon(asset.format)} /></span>
                  <span className="asset-main"><strong>{assetDisplayName(asset)}</strong><small>{formatLabels[asset.format] || asset.format.toUpperCase()}</small></span>
                  <span className="asset-size">{formatBytes(asset.size)}</span>
                  <Icon name="chevron" size={15} />
                </button>
              )) : assets.map((asset) => <AssetGridCard key={asset.id} asset={asset} selected={selectedId === asset.id} onSelect={selectAssetCard} />)}
              {assets.length < total && <button className="load-more" disabled={assetPageLoading} onClick={() => void loadMoreAssets()}>{assetPageLoading ? "正在载入…" : `载入更多（剩余 ${(total - assets.length).toLocaleString("zh-CN")}）`}</button>}
              {assetPageLoading && assets.length === 0 && <div className="entity-loading"><div className="radar small"><span /></div><strong>正在载入资产…</strong></div>}
              {!assetPageLoading && assets.length === 0 && <div className="no-results"><Icon name="search" size={28} /><strong>没有匹配的资产</strong><button onClick={() => { setAssetQuery(""); setAssetFormatTag(""); }}>清除筛选</button></div>}
            </div>
          </section>}

          <div className="workspace-resizer" role="separator" tabIndex={0} aria-label="调整详情区域大小" aria-orientation={detailPlacement === "bottom" ? "horizontal" : "vertical"} aria-valuenow={detailSize} onPointerDown={beginDetailResize} onKeyDown={resizeDetailWithKeyboard}><span /></div>

          <DetailPanel
            asset={selected}
            metadata={metadata}
            textAsset={textAsset}
            textQuery={textQuery}
            setTextQuery={setTextQuery}
            frame={frame}
            setFrame={setFrame}
            playing={playing}
            setPlaying={setPlaying}
            palettes={palettes}
            paletteId={paletteId}
            setPaletteId={setPaletteId}
            playerColors={playerColors}
            previewUrl={previewUrl}
            associations={associations}
            voiceTextPreference={voiceTextPreference}
            wide={detailPlacement === "bottom"}
            scrollKey={`asset:${sourceId}:${selectedId}:${detailPlacement}`}
            onPopout={() => window.open(staticPopoutUrl(new URLSearchParams({ detail: "asset", asset_id: selectedId })), `ra2exp-asset-${selectedId}`, "popup=yes,width=1100,height=780")}
          />
          </> : <>
            <EntityListPanel
              entities={visibleEntities}
              total={entityTotal}
              loading={entityLoading}
              search={catalogSearch}
              sort={entitySort}
              setSort={updateEntitySort}
              buildableFirst={entityBuildableFirst}
              setBuildableFirst={updateEntityBuildableFirst}
              selectedId={selectedEntityId}
              setSelectedId={selectEntityCard}
              sourceId={sourceId}
              sourceRevision={sourceRevision}
              sides={entitySideFacets}
              selectedSide={entitySide}
              setSelectedSide={setEntitySide}
              layout={layout}
              setLayout={updateLayout}
              previewAngle={previewAngle}
              scrollKey={`entities:${sourceId}:${entityKind}:${entityUsage}:${entitySide}:${entitySort}:${entityBuildableFirst}:${layout}`}
              scrollResetRevision={listScrollResetRevision}
              catalogFocus={catalogListFocus}
              onCatalogFocusComplete={finishCatalogListFocus}
            />
            <div className="workspace-resizer" role="separator" tabIndex={0} aria-label="调整详情区域大小" aria-orientation={detailPlacement === "bottom" ? "horizontal" : "vertical"} aria-valuenow={detailSize} onPointerDown={beginDetailResize} onKeyDown={resizeDetailWithKeyboard}><span /></div>
            <EntityDetailPanel
              sourceId={sourceId}
              sourceRevision={sourceRevision}
              entity={selectedEntity}
              loading={entityDetailLoading}
              playerColors={playerColors}
              defaultPreviewAngle={previewAngle}
              voiceTextPreference={voiceTextPreference}
              wide={detailPlacement === "bottom"}
              scrollKey={`entity:${sourceId}:${selectedEntityId}:${detailPlacement}`}
              onPopout={() => window.open(staticPopoutUrl(new URLSearchParams({ detail: "entity", source_id: sourceId, entity_id: selectedEntityId })), `ra2exp-entity-${selectedEntityId}`, "popup=yes,width=1100,height=780")}
            />
          </>}
        </main>
      )}

      {settingsOpen && <SettingsDialog
        hosted={hosted}
        formats={stats.formats}
        enabled={enabledFormats}
        onChange={updateEnabledFormats}
        detailPlacement={detailPlacement}
        onDetailPlacementChange={updateDetailPlacement}
        gameLanguage={gameLanguage}
        onGameLanguageChange={updateGameLanguage}
        voiceTextPreference={voiceTextPreference}
        onVoiceTextPreferenceChange={updateVoiceTextPreference}
        previewAngle={previewAngle}
        onPreviewAngleChange={updatePreviewAngle}
        mediaHeaderAlignment={mediaHeaderAlignment}
        onMediaHeaderAlignmentChange={updateMediaHeaderAlignment}
        sources={sources}
        selectedSourceId={sourceId}
        discoveries={discovery.candidates}
        resourcePacks={resourcePacks}
        busy={busy}
        onAddSource={async (path, name) => {
          await runAction(() => api.addSource(path, name), "游戏目录已解析");
        }}
        onScanSource={async (id) => {
          await runAction(() => api.scanSource(id), "资料库已重新扫描");
        }}
        onImportResourcePack={importResourcePack}
        onExportResourcePack={exportResourcePack}
        currentVersion={currentVersion}
        automaticUpdateCheck={automaticUpdateCheck}
        onAutomaticUpdateCheckChange={updateAutomaticUpdateCheck}
        updateInfo={updateInfo}
        updateChecking={updateChecking}
        updateError={updateError}
        onCheckUpdate={checkLatestUpdate}
        onClose={() => setSettingsOpen(false)}
      />}
      {error && <div className="toast error" role="alert"><Icon name="info" /><span>{error}</span><button onClick={() => setError("")} aria-label="关闭"><Icon name="close" size={15} /></button></div>}
      {notice && <div className="toast success" role="status"><span className="check">✓</span><span>{notice}</span></div>}
    </div>
  );
}

function EmptyLibrary({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <main className="empty-library">
      <div className="empty-visual" aria-hidden="true"><div className="disc"><span /><i /><b /></div><div className="scan-line" /></div>
      <h1>导入 RA2 游戏目录</h1>
      <div className="empty-actions">
        <button className="button primary large" onClick={onOpenSettings}><Icon name="settings" />打开设置</button>
      </div>
    </main>
  );
}

function LayoutToggle({ layout, onChange }: { layout: LayoutMode; onChange: (layout: LayoutMode) => void }) {
  return (
    <div className="layout-toggle" role="group" aria-label="布局方式">
      <button className={layout === "list" ? "active" : ""} onClick={() => onChange("list")} aria-label="列表视图" title="列表视图"><Icon name="list" size={16} /></button>
      <button className={layout === "grid" ? "active" : ""} onClick={() => onChange("grid")} aria-label="网格视图" title="网格视图"><Icon name="grid" size={16} /></button>
    </div>
  );
}

function AssetGridCard({ asset, selected, onSelect }: { asset: Asset; selected: boolean; onSelect: (id: string) => void }) {
  const hasThumbnail = ["shp", "vxl", "tmp", "pcx", "pal", "map"].includes(asset.format);
  const isAudio = audioFormats.includes(asset.format);
  return (
    <button className={`asset-card ${selected ? "selected" : ""}`} onClick={() => onSelect(asset.id)}>
      <span className={`asset-card-preview format-${asset.format}`}>
        {hasThumbnail ? <img loading="lazy" src={api.previewUrl(asset.id, 0, "", 3)} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />
          : isAudio ? <span className="audio-glyph" aria-hidden="true">{[4, 11, 7, 17, 12, 20, 9, 14, 5, 10].map((height, index) => <i key={index} style={{ height }} />)}</span>
            : <Icon name={assetIcon(asset.format)} size={32} />}
      </span>
      <span className="asset-card-copy"><strong title={assetDisplayName(asset)}>{assetDisplayName(asset)}</strong><small>{formatLabels[asset.format] || asset.format.toUpperCase()} · {formatBytes(asset.size)}</small></span>
    </button>
  );
}

function cleanAudioText(value: string) {
  return value.trim().replace(/^\*+\s*/, "").replace(/\s*\*+$/, "").trim();
}

function preferredAudioText(
  localizedText: string | null | undefined,
  translatedText: string | null | undefined,
  preference: VoiceTextPreference,
) {
  const localized = cleanAudioText(localizedText || "");
  const translated = cleanAudioText(translatedText || "");
  if (preference === "game") {
    if (localized) return { label: "中文", value: localized };
    if (translated) return { label: "译文", value: translated };
  } else {
    if (translated) return { label: "译文", value: translated };
    if (localized) return { label: "中文", value: localized };
  }
  return null;
}

function preferredMediaTexts(item: MediaItem, preference: VoiceTextPreference) {
  const localized = uniqueAudioTexts(item.localized_texts || []);
  const translated = uniqueAudioTexts(item.translated_texts || []);
  if (preference === "game") {
    return localized.length > 0
      ? { label: "中文", values: localized }
      : { label: "译文", values: translated };
  }
  return translated.length > 0
    ? { label: "译文", values: translated }
    : { label: "中文", values: localized };
}

function uniqueAudioTexts(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const cleaned = cleanAudioText(value);
    const key = cleaned.replace(/\s+/g, " ").toLocaleLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function mediaPrimaryText(item: MediaItem, preference: VoiceTextPreference = "translation") {
  const preferred = preferredMediaTexts(item, preference).values[0];
  return cleanAudioText(preferred
    || item.description
    || item.original_texts[0]
    || assetDisplayName(item.asset));
}

function mediaSecondaryText(item: MediaItem, preference: VoiceTextPreference = "translation") {
  const primary = mediaPrimaryText(item, preference);
  const primaryKey = primary.replace(/\s+/g, " ").toLocaleLowerCase();
  return uniqueAudioTexts([...item.original_texts, assetDisplayName(item.asset)])
    .filter((text) => text.replace(/\s+/g, " ").toLocaleLowerCase() !== primaryKey)
    .join(" · ");
}

function mediaEntityGroupLabels(entities: MediaItem["entities"]) {
  const nameCounts = new Map<string, number>();
  for (const entity of entities) {
    nameCounts.set(entity.display_name, (nameCounts.get(entity.display_name) || 0) + 1);
  }
  return [...new Set(entities.map((entity) => {
    const needsAffiliation = (nameCounts.get(entity.display_name) || 0) > 1;
    return needsAffiliation && entity.affiliation?.display_name
      ? `${entity.display_name}（${entity.affiliation.display_name}）`
      : entity.display_name;
  }))];
}

function normalizedMediaEvents(item: MediaItem) {
  return item.events.map((event) => event.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "")).join(" ");
}

function semanticSoundSectionIdentity(item: MediaItem, selectedGroup: string) {
  const events = normalizedMediaEvents(item);
  const section = (key: string, label: string) => ({ key: `semantic:${selectedGroup}:${key}`, label, subtitle: "" });
  if (selectedGroup === "superweapon_sound") {
    if (events.includes("forceshield")) return section("force-shield", "力场护盾");
    if (events.includes("geneticmutator")) return section("genetic-mutator", "基因突变器");
    if (events.includes("ironcurtain")) return section("iron-curtain", "铁幕装置");
    if (events.includes("nuke") || events.includes("nuclear")) return section("nuclear", "核弹");
    if (events.includes("psychicdominator")) return section("psychic-dominator", "心灵控制器");
    if (events.includes("weather")) return section("weather-control", "天气控制器");
    if (events.includes("chronosphere") || events.includes("chronoscreen")) return section("chronosphere", "超时空传送");
    if (events.includes("psychicreveal")) return section("psychic-reveal", "心灵探测");
    return section("other", "其他超级武器");
  }
  if (selectedGroup === "notification_sound") {
    if (["crate", "bonus", "credit", "upgrade", "heal"].some((token) => events.includes(token))) {
      return section("reward", "箱子、资源与升级");
    }
    if (["camera", "radar", "beacon", "detected", "flare"].some((token) => events.includes(token))) {
      return section("recon", "侦察与雷达");
    }
    if (["player", "join", "game", "cheer", "garrison", "repair"].some((token) => events.includes(token))) {
      return section("status", "玩家与状态");
    }
    if (["warning", "alarm", "siren", "mindcleared", "bombtick", "ready"].some((token) => events.includes(token))) {
      return section("alert", "警报与就绪");
    }
    return section("other", "其他提示");
  }
  if (selectedGroup === "interface_sound") {
    if (["menu", "options", "commandbar", "mouse", "tab", "click", "scroll"].some((token) => events.includes(token))) {
      return section("controls", "菜单与操作");
    }
    if (["movie", "intro", "map", "wipe"].some((token) => events.includes(token))) {
      return section("transition", "过场与切换");
    }
    if (["score", "bargraph", "bestbox", "efficien"].some((token) => events.includes(token))) {
      return section("score", "结算界面");
    }
    if (["message", "text", "type"].some((token) => events.includes(token))) {
      return section("message", "文字与消息");
    }
    return section("other", "其他界面");
  }
  return null;
}

interface MediaSectionIdentity {
  key: string;
  label: string;
  subtitle: string;
  countryOrder?: number;
}

function mediaSectionIdentity(
  item: MediaItem,
  selectedGroup: string,
  countryNames: ReadonlyMap<string, { label: string; order: number }>,
): MediaSectionIdentity {
  if (["multiplayer_voice", "taunt_voice"].includes(selectedGroup) && item.countries.length > 0) {
    const countryIds = [...item.countries].sort((left, right) => (
      (countryNames.get(left)?.order ?? Number.MAX_SAFE_INTEGER)
      - (countryNames.get(right)?.order ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    ));
    return {
      key: `country:${countryIds.join("|")}`,
      label: countryIds.map((id) => countryNames.get(id)?.label || id).join(" · "),
      subtitle: "",
      countryOrder: Math.min(...countryIds.map(
        (id) => countryNames.get(id)?.order ?? Number.MAX_SAFE_INTEGER,
      )),
    };
  }
  const semanticSection = semanticSoundSectionIdentity(item, selectedGroup);
  if (semanticSection) return semanticSection;
  if (item.entities.length === 1) {
    const entity = item.entities[0];
    return { key: `entity:${entity.id}`, label: entity.display_name, subtitle: entity.id };
  }
  if (item.entities.length > 1) {
    const entities = [...item.entities].sort((left, right) => left.id.localeCompare(right.id));
    return {
      key: `shared:${entities.map((entity) => entity.id).join("|")}`,
      label: mediaEntityGroupLabels(entities).join(" · "),
      subtitle: "",
    };
  }
  if (item.mission) {
    return {
      key: `mission:${item.mission.key}`,
      label: missionLabel(item.mission),
      subtitle: "",
    };
  }
  const group = item.groups[0] || "unclassified";
  return { key: `group:${group}`, label: mediaGroupLabels[group] || group, subtitle: "" };
}

type CatalogSearchBarProps = {
  query: string;
  setQuery: (value: string) => void;
  targets: CatalogSearchTarget[];
  setTargets: (value: CatalogSearchTarget[]) => void;
  suggestions: CatalogSearchSuggestion[];
  suggestionsLoading: boolean;
  onSelectSuggestion: (suggestion: CatalogSearchSuggestion) => void;
  onSubmit: () => void;
  focusToken: number;
  sourceId: string;
  sourceRevision: string;
  previewAngle: PreviewAngle;
  history: string[];
  recents: CatalogRecentItem[];
  onSelectRecent: (item: CatalogRecentItem) => void;
  onRemoveHistory: (value: string) => void;
  onClearHistory: () => void;
  onRemoveRecent: (key: string) => void;
  onClearRecents: () => void;
};

function CatalogSearchBar(props: CatalogSearchBarProps) {
  const {
    query, setQuery, targets, setTargets, suggestions, suggestionsLoading,
    onSelectSuggestion, onSubmit, focusToken, sourceId, sourceRevision, previewAngle,
    history, recents, onSelectRecent, onRemoveHistory, onClearHistory,
    onRemoveRecent, onClearRecents,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsScrollRef = useRef<HTMLDivElement>(null);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const suggestionsVisible = suggestionsOpen && Boolean(query.trim())
    && (suggestions.length > 0 || suggestionsLoading);
  const historyVisible = suggestionsOpen && !query.trim();
  const visibleRecents = recents.filter(
    (item) => item.sourceId === sourceId && targets.includes(item.target),
  );
  const searchesEntities = targets.includes("entities");
  const searchesMedia = targets.includes("media");
  const placeholder = searchesEntities && searchesMedia
    ? "快捷键 Ctrl+K · 搜索单位、声音、中英文或拼音…"
    : searchesEntities
      ? "快捷键 Ctrl+K · 搜索单位名称、中英文或拼音…"
      : "快捷键 Ctrl+K · 搜索声音、对白、中英文或拼音…";
  const searchLabel = searchesEntities && searchesMedia
    ? "搜索单位和声音"
    : searchesEntities ? "搜索单位" : "搜索声音";

  useEffect(() => setSuggestionIndex(-1), [query, suggestions[0]?.key]);
  useLayoutEffect(() => {
    if (suggestionsScrollRef.current) suggestionsScrollRef.current.scrollTop = 0;
  }, [query, targets.join(":"), suggestionsOpen]);
  useLayoutEffect(() => {
    if (historyScrollRef.current) historyScrollRef.current.scrollTop = 0;
  }, [suggestionsOpen]);
  useEffect(() => {
    if (focusToken <= 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    setSuggestionsOpen(true);
  }, [focusToken]);
  useEffect(() => {
    const closeWhenOutside = (event: PointerEvent | FocusEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setSuggestionsOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
    };
  }, []);

  function toggleTarget(target: CatalogSearchTarget, checked: boolean) {
    const order: CatalogSearchTarget[] = ["entities", "media"];
    const next = order.filter((value) => value === target ? checked : targets.includes(value));
    if (next.length > 0) setTargets(next);
  }

  function selectSuggestion(suggestion: CatalogSearchSuggestion) {
    onSelectSuggestion(suggestion);
    setSuggestionsOpen(false);
  }

  function selectRecent(item: CatalogRecentItem) {
    onSelectRecent(item);
    setSuggestionsOpen(false);
  }

  function selectHistory(value: string) {
    setQuery(value);
    setSuggestionsOpen(true);
    inputRef.current?.focus();
  }

  function submitSearch() {
    if (!query.trim()) {
      inputRef.current?.focus();
      return;
    }
    setSuggestionsOpen(false);
    onSubmit();
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setSuggestionsOpen(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (suggestionsOpen && suggestionIndex >= 0 && suggestions[suggestionIndex]) {
        selectSuggestion(suggestions[suggestionIndex]);
      } else {
        submitSearch();
      }
      return;
    }
    if (!suggestions.length || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowDown") {
      setSuggestionsOpen(true);
      setSuggestionIndex((current) => current < 0 ? 0 : (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      setSuggestionsOpen(true);
      setSuggestionIndex((current) => current < 0 ? suggestions.length - 1 : (current - 1 + suggestions.length) % suggestions.length);
    }
  }

  return <div ref={rootRef} className="entity-search-cluster catalog-search" role="search">
    <div className="entity-search-options">
      <div className="catalog-search-targets" role="group" aria-label="搜索内容类型">
        <label className={searchesEntities ? "active" : ""}><input type="checkbox" checked={searchesEntities} onChange={(event) => toggleTarget("entities", event.target.checked)} /><span>单位</span></label>
        <label className={searchesMedia ? "active" : ""}><input type="checkbox" checked={searchesMedia} onChange={(event) => toggleTarget("media", event.target.checked)} /><span>声音</span></label>
      </div>
      <button type="button" className="catalog-search-clear" disabled={!query} onClick={() => { setQuery(""); setSuggestionsOpen(true); inputRef.current?.focus(); }} aria-label="清除搜索" title="清除搜索"><Icon name="close" size={15} /></button>
    </div>
    <div className="entity-search-input">
      <div className="search-box entity-search-box"><Icon name="search" /><input ref={inputRef} value={query} onFocus={() => setSuggestionsOpen(true)} onKeyDown={handleSearchKeyDown} onChange={(event) => { setQuery(event.target.value); setSuggestionsOpen(true); }} placeholder={placeholder} aria-label={searchLabel} role="combobox" aria-autocomplete="list" aria-expanded={suggestionsVisible || historyVisible} aria-controls={suggestionsVisible ? "catalog-search-suggestions" : historyVisible ? "catalog-search-history" : undefined} aria-activedescendant={suggestionsVisible && suggestionIndex >= 0 && suggestions[suggestionIndex] ? `catalog-suggestion-${suggestions[suggestionIndex].key.replace(/[^a-z0-9_-]/gi, "-")}` : undefined} /></div>
      {suggestionsVisible && <div ref={suggestionsScrollRef} className="entity-search-suggestions" id="catalog-search-suggestions" role="listbox" aria-label="搜索建议" onMouseDown={(event) => event.preventDefault()}>
        {suggestions.map((suggestion, index) => {
          const mediaVisualKind = suggestion.media?.kind === "voice" ? "voice" : "sound";
          return <button id={`catalog-suggestion-${suggestion.key.replace(/[^a-z0-9_-]/gi, "-")}`} type="button" role="option" aria-selected={index === suggestionIndex} className={`${index === suggestionIndex ? "active " : ""}catalog-suggestion-${suggestion.target === "entities" ? "entity" : mediaVisualKind}`} key={suggestion.key} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => selectSuggestion(suggestion)}>
            {suggestion.entity
              ? <EntityCardPreview entity={suggestion.entity} sourceId={sourceId} sourceRevision={sourceRevision} previewAngle={previewAngle} compact />
              : <span className={`catalog-suggestion-icon catalog-suggestion-icon-${mediaVisualKind}`}><Icon name={mediaVisualKind} size={18} /></span>}
            <span className="catalog-suggestion-copy"><strong>{suggestion.title}</strong><small>{suggestion.subtitle}</small></span>
            <em>{suggestion.meta}</em>
          </button>;
        })}
        {suggestionsLoading && suggestions.length === 0 && <div className="catalog-search-loading"><span />正在检索单位和声音…</div>}
      </div>}
      {historyVisible && <div ref={historyScrollRef} className="catalog-search-history" id="catalog-search-history" onMouseDown={(event) => event.preventDefault()}>
        {visibleRecents.length > 0 && <section>
          <header><strong>最近访问</strong><button type="button" onClick={onClearRecents}>清空</button></header>
          <div className="catalog-history-list">{visibleRecents.map((item) => {
            const mediaVisualKind = item.media?.kind === "voice" ? "voice" : "sound";
            return <div className={`catalog-history-item catalog-history-${item.target === "entities" ? "entity" : mediaVisualKind}`} key={item.key}>
              <button type="button" className="catalog-history-target" onClick={() => selectRecent(item)}>
                {item.entity
                  ? <EntityCardPreview entity={item.entity} sourceId={sourceId} sourceRevision={sourceRevision} previewAngle={previewAngle} compact />
                  : <span className={`catalog-suggestion-icon catalog-suggestion-icon-${mediaVisualKind}`}><Icon name={mediaVisualKind} size={18} /></span>}
                <span className="catalog-suggestion-copy"><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                <em>{item.meta}</em>
              </button>
              <button type="button" className="catalog-history-remove" onClick={() => onRemoveRecent(item.key)} aria-label={`删除最近访问：${item.title}`} title="删除"><Icon name="close" size={14} /></button>
            </div>;
          })}</div>
        </section>}
        {history.length > 0 && <section>
          <header><strong>搜索历史</strong><button type="button" onClick={onClearHistory}>清空</button></header>
          <div className="catalog-history-list catalog-query-history">{history.map((value) => <div className="catalog-history-item" key={value}>
            <button type="button" className="catalog-history-target" onClick={() => selectHistory(value)}><span className="catalog-history-query-icon"><Icon name="search" size={16} /></span><strong>{value}</strong></button>
            <button type="button" className="catalog-history-remove" onClick={() => onRemoveHistory(value)} aria-label={`删除搜索历史：${value}`} title="删除"><Icon name="close" size={14} /></button>
          </div>)}</div>
        </section>}
        {visibleRecents.length === 0 && history.length === 0 && <div className="catalog-history-empty">暂无搜索记录</div>}
      </div>}
    </div>
    <button type="button" className="catalog-search-submit" disabled={!query.trim()} onClick={submitSearch}><Icon name="search" size={15} /><span>搜索</span></button>
  </div>;
}

function entitySearchResultSides(entity: EntitySummary) {
  if (entity.sides.length > 0) return entity.sides;
  if (entity.affiliation?.kind === "side") return [entity.affiliation.id];
  return ["unaffiliated"];
}

function SearchResultsPanel({
  search,
  query,
  loading,
  entities,
  entityTotal,
  media,
  mediaTotal,
  sourceId,
  sourceRevision,
  previewAngle,
  voiceTextPreference,
  originView,
  originEntityKind,
  originMediaKind,
  onSelectSuggestion,
  onClose,
  onLoadMoreMedia,
}: {
  search: CatalogSearchBarProps;
  query: string;
  loading: boolean;
  entities: EntitySummary[];
  entityTotal: number;
  media: MediaItem[];
  mediaTotal: number;
  sourceId: string;
  sourceRevision: string;
  previewAngle: PreviewAngle;
  voiceTextPreference: VoiceTextPreference;
  originView: "assets" | "entities";
  originEntityKind: EntityKind | "";
  originMediaKind: MediaKind;
  onSelectSuggestion: (suggestion: CatalogSearchSuggestion) => void;
  onClose: () => void;
  onLoadMoreMedia: () => Promise<void>;
}) {
  const [entityKindFilter, setEntityKindFilter] = useState<EntityKind | "">("");
  const [entitySideFilter, setEntitySideFilter] = useState("");
  const [mediaKindFilter, setMediaKindFilter] = useState<MediaKind | "">("");
  const [mediaGroupFilter, setMediaGroupFilter] = useState("");
  const scroll = useRememberedScroll(
    `search-results:${query}:${search.targets.join(",")}:${entityKindFilter}:${entitySideFilter}:${mediaKindFilter}:${mediaGroupFilter}`,
    entities.length + media.length,
  );

  useEffect(() => {
    setEntityKindFilter("");
    setEntitySideFilter("");
    setMediaKindFilter("");
    setMediaGroupFilter("");
  }, [query]);

  const rankedEntities = useMemo(() => [...entities].sort((left, right) => {
    const leftScore = entitySuggestionScore(left, query)
      - (originView === "entities" ? 0.6 : 0)
      - (originView === "entities" && left.kind === originEntityKind ? 0.25 : 0);
    const rightScore = entitySuggestionScore(right, query)
      - (originView === "entities" ? 0.6 : 0)
      - (originView === "entities" && right.kind === originEntityKind ? 0.25 : 0);
    return leftScore - rightScore || left.display_name.localeCompare(right.display_name, "zh-CN", { numeric: true });
  }), [entities, originEntityKind, originView, query]);
  const rankedMedia = useMemo(() => [...media].sort((left, right) => {
    const leftScore = mediaSuggestionScore(left, query)
      - (originView === "assets" ? 0.6 : 0)
      - (originView === "assets" && left.kind === originMediaKind ? 0.25 : 0);
    const rightScore = mediaSuggestionScore(right, query)
      - (originView === "assets" ? 0.6 : 0)
      - (originView === "assets" && right.kind === originMediaKind ? 0.25 : 0);
    return leftScore - rightScore || mediaPrimaryText(left, voiceTextPreference).localeCompare(mediaPrimaryText(right, voiceTextPreference), "zh-CN", { numeric: true });
  }), [media, originMediaKind, originView, query, voiceTextPreference]);
  const entityKindFacets = entityKindOrder.map((kind) => ({
    kind,
    count: entities.filter((entity) => entity.kind === kind).length,
  })).filter((facet) => facet.count > 0);
  const entitySideFacets = orderedSideFacets(
    [...entities.reduce((counts, entity) => {
      for (const side of entitySearchResultSides(entity)) counts.set(side, (counts.get(side) || 0) + 1);
      return counts;
    }, new Map<string, number>())].map(([id, count]) => ({ id, count })),
    entitySideFilter,
  );
  const mediaKindFacets = (["voice", "sound"] as MediaKind[]).map((kind) => ({
    kind,
    count: media.filter((item) => item.kind === kind).length,
  })).filter((facet) => facet.count > 0);
  const mediaGroupFacets = orderedMediaGroups(
    [...media.reduce((counts, item) => {
      for (const group of item.groups) counts.set(group, (counts.get(group) || 0) + 1);
      return counts;
    }, new Map<string, number>())].map(([group, count]) => ({ group, count })),
  );
  const visibleEntities = rankedEntities.filter((entity) => (
    (!entityKindFilter || entity.kind === entityKindFilter)
    && (!entitySideFilter || entitySearchResultSides(entity).includes(entitySideFilter))
  ));
  const visibleMedia = rankedMedia.filter((item) => (
    (!mediaKindFilter || item.kind === mediaKindFilter)
    && (!mediaGroupFilter || item.groups.includes(mediaGroupFilter))
  ));
  const total = (search.targets.includes("entities") ? entityTotal : 0)
    + (search.targets.includes("media") ? mediaTotal : 0);

  function selectEntity(entity: EntitySummary) {
    onSelectSuggestion({
      key: `entity:${entity.id}`,
      target: "entities",
      title: entity.display_name,
      subtitle: entity.internal_name,
      meta: entity.id,
      score: entitySuggestionScore(entity, query),
      entity,
    });
  }

  function selectMedia(item: MediaItem) {
    onSelectSuggestion({
      key: `media:${item.asset.id}`,
      target: "media",
      title: mediaPrimaryText(item, voiceTextPreference),
      subtitle: mediaSecondaryText(item, voiceTextPreference),
      meta: item.entities.map((entity) => entity.display_name).join(" · "),
      score: mediaSuggestionScore(item, query),
      media: item,
    });
  }

  const entitySection = search.targets.includes("entities") && <section className="search-result-section entity-search-results">
    <header><span><Icon name="unit" size={17} /><strong>单位</strong><em>{visibleEntities.length} / {entityTotal}</em></span></header>
    {entityKindFacets.length > 1 && <div className="tag-filter search-result-filter" role="group" aria-label="筛选搜索结果中的单位类型">
      <button className={!entityKindFilter ? "active" : ""} onClick={() => setEntityKindFilter("")}>全部单位</button>
      {entityKindFacets.map((facet) => <button key={facet.kind} className={entityKindFilter === facet.kind ? "active" : ""} onClick={() => setEntityKindFilter(entityKindFilter === facet.kind ? "" : facet.kind)}>{entityKindLabels[facet.kind]}<em>{facet.count}</em></button>)}
    </div>}
    {entitySideFacets.length > 1 && <div className="tag-filter search-result-filter" role="group" aria-label="筛选搜索结果中的单位阵营">
      <button className={!entitySideFilter ? "active" : ""} onClick={() => setEntitySideFilter("")}>全部阵营</button>
      {entitySideFacets.map((facet) => <button key={facet.id} className={entitySideFilter === facet.id ? "active" : ""} onClick={() => setEntitySideFilter(entitySideFilter === facet.id ? "" : facet.id)}>{sideLabels[facet.id] || facet.id}<em>{facet.count}</em></button>)}
    </div>}
    {visibleEntities.length > 0
      ? <div className="asset-grid entity-grid search-result-grid">{visibleEntities.map((entity) => <EntityGridCard key={entity.id} entity={entity} sourceId={sourceId} sourceRevision={sourceRevision} previewAngle={previewAngle} selected={false} onSelect={() => selectEntity(entity)} />)}</div>
      : <div className="search-result-empty">当前结果中没有匹配的单位</div>}
  </section>;

  const mediaSection = search.targets.includes("media") && <section className="search-result-section media-search-results">
    <header><span><Icon name="voice" size={17} /><strong>声音</strong><em>{visibleMedia.length} / {mediaTotal}</em></span></header>
    {mediaKindFacets.length > 1 && <div className="tag-filter search-result-filter" role="group" aria-label="筛选搜索结果中的声音类型">
      <button className={!mediaKindFilter ? "active" : ""} onClick={() => setMediaKindFilter("")}>全部声音</button>
      {mediaKindFacets.map((facet) => <button key={facet.kind} className={mediaKindFilter === facet.kind ? "active" : ""} onClick={() => setMediaKindFilter(mediaKindFilter === facet.kind ? "" : facet.kind)}>{facet.kind === "voice" ? "游戏语音" : "游戏音效"}<em>{facet.count}</em></button>)}
    </div>}
    {mediaGroupFacets.length > 1 && <div className="tag-filter search-result-filter" role="group" aria-label="筛选搜索结果中的声音用途">
      <button className={!mediaGroupFilter ? "active" : ""} onClick={() => setMediaGroupFilter("")}>全部用途</button>
      {mediaGroupFacets.map((facet) => <button key={facet.group} className={mediaGroupFilter === facet.group ? "active" : ""} onClick={() => setMediaGroupFilter(mediaGroupFilter === facet.group ? "" : facet.group)}>{mediaGroupLabels[facet.group] || facet.group}<em>{facet.count}</em></button>)}
    </div>}
    {visibleMedia.length > 0
      ? <div className="search-media-grid">{visibleMedia.map((item) => {
        const primaryText = mediaPrimaryText(item, voiceTextPreference);
        const secondaryText = mediaSecondaryText(item, voiceTextPreference);
        return <button type="button" className="search-media-card" key={item.asset.id} onPointerEnter={() => void preloadAudioResource(api.mediaUrl(item.asset.id), "foreground")} onFocus={() => void preloadAudioResource(api.mediaUrl(item.asset.id), "foreground")} onClick={() => selectMedia(item)}><span className="search-media-play"><Icon name="play" size={15} /></span><span><strong>{primaryText}</strong>{secondaryText && <small>{secondaryText}</small>}</span><em>{mediaGroupLabels[item.groups[0]] || item.groups[0] || (item.kind === "voice" ? "游戏语音" : "游戏音效")}</em></button>;
      })}</div>
      : <div className="search-result-empty">当前结果中没有匹配的声音</div>}
    {media.length < mediaTotal && <button className="load-more search-result-load-more" disabled={loading} onClick={() => void onLoadMoreMedia()}>{loading ? "正在载入…" : `载入更多声音（剩余 ${(mediaTotal - media.length).toLocaleString("zh-CN")}）`}</button>}
  </section>;

  return <section className="asset-panel search-results-panel panel">
    <div className="asset-toolbar search-results-toolbar"><CatalogSearchBar {...search} /><button type="button" className="search-results-close" onClick={onClose} aria-label="返回浏览" title="返回浏览"><Icon name="close" size={16} /></button></div>
    <div className="search-results-heading"><h1><span>搜索结果</span><strong>“{query}”</strong></h1><em>共 {total.toLocaleString("zh-CN")} 项</em>{loading && <i aria-label="正在更新结果" />}</div>
    <div ref={scroll.ref} onScroll={scroll.remember} className="search-results-scroll" tabIndex={0}>
      {originView === "entities" ? <>{entitySection}{mediaSection}</> : <>{mediaSection}{entitySection}</>}
      {!loading && total === 0 && <div className="no-results search-no-results"><Icon name="search" size={28} /><strong>没有找到匹配内容</strong><span>可以尝试中文、英文、拼音或拼音首字母</span></div>}
    </div>
  </section>;
}

function MediaListPanel({ items, total, loading, search, groups, countries, selectedGroup, setSelectedGroup, eventTypes, selectedEventType, setSelectedEventType, grouped, setGrouped, headerAlignment, voiceTextPreference, selectedId, onSelect, playingId, sort, setSort, layout, setLayout, onLoadMore, scrollKey, scrollResetRevision, catalogFocus, onCatalogFocusComplete }: {
  items: MediaItem[];
  total: number;
  loading: boolean;
  search: CatalogSearchBarProps;
  groups: Array<{ group: string; count: number }>;
  countries: CountryFacet[];
  selectedGroup: string;
  setSelectedGroup: (value: string) => void;
  eventTypes: Array<{ event_type: string; count: number }>;
  selectedEventType: string;
  setSelectedEventType: (value: string) => void;
  grouped: boolean;
  setGrouped: (value: boolean) => void;
  headerAlignment: MediaHeaderAlignment;
  voiceTextPreference: VoiceTextPreference;
  selectedId: string;
  onSelect: (id: string) => void;
  playingId: string;
  sort: MediaSort;
  setSort: (sort: MediaSort) => void;
  layout: LayoutMode;
  setLayout: (layout: LayoutMode) => void;
  onLoadMore: () => Promise<void>;
  scrollKey: string;
  scrollResetRevision: number;
  catalogFocus: CatalogListFocus | null;
  onCatalogFocusComplete: (sequence: number) => void;
}) {
  const listScroll = useRememberedScroll(scrollKey, items.length, scrollResetRevision);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const sections = useMemo(() => {
    const countryNames = new Map<string, { label: string; order: number }>(
      countries.map((country, order) => [
        country.id,
        { label: country.display_name, order },
      ] as const),
    );
    const groupedItems = new Map<string, { label: string; subtitle: string; countryOrder: number; items: MediaItem[] }>();
    for (const item of items) {
      const identity = mediaSectionIdentity(item, selectedGroup, countryNames);
      const section: { label: string; subtitle: string; countryOrder: number; items: MediaItem[] } = groupedItems.get(identity.key) || {
        label: identity.label,
        subtitle: identity.subtitle,
        countryOrder: identity.countryOrder ?? Number.MAX_SAFE_INTEGER,
        items: [],
      };
      section.items.push(item);
      groupedItems.set(identity.key, section);
    }
    const result = [...groupedItems.entries()].map(([key, section]) => ({ key, ...section }));
    return ["multiplayer_voice", "taunt_voice"].includes(selectedGroup)
      ? result.sort((left, right) => left.countryOrder - right.countryOrder || left.label.localeCompare(right.label))
      : result;
  }, [countries, items, selectedGroup]);
  const allSectionsExpanded = sections.every((section) => !collapsedSections.has(section.key));

  useEffect(() => {
    const available = new Set(sections.map((section) => section.key));
    setCollapsedSections((current) => {
      const next = new Set([...current].filter((key) => available.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [sections]);

  useEffect(() => {
    if (
      catalogFocus?.target !== "media"
      || !items.some((item) => item.asset.id === catalogFocus.itemId)
    ) return;
    const section = grouped
      ? sections.find((item) => item.items.some(
        (media) => media.asset.id === catalogFocus.itemId,
      ))
      : undefined;
    if (section && collapsedSections.has(section.key)) {
      setCollapsedSections((current) => {
        const next = new Set(current);
        next.delete(section.key);
        return next;
      });
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = listScroll.ref.current?.querySelector<HTMLButtonElement>(
          `[data-catalog-item-id="${CSS.escape(catalogFocus.itemId)}"]`,
        );
        if (!target) return;
        target.scrollIntoView({ block: "center", inline: "center" });
        target.focus({ preventScroll: true });
        onCatalogFocusComplete(catalogFocus.sequence);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [catalogFocus, collapsedSections, grouped, items, onCatalogFocusComplete, sections]);

  function toggleSection(key: string) {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllSections() {
    setCollapsedSections(allSectionsExpanded
      ? new Set(sections.map((section) => section.key))
      : new Set());
  }

  function renderMediaItem(item: MediaItem) {
    const textCount = uniqueAudioTexts(item.texts).length;
    const primaryText = mediaPrimaryText(item, voiceTextPreference);
    const secondaryText = mediaSecondaryText(item, voiceTextPreference);
    if (layout === "list") {
      return <button key={item.asset.id} data-catalog-item-id={item.asset.id} className={`asset-row media-row ${selectedId === item.asset.id ? "selected" : ""} ${playingId === item.asset.id ? "playing" : ""}`} onPointerEnter={() => void preloadAudioResource(api.mediaUrl(item.asset.id), "foreground")} onFocus={() => void preloadAudioResource(api.mediaUrl(item.asset.id), "foreground")} onClick={() => onSelect(item.asset.id)}>
        <span className="file-icon format-audio"><Icon name={playingId === item.asset.id ? "pause" : "play"} /></span>
        <span className="asset-main"><strong>{primaryText}</strong>{(secondaryText || textCount > 1) && <small>{secondaryText}{textCount > 1 ? `${secondaryText ? " · " : ""}${textCount} 条文本` : ""}</small>}</span>
        <span className="media-links">{item.entities.slice(0, 2).map((entity) => entity.display_name).join(" · ") || item.slots.slice(0, 2).map(mediaSlotLabel).join(" · ") || "未关联"}</span>
        <Icon name="chevron" size={15} />
      </button>;
    }
    return <button key={item.asset.id} data-catalog-item-id={item.asset.id} className={`asset-card media-card ${selectedId === item.asset.id ? "selected" : ""} ${playingId === item.asset.id ? "playing" : ""}`} onPointerEnter={() => void preloadAudioResource(api.mediaUrl(item.asset.id), "foreground")} onFocus={() => void preloadAudioResource(api.mediaUrl(item.asset.id), "foreground")} onClick={() => onSelect(item.asset.id)}>
      <span className="asset-card-copy"><strong title={primaryText}>{primaryText}</strong>{secondaryText && <small title={secondaryText}>{secondaryText}</small>}<em>{item.slots.slice(0, 2).map(mediaSlotLabel).join(" · ") || "未分类"}</em></span>
    </button>;
  }

  return (
    <section className="asset-panel media-panel panel">
      <div className="asset-toolbar">
        <CatalogSearchBar {...search} />
        <LayoutToggle layout={layout} onChange={setLayout} />
      </div>
      <div className="filter-strip media-filter-strip">
        <div className="media-filter-groups">
          <div className="tag-filter" role="group" aria-label="按声音用途筛选">
            <button className={!selectedGroup ? "active" : ""} onClick={() => setSelectedGroup("")}>全部用途</button>
            {groups.map((group) => <button key={group.group} className={selectedGroup === group.group ? "active" : ""} onClick={() => setSelectedGroup(selectedGroup === group.group ? "" : group.group)}>{mediaGroupLabels[group.group] || group.group}<em>{group.count}</em></button>)}
          </div>
          {eventTypes.length > 0 && <div className="tag-filter event-type-filter" role="group" aria-label="按事件类型筛选">
            <button className={!selectedEventType ? "active" : ""} onClick={() => setSelectedEventType("")}>全部事件</button>
            {eventTypes.map((eventType) => <button key={eventType.event_type} className={selectedEventType === eventType.event_type ? "active" : ""} onClick={() => setSelectedEventType(selectedEventType === eventType.event_type ? "" : eventType.event_type)}>{mediaSlotLabel(eventType.event_type)}<em>{eventType.count}</em></button>)}
          </div>}
        </div>
        <div className="media-filter-actions">
          <span className="result-count">显示 {items.length} / {total}</span>
          <label className="group-toggle"><input type="checkbox" checked={grouped} onChange={(event) => setGrouped(event.target.checked)} /><span>分组</span></label>
          {grouped && sections.length > 0 && <button type="button" className="group-collapse-toggle" aria-expanded={allSectionsExpanded} onClick={toggleAllSections}><Icon name="chevron" size={14} /><span>{allSectionsExpanded ? "全部收起" : "全部展开"}</span></button>}
          <label className="sort-control"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as MediaSort)}><option value="name_asc">文件名 A–Z</option><option value="name_desc">文件名 Z–A</option><option value="description_asc">说明 A–Z</option></select></label>
        </div>
      </div>
      <div ref={listScroll.ref} className={`asset-list ${grouped ? `media-grouped-list media-header-align-${headerAlignment}` : layout === "grid" ? "asset-grid media-grid" : "list-columns"}`} tabIndex={0} aria-label="声音列表" onScroll={(event) => { listScroll.remember(event); const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) void onLoadMore(); }}>
        {grouped
          ? sections.map((section, index) => {
            const expanded = !collapsedSections.has(section.key);
            const contentId = `media-group-${index}`;
            return <section className={`media-group-section ${expanded ? "expanded" : "collapsed"}`} key={section.key}>
              <button type="button" className="media-group-header" aria-expanded={expanded} aria-controls={contentId} onClick={() => toggleSection(section.key)}>
                <span className="media-group-heading"><strong title={section.label}>{section.label}</strong><em>{section.items.length}</em>{section.subtitle && <small>{section.subtitle}</small>}</span>
                <Icon name="chevron" size={15} />
              </button>
              {expanded && <div id={contentId} className={layout === "grid" ? "asset-grid media-grid media-group-items" : "list-columns media-group-items"}>{section.items.map(renderMediaItem)}</div>}
            </section>;
          })
          : items.map(renderMediaItem)}
        {items.length < total && <button className="load-more" disabled={loading} onClick={() => void onLoadMore()}>{loading ? "正在载入…" : `载入更多（剩余 ${(total - items.length).toLocaleString("zh-CN")}）`}</button>}
        {loading && items.length === 0 && <div className="entity-loading"><div className="radar small"><span /></div><strong>正在建立声音关联…</strong></div>}
        {!loading && items.length === 0 && <div className="no-results"><Icon name="search" size={28} /><strong>没有匹配的声音</strong><button onClick={() => { setSelectedGroup(""); setSelectedEventType(""); }}>清除筛选</button></div>}
      </div>
    </section>
  );
}

function catalogSearchTokens(query: string) {
  const tokens: string[] = [];
  let current = "";
  let currentKind: "han" | "other" | "" = "";
  for (const character of query.trim().toLocaleLowerCase()) {
    if (!/[\p{L}\p{N}]/u.test(character)) {
      if (current) tokens.push(current);
      current = "";
      currentKind = "";
      continue;
    }
    const kind = /\p{Script=Han}/u.test(character) ? "han" : "other";
    if (current && kind !== currentKind) tokens.push(current);
    current = kind === currentKind ? `${current}${character}` : character;
    currentKind = kind;
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalizeCatalogSearchText(value: string) {
  return value.toLocaleLowerCase().replaceAll("砲", "炮");
}

function boundedSuggestionMatch(needle: string, haystack: string) {
  if (needle.length < (/\p{Script=Han}/u.test(needle) ? 2 : 4)) return false;
  let first = haystack.indexOf(needle[0]);
  while (first >= 0) {
    let cursor = first;
    let matched = true;
    for (const character of [...needle].slice(1)) {
      cursor = haystack.indexOf(character, cursor + 1);
      if (cursor < 0) {
        matched = false;
        break;
      }
    }
    if (matched && cursor - first + 1 <= Math.max(needle.length * 2, needle.length + 2)) return true;
    first = haystack.indexOf(needle[0], first + 1);
  }
  return false;
}

function singleSuggestionEditOrTransposition(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const differences = [...left].map((character, index) => character === right[index] ? -1 : index)
      .filter((index) => index >= 0);
    if (differences.length <= 1) return true;
    return differences.length === 2
      && differences[1] === differences[0] + 1
      && left[differences[0]] === right[differences[1]]
      && left[differences[1]] === right[differences[0]];
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  let mismatch = 0;
  let shortIndex = 0;
  for (const character of longer) {
    if (shortIndex < shorter.length && shorter[shortIndex] === character) {
      shortIndex += 1;
      continue;
    }
    mismatch += 1;
    if (mismatch > 1) return false;
  }
  return true;
}

function nearbySuggestionEdit(needle: string, haystack: string) {
  if (needle.length < (/\p{Script=Han}/u.test(needle) ? 3 : 5)) return false;
  for (let width = Math.max(1, needle.length - 1); width <= needle.length + 1; width += 1) {
    for (let start = 0; start + width <= haystack.length; start += 1) {
      if (singleSuggestionEditOrTransposition(needle, haystack.slice(start, start + width))) {
        return true;
      }
    }
  }
  return false;
}

function catalogSuggestionScore(query: string, primaryValues: string[], aliasValues: string[] = []) {
  const raw = normalizeCatalogSearchText(query.trim());
  const tokens = catalogSearchTokens(raw);
  if (!tokens.length) return Number.POSITIVE_INFINITY;
  const primary = primaryValues.map(normalizeCatalogSearchText);
  const aliases = aliasValues.map(normalizeCatalogSearchText);
  if (primary.some((value) => value === raw)) return 0;
  let score = 0;
  for (const token of tokens) {
    const compact = [...token].filter((character) => /[\p{L}\p{N}]/u.test(character)).join("");
    const normalizedPrimary = primary.map((value) => [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).join(""));
    const normalizedAliases = aliases.map((value) => [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).join(""));
    const primaryPrefixCount = primary.filter((value) => value.startsWith(token)).length;
    const termScore = primary.some((value) => value === token) ? 0
      : primaryPrefixCount > 0 ? 1 - Math.min(0.3, (primaryPrefixCount - 1) * 0.1)
      : normalizedAliases.some((value) => value.startsWith(compact)) ? 2
        : primary.some((value) => value.includes(token)) ? 3
          : normalizedAliases.some((value) => value.includes(compact)) ? 4
            : [...normalizedPrimary, ...normalizedAliases].some((value) => (
              value.length <= Math.max(64, compact.length * 8)
              && (boundedSuggestionMatch(compact, value) || nearbySuggestionEdit(compact, value))
            )) ? 5 : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(termScore)) return termScore;
    score += termScore;
  }
  return score;
}

function entitySuggestionScore(entity: EntitySummary, query: string) {
  return catalogSuggestionScore(
    query,
    [entity.display_name, entity.internal_name, entity.id, entity.image, entity.ui_name || ""],
    [entity.search_aliases?.pinyin_compact || "", entity.search_aliases?.pinyin_initials || ""],
  );
}

function mediaSuggestionScore(item: MediaItem, query: string) {
  return catalogSuggestionScore(
    query,
    [
      item.asset.display_name,
      item.description || "",
      ...item.texts,
      ...item.original_texts,
      ...item.localized_texts,
      ...(item.translated_texts || []),
      ...item.events,
      ...item.slots,
      ...(item.mission ? [missionLabel(item.mission)] : []),
      ...item.entities.flatMap((entity) => [entity.id, entity.display_name, entity.affiliation?.display_name || ""]),
    ],
    [...(item.search_aliases?.pinyin_compact || []), ...(item.search_aliases?.pinyin_initials || [])],
  );
}

function EntityListPanel({ entities, total, loading, search, sort, setSort, buildableFirst, setBuildableFirst, selectedId, setSelectedId, sourceId, sourceRevision, sides, selectedSide, setSelectedSide, layout, setLayout, previewAngle, scrollKey, scrollResetRevision, catalogFocus, onCatalogFocusComplete }: {
  entities: EntitySummary[];
  total: number;
  loading: boolean;
  search: CatalogSearchBarProps;
  sort: EntitySort;
  setSort: (value: EntitySort) => void;
  buildableFirst: boolean;
  setBuildableFirst: (value: boolean) => void;
  selectedId: string;
  setSelectedId: (id: string) => void;
  sourceId: string;
  sourceRevision: string;
  sides: Array<{ id: string; count: number }>;
  selectedSide: string;
  setSelectedSide: (value: string) => void;
  layout: LayoutMode;
  setLayout: (layout: LayoutMode) => void;
  previewAngle: PreviewAngle;
  scrollKey: string;
  scrollResetRevision: number;
  catalogFocus: CatalogListFocus | null;
  onCatalogFocusComplete: (sequence: number) => void;
}) {
  const listScroll = useRememberedScroll(scrollKey, entities.length, scrollResetRevision);
  useEffect(() => {
    if (
      catalogFocus?.target !== "entities"
      || !entities.some((entity) => entity.id === catalogFocus.itemId)
    ) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = listScroll.ref.current?.querySelector<HTMLButtonElement>(
          `[data-catalog-item-id="${CSS.escape(catalogFocus.itemId)}"]`,
        );
        if (!target) return;
        target.scrollIntoView({ block: "center", inline: "center" });
        target.focus({ preventScroll: true });
        onCatalogFocusComplete(catalogFocus.sequence);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [catalogFocus, entities, layout, onCatalogFocusComplete]);
  return (
    <section className="asset-panel entity-panel panel">
      <div className="asset-toolbar">
        <CatalogSearchBar {...search} />
        <LayoutToggle layout={layout} onChange={setLayout} />
      </div>
      <div className="filter-strip">
        <div className="tag-filter entity-browse-filter" role="group" aria-label="按阵营筛选当前列表">
          {sides.map((side) => <button key={side.id} className={selectedSide === side.id ? "active" : ""} onClick={() => setSelectedSide(selectedSide === side.id ? "" : side.id)}>{sideLabels[side.id] || side.id}<em>{side.count}</em></button>)}
        </div>
        <div className="media-filter-actions entity-filter-actions">
          <span className="result-count">显示 {entities.length} / {total}</span>
          <label className="group-toggle"><input type="checkbox" checked={buildableFirst} onChange={(event) => setBuildableFirst(event.target.checked)} /><span>可建造优先</span></label>
          <label className="sort-control"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as EntitySort)}>
            <option value="cameo">游戏建造栏</option>
            <option value="faction">阵营</option>
            <option value="name_asc">名称 A–Z</option>
            <option value="name_desc">名称 Z–A</option>
            <option value="cost_asc">造价从低到高</option>
            <option value="cost_desc">造价从高到低</option>
            <option value="strength_asc">生命值从低到高</option>
            <option value="strength_desc">生命值从高到低</option>
          </select></label>
        </div>
      </div>
      <div ref={listScroll.ref} onScroll={listScroll.remember} className={`asset-list ${layout === "grid" ? "asset-grid entity-grid" : "list-columns"}`} tabIndex={0} aria-label="单位列表">
        {layout === "list" ? entities.map((entity) => (
          <button key={entity.id} data-catalog-item-id={entity.id} className={`asset-row entity-row ${selectedId === entity.id ? "selected" : ""}`} onClick={() => setSelectedId(entity.id)}>
            <span className={`file-icon entity-icon ${entity.renderable ? "ready" : "missing"}`}><Icon name="unit" /></span>
            <span className="asset-main"><strong>{entity.display_name}</strong><small>{entity.id}{entity.body_status !== "not_defined" ? ` → ${entity.image}` : ""}{entity.internal_name !== entity.display_name ? ` · ${entity.internal_name}` : ""}</small></span>
            <span className="entity-kind">{entityUsageLabel(entity.kind, entity.usage)}</span>
            <span className="entity-stats"><strong>{entity.cost ? `$${entity.cost}` : "—"}</strong><small>{entity.strength ? `${entity.strength} HP` : entity.renderable ? `${entity.component_count} 个组件` : entityBodyStatusLabel(entity)}</small></span>
            <Icon name="chevron" size={15} />
          </button>
        )) : entities.map((entity) => <EntityGridCard key={entity.id} entity={entity} sourceId={sourceId} sourceRevision={sourceRevision} previewAngle={previewAngle} selected={selectedId === entity.id} onSelect={setSelectedId} />)}
        {loading && entities.length === 0 && <div className="entity-loading"><div className="radar small"><span /></div><strong>正在解析规则实体…</strong></div>}
        {!loading && entities.length === 0 && <div className="no-results"><Icon name="search" size={28} /><strong>没有匹配的单位</strong><button onClick={() => {
          setSelectedSide("");
        }}>清除筛选</button></div>}
      </div>
    </section>
  );
}

function EntityGridCard({ entity, sourceId, sourceRevision, previewAngle, selected, onSelect }: { entity: EntitySummary; sourceId: string; sourceRevision: string; previewAngle: PreviewAngle; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button data-catalog-item-id={entity.id} className={`asset-card entity-card ${selected ? "selected" : ""}`} onClick={() => onSelect(entity.id)}>
      <EntityCardPreview entity={entity} sourceId={sourceId} sourceRevision={sourceRevision} previewAngle={previewAngle} />
      <span className="asset-card-copy"><strong title={entity.display_name}>{entity.display_name}</strong></span>
    </button>
  );
}

function entityCardPlayerColor(entity: EntitySummary) {
  const side = entityAffiliationSide(entity);
  return side === "GDI" ? "blue"
    : side === "Nod" ? "red"
      : side === "ThirdSide" ? "purple" : "";
}

function entityAffiliationSide(entity: EntitySummary) {
  return entity.sides.length === 1
    ? entity.sides[0]
    : entity.sides.length === 0 && entity.affiliation?.kind === "side"
      ? entity.affiliation.id : "";
}

function entityCardPreviewUrl(entity: EntitySummary, sourceId: string, previewAngle: PreviewAngle, sourceRevision: string, compact = false) {
  const staticFacing = entity.body_format !== "vxl" && entity.facing_format
    ? entityFacingForPreviewAngle(entity.facing_format, previewAngle)
    : 0;
  const facing = isStaticSnapshot
    ? staticFacing
    : entityFacingForPreviewAngle(entity.facing_format, previewAngle);
  return api.entityPreviewUrl(sourceId, entity.id, {
    facing,
    scale: 2,
    thumbnail: true,
    compact,
    playerColor: entityCardPlayerColor(entity),
    revision: sourceRevision,
  });
}

const thumbnailAtlasStatus = new Map<string, "loaded" | "failed">();
const pendingThumbnailAtlases = new Map<string, Promise<boolean>>();

function preloadThumbnailAtlas(url: string) {
  const known = thumbnailAtlasStatus.get(url);
  if (known) return Promise.resolve(known === "loaded");
  const existing = pendingThumbnailAtlases.get(url);
  if (existing) return existing;
  const pending = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      thumbnailAtlasStatus.set(url, "loaded");
      pendingThumbnailAtlases.delete(url);
      resolve(true);
    };
    image.onerror = () => {
      thumbnailAtlasStatus.set(url, "failed");
      pendingThumbnailAtlases.delete(url);
      resolve(false);
    };
    image.src = url;
  });
  pendingThumbnailAtlases.set(url, pending);
  return pending;
}

function useThumbnailAtlasUrl(primaryUrl: string, fallbackUrl: string) {
  const [resolvedUrl, setResolvedUrl] = useState(() => (
    thumbnailAtlasStatus.get(primaryUrl) === "failed" ? fallbackUrl : primaryUrl
  ));
  useEffect(() => {
    let disposed = false;
    if (!primaryUrl || primaryUrl === fallbackUrl) {
      setResolvedUrl(primaryUrl);
      return () => { disposed = true; };
    }
    if (thumbnailAtlasStatus.get(primaryUrl) === "failed") {
      setResolvedUrl(fallbackUrl);
      return () => { disposed = true; };
    }
    setResolvedUrl(primaryUrl);
    void preloadThumbnailAtlas(primaryUrl).then((loaded) => {
      if (!disposed && !loaded) setResolvedUrl(fallbackUrl);
    });
    return () => { disposed = true; };
  }, [fallbackUrl, primaryUrl]);
  return resolvedUrl;
}

function EntityCardPreview({ entity, sourceId, sourceRevision, previewAngle, compact = false }: { entity: EntitySummary; sourceId: string; sourceRevision: string; previewAngle: PreviewAngle; compact?: boolean }) {
  const previewRef = useRef<HTMLSpanElement>(null);
  const affiliationSide = entityAffiliationSide(entity);
  const searchAtlas = compact && isStaticSnapshot ? entity.search_thumbnail_atlas : undefined;
  const atlas = searchAtlas ?? (isStaticSnapshot ? entity.thumbnail_atlas : undefined);
  const requestedFacing = entity.facing_format
    ? entityFacingForPreviewAngle(entity.facing_format, previewAngle)
    : 0;
  const atlasFacing = atlas
    ? Math.min(
      Math.max(0, searchAtlas ? previewAngle : requestedFacing),
      Math.max(0, atlas.facing_count - 1),
    )
    : 0;
  const atlasUrl = atlas ? api.entityThumbnailAtlasUrl(atlas.path, atlasFacing) : "";
  const atlasFallbackUrl = atlas ? api.entityThumbnailAtlasFallbackUrl(atlas.path, atlasFacing) : "";
  const readyAtlasUrl = useThumbnailAtlasUrl(atlasUrl, atlasFallbackUrl);
  const atlasColumn = atlas ? atlas.index % atlas.columns : 0;
  const atlasRow = atlas ? Math.floor(atlas.index / atlas.columns) : 0;
  const atlasContentBounds = compact && atlas && !searchAtlas
    ? atlas.content_bounds?.[atlasFacing]
    : undefined;
  const atlasContentWidth = atlasContentBounds?.width ?? atlas?.cell_width ?? 1;
  const atlasContentHeight = atlasContentBounds?.height ?? atlas?.cell_height ?? 1;
  const atlasScale = compact && atlas && !searchAtlas
    ? Math.min(34 / atlasContentWidth, 34 / atlasContentHeight)
    : 1;
  const url = entity.renderable && !atlas
    ? entityCardPreviewUrl(entity, sourceId, previewAngle, sourceRevision, compact)
    : "";
  const [readyUrl, setReadyUrl] = useState(() => hasLoadedCardPreview(url) ? url : "");

  useEffect(() => {
    if (!url) {
      setReadyUrl("");
      return;
    }
    if (hasLoadedCardPreview(url)) {
      setReadyUrl(url);
      return;
    }
    let disposed = false;
    let observer: IntersectionObserver | null = null;
    const request = () => {
      if (disposed) return;
      void preloadCardPreview(url, "foreground").then((loaded) => {
        if (!disposed && loaded) setReadyUrl(url);
      });
    };
    if ("IntersectionObserver" in window && previewRef.current) {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        request();
      }, { rootMargin: "160px 0px" });
      observer.observe(previewRef.current);
    } else {
      request();
    }
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [url]);

  return <span ref={previewRef} className={`asset-card-preview entity-card-preview format-${entity.body_format || "unknown"} ${entity.renderable ? "ready" : "missing"} ${compact ? "catalog-suggestion-thumbnail" : ""}`}>
    {entity.renderable
      ? atlas
        ? <span className={`entity-thumbnail-atlas ${searchAtlas ? "entity-search-thumbnail-atlas" : compact ? "legacy-search-thumbnail-atlas" : ""}`} aria-hidden="true" style={{
          width: atlasContentWidth,
          height: atlasContentHeight,
          backgroundImage: `url("${readyAtlasUrl}")`,
          backgroundPosition: `${-(atlasColumn * atlas.cell_width + (atlasContentBounds?.x ?? 0))}px ${-(atlasRow * atlas.cell_height + (atlasContentBounds?.y ?? 0))}px`,
          transform: compact && !searchAtlas
            ? `translate(-50%, -50%) scale(${atlasScale})`
            : undefined,
        }} />
        : readyUrl && <img decoding="async" fetchPriority="low" src={readyUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />
      : <Icon name="unit" size={34} />}
    {!compact && entity.affiliation && <span className={`entity-affiliation-badge affiliation-${entity.affiliation.kind} affiliation-${affiliationClassId(entity.affiliation.id)} ${affiliationSide ? `affiliation-${affiliationClassId(affiliationSide)}` : ""}`} title={entity.affiliation.display_name}>
      {entity.affiliation.display_name}
    </span>}
  </span>;
}

function FrameGrid({ count, active, onSelect, urlFor, scrollKey }: { count: number; active: number; onSelect: (frame: number) => void; urlFor: (frame: number) => string; scrollKey: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [scrollKey]);
  return <div ref={scrollRef} className="frame-grid" aria-label="全部动画帧">{Array.from({ length: count }, (_, index) => <button type="button" key={index} className={active === index ? "active" : ""} onClick={() => onSelect(index)}><DeferredPreviewImage src={urlFor(index)} alt={`第 ${index + 1} 帧`} /><span>{index + 1}</span></button>)}</div>;
}

function FrameTransport({ frame, count, playing, onPlayingChange, onFrameChange, label = "动画帧", playDisabled = false }: {
  frame: number;
  count: number;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onFrameChange: (frame: number) => void;
  label?: string;
  playDisabled?: boolean;
}) {
  const activeFrame = Math.min(Math.max(0, frame), Math.max(0, count - 1));
  function selectFrame(nextFrame: number) {
    onPlayingChange(false);
    onFrameChange(Math.min(Math.max(0, nextFrame), Math.max(0, count - 1)));
  }
  return <>
    <button type="button" className="play-button" disabled={playDisabled} onClick={() => onPlayingChange(!playing)} aria-label={playing ? "暂停" : "播放"}><Icon name={playing ? "pause" : "play"} size={16} /></button>
    <button type="button" className="frame-step-button previous" disabled={activeFrame <= 0} onClick={() => selectFrame(activeFrame - 1)} aria-label={`上一${label}`} title={`上一${label}`}>‹</button>
    <button type="button" className="frame-step-button next" disabled={activeFrame >= count - 1} onClick={() => selectFrame(activeFrame + 1)} aria-label={`下一${label}`} title={`下一${label}`}>›</button>
    <input type="range" min="0" max={Math.max(0, count - 1)} value={activeFrame} onChange={(event) => selectFrame(Number(event.target.value))} aria-label={`当前${label}`} />
    <span>{String(activeFrame + 1).padStart(2, "0")} <i>/</i> {String(count).padStart(2, "0")}</span>
  </>;
}

type ImageFetchPriority = "high" | "low" | "auto";

const decodedImageFrames = new Map<string, HTMLImageElement>();
const pendingImageFrames = new Map<string, { image: HTMLImageElement; promise: Promise<HTMLImageElement> }>();
const decodedImageFrameLimit = 48;

function preloadDecodedImageFrame(src: string, priority: ImageFetchPriority = "auto") {
  const decoded = decodedImageFrames.get(src);
  if (decoded) {
    decodedImageFrames.delete(src);
    decodedImageFrames.set(src, decoded);
    return Promise.resolve(decoded);
  }
  const pending = pendingImageFrames.get(src);
  if (pending) {
    if (priority === "high") pending.image.fetchPriority = "high";
    return pending.promise;
  }
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = priority;
  const promise = new Promise<HTMLImageElement>((resolve) => {
    const fallbackSrc = api.snapshotFallbackUrl(src);
    let fallbackAttempted = false;
    const finish = (cache = true) => {
      pendingImageFrames.delete(src);
      if (cache) {
        decodedImageFrames.set(src, image);
        while (decodedImageFrames.size > decodedImageFrameLimit) {
          const oldest = decodedImageFrames.keys().next().value;
          if (oldest === undefined) break;
          decodedImageFrames.delete(oldest);
        }
      }
      resolve(image);
    };
    image.onload = () => {
      if (typeof image.decode === "function") void image.decode().catch(() => undefined).then(() => finish());
      else finish();
    };
    image.onerror = () => {
      if (!fallbackAttempted && fallbackSrc !== src) {
        fallbackAttempted = true;
        image.src = fallbackSrc;
        return;
      }
      finish(false);
    };
  });
  pendingImageFrames.set(src, { image, promise });
  image.src = src;
  return promise;
}

function scheduleDecodedImageFrames(srcs: string[], delayMs: number, onReady: () => void) {
  let cancelled = false;
  let delayElapsed = false;
  let imagesDecoded = false;
  const finish = () => {
    if (!cancelled && delayElapsed && imagesDecoded) onReady();
  };
  const timer = window.setTimeout(() => {
    delayElapsed = true;
    finish();
  }, delayMs);
  const uniqueSources = [...new Set(srcs.filter(Boolean))];
  void Promise.all(uniqueSources.map((src) => preloadDecodedImageFrame(src, "high"))).then(() => {
    imagesDecoded = true;
    finish();
  });
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

function scheduleDecodedImageFrame(src: string, delayMs: number, onReady: () => void) {
  return scheduleDecodedImageFrames([src], delayMs, onReady);
}

function DeferredPreviewImage({ src, alt = "" }: { src: string; alt?: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [readySrc, setReadySrc] = useState("");
  useEffect(() => {
    setReadySrc("");
    const target = imageRef.current;
    if (!target || !src) return;
    let cancelled = false;
    const request = () => {
      void preloadDecodedImageFrame(src, "low").then((image) => {
        if (!cancelled && image.naturalWidth) setReadySrc(image.currentSrc || image.src || src);
      });
    };
    if (!("IntersectionObserver" in window)) {
      request();
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      request();
    }, { rootMargin: "64px 0px" });
    observer.observe(target);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [src]);
  return <img ref={imageRef} src={readySrc || undefined} alt={alt} decoding="async" fetchPriority="low" />;
}

function animationSourceFramesFromTotal(sample: MediaSample | undefined, totalFrames: number, facing: number) {
  const total = Math.max(0, totalFrames);
  const playback = sample?.animation;
  if (!playback) return Array.from({ length: Math.max(1, total) }, (_, index) => index);
  const contentTotal = playback.shadow ? Math.floor(total / 2) : total;
  const start = playback.start_frame + (playback.facing_step > 0 ? facing * playback.facing_step : 0);
  const count = playback.frame_count ?? Math.max(1, contentTotal - start);
  const frameStep = Math.max(1, playback.frame_step || 1);
  const frames = Array.from({ length: Math.max(1, count) }, (_, index) => start + index * frameStep)
    .filter((frame) => contentTotal === 0 || frame < contentTotal);
  const available = frames.length > 0
    ? frames
    : [Math.min(Math.max(0, start), Math.max(0, contentTotal - 1))];
  return playback.reverse ? [...available].reverse() : available;
}

function animationSourceFrames(sample: MediaSample | undefined, metadata: AssetMetadata | null, facing: number) {
  return animationSourceFramesFromTotal(sample, metadata?.frame_count || 0, facing);
}

function animationShadowFrame(sample: MediaSample | undefined, metadata: AssetMetadata | null, sourceFrame: number) {
  const paired = metadata?.frames?.[sourceFrame]?.paired_shadow_frame;
  if (paired !== null && paired !== undefined) return paired;
  if (!sample?.animation?.shadow || !metadata?.frame_count) return undefined;
  const candidate = sourceFrame + Math.floor(metadata.frame_count / 2);
  return candidate < metadata.frame_count ? candidate : undefined;
}

function effectBodySequence(associations: MediaAssociation[], slot: string) {
  const bodySequences = associations.filter(
    (association) => association.kind === "animation" && association.slot === "body_sequence",
  );
  if (bodySequences.length === 0) return null;
  const preferredEvents = slot.includes("secondary")
    ? ["deployedfire", "fireprone", "fireup", "fire", "attack"]
    : ["fireup", "fire", "deployedfire", "fireprone", "attack"];
  for (const event of preferredEvents) {
    const match = bodySequences.find((association) => association.event.toLowerCase() === event);
    if (match) return match;
  }
  return bodySequences.find((association) => association.event.toLowerCase().includes("fire")) || null;
}

function preferredBodySequence(associations: MediaAssociation[]) {
  const bodySequences = associations.filter(
    (association) => association.kind === "animation" && association.slot === "body_sequence",
  );
  const preferredEvents = ["ready", "guard", "deployed", "hover", "fly", "walk"];
  return preferredEvents
    .map((event) => bodySequences.find((association) => association.event.toLowerCase() === event))
    .find((association): association is MediaAssociation => Boolean(association))
    || bodySequences[0]
    || null;
}

function defaultBuildingOperationSamples(
  associations: MediaAssociation[],
  facing: number,
  activeAnimation: ActiveEntityAnimation | null = null,
) {
  const seen = new Set<string>();
  const samples: MediaSample[] = [];
  const excludedAssetId = activeAnimation?.sample.asset?.id;
  const excludesSuperFamily = activeAnimation?.slot.toLowerCase().startsWith("superanim") || false;
  for (const association of associations) {
    const slot = association.slot.toLowerCase();
    const persistent = /^(?:active|idle)anim(?:two|three|four)?$/.test(slot)
      || slot === "superanim";
    if (!persistent || (excludesSuperFamily && slot.startsWith("superanim"))) continue;
    for (const sample of animationCardSamples(association, facing)) {
      if (!sample.asset || sample.asset.format !== "shp" || sample.asset.id === excludedAssetId || seen.has(sample.asset.id)) continue;
      seen.add(sample.asset.id);
      samples.push(sample);
    }
  }
  return samples;
}

const animationDirections = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function directionalAnimationSample(samples: MediaSample[], facing: number) {
  const direction = animationDirections[((facing % 8) + 8) % 8];
  return samples.find((sample) => sample.animation?.direction?.toUpperCase() === direction)
    || samples.find((sample) => sample.asset)
    || samples[0];
}

function animationCardSamples(association: MediaAssociation, facing: number) {
  const directional = association.samples.filter((sample) => sample.animation?.direction);
  if (directional.length > 1 && directional.length === association.samples.length) {
    const selected = directionalAnimationSample(association.samples, facing);
    return selected ? [selected] : [];
  }
  if (association.selection) {
    const configured = association.samples.find((sample) => sample.name === association.selected_sample);
    const selected = (configured?.asset ? configured : null)
      || association.samples.find((sample) => sample.asset)
      || configured
      || association.samples[0];
    return selected ? [selected] : [];
  }
  return association.samples;
}

function animationRoleGroup(kind: EntityKind, role: MediaAssociation["role"], slot: string): EntityAnimationGroup {
  if (role === "construction") return kind === "building" ? "construction" : "body";
  if (role === "operation") return kind === "building" ? "operation" : "body";
  if (role === "weapon") return "weapon";
  if (role === "impact") return "impact";
  if (role === "destruction") return "destruction";
  if (role === "debris") return "debris";
  return role === "body" || slot === "body_sequence" ? "body" : "weapon";
}

function animationAssociationGroup(kind: EntityKind, association: MediaAssociation): EntityAnimationGroup {
  return animationRoleGroup(kind, association.role, association.slot);
}

function isPlayableEntityAnimation(kind: EntityKind, association: MediaAssociation) {
  if (association.kind !== "animation") return false;
  if (association.role === "body" || association.slot === "body_sequence") return true;
  return kind === "building" && (association.role === "construction" || association.role === "operation");
}

function entityHasPlayableAnimation(entity: GameEntity) {
  return (entity.kind !== "building" && entity.preview.frame_count > 1)
    || entity.media.some((association) => isPlayableEntityAnimation(entity.kind, association));
}

function animationAssociationCount(association: MediaAssociation) {
  if (association.selection) return 1;
  const directional = association.samples.filter((sample) => sample.animation?.direction);
  return directional.length > 1 && directional.length === association.samples.length
    ? 1
    : association.samples.length;
}

function animationFireFlh(art: Record<string, string>, slot: string) {
  const numbered = /^(?:elite_)?weapon_(\d+)$/.exec(slot);
  if (numbered) {
    const values = (art[`weapon_${numbered[1]}_flh`] || "").split(",").map((value) => Number(value.trim()));
    if (values.length >= 3 && values.every((value) => Number.isFinite(value))) return values.slice(0, 3);
  }
  const secondary = slot.includes("secondary");
  const elite = slot.includes("elite");
  const fields = secondary
    ? [...(elite ? ["elite_secondary_fire_flh"] : []), "secondary_fire_flh", "weapon_2_flh"]
    : [...(elite ? ["elite_primary_fire_flh"] : []), "primary_fire_flh", "weapon_1_flh"];
  for (const field of fields) {
    const values = (art[field] || "").split(",").map((value) => Number(value.trim()));
    if (values.length >= 3 && values.every((value) => Number.isFinite(value))) return values.slice(0, 3);
  }
  return null;
}

function animationEffectAnchor(
  role: MediaAssociation["role"],
  art: Record<string, string>,
  slot: string,
  facing: number,
) {
  if (role === "operation" || role === "destruction" || role === "debris") return { x: 50, y: 50 };
  const radians = (((facing % 8) + 8) % 8) * Math.PI / 4;
  if (role === "impact") {
    return { x: 50 + Math.sin(radians) * 24, y: 54 - Math.cos(radians) * 12 };
  }
  const flh = animationFireFlh(art, slot);
  if (!flh) return { x: 50 + Math.sin(radians) * 12, y: 48 - Math.cos(radians) * 6 };
  const [forward, lateral, height] = flh;
  const projectedX = forward * Math.sin(radians) + lateral * Math.cos(radians);
  const projectedY = -forward * Math.cos(radians) + lateral * Math.sin(radians);
  const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
  return {
    x: clamp(50 + projectedX / 10, 20, 80),
    y: clamp(54 + projectedY / 25 - height / 18, 20, 75),
  };
}

function animationAssociationTitle(association: MediaAssociation) {
  if (association.role === "body" || association.slot === "body_sequence") return animationEventTitle(association.event);
  return `${ruleFieldName(association.rule_field)} · ${association.event}`;
}

function animationAssociationMeta(association: MediaAssociation, sample: MediaSample) {
  const directional = association.samples.length > 1
    && association.samples.every((item) => item.animation?.direction);
  const frameSuffix = directional
    ? ` · ${association.samples.length} 个朝向`
    : sample.animation?.frame_count
      ? ` · ${sample.animation.frame_count} 帧`
      : "";
  const bodyPrefix = association.aliases?.length
    ? `${association.rule_field || "Sequence"} · ${association.aliases.length + 1} 个事件共用`
    : association.rule_field || mediaSlotLabel(association.slot);
  const selectionSuffix = association.selection === "damage"
    ? ` · 伤害值 ${association.selection_value ?? "?"} · ${association.samples.length} 个候选`
    : association.selection === "random"
      ? ` · ${association.rule_field === "WarheadType.AnimList" ? "随机命中特效" : `随机残骸 · 最大 ${association.selection_value ?? "?"}`} · ${association.samples.length} 个候选`
      : association.selection === "first" && association.samples.length > 1
        ? ` · 预览首项 · ${association.samples.length} 个候选`
        : "";
  const prefix = association.role === "body"
    ? bodyPrefix
    : `[${association.source}] · ${mediaSlotLabel(association.slot)} · ${sample.name}`;
  return `${prefix}${frameSuffix}${selectionSuffix}${sample.asset ? "" : " · 未解析"}`;
}

function animationAssociationAliasTitle(association: MediaAssociation) {
  if (!association.aliases?.length) return undefined;
  return `共用帧：${[association.event, ...association.aliases].map(animationEventLabel).join("、")}`;
}

function CompactAudioPlayer({ assetId, label }: {
  assetId: string;
  label: string;
}) {
  const playback = useAudioPlayback();
  const isActive = playback.assetId === assetId && (playback.playing || playback.loading);
  const url = api.mediaUrl(assetId);

  return <span className="compact-audio-player">
    <button type="button" data-audio-asset-id={assetId} onPointerEnter={() => void preloadAudioResource(url, "foreground")} onFocus={() => void preloadAudioResource(url, "foreground")} onClick={() => toggleAudioAsset(assetId, url)} title={isActive ? `暂停 ${label}` : `播放 ${label}`} aria-label={isActive ? `暂停 ${label}` : `播放 ${label}`}><Icon name={isActive ? "pause" : "play"} size={15} /></button>
  </span>;
}

function AudioDownloadAction({ assetId, label }: { assetId: string; label: string }) {
  return <a className="audio-download-action" href={api.contentUrl(assetId)} download={isStaticSnapshot ? `${label}.ogg` : true} title={`下载 ${label}`} aria-label={`下载 ${label}`}><Icon name="download" size={15} /></a>;
}

function StablePreviewImage({ src, alt, style, className, draggable = false, onBeforeReveal, onLoad, onError }: {
  src: string;
  alt: string;
  style?: CSSProperties;
  className?: string;
  draggable?: boolean;
  onBeforeReveal?: (image: HTMLImageElement) => void;
  onLoad?: (image: HTMLImageElement) => void;
  onError?: () => void;
}) {
  const [displayedSrc, setDisplayedSrc] = useState(src);
  const [resolvedRequest, setResolvedRequest] = useState({ source: src, url: src });
  const requestedUrl = resolvedRequest.source === src ? resolvedRequest.url : src;
  const requestedSrc = useRef(requestedUrl);
  const onBeforeRevealRef = useRef(onBeforeReveal);
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  requestedSrc.current = requestedUrl;
  onBeforeRevealRef.current = onBeforeReveal;
  onLoadRef.current = onLoad;
  onErrorRef.current = onError;

  function revealPending(image: HTMLImageElement, pendingSrc: string) {
    const reveal = () => {
      if (requestedSrc.current !== pendingSrc || !image.naturalWidth) {
        if (requestedSrc.current === pendingSrc && !image.naturalWidth) onErrorRef.current?.();
        return;
      }
      onBeforeRevealRef.current?.(image);
      onLoadRef.current?.(image);
      setDisplayedSrc(pendingSrc);
    };
    if (typeof image.decode === "function") void image.decode().catch(() => undefined).then(reveal);
    else reveal();
  }

  function handleImageError(failedSrc: string) {
    const fallbackSrc = api.snapshotFallbackUrl(failedSrc);
    if (fallbackSrc !== failedSrc) {
      setResolvedRequest({ source: src, url: fallbackSrc });
      return;
    }
    onErrorRef.current?.();
  }

  const pendingSrc = requestedUrl && requestedUrl !== displayedSrc ? requestedUrl : "";
  return <>
    {displayedSrc && <img
      key={displayedSrc}
      src={displayedSrc}
      data-requested-src={requestedUrl}
      data-frame-state="active"
      alt={alt}
      className={className}
      draggable={draggable}
      decoding="async"
      fetchPriority="high"
      style={style}
      onLoad={(event) => {
        if (requestedSrc.current === displayedSrc) onLoadRef.current?.(event.currentTarget);
      }}
      onError={() => {
        if (requestedSrc.current === displayedSrc) handleImageError(displayedSrc);
      }}
    />}
    {pendingSrc && <img
      key={pendingSrc}
      src={pendingSrc}
      data-requested-src={requestedUrl}
      data-frame-state="pending"
      alt=""
      aria-hidden="true"
      className={`${className || ""} stable-preview-pending`}
      draggable={false}
      decoding="async"
      fetchPriority="high"
      style={style}
      onLoad={(event) => revealPending(event.currentTarget, pendingSrc)}
      onError={() => {
        if (requestedSrc.current === pendingSrc) handleImageError(pendingSrc);
      }}
    />}
  </>;
}

interface ImageFrameFit {
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
  focusBounds: { x: number; y: number; width: number; height: number };
}

function unionImageBounds(bounds: Array<{ x: number; y: number; width: number; height: number }>) {
  if (bounds.length === 0) return null;
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function shpFrameBounds(frame: NonNullable<AssetMetadata["frames"]>[number]) {
  const content = frame.content_bounds;
  return content && content.width > 0 && content.height > 0
    ? content
    : { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function isVisibleShpFrame(frame: NonNullable<AssetMetadata["frames"]>[number]) {
  return frame.width > 0 && frame.height > 0 && frame.content_bounds !== null;
}

function shpPlaybackFrames(metadata: AssetMetadata | null) {
  if (!metadata?.frames?.length) return Array.from({ length: metadata?.frame_count || 0 }, (_, index) => index);
  const shadowFrames = new Set(metadata.frames
    .map((frame) => frame.paired_shadow_frame)
    .filter((frame): frame is number => frame !== null && frame !== undefined));
  const playbackFrames = metadata.frames
    .filter((frame) => isVisibleShpFrame(frame) && !shadowFrames.has(frame.index))
    .map((frame) => frame.index);
  return playbackFrames.length > 0 ? playbackFrames : metadata.frames.map((frame) => frame.index);
}

function assetPlaybackFrameCount(format: string | undefined, metadata: AssetMetadata | null) {
  return format === "shp" ? Math.max(1, shpPlaybackFrames(metadata).length) : Math.max(1, metadata?.frame_count || 1);
}

function sequenceFrameFit(metadata: AssetMetadata | null, frameIndices: number[], shadowFrameIndices?: number[]): ImageFrameFit | null {
  if (!metadata?.width || !metadata.height || !metadata.frames?.length) return null;
  const mainFrames = [...new Set(frameIndices)]
    .map((index) => metadata.frames?.[index])
    .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame && isVisibleShpFrame(frame)));
  if (mainFrames.length === 0) return null;
  const resolvedShadowIndices = shadowFrameIndices ?? mainFrames
    .map((frame) => frame.paired_shadow_frame)
    .filter((frame): frame is number => frame !== null && frame !== undefined);
  const shadowFrames = [...new Set(resolvedShadowIndices)]
    .map((index) => metadata.frames?.[index])
    .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame && isVisibleShpFrame(frame)));
  const focusBounds = unionImageBounds(mainFrames.map(shpFrameBounds));
  const bounds = unionImageBounds([...mainFrames, ...shadowFrames].map(shpFrameBounds));
  if (!focusBounds || !bounds) return null;
  return {
    width: metadata.width,
    height: metadata.height,
    bounds,
    focusBounds,
  };
}

function combineFrameFits(...fits: Array<ImageFrameFit | null>): ImageFrameFit | null {
  const available = fits.filter((fit): fit is ImageFrameFit => Boolean(fit));
  if (available.length === 0) return null;
  const width = Math.max(...available.map((fit) => fit.width));
  const height = Math.max(...available.map((fit) => fit.height));
  const translated = available.map((fit) => {
    const offsetX = (width - fit.width) / 2;
    const offsetY = (height - fit.height) / 2;
    const translate = (bounds: ImageFrameFit["bounds"]) => ({ ...bounds, x: bounds.x + offsetX, y: bounds.y + offsetY });
    return { bounds: translate(fit.bounds), focusBounds: translate(fit.focusBounds) };
  });
  const bounds = unionImageBounds(translated.map((fit) => fit.bounds));
  const focusBounds = unionImageBounds(translated.map((fit) => fit.focusBounds));
  return bounds && focusBounds ? { width, height, bounds, focusBounds } : null;
}

function ImageViewport({ src, alt, fitKey, fitContent = true, frameFit = null, building = false, className = "", onError }: {
  src: string;
  alt: string;
  fitKey: string;
  fitContent?: boolean;
  frameFit?: ImageFrameFit | null;
  building?: boolean;
  className?: string;
  onError?: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [imageFit, setImageFit] = useState<ImageFrameFit | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const frameFitIdentity = frameFit
    ? `${frameFit.width}:${frameFit.height}:${frameFit.bounds.x}:${frameFit.bounds.y}:${frameFit.bounds.width}:${frameFit.bounds.height}:${frameFit.focusBounds.x}:${frameFit.focusBounds.y}:${frameFit.focusBounds.width}:${frameFit.focusBounds.height}`
    : "";

  function reset() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    reset();
  }, [fitKey, fitContent, frameFitIdentity]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let frame = 0;
    let previousWidth = -1;
    let previousHeight = -1;
    const update = (width: number, height: number) => {
      const nextWidth = Math.round(width);
      const nextHeight = Math.round(height);
      if (nextWidth === previousWidth && nextHeight === previousHeight) return;
      previousWidth = nextWidth;
      previousHeight = nextHeight;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewportSize({ width: nextWidth, height: nextHeight }));
    };
    const bounds = element.getBoundingClientRect();
    update(bounds.width, bounds.height);
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (size) update(size.width, size.height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);

  function measureVisibleContent(image: HTMLImageElement) {
    if (!fitContent) return;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width <= 0 || height <= 0) return;
    if (frameFit) {
      const scaleX = width / frameFit.width;
      const scaleY = height / frameFit.height;
      const nextFit = {
        width,
        height,
        bounds: {
          x: frameFit.bounds.x * scaleX,
          y: frameFit.bounds.y * scaleY,
          width: frameFit.bounds.width * scaleX,
          height: frameFit.bounds.height * scaleY,
        },
        focusBounds: {
          x: frameFit.focusBounds.x * scaleX,
          y: frameFit.focusBounds.y * scaleY,
          width: frameFit.focusBounds.width * scaleX,
          height: frameFit.focusBounds.height * scaleY,
        },
      };
      setImageFit((current) => current
        && current.width === nextFit.width
        && current.height === nextFit.height
        && current.bounds.x === nextFit.bounds.x
        && current.bounds.y === nextFit.bounds.y
        && current.bounds.width === nextFit.bounds.width
        && current.bounds.height === nextFit.bounds.height
        && current.focusBounds.x === nextFit.focusBounds.x
        && current.focusBounds.y === nextFit.focusBounds.y
        && current.focusBounds.width === nextFit.focusBounds.width
        && current.focusBounds.height === nextFit.focusBounds.height
        ? current
        : nextFit);
      return;
    }
    const sampleScale = Math.min(1, 2048 / Math.max(width, height));
    const sampleWidth = Math.max(1, Math.round(width * sampleScale));
    const sampleHeight = Math.max(1, Math.round(height * sampleScale));
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    try {
      const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      let left = sampleWidth;
      let top = sampleHeight;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < sampleHeight; y += 1) {
        for (let x = 0; x < sampleWidth; x += 1) {
          if (pixels[(y * sampleWidth + x) * 4 + 3] <= 4) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      const bounds = right >= left && bottom >= top
        ? {
            x: left / sampleScale,
            y: top / sampleScale,
            width: (right - left + 1) / sampleScale,
            height: (bottom - top + 1) / sampleScale,
          }
        : { x: 0, y: 0, width, height };
      setImageFit({ width, height, bounds, focusBounds: bounds });
    } catch {
      const bounds = { x: 0, y: 0, width, height };
      setImageFit({ width, height, bounds, focusBounds: bounds });
    }
  }

  useEffect(() => {
    if (!fitContent) return;
    const image = viewportRef.current?.querySelector<HTMLImageElement>(".image-viewport-canvas img");
    if (
      image?.complete
      && image.getAttribute("src") === image.dataset.requestedSrc
    ) measureVisibleContent(image);
  }, [fitContent, frameFitIdentity]);

  const fittedImageStyle = useMemo<CSSProperties | undefined>(() => {
    if (!imageFit || viewportSize.width <= 0 || viewportSize.height <= 0) return undefined;
    const padding = Math.max(32, Math.min(viewportSize.width, viewportSize.height) * 0.12);
    const availableWidth = Math.max(1, viewportSize.width - padding * 2);
    const availableHeight = Math.max(1, viewportSize.height - padding * 2);
    const focusCenterX = imageFit.focusBounds.x + imageFit.focusBounds.width / 2;
    const focusCenterY = imageFit.focusBounds.y + imageFit.focusBounds.height / 2;
    const stableWidth = Math.max(1, 2 * Math.max(
      focusCenterX - imageFit.bounds.x,
      imageFit.bounds.x + imageFit.bounds.width - focusCenterX,
    ));
    const stableHeight = Math.max(1, 2 * Math.max(
      focusCenterY - imageFit.bounds.y,
      imageFit.bounds.y + imageFit.bounds.height - focusCenterY,
    ));
    const scale = Math.min(1.75,
      availableWidth / stableWidth,
      availableHeight / stableHeight,
    );
    return {
      width: imageFit.width * scale,
      height: imageFit.height * scale,
      left: viewportSize.width / 2 - focusCenterX * scale,
      top: viewportSize.height / 2 - focusCenterY * scale,
    };
  }, [imageFit, viewportSize]);
  const activeFittedImageStyle = fitContent ? fittedImageStyle : undefined;

  function adjustZoom(delta: number) {
    setZoom((current) => {
      const next = Math.min(6, Math.max(0.25, Math.round((current + delta) * 100) / 100));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }

  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setPan({ x: current.panX + event.clientX - current.x, y: current.panY + event.clientY - current.y });
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  function zoomWithWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    adjustZoom(event.deltaY < 0 ? 0.2 : -0.2);
  }

  return <div
    ref={viewportRef}
    className={`preview-stage image-viewport ${building ? "building-image-viewport" : ""} ${className}`}
    data-fit-mode={frameFit ? "sequence" : fitContent ? "content" : "canvas"}
    onPointerDown={beginPan}
    onPointerMove={movePan}
    onPointerUp={endPan}
    onPointerCancel={endPan}
    onWheel={zoomWithWheel}
    onDoubleClick={reset}
  >
    <div className="preview-rulers horizontal" />
    <div className="preview-rulers vertical" />
    <div className={`image-viewport-canvas ${activeFittedImageStyle ? "content-fitted" : ""}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
      <StablePreviewImage src={src} alt={alt} style={activeFittedImageStyle} onBeforeReveal={fitContent ? measureVisibleContent : undefined} onLoad={fitContent ? measureVisibleContent : undefined} onError={onError} />
    </div>
    <div className="image-viewport-tools" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" onClick={() => adjustZoom(-0.25)} disabled={zoom <= 0.25} aria-label="缩小" title="缩小">−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => adjustZoom(0.25)} disabled={zoom >= 6} aria-label="放大" title="放大">＋</button>
      <button type="button" onClick={reset} disabled={zoom === 1 && pan.x === 0 && pan.y === 0}>适应</button>
    </div>
  </div>;
}

function EntitySoundSample({ sample, voiceTextPreference }: { sample: MediaSample; voiceTextPreference: VoiceTextPreference }) {
  const originalText = sample.original_text
    || (!sample.localized_text && !sample.translated_text ? sample.text : null);
  const preferredText = preferredAudioText(
    sample.localized_text,
    sample.translated_text,
    voiceTextPreference,
  );
  const localizedText = preferredText?.value !== originalText ? preferredText : null;
  const internalName = audioDisplayName(sample.name);
  return <div className="media-sample">
    <strong className="media-sample-id" title={sample.asset?.display_name || sample.name}>{internalName}{sample.weight > 1 && <em>×{sample.weight}</em>}</strong>
    {sample.asset && audioFormats.includes(sample.asset.format)
      ? <CompactAudioPlayer assetId={sample.asset.id} label={internalName} />
      : <em className="media-sample-missing">未解析</em>}
    <span className={`media-sample-texts ${localizedText ? "bilingual" : "single"}`}>
      {originalText && <span className="media-sample-copy" title={originalText}><b>原文</b>{originalText}</span>}
      {localizedText && <span className="media-sample-copy" title={localizedText.value}><b>{localizedText.label}</b>{localizedText.value}</span>}
    </span>
    {sample.asset && audioFormats.includes(sample.asset.format) && <AudioDownloadAction assetId={sample.asset.id} label={internalName} />}
  </div>;
}

interface DisplaySoundAssociation {
  kind: "voice" | "sound";
  event: string;
  slots: string[];
  samples: MediaSample[];
}

type EntityDetailTab = "sound" | "animation" | "data";
type EntityAnimationGroup = "body" | "construction" | "operation" | "weapon" | "impact" | "destruction" | "debris";
type AudioDetailTab = "associations" | "data";

interface ActiveEntityAnimation {
  event: string;
  slot: string;
  source: string;
  ruleField: string | null;
  role: MediaAssociation["role"];
  sample: MediaSample;
}

function mergeSoundAssociations(associations: MediaAssociation[]): DisplaySoundAssociation[] {
  const merged = new Map<string, DisplaySoundAssociation>();
  for (const association of associations) {
    if (association.kind === "animation") continue;
    const key = `${association.kind}:${association.event.toLowerCase()}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        kind: association.kind,
        event: association.event,
        slots: [association.slot],
        samples: [...association.samples],
      });
      continue;
    }
    if (!current.slots.includes(association.slot)) current.slots.push(association.slot);
    for (const sample of association.samples) {
      const identity = sample.asset?.id || sample.name.toLowerCase();
      const position = current.samples.findIndex((item) => (item.asset?.id || item.name.toLowerCase()) === identity);
      if (position < 0) current.samples.push(sample);
      else if ((sample.weight || 1) > (current.samples[position].weight || 1)) current.samples[position] = sample;
    }
  }
  return [...merged.values()];
}

function EntityDetailPanel({ sourceId, sourceRevision = "", entity, loading, playerColors, defaultPreviewAngle, voiceTextPreference, wide = false, onPopout, scrollKey = "" }: {
  sourceId: string;
  sourceRevision?: string;
  entity: GameEntity | null;
  loading: boolean;
  playerColors: PlayerColor[];
  defaultPreviewAngle: PreviewAngle;
  voiceTextPreference: VoiceTextPreference;
  wide?: boolean;
  onPopout?: () => void;
  scrollKey?: string;
}) {
  const [frame, setFrame] = useState(0);
  const [previewAngle, setPreviewAngle] = useState<PreviewAngle>(defaultPreviewAngle);
  const defaultPreviewAngleRef = useRef(defaultPreviewAngle);
  defaultPreviewAngleRef.current = defaultPreviewAngle;
  const facing = shpFacingForPreviewAngle(previewAngle);
  const renderFacing = entity?.preview.supports_facing
    ? entityFacingForPreviewAngle(entity.preview.facing_format, previewAngle)
    : 0;
  const defaultPlayerColor = entity ? entityCardPlayerColor(entity) : "";
  const [playerColorSelection, setPlayerColorSelection] = useState<{
    entityId: string;
    color: string;
  } | null>(null);
  const playerColor = playerColorSelection && playerColorSelection.entityId === entity?.id
    ? playerColorSelection.color
    : defaultPlayerColor;
  const selectablePlayerColors = defaultPlayerColor
    && !playerColors.some((color) => color.id === defaultPlayerColor)
    ? [{ id: defaultPlayerColor, rgb: [], hex: "" }, ...playerColors]
    : playerColors;
  const [playing, setPlaying] = useState(false);
  const [frameMode, setFrameMode] = useState<"sequence" | "grid">("sequence");
  const [soundAssociationLayout, setSoundAssociationLayout] = useState<LayoutMode>("list");
  const [animationAssociationLayout, setAnimationAssociationLayout] = useState<LayoutMode>("grid");
  const [detailTab, setDetailTab] = useState<EntityDetailTab>("sound");
  const [activeAnimation, setActiveAnimation] = useState<ActiveEntityAnimation | null>(null);
  const [animationMetadata, setAnimationMetadata] = useState<AssetMetadata | null>(null);
  const [effectBodyMetadata, setEffectBodyMetadata] = useState<AssetMetadata | null>(null);
  const [bodyMetadata, setBodyMetadata] = useState<AssetMetadata | null>(null);
  const [operationMetadata, setOperationMetadata] = useState<Record<string, AssetMetadata>>({});
  const [animationFrame, setAnimationFrame] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const autoStartedAnimationRef = useRef<ActiveEntityAnimation | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const frameCount = Math.max(1, entity?.preview.frame_count || 1);
  const animationAssociations = useMemo(
    () => entity?.media.filter((association) => isPlayableEntityAnimation(entity.kind, association)) || [],
    [entity],
  );
  const entityKind = entity?.kind || "vehicle";
  const bodyAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "body",
  );
  const constructionAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "construction",
  );
  const operationAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "operation",
  );
  const defaultOperationSamples = defaultBuildingOperationSamples(
    operationAnimationAssociations,
    facing,
    activeAnimation,
  );
  const defaultOperationAssetKey = defaultOperationSamples.map((sample) => sample.asset?.id).join(":");
  const weaponAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "weapon",
  );
  const impactAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "impact",
  );
  const destructionAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "destruction",
  );
  const debrisAnimationAssociations = animationAssociations.filter(
    (association) => animationAssociationGroup(entityKind, association) === "debris",
  );
  const activeAnimationFrames = useMemo(
    () => animationSourceFrames(activeAnimation?.sample, animationMetadata, facing),
    [activeAnimation, animationMetadata, facing],
  );
  const activeAnimationIsBody = activeAnimation?.role === "body" || activeAnimation?.slot === "body_sequence";
  const activeAnimationReplacesBody = activeAnimationIsBody
    || activeAnimation?.role === "construction"
    || activeAnimation?.role === "debris";
  const effectBodyAssociation = activeAnimation?.role === "weapon"
    ? effectBodySequence(animationAssociations, activeAnimation.slot)
    : null;
  const effectBodySample = effectBodyAssociation?.samples.find((sample) => sample.asset) || null;
  const effectBodyFrames = useMemo(
    () => effectBodySample
      ? animationSourceFramesFromTotal(effectBodySample, entity?.preview.source_frame_count || 0, facing)
      : [],
    [effectBodySample, entity?.preview.source_frame_count, facing],
  );
  const activeAnimationShadowFrames = activeAnimationFrames
    .map((sourceFrame) => animationShadowFrame(activeAnimation?.sample, animationMetadata, sourceFrame))
    .filter((sourceFrame): sourceFrame is number => sourceFrame !== undefined);
  const activeAnimationFrameFit = sequenceFrameFit(
    animationMetadata,
    activeAnimationFrames,
    activeAnimationShadowFrames,
  );
  const effectBodyShadowFrames = effectBodyFrames
    .map((sourceFrame) => animationShadowFrame(effectBodySample || undefined, effectBodyMetadata, sourceFrame))
    .filter((sourceFrame): sourceFrame is number => sourceFrame !== undefined);
  const effectBodyFrameFit = sequenceFrameFit(effectBodyMetadata, effectBodyFrames, effectBodyShadowFrames);
  const defaultBodyAssociation = preferredBodySequence(bodyAnimationAssociations);
  const defaultBodySample = defaultBodyAssociation?.samples.find((sample) => sample.asset) || null;
  const bodyFrameIndices = defaultBodySample
    ? animationSourceFrames(defaultBodySample, bodyMetadata, facing)
    : entity?.preview.frame_indices || shpPlaybackFrames(bodyMetadata);
  const entityBodyFrameFit = sequenceFrameFit(
    bodyMetadata,
    bodyFrameIndices,
  );
  const defaultOperationFrameFits = defaultOperationSamples.map((sample) => {
    const metadata = sample.asset ? operationMetadata[sample.asset.id] : null;
    const frames = animationSourceFrames(sample, metadata, facing);
    const shadows = frames
      .map((sourceFrame) => animationShadowFrame(sample, metadata, sourceFrame))
      .filter((sourceFrame): sourceFrame is number => sourceFrame !== undefined);
    return sequenceFrameFit(metadata, frames, shadows);
  });
  const operationMetadataReady = defaultOperationSamples.every(
    (sample) => Boolean(sample.asset && operationMetadata[sample.asset.id]),
  );
  const entityPresentationFrameFit = defaultOperationSamples.length > 0 && !operationMetadataReady
    ? null
    : combineFrameFits(entityBodyFrameFit, ...defaultOperationFrameFits);
  const buildingOperationFrameFit = combineFrameFits(entityPresentationFrameFit, activeAnimationFrameFit);
  const activeAnimationFrameCount = activeAnimation
    ? Math.max(activeAnimationFrames.length, effectBodyFrames.length, 1)
    : activeAnimationFrames.length;
  const activeAnimationLoops = activeAnimationIsBody
    || activeAnimation?.sample.animation?.loop_count === -1;
  const activeAnimationLoopStart = (() => {
    if (!activeAnimationLoops) return 0;
    const sourceFrame = activeAnimation?.sample.animation?.loop_start;
    if (sourceFrame === null || sourceFrame === undefined) return 0;
    const index = activeAnimationFrames.indexOf(sourceFrame);
    return index >= 0 ? index : 0;
  })();
  const activeAnimationSourceFrame = activeAnimationFrames[Math.min(animationFrame, activeAnimationFrames.length - 1)] || 0;
  const activeAnimationShadowFrame = animationShadowFrame(
    activeAnimation?.sample,
    animationMetadata,
    activeAnimationSourceFrame,
  );
  const effectBodySourceFrame = effectBodyFrames.length > 0
    ? effectBodyFrames[animationFrame % effectBodyFrames.length]
    : 0;
  const effectFrameVisible = Boolean(activeAnimation && !activeAnimationReplacesBody && animationFrame < activeAnimationFrames.length);
  function animationPreviewUrls(sequenceFrame: number) {
    const sample = activeAnimation?.sample;
    const asset = sample?.asset;
    if (!sample || !asset || asset.format !== "shp") return [];
    const sourceFrame = activeAnimationFrames[Math.min(sequenceFrame, activeAnimationFrames.length - 1)] || 0;
    const shadowFrame = animationShadowFrame(sample, animationMetadata, sourceFrame);
    if (entity?.kind === "building" && activeAnimation?.role === "operation") {
      return [api.entityPreviewUrl(sourceId, entity.id, {
        frame,
        facing: renderFacing,
        playerColor,
        scale: 4,
        effectAssetId: asset.id,
        effectFrame: sourceFrame,
        effectShadowFrame: shadowFrame,
        effectPalette: sample.palette || undefined,
        revision: sourceRevision,
      })];
    }
    const urls = sequenceFrame < activeAnimationFrames.length
      ? [api.previewUrl(asset.id, sourceFrame, "", 5, playerColor, {
        palette: sample.palette || undefined,
        shadowFrame,
      })]
      : [];
    if (effectBodySample?.asset?.format === "shp" && effectBodyFrames.length > 0) {
      const bodySourceFrame = effectBodyFrames[sequenceFrame % effectBodyFrames.length];
      urls.push(api.previewUrl(
        effectBodySample.asset.id,
        bodySourceFrame,
        "",
        5,
        playerColor,
        { palette: effectBodySample.palette || undefined },
      ));
    }
    return [...new Set(urls)];
  }
  const associationLayout = detailTab === "animation" ? animationAssociationLayout : soundAssociationLayout;
  const setAssociationLayout = detailTab === "animation" ? setAnimationAssociationLayout : setSoundAssociationLayout;
  const detailScroll = useRememberedScroll<HTMLElement, HTMLDivElement>(
    `${scrollKey}:${detailTab}`,
    entity ? entity.components.length + entity.media.length : 0,
  );
  useResponsiveDetailPageReset(scrollKey, detailScroll.ref);

  useEffect(() => {
    setFrame(0);
    setPreviewAngle(defaultPreviewAngleRef.current);
    setPlayerColorSelection(null);
    setPlaying(false);
    setFrameMode("sequence");
    setActiveAnimation(null);
    setAnimationMetadata(null);
    setEffectBodyMetadata(null);
    setAnimationFrame(0);
    setAnimationPlaying(false);
    setPreviewFailed(false);
    setDetailTab(entity?.media.some((association) => association.kind !== "animation")
      ? "sound"
      : entity && entityHasPlayableAnimation(entity)
        ? "animation"
        : "data");
  }, [entity?.id]);

  useEffect(() => setPreviewAngle(defaultPreviewAngle), [defaultPreviewAngle]);

  useEffect(() => {
    if (!playing || frameCount < 2) return;
    const nextFrame = (frame + 1) % frameCount;
    const advance = () => setFrame((current) => current === frame ? nextFrame : current);
    if (entity?.voxel) {
      const timer = window.setTimeout(advance, 240);
      return () => window.clearTimeout(timer);
    }
    if (!entity?.id) return;
    const nextUrl = api.entityPreviewUrl(
      sourceId,
      entity.id,
      { frame: nextFrame, facing: renderFacing, playerColor, scale: 4 },
    );
    return scheduleDecodedImageFrame(nextUrl, 160, advance);
  }, [playing, frame, frameCount, entity?.id, entity?.voxel, sourceId, renderFacing, playerColor]);

  const previewUrl = useMemo(() => entity?.renderable ? api.entityPreviewUrl(
    sourceId,
    entity.id,
    { frame, facing: renderFacing, playerColor, scale: 4 },
  ) : "", [sourceId, entity, frame, renderFacing, playerColor]);

  useEffect(() => setPreviewFailed(false), [previewUrl]);

  useEffect(() => {
    setBodyMetadata(null);
    const bodyAsset = entity?.components.find((component) => component.role === "body")?.asset;
    if (!bodyAsset || bodyAsset.format !== "shp") return;
    let cancelled = false;
    api.metadata(bodyAsset.id)
      .then((nextMetadata) => !cancelled && setBodyMetadata(nextMetadata))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [entity?.id]);

  useEffect(() => {
    setOperationMetadata({});
    const assets = defaultOperationSamples
      .map((sample) => sample.asset)
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
    if (assets.length === 0) return;
    let cancelled = false;
    Promise.all(assets.map(async (asset) => {
      try {
        return [asset.id, await api.metadata(asset.id)] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      setOperationMetadata(Object.fromEntries(entries.filter((entry) => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [entity?.id, defaultOperationAssetKey]);

  useEffect(() => {
    setAnimationMetadata(null);
    setAnimationFrame(0);
    setAnimationPlaying(false);
    autoStartedAnimationRef.current = null;
    if (!activeAnimation?.sample.asset) return;
    let cancelled = false;
    api.metadata(activeAnimation.sample.asset.id)
      .then((nextMetadata) => {
        if (cancelled) return;
        setAnimationMetadata(nextMetadata);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeAnimation]);

  useEffect(() => {
    setEffectBodyMetadata(null);
    if (!effectBodySample?.asset || effectBodySample.asset.format !== "shp") return;
    let cancelled = false;
    api.metadata(effectBodySample.asset.id)
      .then((nextMetadata) => {
        if (!cancelled) setEffectBodyMetadata(nextMetadata);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [effectBodySample?.asset?.id]);

  useEffect(() => {
    if (!activeAnimation || autoStartedAnimationRef.current === activeAnimation) return;
    const sample = activeAnimation.sample;
    const asset = sample.asset;
    if (!asset) return;
    if (asset.format !== "shp") {
      autoStartedAnimationRef.current = activeAnimation;
      setAnimationPlaying(activeAnimationFrameCount > 1);
      return;
    }
    if (!animationMetadata && (sample.animation?.shadow || sample.animation?.frame_count === null)) return;
    const frameUrlGroups = Array.from(
      { length: activeAnimationFrameCount },
      (_, index) => animationPreviewUrls(index),
    );
    if (frameUrlGroups.length === 0) return;
    let cancelled = false;
    const firstFrames = frameUrlGroups.slice(0, 2).map((urls) => Promise.all(
      urls.map((url) => preloadDecodedImageFrame(url, "high")),
    ));
    void firstFrames[0].then(() => {
      if (cancelled) return;
      autoStartedAnimationRef.current = activeAnimation;
      setAnimationPlaying(activeAnimationFrameCount > 1);
    });
    void Promise.all(firstFrames).then(() => {
      if (cancelled) return;
      for (const urls of frameUrlGroups.slice(2)) {
        for (const url of urls) void preloadDecodedImageFrame(url, "low");
      }
    });
    return () => { cancelled = true; };
  }, [activeAnimation, activeAnimationFrameCount, activeAnimationFrames, animationMetadata, effectBodyFrames, effectBodySample, entity, frame, renderFacing, playerColor, sourceId, sourceRevision]);

  useEffect(() => {
    if (!activeAnimation) return;
    const association = animationAssociations.find(
      (item) => item.slot === activeAnimation.slot
        && item.source === activeAnimation.source
        && item.event === activeAnimation.event
        && item.rule_field === activeAnimation.ruleField,
    );
    const directional = association?.samples.filter((sample) => sample.animation?.direction) || [];
    const sample = association && directional.length > 1 && directional.length === association.samples.length
      ? directionalAnimationSample(association.samples, facing)
      : undefined;
    if (sample && sample.name !== activeAnimation.sample.name) {
      setActiveAnimation((current) => current ? { ...current, sample } : current);
    }
    setAnimationFrame(0);
  }, [facing]);

  useEffect(() => {
    if (!animationPlaying || activeAnimationFrameCount < 2) return;
    const requestedRate = activeAnimation?.sample.animation?.rate_ms || 140;
    const interval = Math.min(1000, Math.max(60, requestedRate));
    if (animationFrame >= activeAnimationFrameCount - 1 && !activeAnimationLoops) {
      setAnimationPlaying(false);
      return;
    }
    const nextFrame = animationFrame >= activeAnimationFrameCount - 1
      ? activeAnimationLoopStart
      : animationFrame + 1;
    const advance = () => setAnimationFrame((current) => current === animationFrame ? nextFrame : current);
    if (activeAnimation?.sample.asset?.format === "shp") {
      return scheduleDecodedImageFrames(animationPreviewUrls(nextFrame), interval, advance);
    }
    const timer = window.setTimeout(advance, interval);
    return () => window.clearTimeout(timer);
  }, [animationPlaying, animationFrame, activeAnimationFrameCount, activeAnimationLoops, activeAnimationLoopStart, activeAnimation, activeAnimationFrames, animationMetadata, effectBodyFrames, effectBodySample, entity, frame, renderFacing, playerColor, sourceId, sourceRevision]);

  if (loading && !entity) return <aside className="detail-panel panel empty-detail"><div className="radar small"><span /></div><strong>正在读取单位详情…</strong></aside>;
  if (!entity) return <aside className="detail-panel panel empty-detail"><div className="empty-detail-icon"><Icon name="unit" size={30} /></div><strong>选择单位</strong></aside>;
  const rules = Object.entries(entity.rules).filter(([key]) => ruleLabels[key]);
  const soundAssociations = mergeSoundAssociations(entity.media);
  const soundCount = soundAssociations.reduce((count, association) => count + association.samples.length, 0);
  const hasBodySequences = bodyAnimationAssociations.length > 0;
  const hasRawBodyAnimation = entity.kind !== "building" && frameCount > 1 && !hasBodySequences;
  const rawBodyAnimationTitle = entity.voxel ? "模型姿态" : "未分组主体帧";
  const rawBodyAnimationMeta = entity.voxel
    ? `${frameCount} 帧 · HVA 逐帧变换`
    : `${frameCount} 帧 · 未找到事件映射`;
  const animationGroups: Record<EntityAnimationGroup, MediaAssociation[]> = {
    body: bodyAnimationAssociations,
    construction: constructionAnimationAssociations,
    operation: operationAnimationAssociations,
    weapon: weaponAnimationAssociations,
    impact: impactAnimationAssociations,
    destruction: destructionAnimationAssociations,
    debris: debrisAnimationAssociations,
  };
  const animationCounts: Record<EntityAnimationGroup, number> = {
    body: bodyAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0)
      + (hasRawBodyAnimation ? 1 : 0),
    construction: constructionAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0),
    operation: operationAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0),
    weapon: weaponAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0),
    impact: impactAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0),
    destruction: destructionAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0),
    debris: debrisAnimationAssociations.reduce((count, association) => count + animationAssociationCount(association), 0),
  };
  const animationGroupLabels: Record<EntityAnimationGroup, string> = {
    body: entity.voxel ? "模型姿态" : "主体动作",
    construction: "建造",
    operation: "运转与状态",
    weapon: "开火效果",
    impact: "命中特效",
    destruction: "摧毁爆炸",
    debris: "飞散残骸",
  };
  const animationGroupOrder: EntityAnimationGroup[] = entity.kind === "building"
    ? ["construction", "operation", "body", "weapon", "impact", "destruction", "debris"]
    : ["body", "weapon", "impact", "destruction", "debris", "construction", "operation"];
  const visibleAnimationGroups = animationGroupOrder.filter(
    (group) => animationCounts[group] > 0,
  );
  const animationCount = Object.values(animationCounts).reduce((total, count) => total + count, 0);
  const activeAnimationAssociation = activeAnimation
    ? animationAssociations.find(
      (association) => association.slot === activeAnimation.slot
        && association.source === activeAnimation.source
        && association.event === activeAnimation.event
        && association.rule_field === activeAnimation.ruleField,
    )
    : undefined;
  const activeAnimationCandidates = activeAnimationAssociation?.selection && activeAnimationAssociation.samples.length > 1
    ? activeAnimationAssociation.samples.filter((sample) => sample.asset)
    : [];
  const activeAnimationTitle = activeAnimationAssociation
    ? animationAssociationTitle(activeAnimationAssociation)
    : animationEventLabel(activeAnimation?.event || "主体动作");
  const activeAnimationAsset = activeAnimation?.sample.asset || null;
  const effectBodyAsset = effectBodySample?.asset || null;
  const activeAnimationPreviewUrl = activeAnimationAsset?.format === "shp"
    ? api.previewUrl(activeAnimationAsset.id, activeAnimationSourceFrame, "", 5, playerColor, {
      palette: activeAnimation?.sample.palette || undefined,
      shadowFrame: activeAnimationShadowFrame,
    })
    : "";
  const effectBodyPreviewUrl = effectBodyAsset?.format === "shp"
    ? api.previewUrl(effectBodyAsset.id, effectBodySourceFrame, "", 5, playerColor, {
      palette: effectBodySample?.palette || undefined,
    })
    : "";
  const buildingOperationPreviewUrl = entity.kind === "building"
    && activeAnimation?.role === "operation"
    && activeAnimationAsset?.format === "shp"
    ? api.entityPreviewUrl(sourceId, entity.id, {
      frame,
      facing: renderFacing,
      playerColor,
      scale: 4,
      effectAssetId: activeAnimationAsset.id,
      effectFrame: activeAnimationSourceFrame,
      effectShadowFrame: activeAnimationShadowFrame,
      effectPalette: activeAnimation.sample.palette || undefined,
      revision: sourceRevision,
    })
    : "";
  const animationCardPreviewUrl = (association: MediaAssociation, sample: MediaSample) => {
    if (!sample.asset || !["shp", "tmp", "pcx"].includes(sample.asset.format)) return "";
    if (entity.kind === "building" && association.role === "operation" && sample.asset.format === "shp") {
      return api.entityPreviewUrl(sourceId, entity.id, {
        frame: 0,
        facing: renderFacing,
        playerColor,
        scale: 2,
        effectAssetId: sample.asset.id,
        effectFrame: sample.animation?.start_frame || 0,
        effectPalette: sample.palette || undefined,
        revision: sourceRevision,
      });
    }
    return api.previewUrl(
      sample.asset.id,
      sample.animation?.start_frame || 0,
      "",
      2,
      playerColor,
      { palette: sample.palette || undefined },
    );
  };
  const effectAnchor = animationEffectAnchor(
    activeAnimation?.role || null,
    entity.art,
    activeAnimation?.slot || "",
    facing,
  );
  const entityTags = [
    entityKindLabels[entity.kind],
    entityUsageLabel(entity.kind, entity.usage),
    entity.voxel ? "VXL 三维模型" : "SHP 帧动画",
    ...entity.sides.map((side) => sideLabels[side] || side),
    ...entity.countries,
    `${entity.component_count} 个组件`,
    ...(entity.preview.frame_count > 1 ? [`${entity.preview.frame_count} 个有效帧`] : []),
    ...(entity.preview.source_frame_count !== undefined && entity.preview.source_frame_count !== entity.preview.frame_count
      ? [`源文件 ${entity.preview.source_frame_count} 帧`]
      : []),
    ...(entity.preview.voxel_count !== undefined
      ? [`${entity.preview.voxel_count.toLocaleString("zh-CN")} 体素`]
      : []),
  ];
  const dataCount = entityTags.length + rules.length + entity.components.length;
  const dependencyGroups = [...new Set(entity.dependencies.map((item) => item.slot))].map(
    (slot) => ({ slot, items: entity.dependencies.filter((item) => item.slot === slot) }),
  );
  return (
    <aside ref={detailScroll.ref} onScroll={detailScroll.remember} aria-busy={loading} className={`detail-panel entity-detail panel ${wide ? "entity-detail-wide" : "entity-detail-narrow"}`}>
      <div className="entity-detail-body">
        <div className="entity-preview-column">
          {entity.renderable ? <div className="preview-block entity-preview">
            {activeAnimationReplacesBody && activeAnimationAsset?.format === "shp"
              ? <ImageViewport className="shp entity-body-action-stage" fitKey={`${activeAnimationAsset.id}:${activeAnimation?.event || "body"}`} frameFit={activeAnimationFrameFit} src={activeAnimationPreviewUrl} alt={`${activeAnimationTitle}预览`} building={entity.kind === "building"} />
              : activeAnimationReplacesBody && activeAnimationAsset && ["vxl", "hva"].includes(activeAnimationAsset.format)
                ? <VoxelPreview url={api.assetModelUrl(activeAnimationAsset.id, activeAnimationSourceFrame, playerColor)} label={animationEventLabel(activeAnimation?.event || activeAnimationAsset.display_name)} viewKey={`asset:${activeAnimationAsset.id}`} previewAngle={previewAngle} resetAngle={defaultPreviewAngle} onPreviewAngleChange={setPreviewAngle} />
                : buildingOperationPreviewUrl
                  ? <ImageViewport className="shp entity-body-action-stage" fitKey={`${entity.id}:operation:${activeAnimationAsset?.id || "effect"}`} frameFit={buildingOperationFrameFit} src={buildingOperationPreviewUrl} alt={`${activeAnimationTitle}组合预览`} building />
                  : !activeAnimationAsset && frameMode === "grid" && hasRawBodyAnimation
                    ? <FrameGrid count={frameCount} active={frame} onSelect={setFrame} scrollKey={`${entity.id}:${renderFacing}:${playerColor}`} urlFor={(index) => api.entityPreviewUrl(sourceId, entity.id, { frame: index, facing: renderFacing, playerColor, scale: 3 })} />
                    : <div className="entity-composite-stage">
                    {effectBodyPreviewUrl
                      ? <ImageViewport className="shp entity-composite-body" fitKey={`${entity.id}:${effectBodyAssociation?.event || "body"}`} frameFit={effectBodyFrameFit} src={effectBodyPreviewUrl} alt={`${entity.display_name} 主体动作`} building={entity.kind === "building"} />
                      : entity.voxel
                        ? <VoxelPreview url={api.entityModelUrl(sourceId, entity.id, { frame, playerColor, revision: sourceRevision })} label={entity.display_name} viewKey={`entity:${sourceId}:${entity.id}`} previewAngle={previewAngle} resetAngle={defaultPreviewAngle} onPreviewAngleChange={setPreviewAngle} />
                        : previewFailed
                          ? <div className="preview-stage shp"><div className="preview-error"><Icon name="info" size={24} /><strong>预览生成失败</strong></div></div>
                          : <ImageViewport className="shp entity-composite-body" fitKey={entity.id} frameFit={entityPresentationFrameFit} src={previewUrl} onError={() => setPreviewFailed(true)} alt={`${entity.display_name} 组合预览`} building={entity.kind === "building"} />}
                    {activeAnimationAsset?.format === "shp" && <span className={`entity-effect-overlay ${activeAnimation?.role === "operation" ? "attached" : ""} ${effectFrameVisible ? "visible" : "hidden"}`} style={{ "--effect-x": `${effectAnchor.x}%`, "--effect-y": `${effectAnchor.y}%` } as CSSProperties} aria-hidden="true">
                      <StablePreviewImage src={activeAnimationPreviewUrl} alt="" />
                    </span>}
                    </div>}
            {(activeAnimationAsset || hasRawBodyAnimation) && <div className="entity-preview-controls">
              {activeAnimationAsset && activeAnimationFrameCount > 1
                ? <div className="frame-controls"><FrameTransport frame={animationFrame} count={activeAnimationFrameCount} playing={animationPlaying} onPlayingChange={(next) => {
                  if (next && animationFrame >= activeAnimationFrameCount - 1 && !activeAnimationLoops) setAnimationFrame(0);
                  setAnimationPlaying(next);
                }} onFrameChange={setAnimationFrame} label="帧" /></div>
                : !activeAnimationAsset && hasRawBodyAnimation && <div className="frame-controls">
                  {frameMode === "sequence" && <FrameTransport frame={frame} count={frameCount} playing={playing} onPlayingChange={setPlaying} onFrameChange={setFrame} label="帧" />}
                  <div className="frame-mode-toggle"><button className={frameMode === "sequence" ? "active" : ""} onClick={() => setFrameMode("sequence")} title="顺序播放"><Icon name="play" size={14} /></button><button className={frameMode === "grid" ? "active" : ""} onClick={() => { setPlaying(false); setFrameMode("grid"); }} title="全部帧"><Icon name="grid" size={14} /></button></div>
                </div>}
              {activeAnimation && activeAnimationCandidates.length > 1 && <label className="animation-candidate-control"><span>候选</span><select aria-label="动画候选" value={activeAnimation.sample.name} onChange={(event) => {
                const sample = activeAnimationCandidates.find((candidate) => candidate.name === event.target.value);
                if (sample) setActiveAnimation((current) => current ? { ...current, sample } : current);
              }}>{activeAnimationCandidates.map((sample) => <option value={sample.name} key={sample.name}>{sample.name}</option>)}</select></label>}
              {activeAnimationAsset && <button type="button" className="return-body-action" onClick={() => { setActiveAnimation(null); setPlaying(hasRawBodyAnimation); }}>返回主体</button>}
            </div>}
            <div className="entity-render-options compact-render-options">
              {(entity.voxel || entity.preview.supports_facing) && <label><span>角度</span><select aria-label="单位预览角度" value={previewAngle} onChange={(event) => setPreviewAngle(normalizePreviewAngle(Number(event.target.value)))}>{previewAngleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
              {entity.preview.supports_player_color && <label title="选择玩家颜色"><select aria-label="玩家颜色" value={playerColor} onChange={(event) => setPlayerColorSelection({ entityId: entity.id, color: event.target.value })}><option value="">原始色</option>{selectablePlayerColors.map((color) => <option key={color.id} value={color.id}>{playerColorLabels[color.id] || color.id}</option>)}</select></label>}
            </div>
          </div> : <div className="unsupported-preview"><Icon name="unit" size={34} /><strong>{entityBodyStatusLabel(entity)}</strong></div>}
        </div>

        <div ref={detailScroll.alternateRef} onScroll={detailScroll.remember} className="entity-detail-sections">
          <div className="detail-title entity-detail-title"><div className="detail-heading-line"><h2 title={entity.display_name}>{entity.display_name}</h2><small>{entity.id} · {entity.internal_name}</small></div><div className="detail-actions">{detailTab !== "data" && <LayoutToggle layout={associationLayout} onChange={setAssociationLayout} />}{onPopout && <button type="button" className="icon-button" onClick={onPopout} title="在独立窗口中打开" aria-label="在独立窗口中打开"><Icon name="popout" /></button>}</div></div>
          <div className="entity-detail-tabs" role="tablist" aria-label="单位详细信息">
            <button type="button" role="tab" id="entity-sound-tab" aria-controls="entity-sound-panel" aria-selected={detailTab === "sound"} className={detailTab === "sound" ? "active" : ""} disabled={soundCount === 0} onClick={() => setDetailTab("sound")}>声音 <em>{soundCount}</em></button>
            <button type="button" role="tab" id="entity-animation-tab" aria-controls="entity-animation-panel" aria-selected={detailTab === "animation"} className={detailTab === "animation" ? "active" : ""} disabled={animationCount === 0} onClick={() => setDetailTab("animation")}>动画 <em>{animationCount}</em></button>
            <button type="button" role="tab" id="entity-data-tab" aria-controls="entity-data-panel" aria-selected={detailTab === "data"} className={detailTab === "data" ? "active" : ""} onClick={() => setDetailTab("data")}>数据 <em>{dataCount}</em></button>
          </div>

          {detailTab === "sound" && <section className="entity-tab-panel entity-sounds" role="tabpanel" id="entity-sound-panel" aria-labelledby="entity-sound-tab">
            <div className={`media-association-list ${associationLayout === "grid" ? "media-association-grid" : ""}`}>
              {soundAssociations.map((association) => <article key={`${association.kind}-${association.event}`}>
                <header><span className="media-association-slots">{association.slots.map((slot) => <strong key={slot}>{mediaSlotLabel(slot)}</strong>)}</span><code>{association.event}</code><em>{association.samples.length}</em></header>
                <div>{association.samples.map((sample) => <EntitySoundSample sample={sample} voiceTextPreference={voiceTextPreference} key={`${association.event}-${sample.asset?.id || sample.name}`} />)}</div>
              </article>)}
            </div>
          </section>}

          {detailTab === "animation" && <section className="entity-tab-panel entity-animations" role="tabpanel" id="entity-animation-panel" aria-labelledby="entity-animation-tab">
            <div className="animation-kind-groups" aria-label="动画类型分组">
              {visibleAnimationGroups.map((group) => <section className={`animation-kind-group animation-group-${group}`} aria-labelledby={`entity-${group}-animation-heading`} key={group}>
                <header id={`entity-${group}-animation-heading`}><strong>{animationGroupLabels[group]}</strong><em>{animationCounts[group]}</em></header>
                <div className={`animation-association-list ${associationLayout === "grid" ? "animation-association-grid" : ""}`}>
                  {group === "body" && hasRawBodyAnimation && <button type="button" className={!activeAnimation ? "active" : ""} onClick={() => { setActiveAnimation(null); setFrameMode("sequence"); setPlaying(true); }}><span className="animation-thumbnail body-action"><Icon name="unit" size={24} /></span><span><strong>{rawBodyAnimationTitle}</strong><small>{rawBodyAnimationMeta}</small></span><Icon name="play" size={16} /></button>}
                  {animationGroups[group].flatMap((association) => animationCardSamples(association, facing).map((sample, index) => <button type="button" disabled={!sample.asset} className={activeAnimation?.event === association.event && activeAnimation.slot === association.slot && activeAnimation.source === association.source && activeAnimation.ruleField === association.rule_field && activeAnimation.sample.name === sample.name ? "active" : ""} onClick={() => { if (!sample.asset) return; setPlaying(false); setActiveAnimation({ event: association.event, slot: association.slot, source: association.source, ruleField: association.rule_field, role: association.role, sample }); }} key={`${association.slot}-${association.source}-${association.rule_field}-${association.event}-${sample.name}-${index}`}>
                    <span className={`animation-thumbnail ${association.role === "body" || association.role === "construction" ? "body-action" : ""}`}>{animationCardPreviewUrl(association, sample) ? <DeferredPreviewImage src={animationCardPreviewUrl(association, sample)} /> : <Icon name="image" size={24} />}</span>
                    <span><strong>{animationAssociationTitle(association)}</strong><small title={animationAssociationAliasTitle(association)}>{animationAssociationMeta(association, sample)}</small></span><Icon name="play" size={16} />
                  </button>))}
                </div>
              </section>)}
            </div>
          </section>}

          {detailTab === "data" && <section className="entity-tab-panel entity-data-panel" role="tabpanel" id="entity-data-panel" aria-labelledby="entity-data-tab">
            <details className="entity-section compact-section entity-tag-section" open>
              <summary><span>标签</span><em>{entityTags.length}</em></summary>
              <div className="entity-tags" aria-label="单位资源摘要">
                {entityTags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}
              </div>
            </details>

            {rules.length > 0 && <details className="entity-section compact-section entity-rules" open>
              <summary><span>规则属性</span><em>{rules.length}</em></summary>
              <div className="metadata"><dl>{rules.map(([key, value]) => <div className={`rule-span-${ruleColumnSpan(ruleLabels[key], value)}`} key={key}><dt>{ruleLabels[key]}</dt><dd>{value}</dd></div>)}</dl></div>
            </details>}

            {dependencyGroups.length > 0 && <div className="entity-dependencies">
              <h3>战斗依赖</h3>
              <div className="dependency-groups">
                {dependencyGroups.map((group) => <details key={group.slot}>
                  <summary><span>{dependencySlotLabel(group.slot)}</span><strong>{group.items[0]?.id}</strong><em>{group.items.length}</em></summary>
                  <div className="dependency-compact">
                    {group.items.map((dependency, index) => <article className={dependency.resolved ? "" : "unresolved"} key={`${dependency.kind}-${dependency.id}-${index}`}>
                      <header><span>{dependencyKindLabels[dependency.kind]}</span><code>{dependency.id}</code>{!dependency.resolved && <em>缺少规则节</em>}</header>
                      {Object.keys(dependency.properties).length > 0 && <div className="property-tags">{Object.entries(dependency.properties).map(([key, value]) => <span key={key} title={value}><b>{dependencyPropertyLabels[key] || key}</b>{value}</span>)}</div>}
                    </article>)}
                  </div>
                </details>)}
              </div>
            </div>}

            <details className="entity-section compact-section entity-components" open>
              <summary><span>资源文件</span><em>{entity.components.length}</em></summary>
              <div className="component-chips resource-file-list">
                {entity.components.map((component) => component.asset ? isStaticSnapshot ? <span key={component.role} title={`${component.asset.virtual_path} · ${formatBytes(component.asset.size)}`}>
                  <Icon name={assetIcon(component.asset.format)} size={14} />
                  <strong>{componentRoleLabels[component.role] || component.role}</strong>
                  <span>{component.asset.display_name}</span>
                  <em>{formatBytes(component.asset.size)}</em>
                </span> : <a key={component.role} href={api.contentUrl(component.asset.id)} title={`${component.asset.virtual_path} · ${formatBytes(component.asset.size)}`}>
                  <Icon name={assetIcon(component.asset.format)} size={14} />
                  <strong>{componentRoleLabels[component.role] || component.role}</strong>
                  <span>{component.asset.display_name}</span>
                  <em>{formatBytes(component.asset.size)}</em>
                </a> : <span className="missing-component" key={component.role} title={component.expected_name}>
                  <Icon name="file" size={14} />
                  <strong>{componentRoleLabels[component.role] || component.role}</strong>
                  <span>{component.expected_name}</span>
                  <em>未找到</em>
                </span>)}
              </div>
            </details>
          </section>}
        </div>
      </div>
    </aside>
  );
}

function DetailPanel({ asset, metadata, textAsset, textQuery, setTextQuery, frame, setFrame, playing, setPlaying, palettes, paletteId, setPaletteId, playerColors, previewUrl, associations, voiceTextPreference, wide = false, onPopout, scrollKey = "" }: {
  asset: Asset | null;
  metadata: AssetMetadata | null;
  textAsset: TextAsset | null;
  textQuery: string;
  setTextQuery: (value: string) => void;
  frame: number;
  setFrame: (frame: number | ((current: number) => number)) => void;
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  palettes: Asset[];
  paletteId: string;
  setPaletteId: (id: string) => void;
  playerColors: PlayerColor[];
  previewUrl: string;
  associations: AssetAssociationPage | null;
  voiceTextPreference: VoiceTextPreference;
  wide?: boolean;
  onPopout?: () => void;
  scrollKey?: string;
}) {
  const [playerColor, setPlayerColor] = useState("");
  const [videoRequested, setVideoRequested] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [frameMode, setFrameMode] = useState<"sequence" | "grid">("sequence");
  const [audioDetailTab, setAudioDetailTab] = useState<AudioDetailTab>(() => {
    const remembered = window.localStorage.getItem("ra2exp-audio-detail-tab-v1");
    return remembered === "data" ? "data" : "associations";
  });
  const detailScroll = useRememberedScroll<HTMLElement>(
    `${scrollKey}:${asset && audioFormats.includes(asset.format) ? audioDetailTab : "main"}`,
    associations?.items.length || 0,
  );
  useResponsiveDetailPageReset(scrollKey, detailScroll.ref);
  function selectAudioDetailTab(next: AudioDetailTab) {
    setAudioDetailTab(next);
    window.localStorage.setItem("ra2exp-audio-detail-tab-v1", next);
  }
  useEffect(() => {
    setPlayerColor("");
    setVideoRequested(false);
    setVideoFailed(false);
    setFrameMode("sequence");
  }, [asset?.id]);
  if (!asset) return <aside className="detail-panel panel empty-detail"><div className="empty-detail-icon"><Icon name="image" size={30} /></div><strong>选择资产</strong></aside>;
  const canPreview = imageFormats.includes(asset.format);
  const isText = ["ini", "map", "text", "csf"].includes(asset.format);
  const isAudio = audioFormats.includes(asset.format);
  const isModel = ["vxl", "hva"].includes(asset.format);
  const audioRelationshipItems = isAudio
    ? (associations?.items || []).filter((item) => item.entity !== null)
    : [];
  const unitIntroEntity = isAudio
    ? audioRelationshipItems.find((item) => /^unit_(?:eva|sofia)_/i.test(item.event))?.entity ?? null
    : null;
  const detailHeading = unitIntroEntity
    ? [unitIntroEntity.display_name, unitIntroEntity.internal_name]
      .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
      .join(" · ")
    : assetDisplayName(asset);
  const hasAudioRelationshipTabs = isAudio && audioRelationshipItems.length > 0;
  const activeAudioDetailTab = audioDetailTab === "associations" && !hasAudioRelationshipTabs
    ? "data"
    : audioDetailTab;
  const shpFrames = asset.format === "shp" ? shpPlaybackFrames(metadata) : [];
  const frameCount = assetPlaybackFrameCount(asset.format, metadata);
  const sourceFrame = asset.format === "shp"
    ? shpFrames[frame % Math.max(1, shpFrames.length)] ?? 0
    : frame;
  const sourceShadowFrame = asset.format === "shp"
    ? metadata?.frames?.[sourceFrame]?.paired_shadow_frame ?? undefined
    : undefined;
  const shpSequenceFit = asset.format === "shp" ? sequenceFrameFit(metadata, shpFrames) : null;
  const resolvedPreviewUrl = asset.format === "shp"
    ? api.previewUrl(asset.id, sourceFrame, paletteId, 5, playerColor, { shadowFrame: sourceShadowFrame })
    : previewUrl;
  const activeFrame = metadata?.frames?.[sourceFrame];
  const activeLimb = metadata?.limbs?.[frame];
  const hasFrameControl = ["shp", "tmp", "hva"].includes(asset.format) && frameCount > 1;
  const canChoosePalette = ["shp", "vxl", "hva", "tmp"].includes(asset.format) && palettes.length > 0;
  const originalTexts = uniqueAudioTexts([
    ...(associations?.original_texts || []),
    ...(associations?.items || []).map((item) => item.original_text || (item.localized_text || item.translated_text ? null : item.text)).filter((item): item is string => Boolean(item)),
    ...(associations && associations.original_texts.length === 0 && associations.localized_texts.length === 0 && (associations.translated_texts || []).length === 0
      ? associations.texts
      : []),
  ]);
  const originalTextKeys = new Set(originalTexts.map((item) => item.trim().replace(/\s+/g, " ").toLocaleLowerCase()));
  const localizedTexts = uniqueAudioTexts([
    ...(associations?.localized_texts || []),
    ...(associations?.items || []).map((item) => item.localized_text).filter((item): item is string => Boolean(item)),
  ])
    .filter((item) => !originalTextKeys.has(item.trim().replace(/\s+/g, " ").toLocaleLowerCase()));
  const translatedTexts = uniqueAudioTexts([
    ...(associations?.translated_texts || []),
    ...(associations?.items || []).map((item) => item.translated_text).filter((item): item is string => Boolean(item)),
  ])
    .filter((item) => !originalTextKeys.has(item.trim().replace(/\s+/g, " ").toLocaleLowerCase()));
  const preferredTexts = voiceTextPreference === "game"
    ? localizedTexts.length > 0
      ? { label: "中文", values: localizedTexts }
      : { label: "译文", values: translatedTexts }
    : translatedTexts.length > 0
      ? { label: "译文", values: translatedTexts }
      : { label: "中文", values: localizedTexts };
  const metadataRows: Array<{ label: string; value: string; tone?: string; span?: 1 | 2 | 3 }> = isAudio
    ? []
    : [{ label: "文件大小", value: formatBytes(asset.size) }];
  if (metadata?.width !== undefined && metadata?.height !== undefined) metadataRows.push({ label: asset.format === "map" ? "地图尺寸" : "画布 / 地块", value: `${metadata.width} × ${metadata.height}${asset.format === "map" ? " 格" : " px"}` });
  if (metadata?.theater) metadataRows.push({ label: "地图环境", value: metadata.theater });
  if (metadata?.object_counts) metadataRows.push({ label: "地图对象", value: Object.entries(metadata.object_counts).map(([kind, count]) => `${mapObjectLabels[kind] || kind} ${count}`).join(" · ") });
  if (metadata?.template_width !== undefined) metadataRows.push({ label: "模板网格", value: `${metadata.template_width} × ${metadata.template_height} · ${metadata.tile_count} 个地块` });
  if (metadata?.frame_count !== undefined) metadataRows.push({ label: asset.format === "vxl" ? "部件数" : "帧 / 槽位", value: String(metadata.frame_count) });
  if (activeFrame) metadataRows.push({ label: "当前帧", value: `${activeFrame.width} × ${activeFrame.height} · 压缩 ${activeFrame.compression}` });
  if (activeLimb) metadataRows.push({ label: "当前部件", value: `${activeLimb.name} · ${activeLimb.size.join("×")} · ${activeLimb.voxel_count.toLocaleString("zh-CN")} 体素` });
  if (metadata?.voxel_count !== undefined) metadataRows.push({ label: "总体素", value: metadata.voxel_count.toLocaleString("zh-CN") });
  if (metadata?.section_count !== undefined) metadataRows.push({ label: "节 / 段", value: `${metadata.section_count}${metadata.section_names?.length ? ` · ${metadata.section_names.slice(0, 3).join(", ")}` : ""}` });
  if (metadata?.label_count !== undefined) metadataRows.push({ label: "CSF 文本", value: `${metadata.label_count} 标签 · ${metadata.string_count} 字符串` });
  if (metadata?.entry_count !== undefined) metadataRows.push({ label: "配置结构", value: `${metadata.section_count} 节 · ${metadata.entry_count} 项` });
  if (metadata?.encoding) metadataRows.push({ label: "文本编码", value: metadata.encoding });
  if (!isAudio) metadataRows.push({ label: "来源", value: asset.storage_kind === "loose" ? "松散文件" : asset.storage_kind === "bag" ? "音频包" : "MIX 归档" });
  if (!isAudio && asset.crc !== null) metadataRows.push({ label: "CRC", value: crcLabel(asset.crc), tone: "mono" });
  if (!isAudio) metadataRows.push({ label: "识别", value: asset.confidence === "name" ? "名称库匹配" : asset.confidence === "content" ? "内容探测" : asset.confidence === "filename" ? "文件名" : asset.confidence === "index" ? "音频索引" : "未知" });
  const audioContextItems = isAudio
    ? (associations?.items || []).filter((item) => item.entity === null)
    : [];
  const audioEventTags = [...new Map(
    audioContextItems
      .filter((item) => item.event.trim())
      .map((item) => [item.event.trim().toLocaleLowerCase(), item.event.trim()]),
  ).values()].map((event) => ({ label: "事件 ID", value: event, mono: true }));
  const audioVersionTags = [...new Set(
    audioContextItems
      .filter((item) => item.slot.startsWith("eva_"))
      .map((item) => mediaSlotLabel(item.slot)),
  )].map((version) => ({ label: "适用", value: version }));
  const audioMetadataTags: Array<{ label: string; value: string; mono?: boolean }> = isAudio ? [
    ...audioEventTags,
    ...audioVersionTags,
    { label: "大小", value: formatBytes(asset.size) },
    ...(metadata?.duration_seconds !== undefined ? [{ label: "时长", value: formatDuration(metadata.duration_seconds) }] : []),
    ...(metadata?.sample_rate !== undefined ? [{ label: "采样率", value: `${metadata.sample_rate.toLocaleString("zh-CN")} Hz` }] : []),
    ...(metadata?.bits_per_sample !== undefined ? [{ label: "位深", value: `${metadata.bits_per_sample} bit` }] : []),
    ...(metadata?.channels !== undefined ? [{ label: "声道", value: metadata.channels === 1 ? "单声道" : metadata.channels === 2 ? "双声道" : `${metadata.channels} 声道` }] : []),
    ...(metadata?.audio_codec ? [{ label: "编码", value: metadata.audio_codec }] : []),
    ...(asset.crc !== null ? [{ label: "CRC", value: crcLabel(asset.crc), mono: true }] : []),
  ] : [];
  const audioTextRows = isAudio ? [
    ...(originalTexts.length > 0 ? [{ label: "原文", value: originalTexts.join("\n") }] : []),
    ...(preferredTexts.values.length > 0 ? [{ label: preferredTexts.label, value: preferredTexts.values.join("\n") }] : []),
  ] : [];
  const audioDataCount = audioMetadataTags.length + audioTextRows.length;
  return (
    <aside ref={detailScroll.ref} onScroll={detailScroll.remember} className={`detail-panel asset-detail panel ${wide ? "detail-panel-wide" : "detail-panel-narrow"}`}>
      <div className={`detail-title ${isAudio ? "audio-detail-title" : ""}`}>
        <div className="detail-heading-line"><span className="format-pill">{formatLabels[asset.format] || asset.format.toUpperCase()}</span><h2 title={detailHeading}>{detailHeading}</h2></div>
        <div className="detail-actions">
          {onPopout && <button type="button" className="icon-button" onClick={onPopout} title="在独立窗口中打开" aria-label="在独立窗口中打开"><Icon name="popout" /></button>}
          {isAudio
            ? <div className="audio-header-player">
              <CompactAudioPlayer assetId={asset.id} label={assetDisplayName(asset)} />
              <span className="audio-header-meta" title={metadata?.audio_codec || ""}>{metadata?.duration_seconds !== undefined ? formatDuration(metadata.duration_seconds) : ""}</span>
              <AudioDownloadAction assetId={asset.id} label={assetDisplayName(asset)} />
            </div>
            : <a className="icon-button" href={api.contentUrl(asset.id)} title="导出原始文件" aria-label="导出原始文件"><Icon name="download" /></a>}
        </div>
      </div>

      {hasAudioRelationshipTabs && <div className="entity-detail-tabs asset-detail-tabs" role="tablist" aria-label="声音详细信息">
        <button type="button" role="tab" id="audio-associations-tab" aria-controls="audio-associations-panel" aria-selected={activeAudioDetailTab === "associations"} className={activeAudioDetailTab === "associations" ? "active" : ""} onClick={() => selectAudioDetailTab("associations")}>关联 <em>{audioRelationshipItems.length}</em></button>
        <button type="button" role="tab" id="audio-data-tab" aria-controls="audio-data-panel" aria-selected={activeAudioDetailTab === "data"} className={activeAudioDetailTab === "data" ? "active" : ""} onClick={() => selectAudioDetailTab("data")}>数据 <em>{audioDataCount}</em></button>
      </div>}

      {isModel && <div className="preview-block">
        {frameMode === "grid" && asset.format === "hva" && frameCount > 1
          ? <FrameGrid count={frameCount} active={frame} onSelect={setFrame} scrollKey={`${asset.id}:${paletteId}:${playerColor}`} urlFor={(index) => api.previewUrl(asset.id, index, paletteId, 3, playerColor)} />
          : <VoxelPreview url={api.assetModelUrl(asset.id, frame, playerColor, paletteId)} label={asset.display_name} viewKey={`asset:${asset.id}`} />}
        {asset.format === "hva" && hasFrameControl && <div className="frame-controls">
          {frameMode === "sequence" && <FrameTransport frame={frame} count={frameCount} playing={playing} onPlayingChange={setPlaying} onFrameChange={setFrame} label="帧" />}
          <div className="frame-mode-toggle"><button className={frameMode === "sequence" ? "active" : ""} onClick={() => setFrameMode("sequence")} title="顺序播放"><Icon name="play" size={14} /></button><button className={frameMode === "grid" ? "active" : ""} onClick={() => { setPlaying(false); setFrameMode("grid"); }} title="全部帧"><Icon name="grid" size={14} /></button></div>
        </div>}
      </div>}

      {canPreview && (
        <div className="preview-block">
          {frameMode === "grid" && asset.format === "shp" && frameCount > 1
            ? <FrameGrid count={frameCount} active={frame} onSelect={setFrame} scrollKey={`${asset.id}:${paletteId}:${playerColor}`} urlFor={(index) => {
              const source = shpFrames[index] ?? 0;
              return api.previewUrl(asset.id, source, paletteId, 3, playerColor, { shadowFrame: metadata?.frames?.[source]?.paired_shadow_frame ?? undefined });
            }} />
            : <ImageViewport className={asset.format} fitKey={asset.id} frameFit={shpSequenceFit} src={resolvedPreviewUrl} alt={`${asset.display_name} 预览`} />}
          {hasFrameControl && <div className="frame-controls">
            {frameMode === "sequence" && <FrameTransport frame={frame} count={frameCount} playing={playing} onPlayingChange={setPlaying} onFrameChange={setFrame} label={asset.format === "tmp" ? "地块" : "帧"} playDisabled={asset.format === "tmp"} />}
            {asset.format === "shp" && <div className="frame-mode-toggle"><button className={frameMode === "sequence" ? "active" : ""} onClick={() => setFrameMode("sequence")} title="顺序播放"><Icon name="play" size={14} /></button><button className={frameMode === "grid" ? "active" : ""} onClick={() => { setPlaying(false); setFrameMode("grid"); }} title="全部帧"><Icon name="grid" size={14} /></button></div>}
          </div>}
        </div>
      )}

      {asset.format === "video" && <div className="video-preview">
        {videoRequested && !videoFailed
          ? <video controls autoPlay preload="metadata" src={api.videoUrl(asset.id)} onLoadedData={() => setVideoFailed(false)} onError={() => setVideoFailed(true)}>浏览器不支持视频播放。</video>
          : <button type="button" className="button primary" onClick={() => { setVideoFailed(false); setVideoRequested(true); }}><Icon name="play" />{videoFailed ? "重试转换" : "转换并播放"}</button>}
        {videoFailed && <strong className="video-error">视频转换失败</strong>}
      </div>}

      {isText && <div className="text-preview">
        <label><Icon name="search" size={14} /><input value={textQuery} onChange={(event) => setTextQuery(event.target.value)} placeholder="在当前文件中筛选…" /></label>
        <pre>{textAsset?.text || "正在读取文本…"}</pre>
        {textAsset && <small>显示 {textAsset.returned_lines} / {textAsset.line_count} 行{textAsset.truncated ? " · 已截断" : ""}</small>}
      </div>}

      {associations && (isAudio ? audioRelationshipItems : associations.items).length > 0 && (!isAudio || activeAudioDetailTab === "associations") && <div className="asset-associations" role={isAudio ? "tabpanel" : undefined} id={isAudio ? "audio-associations-panel" : undefined} aria-labelledby={isAudio ? "audio-associations-tab" : undefined}>
        <h3>关联事件</h3>
        <div>{(isAudio ? audioRelationshipItems : associations.items).map((item, index) => {
          const originalText = cleanAudioText(item.original_text || item.text || "");
          const preferredText = preferredAudioText(item.localized_text, item.translated_text, voiceTextPreference);
          return <article key={`${item.scope}-${item.event}-${item.slot}-${index}`}>
            <span>{mediaSlotLabel(item.slot)}</span>
            <strong>{item.entity?.display_name || item.event}</strong>
            {item.entity && <code>{item.event}</code>}
            {originalText && <p><b>原文</b>{originalText}</p>}
            {preferredText && preferredText.value !== originalText && <p><b>{preferredText.label}</b>{preferredText.value}</p>}
          </article>;
        })}</div>
      </div>}

      {!canPreview && !isText && !isAudio && !isModel && asset.format !== "video" && <div className="unsupported-preview"><Icon name={assetIcon(asset.format)} size={34} /><strong>{formatLabels[asset.format] || asset.format.toUpperCase()}</strong></div>}

      {(canChoosePalette || isModel) && <div className="entity-render-options asset-render-options">
        {isModel && <label title="选择玩家颜色"><select aria-label="玩家颜色" value={playerColor} onChange={(event) => setPlayerColor(event.target.value)}><option value="">原始色</option>{playerColors.map((color) => <option key={color.id} value={color.id}>{playerColorLabels[color.id] || color.id}</option>)}</select></label>}
        {canChoosePalette && <label><span>配色表</span><select value={paletteId} onChange={(event) => setPaletteId(event.target.value)}><option value="">自动</option>{palettes.map((palette) => <option key={palette.id} value={palette.id}>{palette.display_name}</option>)}</select></label>}
      </div>}

      {isAudio && activeAudioDetailTab === "data" && <div className={`metadata sound-metadata ${hasAudioRelationshipTabs ? "" : "sound-metadata-direct"}`} role={hasAudioRelationshipTabs ? "tabpanel" : undefined} id={hasAudioRelationshipTabs ? "audio-data-panel" : undefined} aria-labelledby={hasAudioRelationshipTabs ? "audio-data-tab" : undefined}>
        {hasAudioRelationshipTabs && <h3>资产信息</h3>}
        <ul className="sound-metadata-tags" aria-label="音频元信息">{audioMetadataTags.map((tag) => <li key={`${tag.label}-${tag.value}`} title={`${tag.label}：${tag.value}`}><span>{tag.label}</span><strong className={tag.mono ? "mono" : ""}>{tag.value}</strong></li>)}</ul>
        {audioTextRows.length > 0 && <dl className="sound-transcript-list">{audioTextRows.map((row) => <div className={canUseCompactTextTag(row.value) ? "sound-transcript-tag" : "sound-transcript-block"} key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
      </div>}
      {!isAudio && <div className="metadata">
        <h3>资产信息</h3>
        <dl>{metadataRows.map((row) => <div className={`metadata-span-${isAudio ? 1 : row.span ?? ruleColumnSpan(row.label, row.value)}`} key={row.label}><dt>{row.label}</dt><dd className={row.tone || ""}>{row.value}</dd></div>)}</dl>
      </div>}
      {!isAudio && <a className="button export-button" href={api.contentUrl(asset.id)}><Icon name="download" />导出原始资产</a>}
    </aside>
  );
}

function SettingsDialog({
  hosted,
  formats,
  enabled,
  onChange,
  detailPlacement,
  onDetailPlacementChange,
  gameLanguage,
  onGameLanguageChange,
  voiceTextPreference,
  onVoiceTextPreferenceChange,
  previewAngle,
  onPreviewAngleChange,
  mediaHeaderAlignment,
  onMediaHeaderAlignmentChange,
  sources,
  selectedSourceId,
  discoveries,
  resourcePacks,
  busy,
  onAddSource,
  onScanSource,
  onImportResourcePack,
  onExportResourcePack,
  currentVersion,
  automaticUpdateCheck,
  onAutomaticUpdateCheckChange,
  updateInfo,
  updateChecking,
  updateError,
  onCheckUpdate,
  onClose,
}: {
  hosted: boolean;
  formats: Stats["formats"];
  enabled: string[];
  onChange: (formats: string[]) => void;
  detailPlacement: DetailPlacement;
  onDetailPlacementChange: (placement: DetailPlacement) => void;
  gameLanguage: GameLanguage;
  onGameLanguageChange: (language: GameLanguage) => void;
  voiceTextPreference: VoiceTextPreference;
  onVoiceTextPreferenceChange: (preference: VoiceTextPreference) => void;
  previewAngle: PreviewAngle;
  onPreviewAngleChange: (angle: PreviewAngle) => void;
  mediaHeaderAlignment: MediaHeaderAlignment;
  onMediaHeaderAlignmentChange: (alignment: MediaHeaderAlignment) => void;
  sources: Source[];
  selectedSourceId: string;
  discoveries: GameInstallation[];
  resourcePacks: ResourcePack[];
  busy: boolean;
  onAddSource: (path: string, name: string) => Promise<void>;
  onScanSource: (sourceId: string) => Promise<void>;
  onImportResourcePack: (file: File) => Promise<void>;
  onExportResourcePack: (sourceId: string) => Promise<void>;
  currentVersion: string;
  automaticUpdateCheck: boolean;
  onAutomaticUpdateCheckChange: (enabled: boolean) => void;
  updateInfo: UpdateInfo | null;
  updateChecking: boolean;
  updateError: string;
  onCheckUpdate: () => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [packFile, setPackFile] = useState<File | null>(null);
  const enabledSet = new Set(enabled);
  const available = formats.map((item) => item.format);
  const activeSource = sources.find((source) => source.id === selectedSourceId) || null;
  const buildInfo = staticBuildInfo(currentVersion);
  function toggle(formatName: string) {
    onChange(enabledSet.has(formatName)
      ? enabled.filter((item) => item !== formatName)
      : [...enabled, formatName]);
  }
  function submitSource(event: FormEvent) {
    event.preventDefault();
    if (path.trim()) void onAddSource(path.trim(), name.trim());
  }
  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-header settings-header"><div className="dialog-icon"><Icon name="settings" /></div><div><h2 id="settings-title">设置</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭"><Icon name="close" /></button></div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
            <button type="button" onClick={() => scrollToSection("settings-display")}>显示</button>
            {!isStaticSnapshot && <button type="button" onClick={() => scrollToSection("settings-formats")}>载入类型</button>}
            {!hosted && <button type="button" onClick={() => scrollToSection("settings-sources")}>游戏目录</button>}
            {!hosted && <button type="button" onClick={() => scrollToSection("settings-packs")}>资源包</button>}
            {!isStaticSnapshot && <button type="button" onClick={() => scrollToSection("settings-updates")}>应用更新</button>}
          </nav>
          <div className="settings-content">
            {isStaticSnapshot && <div className="settings-build-info" role="status">
              <Icon name="info" size={17} />
              <span><strong>精简网页版</strong><small className="settings-build-meta">
                {buildInfo.revisionUrl
                  ? <a href={buildInfo.revisionUrl} target="_blank" rel="noreferrer" title={buildInfo.revisionTitle}>{buildInfo.revision}</a>
                  : <span>{buildInfo.revision}</span>}
                {buildInfo.stableDistance && <span>· {buildInfo.stableDistance}</span>}
                {buildInfo.updated && <span>· 更新于 {buildInfo.updated}</span>}
              </small></span>
            </div>}
            <section className="settings-section" id="settings-display">
              <header><h3>显示</h3></header>
              <div className="display-settings">
                <div className="display-setting-row">
                  <strong>详情布局</strong>
                  <div className="layout-choice" role="group" aria-label="详情区域布局">
                    <button type="button" className={detailPlacement === "bottom" ? "active" : ""} onClick={() => onDetailPlacementChange("bottom")}>上下</button>
                    <button type="button" className={detailPlacement === "right" ? "active" : ""} onClick={() => onDetailPlacementChange("right")}>左右</button>
                  </div>
                </div>
                <div className="display-setting-row">
                  <strong>游戏文本</strong>
                  <div className="layout-choice" role="group" aria-label="游戏文本语言">
                    <button type="button" className={gameLanguage === "zh-CN" ? "active" : ""} onClick={() => onGameLanguageChange("zh-CN")}>简体中文</button>
                    <button type="button" className={gameLanguage === "zh-TW" ? "active" : ""} onClick={() => onGameLanguageChange("zh-TW")}>繁體中文</button>
                  </div>
                </div>
                <div className="display-setting-row">
                  <strong>语音文本</strong>
                  <div className="layout-choice" role="group" aria-label="语音中文显示优先级">
                    <button type="button" className={voiceTextPreference === "translation" ? "active" : ""} onClick={() => onVoiceTextPreferenceChange("translation")}>译文优先</button>
                    <button type="button" className={voiceTextPreference === "game" ? "active" : ""} onClick={() => onVoiceTextPreferenceChange("game")}>游戏中文优先</button>
                  </div>
                </div>
                <div className="display-setting-row">
                  <strong>单位默认角度</strong>
                  <select className="display-setting-select" aria-label="单位默认预览角度" value={previewAngle} onChange={(event) => onPreviewAngleChange(normalizePreviewAngle(Number(event.target.value)))}>
                    {previewAngleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="display-setting-row">
                  <strong>声音分组标题</strong>
                  <div className="layout-choice" role="group" aria-label="声音分组标题对齐方式">
                    <button type="button" className={mediaHeaderAlignment === "left" ? "active" : ""} onClick={() => onMediaHeaderAlignmentChange("left")}>左对齐</button>
                    <button type="button" className={mediaHeaderAlignment === "center" ? "active" : ""} onClick={() => onMediaHeaderAlignmentChange("center")}>居中</button>
                  </div>
                </div>
              </div>
            </section>

            {!isStaticSnapshot && <section className="settings-section" id="settings-formats">
              <header><h3>载入类型</h3><span>{enabled.length} / {formats.length}</span></header>
              <div className="format-settings-actions">
                <button type="button" onClick={() => onChange(available.filter((item) => defaultVisibleFormats.includes(item)))}>常用素材</button>
                <button type="button" onClick={() => onChange(available)}>全部启用</button>
              </div>
              {formats.length > 0 ? <div className="format-checks">
                {formats.map((item) => <label key={item.format} className={enabledSet.has(item.format) ? "checked" : ""}>
                  <input type="checkbox" checked={enabledSet.has(item.format)} onChange={() => toggle(item.format)} />
                  <span className={`file-icon format-${item.format}`}><Icon name={assetIcon(item.format)} size={15} /></span>
                  <strong>{formatLabels[item.format] || item.format.toUpperCase()}</strong>
                  <em>{item.count.toLocaleString("zh-CN")}</em>
                </label>)}
              </div> : <div className="settings-empty">导入游戏目录或资源包后即可选择载入类型。</div>}
            </section>}

            {!hosted && <section className="settings-section" id="settings-sources">
              <header><h3>游戏目录</h3><span>{sources.length}</span></header>
              {sources.length > 0 && <div className="settings-source-list">
                {sources.map((source) => {
                  const fromPack = source.root_path.startsWith("resource-pack://");
                  return <article key={source.id} className={source.id === selectedSourceId ? "active" : ""}>
                    <span className="file-icon"><Icon name={fromPack ? "archive" : "folder"} size={16} /></span>
                    <div><strong>{sourceDisplayName(source)}</strong><small>{fromPack ? "派生资源包" : "原版游戏目录"} · {source.asset_count.toLocaleString("zh-CN")} 项</small></div>
                    {!fromPack && <button type="button" disabled={busy} onClick={() => void onScanSource(source.id)}>重新扫描</button>}
                  </article>;
                })}
              </div>}
              {discoveries.length > 0 && <div className="settings-discoveries">
                {discoveries.map((installation) => <button type="button" key={installation.path} disabled={busy} onClick={() => { setPath(installation.path); setName(installation.name); }}>
                  <Icon name="folder" size={16} /><span><strong>{installation.edition}</strong><small>{installation.provider} · {installation.path}</small></span><em>选择</em>
                </button>)}
              </div>}
              <form className="settings-source-form" onSubmit={submitSource}>
                <label><span>原版游戏目录</span><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="例如 D:\Games\Red Alert 2" /></label>
                <label><span>资料库名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="可选" /></label>
                <button type="submit" className="button primary" disabled={busy || !path.trim()}>{busy ? "正在处理…" : "解析目录"}</button>
              </form>
            </section>}

            {!hosted && <section className="settings-section" id="settings-packs">
              <header><h3>派生资源包</h3><span>.ra2pack</span></header>
              <div className="resource-pack-actions">
                <div className="resource-pack-import">
                  <input id="resource-pack-file" type="file" accept=".ra2pack,application/zip" onChange={(event) => setPackFile(event.target.files?.[0] || null)} />
                  <label htmlFor="resource-pack-file" className="button ghost"><Icon name="folder" />选择资源包</label>
                  <span title={packFile?.name}>{packFile?.name || "尚未选择文件"}</span>
                  <button type="button" className="button primary" disabled={busy || !packFile} onClick={() => packFile && void onImportResourcePack(packFile)}>导入</button>
                </div>
                <button type="button" className="button ghost resource-pack-export" disabled={busy || !activeSource} onClick={() => activeSource && void onExportResourcePack(activeSource.id)}><Icon name="download" />导出当前资料库</button>
              </div>
              {resourcePacks.length > 0 ? <div className="resource-pack-list">
                {resourcePacks.map((pack) => <article key={pack.filename}>
                  <Icon name="archive" size={17} /><div><strong>{libraryDisplayName(pack.source_name)}</strong><small>{pack.filename} · {formatBytes(pack.size)}</small></div><a className="button ghost" href={pack.download_url} download><Icon name="download" />下载</a>
                </article>)}
              </div> : <div className="settings-empty">尚未在本机导出派生资源包。</div>}
            </section>}

            {!isStaticSnapshot && <section className="settings-section" id="settings-updates">
              <header><h3>应用更新</h3><span>当前 {currentVersion || updateInfo?.current_version || "—"}</span></header>
              <label className="settings-toggle"><input type="checkbox" checked={automaticUpdateCheck} onChange={(event) => onAutomaticUpdateCheckChange(event.target.checked)} /><span><strong>应用启动时检查更新</strong><small>从 GitHub Releases 获取版本信息；不会自动下载或安装。</small></span></label>
              <div className="update-actions">
                <button type="button" className="button ghost" disabled={updateChecking} onClick={() => void onCheckUpdate()}>{updateChecking ? "正在检查…" : "检查更新"}</button>
                {updateInfo?.update_available && updateInfo.asset && <a className="button primary" href={updateInfo.asset.download_url} target="_blank" rel="noreferrer"><Icon name="download" />下载 {updateInfo.latest_version}</a>}
                {updateInfo && <a className="button ghost" href={updateInfo.release_url} target="_blank" rel="noreferrer">发行说明</a>}
              </div>
              {updateError && <div className="settings-message error" role="alert">{updateError}</div>}
              {updateInfo && <div className={`settings-message ${updateInfo.update_available ? "available" : "current"}`}>
                <strong>{updateInfo.update_available ? `发现 ${updateInfo.latest_version}` : "已经是最新版本"}</strong>
                {updateInfo.asset && <span>GitHub Release · {formatBytes(updateInfo.asset.size)}{updateInfo.asset.digest ? ` · ${updateInfo.asset.digest}` : ""}</span>}
                {updateInfo.notes && <p>{updateInfo.notes}</p>}
              </div>}
            </section>}
          </div>
        </div>
        <div className="dialog-actions settings-footer"><button type="button" className="button primary" disabled={busy} onClick={onClose}>完成</button></div>
      </section>
    </div>
  );
}

function DetachedEntityDetail({ sourceId, entityId }: { sourceId: string; entityId: string }) {
  const [gameLanguage] = useState<GameLanguage>(storedGameLanguage);
  const [voiceTextPreference] = useState<VoiceTextPreference>(storedVoiceTextPreference);
  const [previewAngle] = useState<PreviewAngle>(storedPreviewAngle);
  const [entity, setEntity] = useState<GameEntity | null>(null);
  const [colors, setColors] = useState<PlayerColor[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      api.entity(sourceId, entityId, gameLanguage),
      isStaticSnapshot ? Promise.resolve([] as PlayerColor[]) : api.playerColors(),
    ])
      .then(([nextEntity, nextColors]) => {
        preloadEntityAudioResources(nextEntity);
        setEntity(nextEntity);
        setColors(nextColors);
        document.title = `${nextEntity.display_name} · RA2 Explorer`;
      })
      .catch((reason: Error) => setError(reason.message));
  }, [sourceId, entityId, gameLanguage]);
  return <main className="detached-shell">{error ? <div className="detached-error">{error}</div> : <EntityDetailPanel sourceId={sourceId} entity={entity} loading={!entity} playerColors={colors} defaultPreviewAngle={previewAngle} voiceTextPreference={voiceTextPreference} wide scrollKey={`detached-entity:${sourceId}:${entityId}`} />}</main>;
}

function DetachedAssetDetail({ assetId }: { assetId: string }) {
  const [gameLanguage] = useState<GameLanguage>(storedGameLanguage);
  const [voiceTextPreference] = useState<VoiceTextPreference>(storedVoiceTextPreference);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [metadata, setMetadata] = useState<AssetMetadata | null>(null);
  const [associations, setAssociations] = useState<AssetAssociationPage | null>(null);
  const [textAsset, setTextAsset] = useState<TextAsset | null>(null);
  const [palettes, setPalettes] = useState<Asset[]>([]);
  const [colors, setColors] = useState<PlayerColor[]>([]);
  const [textQuery, setTextQuery] = useState("");
  const [frame, setFrame] = useState(0);
  const [paletteId, setPaletteId] = useState("");
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.asset(assetId)
      .then(async (nextAsset) => {
        const [nextMetadata, nextAssociations, nextPalettes, nextColors] = await Promise.all([
          api.metadata(assetId),
          api.assetAssociations(assetId, gameLanguage).catch(() => null),
          isStaticSnapshot ? Promise.resolve([] as Asset[]) : api.palettes(nextAsset.source_id),
          isStaticSnapshot ? Promise.resolve([] as PlayerColor[]) : api.playerColors(),
        ]);
        setAsset(nextAsset);
        setMetadata(nextMetadata);
        setAssociations(nextAssociations);
        setPalettes(nextPalettes);
        setColors(nextColors);
        document.title = `${nextAsset.display_name} · RA2 Explorer`;
      })
      .catch((reason: Error) => setError(reason.message));
  }, [assetId, gameLanguage]);
  useEffect(() => {
    if (!asset || !["ini", "map", "text", "csf"].includes(asset.format)) return;
    const timer = window.setTimeout(() => api.text(asset.id, textQuery).then(setTextAsset).catch(() => undefined), textQuery ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [asset, textQuery]);
  useEffect(() => {
    const playbackFrameCount = assetPlaybackFrameCount(asset?.format, metadata);
    if (!playing || !asset || !["shp", "hva"].includes(asset.format) || playbackFrameCount < 2) return;
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % playbackFrameCount), asset.format === "hva" ? 350 : 140);
    return () => window.clearInterval(timer);
  }, [playing, asset, metadata]);
  const previewUrl = asset && imageFormats.includes(asset.format)
    ? api.previewUrl(asset.id, frame, paletteId, asset.format === "pcx" ? 1 : asset.format === "shp" ? 5 : 4)
    : "";
  return <main className="detached-shell">{error ? <div className="detached-error">{error}</div> : <DetailPanel asset={asset} metadata={metadata} textAsset={textAsset} textQuery={textQuery} setTextQuery={setTextQuery} frame={frame} setFrame={setFrame} playing={playing} setPlaying={setPlaying} palettes={palettes} paletteId={paletteId} setPaletteId={setPaletteId} playerColors={colors} previewUrl={previewUrl} associations={associations} voiceTextPreference={voiceTextPreference} wide scrollKey={`detached-asset:${assetId}`} />}</main>;
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const detail = params.get("detail");
  if (detail === "entity" && params.get("source_id") && params.get("entity_id")) {
    return <DetachedEntityDetail sourceId={params.get("source_id")!} entityId={params.get("entity_id")!} />;
  }
  if (detail === "asset" && params.get("asset_id")) {
    return <DetachedAssetDetail assetId={params.get("asset_id")!} />;
  }
  return <ExplorerApp />;
}

export default App;
