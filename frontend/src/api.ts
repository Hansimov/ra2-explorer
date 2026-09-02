import {
  isStaticSnapshot,
  staticAssetModelUrl,
  staticAssetPreviewUrl,
  staticAudioUrl,
  staticEntityModelUrl,
  staticEntityPreviewUrl,
  staticEntityThumbnailAtlasFallbackUrl,
  staticEntityThumbnailAtlasUrl,
  staticSnapshotRequest,
} from "./staticSnapshot";

export { isStaticSnapshot, staticPopoutUrl } from "./staticSnapshot";

export type SourceState = "new" | "scanning" | "ready" | "ready_with_errors" | "failed";

export interface Source {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  scanned_at: string | null;
  state: SourceState;
  error: string | null;
  archive_count: number;
  asset_count: number;
}

export interface Asset {
  id: string;
  source_id: string;
  archive_id: string | null;
  archive_path: string | null;
  ordinal: number | null;
  virtual_path: string;
  name: string | null;
  display_name: string;
  crc: number | null;
  size: number;
  format: string;
  extension: string;
  confidence: string;
  storage_kind: "mix" | "loose" | "bag";
  loose_relative_path: string | null;
}

export interface AssetPage {
  items: Asset[];
  total: number;
}

export interface FormatCount {
  format: string;
  count: number;
}

export interface Stats {
  total_assets: number;
  formats: FormatCount[];
  media_kinds?: Array<{ kind: MediaKind; count: number }>;
  media_groups?: Array<{ group: string; count: number }>;
  media_event_types?: Array<{ event_type: string; count: number }>;
}

export interface AppInfo {
  status: "ok";
  name: string;
  version: string;
  pid: number;
  mode: "local" | "hosted";
  edition?: "full" | "pages";
}

export interface ShpFrame {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  compression: number;
  content_bounds?: { x: number; y: number; width: number; height: number } | null;
  paired_shadow_frame?: number | null;
}

export interface ShpMetadata {
  width: number;
  height: number;
  frame_count: number;
  frames: ShpFrame[];
}

export interface AssetMetadata {
  format: string;
  size: number;
  width?: number;
  height?: number;
  frame_count?: number;
  frames?: ShpFrame[];
  file_name?: string;
  limb_count?: number;
  voxel_count?: number;
  limbs?: Array<{ index: number; name: string; size: number[]; voxel_count: number; normals_mode: number }>;
  tile_count?: number;
  template_width?: number;
  template_height?: number;
  section_count?: number;
  section_names?: string[];
  entry_count?: number;
  label_count?: number;
  string_count?: number;
  encoding?: string;
  channels?: number;
  sample_rate?: number;
  bits_per_sample?: number;
  duration_seconds?: number;
  audio_format?: number;
  playback_transcodes_to_pcm?: boolean;
  audio_codec?: string;
  chunk_count?: number;
  color_count?: number;
  mode?: string;
  theater?: string | null;
  object_counts?: Record<string, number>;
}

export interface TextAsset {
  format: string;
  text: string;
  line_count: number;
  returned_lines: number;
  truncated: boolean;
  encoding?: string;
  section_count?: number;
  entry_count?: number;
  label_count?: number;
  string_count?: number;
}

export interface GameInstallation {
  path: string;
  name: string;
  provider: string;
  edition: string;
  markers: string[];
}

export interface DiscoveryResult {
  candidates: GameInstallation[];
  checked_locations: string[];
  official_sources: Array<{ provider: string; url: string }>;
}

export interface ResourcePack {
  filename: string;
  size: number;
  created_at?: string | null;
  source_id: string;
  source_name: string;
  asset_count: number;
  artifact_files?: number;
  artifact_bytes?: number;
  download_url: string;
}

export interface ResourcePackImportResult {
  source: Source;
  imported: boolean;
  installed_files: number;
  reused_files: number;
  installed_bytes: number;
}

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  published_at: string | null;
  notes: string;
  provider: "github";
  asset: {
    name: string;
    size: number;
    digest: string | null;
    download_url: string;
  } | null;
}

export type EntityKind = "vehicle" | "infantry" | "aircraft" | "building";
export type EntityUsage = "buildable" | "hero" | "tech" | "civilian" | "scenario";
export type GameLanguage = "zh-CN" | "zh-TW";

export interface EntityThumbnailAtlas {
  path: string;
  index: number;
  columns: number;
  cell_width: number;
  cell_height: number;
  facing_count: number;
  content_bounds?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  usage: EntityUsage;
  display_name: string;
  internal_name: string;
  ui_name: string | null;
  search_aliases: {
    pinyin: string;
    pinyin_compact: string;
    pinyin_initials: string;
  } | null;
  image: string;
  voxel: boolean;
  renderable: boolean;
  body_status: "available" | "not_defined" | "missing";
  component_count: number;
  body_format: string | null;
  facing_format: "vxl" | "shp" | null;
  media_kinds: Array<"voice" | "sound" | "animation">;
  media_count: number;
  cost: string | null;
  strength: string | null;
  tech_level?: string | null;
  ai_base_planning_side?: string | null;
  naval?: boolean;
  considered_aircraft?: boolean;
  owner: string | null;
  primary: string | null;
  countries: string[];
  sides: string[];
  affiliation: {
    kind: "country" | "side";
    id: string;
    display_name: string;
    icon: EntityComponentAsset | null;
  } | null;
  thumbnail_atlas?: EntityThumbnailAtlas;
  search_thumbnail_atlas?: EntityThumbnailAtlas;
}

export type AssetSort = "name_asc" | "name_desc" | "size_desc" | "size_asc";

export interface EntityComponentAsset {
  id: string;
  display_name: string;
  format: string;
  virtual_path: string;
  size: number;
  storage_kind: "mix" | "loose" | "bag";
}

export interface EntityComponent {
  role: string;
  expected_name: string;
  asset: EntityComponentAsset | null;
}

export type EntityDependencyKind = "weapon" | "projectile" | "warhead";

export interface EntityDependency {
  id: string;
  kind: EntityDependencyKind;
  slot: string;
  parent: string | null;
  resolved: boolean;
  properties: Record<string, string>;
}

export interface EntityPreview {
  format: "vxl" | "shp" | null;
  facing_format: "vxl" | "shp" | null;
  frame_count: number;
  facing_count: number;
  supports_facing: boolean;
  supports_player_color: boolean;
  width?: number;
  height?: number;
  limb_count?: number;
  voxel_count?: number;
  source_frame_count?: number;
  frame_indices?: number[];
  remap_range?: number[];
  warnings?: string[];
}

export interface GameEntity extends EntitySummary {
  rules: Record<string, string>;
  art: Record<string, string>;
  components: EntityComponent[];
  dependencies: EntityDependency[];
  media: MediaAssociation[];
  preview: EntityPreview;
}

export interface AnimationPlayback {
  start_frame: number;
  frame_count: number | null;
  facing_step: number;
  frame_step: number;
  rate_ms: number | null;
  loop_start: number | null;
  loop_end: number | null;
  loop_count: number | null;
  direction: string | null;
  shadow: boolean;
  reverse: boolean;
}

export interface MediaSample {
  name: string;
  text: string | null;
  original_text: string | null;
  localized_text: string | null;
  text_label: string | null;
  asset: EntityComponentAsset | null;
  animation: AnimationPlayback | null;
  weight: number;
  palette: "unit" | "animation" | null;
}

export interface MediaAssociation {
  kind: "voice" | "sound" | "animation";
  slot: string;
  event: string;
  source: string;
  role: "body" | "construction" | "operation" | "weapon" | "impact" | "destruction" | "debris" | null;
  aliases?: string[];
  selection: "damage" | "random" | "first" | null;
  selected_sample: string | null;
  selection_value: number | null;
  rule_field: string | null;
  samples: MediaSample[];
}

export interface AssetAssociation {
  scope: "entity" | "event";
  kind: string;
  slot: string;
  event: string;
  entity: EntitySummary | null;
  text: string | null;
  original_text: string | null;
  localized_text: string | null;
}

export interface AssetAssociationPage {
  items: AssetAssociation[];
  total: number;
  texts: string[];
  original_texts: string[];
  localized_texts: string[];
}

export interface EntityPage {
  items: EntitySummary[];
  total: number;
  kinds: Array<{ kind: EntityKind; count: number }>;
  usages: Array<{ usage: EntityUsage; count: number }>;
  countries: Array<{ id: string; display_name: string; side: string; count: number }>;
  sides: Array<{ id: string; count: number }>;
  warnings: string[];
}

export type MediaKind = "voice" | "sound" | "unknown";
export type MediaSort = "name_asc" | "name_desc" | "description_asc";

export interface MediaItem {
  asset: EntityComponentAsset;
  kind: MediaKind;
  groups: string[];
  texts: string[];
  original_texts: string[];
  localized_texts: string[];
  events: string[];
  slots: string[];
  entities: Array<{
    id: string;
    display_name: string;
    kind: EntityKind;
    affiliation: {
      kind: "country" | "side";
      id: string;
      display_name: string;
    } | null;
  }>;
  countries: string[];
  sides: string[];
  mission?: {
    key: string;
    game: "ra2" | "yr";
    campaign: "allied" | "soviet" | "tutorial" | "coop";
    number: number;
  } | null;
  description: string | null;
  search_aliases?: {
    pinyin_compact: string[];
    pinyin_initials: string[];
  };
}

export interface MediaPage {
  items: MediaItem[];
  total: number;
  kinds: Array<{ kind: MediaKind; count: number }>;
  groups: Array<{ group: string; count: number }>;
  event_types: Array<{ event_type: string; count: number }>;
}

export interface EntityListOptions {
  query?: string;
  kind?: EntityKind | "";
  kinds?: EntityKind[];
  usage?: EntityUsage | "";
  usages?: EntityUsage[];
  side?: string;
  renderable?: "" | "true" | "false";
  language?: GameLanguage;
}

export interface MediaListOptions {
  query?: string;
  kind?: MediaKind;
  group?: string;
  eventType?: string;
  offset?: number;
  limit?: number;
  sort?: MediaSort;
  language?: GameLanguage;
}

export interface SemanticDiagnostics {
  status: "ready" | "empty";
  entity_count: number;
  renderable_count: number;
  renderable_percent: number;
  localized_count: number;
  localized_percent: number;
  component_count: number;
  resolved_component_count: number;
  component_percent: number;
  dependency_count: number;
  unresolved_dependency_count: number;
  kinds: Array<{ kind: EntityKind; count: number; renderable_count: number }>;
  missing_components: Array<{ role: string; count: number }>;
  warnings: string[];
}

export interface PlayerColor {
  id: string;
  rgb: number[];
  hex: string;
}

export interface EntityPreviewOptions {
  frame?: number;
  facing?: number;
  playerColor?: string;
  paletteId?: string;
  scale?: number;
  thumbnail?: boolean;
  compact?: boolean;
  effectAssetId?: string;
  effectFrame?: number;
  effectShadowFrame?: number;
  effectPalette?: "unit" | "animation";
  revision?: string;
}

export interface ReferenceStatus {
  available: boolean;
  manifest_valid?: boolean;
  repository?: string;
  revision?: string;
  downloaded_at?: string;
  name_count?: number;
  builtin_name_count?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (isStaticSnapshot) return await staticSnapshotRequest<T>(path, init);
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the status-based fallback when the response is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

const detailRequestCache = new Map<string, Promise<unknown>>();
const DETAIL_REQUEST_CACHE_LIMIT = 256;

function cachedRequest<T>(path: string): Promise<T> {
  const cached = detailRequestCache.get(path) as Promise<T> | undefined;
  if (cached) {
    detailRequestCache.delete(path);
    detailRequestCache.set(path, cached);
    return cached;
  }
  const pending = request<T>(path).catch((reason) => {
    detailRequestCache.delete(path);
    throw reason;
  });
  detailRequestCache.set(path, pending);
  while (detailRequestCache.size > DETAIL_REQUEST_CACHE_LIMIT) {
    const oldest = detailRequestCache.keys().next().value as string | undefined;
    if (!oldest) break;
    detailRequestCache.delete(oldest);
  }
  return pending;
}

function withRevision(path: string, revision: string) {
  if (!revision) return path;
  return `${path}${path.includes("?") ? "&" : "?"}r=${encodeURIComponent(revision)}`;
}

export const api = {
  health: () => request<AppInfo>("/api/health"),
  sources: () => request<Source[]>("/api/sources"),
  discovery: () => request<DiscoveryResult>("/api/discovery"),
  addSource: (path: string, name?: string) =>
    request<Source>("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name: name || null }),
    }),
  scanSource: (id: string) => request<Source>(`/api/sources/${id}/scan`, { method: "POST" }),
  resourcePacks: () => request<ResourcePack[]>("/api/resource-packs"),
  exportResourcePack: (sourceId: string) =>
    request<ResourcePack>("/api/resource-packs/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: sourceId }),
    }),
  importResourcePack: (file: File) =>
    request<ResourcePackImportResult>(
      `/api/resource-packs/import?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    ),
  latestUpdate: () => request<UpdateInfo>("/api/updates/latest"),
  assets: (
    sourceId: string,
    query: string,
    formats: string[],
    offset = 0,
    limit = 500,
    sort: AssetSort = "name_asc",
  ) => {
    const params = new URLSearchParams({
      source_id: sourceId,
      limit: String(limit),
      offset: String(offset),
      sort,
    });
    if (query.trim()) params.set("q", query.trim());
    if (formats.length) params.set("formats", formats.join(","));
    return request<AssetPage>(`/api/assets?${params}`);
  },
  entities: (sourceId: string, options: EntityListOptions = {}) => {
    const params = new URLSearchParams({ source_id: sourceId, limit: "1000" });
    if (options.query?.trim()) params.set("q", options.query.trim());
    if (options.kind) params.set("kind", options.kind);
    if (options.kinds?.length) params.set("kinds", options.kinds.join(","));
    if (options.usage) params.set("usage", options.usage);
    if (options.usages?.length) params.set("usages", options.usages.join(","));
    if (options.side) params.set("side", options.side);
    if (options.renderable) params.set("renderable", options.renderable);
    params.set("language", options.language ?? "zh-CN");
    return request<EntityPage>(`/api/entities?${params}`);
  },
  media: (sourceId: string, options: MediaListOptions = {}) => {
    const params = new URLSearchParams({
      source_id: sourceId,
      limit: String(options.limit ?? 500),
      offset: String(options.offset ?? 0),
      sort: options.sort ?? "name_asc",
    });
    if (options.query?.trim()) params.set("q", options.query.trim());
    if (options.kind) params.set("kind", options.kind);
    if (options.group) params.set("group", options.group);
    if (options.eventType) params.set("event_type", options.eventType);
    params.set("language", options.language ?? "zh-CN");
    return request<MediaPage>(`/api/media?${params}`);
  },
  entity: (sourceId: string, entityId: string, language: GameLanguage = "zh-CN", revision = "") =>
    cachedRequest<GameEntity>(
      withRevision(
        `/api/entities/${encodeURIComponent(sourceId)}/${encodeURIComponent(entityId)}?language=${encodeURIComponent(language)}`,
        revision,
      ),
    ).then((entity) => ({
      ...entity,
      body_format: entity.body_format ?? entity.components?.find((item) => item.role === "body")?.asset?.format ?? null,
      media_kinds: entity.media_kinds ?? [],
      media_count: entity.media_count ?? entity.media?.length ?? 0,
      components: entity.components ?? [],
      dependencies: entity.dependencies ?? [],
      media: entity.media ?? [],
      countries: entity.countries ?? [],
      sides: entity.sides ?? [],
      rules: entity.rules ?? {},
      art: entity.art ?? {},
      preview: entity.preview ?? {
        format: null,
        frame_count: 1,
        facing_count: 1,
        supports_facing: false,
        supports_player_color: false,
      },
    })),
  asset: (id: string, revision = "") => cachedRequest<Asset>(withRevision(`/api/assets/${id}`, revision)),
  assetAssociations: (id: string, language: GameLanguage = "zh-CN", revision = "") =>
    cachedRequest<AssetAssociationPage>(
      withRevision(
        `/api/assets/${id}/associations?language=${encodeURIComponent(language)}`,
        revision,
      ),
    ),
  stats: (sourceId: string) => request<Stats>(`/api/stats?source_id=${encodeURIComponent(sourceId)}`),
  palettes: (sourceId: string) =>
    request<Asset[]>(`/api/palettes?source_id=${encodeURIComponent(sourceId)}`),
  semanticDiagnostics: (sourceId: string) =>
    request<SemanticDiagnostics>(
      `/api/semantic/${encodeURIComponent(sourceId)}/diagnostics?limit=8`,
    ),
  playerColors: () => request<PlayerColor[]>("/api/player-colors"),
  shp: (assetId: string) => request<ShpMetadata>(`/api/assets/${assetId}/shp`),
  metadata: (assetId: string, revision = "") => cachedRequest<AssetMetadata>(
    withRevision(`/api/assets/${assetId}/metadata`, revision),
  ),
  text: (assetId: string, query = "") => {
    const params = new URLSearchParams({ limit: "400" });
    if (query.trim()) params.set("q", query.trim());
    return request<TextAsset>(`/api/assets/${assetId}/text?${params}`);
  },
  referenceStatus: () => request<ReferenceStatus>("/api/reference-data"),
  syncNames: () =>
    request<ReferenceStatus>("/api/reference-data/names/sync", { method: "POST" }),
  contentUrl: (assetId: string) => isStaticSnapshot
    ? staticAudioUrl(assetId)
    : `/api/assets/${assetId}/content`,
  mediaUrl: (assetId: string) => isStaticSnapshot
    ? staticAudioUrl(assetId)
    : `/api/assets/${assetId}/media`,
  videoUrl: (assetId: string) => `/api/assets/${assetId}/video.mp4`,
  entityPreviewUrl: (
    sourceId: string,
    entityId: string,
    options: EntityPreviewOptions = {},
  ) => {
    if (isStaticSnapshot) return staticEntityPreviewUrl(entityId, options);
    const params = new URLSearchParams({
      frame: String(options.frame ?? 0),
      facing: String(options.facing ?? 0),
      scale: String(options.scale ?? 4),
      v: "13",
    });
    if (options.playerColor) params.set("player_color", options.playerColor);
    if (options.paletteId) params.set("palette_id", options.paletteId);
    if (options.thumbnail) params.set("thumbnail", "true");
    if (options.compact) params.set("compact", "true");
    if (options.effectAssetId) params.set("effect_asset_id", options.effectAssetId);
    if (options.effectFrame !== undefined) params.set("effect_frame", String(options.effectFrame));
    if (options.effectShadowFrame !== undefined) params.set("effect_shadow_frame", String(options.effectShadowFrame));
    if (options.effectPalette) params.set("effect_palette_kind", options.effectPalette);
    if (options.revision) params.set("r", options.revision);
    return `/api/entities/${encodeURIComponent(sourceId)}/${encodeURIComponent(entityId)}/preview.png?${params}`;
  },
  entityThumbnailAtlasUrl: (path: string, facing: number) => isStaticSnapshot
    ? staticEntityThumbnailAtlasUrl(path, facing)
    : "",
  entityThumbnailAtlasFallbackUrl: (path: string, facing: number) => isStaticSnapshot
    ? staticEntityThumbnailAtlasFallbackUrl(path, facing)
    : "",
  entityModelUrl: (
    sourceId: string,
    entityId: string,
    options: EntityPreviewOptions = {},
  ) => {
    if (isStaticSnapshot) return staticEntityModelUrl(entityId, options.frame ?? 0);
    const params = new URLSearchParams({ frame: String(options.frame ?? 0), v: "5" });
    if (options.playerColor) params.set("player_color", options.playerColor);
    if (options.paletteId) params.set("palette_id", options.paletteId);
    if (options.revision) params.set("r", options.revision);
    return `/api/entities/${encodeURIComponent(sourceId)}/${encodeURIComponent(entityId)}/model.json?${params}`;
  },
  assetModelUrl: (assetId: string, frame = 0, playerColor = "", paletteId = "") => {
    if (isStaticSnapshot) return staticAssetModelUrl(assetId, frame);
    const params = new URLSearchParams({ frame: String(frame), v: "5" });
    if (playerColor) params.set("player_color", playerColor);
    if (paletteId) params.set("palette_id", paletteId);
    return `/api/assets/${assetId}/model.json?${params}`;
  },
  previewUrl: (
    assetId: string,
    frame: number,
    paletteId: string,
    scale = 4,
    playerColor = "",
    options: { palette?: "unit" | "animation"; shadowFrame?: number } = {},
  ) => {
    if (isStaticSnapshot) return staticAssetPreviewUrl(assetId, frame, options.palette, options.shadowFrame);
    const params = new URLSearchParams({ frame: String(frame), scale: String(scale) });
    if (paletteId) params.set("palette_id", paletteId);
    if (playerColor) params.set("player_color", playerColor);
    if (options.palette) params.set("palette_kind", options.palette);
    if (options.shadowFrame !== undefined) params.set("shadow_frame", String(options.shadowFrame));
    return `/api/assets/${assetId}/preview.png?${params}`;
  },
};
