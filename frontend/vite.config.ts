import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function gitValue(args: string[]) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function pagesCdnBase(mode: string, override: string | undefined) {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  if (mode !== "pages") return "";
  try {
    const lockUrl = new URL("../packaging/pages-cdn.json", import.meta.url);
    const lock = JSON.parse(readFileSync(lockUrl, "utf8")) as { base_url?: unknown };
    return typeof lock.base_url === "string" ? lock.base_url.trim().replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

export default defineConfig(({ mode }) => {
  // Vite's loadEnv() only reads env files. Preserve the documented precedence
  // of variables supplied by the caller/CI over values from .env files.
  const env = { ...loadEnv(mode, ".", ""), ...process.env };
  const buildCommit = env.VITE_RA2EXP_BUILD_COMMIT || gitValue(["rev-parse", "HEAD"]);
  const buildTag = env.VITE_RA2EXP_BUILD_TAG || gitValue(["describe", "--tags", "--exact-match", "--match", "v*", "HEAD"]);
  const buildTime = env.VITE_RA2EXP_BUILD_TIME || gitValue(["show", "-s", "--format=%cI", "HEAD"]);
  const stableTag = env.VITE_RA2EXP_STABLE_TAG
    || gitValue(["tag", "--list", "v*", "--sort=-v:refname"]).split(/\r?\n/, 1)[0]
    || "";
  const [stableBehind = "", stableAhead = ""] = stableTag
    ? gitValue(["rev-list", "--left-right", "--count", `${stableTag}...HEAD`]).split(/\s+/)
    : [];
  const repositoryUrl = (env.VITE_RA2EXP_REPOSITORY_URL || "https://github.com/Hansimov/ra2-explorer").replace(/\/$/, "");
  const publicBase = env.RA2EXP_PUBLIC_BASE || "/";
  const normalizedBase = publicBase.endsWith("/") ? publicBase : `${publicBase}/`;
  const defaultAtlas = env.RA2EXP_DEFAULT_ATLAS?.replace(/^\/+/, "");
  const staticCdnBase = pagesCdnBase(mode, env.RA2EXP_STATIC_CDN_BASE);
  const preloadPagesAssets = {
    name: "preload-pages-startup-assets",
    transformIndexHtml() {
      if (mode !== "pages" || !defaultAtlas) return [];
      const snapshotBase = staticCdnBase || `${normalizedBase}data`;
      const links: HtmlTagDescriptor[] = [
        {
          tag: "link",
          attrs: { rel: "preload", as: "fetch", crossorigin: "anonymous", href: `${snapshotBase}/manifest.json` },
          injectTo: "head-prepend" as const,
        },
        {
          tag: "link",
          attrs: { rel: "preload", as: "fetch", crossorigin: "anonymous", href: `${snapshotBase}/catalog/entities.zh-CN.json` },
          injectTo: "head-prepend" as const,
        },
        {
          tag: "link",
          attrs: {
            rel: "preload",
            as: "image",
            type: "image/webp",
            href: `${snapshotBase}/${defaultAtlas}`,
          },
          injectTo: "head-prepend" as const,
        },
      ];
      if (staticCdnBase) links.unshift({
        tag: "link",
        attrs: { rel: "preconnect", href: new URL(staticCdnBase).origin },
        injectTo: "head-prepend" as const,
      });
      return links;
    },
  } satisfies Plugin;
  return {
    base: publicBase,
    plugins: [react(), preloadPagesAssets],
    define: {
      "import.meta.env.VITE_RA2EXP_BUILD_COMMIT": JSON.stringify(buildCommit),
      "import.meta.env.VITE_RA2EXP_BUILD_TAG": JSON.stringify(buildTag),
      "import.meta.env.VITE_RA2EXP_BUILD_TIME": JSON.stringify(buildTime),
      "import.meta.env.VITE_RA2EXP_STABLE_TAG": JSON.stringify(stableTag),
      "import.meta.env.VITE_RA2EXP_STABLE_AHEAD": JSON.stringify(env.VITE_RA2EXP_STABLE_AHEAD || stableAhead),
      "import.meta.env.VITE_RA2EXP_STABLE_BEHIND": JSON.stringify(env.VITE_RA2EXP_STABLE_BEHIND || stableBehind),
      "import.meta.env.VITE_RA2EXP_REPOSITORY_URL": JSON.stringify(repositoryUrl),
      "import.meta.env.VITE_RA2EXP_STATIC_CDN_BASE": JSON.stringify(staticCdnBase),
    },
    build: {
      outDir: mode === "pages" ? "dist-pages" : "dist",
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replaceAll("\\", "/");
            if (normalized.endsWith("/three/build/three.core.js")) return "three-core";
            if (normalized.endsWith("/three/build/three.module.js")) return "three-renderer";
          },
        },
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:46120",
      },
    },
  };
});
