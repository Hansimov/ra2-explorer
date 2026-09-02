from __future__ import annotations

import io
import json
import math
import os
import re
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ra2_explorer import __version__
from ra2_explorer.codecs.aud import aud_for_browser, parse_aud
from ra2_explorer.codecs.bag import (
    BagAudioEntry,
    bag_audio_for_browser,
    inspect_bag_audio,
)
from ra2_explorer.codecs.csf import parse_csf
from ra2_explorer.codecs.hva import parse_hva
from ra2_explorer.codecs.map import parse_map
from ra2_explorer.codecs.pal import PLAYER_COLOR_PRESETS, grayscale_palette, parse_palette
from ra2_explorer.codecs.shp import ShpFile, parse_shp
from ra2_explorer.codecs.text import decode_legacy_text, parse_ini, text_excerpt
from ra2_explorer.codecs.tmp import parse_tmp
from ra2_explorer.codecs.vpl import parse_vpl
from ra2_explorer.codecs.vxl import (
    VxlRenderPart,
    build_vxl_scene,
    parse_vxl,
    render_vxl_composite,
)
from ra2_explorer.codecs.wav import parse_wav, wav_for_browser
from ra2_explorer.config import Settings, load_settings
from ra2_explorer.derived import DerivedStore
from ra2_explorer.discovery import discover_installations
from ra2_explorer.errors import AssetNotFoundError, InvalidFormatError, Ra2ExplorerError
from ra2_explorer.library import AssetReader, SourceLibrary
from ra2_explorer.localization import DEFAULT_GAME_LANGUAGE, GameLanguage
from ra2_explorer.reference_data import (
    BUNDLED_UNIT_INTEL_TRANSCRIPT_PATH,
    load_audio_transcript,
    load_known_names,
    reference_status,
    sync_known_names,
)
from ra2_explorer.resource_pack import (
    MAX_RESOURCE_PACK_BYTES,
    create_resource_pack,
    import_resource_pack,
    list_resource_packs,
    resource_pack_path,
)
from ra2_explorer.semantic import (
    ENTITY_KINDS,
    ENTITY_USAGES,
    GameEntity,
    MediaSample,
    SemanticLibrary,
)
from ra2_explorer.storage import Database
from ra2_explorer.updates import check_for_updates
from ra2_explorer.video import VideoTranscoder

INSPECTABLE_FORMATS = {
    "aud",
    "bag_audio",
    "csf",
    "hva",
    "ini",
    "map",
    "pal",
    "pcx",
    "shp",
    "text",
    "tmp",
    "vxl",
    "vpl",
    "wav",
}


class SourceRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    name: str | None = Field(default=None, max_length=160)


class ResourcePackExportRequest(BaseModel):
    source_id: str = Field(min_length=1, max_length=160)


class Services:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.database = Database(settings.database_path)
        self.derived = DerivedStore(settings.derived_root)
        self.library = SourceLibrary(
            self.database,
            load_known_names(settings.known_names_path),
            (settings.derived_root,),
        )
        self.reader = AssetReader(self.database, self.derived)
        self.semantic = SemanticLibrary(
            self.database,
            self.reader,
            load_audio_transcript(
                settings.audio_transcript_path,
                supplement_paths=(
                    settings.mission_audio_transcript_path,
                    settings.english_voice_transcript_path,
                    BUNDLED_UNIT_INTEL_TRANSCRIPT_PATH,
                ),
            ),
        )
        self.video = VideoTranscoder(self.database, self.reader, self.derived)

    def reload_names(self) -> None:
        self.library = SourceLibrary(
            self.database,
            load_known_names(self.settings.known_names_path),
            (self.settings.derived_root,),
        )


def _require_local_mode(settings: Settings) -> None:
    if settings.hosted:
        raise HTTPException(status_code=403, detail="在线浏览为只读模式")


def create_app(settings: Settings | None = None) -> FastAPI:
    current_settings = settings or load_settings()
    services = Services(current_settings)
    app = FastAPI(
        title="RA2 Explorer API",
        version=__version__,
        docs_url=None if current_settings.hosted else "/api/docs",
        openapi_url=None if current_settings.hosted else "/api/openapi.json",
    )
    app.state.services = services
    app.add_middleware(GZipMiddleware, minimum_size=1_024)
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["*"]
        if current_settings.hosted
        else ["127.0.0.1", "localhost", "[::1]", "testserver"],
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(AssetNotFoundError)
    async def handle_not_found(_request: Request, error: AssetNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(error)})

    @app.exception_handler(Ra2ExplorerError)
    async def handle_domain_error(_request: Request, error: Ra2ExplorerError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(error)})

    @app.get("/api/health")
    def health() -> dict[str, object]:
        return {
            "status": "ok",
            "name": "ra2-explorer",
            "version": __version__,
            "pid": os.getpid(),
            "mode": "hosted" if current_settings.hosted else "local",
        }

    @app.get("/api/updates/latest")
    async def latest_update() -> dict[str, object]:
        try:
            return await run_in_threadpool(check_for_updates)
        except Ra2ExplorerError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/api/sources")
    def sources() -> list[dict[str, object]]:
        return services.database.list_sources()

    @app.get("/api/discovery")
    async def discovery() -> dict[str, object]:
        if current_settings.hosted:
            return {"candidates": [], "checked_locations": [], "official_sources": []}
        return await run_in_threadpool(discover_installations)

    @app.post("/api/sources", status_code=201)
    async def add_source(payload: SourceRequest) -> dict[str, object]:
        _require_local_mode(current_settings)
        return await run_in_threadpool(
            services.library.import_source,
            Path(payload.path),
            payload.name,
        )

    @app.post("/api/sources/{source_id}/scan")
    async def scan_source(source_id: str) -> dict[str, object]:
        _require_local_mode(current_settings)
        return await run_in_threadpool(services.library.scan, source_id)

    @app.delete("/api/sources/{source_id}")
    def delete_source(source_id: str) -> dict[str, object]:
        _require_local_mode(current_settings)
        return services.database.delete_source(source_id)

    @app.get("/api/resource-packs")
    def resource_packs() -> list[dict[str, object]]:
        return list_resource_packs(services.derived)

    @app.post("/api/resource-packs/export", status_code=201)
    async def export_resource_pack(
        payload: ResourcePackExportRequest,
    ) -> dict[str, object]:
        _require_local_mode(current_settings)
        result = await run_in_threadpool(
            create_resource_pack,
            services.database,
            services.semantic,
            services.derived,
            payload.source_id,
        )
        result.pop("path", None)
        return result

    @app.post("/api/resource-packs/import", status_code=201)
    async def import_uploaded_resource_pack(
        request: Request,
        filename: str = Query(min_length=1, max_length=255),
    ) -> dict[str, object]:
        _require_local_mode(current_settings)
        if Path(filename).name != filename:
            raise HTTPException(status_code=422, detail="资源包文件名无效")
        content_length = request.headers.get("content-length")
        if content_length and (
            not content_length.isdigit() or int(content_length) > MAX_RESOURCE_PACK_BYTES
        ):
            raise HTTPException(status_code=413, detail="资源包超过 2 GiB 限制")
        upload_root = current_settings.derived_root / "imports"
        upload_root.mkdir(parents=True, exist_ok=True)
        temporary = upload_root / f".{uuid.uuid4().hex}.ra2pack"
        total = 0
        try:
            with temporary.open("wb") as stream:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > MAX_RESOURCE_PACK_BYTES:
                        raise HTTPException(status_code=413, detail="资源包超过 2 GiB 限制")
                    stream.write(chunk)
            if total == 0:
                raise HTTPException(status_code=422, detail="资源包为空")
            return await run_in_threadpool(
                import_resource_pack,
                services.database,
                services.derived,
                temporary,
            )
        finally:
            temporary.unlink(missing_ok=True)

    @app.get("/api/resource-packs/{filename}")
    def download_resource_pack(filename: str) -> FileResponse:
        path = resource_pack_path(services.derived, filename)
        return FileResponse(
            path,
            media_type="application/zip",
            filename=path.name,
        )

    @app.get("/api/assets")
    def assets(
        source_id: str | None = None,
        q: str | None = Query(default=None, max_length=200),
        format: str | None = Query(default=None, max_length=24),
        formats: str | None = Query(default=None, max_length=240),
        sort: str = Query(default="name_asc", max_length=20),
        limit: int = Query(default=100, ge=1, le=1_000),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, object]:
        selected_formats = tuple(
            item.strip().casefold() for item in (formats or "").split(",") if item.strip()
        )
        if len(selected_formats) > 20 or any(
            not item.replace("_", "").isalnum() for item in selected_formats
        ):
            raise HTTPException(status_code=422, detail="资源格式筛选无效")
        if sort not in {"name_asc", "name_desc", "size_desc", "size_asc"}:
            raise HTTPException(status_code=422, detail="资源排序方式无效")
        return services.database.list_assets(
            source_id=source_id,
            query=q,
            asset_format=format,
            asset_formats=selected_formats,
            sort_by=sort,
            limit=limit,
            offset=offset,
        )

    @app.get("/api/assets/{asset_id}")
    def asset(asset_id: str) -> dict[str, object]:
        return services.database.get_asset(asset_id)

    @app.get("/api/assets/{asset_id}/associations")
    def asset_associations(
        asset_id: str,
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
    ) -> dict[str, object]:
        asset_record = services.database.get_asset(asset_id)
        return services.semantic.asset_associations(
            str(asset_record["source_id"]), asset_id, language
        )

    @app.get("/api/entities")
    def entities(
        source_id: str,
        q: str | None = Query(default=None, max_length=200),
        kind: str | None = Query(default=None),
        kinds: str | None = Query(default=None, max_length=128),
        usage: str | None = Query(default=None, max_length=32),
        usages: str | None = Query(default=None, max_length=128),
        side: str | None = Query(default=None, max_length=64),
        renderable: bool | None = Query(default=None),
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
        limit: int = Query(default=100, ge=1, le=1_000),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, object]:
        selected_kinds = tuple(
            dict.fromkeys(value.strip() for value in (kinds or "").split(",") if value.strip())
        )
        selected_usages = tuple(
            dict.fromkeys(value.strip() for value in (usages or "").split(",") if value.strip())
        )
        if kind is not None and kind not in ENTITY_KINDS:
            raise HTTPException(status_code=422, detail="未知单位类型")
        if any(value not in ENTITY_KINDS for value in selected_kinds):
            raise HTTPException(status_code=422, detail="未知单位类型")
        if usage is not None and usage not in ENTITY_USAGES:
            raise HTTPException(status_code=422, detail="未知单位分类")
        if any(value not in ENTITY_USAGES for value in selected_usages):
            raise HTTPException(status_code=422, detail="未知单位分类")
        return services.semantic.list_entities(
            source_id,
            query=q,
            kind=kind,
            kinds=selected_kinds,
            usage=usage,
            usages=selected_usages,
            side=side,
            renderable=renderable,
            language=language,
            limit=limit,
            offset=offset,
        )

    @app.get("/api/media")
    def media(
        source_id: str,
        q: str | None = Query(default=None, max_length=200),
        kind: str | None = Query(default=None),
        group: str | None = Query(default=None, max_length=64),
        event_type: str | None = Query(default=None, max_length=64),
        sort: str = Query(default="name_asc", max_length=24),
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
        limit: int = Query(default=500, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, object]:
        if kind is not None and kind not in {"voice", "sound", "unknown"}:
            raise HTTPException(status_code=422, detail="未知音频类型")
        if sort not in {"name_asc", "name_desc", "description_asc"}:
            raise HTTPException(status_code=422, detail="未知音频排序方式")
        return services.semantic.list_media(
            source_id,
            query=q,
            kind=kind,
            group=group,
            event_type=event_type,
            sort=sort,
            language=language,
            limit=limit,
            offset=offset,
        )

    @app.get("/api/semantic/{source_id}/diagnostics")
    def semantic_diagnostics(
        source_id: str,
        limit: int = Query(default=20, ge=1, le=100),
    ) -> dict[str, object]:
        return services.semantic.diagnostics(source_id, limit=limit)

    @app.get("/api/entities/{source_id}/{entity_id}")
    def entity(
        source_id: str,
        entity_id: str,
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
    ) -> dict[str, object]:
        return services.semantic.get_entity(source_id, entity_id, language)

    @app.get("/api/entities/{source_id}/{entity_id}/preview.png")
    def entity_preview(
        source_id: str,
        entity_id: str,
        frame: int = Query(default=0, ge=0),
        facing: int = Query(default=0, ge=0, le=7),
        player_color: str | None = Query(default=None, max_length=24),
        palette_id: str | None = None,
        scale: int = Query(default=4, ge=1, le=12),
        thumbnail: bool = False,
        compact: bool = False,
        effect_asset_id: str | None = None,
        effect_frame: int = Query(default=0, ge=0),
        effect_shadow_frame: int | None = Query(default=None, ge=0),
        effect_palette_kind: Literal["unit", "animation"] | None = None,
    ) -> Response:
        semantic_entity = services.semantic.catalog(source_id).get(entity_id)
        body = semantic_entity.component("body")
        if body is None:
            raise HTTPException(status_code=409, detail="该单位没有可渲染的主体资产")
        player_color = _validated_player_color(player_color)
        renderer_version = "shp-layers-v9" if body["format"] == "shp" else "vpl-body-v3"
        artifact_path = _source_artifact_path(
            services,
            "previews",
            source_id,
            entity_id,
            renderer_version,
            f"frame-{frame}",
            f"facing-{facing}",
            f"color-{player_color or 'original'}",
            f"palette-{palette_id or 'auto'}",
            f"scale-{scale}",
            f"thumbnail-{thumbnail}",
            f"compact-{compact}",
            f"effect-{effect_asset_id or 'none'}",
            f"effect-frame-{effect_frame}",
            f"effect-shadow-{effect_shadow_frame if effect_shadow_frame is not None else 'none'}",
            f"effect-palette-{effect_palette_kind or 'auto'}",
            extension="png",
        )
        cached = services.derived.read_bytes(artifact_path)
        if cached is not None:
            return Response(
                content=cached,
                media_type="image/png",
                headers={"Cache-Control": "private, max-age=3600"},
            )
        palette = _select_palette(services, body, palette_id)
        _, image, focus_bounds = services.semantic.render(
            source_id,
            entity_id,
            palette=palette,
            frame=frame,
            facing=facing,
            player_color=player_color,
            scale=scale,
        )
        default_effect_samples = (
            _default_entity_operation_samples(
                semantic_entity,
                excluded_asset_id=effect_asset_id,
            )
            if body["format"] == "shp"
            else ()
        )
        shadow_layers: list[Image.Image] = []
        main_layers: list[Image.Image] = []
        for sample in default_effect_samples:
            rendered_layer = _render_entity_shp_layer(
                services,
                sample,
                player_color=player_color,
                scale=scale,
            )
            if rendered_layer is None:
                continue
            shadow_layer, main_layer = rendered_layer
            if shadow_layer is not None:
                shadow_layers.append(shadow_layer)
            main_layers.append(main_layer)
        if effect_asset_id:
            if body["format"] != "shp":
                raise HTTPException(
                    status_code=409,
                    detail="只有 SHP 主体支持原始画布动画合成",
                )
            effect_asset, effect_data = services.reader.read(effect_asset_id)
            if effect_asset["source_id"] != body["source_id"] or effect_asset["format"] != "shp":
                raise HTTPException(status_code=409, detail="动画资产不属于当前 SHP 单位")
            effect_sprite = parse_shp(effect_data)
            if effect_frame >= len(effect_sprite.frames) or (
                effect_shadow_frame is not None and effect_shadow_frame >= len(effect_sprite.frames)
            ):
                raise HTTPException(status_code=416, detail="动画帧编号超出范围")
            effect_palette = _select_palette(
                services,
                effect_asset,
                None,
                effect_palette_kind,
            )
            if player_color:
                effect_palette = (effect_palette or grayscale_palette()).with_player_color(
                    player_color
                )
            effect_main = effect_sprite.render(effect_frame, effect_palette, scale=scale)
            if effect_shadow_frame is not None:
                shadow_layers.append(effect_sprite.render_shadow(effect_shadow_frame, scale=scale))
            main_layers.append(effect_main)
        if shadow_layers or main_layers:
            base_size = image.size
            image = _alpha_composite_centered([*shadow_layers, image, *main_layers])
            focus_bounds = _composite_focus_bounds(
                focus_bounds,
                base_size,
                main_layers,
                image.size,
            )
        image, focus_bounds = _composite_building_voxel_turret(
            services,
            source_id,
            semantic_entity,
            image,
            focus_bounds,
            palette=palette,
            frame=frame,
            facing=facing,
            player_color=player_color,
            scale=scale,
        )
        if thumbnail:
            image = _crop_transparent_preview(
                image,
                padding_ratio=_entity_thumbnail_padding(semantic_entity, compact=compact),
                focus_bounds=None if compact else focus_bounds,
            )
        output = io.BytesIO()
        image.save(output, format="PNG")
        rendered = output.getvalue()
        services.derived.write_bytes(artifact_path, rendered)
        return Response(
            content=rendered,
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @app.get("/api/entities/{source_id}/{entity_id}/model.json")
    def entity_model(
        source_id: str,
        entity_id: str,
        frame: int = Query(default=0, ge=0),
        player_color: str | None = Query(default=None, max_length=24),
        palette_id: str | None = None,
    ) -> Response:
        semantic_entity = services.semantic.catalog(source_id).get(entity_id)
        body = semantic_entity.component("body")
        if body is None or body["format"] != "vxl":
            raise HTTPException(status_code=409, detail="该单位不是 VXL 模型")
        player_color = _validated_player_color(player_color)
        artifact_path = _source_artifact_path(
            services,
            "models",
            source_id,
            entity_id,
            "scene-v4-vpl-techno-body-v2",
            f"frame-{frame}",
            f"color-{player_color or 'original'}",
            f"palette-{palette_id or 'auto'}",
            extension="json",
        )
        cached = services.derived.read_bytes(artifact_path)
        if cached is not None:
            return _model_response(cached)
        palette = _select_palette(services, body, palette_id)
        _, scene = services.semantic.model_scene(
            source_id,
            entity_id,
            palette=palette,
            frame=frame,
            player_color=player_color,
        )
        result = scene.as_dict()
        encoded = _json_bytes(result)
        services.derived.write_bytes(artifact_path, encoded)
        return _model_response(encoded)

    @app.get("/api/assets/{asset_id}/content")
    def asset_content(asset_id: str) -> StreamingResponse:
        asset_record = services.database.get_asset(asset_id)
        safe_name = Path(asset_record["display_name"]).name or "asset.bin"
        media_type = "application/octet-stream"
        if asset_record["format"] == "bag_audio":
            asset_record, data, _ = _browser_audio(services, asset_id)
            media_type = "audio/wav"
        else:
            asset_record, data = services.reader.read(asset_id)
        disposition = f"attachment; filename*=UTF-8''{quote(safe_name)}"
        return StreamingResponse(
            io.BytesIO(data),
            media_type=media_type,
            headers={"Content-Disposition": disposition},
        )

    @app.get("/api/assets/{asset_id}/shp")
    def shp_metadata(asset_id: str) -> dict[str, object]:
        asset_record, data = services.reader.read(asset_id)
        if asset_record["format"] != "shp":
            raise HTTPException(status_code=409, detail="该资产不是 SHP")
        sprite = parse_shp(data)
        return {
            "width": sprite.width,
            "height": sprite.height,
            "frame_count": len(sprite.frames),
            "frames": _shp_frame_metadata(sprite),
        }

    @app.get("/api/assets/{asset_id}/model.json")
    def asset_model(
        asset_id: str,
        frame: int = Query(default=0, ge=0),
        player_color: str | None = Query(default=None, max_length=24),
        palette_id: str | None = None,
    ) -> Response:
        asset_record = services.database.get_asset(asset_id)
        if asset_record["format"] not in {"vxl", "hva"}:
            raise HTTPException(status_code=409, detail="该资产不是 VXL/HVA 模型")
        source_id = str(asset_record["source_id"])
        stem = Path(str(asset_record["display_name"])).stem
        related = services.database.assets_named(
            source_id,
            (f"{stem}.vxl", f"{stem}.hva"),
        )
        model_asset = (
            asset_record
            if asset_record["format"] == "vxl"
            else next((item for item in related if item["format"] == "vxl"), None)
        )
        animation_asset = (
            asset_record
            if asset_record["format"] == "hva"
            else next((item for item in related if item["format"] == "hva"), None)
        )
        if model_asset is None:
            raise HTTPException(status_code=409, detail="没有找到与 HVA 同名的 VXL 模型")
        palette = _select_palette(services, model_asset, palette_id)
        player_color = _validated_player_color(player_color)
        artifact_path = _asset_artifact_path(
            services,
            "models",
            asset_record,
            "scene-v4-vpl",
            f"model-{model_asset['id']}",
            f"animation-{animation_asset['id'] if animation_asset else 'none'}",
            f"frame-{frame}",
            f"color-{player_color or 'original'}",
            f"palette-{palette_id or 'auto'}",
            extension="json",
        )
        cached = services.derived.read_bytes(artifact_path)
        if cached is not None:
            return _model_response(cached)
        _, model_data = services.reader.read(str(model_asset["id"]))
        animation = None
        if animation_asset is not None:
            _, animation_data = services.reader.read(str(animation_asset["id"]))
            animation = parse_hva(animation_data)
        scene = build_vxl_scene(
            (VxlRenderPart(parse_vxl(model_data), animation),),
            palette=palette,
            frame=frame,
            player_color=player_color,
            vpl=services.semantic.voxel_lighting(source_id),
        )
        result = scene.as_dict()
        encoded = _json_bytes(result)
        services.derived.write_bytes(artifact_path, encoded)
        return _model_response(encoded)

    @app.get("/api/assets/{asset_id}/metadata")
    def asset_metadata(asset_id: str) -> dict[str, object]:
        asset_record = services.database.get_asset(asset_id)
        artifact_path = _asset_artifact_path(
            services,
            "metadata",
            asset_record,
            "inspection-v2-shp-bounds",
            extension="json",
        )
        cached = services.derived.read_json(artifact_path)
        if cached is not None:
            return cached
        if asset_record["format"] in INSPECTABLE_FORMATS:
            asset_record, data = services.reader.read(asset_id)
            result = _inspect_asset(asset_record, data)
        else:
            result = {
                "format": asset_record["format"],
                "size": asset_record["size"],
            }
        services.derived.write_json(artifact_path, result)
        return result

    @app.get("/api/assets/{asset_id}/text")
    def asset_text(
        asset_id: str,
        q: str | None = Query(default=None, max_length=200),
        limit: int = Query(default=400, ge=1, le=2_000),
    ) -> dict[str, object]:
        asset_record, data = services.reader.read(asset_id)
        asset_format = str(asset_record["format"])
        if asset_format == "csf":
            parsed = parse_csf(data)
            return {
                "format": "csf",
                "version": parsed.version,
                "language": parsed.language,
                "label_count": len(parsed.labels),
                "string_count": parsed.string_count,
                **parsed.excerpt(query=q, limit=limit),
            }
        if asset_format in {"ini", "map"}:
            parsed_ini = parse_ini(data)
            return {
                "format": asset_format,
                "encoding": parsed_ini.encoding,
                "section_count": len(parsed_ini.sections),
                "entry_count": parsed_ini.entry_count,
                **text_excerpt(parsed_ini.text, query=q, limit=limit),
            }
        if asset_format == "text":
            decoded = decode_legacy_text(data)
            return {
                "format": "text",
                "encoding": decoded.encoding,
                **text_excerpt(decoded.text, query=q, limit=limit),
            }
        raise HTTPException(status_code=409, detail="该格式不是可读取的文本资产")

    @app.get("/api/assets/{asset_id}/preview.png")
    def asset_preview(
        asset_id: str,
        frame: int = Query(default=0, ge=0),
        player_color: str | None = Query(default=None, max_length=24),
        palette_id: str | None = None,
        palette_kind: Literal["unit", "animation"] | None = None,
        shadow_frame: int | None = Query(default=None, ge=0),
        scale: int = Query(default=4, ge=1, le=16),
    ) -> Response:
        asset_record = services.database.get_asset(asset_id)
        player_color = _validated_player_color(player_color)
        if asset_record["format"] not in {
            "pal",
            "shp",
            "vxl",
            "hva",
            "tmp",
            "pcx",
            "map",
        }:
            raise HTTPException(status_code=409, detail="该格式没有图像预览")
        artifact_path = _asset_artifact_path(
            services,
            "previews",
            asset_record,
            "renderer-shp-shadow-palette-v1",
            f"frame-{frame}",
            f"color-{player_color or 'original'}",
            f"palette-{palette_id or 'auto'}",
            f"palette-kind-{palette_kind or 'auto'}",
            f"shadow-{shadow_frame if shadow_frame is not None else 'none'}",
            f"scale-{scale}",
            extension="png",
        )
        cached = services.derived.read_bytes(artifact_path)
        if cached is not None:
            return Response(
                content=cached,
                media_type="image/png",
                headers={"Cache-Control": "private, max-age=3600"},
            )
        asset_record, data = services.reader.read(asset_id)
        if asset_record["format"] == "pal":
            image = parse_palette(data).preview(cell_size=max(4, scale * 3))
        elif asset_record["format"] == "shp":
            sprite = parse_shp(data)
            if frame >= len(sprite.frames) or (
                shadow_frame is not None and shadow_frame >= len(sprite.frames)
            ):
                raise HTTPException(status_code=416, detail="帧编号超出范围")
            palette = _select_palette(
                services,
                asset_record,
                palette_id,
                palette_kind,
            )
            if player_color:
                palette = (palette or grayscale_palette()).with_player_color(player_color)
            image = sprite.render(
                frame,
                palette,
                scale=scale,
                shadow_frame=shadow_frame,
            )
        elif asset_record["format"] == "vxl":
            model = parse_vxl(data)
            if frame >= len(model.limbs):
                raise HTTPException(status_code=416, detail="部件编号超出范围")
            palette = _select_palette(services, asset_record, palette_id)
            image = model.render(
                frame,
                palette=palette,
                player_color=player_color,
                scale=scale,
            )
        elif asset_record["format"] == "hva":
            source_id = str(asset_record["source_id"])
            stem = Path(str(asset_record["display_name"])).stem
            related = services.database.assets_named(source_id, (f"{stem}.vxl",))
            model_asset = next((item for item in related if item["format"] == "vxl"), None)
            if model_asset is None:
                raise HTTPException(status_code=409, detail="没有找到与 HVA 同名的 VXL 模型")
            _, model_data = services.reader.read(str(model_asset["id"]))
            animation = parse_hva(data)
            if frame >= animation.frame_count:
                raise HTTPException(status_code=416, detail="帧编号超出范围")
            palette = _select_palette(services, model_asset, palette_id)
            image = render_vxl_composite(
                (VxlRenderPart(parse_vxl(model_data), animation),),
                palette=palette,
                frame=frame,
                player_color=player_color,
                vpl=services.semantic.voxel_lighting(source_id),
                scale=scale,
            )
        elif asset_record["format"] == "tmp":
            template = parse_tmp(data)
            if frame >= len(template.tiles):
                raise HTTPException(status_code=416, detail="地块编号超出范围")
            palette = _select_palette(services, asset_record, palette_id)
            image = template.render(frame, palette=palette, scale=scale)
        elif asset_record["format"] == "pcx":
            try:
                image = Image.open(io.BytesIO(data))
                image.load()
            except (OSError, UnidentifiedImageError) as error:
                raise InvalidFormatError("PCX 文件无法解码") from error
            if image.width * image.height > 16_777_216:
                raise InvalidFormatError("PCX 图像超过预览安全限制")
            image = image.convert("RGBA")
            if scale > 1:
                image = image.resize(
                    (image.width * scale, image.height * scale),
                    resample=Image.Resampling.NEAREST,
                )
        elif asset_record["format"] == "map":
            image = parse_map(data).render(scale=scale)
        else:
            raise HTTPException(status_code=409, detail="该格式没有图像预览")
        output = io.BytesIO()
        image.save(output, format="PNG")
        rendered = output.getvalue()
        services.derived.write_bytes(artifact_path, rendered)
        return Response(
            content=rendered,
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @app.get("/api/assets/{asset_id}/media")
    def asset_media(asset_id: str) -> Response:
        _, playable_data, transcoded = _browser_audio(services, asset_id)
        headers = {"Cache-Control": "private, max-age=3600"}
        if transcoded:
            headers["X-RA2-Transcoded"] = "source-audio-to-pcm"
        return Response(
            content=playable_data,
            media_type="audio/wav",
            headers=headers,
        )

    @app.get("/api/assets/{asset_id}/video.mp4")
    def asset_video(asset_id: str) -> FileResponse:
        path = services.video.browser_video(asset_id)
        return FileResponse(
            path,
            media_type="video/mp4",
            headers={"Cache-Control": "private, max-age=86400"},
        )

    @app.get("/api/palettes")
    def palettes(source_id: str) -> list[dict[str, object]]:
        return services.database.palette_assets(source_id)

    @app.get("/api/player-colors")
    def player_colors() -> list[dict[str, object]]:
        return [
            {
                "id": name,
                "rgb": list(color),
                "hex": "#" + "".join(f"{component:02x}" for component in color),
            }
            for name, color in PLAYER_COLOR_PRESETS.items()
        ]

    @app.get("/api/stats")
    def stats(source_id: str | None = None) -> dict[str, object]:
        return services.database.stats(source_id)

    @app.get("/api/reference-data")
    def reference_data() -> dict[str, object]:
        return reference_status(current_settings.known_names_path)

    @app.post("/api/reference-data/names/sync")
    async def sync_reference_data() -> dict[str, object]:
        _require_local_mode(current_settings)
        manifest = await run_in_threadpool(sync_known_names, current_settings.known_names_path)
        services.reload_names()
        return manifest

    if current_settings.frontend_dir.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=current_settings.frontend_dir, html=True),
            name="frontend",
        )
    else:

        @app.get("/")
        def root() -> dict[str, str]:
            return {
                "name": "RA2 Explorer API",
                "docs": "/api/docs",
                "message": "frontend/dist 尚未构建",
            }

    return app


def _validated_player_color(player_color: str | None) -> str | None:
    if player_color is None:
        return None
    normalized = player_color.casefold()
    if normalized not in PLAYER_COLOR_PRESETS:
        raise HTTPException(status_code=422, detail="未知阵营颜色")
    return normalized


def _bag_entry_from_asset(asset: dict[str, object]) -> BagAudioEntry:
    channels = int(asset["channels"])
    codec = str(asset["codec"])
    flags = 0x04 | (0x01 if channels == 2 else 0)
    flags |= 0x02 if codec == "pcm16" else 0x08
    return BagAudioEntry(
        name=Path(str(asset["display_name"])).stem,
        offset=int(asset["data_offset"]),
        size=int(asset["data_size"]),
        sample_rate=int(asset["sample_rate"]),
        flags=flags,
        block_align=int(asset["block_align"]),
    )


def _asset_artifact_path(
    services: Services,
    kind: str,
    asset: dict[str, object],
    *identity: object,
    extension: str,
) -> Path:
    source = services.database.get_source(str(asset["source_id"]))
    return services.derived.artifact_path(
        kind,
        source_id=source["id"],
        revision=source.get("scanned_at") or source["created_at"],
        identity=(asset["id"], *identity),
        extension=extension,
    )


def _source_artifact_path(
    services: Services,
    kind: str,
    source_id: str,
    *identity: object,
    extension: str,
) -> Path:
    source = services.database.get_source(source_id)
    return services.derived.artifact_path(
        kind,
        source_id=source["id"],
        revision=source.get("scanned_at") or source["created_at"],
        identity=identity,
        extension=extension,
    )


def _crop_transparent_preview(
    image,
    *,
    padding_ratio: float = 0.08,
    focus_bounds: tuple[int, int, int, int] | None = None,
):
    if "A" not in image.getbands():
        return image
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        return image
    visible_left, visible_top, visible_right, visible_bottom = bounds
    focus_left, focus_top, focus_right, focus_bottom = focus_bounds or bounds
    center_x = (focus_left + focus_right) / 2
    center_y = (focus_top + focus_bottom) / 2
    half_width = max(center_x - visible_left, visible_right - center_x)
    half_height = max(center_y - visible_top, visible_bottom - center_y)
    padding = max(
        2,
        round(max(focus_right - focus_left, focus_bottom - focus_top) * padding_ratio),
    )
    return image.crop(
        (
            math.floor(center_x - half_width - padding),
            math.floor(center_y - half_height - padding),
            math.ceil(center_x + half_width + padding),
            math.ceil(center_y + half_height + padding),
        )
    )


def _entity_thumbnail_padding(entity: GameEntity, *, compact: bool) -> float:
    return 0.08 if compact or entity.kind != "infantry" else 0.20


def _default_entity_operation_samples(
    entity: GameEntity,
    *,
    excluded_asset_id: str | None = None,
) -> tuple[MediaSample, ...]:
    samples: list[MediaSample] = []
    seen_assets: set[str] = set()
    excluded_super_family = any(
        association.kind == "animation"
        and association.role == "operation"
        and association.slot.casefold().startswith("superanim")
        and any(
            sample.asset and str(sample.asset["id"]) == excluded_asset_id
            for sample in association.samples
        )
        for association in entity.media
    )
    for association in entity.media:
        if association.kind != "animation" or association.role != "operation":
            continue
        slot = association.slot.casefold()
        is_persistent = bool(
            re.fullmatch(r"(?:active|idle)anim(?:two|three|four)?", slot)
            or slot == "superanim"
        )
        if not is_persistent or (excluded_super_family and slot.startswith("superanim")):
            continue
        configured = next(
            (
                sample
                for sample in association.samples
                if sample.name == association.selected_sample
                and sample.asset
                and sample.asset.get("format") == "shp"
            ),
            None,
        )
        sample = configured or next(
            (
                candidate
                for candidate in association.samples
                if candidate.asset and candidate.asset.get("format") == "shp"
            ),
            None,
        )
        if sample is None or sample.asset is None or sample.asset.get("format") != "shp":
            continue
        asset_id = str(sample.asset["id"])
        if asset_id == excluded_asset_id or asset_id in seen_assets:
            continue
        seen_assets.add(asset_id)
        samples.append(sample)
    return tuple(samples)


def _render_entity_shp_layer(
    services: Services,
    sample: MediaSample,
    *,
    player_color: str | None,
    scale: int,
) -> tuple[Image.Image | None, Image.Image] | None:
    asset = sample.asset
    if asset is None or asset.get("format") != "shp":
        return None
    try:
        _, data = services.reader.read(str(asset["id"]))
        sprite = parse_shp(data)
        source_frame = sample.animation.start_frame if sample.animation else 0
        if source_frame >= len(sprite.frames):
            return None
        palette_kind: Literal["unit", "animation"] | None = (
            sample.palette if sample.palette in {"unit", "animation"} else None
        )
        palette = _select_palette(services, asset, None, palette_kind)
        if player_color:
            palette = (palette or grayscale_palette()).with_player_color(player_color)
        main = sprite.render(source_frame, palette, scale=scale)
        shadow_frame = (
            sprite.paired_shadow_frame(source_frame)
            if sample.animation and sample.animation.shadow
            else None
        )
        shadow = (
            sprite.render_shadow(shadow_frame, scale=scale) if shadow_frame is not None else None
        )
        return shadow, main
    except (OSError, Ra2ExplorerError, ValueError):
        return None


def _shp_frame_metadata(sprite: ShpFile) -> list[dict[str, object]]:
    shadow_pairs = {
        frame_index: shadow_frame
        for frame_index in range(len(sprite.frames) // 2)
        if (shadow_frame := sprite.paired_shadow_frame(frame_index)) is not None
    }
    frames = []
    for frame in sprite.frames:
        content_bounds = sprite.content_bounds(frame.index)
        frames.append(
            {
                "index": frame.index,
                "x": frame.x,
                "y": frame.y,
                "width": frame.width,
                "height": frame.height,
                "compression": frame.compression,
                "content_bounds": (
                    {
                        "x": content_bounds[0],
                        "y": content_bounds[1],
                        "width": content_bounds[2],
                        "height": content_bounds[3],
                    }
                    if content_bounds is not None
                    else None
                ),
                "paired_shadow_frame": shadow_pairs.get(frame.index),
            }
        )
    return frames


def _browser_audio(
    services: Services,
    asset_id: str,
) -> tuple[dict[str, object], bytes, bool]:
    asset = services.database.get_asset(asset_id)
    if asset["format"] == "bag_audio":
        asset = {**asset, **services.database.get_asset_segment(asset_id)}
    if asset["format"] not in {"wav", "aud", "bag_audio"}:
        raise HTTPException(status_code=409, detail="该格式不能直接在浏览器中播放")
    path = _asset_artifact_path(services, "audio", asset, "browser-pcm", extension="wav")
    cached = services.derived.read_bytes(path)
    transcoded = asset["format"] == "aud" or (
        asset["format"] == "bag_audio" and str(asset["codec"]) == "ima_adpcm"
    )
    if cached is not None:
        return asset, cached, transcoded
    _, data = services.reader.read(asset_id)
    if asset["format"] == "wav":
        playable_data, transcoded = wav_for_browser(data)
    elif asset["format"] == "aud":
        playable_data = aud_for_browser(data)
    else:
        playable_data = bag_audio_for_browser(data, _bag_entry_from_asset(asset))
    services.derived.write_bytes(path, playable_data)
    return asset, playable_data, transcoded


def _select_palette(
    services: Services,
    asset: dict[str, object],
    palette_id: str | None,
    palette_kind: Literal["unit", "animation"] | None = None,
):
    palettes = services.database.palette_assets(str(asset["source_id"]))
    if palette_id:
        palette_asset = services.database.get_asset(palette_id)
        if palette_asset["source_id"] != asset["source_id"] or palette_asset["format"] != "pal":
            raise HTTPException(status_code=409, detail="调色板不属于当前资源目录")
        _, palette_data = services.reader.read(palette_id)
        return parse_palette(palette_data)
    if not palettes:
        return None
    extension = str(asset.get("extension") or "").lower()
    theater = {
        "tem": "tem",
        "tmp": "tem",
        "urb": "urb",
        "sno": "sno",
        "des": "des",
        "ubn": "ubn",
        "lun": "lun",
    }.get(extension)
    virtual_path = str(asset.get("virtual_path") or "").casefold()
    if theater is None:
        theater = next(
            (
                code
                for marker, code in (
                    ("snow.mix", "sno"),
                    ("urbann.mix", "ubn"),
                    ("urban.mix", "urb"),
                    ("lunar.mix", "lun"),
                    ("desert.mix", "des"),
                    ("temperat.mix", "tem"),
                )
                if marker in virtual_path
            ),
            "tem",
        )
    uses_iso_palette = asset.get("format") == "tmp"
    preferred = (
        ["anim.pal", f"unit{theater}.pal", "unittem.pal"]
        if palette_kind == "animation"
        else [f"iso{theater}.pal", "isotem.pal", f"unit{theater}.pal", "unittem.pal"]
        if uses_iso_palette
        else [f"unit{theater}.pal", "unittem.pal", f"iso{theater}.pal", "isotem.pal"]
    )
    priority = {name: index for index, name in enumerate(preferred)}
    palette_asset = min(
        palettes,
        key=lambda item: (
            priority.get(str(item["display_name"]).lower(), 99),
            item["display_name"],
        ),
    )
    _, palette_data = services.reader.read(palette_asset["id"])
    return parse_palette(palette_data)


def _alpha_composite_centered(layers: list[Image.Image]) -> Image.Image:
    width = max(layer.width for layer in layers)
    height = max(layer.height for layer in layers)
    output = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for layer in layers:
        output.alpha_composite(
            layer.convert("RGBA"),
            ((width - layer.width) // 2, (height - layer.height) // 2),
        )
    return output


def _alpha_composite_anchored(
    base: Image.Image,
    overlay: Image.Image,
    *,
    overlay_anchor: tuple[int, int],
    target_anchor: tuple[int, int],
    base_focus: tuple[int, int, int, int] | None,
) -> tuple[Image.Image, tuple[int, int, int, int] | None]:
    overlay_left = target_anchor[0] - overlay_anchor[0]
    overlay_top = target_anchor[1] - overlay_anchor[1]
    left = min(0, overlay_left)
    top = min(0, overlay_top)
    right = max(base.width, overlay_left + overlay.width)
    bottom = max(base.height, overlay_top + overlay.height)
    base_offset = (-left, -top)
    overlay_offset = (overlay_left - left, overlay_top - top)
    output = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
    output.alpha_composite(base.convert("RGBA"), base_offset)
    output.alpha_composite(overlay.convert("RGBA"), overlay_offset)

    candidates: list[tuple[int, int, int, int]] = []
    if base_focus is not None:
        candidates.append(
            (
                base_focus[0] + base_offset[0],
                base_focus[1] + base_offset[1],
                base_focus[2] + base_offset[0],
                base_focus[3] + base_offset[1],
            )
        )
    overlay_bounds = overlay.getchannel("A").getbbox()
    if overlay_bounds is not None:
        candidates.append(
            (
                overlay_bounds[0] + overlay_offset[0],
                overlay_bounds[1] + overlay_offset[1],
                overlay_bounds[2] + overlay_offset[0],
                overlay_bounds[3] + overlay_offset[1],
            )
        )
    if not candidates:
        return output, None
    return output, (
        min(bounds[0] for bounds in candidates),
        min(bounds[1] for bounds in candidates),
        max(bounds[2] for bounds in candidates),
        max(bounds[3] for bounds in candidates),
    )


def _composite_building_voxel_turret(
    services: Services,
    source_id: str,
    entity: GameEntity,
    image: Image.Image,
    focus_bounds: tuple[int, int, int, int] | None,
    *,
    palette: object,
    frame: int,
    facing: int,
    player_color: str | None,
    scale: int,
) -> tuple[Image.Image, tuple[int, int, int, int] | None]:
    turret = services.semantic.render_building_voxel_turret(
        source_id,
        entity,
        palette=palette,
        frame=frame,
        facing=facing,
        player_color=player_color,
        scale=scale,
    )
    if turret is None:
        return image, focus_bounds
    turret_image, turret_origin = turret
    return _alpha_composite_anchored(
        image,
        turret_image,
        overlay_anchor=turret_origin,
        target_anchor=(
            image.width // 2 + _safe_int(entity.rules.get("turret_anim_x")) * scale,
            image.height // 2 + _safe_int(entity.rules.get("turret_anim_y")) * scale,
        ),
        base_focus=focus_bounds,
    )


def _safe_int(value: object) -> int:
    try:
        return int(str(value or "0").strip())
    except ValueError:
        return 0


def _composite_focus_bounds(
    base_focus: tuple[int, int, int, int] | None,
    base_size: tuple[int, int],
    main_layers: list[Image.Image],
    output_size: tuple[int, int],
) -> tuple[int, int, int, int] | None:
    candidates: list[tuple[int, int, int, int]] = []

    def translate(
        bounds: tuple[int, int, int, int],
        layer_size: tuple[int, int],
    ) -> tuple[int, int, int, int]:
        offset_x = (output_size[0] - layer_size[0]) // 2
        offset_y = (output_size[1] - layer_size[1]) // 2
        left, top, right, bottom = bounds
        return (
            left + offset_x,
            top + offset_y,
            right + offset_x,
            bottom + offset_y,
        )

    if base_focus is not None:
        candidates.append(translate(base_focus, base_size))
    for layer in main_layers:
        bounds = layer.getchannel("A").getbbox()
        if bounds is not None:
            candidates.append(translate(bounds, layer.size))
    if not candidates:
        return None
    return (
        min(bounds[0] for bounds in candidates),
        min(bounds[1] for bounds in candidates),
        max(bounds[2] for bounds in candidates),
        max(bounds[3] for bounds in candidates),
    )


def _json_bytes(data: dict[str, object]) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _model_response(data: bytes) -> Response:
    return Response(
        content=data,
        media_type="application/json",
        headers={"Cache-Control": "private, max-age=3600"},
    )


def _inspect_asset(asset: dict[str, object], data: bytes) -> dict[str, object]:
    asset_format = str(asset["format"])
    base: dict[str, object] = {
        "format": asset_format,
        "size": len(data),
    }
    if asset_format == "shp":
        sprite = parse_shp(data)
        return {
            **base,
            "width": sprite.width,
            "height": sprite.height,
            "frame_count": len(sprite.frames),
            "frames": _shp_frame_metadata(sprite),
        }
    if asset_format == "pal":
        parse_palette(data)
        return {**base, "color_count": 256, "frame_count": 1}
    if asset_format == "vxl":
        model = parse_vxl(data)
        return {
            **base,
            "file_name": model.file_name,
            "palette_count": model.palette_count,
            "remap_range": [model.remap_start, model.remap_end],
            "frame_count": len(model.limbs),
            "limb_count": len(model.limbs),
            "voxel_count": model.voxel_count,
            "limbs": [
                {
                    "index": index,
                    "name": limb.name,
                    "number": limb.number,
                    "size": list(limb.size),
                    "voxel_count": len(limb.voxels),
                    "normals_mode": limb.normals_mode,
                    "scale": limb.scale,
                    "min_bounds": list(limb.min_bounds),
                    "max_bounds": list(limb.max_bounds),
                }
                for index, limb in enumerate(model.limbs)
            ],
        }
    if asset_format == "vpl":
        lighting = parse_vpl(data)
        return {
            **base,
            "remap_start": lighting.remap_start,
            "remap_end": lighting.remap_end,
            "section_count": lighting.section_count,
            "lookup_entries": lighting.section_count * 256,
        }
    if asset_format == "hva":
        animation = parse_hva(data)
        first_transform = list(animation.transforms[0]) if animation.transforms else []
        return {
            **base,
            "file_name": animation.file_name,
            "frame_count": animation.frame_count,
            "section_count": len(animation.section_names),
            "section_names": list(animation.section_names),
            "first_transform": first_transform,
        }
    if asset_format == "tmp":
        template = parse_tmp(data)
        return {
            **base,
            "width": template.tile_width,
            "height": template.tile_height,
            "template_width": template.template_width,
            "template_height": template.template_height,
            "frame_count": len(template.tiles),
            "tile_count": template.tile_count,
            "tiles": [
                None
                if tile is None
                else {
                    "index": tile.index,
                    "height": tile.height,
                    "terrain_type": tile.terrain_type,
                    "ramp_type": tile.ramp_type,
                    "has_extra": tile.extra_pixels is not None,
                }
                for tile in template.tiles
            ],
        }
    if asset_format == "csf":
        strings = parse_csf(data)
        return {
            **base,
            "version": strings.version,
            "language": strings.language,
            "label_count": len(strings.labels),
            "string_count": strings.string_count,
            "declared_string_count": strings.declared_string_count,
        }
    if asset_format == "map":
        overview = parse_map(data)
        return {
            **base,
            "encoding": overview.ini.encoding,
            "section_count": len(overview.ini.sections),
            "entry_count": overview.ini.entry_count,
            "width": overview.width,
            "height": overview.height,
            "theater": overview.theater,
            "object_counts": overview.counts,
        }
    if asset_format == "ini":
        ini = parse_ini(data)
        return {
            **base,
            "encoding": ini.encoding,
            "section_count": len(ini.sections),
            "entry_count": ini.entry_count,
            "section_names": [section.name for section in ini.sections[:500]],
        }
    if asset_format == "text":
        decoded = decode_legacy_text(data)
        return {
            **base,
            "encoding": decoded.encoding,
            "line_count": len(decoded.text.splitlines()),
        }
    if asset_format == "wav":
        audio = parse_wav(data)
        return {
            **base,
            "audio_format": audio.audio_format,
            "channels": audio.channels,
            "sample_rate": audio.sample_rate,
            "bits_per_sample": audio.bits_per_sample,
            "block_align": audio.block_align,
            "data_size": audio.data_size,
            "samples_per_block": audio.samples_per_block,
            "sample_count": audio.sample_count,
            "duration_seconds": audio.duration_seconds,
            "browser_playable": audio.browser_playable,
            "playback_transcodes_to_pcm": audio.audio_format == 17,
        }
    if asset_format == "aud":
        audio = parse_aud(data)
        return {
            **base,
            "audio_format": audio.compression,
            "audio_codec": audio.codec,
            "channels": audio.channels,
            "sample_rate": audio.sample_rate,
            "bits_per_sample": audio.bits_per_sample,
            "data_size": audio.data_size,
            "sample_count": audio.sample_count,
            "duration_seconds": audio.duration_seconds,
            "chunk_count": audio.chunk_count,
            "browser_playable": True,
            "playback_transcodes_to_pcm": True,
        }
    if asset_format == "bag_audio":
        return {
            **base,
            **inspect_bag_audio(data, _bag_entry_from_asset(asset)),
        }
    if asset_format == "pcx":
        from PIL import Image, UnidentifiedImageError

        try:
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                mode = image.mode
        except (OSError, UnidentifiedImageError) as error:
            raise InvalidFormatError("PCX 文件无法解码") from error
        return {**base, "width": width, "height": height, "mode": mode, "frame_count": 1}
    return base


app = create_app()


__all__ = ["Services", "app", "create_app"]
