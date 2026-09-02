from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from scripts.verify_pages_snapshot import SnapshotValidationError, verify_snapshot


def _write_snapshot(root: Path, *, schema_version: int = 1) -> None:
    files = {
        "ASSET-NOTICE.txt": b"derived files only",
        "assets/a.json": b"{}",
        "audio/a.ogg": b"OggS",
        "catalog/entities.zh-CN.json": b"{}",
        "catalog/entities.zh-TW.json": b"{}",
        "catalog/media.zh-CN.json": b"{}",
        "catalog/media.zh-TW.json": b"{}",
        "entities/zh-CN/a.json": b"{}",
        "entities/zh-TW/a.json": b"{}",
    }
    categories: dict[str, dict[str, int]] = {}
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        category = name.split("/", 1)[0]
        current = categories.setdefault(category, {"files": 0, "bytes": 0})
        current["files"] += 1
        current["bytes"] += len(content)
    manifest = {
        "schema_version": schema_version,
        "snapshot_id": "test-snapshot",
        "edition": "pages-slim",
        "included": ["units", "sounds"],
        "contains_original_game_files": False,
        "source": {"root_path": "pages://test"},
        "stats": {"total_assets": 1, "formats": [{"format": "wav", "count": 1}]},
        "catalog": {"entities": 1, "audio": 1, "referenced_assets": 1},
        "payload": {
            "files": len(files),
            "bytes": sum(map(len, files.values())),
            "categories": categories,
        },
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )


def test_verify_pages_snapshot_directory_and_zip(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot"
    _write_snapshot(snapshot)

    directory_result = verify_snapshot(snapshot)
    archive = tmp_path / "snapshot.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for path in snapshot.rglob("*"):
            if path.is_file():
                bundle.write(path, path.relative_to(snapshot).as_posix())
    archive_result = verify_snapshot(archive)

    assert directory_result["snapshot_id"] == "test-snapshot"
    assert archive_result == directory_result


@pytest.mark.parametrize("schema_version", [1, 2])
def test_verify_pages_snapshot_accepts_supported_schema(
    tmp_path: Path,
    schema_version: int,
) -> None:
    snapshot = tmp_path / f"snapshot-{schema_version}"
    _write_snapshot(snapshot, schema_version=schema_version)

    assert verify_snapshot(snapshot)["snapshot_id"] == "test-snapshot"


def test_verify_pages_snapshot_rejects_future_schema(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot"
    _write_snapshot(snapshot, schema_version=3)

    with pytest.raises(SnapshotValidationError, match="版本或发行类型无效"):
        verify_snapshot(snapshot)


def test_verify_pages_snapshot_rejects_raw_game_file(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot"
    _write_snapshot(snapshot)
    (snapshot / "assets" / "rules.ini").write_text("[General]", encoding="utf-8")

    with pytest.raises(SnapshotValidationError, match="未允许文件"):
        verify_snapshot(snapshot)


def test_verify_pages_snapshot_rejects_archive_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "snapshot.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("../outside.json", "{}")

    with pytest.raises(SnapshotValidationError, match="非法快照路径"):
        verify_snapshot(archive)


def test_verify_pages_snapshot_rejects_nonexistent_slim_format(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot"
    _write_snapshot(snapshot)
    manifest_path = snapshot / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["stats"]["formats"] = [{"format": "map", "count": 1}]
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    with pytest.raises(SnapshotValidationError, match="不存在或不支持"):
        verify_snapshot(snapshot)
