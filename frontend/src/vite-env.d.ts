/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RA2EXP_BUILD_COMMIT?: string;
  readonly VITE_RA2EXP_BUILD_TAG?: string;
  readonly VITE_RA2EXP_BUILD_TIME?: string;
  readonly VITE_RA2EXP_STABLE_TAG?: string;
  readonly VITE_RA2EXP_STABLE_AHEAD?: string;
  readonly VITE_RA2EXP_STABLE_BEHIND?: string;
  readonly VITE_RA2EXP_REPOSITORY_URL?: string;
  readonly VITE_RA2EXP_STATIC_SNAPSHOT?: string;
  readonly VITE_RA2EXP_STATIC_CDN_BASE?: string;
  readonly VITE_RA2EXP_STATIC_CDN_ROUTES?: string;
  readonly VITE_RA2EXP_STATIC_DATA_VERSION?: string;
  readonly VITE_RA2EXP_BROWSER_STATE_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
