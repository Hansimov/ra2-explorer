from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from verify_pages_snapshot import SnapshotValidationError, verify_snapshot
except ModuleNotFoundError:  # Imported as scripts.publish_pages_cdn in tests.
    from scripts.verify_pages_snapshot import SnapshotValidationError, verify_snapshot


DEFAULT_PACKAGE = "ra2-explorer-pages-data"
DEFAULT_REGISTRY = "https://registry.npmjs.org/"
CDN_ROOT = "https://cdn.jsdelivr.net/npm"
PACKAGE_NAME_PATTERN = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
REQUIRED_CATALOGS = {
    "catalog/entities.zh-CN.json",
    "catalog/entities.zh-TW.json",
    "catalog/media.zh-CN.json",
    "catalog/media.zh-TW.json",
}


class PagesCdnPublishError(RuntimeError):
    pass


def _load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.removeprefix("export ").strip()] = value.strip().strip('"').strip("'")
    return values


def _safe_member_path(raw_path: str) -> str:
    normalized = raw_path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    candidate = PurePosixPath(normalized)
    if not normalized or candidate.is_absolute() or ".." in candidate.parts:
        raise PagesCdnPublishError(f"数据包包含非法路径：{raw_path!r}")
    return candidate.as_posix()


def _is_cdn_member(path: str) -> bool:
    return path == "manifest.json" or path in REQUIRED_CATALOGS or path.startswith(
        ("previews/entity-atlases/", "previews/entity-search-atlases/")
    )


def _validate_identity(package_name: str, version: str) -> None:
    if not PACKAGE_NAME_PATTERN.fullmatch(package_name):
        raise PagesCdnPublishError("npm 包名格式无效")
    if not VERSION_PATTERN.fullmatch(version):
        raise PagesCdnPublishError("npm 包版本必须是明确的语义版本")


def _content_digest(files: list[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    for path, content in sorted(files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
    return digest.hexdigest()


def _package_notice() -> str:
    return (
        "RA2 Explorer Pages data package\n\n"
        "This package contains generated bilingual indexes and compact card and search-preview "
        "atlases.\n"
        "It does not contain original MIX archives, VXL/SHP source files, "
        "executables, or WAV files.\n"
        "These generated data assets are distributed by the project maintainer under separate\n"
        "authorization and are not covered by the MIT license for the application source code.\n"
        "Command & Conquer and Red Alert are trademarks of Electronic Arts Inc.\n"
    )


def _package_readme(package_name: str, version: str, snapshot_id: str) -> str:
    return (
        f"# {package_name}\n\n"
        "Machine-generated startup data for the RA2 Explorer static web edition. "
        "Applications should pin the exact package version rather than use a moving tag.\n\n"
        f"- Version: `{version}`\n"
        f"- Snapshot: `{snapshot_id}`\n"
        "- Included: manifest, bilingual unit/sound catalogs, and unit card-preview atlases\n"
        "- Excluded: original game archives and source assets\n"
    )


def prepare_package(
    archive: Path,
    staging: Path,
    *,
    package_name: str,
    version: str,
    overwrite: bool = False,
) -> dict[str, Any]:
    _validate_identity(package_name, version)
    try:
        verification = verify_snapshot(archive)
    except SnapshotValidationError as error:
        raise PagesCdnPublishError(str(error)) from error
    if not zipfile.is_zipfile(archive):
        raise PagesCdnPublishError("npm CDN 数据源必须是通过审计的 Pages ZIP")

    resolved_staging = staging.resolve()
    if resolved_staging == Path.cwd().resolve() or len(resolved_staging.parts) < 3:
        raise PagesCdnPublishError("拒绝使用过宽的 npm 暂存目录")
    if resolved_staging.exists():
        if not overwrite:
            raise PagesCdnPublishError("npm 暂存目录已存在；确认后使用 --overwrite")
        shutil.rmtree(resolved_staging)
    data_root = resolved_staging / "data"
    data_root.mkdir(parents=True)

    selected: list[tuple[str, bytes]] = []
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            if info.is_dir():
                continue
            relative = _safe_member_path(info.filename)
            if not _is_cdn_member(relative):
                continue
            content = bundle.read(info)
            destination = data_root.joinpath(*PurePosixPath(relative).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            selected.append((relative, content))

    selected_paths = {path for path, _ in selected}
    missing = sorted({"manifest.json", *REQUIRED_CATALOGS} - selected_paths)
    card_atlases = [
        path for path in selected_paths if path.startswith("previews/entity-atlases/")
    ]
    search_atlases = [
        path
        for path in selected_paths
        if path.startswith("previews/entity-search-atlases/")
    ]
    if missing or not card_atlases or not search_atlases:
        detail = ", ".join(missing) if missing else (
            "单位卡片图集" if not card_atlases else "搜索单位缩略图图集"
        )
        raise PagesCdnPublishError(f"CDN 数据缺少必要内容：{detail}")

    package_manifest = {
        "name": package_name,
        "version": version,
        "description": "Pinned startup indexes and card previews for RA2 Explorer Pages",
        "license": "SEE LICENSE IN NOTICE.txt",
        "repository": {
            "type": "git",
            "url": "git+https://github.com/Hansimov/ra2-explorer.git",
        },
        "homepage": "https://hansimov.github.io/ra2-explorer/",
        "files": ["data", "README.md", "NOTICE.txt"],
        "sideEffects": False,
        "publishConfig": {"access": "public", "registry": DEFAULT_REGISTRY},
    }
    (resolved_staging / "package.json").write_text(
        json.dumps(package_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (resolved_staging / "README.md").write_text(
        _package_readme(package_name, version, str(verification["snapshot_id"])),
        encoding="utf-8",
    )
    (resolved_staging / "NOTICE.txt").write_text(_package_notice(), encoding="utf-8")
    return {
        "schema_version": 1,
        "provider": "npm+jsdelivr",
        "package": package_name,
        "version": version,
        "registry": DEFAULT_REGISTRY,
        "base_url": f"{CDN_ROOT}/{package_name}@{version}/data",
        "snapshot_id": verification["snapshot_id"],
        "files": len(selected),
        "bytes": sum(len(content) for _, content in selected),
        "sha256": _content_digest(selected),
        "included": [
            "manifest",
            "bilingual_catalogs",
            "entity_card_atlases",
            "entity_search_atlases",
        ],
        "contains_original_game_files": False,
    }


def _npm_executable() -> str:
    executable = shutil.which("npm.cmd") or shutil.which("npm")
    if not executable:
        raise PagesCdnPublishError("找不到 npm.cmd")
    return executable


def _npm_json(args: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> Any:
    result = subprocess.run(
        [_npm_executable(), *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode:
        message = (result.stderr or result.stdout or "npm 命令失败").strip()
        raise PagesCdnPublishError(message[-2000:])
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PagesCdnPublishError("npm 没有返回有效的 JSON 结果") from error


def validate_package(staging: Path) -> dict[str, Any]:
    report = _npm_json(["pack", "--dry-run", "--json"], cwd=staging)
    if not isinstance(report, list) or not report or not isinstance(report[0], dict):
        raise PagesCdnPublishError("npm pack 审计结果格式无效")
    files = report[0].get("files")
    if not isinstance(files, list) or not files:
        raise PagesCdnPublishError("npm pack 没有包含文件")
    paths = {str(item.get("path", "")).replace("\\", "/") for item in files}
    if any(path.startswith("data/audio/") or path.startswith("data/models/") for path in paths):
        raise PagesCdnPublishError("npm 包误包含音频或模型数据")
    return report[0]


def publish_package(staging: Path, auth_value: str) -> dict[str, Any]:
    if not auth_value:
        raise PagesCdnPublishError("缺少 NPM_TOKEN")
    env = dict(os.environ)
    env["NODE_AUTH_TOKEN"] = auth_value
    user_config = staging / ".npmrc.ra2exp"
    user_config.write_text(
        "registry=https://registry.npmjs.org/\n"
        "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n"
        "always-auth=true\n",
        encoding="utf-8",
    )
    env["NPM_CONFIG_USERCONFIG"] = str(user_config)
    try:
        return _npm_json(
            ["publish", "--access", "public", "--registry", DEFAULT_REGISTRY, "--json"],
            cwd=staging,
            env=env,
        )
    finally:
        user_config.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="发布 Pages 高频资源到 npm/jsDelivr")
    parser.add_argument("archive", type=Path, help="通过审计的 Pages ZIP")
    parser.add_argument("--version", required=True, help="不可变 npm 版本，例如 0.11.0")
    parser.add_argument("--package-name", default=DEFAULT_PACKAGE)
    parser.add_argument(
        "--staging",
        type=Path,
        default=Path(".runtime/RA2MD-Ext/npm-pages-data"),
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--publish", action="store_true", help="审计通过后实际发布")
    parser.add_argument("--env-file", type=Path, default=Path(".secrets/local.env"))
    parser.add_argument("--write-lock", type=Path, default=Path("packaging/pages-cdn.json"))
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        lock = prepare_package(
            args.archive,
            args.staging,
            package_name=args.package_name,
            version=args.version,
            overwrite=args.overwrite,
        )
        package_report = validate_package(args.staging.resolve())
        lock["package_bytes"] = int(package_report.get("size", 0))
        lock["package_unpacked_bytes"] = int(package_report.get("unpackedSize", 0))
        if args.publish:
            values = _load_env_file(args.env_file)
            token = os.environ.get("NPM_TOKEN") or os.environ.get("NODE_AUTH_TOKEN") or values.get(
                "NPM_TOKEN", ""
            )
            publish_report = publish_package(args.staging.resolve(), token)
            for key in ("integrity", "shasum"):
                if publish_report.get(key):
                    lock[key] = publish_report[key]
            lock["published"] = True
        else:
            lock["published"] = False
        if args.write_lock:
            args.write_lock.parent.mkdir(parents=True, exist_ok=True)
            args.write_lock.write_text(
                json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
    except (OSError, PagesCdnPublishError, ValueError, zipfile.BadZipFile) as error:
        print(f"pages CDN publish failed: {error}", file=sys.stderr)
        return 1
    action = "published" if args.publish else "prepared"
    print(
        f"pages CDN {action} ({lock['package']}@{lock['version']}, "
        f"{lock['files']:,} data files, {lock['bytes'] / 1024 / 1024:.1f} MiB)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
