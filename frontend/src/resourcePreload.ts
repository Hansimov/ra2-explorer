export type ResourcePriority = "foreground" | "background";

interface ImageJob {
  url: string;
  priority: ResourcePriority;
  startedPriority: ResourcePriority | null;
  batch: number;
  image: HTMLImageElement | null;
  resolve: (loaded: boolean) => void;
  promise: Promise<boolean>;
}

const completedCardPreviews = new Set<string>();
const pendingCardPreviews = new Map<string, ImageJob>();
const cardPreviewQueue: ImageJob[] = [];
const retainedCardImages = new Map<string, HTMLImageElement>();
const retainedCardImageLimit = 96;
const cardPreviewForegroundConcurrency = 8;
const cardPreviewBackgroundConcurrency = 2;
let activeCardPreviews = 0;
let activeBackgroundCardPreviews = 0;
let backgroundPauseDepth = 0;
let latestCardPreviewBatch = 0;

function retainDecodedCard(url: string, image: HTMLImageElement) {
  retainedCardImages.delete(url);
  retainedCardImages.set(url, image);
  while (retainedCardImages.size > retainedCardImageLimit) {
    const oldest = retainedCardImages.keys().next().value;
    if (oldest === undefined) break;
    retainedCardImages.delete(oldest);
  }
}

function finishCardPreview(job: ImageJob, loaded: boolean) {
  activeCardPreviews = Math.max(0, activeCardPreviews - 1);
  if (job.startedPriority === "background") {
    activeBackgroundCardPreviews = Math.max(0, activeBackgroundCardPreviews - 1);
  }
  pendingCardPreviews.delete(job.url);
  if (loaded && job.image) {
    completedCardPreviews.add(job.url);
    retainDecodedCard(job.url, job.image);
  }
  job.resolve(loaded);
  drainCardPreviewQueue();
}

function startCardPreview(job: ImageJob) {
  job.startedPriority = job.priority;
  activeCardPreviews += 1;
  if (job.startedPriority === "background") activeBackgroundCardPreviews += 1;
  const image = new Image();
  job.image = image;
  image.decoding = "async";
  image.fetchPriority = job.priority === "foreground" ? "high" : "low";
  image.onload = () => {
    if (typeof image.decode === "function") {
      void image.decode().catch(() => undefined).then(() => finishCardPreview(job, true));
    } else {
      finishCardPreview(job, true);
    }
  };
  image.onerror = () => finishCardPreview(job, false);
  image.src = job.url;
}

function drainCardPreviewQueue() {
  while (activeCardPreviews < cardPreviewForegroundConcurrency && cardPreviewQueue.length > 0) {
    const foregroundIndex = cardPreviewQueue.findIndex((job) => job.priority === "foreground");
    let nextIndex = foregroundIndex;
    if (
      nextIndex < 0
      && backgroundPauseDepth === 0
      && activeBackgroundCardPreviews < cardPreviewBackgroundConcurrency
      && activeCardPreviews < cardPreviewBackgroundConcurrency
    ) {
      let newestBatch = -1;
      for (let index = 0; index < cardPreviewQueue.length; index += 1) {
        if (cardPreviewQueue[index].batch <= newestBatch) continue;
        newestBatch = cardPreviewQueue[index].batch;
        nextIndex = index;
      }
    }
    if (nextIndex < 0) return;
    const [job] = cardPreviewQueue.splice(nextIndex, 1);
    startCardPreview(job);
  }
}

export function hasLoadedCardPreview(url: string) {
  return completedCardPreviews.has(url);
}

function enqueueCardPreview(url: string, priority: ResourcePriority, batch: number) {
  if (!url) return Promise.resolve(false);
  if (completedCardPreviews.has(url)) return Promise.resolve(true);
  const pending = pendingCardPreviews.get(url);
  if (pending) {
    pending.batch = Math.max(pending.batch, batch);
    if (priority === "foreground" && pending.priority !== "foreground") {
      pending.priority = "foreground";
      if (pending.image) pending.image.fetchPriority = "high";
      drainCardPreviewQueue();
    }
    return pending.promise;
  }

  let resolveJob: (loaded: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => { resolveJob = resolve; });
  const job: ImageJob = { url, priority, startedPriority: null, batch, image: null, resolve: resolveJob, promise };
  pendingCardPreviews.set(url, job);
  cardPreviewQueue.push(job);
  drainCardPreviewQueue();
  return promise;
}

export function preloadCardPreview(url: string, priority: ResourcePriority = "background") {
  return enqueueCardPreview(url, priority, 0);
}

export function preloadCardPreviewGroup(urls: string[]) {
  latestCardPreviewBatch += 1;
  for (const url of new Set(urls.filter(Boolean))) {
    void enqueueCardPreview(url, "background", latestCardPreviewBatch);
  }
}

export function pauseCardPreviewBackground() {
  backgroundPauseDepth += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    backgroundPauseDepth = Math.max(0, backgroundPauseDepth - 1);
    drainCardPreviewQueue();
  };
}

interface AudioJob {
  url: string;
  priority: ResourcePriority;
  controller: AbortController | null;
  resolve: (cachedUrl: string | null) => void;
  promise: Promise<string | null>;
}

interface CachedAudioResource {
  objectUrl: string;
  size: number;
}

const cachedAudioResources = new Map<string, CachedAudioResource>();
const pendingAudioResources = new Map<string, AudioJob>();
const audioQueue: AudioJob[] = [];
const cachedAudioResourceLimit = 256;
const cachedAudioByteLimit = 64 * 1024 * 1024;
const audioPreloadConcurrency = 3;
let activeAudioPreloads = 0;
let cachedAudioBytes = 0;

function retainAudioResource(url: string, cachedUrl: string, size: number) {
  if (size > cachedAudioByteLimit) {
    URL.revokeObjectURL(cachedUrl);
    return null;
  }
  const previous = cachedAudioResources.get(url);
  if (previous) {
    cachedAudioBytes -= previous.size;
    URL.revokeObjectURL(previous.objectUrl);
    cachedAudioResources.delete(url);
  }
  cachedAudioResources.set(url, { objectUrl: cachedUrl, size });
  cachedAudioBytes += size;
  while (cachedAudioResources.size > cachedAudioResourceLimit || cachedAudioBytes > cachedAudioByteLimit) {
    const oldest = cachedAudioResources.keys().next().value;
    if (oldest === undefined) break;
    const cached = cachedAudioResources.get(oldest);
    cachedAudioResources.delete(oldest);
    if (cached) {
      cachedAudioBytes -= cached.size;
      URL.revokeObjectURL(cached.objectUrl);
    }
  }
  return cachedUrl;
}

function drainAudioQueue() {
  while (activeAudioPreloads < audioPreloadConcurrency && audioQueue.length > 0) {
    const foregroundIndex = audioQueue.findIndex((job) => job.priority === "foreground");
    const [job] = audioQueue.splice(foregroundIndex >= 0 ? foregroundIndex : 0, 1);
    activeAudioPreloads += 1;
    const controller = new AbortController();
    job.controller = controller;
    void fetch(job.url, { cache: "force-cache", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Audio preload failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        const cachedUrl = URL.createObjectURL(blob);
        job.resolve(retainAudioResource(job.url, cachedUrl, blob.size));
      })
      .catch(() => job.resolve(null))
      .finally(() => {
        job.controller = null;
        activeAudioPreloads = Math.max(0, activeAudioPreloads - 1);
        pendingAudioResources.delete(job.url);
        drainAudioQueue();
      });
  }
}

export function cachedAudioResourceUrl(url: string) {
  const cached = cachedAudioResources.get(url);
  if (!cached) return null;
  cachedAudioResources.delete(url);
  cachedAudioResources.set(url, cached);
  return cached.objectUrl;
}

export function preloadAudioResource(url: string, priority: ResourcePriority = "background") {
  if (!url) return Promise.resolve(null);
  const cachedUrl = cachedAudioResourceUrl(url);
  if (cachedUrl) return Promise.resolve(cachedUrl);
  const pending = pendingAudioResources.get(url);
  if (pending) {
    if (priority === "foreground") pending.priority = "foreground";
    drainAudioQueue();
    return pending.promise;
  }

  let resolveJob: (cachedUrl: string | null) => void = () => {};
  const promise = new Promise<string | null>((resolve) => { resolveJob = resolve; });
  const job: AudioJob = { url, priority, controller: null, resolve: resolveJob, promise };
  pendingAudioResources.set(url, job);
  audioQueue.push(job);
  drainAudioQueue();
  return promise;
}

export function cancelAudioResourcePreload(url: string) {
  const pending = pendingAudioResources.get(url);
  if (!pending) return;
  if (pending.controller) {
    pending.controller.abort();
    return;
  }
  const queuedIndex = audioQueue.indexOf(pending);
  if (queuedIndex >= 0) audioQueue.splice(queuedIndex, 1);
  pendingAudioResources.delete(url);
  pending.resolve(null);
}

export function preloadAudioResourceGroup(urls: string[]) {
  for (const url of new Set(urls.filter(Boolean))) {
    void preloadAudioResource(url, "background");
  }
}
