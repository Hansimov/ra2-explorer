from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
import zipfile
from collections import Counter
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar
from urllib.parse import quote

from fastapi.testclient import TestClient
from PIL import Image

from ra2_explorer import __version__
from ra2_explorer.api import (
    Services,
    _alpha_composite_centered,
    _composite_building_voxel_turret,
    _composite_focus_bounds,
    _crop_transparent_preview,
    _default_entity_operation_samples,
    _entity_thumbnail_padding,
    _render_entity_shp_layer,
    _select_palette,
    create_app,
)
from ra2_explorer.codecs.shp import parse_shp
from ra2_explorer.config import Settings
from ra2_explorer.errors import Ra2ExplorerError

PAGES_SNAPSHOT_SCHEMA_VERSION = 2
PAGES_RENDER_REVISION = 9
PAGES_ASSET_BUNDLE_REVISION = 4
_SAFE_FILENAME = re.compile(r"^[A-Za-z0-9_.~$-]+$")
_AUDIO_FORMATS = {"aud", "bag_audio", "wav"}
_MODEL_FORMATS = {"hva", "vxl"}
_IMAGE_FORMATS = {"pcx", "shp", "tmp"}
_ENTITY_ATLAS_CELL_WIDTH = 144
_ENTITY_ATLAS_CELL_HEIGHT = 135
_ENTITY_ATLAS_COLUMNS = 12
_ENTITY_SEARCH_ATLAS_CELL_SIZE = 36
_ENTITY_SEARCH_ATLAS_CONTENT_SIZE = 32
_ENTITY_SEARCH_ATLAS_COLUMNS = 24
_T = TypeVar("_T")


@dataclass(frozen=True, slots=True)
class _AnimationVariant:
    palette: str
    start_frame: int
    frame_count: int | None
    facing_step: int
    frame_step: int
    shadow: bool
    reverse: bool = False


@dataclass(frozen=True, slots=True)
class _AssetUsage:
    asset: dict[str, Any]
    variants: frozenset[_AnimationVariant]


@dataclass(frozen=True, slots=True)
class _ExportTask:
    path: str
    params: dict[str, object]
    output: Path
    kind: str


@dataclass(frozen=True, slots=True)
class _EntityPreviewTask:
    entity_id: str
    frame: int
    facing: int
    scale: int
    thumbnail: bool
    player_color: str | None
    output: Path


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_json_bytes(value))


def _safe_filename(value: str) -> str:
    if not _SAFE_FILENAME.fullmatch(value):
        raise Ra2ExplorerError(f"静态快照包含不安全的文件标识：{value!r}")
    return value


def _request_json(client: TestClient, path: str, **params: object) -> Any:
    response = client.get(path, params=params)
    if response.status_code != 200:
        detail = response.text[:500]
        raise Ra2ExplorerError(f"快照 API 请求失败：{path}（{response.status_code}）{detail}")
    return response.json()


def _write_webp(data: bytes, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(data)) as image:
        _save_webp(image, output)


def _save_webp(image: Image.Image, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="WEBP", lossless=True, method=4)


def _run_parallel(
    label: str,
    values: Iterable[_T],
    worker: Callable[[_T], None],
    *,
    workers: int,
) -> None:
    pending = list(values)
    total = len(pending)
    if total == 0:
        return
    print(f"[pages] {label}：{total:,} 项", file=sys.stderr, flush=True)
    completed = 0
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ra2exp-pages") as pool:
        futures = {pool.submit(worker, value): value for value in pending}
        for future in as_completed(futures):
            future.result()
            completed += 1
            if completed == total or completed % 100 == 0:
                print(
                    f"[pages] {label}：{completed:,}/{total:,}",
                    file=sys.stderr,
                    flush=True,
                )


def _snapshot_identity(source: dict[str, Any]) -> str:
    token = "|".join(
        (
            str(PAGES_SNAPSHOT_SCHEMA_VERSION),
            str(PAGES_RENDER_REVISION),
            str(source["id"]),
            str(source.get("scanned_at") or source.get("created_at") or ""),
            str(source.get("asset_count") or 0),
        )
    )
    return f"ra2md-slim-{hashlib.sha256(token.encode()).hexdigest()[:12]}"


def _prepare_output(output: Path, *, overwrite: bool) -> tuple[Path, Path]:
    resolved = output.resolve()
    if resolved == resolved.anchor or resolved.parent == resolved:
        raise Ra2ExplorerError("拒绝把磁盘根目录用作静态快照输出目录")
    if resolved.exists() and not overwrite:
        raise Ra2ExplorerError(f"输出目录已经存在：{resolved}；如需替换请添加 --overwrite")
    staging = resolved.parent / f".{resolved.name}.building-{uuid.uuid4().hex[:8]}"
    if staging.exists():
        raise Ra2ExplorerError(f"临时输出目录已经存在：{staging}")
    staging.mkdir(parents=True)
    return resolved, staging


def _resume_reusable_data(target: Path, staging: Path) -> int:
    candidates = [target] if target.is_dir() else []
    candidates.extend(
        sorted(
            target.parent.glob(f".{target.name}.building-*"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    )
    copied = 0
    candidates = [
        candidate for candidate in candidates if candidate.resolve() != staging.resolve()
    ]
    for directory in ("assets", "audio", "previews", "models"):
        for candidate in candidates:
            source = candidate / directory
            destination = staging / directory
            if not source.is_dir():
                continue
            for path in source.rglob("*"):
                if not path.is_file():
                    continue
                output = destination / path.relative_to(source)
                if output.exists():
                    continue
                output.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.link(path, output)
                except OSError:
                    shutil.copyfile(path, output)
                copied += 1
                if copied % 2_000 == 0:
                    print(
                        f"[pages] 已复用 {copied:,} 个文件",
                        file=sys.stderr,
                        flush=True,
                    )
            break
    if copied:
        print(f"[pages] 复用中断构建结果：{copied:,} 个文件", file=sys.stderr, flush=True)
    return copied


def _prune_reused_exports(
    root: Path,
    *,
    asset_ids: set[str],
    audio_ids: set[str],
    animation_ids: set[str],
    entity_ids: set[str],
) -> int:
    allowed = {
        root / "assets": {f"{_safe_filename(asset_id)}.json" for asset_id in asset_ids},
        root / "audio": {f"{_safe_filename(asset_id)}.ogg" for asset_id in audio_ids},
        root / "previews" / "assets": {
            _safe_filename(asset_id) for asset_id in animation_ids
        },
        root / "models" / "assets": {
            _safe_filename(asset_id) for asset_id in animation_ids
        },
        root / "previews" / "entities": {
            _safe_filename(entity_id) for entity_id in entity_ids
        },
        root / "models" / "entities": {
            _safe_filename(entity_id) for entity_id in entity_ids
        },
    }
    removed = 0
    for directory, expected_names in allowed.items():
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if path.name in expected_names:
                continue
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            removed += 1
    if removed:
        print(f"[pages] 清理失效复用项：{removed:,} 项", file=sys.stderr, flush=True)
    return removed


def _collect_catalog(
    client: TestClient,
    source_id: str,
    language: str,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    entities = _request_json(
        client,
        "/api/entities",
        source_id=source_id,
        language=language,
        limit=1000,
    )
    media_first = _request_json(
        client,
        "/api/media",
        source_id=source_id,
        language=language,
        limit=500,
        offset=0,
    )
    media_items = list(media_first["items"])
    while len(media_items) < int(media_first["total"]):
        page = _request_json(
            client,
            "/api/media",
            source_id=source_id,
            language=language,
            limit=500,
            offset=len(media_items),
        )
        if not page["items"]:
            raise Ra2ExplorerError("声音目录分页提前结束")
        media_items.extend(page["items"])
    media = {**media_first, "items": media_items}
    details = [
        _request_json(
            client,
            f"/api/entities/{quote(source_id, safe='')}/{quote(str(item['id']), safe='')}",
            language=language,
        )
        for item in entities["items"]
    ]
    return entities, media, details


def _asset_usages(
    media: dict[str, Any],
    entities: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, _AssetUsage], set[str]]:
    referenced: dict[str, dict[str, Any]] = {}
    animation: dict[str, dict[str, Any]] = {}
    audio_ids = {str(item["asset"]["id"]) for item in media["items"]}
    for item in media["items"]:
        asset = item["asset"]
        referenced[str(asset["id"])] = asset
    for entity in entities:
        for component in entity.get("components", []):
            asset = component.get("asset")
            if asset:
                referenced[str(asset["id"])] = asset
        for association in entity.get("media", []):
            association_kind = association.get("kind")
            if association_kind == "animation":
                role = association.get("role")
                slot = association.get("slot")
                is_body = role == "body" or slot == "body_sequence"
                is_building_layer = entity.get("kind") == "building" and role in {
                    "construction",
                    "operation",
                }
                if not is_body and not is_building_layer:
                    continue
            for sample in association.get("samples", []):
                asset = sample.get("asset")
                if not asset:
                    continue
                asset_id = str(asset["id"])
                referenced[asset_id] = asset
                if association_kind != "animation":
                    continue
                current = animation.setdefault(
                    asset_id,
                    {"asset": asset, "variants": set()},
                )
                playback = sample.get("animation") or {}
                current["variants"].add(
                    _AnimationVariant(
                        palette=str(sample.get("palette") or "auto"),
                        start_frame=int(playback.get("start_frame") or 0),
                        frame_count=(
                            int(playback["frame_count"])
                            if playback.get("frame_count") is not None
                            else None
                        ),
                        facing_step=int(playback.get("facing_step") or 0),
                        frame_step=max(1, int(playback.get("frame_step") or 1)),
                        shadow=bool(playback.get("shadow")),
                        reverse=bool(playback.get("reverse")),
                    )
                )
    usages = {
        asset_id: _AssetUsage(
            asset=value["asset"],
            variants=frozenset(value["variants"]),
        )
        for asset_id, value in animation.items()
    }
    return referenced, usages, audio_ids


def _export_asset_bundles(
    client: TestClient,
    root: Path,
    assets: dict[str, dict[str, Any]],
    audio_ids: set[str],
    *,
    workers: int,
) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}

    def export(asset_id: str) -> None:
        safe_id = _safe_filename(asset_id)
        output = root / "assets" / f"{safe_id}.json"
        if output.is_file():
            bundle = json.loads(output.read_text(encoding="utf-8"))
            if bundle.get("bundle_revision") == PAGES_ASSET_BUNDLE_REVISION:
                metadata[asset_id] = bundle["metadata"]
                return
        asset = _request_json(client, f"/api/assets/{quote(asset_id, safe='')}")
        inspected = _request_json(client, f"/api/assets/{quote(asset_id, safe='')}/metadata")
        empty = {
            "items": [],
            "total": 0,
            "texts": [],
            "original_texts": [],
            "localized_texts": [],
        }
        associations: dict[str, Any] = {"zh-CN": empty, "zh-TW": empty}
        if asset_id in audio_ids:
            associations = {
                language: _request_json(
                    client,
                    f"/api/assets/{quote(asset_id, safe='')}/associations",
                    language=language,
                )
                for language in ("zh-CN", "zh-TW")
            }
        _write_json(
            output,
            {
                "bundle_revision": PAGES_ASSET_BUNDLE_REVISION,
                "asset": asset,
                "metadata": inspected,
                "associations": associations,
            },
        )
        metadata[asset_id] = inspected

    _run_parallel("导出资产信息", sorted(assets), export, workers=workers)
    return metadata


def _export_audio(
    client: TestClient,
    root: Path,
    audio_ids: set[str],
    *,
    ffmpeg: Path,
    bitrate: str,
    workers: int,
) -> None:
    def export(asset_id: str) -> None:
        output = root / "audio" / f"{_safe_filename(asset_id)}.ogg"
        if output.is_file() and output.stat().st_size > 0:
            return
        response = client.get(f"/api/assets/{quote(asset_id, safe='')}/media")
        if response.status_code != 200:
            raise Ra2ExplorerError(
                f"声音转码源读取失败：{asset_id}（{response.status_code}）{response.text[:300]}"
            )
        output.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            (
                str(ffmpeg),
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                "pipe:0",
                "-map_metadata",
                "-1",
                "-vn",
                "-c:a",
                "libopus",
                "-b:a",
                bitrate,
                "-vbr",
                "on",
                "-compression_level",
                "10",
                "-application",
                "audio",
                str(output),
            ),
            input=response.content,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            message = result.stderr.decode("utf-8", errors="replace")[-500:]
            raise Ra2ExplorerError(f"声音转码失败：{asset_id}：{message}")

    _run_parallel("压缩声音", sorted(audio_ids), export, workers=workers)


def _entity_player_color(entity: dict[str, Any]) -> str | None:
    sides = {
        str(side)
        for side in entity.get("sides", [])
        if str(side) in {"GDI", "Nod", "ThirdSide"}
    }
    if len(sides) == 1:
        side = next(iter(sides))
    elif not sides and (entity.get("affiliation") or {}).get("kind") == "side":
        side = str(entity["affiliation"]["id"])
    else:
        return None
    return {"GDI": "blue", "Nod": "red", "ThirdSide": "purple"}.get(side)


def _entity_tasks(
    root: Path,
    source_id: str,
    entities: list[dict[str, Any]],
) -> tuple[list[_EntityPreviewTask], list[_ExportTask]]:
    images: dict[Path, _EntityPreviewTask] = {}
    models: dict[Path, _ExportTask] = {}
    for entity in entities:
        if not entity.get("renderable"):
            continue
        entity_id = str(entity["id"])
        safe_id = _safe_filename(entity_id)
        preview = entity.get("preview") or {}
        player_color = _entity_player_color(entity)
        facings = range(8) if preview.get("supports_facing") else range(1)
        thumbnail_facings = range(1) if preview.get("format") == "vxl" else facings
        for facing in thumbnail_facings:
            thumbnail_output = (
                root / "previews" / "entities" / safe_id / "thumbnail" / str(facing) / "0.webp"
            )
            images[thumbnail_output] = _EntityPreviewTask(
                entity_id=entity_id,
                frame=0,
                facing=facing,
                scale=2,
                thumbnail=True,
                player_color=player_color,
                output=thumbnail_output,
            )
        frame_count = max(1, int(preview.get("frame_count") or 1))
        has_body_sequences = any(
            association.get("kind") == "animation"
            and (
                association.get("role") in {"body", "construction", "operation"}
                or association.get("slot") == "body_sequence"
            )
            for association in entity.get("media", [])
        )
        has_raw_body_animation = (
            entity.get("kind") != "building" and frame_count > 1 and not has_body_sequences
        )
        exported_frames = range(frame_count) if has_raw_body_animation else range(1)
        if preview.get("format") == "vxl":
            for frame in exported_frames:
                output = root / "models" / "entities" / safe_id / f"{frame}.json"
                models[output] = _ExportTask(
                    path=(
                        f"/api/entities/{quote(source_id, safe='')}/"
                        f"{quote(entity_id, safe='')}/model.json"
                    ),
                    params={
                        "frame": frame,
                        **({"player_color": player_color} if player_color else {}),
                    },
                    output=output,
                    kind="model",
                )
            continue
        for facing in facings:
            for frame in exported_frames:
                output = (
                    root
                    / "previews"
                    / "entities"
                    / safe_id
                    / "frame"
                    / str(facing)
                    / f"{frame}.webp"
                )
                images[output] = _EntityPreviewTask(
                    entity_id=entity_id,
                    frame=frame,
                    facing=facing,
                    scale=4,
                    thumbnail=False,
                    player_color=player_color,
                    output=output,
                )
    return list(images.values()), list(models.values())


def _entity_operation_effect_tasks(
    root: Path,
    source_id: str,
    entities: list[dict[str, Any]],
    metadata: dict[str, dict[str, Any]],
) -> list[_ExportTask]:
    tasks: dict[Path, _ExportTask] = {}
    for entity in entities:
        if entity.get("kind") != "building" or not entity.get("renderable"):
            continue
        entity_id = str(entity["id"])
        safe_entity_id = _safe_filename(entity_id)
        preview = entity.get("preview") or {}
        facings = range(8) if preview.get("supports_facing") else range(1)
        player_color = _entity_player_color(entity)
        for association in entity.get("media", []):
            if association.get("kind") != "animation" or association.get("role") != "operation":
                continue
            for sample in association.get("samples", []):
                asset = sample.get("asset")
                if not asset or asset.get("format") != "shp":
                    continue
                asset_id = str(asset["id"])
                safe_asset_id = _safe_filename(asset_id)
                playback = sample.get("animation") or {}
                palette = str(sample.get("palette") or "auto")
                variant = _AnimationVariant(
                    palette=palette,
                    start_frame=int(playback.get("start_frame") or 0),
                    frame_count=(
                        int(playback["frame_count"])
                        if playback.get("frame_count") is not None
                        else None
                    ),
                    facing_step=int(playback.get("facing_step") or 0),
                    frame_step=max(1, int(playback.get("frame_step") or 1)),
                    shadow=bool(playback.get("shadow")),
                    reverse=bool(playback.get("reverse")),
                )
                asset_metadata = metadata.get(asset_id, {})
                frame_count = max(1, int(asset_metadata.get("frame_count") or 1))
                paired_shadows = {
                    int(frame["index"]): int(frame["paired_shadow_frame"])
                    for frame in asset_metadata.get("frames", [])
                    if frame.get("paired_shadow_frame") is not None
                }
                usage = _AssetUsage(asset=asset, variants=frozenset({variant}))
                requests = _animation_frame_requests(usage, frame_count, paired_shadows)
                for facing in facings:
                    for _palette, effect_frame, shadow_frame in requests:
                        effect_name = (
                            f"{effect_frame}-shadow-"
                            f"{shadow_frame if shadow_frame is not None else 'none'}.webp"
                        )
                        output = (
                            root
                            / "previews"
                            / "entities"
                            / safe_entity_id
                            / "effects"
                            / safe_asset_id
                            / palette
                            / str(facing)
                            / effect_name
                        )
                        params: dict[str, object] = {
                            "frame": 0,
                            "facing": facing,
                            "scale": 4,
                            "effect_asset_id": asset_id,
                            "effect_frame": effect_frame,
                        }
                        if player_color:
                            params["player_color"] = player_color
                        if shadow_frame is not None:
                            params["effect_shadow_frame"] = shadow_frame
                        if palette != "auto":
                            params["effect_palette_kind"] = palette
                        tasks[output] = _ExportTask(
                            path=(
                                f"/api/entities/{quote(source_id, safe='')}/"
                                f"{quote(entity_id, safe='')}/preview.png"
                            ),
                            params=params,
                            output=output,
                            kind="image",
                        )
    return list(tasks.values())


def _export_entity_previews(
    services: Services,
    source_id: str,
    tasks: list[_EntityPreviewTask],
    *,
    workers: int,
) -> None:
    grouped: dict[str, list[_EntityPreviewTask]] = {}
    for task in tasks:
        grouped.setdefault(task.entity_id, []).append(task)

    def export(value: tuple[str, list[_EntityPreviewTask]]) -> None:
        entity_id, requests = value
        semantic_entity = services.semantic.catalog(source_id).get(entity_id)
        body = semantic_entity.component("body")
        if body is None:
            raise Ra2ExplorerError(f"单位没有可渲染主体：{entity_id}")
        palette = _select_palette(services, body, None)
        default_samples = _default_entity_operation_samples(semantic_entity)
        operation_layers: dict[
            tuple[int, str | None], tuple[list[Image.Image], list[Image.Image]]
        ] = {}
        for request in requests:
            if request.output.is_file() and request.output.stat().st_size > 0:
                continue
            _, image, focus_bounds = services.semantic.render(
                source_id,
                entity_id,
                palette=palette,
                frame=request.frame,
                facing=request.facing,
                player_color=request.player_color,
                scale=request.scale,
            )
            if body["format"] == "shp" and default_samples:
                layer_key = (request.scale, request.player_color)
                layers = operation_layers.get(layer_key)
                if layers is None:
                    shadow_layers: list[Image.Image] = []
                    main_layers: list[Image.Image] = []
                    for sample in default_samples:
                        rendered = _render_entity_shp_layer(
                            services,
                            sample,
                            player_color=request.player_color,
                            scale=request.scale,
                        )
                        if rendered is None:
                            continue
                        shadow, main = rendered
                        if shadow is not None:
                            shadow_layers.append(shadow)
                        main_layers.append(main)
                    layers = (shadow_layers, main_layers)
                    operation_layers[layer_key] = layers
                shadow_layers, main_layers = layers
                if shadow_layers or main_layers:
                    image, focus_bounds = _composite_entity_preview_layers(
                        image,
                        focus_bounds,
                        shadow_layers,
                        main_layers,
                    )
            image, focus_bounds = _composite_building_voxel_turret(
                services,
                source_id,
                semantic_entity,
                image,
                focus_bounds,
                palette=palette,
                frame=request.frame,
                facing=request.facing,
                player_color=request.player_color,
                scale=request.scale,
            )
            if request.thumbnail:
                image = _crop_transparent_preview(
                    image,
                    padding_ratio=_entity_thumbnail_padding(semantic_entity, compact=False),
                    focus_bounds=focus_bounds,
                )
            _save_webp(image, request.output)

    _run_parallel(
        "生成单位预览",
        sorted(grouped.items()),
        export,
        workers=workers,
    )


def _entity_thumbnail_atlas_cell(image: Image.Image, body_format: str | None) -> Image.Image:
    cell = Image.new(
        "RGBA",
        (_ENTITY_ATLAS_CELL_WIDTH, _ENTITY_ATLAS_CELL_HEIGHT),
        (0, 0, 0, 0),
    )
    left = right = 10
    top = 8 if body_format == "shp" else 10
    bottom = 15 if body_format == "shp" else 10
    available_width = _ENTITY_ATLAS_CELL_WIDTH - left - right
    available_height = _ENTITY_ATLAS_CELL_HEIGHT - top - bottom
    rgba = image.convert("RGBA")
    scale = min(available_width / rgba.width, available_height / rgba.height)
    fitted = rgba.resize(
        (
            max(1, round(rgba.width * scale)),
            max(1, round(rgba.height * scale)),
        ),
        Image.Resampling.NEAREST,
    )
    position = (
        left + (available_width - fitted.width) // 2,
        top + (available_height - fitted.height) // 2,
    )
    cell.alpha_composite(fitted, position)
    return cell


def _entity_search_thumbnail_cell(image: Image.Image) -> Image.Image:
    cell = Image.new(
        "RGBA",
        (_ENTITY_SEARCH_ATLAS_CELL_SIZE, _ENTITY_SEARCH_ATLAS_CELL_SIZE),
        (0, 0, 0, 0),
    )
    rgba = image.convert("RGBA")
    bounds = rgba.getchannel("A").getbbox()
    if bounds is None:
        return cell
    content = rgba.crop(bounds)
    scale = min(
        _ENTITY_SEARCH_ATLAS_CONTENT_SIZE / content.width,
        _ENTITY_SEARCH_ATLAS_CONTENT_SIZE / content.height,
    )
    fitted = content.resize(
        (
            max(1, round(content.width * scale)),
            max(1, round(content.height * scale)),
        ),
        Image.Resampling.NEAREST,
    )
    cell.alpha_composite(
        fitted,
        (
            (_ENTITY_SEARCH_ATLAS_CELL_SIZE - fitted.width) // 2,
            (_ENTITY_SEARCH_ATLAS_CELL_SIZE - fitted.height) // 2,
        ),
    )
    return cell


def _export_entity_thumbnail_atlases(
    root: Path,
    entities: list[dict[str, Any]],
) -> dict[str, dict[str, object]]:
    atlas_root = root / "previews" / "entity-atlases"
    if atlas_root.is_dir():
        shutil.rmtree(atlas_root)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entity in entities:
        if entity.get("renderable"):
            grouped.setdefault(str(entity["kind"]), []).append(entity)

    metadata: dict[str, dict[str, object]] = {}
    for kind, items in sorted(grouped.items()):
        items.sort(key=lambda item: str(item["id"]).casefold())
        columns = min(_ENTITY_ATLAS_COLUMNS, max(1, len(items)))
        rows = (len(items) + columns - 1) // columns
        facing_counts: list[int] = []
        for item in items:
            preview = item.get("preview") or {}
            facing_counts.append(
                8 if preview.get("supports_facing") and preview.get("format") != "vxl" else 1
            )
        sheet_facing_count = max(facing_counts, default=1)
        sheet_pattern = (
            f"previews/entity-atlases/{_safe_filename(kind)}/"
            f"{{facing}}-r{PAGES_RENDER_REVISION}.webp"
        )
        for index, (item, facing_count) in enumerate(zip(items, facing_counts, strict=True)):
            metadata[str(item["id"])] = {
                "path": sheet_pattern,
                "index": index,
                "columns": columns,
                "cell_width": _ENTITY_ATLAS_CELL_WIDTH,
                "cell_height": _ENTITY_ATLAS_CELL_HEIGHT,
                "facing_count": facing_count,
                "content_bounds": [None] * facing_count,
            }

        for facing in range(sheet_facing_count):
            output = root / sheet_pattern.replace("{facing}", str(facing))
            atlas = Image.new(
                "RGBA",
                (columns * _ENTITY_ATLAS_CELL_WIDTH, rows * _ENTITY_ATLAS_CELL_HEIGHT),
                (0, 0, 0, 0),
            )
            for index, (item, facing_count) in enumerate(
                zip(items, facing_counts, strict=True)
            ):
                source_facing = facing if facing < facing_count else 0
                entity_id = _safe_filename(str(item["id"]))
                source = (
                    root
                    / "previews"
                    / "entities"
                    / entity_id
                    / "thumbnail"
                    / str(source_facing)
                    / "0.webp"
                )
                if not source.is_file():
                    raise Ra2ExplorerError(f"单位缩略图图集缺少来源：{item['id']}")
                with Image.open(source) as image:
                    cell = _entity_thumbnail_atlas_cell(
                        image,
                        str(item.get("body_format") or item.get("preview", {}).get("format") or ""),
                    )
                bounds = cell.getchannel("A").getbbox()
                if bounds is None:
                    bounds = (0, 0, _ENTITY_ATLAS_CELL_WIDTH, _ENTITY_ATLAS_CELL_HEIGHT)
                content_bounds = metadata[str(item["id"])]["content_bounds"]
                if isinstance(content_bounds, list):
                    content_bounds[source_facing] = {
                        "x": bounds[0],
                        "y": bounds[1],
                        "width": bounds[2] - bounds[0],
                        "height": bounds[3] - bounds[1],
                    }
                atlas.alpha_composite(
                    cell,
                    (
                        index % columns * _ENTITY_ATLAS_CELL_WIDTH,
                        index // columns * _ENTITY_ATLAS_CELL_HEIGHT,
                    ),
                )
            _save_webp(atlas, output)
    return metadata


def _export_entity_search_thumbnail_atlases(
    root: Path,
    entities: list[dict[str, Any]],
) -> dict[str, dict[str, object]]:
    atlas_root = root / "previews" / "entity-search-atlases"
    if atlas_root.is_dir():
        shutil.rmtree(atlas_root)
    items = sorted(
        (entity for entity in entities if entity.get("renderable")),
        key=lambda item: str(item["id"]).casefold(),
    )
    if not items:
        return {}

    columns = min(_ENTITY_SEARCH_ATLAS_COLUMNS, len(items))
    rows = (len(items) + columns - 1) // columns
    sheet_pattern = (
        "previews/entity-search-atlases/"
        f"{{facing}}-r{PAGES_RENDER_REVISION}.webp"
    )
    metadata = {
        str(item["id"]): {
            "path": sheet_pattern,
            "index": index,
            "columns": columns,
            "cell_width": _ENTITY_SEARCH_ATLAS_CELL_SIZE,
            "cell_height": _ENTITY_SEARCH_ATLAS_CELL_SIZE,
            "facing_count": 8,
        }
        for index, item in enumerate(items)
    }

    for preview_angle in range(8):
        atlas = Image.new(
            "RGBA",
            (
                columns * _ENTITY_SEARCH_ATLAS_CELL_SIZE,
                rows * _ENTITY_SEARCH_ATLAS_CELL_SIZE,
            ),
            (0, 0, 0, 0),
        )
        for index, item in enumerate(items):
            preview = item.get("preview") or {}
            supports_facing = (
                preview.get("supports_facing") and preview.get("format") != "vxl"
            )
            source_facing = (4 + preview_angle) % 8 if supports_facing else 0
            entity_id = _safe_filename(str(item["id"]))
            source = (
                root
                / "previews"
                / "entities"
                / entity_id
                / "thumbnail"
                / str(source_facing)
                / "0.webp"
            )
            if not source.is_file():
                raise Ra2ExplorerError(f"搜索单位缩略图图集缺少来源：{item['id']}")
            with Image.open(source) as image:
                cell = _entity_search_thumbnail_cell(image)
            atlas.alpha_composite(
                cell,
                (
                    index % columns * _ENTITY_SEARCH_ATLAS_CELL_SIZE,
                    index // columns * _ENTITY_SEARCH_ATLAS_CELL_SIZE,
                ),
            )
        _save_webp(
            atlas,
            root / sheet_pattern.replace("{facing}", str(preview_angle)),
        )
    return metadata


def _attach_entity_thumbnail_atlases(
    catalogs: dict[str, tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]],
    metadata: dict[str, dict[str, object]],
    search_metadata: dict[str, dict[str, object]],
) -> None:
    for entities, _media, _details in catalogs.values():
        for item in entities["items"]:
            atlas = metadata.get(str(item["id"]))
            if atlas is not None:
                item["thumbnail_atlas"] = atlas
            search_atlas = search_metadata.get(str(item["id"]))
            if search_atlas is not None:
                item["search_thumbnail_atlas"] = search_atlas


def _composite_entity_preview_layers(
    image: Image.Image,
    focus_bounds: tuple[int, int, int, int] | None,
    shadow_layers: list[Image.Image],
    main_layers: list[Image.Image],
) -> tuple[Image.Image, tuple[int, int, int, int] | None]:
    base_size = image.size
    composite = _alpha_composite_centered([*shadow_layers, image, *main_layers])
    return (
        composite,
        _composite_focus_bounds(
            focus_bounds,
            base_size,
            main_layers,
            composite.size,
        ),
    )


def _animation_tasks(
    root: Path,
    usages: dict[str, _AssetUsage],
    metadata: dict[str, dict[str, Any]],
) -> tuple[list[_ExportTask], list[_ExportTask]]:
    images: dict[Path, _ExportTask] = {}
    models: dict[Path, _ExportTask] = {}
    for asset_id, usage in usages.items():
        asset_format = str(usage.asset.get("format") or "")
        frame_count = max(1, int(metadata.get(asset_id, {}).get("frame_count") or 1))
        requested = _animation_frame_requests(usage, frame_count)
        if asset_format in _MODEL_FORMATS:
            model_frames = {frame for _palette, frame, _shadow in requested}
            for frame in sorted(model_frames or {0}):
                output = root / "models" / "assets" / _safe_filename(asset_id) / f"{frame}.json"
                models[output] = _ExportTask(
                    path=f"/api/assets/{quote(asset_id, safe='')}/model.json",
                    params={"frame": frame},
                    output=output,
                    kind="model",
                )
            continue
        if asset_format not in _IMAGE_FORMATS:
            continue
        if asset_format == "shp":
            continue
        for palette, frame, shadow_frame in sorted(
            requested or {("auto", 0, None)},
            key=lambda item: (item[0], item[1], item[2] if item[2] is not None else -1),
        ):
            palette_kind = None if palette == "auto" else palette
            output = (
                root
                / "previews"
                / "assets"
                / _safe_filename(asset_id)
                / palette
                / f"{frame}-shadow-{shadow_frame if shadow_frame is not None else 'none'}.webp"
            )
            params: dict[str, object] = {"frame": frame, "scale": 5}
            if shadow_frame is not None:
                params["shadow_frame"] = shadow_frame
            if palette_kind:
                params["palette_kind"] = palette_kind
            images[output] = _ExportTask(
                path=f"/api/assets/{quote(asset_id, safe='')}/preview.png",
                params=params,
                output=output,
                kind="image",
            )
    return list(images.values()), list(models.values())


def _animation_frame_requests(
    usage: _AssetUsage,
    frame_count: int,
    paired_shadows: dict[int, int] | None = None,
) -> set[tuple[str, int, int | None]]:
    requested: set[tuple[str, int, int | None]] = set()
    for variant in usage.variants:
        content_total = frame_count // 2 if variant.shadow else frame_count
        for facing in range(8):
            start = variant.start_frame + (
                facing * variant.facing_step if variant.facing_step > 0 else 0
            )
            count = variant.frame_count
            if count is None:
                count = max(1, content_total - start)
            frames = [
                start + index * max(1, variant.frame_step)
                for index in range(max(1, count))
                if start + index * max(1, variant.frame_step) < content_total
            ]
            if not frames:
                frames = [min(max(0, start), max(0, content_total - 1))]
            for frame in frames:
                shadow_frame = (paired_shadows or {}).get(frame)
                if shadow_frame is None and variant.shadow:
                    shadow_frame = frame + frame_count // 2
                if shadow_frame is not None and shadow_frame >= frame_count:
                    shadow_frame = None
                requested.add((variant.palette, frame, shadow_frame))
        requested.add((variant.palette, variant.start_frame, None))
    return requested


def _export_shp_animation_previews(
    services: Services,
    root: Path,
    usages: dict[str, _AssetUsage],
    metadata: dict[str, dict[str, Any]],
    *,
    workers: int,
) -> None:
    selected = [
        (asset_id, usage)
        for asset_id, usage in usages.items()
        if usage.asset.get("format") == "shp"
    ]

    def export(value: tuple[str, _AssetUsage]) -> None:
        asset_id, usage = value
        asset, data = services.reader.read(asset_id)
        sprite = parse_shp(data)
        frame_count = max(1, int(metadata.get(asset_id, {}).get("frame_count") or 1))
        palettes: dict[str, object] = {}
        paired_shadows = {
            int(frame["index"]): int(frame["paired_shadow_frame"])
            for frame in metadata.get(asset_id, {}).get("frames", [])
            if frame.get("paired_shadow_frame") is not None
        }
        for palette, frame, shadow_frame in sorted(
            _animation_frame_requests(usage, frame_count, paired_shadows),
            key=lambda item: (item[0], item[1], item[2] if item[2] is not None else -1),
        ):
            output = (
                root
                / "previews"
                / "assets"
                / _safe_filename(asset_id)
                / palette
                / f"{frame}-shadow-{shadow_frame if shadow_frame is not None else 'none'}.webp"
            )
            if output.is_file() and output.stat().st_size > 0:
                continue
            selected_palette = palettes.get(palette)
            if selected_palette is None:
                palette_kind = None if palette == "auto" else palette
                selected_palette = _select_palette(services, asset, None, palette_kind)
                palettes[palette] = selected_palette
            image = sprite.render(
                frame,
                selected_palette,
                scale=5,
                shadow_frame=shadow_frame,
            )
            _save_webp(image, output)

    _run_parallel("生成单位动画", selected, export, workers=workers)


def _export_render_tasks(
    client: TestClient,
    tasks: list[_ExportTask],
    *,
    workers: int,
    label: str,
) -> None:
    def export(task: _ExportTask) -> None:
        if task.output.is_file() and task.output.stat().st_size > 0:
            return
        response = client.get(task.path, params=task.params)
        if response.status_code != 200:
            raise Ra2ExplorerError(
                f"{label}失败：{task.path} {task.params}（{response.status_code}）"
                f"{response.text[:300]}"
            )
        task.output.parent.mkdir(parents=True, exist_ok=True)
        if task.kind == "image":
            _write_webp(response.content, task.output)
        else:
            task.output.write_bytes(response.content)

    _run_parallel(label, tasks, export, workers=workers)


def _directory_stats(
    root: Path,
    *,
    exclude: frozenset[str] = frozenset(),
) -> dict[str, object]:
    categories: dict[str, dict[str, int]] = {}
    total_files = 0
    total_bytes = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if relative.as_posix() in exclude:
            continue
        size = path.stat().st_size
        total_files += 1
        total_bytes += size
        category = relative.parts[0]
        current = categories.setdefault(category, {"files": 0, "bytes": 0})
        current["files"] += 1
        current["bytes"] += size
    return {"files": total_files, "bytes": total_bytes, "categories": categories}


def archive_pages_snapshot(
    snapshot_root: Path,
    archive: Path,
    *,
    overwrite: bool = False,
) -> dict[str, object]:
    root = snapshot_root.resolve()
    destination = archive.resolve()
    if not root.is_dir() or not (root / "manifest.json").is_file():
        raise Ra2ExplorerError(f"静态快照目录无效：{root}")
    if destination == root or destination.is_relative_to(root):
        raise Ra2ExplorerError("发布 ZIP 不能位于静态快照目录内部")
    if destination.exists() and not overwrite:
        raise Ra2ExplorerError(f"发布 ZIP 已经存在：{destination}；如需替换请添加 --overwrite")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.building-{uuid.uuid4().hex[:8]}"
    files = sorted(path for path in root.rglob("*") if path.is_file())
    print(f"[pages] 压缩发布 ZIP：{len(files):,} 个文件", file=sys.stderr, flush=True)
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
            strict_timestamps=False,
        ) as bundle:
            for index, path in enumerate(files, start=1):
                bundle.write(path, path.relative_to(root).as_posix())
                if index == len(files) or index % 2_000 == 0:
                    print(
                        f"[pages] 压缩发布 ZIP：{index:,}/{len(files):,}",
                        file=sys.stderr,
                        flush=True,
                    )
        os.replace(temporary, destination)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise Ra2ExplorerError(f"发布 ZIP 生成失败：{type(error).__name__}") from error
    return {
        "path": str(destination),
        "files": len(files),
        "bytes": destination.stat().st_size,
    }


def _pages_audio_stats(
    media: dict[str, Any],
    audio_ids: set[str],
) -> dict[str, object]:
    format_counts = Counter(str(item["asset"]["format"]) for item in media["items"])
    return {
        "total_assets": len(audio_ids),
        "formats": [
            {"format": format_name, "count": count}
            for format_name, count in sorted(format_counts.items())
        ],
        "media_kinds": media["kinds"],
        "media_groups": media["groups"],
        "media_event_types": media["event_types"],
    }


def build_pages_snapshot(
    settings: Settings,
    source_id: str,
    *,
    output: Path | None = None,
    archive: Path | None = None,
    ffmpeg: Path | None = None,
    audio_bitrate: str = "24k",
    workers: int = 4,
    overwrite: bool = False,
) -> dict[str, object]:
    if not re.fullmatch(r"[1-9][0-9]*k", audio_bitrate):
        raise Ra2ExplorerError("Opus 码率必须使用类似 24k 或 32k 的格式")
    if not 1 <= workers <= 12:
        raise Ra2ExplorerError("并行任务数必须位于 1 到 12")
    ffmpeg_path = (ffmpeg or Path(shutil.which("ffmpeg") or "")).resolve()
    if not ffmpeg_path.is_file():
        raise Ra2ExplorerError("未找到 ffmpeg；请安装后使用 --ffmpeg 指定可执行文件")

    app = create_app(settings)
    client = TestClient(app)
    source = next(
        (item for item in _request_json(client, "/api/sources") if item["id"] == source_id),
        None,
    )
    if source is None:
        raise Ra2ExplorerError(f"资料库不存在：{source_id}")
    if source.get("state") not in {"ready", "ready_with_errors"}:
        raise Ra2ExplorerError("资料库尚未完成扫描")
    snapshot_id = _snapshot_identity(source)
    target = output or settings.derived_root / "pages" / snapshot_id
    resolved, staging = _prepare_output(target, overwrite=overwrite)
    _resume_reusable_data(resolved, staging)
    generated_at = datetime.now(UTC).isoformat()
    try:
        catalogs: dict[str, tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]] = {}
        for language in ("zh-CN", "zh-TW"):
            print(f"[pages] 生成 {language} 目录", file=sys.stderr, flush=True)
            catalogs[language] = _collect_catalog(client, source_id, language)
            entities, media, details = catalogs[language]
            _write_json(staging / "catalog" / f"entities.{language}.json", entities)
            _write_json(staging / "catalog" / f"media.{language}.json", media)
            for detail in details:
                _write_json(
                    staging / "entities" / language / f"{_safe_filename(str(detail['id']))}.json",
                    detail,
                )

        entities_cn, media_cn, details_cn = catalogs["zh-CN"]
        referenced, animation_usages, audio_ids = _asset_usages(media_cn, details_cn)
        metadata = _export_asset_bundles(
            client,
            staging,
            referenced,
            audio_ids,
            workers=workers,
        )
        _export_audio(
            client,
            staging,
            audio_ids,
            ffmpeg=ffmpeg_path,
            bitrate=audio_bitrate,
            workers=workers,
        )
        entity_images, entity_models = _entity_tasks(staging, source_id, details_cn)
        animation_images, animation_models = _animation_tasks(
            staging,
            animation_usages,
            metadata,
        )
        entity_effect_images = _entity_operation_effect_tasks(
            staging,
            source_id,
            details_cn,
            metadata,
        )
        _export_shp_animation_previews(
            app.state.services,
            staging,
            animation_usages,
            metadata,
            workers=workers,
        )
        _export_entity_previews(
            app.state.services,
            source_id,
            entity_images,
            workers=workers,
        )
        thumbnail_atlases = _export_entity_thumbnail_atlases(staging, details_cn)
        search_thumbnail_atlases = _export_entity_search_thumbnail_atlases(
            staging,
            details_cn,
        )
        _attach_entity_thumbnail_atlases(
            catalogs,
            thumbnail_atlases,
            search_thumbnail_atlases,
        )
        for language, (entities, _media, _details) in catalogs.items():
            _write_json(staging / "catalog" / f"entities.{language}.json", entities)
        _export_render_tasks(
            client,
            animation_images + entity_effect_images,
            workers=workers,
            label="生成 WebP 预览",
        )
        _export_render_tasks(
            client,
            entity_models + animation_models,
            workers=workers,
            label="生成三维模型",
        )
        _prune_reused_exports(
            staging,
            asset_ids=set(referenced),
            audio_ids=audio_ids,
            animation_ids=set(animation_usages),
            entity_ids={
                str(entity["id"])
                for entity in details_cn
                if entity.get("renderable")
            },
        )

        audio_stats = _pages_audio_stats(media_cn, audio_ids)
        diagnostics = _request_json(
            client,
            f"/api/semantic/{quote(source_id, safe='')}/diagnostics",
            limit=8,
        )
        public_diagnostics = {
            key: diagnostics[key]
            for key in (
                "status",
                "entity_count",
                "renderable_count",
                "renderable_percent",
                "localized_count",
                "localized_percent",
                "component_count",
                "resolved_component_count",
                "component_percent",
                "dependency_count",
                "unresolved_dependency_count",
                "kinds",
                "missing_components",
                "warnings",
            )
        }
        sanitized_source = {
            **source,
            "name": "尤里的复仇 · 精简网页版",
            "root_path": "pages://ra2md-slim",
            "created_at": generated_at,
            "scanned_at": generated_at,
            "archive_count": 0,
            "asset_count": len(audio_ids),
            "error": None,
        }
        manifest = {
            "schema_version": PAGES_SNAPSHOT_SCHEMA_VERSION,
            "render_revision": PAGES_RENDER_REVISION,
            "asset_bundle_revision": PAGES_ASSET_BUNDLE_REVISION,
            "snapshot_id": snapshot_id,
            "created_at": generated_at,
            "app_version": __version__,
            "edition": "pages-slim",
            "included": ["units", "sounds"],
            "contains_original_game_files": False,
            "audio_codec": "opus",
            "audio_bitrate": audio_bitrate,
            "source": sanitized_source,
            "stats": audio_stats,
            "diagnostics": public_diagnostics,
            "reference_status": _request_json(client, "/api/reference-data"),
            "catalog": {
                "entities": int(entities_cn["total"]),
                "media": int(media_cn["total"]),
                "audio": len(audio_ids),
                "referenced_assets": len(referenced),
            },
        }
        _write_json(staging / "manifest.json", manifest)
        (staging / "ASSET-NOTICE.txt").write_text(
            "RA2 Explorer GitHub Pages 精简快照\n"
            "仅包含单位浏览所需的派生预览、模型场景数据和压缩声音，"
            "不包含 MIX/BAG/INI/CSF 等原始游戏文件。\n",
            encoding="utf-8",
        )
        payload = _directory_stats(staging, exclude=frozenset({"manifest.json"}))
        manifest["payload"] = payload
        _write_json(staging / "manifest.json", manifest)
        if resolved.exists():
            shutil.rmtree(resolved)
        staging.replace(resolved)
        result = {"output": str(resolved), **manifest}
        print(
            f"[pages] 完成：{result['payload']['files']:,} 个文件，"
            f"{result['payload']['bytes'] / 1024 / 1024:.1f} MiB",
            file=sys.stderr,
            flush=True,
        )
        if archive is not None:
            result["archive"] = archive_pages_snapshot(
                resolved,
                archive,
                overwrite=overwrite,
            )
        return result
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    finally:
        client.close()


__all__ = ["archive_pages_snapshot", "build_pages_snapshot"]
