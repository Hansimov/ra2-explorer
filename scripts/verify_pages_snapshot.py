from __future__ import annotations

import argparse
import hashlib
import json
import stat
import sys
import zipfile
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from privacy_scan import scan_text
except ModuleNotFoundError:  # Imported as scripts.verify_pages_snapshot in tests.
    from scripts.privacy_scan import scan_text

SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = {1, 2}


MAX_FILES = 50_000
MAX_BYTES = 256 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
ALLOWED_FILES = {"manifest.json", "ASSET-NOTICE.txt"}
ALLOWED_AUDIO_FORMATS = {"aud", "bag_audio", "wav"}
ALLOWED_SUFFIXES = {
    "assets": {".json"},
    "audio": {".ogg"},
    "catalog": {".json"},
    "entities": {".json"},
    "models": {".json"},
    "previews": {".webp"},
}
REQUIRED_FILES = {
    "manifest.json",
    "ASSET-NOTICE.txt",
    "catalog/entities.zh-CN.json",
    "catalog/entities.zh-TW.json",
    "catalog/media.zh-CN.json",
    "catalog/media.zh-TW.json",
}
TEXT_SUFFIXES = {".json", ".txt"}


class SnapshotValidationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SnapshotEntry:
    path: str
    size: int
    read: Callable[[], bytes]


def _normalize_path(raw_path: str) -> str:
    path = raw_path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    candidate = PurePosixPath(path)
    if not path or candidate.is_absolute() or ".." in candidate.parts:
        raise SnapshotValidationError(f"非法快照路径：{raw_path!r}")
    return candidate.as_posix()


def _directory_entries(root: Path) -> list[SnapshotEntry]:
    entries: list[SnapshotEntry] = []
    for path in root.rglob("*"):
        if path.is_symlink():
            raise SnapshotValidationError(f"快照包含符号链接：{path.relative_to(root)}")
        if not path.is_file():
            continue
        relative = _normalize_path(path.relative_to(root).as_posix())
        entries.append(
            SnapshotEntry(
                path=relative,
                size=path.stat().st_size,
                read=path.read_bytes,
            )
        )
    return entries


def _archive_entries(archive: Path) -> list[SnapshotEntry]:
    entries: list[SnapshotEntry] = []
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            if info.is_dir():
                continue
            mode = info.external_attr >> 16
            if mode and stat.S_ISLNK(mode):
                raise SnapshotValidationError(f"快照包含符号链接：{info.filename}")
            relative = _normalize_path(info.filename)
            content = (
                bundle.read(info)
                if PurePosixPath(relative).suffix.casefold() in TEXT_SUFFIXES
                else None
            )
            entries.append(
                SnapshotEntry(
                    path=relative,
                    size=info.file_size,
                    read=lambda data=content: data or b"",
                )
            )
    return entries


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _load_manifest(entries: dict[str, SnapshotEntry]) -> dict[str, Any]:
    try:
        value = json.loads(entries["manifest.json"].read())
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise SnapshotValidationError("manifest.json 缺失或格式无效") from error
    if not isinstance(value, dict):
        raise SnapshotValidationError("manifest.json 顶层必须是对象")
    return value


def _payload_stats(entries: Iterable[SnapshotEntry]) -> dict[str, object]:
    categories: dict[str, dict[str, int]] = {}
    files = 0
    total_bytes = 0
    for entry in entries:
        if entry.path == "manifest.json":
            continue
        files += 1
        total_bytes += entry.size
        category = entry.path.split("/", 1)[0]
        current = categories.setdefault(category, {"files": 0, "bytes": 0})
        current["files"] += 1
        current["bytes"] += entry.size
    return {"files": files, "bytes": total_bytes, "categories": categories}


def _validate_file_set(entries: list[SnapshotEntry]) -> dict[str, SnapshotEntry]:
    if len(entries) > MAX_FILES:
        raise SnapshotValidationError(f"文件数超过上限：{len(entries):,}")
    total_bytes = sum(entry.size for entry in entries)
    if total_bytes > MAX_BYTES:
        raise SnapshotValidationError(f"解压体积超过上限：{total_bytes:,} 字节")
    by_path: dict[str, SnapshotEntry] = {}
    for entry in entries:
        if entry.path in by_path:
            raise SnapshotValidationError(f"快照包含重复路径：{entry.path}")
        if entry.size > MAX_FILE_BYTES:
            raise SnapshotValidationError(f"单个文件超过上限：{entry.path}")
        parts = PurePosixPath(entry.path).parts
        if len(parts) == 1:
            if entry.path not in ALLOWED_FILES:
                raise SnapshotValidationError(f"快照顶层包含未允许文件：{entry.path}")
        else:
            allowed = ALLOWED_SUFFIXES.get(parts[0])
            if allowed is None or PurePosixPath(entry.path).suffix.casefold() not in allowed:
                raise SnapshotValidationError(f"快照包含未允许文件：{entry.path}")
        by_path[entry.path] = entry
    missing = sorted(REQUIRED_FILES - by_path.keys())
    if missing:
        raise SnapshotValidationError(f"快照缺少必要文件：{', '.join(missing)}")
    return by_path


def _validate_manifest(
    manifest: dict[str, Any],
    entries: list[SnapshotEntry],
) -> None:
    if (
        manifest.get("schema_version") not in SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS
        or manifest.get("edition") != "pages-slim"
    ):
        raise SnapshotValidationError("快照版本或发行类型无效")
    if manifest.get("included") != ["units", "sounds"]:
        raise SnapshotValidationError("精简快照只能包含单位和声音")
    if manifest.get("contains_original_game_files") is not False:
        raise SnapshotValidationError("快照没有明确声明排除原始游戏文件")
    source = manifest.get("source")
    if not isinstance(source, dict) or not str(source.get("root_path", "")).startswith("pages://"):
        raise SnapshotValidationError("快照来源路径没有完成脱敏")
    actual_payload = _payload_stats(entries)
    if manifest.get("payload") != actual_payload:
        raise SnapshotValidationError("快照负载统计与实际文件不一致")

    catalog = manifest.get("catalog")
    stats = manifest.get("stats")
    if not isinstance(catalog, dict) or not isinstance(stats, dict):
        raise SnapshotValidationError("快照目录统计缺失")
    formats = stats.get("formats")
    if not isinstance(formats, list) or sum(int(item["count"]) for item in formats) != int(
        stats.get("total_assets", -1)
    ):
        raise SnapshotValidationError("声音格式统计与声音总数不一致")
    if any(
        not isinstance(item, dict)
        or item.get("format") not in ALLOWED_AUDIO_FORMATS
        or not isinstance(item.get("count"), int)
        or item["count"] <= 0
        for item in formats
    ):
        raise SnapshotValidationError("精简快照声明了不存在或不支持的声音格式")
    if int(stats["total_assets"]) != int(catalog.get("audio", -1)):
        raise SnapshotValidationError("载入类型统计与实际声音文件数不一致")
    category_counts = Counter(entry.path.split("/", 1)[0] for entry in entries)
    expected_counts = {
        "assets": int(catalog.get("referenced_assets", -1)),
        "audio": int(catalog.get("audio", -1)),
        "entities": int(catalog.get("entities", -1)) * 2,
    }
    for category, expected in expected_counts.items():
        if category_counts[category] != expected:
            raise SnapshotValidationError(
                f"{category} 文件数不一致：{category_counts[category]} != {expected}"
            )


def _scan_private_content(entries: Iterable[SnapshotEntry]) -> None:
    findings = []
    for entry in entries:
        if PurePosixPath(entry.path).suffix.casefold() not in TEXT_SUFFIXES:
            continue
        findings.extend(scan_text(entry.path, entry.read()))
    if findings:
        details = "; ".join(finding.display() for finding in findings[:10])
        raise SnapshotValidationError(f"快照隐私扫描失败：{details}")


def verify_snapshot(path: Path, *, expected_sha256: str | None = None) -> dict[str, object]:
    resolved = path.resolve()
    if not resolved.exists():
        raise SnapshotValidationError(f"快照不存在：{resolved}")
    if expected_sha256:
        if not resolved.is_file():
            raise SnapshotValidationError("只有 ZIP 快照可以校验 SHA-256")
        digest = _sha256_file(resolved)
        if digest.casefold() != expected_sha256.casefold():
            raise SnapshotValidationError("快照 SHA-256 不匹配")
    if resolved.is_dir():
        entries = _directory_entries(resolved)
    elif zipfile.is_zipfile(resolved):
        entries = _archive_entries(resolved)
    else:
        raise SnapshotValidationError("快照必须是目录或 ZIP 文件")
    by_path = _validate_file_set(entries)
    manifest = _load_manifest(by_path)
    _validate_manifest(manifest, entries)
    _scan_private_content(entries)
    return {
        "snapshot_id": manifest["snapshot_id"],
        "files": len(entries),
        "bytes": sum(entry.size for entry in entries),
        "entities": manifest["catalog"]["entities"],
        "audio": manifest["catalog"]["audio"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="审计 RA2 Explorer GitHub Pages 快照")
    parser.add_argument("path", type=Path, help="快照目录或 ZIP 文件")
    parser.add_argument("--sha256", help="ZIP 的预期 SHA-256")
    parser.add_argument("--lock", type=Path, help="从 Pages 数据锁定清单读取 SHA-256")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        expected_sha256 = args.sha256
        if args.lock:
            lock = json.loads(args.lock.read_text(encoding="utf-8"))
            lock_sha256 = str(lock["sha256"])
            if expected_sha256 and expected_sha256.casefold() != lock_sha256.casefold():
                raise SnapshotValidationError("命令行与锁定清单中的 SHA-256 不一致")
            expected_sha256 = lock_sha256
        result = verify_snapshot(args.path, expected_sha256=expected_sha256)
    except (
        KeyError,
        OSError,
        SnapshotValidationError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
    ) as error:
        print(f"pages snapshot verification failed: {error}", file=sys.stderr)
        return 1
    print(
        "pages snapshot verification passed "
        f"({result['snapshot_id']}, {result['files']:,} files, "
        f"{result['bytes'] / 1024 / 1024:.1f} MiB, "
        f"{result['entities']} units, {result['audio']} sounds)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
