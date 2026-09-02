import type {
  AppInfo,
  Asset,
  AssetAssociationPage,
  AssetMetadata,
  EntityPage,
  EntitySummary,
  GameEntity,
  GameLanguage,
  MediaItem,
  MediaPage,
  ReferenceStatus,
  SemanticDiagnostics,
  Source,
  Stats,
} from "./api";

export const isStaticSnapshot = import.meta.env.VITE_RA2EXP_STATIC_SNAPSHOT === "1";

const externalSnapshotBase = (import.meta.env.VITE_RA2EXP_STATIC_CDN_BASE || "")
  .trim()
  .replace(/\/+$/, "");

interface StaticAssetBundle {
  asset: Asset;
  metadata: AssetMetadata;
  associations: Record<GameLanguage, AssetAssociationPage>;
}

interface StaticSnapshotManifest {
  schema_version: 1 | 2;
  snapshot_id: string;
  created_at: string;
  app_version: string;
  edition: "pages-slim";
  included: Array<"units" | "sounds">;
  source: Source;
  stats: Stats;
  diagnostics: SemanticDiagnostics;
  reference_status: ReferenceStatus;
}

function requireContent(manifest: StaticSnapshotManifest, content: "units" | "sounds") {
  if (!manifest.included.includes(content)) {
    throw new Error(`精简网页版未包含${content === "units" ? "单位" : "声音"}资料`);
  }
}

const jsonCache = new Map<string, Promise<unknown>>();

function publicUrl(path: string) {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

function localSnapshotUrl(path: string) {
  return publicUrl(`data/${path}`);
}

function isExternalSnapshotPath(path: string) {
  const normalized = path.replace(/^\/+/, "");
  return normalized === "manifest.json"
    || normalized.startsWith("catalog/")
    || normalized.startsWith("previews/entity-atlases/")
    || normalized.startsWith("previews/entity-search-atlases/");
}

function snapshotUrl(path: string) {
  const normalized = path.replace(/^\/+/, "");
  return externalSnapshotBase && isExternalSnapshotPath(normalized)
    ? `${externalSnapshotBase}/${normalized}`
    : localSnapshotUrl(normalized);
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`静态资料载入失败（${response.status}）`);
  return await response.json() as T;
}

function loadJson<T>(path: string): Promise<T> {
  let pending = jsonCache.get(path) as Promise<T> | undefined;
  if (!pending) {
    const primaryUrl = snapshotUrl(path);
    const fallbackUrl = localSnapshotUrl(path);
    pending = fetchJson<T>(primaryUrl).catch((primaryError: unknown) => {
      if (primaryUrl === fallbackUrl) throw primaryError;
      return fetchJson<T>(fallbackUrl);
    });
    pending.catch(() => jsonCache.delete(path));
    jsonCache.set(path, pending);
  }
  return pending;
}

function languageFrom(params: URLSearchParams): GameLanguage {
  return params.get("language") === "zh-TW" ? "zh-TW" : "zh-CN";
}

function otherLanguage(language: GameLanguage): GameLanguage {
  return language === "zh-CN" ? "zh-TW" : "zh-CN";
}

function searchText(value: unknown) {
  return JSON.stringify(value)?.toLocaleLowerCase() || "";
}

function normalizeSearchText(value: string) {
  return [...value.toLocaleLowerCase().replaceAll("砲", "炮")]
    .filter((character) => /[\p{L}\p{N}]/u.test(character)).join("");
}

function searchQueryTokens(value: string) {
  const tokens: string[] = [];
  let current = "";
  let currentKind: "han" | "other" | "" = "";
  for (const character of value.toLocaleLowerCase()) {
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

function allowsFuzzyMatch(value: string) {
  return value.length >= (/\p{Script=Han}/u.test(value) ? 2 : 4);
}

function boundedSubsequence(needle: string, haystack: string) {
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

function singleEditOrTransposition(left: string, right: string) {
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

function nearbySingleEdit(needle: string, haystack: string) {
  const hasHan = /\p{Script=Han}/u.test(needle);
  if (needle.length < (hasHan ? 3 : 5)) return false;
  for (let width = Math.max(1, needle.length - 1); width <= needle.length + 1; width += 1) {
    for (let start = 0; start + width <= haystack.length; start += 1) {
      if (singleEditOrTransposition(needle, haystack.slice(start, start + width))) return true;
    }
  }
  return false;
}

function fuzzyEntityMatch(query: string, item: EntityPage["items"][number] | undefined) {
  const needle = normalizeSearchText(query);
  if (!item || !allowsFuzzyMatch(needle)) return false;
  return [
    item.id,
    item.display_name,
    item.internal_name,
    item.ui_name || "",
    item.image,
    item.search_aliases?.pinyin_compact || "",
    item.search_aliases?.pinyin_initials || "",
  ].some((value) => {
    const haystack = normalizeSearchText(value);
    return haystack.length <= Math.max(64, needle.length * 8)
      && (boundedSubsequence(needle, haystack) || nearbySingleEdit(needle, haystack));
  });
}

function entitySearchTokenMatch(token: string, item: EntityPage["items"][number] | undefined) {
  return Boolean(item) && (searchText(item).includes(token) || fuzzyEntityMatch(token, item));
}

function mediaSearchValues(item: MediaItem) {
  return [
    item.asset.display_name,
    item.description || "",
    ...item.texts,
    ...item.original_texts,
    ...item.localized_texts,
    ...item.events,
    ...item.slots,
    ...(item.mission ? [item.mission.key, item.mission.game, item.mission.campaign, String(item.mission.number)] : []),
    ...item.entities.flatMap((entity) => [entity.id, entity.display_name, entity.affiliation?.display_name || ""]),
  ];
}

function mediaSearchTokenMatch(token: string, item: MediaItem | undefined) {
  if (!item) return false;
  if (searchText(item).includes(token)) return true;
  const needle = normalizeSearchText(token);
  if (allowsFuzzyMatch(needle) && mediaSearchValues(item).some((value) => {
    const haystack = normalizeSearchText(value);
    return haystack.length <= Math.max(64, needle.length * 8)
      && (boundedSubsequence(needle, haystack) || nearbySingleEdit(needle, haystack));
  })) return true;
  if (!/^[a-z0-9]+$/i.test(needle) || needle.length < 2) return false;
  return [
    ...(item.search_aliases?.pinyin_compact || []),
    ...(item.search_aliases?.pinyin_initials || []),
  ].some((alias) => alias.includes(needle)
    || (needle.length >= 4 && boundedSubsequence(needle, alias)));
}

function commaValues(params: URLSearchParams, key: string) {
  return new Set((params.get(key) || "").split(",").map((value) => value.trim()).filter(Boolean));
}

function countBy<T>(items: T[], values: (item: T) => string[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const value of values(item)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function entityFactionIds(item: EntityPage["items"][number]) {
  if (!item.affiliation) return ["unaffiliated"];
  if (item.affiliation.kind === "side" && item.affiliation.id) return [item.affiliation.id];
  if (item.affiliation.kind === "country" && item.sides.length === 1) return item.sides;
  return ["unaffiliated"];
}

async function manifest() {
  return await loadJson<StaticSnapshotManifest>("manifest.json");
}

async function entityCatalog(language: GameLanguage) {
  return await loadJson<EntityPage>(`catalog/entities.${language}.json`);
}

async function mediaCatalog(language: GameLanguage) {
  return await loadJson<MediaPage>(`catalog/media.${language}.json`);
}

async function filterEntities(params: URLSearchParams): Promise<EntityPage> {
  const language = languageFrom(params);
  const catalog = await entityCatalog(language);
  let items = [...catalog.items];
  const renderable = params.get("renderable");
  if (renderable) items = items.filter((item) => item.renderable === (renderable === "true"));
  const kindCounts = countBy(items, (item) => [item.kind]);
  const kind = params.get("kind");
  const kinds = commaValues(params, "kinds");
  if (kinds.size) items = items.filter((item) => kinds.has(item.kind));
  else if (kind) items = items.filter((item) => item.kind === kind);
  const query = params.get("q")?.trim().toLocaleLowerCase();
  if (query) {
    const tokens = searchQueryTokens(query);
    const alternate = await entityCatalog(otherLanguage(language));
    const alternateById = new Map(alternate.items.map((item) => [item.id, item]));
    items = items.filter((item) => tokens.every((token) => (
      entitySearchTokenMatch(token, item)
      || entitySearchTokenMatch(token, alternateById.get(item.id))
    )));
  }
  const usageCounts = countBy(items, (item) => [item.usage]);
  const usage = params.get("usage");
  const usages = commaValues(params, "usages");
  if (usages.size) items = items.filter((item) => usages.has(item.usage));
  else if (usage) items = items.filter((item) => item.usage === usage);
  const countryCounts = countBy(items, (item) => item.countries);
  const sideCounts = countBy(items, entityFactionIds);
  const side = params.get("side")?.toLocaleLowerCase();
  if (side) items = items.filter((item) => entityFactionIds(item).some((value) => value.toLocaleLowerCase() === side));
  const offset = Math.max(0, Number(params.get("offset") || 0));
  const limit = Math.max(1, Number(params.get("limit") || 1000));
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    kinds: catalog.kinds.map((item) => ({ ...item, count: kindCounts.get(item.kind) || 0 })),
    usages: catalog.usages
      .map((item) => ({ ...item, count: usageCounts.get(item.usage) || 0 }))
      .filter((item) => item.count > 0),
    countries: catalog.countries
      .map((item) => ({ ...item, count: countryCounts.get(item.id) || 0 }))
      .filter((item) => item.count > 0),
    sides: [...sideCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
      .filter(([id]) => Boolean(id))
      .map(([id, count]) => ({ id, count })),
    warnings: catalog.warnings,
  };
}

function mediaName(item: MediaItem) {
  return item.asset.display_name.toLocaleLowerCase();
}

async function filterMedia(params: URLSearchParams): Promise<MediaPage> {
  const language = languageFrom(params);
  const catalog = await mediaCatalog(language);
  const allItems = catalog.items;
  const kindCounts = countBy(allItems, (item) => [item.kind]);
  const groupCounts = countBy(allItems, (item) => item.groups);
  let items = [...allItems];
  const kind = params.get("kind");
  if (kind) items = items.filter((item) => item.kind === kind);
  const group = params.get("group");
  if (group) items = items.filter((item) => item.groups.includes(group));
  const query = params.get("q")?.trim().toLocaleLowerCase();
  if (query) {
    const tokens = searchQueryTokens(query);
    const alternate = await mediaCatalog(otherLanguage(language));
    const alternateById = new Map(alternate.items.map((item) => [item.asset.id, item]));
    items = items.filter((item) => tokens.every((token) => (
      mediaSearchTokenMatch(token, item)
      || mediaSearchTokenMatch(token, alternateById.get(item.asset.id))
    )));
  }
  const eventCounts = countBy(items, (item) => item.slots);
  const eventType = params.get("event_type");
  if (eventType) items = items.filter((item) => item.slots.includes(eventType));
  const sort = params.get("sort") || "name_asc";
  items.sort((left, right) => {
    if (sort === "description_asc") {
      const leftDescription = left.description || "\uffff";
      const rightDescription = right.description || "\uffff";
      return leftDescription.localeCompare(rightDescription, language, { numeric: true })
        || mediaName(left).localeCompare(mediaName(right), language, { numeric: true });
    }
    const compared = mediaName(left).localeCompare(mediaName(right), language, { numeric: true });
    return sort === "name_desc" ? -compared : compared;
  });
  const offset = Math.max(0, Number(params.get("offset") || 0));
  const limit = Math.max(1, Number(params.get("limit") || 500));
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    kinds: ["voice", "sound", "unknown"].map((value) => ({
      kind: value as MediaPage["kinds"][number]["kind"],
      count: kindCounts.get(value) || 0,
    })),
    groups: [...groupCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([value, count]) => ({ group: value, count })),
    event_types: [...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([value, count]) => ({ event_type: value, count })),
  };
}

function assetBundle(assetId: string) {
  return loadJson<StaticAssetBundle>(`assets/${encodeURIComponent(assetId)}.json`);
}

export async function staticSnapshotRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== "GET") throw new Error("精简网页版不支持修改本地资料");
  const url = new URL(path, window.location.origin);
  const route = url.pathname;
  const currentManifest = await manifest();
  if (route === "/api/health") {
    return {
      status: "ok",
      name: "ra2-explorer",
      version: currentManifest.app_version,
      pid: 0,
      mode: "hosted",
      edition: "pages",
    } as T;
  }
  if (route === "/api/sources") return [currentManifest.source] as T;
  if (route === "/api/stats") {
    requireContent(currentManifest, "sounds");
    return currentManifest.stats as T;
  }
  if (route === "/api/reference-data") return currentManifest.reference_status as T;
  if (route.includes("/api/semantic/") && route.endsWith("/diagnostics")) return currentManifest.diagnostics as T;
  if (route === "/api/entities") {
    requireContent(currentManifest, "units");
    return await filterEntities(url.searchParams) as T;
  }
  if (route === "/api/media") {
    requireContent(currentManifest, "sounds");
    return await filterMedia(url.searchParams) as T;
  }

  const entityMatch = route.match(/^\/api\/entities\/[^/]+\/([^/]+)$/);
  if (entityMatch) {
    const language = languageFrom(url.searchParams);
    return await loadJson<GameEntity>(
      `entities/${language}/${encodeURIComponent(decodeURIComponent(entityMatch[1]))}.json`,
    ) as T;
  }
  const metadataMatch = route.match(/^\/api\/assets\/([^/]+)\/metadata$/);
  if (metadataMatch) return (await assetBundle(decodeURIComponent(metadataMatch[1]))).metadata as T;
  const associationMatch = route.match(/^\/api\/assets\/([^/]+)\/associations$/);
  if (associationMatch) {
    const bundle = await assetBundle(decodeURIComponent(associationMatch[1]));
    return bundle.associations[languageFrom(url.searchParams)] as T;
  }
  const assetMatch = route.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch) return (await assetBundle(decodeURIComponent(assetMatch[1]))).asset as T;
  throw new Error(`精简网页版未包含此资源：${route}`);
}

export function staticAudioUrl(assetId: string) {
  return snapshotUrl(`audio/${encodeURIComponent(assetId)}.ogg`);
}

export function staticEntityPreviewUrl(
  entityId: string,
  options: {
    frame?: number;
    facing?: number;
    thumbnail?: boolean;
    effectAssetId?: string;
    effectFrame?: number;
    effectShadowFrame?: number;
    effectPalette?: "unit" | "animation";
  },
) {
  const facing = options.facing ?? 0;
  if (options.effectAssetId) {
    const palette = options.effectPalette || "auto";
    const shadow = options.effectShadowFrame ?? "none";
    return snapshotUrl(
      `previews/entities/${encodeURIComponent(entityId)}/effects/${encodeURIComponent(options.effectAssetId)}/${palette}/${facing}/${options.effectFrame ?? 0}-shadow-${shadow}.webp`,
    );
  }
  const variant = options.thumbnail ? "thumbnail" : "frame";
  return snapshotUrl(
    `previews/entities/${encodeURIComponent(entityId)}/${variant}/${facing}/${options.frame ?? 0}.webp`,
  );
}

export function staticEntityThumbnailAtlasUrl(path: string, facing: number) {
  return snapshotUrl(path.replace("{facing}", String(facing)));
}

export function staticEntityThumbnailAtlasFallbackUrl(path: string, facing: number) {
  return localSnapshotUrl(path.replace("{facing}", String(facing)));
}

export function staticEntityModelUrl(entityId: string, frame = 0) {
  return snapshotUrl(`models/entities/${encodeURIComponent(entityId)}/${frame}.json`);
}

export function staticAssetModelUrl(assetId: string, frame = 0) {
  return snapshotUrl(`models/assets/${encodeURIComponent(assetId)}/${frame}.json`);
}

export function staticAssetPreviewUrl(
  assetId: string,
  frame: number,
  palette: "unit" | "animation" | undefined,
  shadowFrame: number | undefined,
) {
  return snapshotUrl(
    `previews/assets/${encodeURIComponent(assetId)}/${palette || "auto"}/${frame}-shadow-${shadowFrame ?? "none"}.webp`,
  );
}

export function staticPopoutUrl(params: URLSearchParams) {
  const url = new URL(window.location.href);
  url.search = params.toString();
  url.hash = "";
  return url.toString();
}
