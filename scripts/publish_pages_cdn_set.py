from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    from publish_pages_cdn import (
        DEFAULT_REGISTRY,
        PagesCdnPublishError,
        _load_env_file,
        prepare_package,
        publish_package,
        validate_package,
    )
except ModuleNotFoundError:  # Imported as scripts.publish_pages_cdn_set in tests.
    from scripts.publish_pages_cdn import (
        DEFAULT_REGISTRY,
        PagesCdnPublishError,
        _load_env_file,
        prepare_package,
        publish_package,
        validate_package,
    )


PACKAGE_PROFILES = (
    ("core", "ra2-explorer-pages-core"),
    ("metadata", "ra2-explorer-pages-metadata"),
    ("entity-previews", "ra2-explorer-pages-entity-previews"),
    ("animation-previews", "ra2-explorer-pages-animation-previews"),
)


def compose_lock(parts: list[dict[str, Any]], version: str) -> dict[str, Any]:
    if len(parts) != len(PACKAGE_PROFILES):
        raise PagesCdnPublishError("CDN 分包数量不完整")
    snapshot_ids = {str(part.get("snapshot_id") or "") for part in parts}
    if len(snapshot_ids) != 1 or not next(iter(snapshot_ids)):
        raise PagesCdnPublishError("CDN 分包并非来自同一份快照")
    profiles = {str(part.get("profile") or "") for part in parts}
    expected_profiles = {profile for profile, _package in PACKAGE_PROFILES}
    if profiles != expected_profiles:
        raise PagesCdnPublishError("CDN 分包资料分组不完整")

    routes: list[dict[str, str]] = []
    seen_routes: set[str] = set()
    included: list[str] = []
    for part in parts:
        base_url = str(part["base_url"])
        for prefix in part.get("routes", []):
            value = str(prefix)
            if value in seen_routes:
                raise PagesCdnPublishError(f"CDN 路由重复：{value}")
            seen_routes.add(value)
            routes.append({"prefix": value, "base_url": base_url})
        for value in part.get("included", []):
            if value not in included:
                included.append(str(value))

    return {
        "schema_version": 2,
        "provider": "npm+jsdelivr",
        "registry": DEFAULT_REGISTRY,
        "version": version,
        "snapshot_id": next(iter(snapshot_ids)),
        "routes": routes,
        "packages": parts,
        "files": sum(int(part.get("files", 0)) for part in parts),
        "bytes": sum(int(part.get("bytes", 0)) for part in parts),
        "package_bytes": sum(int(part.get("package_bytes", 0)) for part in parts),
        "included": included,
        "contains_original_game_files": False,
        "published": all(part.get("published") is True for part in parts),
    }


def _write_lock(path: Path, lock: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="发布 Pages 分包 CDN 资料到 npm/jsDelivr")
    parser.add_argument("archive", type=Path, help="通过审计的 Pages ZIP")
    parser.add_argument("--version", required=True, help="不可变 npm 版本，例如 0.15.0")
    parser.add_argument(
        "--staging",
        type=Path,
        default=Path(".runtime/RA2MD-Ext/npm-pages-cdn-set"),
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--env-file", type=Path, default=Path(".secrets/local.env"))
    parser.add_argument("--write-lock", type=Path, default=Path("packaging/pages-cdn.json"))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    token = ""
    if args.publish:
        values = _load_env_file(args.env_file)
        token = os.environ.get("NPM_TOKEN") or os.environ.get("NODE_AUTH_TOKEN") or values.get(
            "NPM_TOKEN", ""
        )
        if not token:
            print("pages CDN set publish failed: 缺少 NPM_TOKEN", file=sys.stderr)
            return 1

    parts: list[dict[str, Any]] = []
    try:
        for profile, package_name in PACKAGE_PROFILES:
            print(f"[pages-cdn] 准备 {profile}（{package_name}@{args.version}）", flush=True)
            staging = args.staging / profile
            lock = prepare_package(
                args.archive,
                staging,
                package_name=package_name,
                version=args.version,
                profile=profile,
                overwrite=args.overwrite,
            )
            report = validate_package(staging.resolve())
            lock["package_bytes"] = int(report.get("size", 0))
            lock["package_unpacked_bytes"] = int(report.get("unpackedSize", 0))
            if args.publish:
                published = publish_package(staging.resolve(), token)
                for key in ("integrity", "shasum"):
                    if published.get(key):
                        lock[key] = published[key]
                lock["published"] = True
            else:
                lock["published"] = False
            parts.append(lock)
            print(
                f"[pages-cdn] 完成 {profile}：{lock['files']:,} 文件，"
                f"{lock['bytes'] / 1024 / 1024:.1f} MiB",
                flush=True,
            )
        combined = compose_lock(parts, args.version)
        _write_lock(args.write_lock, combined)
    except (OSError, PagesCdnPublishError, ValueError) as error:
        print(f"pages CDN set publish failed: {error}", file=sys.stderr)
        return 1

    action = "published" if args.publish else "prepared"
    print(
        f"pages CDN set {action} ({len(parts)} packages, "
        f"{combined['files']:,} data files, {combined['bytes'] / 1024 / 1024:.1f} MiB)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
