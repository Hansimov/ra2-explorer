const APP_STORAGE_PREFIX = "ra2exp-";
const STATE_VERSION_KEY = "ra2exp-browser-state-version";
const APP_CACHE_PREFIXES = ["ra2exp-", "ra2exp:"];

export const browserStateVersion = (
  import.meta.env.VITE_RA2EXP_BROWSER_STATE_VERSION?.trim()
  || import.meta.env.VITE_RA2EXP_BUILD_COMMIT?.trim()
  || import.meta.env.VITE_RA2EXP_BUILD_TAG?.trim()
  || "development"
);

function clearAppStorage(storage: Storage) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(APP_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

async function clearAppCaches() {
  if (!("caches" in window)) return;
  const names = await window.caches.keys();
  await Promise.all(
    names
      .filter((name) => APP_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map((name) => window.caches.delete(name)),
  );
}

export function resetBrowserStateForBuild() {
  let previousVersion: string | null = null;
  try {
    previousVersion = window.localStorage.getItem(STATE_VERSION_KEY);
  } catch {
    // Storage can be unavailable under restrictive browser policies.
  }
  if (previousVersion === browserStateVersion) return false;

  try {
    clearAppStorage(window.localStorage);
    window.localStorage.setItem(STATE_VERSION_KEY, browserStateVersion);
  } catch {
    // The application remains usable without persistent browser state.
  }
  try {
    clearAppStorage(window.sessionStorage);
  } catch {
    // Session storage can be unavailable for the same reason.
  }
  void clearAppCaches().catch(() => undefined);
  return true;
}
