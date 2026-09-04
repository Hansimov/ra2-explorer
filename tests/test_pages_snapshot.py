from __future__ import annotations

import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from ra2_explorer.errors import Ra2ExplorerError
from ra2_explorer.pages_snapshot import (
    PAGES_ASSET_BUNDLE_REVISION,
    PAGES_RENDER_REVISION,
    _animation_frame_requests,
    _animation_tasks,
    _AnimationVariant,
    _asset_usages,
    _AssetUsage,
    _composite_entity_preview_layers,
    _directory_stats,
    _entity_operation_effect_tasks,
    _entity_player_color,
    _entity_search_thumbnail_cell,
    _entity_thumbnail_atlas_cell,
    _EntityPreviewTask,
    _export_asset_bundles,
    _export_entity_previews,
    _export_entity_search_thumbnail_atlases,
    _export_entity_thumbnail_atlases,
    _export_shp_animation_previews,
    _pages_audio_stats,
    _prune_reused_exports,
    _safe_filename,
    _snapshot_identity,
    archive_pages_snapshot,
)


def test_pages_default_preload_search_atlas_matches_render_revision() -> None:
    pages_env = (Path(__file__).parents[1] / "frontend" / ".env.pages").read_text(
        encoding="utf-8",
    )

    assert (
        "RA2EXP_DEFAULT_ATLAS="
        f"previews/entity-search-atlases/1-r{PAGES_RENDER_REVISION}.webp"
    ) in pages_env


def test_pages_prune_removes_only_stale_reused_exports(tmp_path: Path) -> None:
    expected = tmp_path / "previews" / "assets" / "body" / "auto" / "0.webp"
    stale = tmp_path / "previews" / "assets" / "weapon" / "auto" / "0.webp"
    expected.parent.mkdir(parents=True)
    stale.parent.mkdir(parents=True)
    expected.write_bytes(b"expected")
    stale.write_bytes(b"stale")

    removed = _prune_reused_exports(
        tmp_path,
        asset_ids=set(),
        audio_ids=set(),
        animation_ids={"body"},
        entity_ids=set(),
    )

    assert removed == 1
    assert expected.read_bytes() == b"expected"
    assert not stale.exists()


def test_pages_asset_bundle_reuse_requires_current_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "assets" / "sample.json"
    output.parent.mkdir(parents=True)
    output.write_text(
        json.dumps({"metadata": {"stale": True}}),
        encoding="utf-8",
    )
    requests: list[str] = []

    def request(_client: object, path: str, **_kwargs: object) -> dict[str, object]:
        requests.append(path)
        if path.endswith("/metadata"):
            return {"fresh": True}
        return {"id": "sample", "format": "wav"}

    monkeypatch.setattr("ra2_explorer.pages_snapshot._request_json", request)
    metadata = _export_asset_bundles(
        object(),  # type: ignore[arg-type]
        tmp_path,
        {"sample": {"id": "sample"}},
        set(),
        workers=1,
    )

    assert metadata == {"sample": {"fresh": True}}
    assert requests == ["/api/assets/sample", "/api/assets/sample/metadata"]
    bundle = json.loads(output.read_text(encoding="utf-8"))
    assert bundle["bundle_revision"] == PAGES_ASSET_BUNDLE_REVISION

    requests.clear()
    assert _export_asset_bundles(
        object(),  # type: ignore[arg-type]
        tmp_path,
        {"sample": {"id": "sample"}},
        set(),
        workers=1,
    ) == {"sample": {"fresh": True}}
    assert requests == []


def test_pages_asset_usages_exclude_incomplete_combat_effects() -> None:
    body_asset = {"id": "body", "format": "shp"}
    weapon_asset = {"id": "weapon", "format": "shp"}
    building_asset = {"id": "active", "format": "shp"}
    entities = [
        {
            "kind": "infantry",
            "sides": ["GDI"],
            "components": [],
            "media": [
                {
                    "kind": "animation",
                    "role": "body",
                    "slot": "body_sequence",
                    "samples": [{"asset": body_asset}],
                },
                {
                    "kind": "animation",
                    "role": "weapon",
                    "slot": "primary",
                    "samples": [{"asset": weapon_asset}],
                },
            ],
        },
        {
            "kind": "building",
            "sides": ["ThirdSide"],
            "components": [],
            "media": [
                {
                    "kind": "animation",
                    "role": "operation",
                    "slot": "active_anim",
                    "samples": [{"asset": building_asset}],
                },
            ],
        },
    ]

    referenced, usages, _audio_ids = _asset_usages({"items": []}, entities)

    assert set(referenced) == {"body", "active"}
    assert set(usages) == {"body", "active"}
    assert usages["body"].player_colors == frozenset({"blue"})
    assert usages["active"].player_colors == frozenset({"purple"})


def test_pages_animation_exports_are_partitioned_by_player_color(tmp_path: Path) -> None:
    usage = _AssetUsage(
        asset={"id": "demo", "format": "pcx"},
        variants=frozenset(
            {
                _AnimationVariant(
                    palette="unit",
                    start_frame=0,
                    frame_count=1,
                    facing_step=0,
                    frame_step=1,
                    shadow=False,
                )
            }
        ),
        player_colors=frozenset({"blue", "red"}),
    )

    images, models = _animation_tasks(tmp_path, {"demo": usage}, {"demo": {"frame_count": 1}})

    assert models == []
    assert {task.params["player_color"] for task in images} == {"blue", "red"}
    assert {task.output.relative_to(tmp_path).as_posix() for task in images} == {
        "previews/assets/demo/color-blue/unit/0-shadow-none.webp",
        "previews/assets/demo/color-red/unit/0-shadow-none.webp",
    }


def test_pages_shp_animation_frames_apply_each_entity_player_color(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rendered_colors: list[str] = []

    class Palette:
        def __init__(self, color: str = "original"):
            self.color = color

        def with_player_color(self, color: str) -> Palette:
            return Palette(color)

    class Sprite:
        frames = (object(),)

        @staticmethod
        def render(
            _frame: int,
            palette: Palette,
            *,
            scale: int,
            shadow_frame: int | None,
        ) -> Image.Image:
            assert scale == 5
            assert shadow_frame is None
            rendered_colors.append(palette.color)
            return Image.new("RGBA", (1, 1), (255, 255, 255, 255))

    services = SimpleNamespace(
        reader=SimpleNamespace(read=lambda _asset_id: ({"id": "demo"}, b"sprite"))
    )
    usage = _AssetUsage(
        asset={"id": "demo", "format": "shp"},
        variants=frozenset(
            {_AnimationVariant("unit", 0, 1, 0, 1, False)}
        ),
        player_colors=frozenset({"blue", "red"}),
    )
    monkeypatch.setattr("ra2_explorer.pages_snapshot.parse_shp", lambda _data: Sprite())
    monkeypatch.setattr(
        "ra2_explorer.pages_snapshot._select_palette",
        lambda *_args, **_kwargs: Palette(),
    )

    _export_shp_animation_previews(
        services,  # type: ignore[arg-type]
        tmp_path,
        {"demo": usage},
        {"demo": {"frame_count": 1, "frames": []}},
        workers=1,
    )

    assert rendered_colors == ["blue", "red"]
    assert (
        tmp_path / "previews/assets/demo/color-blue/unit/0-shadow-none.webp"
    ).is_file()
    assert (
        tmp_path / "previews/assets/demo/color-red/unit/0-shadow-none.webp"
    ).is_file()


def test_animation_frame_requests_exports_only_configured_direction_ranges() -> None:
    usage = _AssetUsage(
        asset={"id": "demo", "format": "shp"},
        variants=frozenset(
            {
                _AnimationVariant(
                    palette="unit",
                    start_frame=0,
                    frame_count=2,
                    facing_step=2,
                    frame_step=1,
                    shadow=True,
                )
            }
        ),
    )

    requests = _animation_frame_requests(usage, 32)

    assert len(requests) == 17
    assert ("unit", 0, None) in requests
    assert ("unit", 0, 16) in requests
    assert ("unit", 15, 31) in requests
    assert ("unit", 16, None) not in requests


def test_animation_frame_requests_support_interleaved_unit_actions() -> None:
    usage = _AssetUsage(
        asset={"id": "drone", "format": "shp"},
        variants=frozenset(
            {
                _AnimationVariant(
                    palette="unit",
                    start_frame=8,
                    frame_count=2,
                    facing_step=1,
                    frame_step=8,
                    shadow=False,
                )
            }
        ),
    )
    paired_shadows = {frame: frame + 32 for frame in range(8, 24)}

    requests = _animation_frame_requests(usage, 64, paired_shadows)

    assert ("unit", 8, 40) in requests
    assert ("unit", 16, 48) in requests
    assert ("unit", 9, 41) in requests
    assert ("unit", 17, 49) in requests
    assert ("unit", 24, 56) not in requests
    assert ("unit", 8, None) in requests


def test_pages_exports_precomposited_building_operation_frames(tmp_path: Path) -> None:
    entities = [
        {
            "id": "SUPERBUILDING",
            "kind": "building",
            "renderable": True,
            "sides": ["GDI"],
            "preview": {"supports_facing": False},
            "media": [
                {
                    "kind": "animation",
                    "role": "operation",
                    "slot": "superanimtwo",
                    "samples": [
                        {
                            "asset": {"id": "effect", "format": "shp"},
                            "palette": "unit",
                            "animation": {
                                "start_frame": 0,
                                "frame_count": 2,
                                "facing_step": 0,
                                "frame_step": 1,
                                "shadow": True,
                                "reverse": False,
                            },
                        }
                    ],
                }
            ],
        }
    ]
    metadata = {
        "effect": {
            "frame_count": 4,
            "frames": [
                {"index": 0, "paired_shadow_frame": 2},
                {"index": 1, "paired_shadow_frame": 3},
            ],
        }
    }

    tasks = _entity_operation_effect_tasks(tmp_path, "source", entities, metadata)

    assert len(tasks) == 3
    paired = next(task for task in tasks if task.params.get("effect_shadow_frame") == 2)
    assert paired.params["player_color"] == "blue"
    assert paired.output == (
        tmp_path
        / "previews/entities/SUPERBUILDING/effects/effect/unit/0/0-shadow-2.webp"
    )


def test_snapshot_identity_excludes_local_display_values() -> None:
    source = {
        "id": "source-id",
        "scanned_at": "2026-01-02T03:04:05Z",
        "asset_count": 42,
        "name": "private name",
        "root_path": "E:/private/location",
    }

    changed = {**source, "name": "public name", "root_path": "D:/elsewhere"}

    assert _snapshot_identity(source) == _snapshot_identity(changed)


def test_static_snapshot_rejects_path_like_identifiers() -> None:
    with pytest.raises(Ra2ExplorerError):
        _safe_filename("../outside")


def test_directory_stats_can_exclude_self_describing_manifest(tmp_path) -> None:
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog" / "entities.json").write_text("[]", encoding="utf-8")
    (tmp_path / "manifest.json").write_text(
        json.dumps({"payload": {"bytes": 1}}),
        encoding="utf-8",
    )

    stats = _directory_stats(tmp_path, exclude=frozenset({"manifest.json"}))

    assert stats == {
        "files": 1,
        "bytes": 2,
        "categories": {"catalog": {"files": 1, "bytes": 2}},
    }


def test_pages_archive_is_complete_and_atomically_replaceable(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot"
    (snapshot / "catalog").mkdir(parents=True)
    (snapshot / "manifest.json").write_text('{"schema_version":1}', encoding="utf-8")
    (snapshot / "catalog" / "entities.json").write_text("[]", encoding="utf-8")
    archive = tmp_path / "pages.zip"

    result = archive_pages_snapshot(snapshot, archive)

    assert result["files"] == 2
    assert result["bytes"] == archive.stat().st_size
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.namelist() == ["catalog/entities.json", "manifest.json"]
    with pytest.raises(Ra2ExplorerError):
        archive_pages_snapshot(snapshot, archive)
    archive_pages_snapshot(snapshot, archive, overwrite=True)
    assert not list(tmp_path.glob(".pages.zip.building-*"))


def test_pages_building_preview_focus_includes_every_visible_main_layer() -> None:
    base = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    base.paste((255, 255, 255, 255), (40, 40, 60, 60))
    operation = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
    operation.paste((255, 0, 0, 255), (150, 40, 190, 60))

    composite, focus = _composite_entity_preview_layers(
        base,
        (40, 40, 60, 60),
        [],
        [operation],
    )

    assert composite.size == (200, 100)
    assert focus == (90, 40, 190, 60)


def test_pages_entity_preview_includes_the_shared_voxel_turret_composite(
    tmp_path: Path,
) -> None:
    body = {"format": "shp", "source_id": "source"}

    class Entity:
        kind = "building"
        rules: dict[str, str] = {}
        media: tuple[object, ...] = ()

        @staticmethod
        def component(role: str) -> dict[str, str] | None:
            return body if role == "body" else None

    entity = Entity()
    base = Image.new("RGBA", (40, 40), (255, 0, 0, 255))
    turret = Image.new("RGBA", (10, 10), (0, 0, 255, 255))
    semantic = SimpleNamespace(
        catalog=lambda _source_id: SimpleNamespace(get=lambda _entity_id: entity),
        render=lambda *_args, **_kwargs: (entity, base, (0, 0, 40, 40)),
        render_building_voxel_turret=lambda *_args, **_kwargs: (turret, (5, 5)),
    )
    services = SimpleNamespace(
        semantic=semantic,
        database=SimpleNamespace(palette_assets=lambda _source_id: []),
    )
    output = tmp_path / "building.webp"

    _export_entity_previews(
        services,  # type: ignore[arg-type]
        "source",
        [_EntityPreviewTask("BUILDING", 0, 0, 2, False, None, output)],
        workers=1,
    )

    with Image.open(output) as rendered:
        assert rendered.convert("RGBA").getpixel((20, 20))[:3] == (0, 0, 255)


def test_pages_infantry_thumbnail_uses_the_shared_card_framing(tmp_path: Path) -> None:
    body = {"format": "shp", "source_id": "source"}

    class Entity:
        kind = "infantry"
        rules: dict[str, str] = {}
        media: tuple[object, ...] = ()

        @staticmethod
        def component(role: str) -> dict[str, str] | None:
            return body if role == "body" else None

    entity = Entity()
    base = Image.new("RGBA", (20, 40), (255, 0, 0, 255))
    semantic = SimpleNamespace(
        catalog=lambda _source_id: SimpleNamespace(get=lambda _entity_id: entity),
        render=lambda *_args, **_kwargs: (entity, base, (0, 0, 20, 40)),
        render_building_voxel_turret=lambda *_args, **_kwargs: None,
    )
    services = SimpleNamespace(
        semantic=semantic,
        database=SimpleNamespace(palette_assets=lambda _source_id: []),
    )
    output = tmp_path / "infantry.webp"

    _export_entity_previews(
        services,  # type: ignore[arg-type]
        "source",
        [_EntityPreviewTask("INFANTRY", 0, 0, 2, True, None, output)],
        workers=1,
    )

    with Image.open(output) as rendered:
        bounds = rendered.convert("RGBA").getchannel("A").getbbox()
        assert bounds is not None
        visible_ratio = max(
            (bounds[2] - bounds[0]) / rendered.width,
            (bounds[3] - bounds[1]) / rendered.height,
        )
        assert 0.68 <= visible_ratio <= 0.75


def test_pages_thumbnail_atlas_cell_matches_card_dimensions() -> None:
    source = Image.new("RGBA", (20, 10), (255, 0, 0, 255))

    cell = _entity_thumbnail_atlas_cell(source, "shp")

    assert cell.size == (144, 135)
    assert cell.getchannel("A").getbbox() == (10, 33, 134, 95)


def test_pages_search_thumbnail_cell_is_centered_and_pre_fitted() -> None:
    source = Image.new("RGBA", (20, 10), (255, 0, 0, 255))

    cell = _entity_search_thumbnail_cell(source)

    assert cell.size == (36, 36)
    assert cell.getchannel("A").getbbox() == (2, 10, 34, 26)


def test_pages_entity_card_player_colors_follow_exclusive_side() -> None:
    assert _entity_player_color({"sides": ["GDI"]}) == "blue"
    assert _entity_player_color({"sides": ["Nod"]}) == "red"
    assert _entity_player_color({"sides": ["ThirdSide"]}) == "purple"
    assert _entity_player_color({"sides": ["GDI", "Nod"]}) is None
    assert _entity_player_color({"sides": []}) is None
    assert _entity_player_color({
        "sides": [],
        "affiliation": {"kind": "side", "id": "GDI"},
    }) == "blue"


def test_pages_exports_one_thumbnail_atlas_request_per_entity_kind(
    tmp_path: Path,
) -> None:
    entities = []
    for entity_id, kind, supports_facing in (
        ("TANK", "vehicle", True),
        ("SOLDIER", "infantry", True),
        ("CANNON", "building", True),
    ):
        facing_count = 8 if supports_facing else 1
        for facing in range(facing_count):
            output = (
                tmp_path
                / "previews"
                / "entities"
                / entity_id
                / "thumbnail"
                / str(facing)
                / "0.webp"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (24, 16), (facing, 20, 30, 255)).save(
                output,
                format="WEBP",
                lossless=True,
            )
        entities.append(
            {
                "id": entity_id,
                "kind": kind,
                "body_format": "shp",
                "renderable": True,
                "preview": {
                    "format": "shp",
                    "supports_facing": supports_facing,
                },
            }
        )

    metadata = _export_entity_thumbnail_atlases(tmp_path, entities)

    assert metadata["TANK"]["facing_count"] == 8
    assert metadata["SOLDIER"]["facing_count"] == 8
    assert metadata["CANNON"]["facing_count"] == 8
    assert metadata["SOLDIER"]["content_bounds"] == [
        {"x": 10, "y": 22, "width": 124, "height": 83}
    ] * 8
    assert metadata["SOLDIER"]["path"] == (
        f"previews/entity-atlases/infantry/{{facing}}-r{PAGES_RENDER_REVISION}.webp"
    )
    assert (
        tmp_path / f"previews/entity-atlases/vehicle/7-r{PAGES_RENDER_REVISION}.webp"
    ).is_file()
    assert (
        tmp_path / f"previews/entity-atlases/building/7-r{PAGES_RENDER_REVISION}.webp"
    ).is_file()
    assert (
        tmp_path / f"previews/entity-atlases/infantry/7-r{PAGES_RENDER_REVISION}.webp"
    ).is_file()
    with Image.open(
        tmp_path
        / f"previews/entity-atlases/infantry/0-r{PAGES_RENDER_REVISION}.webp"
    ) as atlas:
        assert atlas.size == (144, 135)


def test_pages_exports_one_shared_search_thumbnail_atlas_per_angle(
    tmp_path: Path,
) -> None:
    entities = []
    for entity_id, image_format, supports_facing in (
        ("TANK", "vxl", False),
        ("SOLDIER", "shp", True),
    ):
        for facing in range(8 if supports_facing else 1):
            output = (
                tmp_path
                / "previews"
                / "entities"
                / entity_id
                / "thumbnail"
                / str(facing)
                / "0.webp"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (24, 16), (facing, 20, 30, 255)).save(
                output,
                format="WEBP",
                lossless=True,
            )
        entities.append(
            {
                "id": entity_id,
                "kind": "vehicle" if image_format == "vxl" else "infantry",
                "body_format": image_format,
                "renderable": True,
                "preview": {
                    "format": image_format,
                    "supports_facing": supports_facing,
                },
            }
        )

    metadata = _export_entity_search_thumbnail_atlases(tmp_path, entities)

    expected_path = (
        f"previews/entity-search-atlases/{{facing}}-r{PAGES_RENDER_REVISION}.webp"
    )
    assert metadata["SOLDIER"]["path"] == expected_path
    assert metadata["TANK"]["path"] == expected_path
    assert metadata["SOLDIER"]["facing_count"] == 8
    assert metadata["SOLDIER"]["cell_width"] == 36
    atlas_path = (
        tmp_path / f"previews/entity-search-atlases/1-r{PAGES_RENDER_REVISION}.webp"
    )
    with Image.open(atlas_path) as atlas:
        assert atlas.size == (72, 36)
        soldier_index = int(metadata["SOLDIER"]["index"])
        center_x = soldier_index * 36 + 18
        assert atlas.convert("RGBA").getpixel((center_x, 18))[:3] == (5, 20, 30)


def test_pages_audio_stats_include_lightweight_media_facets() -> None:
    media = {
        "items": [{"asset": {"format": "wav"}}, {"asset": {"format": "wav"}}],
        "kinds": [{"kind": "voice", "count": 2}],
        "groups": [{"group": "selection_voice", "count": 2}],
        "event_types": [{"event_type": "select", "count": 2}],
    }

    stats = _pages_audio_stats(media, {"one", "two"})

    assert stats == {
        "total_assets": 2,
        "formats": [{"format": "wav", "count": 2}],
        "media_kinds": [{"kind": "voice", "count": 2}],
        "media_groups": [{"group": "selection_voice", "count": 2}],
        "media_event_types": [{"event_type": "select", "count": 2}],
    }
