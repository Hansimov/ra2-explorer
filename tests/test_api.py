from __future__ import annotations

import io
import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from ra2_explorer.api import (
    _alpha_composite_anchored,
    _alpha_composite_centered,
    _composite_focus_bounds,
    _crop_transparent_preview,
    _default_entity_operation_samples,
    create_app,
)
from ra2_explorer.config import Settings
from ra2_explorer.semantic import (
    GameEntity,
    MediaAssociation,
    MediaSample,
    VoiceText,
    _art_animation_playback,
    _art_end_is_frame_count,
    _art_sibling_frame_count,
    _AssetIndex,
    _build_eva_events,
    _build_media_items,
    _edition_ini_inputs,
    _effective_entity_countries,
    _entity_animation_role,
    _entity_usage,
    _index_assets,
    _overlay_voice_transcripts,
    _resolve_components,
    _shp_unit_body_playbacks,
    _standalone_sound_group,
)
from tests.ra2_fixtures import (
    FIXTURE_NAMES,
    _build_fixture_wav,
    create_fixture_installation,
)


def test_fixture_library_is_browsable_and_previewable(tmp_path: Path) -> None:
    data_dir = tmp_path / "runtime"
    settings = Settings(
        data_dir=data_dir,
        database_path=data_dir / "library.db",
        frontend_dir=tmp_path / "missing-frontend",
        known_names_path=data_dir / "reference" / "known_names_ra2.txt",
    )
    settings.prepare()
    settings.known_names_path.write_text("\n".join(FIXTURE_NAMES), encoding="utf-8")
    settings.mission_audio_transcript_path.parent.mkdir(parents=True, exist_ok=True)
    settings.mission_audio_transcript_path.write_text(
        json.dumps(
            {
                "entries": {
                    "fixture.wav": {
                        "original_text": "Ready for the test.",
                        "localized_text": "准备测试。",
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    client = TestClient(create_app(settings))

    installation = create_fixture_installation(tmp_path / "fixture-installation")
    source_response = client.post(
        "/api/sources",
        json={"path": str(installation), "name": "Test fixture"},
    )
    assert source_response.status_code == 201
    source = source_response.json()
    assert source["state"] == "ready"
    assert source["archive_count"] == 2
    assert source["asset_count"] == 15

    assets_response = client.get(
        "/api/assets", params={"source_id": source["id"], "q": "fixture.shp"}
    )
    assert assets_response.status_code == 200
    assets = assets_response.json()
    assert assets["total"] == 1
    sprite = assets["items"][0]

    metadata = client.get(f"/api/assets/{sprite['id']}/shp")
    assert metadata.status_code == 200
    shp_metadata = metadata.json()
    assert shp_metadata["frame_count"] == 6
    assert shp_metadata["frames"][0]["content_bounds"] is not None
    assert "paired_shadow_frame" in shp_metadata["frames"][0]

    preview = client.get(
        f"/api/assets/{sprite['id']}/preview.png",
        params={"frame": 3, "scale": 2},
    )
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/png"
    assert preview.content.startswith(b"\x89PNG")

    page = client.get("/api/assets", params={"source_id": source["id"], "limit": 100}).json()
    by_name = {asset["display_name"]: asset for asset in page["items"]}
    filtered = client.get(
        "/api/assets",
        params={"source_id": source["id"], "formats": "vxl,wav"},
    ).json()
    assert {asset["format"] for asset in filtered["items"]} == {"vxl", "wav"}
    largest_first = client.get(
        "/api/assets",
        params={"source_id": source["id"], "sort": "size_desc", "limit": 100},
    ).json()["items"]
    assert [asset["size"] for asset in largest_first] == sorted(
        (asset["size"] for asset in largest_first), reverse=True
    )
    assert (
        client.get(
            "/api/assets", params={"source_id": source["id"], "sort": "unsupported"}
        ).status_code
        == 422
    )

    vxl = by_name["fixture.vxl"]
    vxl_metadata = client.get(f"/api/assets/{vxl['id']}/metadata")
    assert vxl_metadata.status_code == 200
    assert vxl_metadata.json()["voxel_count"] > 80
    assert client.get(f"/api/assets/{vxl['id']}/preview.png").content.startswith(b"\x89PNG")
    vxl_model = client.get(f"/api/assets/{vxl['id']}/model.json")
    assert vxl_model.status_code == 200
    assert vxl_model.json()["version"] == 4
    assert vxl_model.json()["lighting"] == "westwood_vpl"
    assert vxl_model.json()["voxel_count"] > 80
    assert vxl_model.json()["visible_voxel_count"] <= vxl_model.json()["voxel_count"]
    assert len(vxl_model.json()["voxels"][0]) == 9
    assert vxl_model.json()["voxels"][0][-2:] == [20, 4]

    animation = by_name["fixture.hva"]
    animated_model = client.get(
        f"/api/assets/{animation['id']}/model.json",
        params={"frame": 3},
    )
    assert animated_model.status_code == 200
    assert animated_model.json()["frame"] == 3
    assert animated_model.json()["frame_count"] == 4
    animated_preview = client.get(
        f"/api/assets/{animation['id']}/preview.png",
        params={"frame": 3, "player_color": "blue"},
    )
    assert animated_preview.status_code == 200
    assert animated_preview.content.startswith(b"\x89PNG")

    terrain = by_name["fixture.tem"]
    terrain_preview = client.get(f"/api/assets/{terrain['id']}/preview.png")
    assert terrain_preview.status_code == 200
    assert terrain_preview.content.startswith(b"\x89PNG")

    game_map = by_name["fixture.map"]
    map_metadata = client.get(f"/api/assets/{game_map['id']}/metadata")
    assert map_metadata.status_code == 200
    assert map_metadata.json()["width"] == 60
    assert map_metadata.json()["height"] == 42
    assert map_metadata.json()["object_counts"]["structure"] == 1
    assert client.get(f"/api/assets/{game_map['id']}/preview.png").content.startswith(b"\x89PNG")

    strings = by_name["fixture.csf"]
    text = client.get(f"/api/assets/{strings['id']}/text", params={"q": "ready"})
    assert text.status_code == 200
    assert "Asset pipeline ready" in text.json()["text"]

    sound = by_name["fixture.wav"]
    media = client.get(f"/api/assets/{sound['id']}/media")
    assert media.status_code == 200
    assert media.headers["content-type"] == "audio/wav"
    assert media.content.startswith(b"RIFF")

    entities = client.get("/api/entities", params={"source_id": source["id"]})
    assert entities.status_code == 200
    entity_page = entities.json()
    assert entity_page["total"] == 2
    entity_summaries = {item["id"]: item for item in entity_page["items"]}
    assert entity_summaries["DemoVehicle"]["display_name"] == "Generated test vehicle"
    assert entity_summaries["DemoVehicle"]["body_status"] == "available"
    assert entity_summaries["DemoVehicle"]["renderable"] is True
    assert entity_summaries["DemoVehicle"]["body_format"] == "vxl"
    assert entity_summaries["DemoVehicle"]["usage"] == "buildable"
    assert entity_summaries["DemoVehicle"]["tech_level"] == "2"
    assert entity_summaries["DemoVehicle"]["ai_base_planning_side"] == "0"
    assert entity_summaries["DemoVehicle"]["naval"] is False
    assert entity_summaries["DemoVehicle"]["considered_aircraft"] is False
    assert entity_summaries["DemoInfantry"]["usage"] == "buildable"
    assert entity_summaries["DemoInfantry"]["display_name"] == "测试步兵"
    assert entity_summaries["DemoInfantry"]["search_aliases"] == {
        "pinyin": "ce shi bu bing",
        "pinyin_compact": "ceshibubing",
        "pinyin_initials": "csbb",
    }
    assert entity_summaries["DemoVehicle"]["media_count"] > 0
    assert "voice" in entity_summaries["DemoVehicle"]["media_kinds"]
    assert entity_summaries["DemoVehicle"]["countries"] == ["Americans", "Russians"]
    assert entity_summaries["DemoVehicle"]["sides"] == ["GDI", "Nod"]
    assert entity_summaries["DemoVehicle"]["affiliation"]["id"] == "GDI"
    assert entity_summaries["DemoInfantry"]["affiliation"]["id"] == "Americans"
    assert entity_page["sides"] == [{"id": "GDI", "count": 2}]
    assert {item["display_name"] for item in entity_page["countries"]} == {
        "United States",
        "Russia",
    }
    assert entity_page["usages"] == [{"usage": "buildable", "count": 2}]
    allied_vehicles = client.get(
        "/api/entities",
        params={
            "source_id": source["id"],
            "kind": "vehicle",
            "side": "GDI",
            "renderable": "true",
        },
    )
    assert allied_vehicles.status_code == 200
    assert allied_vehicles.json()["total"] == 1
    assert allied_vehicles.json()["items"][0]["id"] == "DemoVehicle"
    assert (
        client.get(
            "/api/entities",
            params={"source_id": source["id"], "kind": "vehicle", "side": "Nod"},
        ).json()["total"]
        == 0
    )
    assert (
        client.get(
            "/api/entities",
            params={"source_id": source["id"], "side": "unaffiliated"},
        ).json()["total"]
        == 0
    )
    empty_side = client.get(
        "/api/entities",
        params={"source_id": source["id"], "kind": "building", "side": "GDI"},
    )
    assert empty_side.status_code == 200
    assert empty_side.json()["total"] == 0
    buildable_infantry = client.get(
        "/api/entities",
        params={
            "source_id": source["id"],
            "kind": "infantry",
            "usage": "buildable",
        },
    )
    assert buildable_infantry.status_code == 200
    assert [item["id"] for item in buildable_infantry.json()["items"]] == ["DemoInfantry"]
    multi_category = client.get(
        "/api/entities",
        params={
            "source_id": source["id"],
            "kinds": "vehicle,infantry",
            "usages": "buildable,scenario",
        },
    )
    assert {item["id"] for item in multi_category.json()["items"]} == {
        "DemoVehicle",
        "DemoInfantry",
    }
    assert (
        client.get(
            "/api/entities",
            params={"source_id": source["id"], "usage": "invalid"},
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/api/entities",
            params={"source_id": source["id"], "kinds": "vehicle,invalid"},
        ).status_code
        == 422
    )
    simplified_name_search = client.get(
        "/api/entities",
        params={"source_id": source["id"], "q": "测试步兵"},
    )
    assert [item["id"] for item in simplified_name_search.json()["items"]] == ["DemoInfantry"]
    fuzzy_name_search = client.get(
        "/api/entities",
        params={"source_id": source["id"], "q": "测试兵"},
    )
    assert [item["id"] for item in fuzzy_name_search.json()["items"]] == ["DemoInfantry"]
    traditional_name_search = client.get(
        "/api/entities",
        params={"source_id": source["id"], "q": "測試步兵", "language": "zh-TW"},
    )
    assert traditional_name_search.json()["items"][0]["display_name"] == "測試步兵"
    for query in ("ceshibubing", "ce shi bu bing", "csbb"):
        pinyin_name_search = client.get(
            "/api/entities",
            params={"source_id": source["id"], "q": query},
        )
        assert [item["id"] for item in pinyin_name_search.json()["items"]] == ["DemoInfantry"]
    mixed_name_search = client.get(
        "/api/entities",
        params={"source_id": source["id"], "q": "测试 bing"},
    )
    assert [item["id"] for item in mixed_name_search.json()["items"]] == ["DemoInfantry"]
    assert (
        client.get(
            "/api/entities",
            params={"source_id": source["id"], "language": "english"},
        ).status_code
        == 422
    )

    semantic_media = client.get(
        "/api/media",
        params={"source_id": source["id"], "kind": "voice"},
    )
    assert semantic_media.status_code == 200
    media_items = semantic_media.json()["items"]
    assert len(media_items) == 1
    assert media_items[0]["asset"]["display_name"] == "fixture.wav"
    assert media_items[0]["description"] == "准备测试。"
    assert media_items[0]["groups"] == ["selection_voice"]
    assert media_items[0]["original_texts"] == ["Ready for the test."]
    assert media_items[0]["localized_texts"] == []
    assert media_items[0]["translated_texts"] == ["准备测试。"]
    assert "zhunbeiceshi" in media_items[0]["search_aliases"]["pinyin_compact"]
    assert {item["event_type"] for item in semantic_media.json()["event_types"]} >= {
        "select",
        "sound_event",
    }
    selected_media = client.get(
        "/api/media",
        params={"source_id": source["id"], "kind": "voice", "event_type": "select"},
    )
    assert selected_media.status_code == 200
    assert selected_media.json()["total"] == 1
    assert (
        client.get(
            "/api/media",
            params={"source_id": source["id"], "kind": "voice", "q": "准备 ce shi"},
        ).json()["total"]
        == 1
    )
    assert (
        client.get(
            "/api/media",
            params={"source_id": source["id"], "kind": "voice", "event_type": "move"},
        ).json()["total"]
        == 0
    )
    assert (
        client.get(
            "/api/media",
            params={"source_id": source["id"], "sort": "random"},
        ).status_code
        == 422
    )

    entity = client.get(f"/api/entities/{source['id']}/DemoVehicle")
    assert entity.status_code == 200
    entity_body = entity.json()
    components = {item["role"]: item for item in entity_body["components"]}
    assert components["body"]["asset"]["display_name"] == "fixture.vxl"
    assert components["body_hva"]["asset"]["display_name"] == "fixture.hva"
    assert components["cameo"]["asset"]["display_name"] == "fixture.shp"
    assert entity_body["preview"]["frame_count"] == 4
    assert entity_body["preview"]["supports_facing"] is True
    assert entity_body["preview"]["supports_player_color"] is True
    dependencies = {(item["kind"], item["id"]): item for item in entity_body["dependencies"]}
    assert len(entity_body["dependencies"]) == 9
    assert dependencies[("weapon", "DemoCannon")]["properties"]["damage"] == "75"
    assert dependencies[("weapon", "DemoAltCannon")]["slot"] == "weapon_1"
    assert dependencies[("projectile", "DemoShell")]["resolved"] is True
    assert dependencies[("warhead", "DemoWarhead")]["resolved"] is True
    weapon_animation = next(
        item
        for item in entity_body["media"]
        if item["kind"] == "animation" and item["role"] == "weapon"
    )
    impact_animation = next(
        item
        for item in entity_body["media"]
        if item["kind"] == "animation" and item["role"] == "impact"
    )
    assert weapon_animation["samples"][0]["asset"]["display_name"] == "infantry.shp"
    assert weapon_animation["rule_field"] == "WeaponType.Anim"
    assert impact_animation["samples"][0]["asset"]["display_name"] == "infantry.shp"
    assert [sample["name"] for sample in impact_animation["samples"]] == [
        "IMPACT1",
        "IMPACT2",
        "IMPACT3",
        "IMPACT4",
    ]
    assert impact_animation["selection"] == "damage"
    assert impact_animation["selection_value"] == 75
    assert impact_animation["selected_sample"] == "IMPACT4"
    assert impact_animation["rule_field"] == "WarheadType.AnimList"
    splash_animation = next(
        item
        for item in entity_body["media"]
        if item["kind"] == "animation" and item["rule_field"] == "WarheadType.SplashList"
    )
    assert splash_animation["selected_sample"] == "IMPACT2"
    destruction_animation = next(
        item
        for item in entity_body["media"]
        if item["kind"] == "animation" and item["role"] == "destruction"
    )
    assert destruction_animation["slot"] == "destruction"
    assert destruction_animation["selection_value"] == 50
    assert destruction_animation["selected_sample"] == "DEATH3"
    assert destruction_animation["rule_field"] == "WarheadType.AnimList"
    debris_animation = next(
        item
        for item in entity_body["media"]
        if item["kind"] == "animation" and item["role"] == "debris"
    )
    assert debris_animation["selection"] == "random"
    assert debris_animation["rule_field"] == "General.MetallicDebris"
    assert [sample["name"] for sample in debris_animation["samples"]] == [
        "DEBRIS1",
        "DEBRIS2",
    ]
    assert entity_body["art"]["primary_fire_flh"] == "180,24,90"
    assert entity_body["art"]["weapon_1_flh"] == "160,18,80"
    select_voice = next(item for item in entity_body["media"] if item["slot"] == "select")
    assert select_voice["event"] == "FixtureSelect"
    assert select_voice["samples"][0]["text"] == "准备测试。"
    assert select_voice["samples"][0]["original_text"] == "Ready for the test."
    assert select_voice["samples"][0]["localized_text"] is None
    assert select_voice["samples"][0]["translated_text"] == "准备测试。"
    assert select_voice["samples"][0]["text_label"] == "VOX:fixture_event"
    assert select_voice["samples"][0]["asset"]["display_name"] == "fixture.wav"
    assert select_voice["samples"][0]["weight"] == 2
    assert len(select_voice["samples"]) == 1

    associations = client.get(f"/api/assets/{sound['id']}/associations")
    assert associations.status_code == 200
    association_items = associations.json()["items"]
    assert any(
        item["entity"]["id"] == "DemoVehicle"
        and item["text"] == "准备测试。"
        and item["original_text"] == "Ready for the test."
        and item["localized_text"] is None
        and item["translated_text"] == "准备测试。"
        for item in association_items
        if item["entity"]
    )

    infantry = client.get(f"/api/entities/{source['id']}/DemoInfantry")
    assert infantry.status_code == 200
    infantry_preview = infantry.json()["preview"]
    assert infantry_preview["frame_count"] == 3
    assert infantry_preview["source_frame_count"] == 6
    assert infantry_preview["frame_indices"] == [0, 2, 4]
    assert infantry_preview["supports_facing"] is True
    ready_animation = next(
        item
        for item in infantry.json()["media"]
        if item["kind"] == "animation" and item["event"] == "ready"
    )
    assert ready_animation["aliases"] == ["guard"]
    assert not any(
        item["kind"] == "animation" and item["event"] == "guard"
        for item in infantry.json()["media"]
    )
    walk_animation = next(
        item
        for item in infantry.json()["media"]
        if item["kind"] == "animation" and item["event"] == "walk"
    )
    assert walk_animation["slot"] == "body_sequence"
    assert walk_animation["role"] == "body"
    assert walk_animation["rule_field"] == "Sequence.walk"
    assert walk_animation["samples"][0]["animation"] == {
        "start_frame": 0,
        "frame_count": 2,
        "facing_step": 1,
        "frame_step": 1,
        "rate_ms": None,
        "loop_start": None,
        "loop_end": None,
        "loop_count": None,
        "direction": None,
        "shadow": False,
        "reverse": False,
    }
    infantry_image = client.get(
        f"/api/entities/{source['id']}/DemoInfantry/preview.png",
        params={"frame": 2},
    )
    assert infantry_image.status_code == 200
    assert infantry_image.content.startswith(b"\x89PNG")
    infantry_facing = client.get(
        f"/api/entities/{source['id']}/DemoInfantry/preview.png",
        params={"frame": 0, "facing": 2},
    )
    assert infantry_facing.status_code == 200
    assert (
        infantry_facing.content
        != client.get(
            f"/api/entities/{source['id']}/DemoInfantry/preview.png",
            params={"frame": 0, "facing": 0},
        ).content
    )
    infantry_thumbnail = client.get(
        f"/api/entities/{source['id']}/DemoInfantry/preview.png",
        params={"frame": 2, "thumbnail": "true"},
    )
    with Image.open(io.BytesIO(infantry_thumbnail.content)) as thumbnail:
        visible_bounds = thumbnail.convert("RGBA").getchannel("A").getbbox()
        assert visible_bounds is not None
        visible_width = visible_bounds[2] - visible_bounds[0]
        visible_height = visible_bounds[3] - visible_bounds[1]
        assert abs(visible_bounds[0] - (thumbnail.width - visible_bounds[2])) <= 1
        assert abs(visible_bounds[1] - (thumbnail.height - visible_bounds[3])) <= 1
        visible_ratio = max(
            visible_width / thumbnail.width,
            visible_height / thumbnail.height,
        )
        assert 0.68 <= visible_ratio <= 0.75
    infantry_compact_thumbnail = client.get(
        f"/api/entities/{source['id']}/DemoInfantry/preview.png",
        params={"frame": 2, "thumbnail": "true", "compact": "true"},
    )
    with Image.open(io.BytesIO(infantry_compact_thumbnail.content)) as thumbnail:
        visible_bounds = thumbnail.convert("RGBA").getchannel("A").getbbox()
        assert visible_bounds is not None
        visible_width = visible_bounds[2] - visible_bounds[0]
        visible_height = visible_bounds[3] - visible_bounds[1]
        assert (
            max(
                visible_width / thumbnail.width,
                visible_height / thumbnail.height,
            )
            >= 0.8
        )

    entity_preview = client.get(
        f"/api/entities/{source['id']}/DemoVehicle/preview.png",
        params={"frame": 3, "facing": 2, "player_color": "blue"},
    )
    assert entity_preview.status_code == 200
    assert entity_preview.content.startswith(b"\x89PNG")

    entity_model = client.get(
        f"/api/entities/{source['id']}/DemoVehicle/model.json",
        params={"frame": 3, "player_color": "blue"},
    )
    assert entity_model.status_code == 200
    assert entity_model.json()["frame"] == 3
    assert entity_model.json()["frame_count"] == 4
    assert entity_model.json()["part_count"] == 1
    assert entity_model.headers["cache-control"] == "private, max-age=3600"

    diagnostics = client.get(f"/api/semantic/{source['id']}/diagnostics")
    assert diagnostics.status_code == 200
    diagnostic_body = diagnostics.json()
    assert diagnostic_body["status"] == "ready"
    assert diagnostic_body["entity_count"] == 2
    assert diagnostic_body["renderable_percent"] == 100.0
    assert diagnostic_body["unresolved_dependency_count"] == 0

    colors = client.get("/api/player-colors")
    assert colors.status_code == 200
    assert {item["id"] for item in colors.json()} >= {"red", "blue", "green"}
    invalid_color = client.get(
        f"/api/entities/{source['id']}/DemoVehicle/preview.png",
        params={"player_color": "transparent"},
    )
    assert invalid_color.status_code == 422

    layered_sprite = client.get(
        f"/api/assets/{sprite['id']}/preview.png",
        params={
            "frame": 0,
            "shadow_frame": 1,
            "palette_kind": "animation",
        },
    )
    assert layered_sprite.status_code == 200
    assert layered_sprite.content.startswith(b"\x89PNG")

    artifact_kinds = {
        path.parent.name
        for path in settings.derived_root.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    }
    assert settings.derived_root.joinpath("manifest.json").is_file()
    assert artifact_kinds >= {"audio", "metadata", "models", "previews"}
    assert "extracted" not in artifact_kinds

    removed = client.delete(f"/api/sources/{source['id']}")
    assert removed.status_code == 200
    assert client.get("/api/sources").json() == []


def test_api_rejects_untrusted_host(tmp_path: Path) -> None:
    data_dir = tmp_path / "runtime"
    settings = Settings(
        data_dir=data_dir,
        database_path=data_dir / "library.db",
        frontend_dir=tmp_path / "missing-frontend",
        known_names_path=data_dir / "reference" / "known_names_ra2.txt",
    )
    settings.prepare()
    client = TestClient(create_app(settings), base_url="http://outside.example")

    response = client.get("/api/health")

    assert response.status_code == 400


def test_art_animation_playback_uses_inclusive_bounds_and_shadow() -> None:
    playback = _art_animation_playback(
        {
            "start": "10",
            "loopstart": "10",
            "loopend": "19",
            "rate": "450",
            "shadow": "yes",
        }
    )

    assert playback is not None
    assert playback.start_frame == 10
    assert playback.frame_count == 10
    assert playback.loop_end == 19
    assert playback.rate_ms == 450
    assert playback.shadow is True

    reversed_playback = _art_animation_playback(
        {"start": "10", "end": "10", "reverse": "yes"},
        end_is_frame_count=True,
    )
    assert reversed_playback is not None
    assert reversed_playback.frame_count == 10
    assert reversed_playback.reverse is True


def test_art_animation_playback_detects_repair_bay_frame_counts() -> None:
    sections = {
        "repair_start": {"image": "REPAIR", "start": "0", "end": "10"},
        "repair_damaged": {"image": "REPAIR", "start": "10", "end": "10"},
        "ordinary": {"image": "OTHER", "start": "12", "end": "23"},
    }

    assert _art_end_is_frame_count("REPAIR_START", sections["repair_start"], sections)
    assert not _art_end_is_frame_count("ORDINARY", sections["ordinary"], sections)


def test_art_animation_playback_stops_before_a_shared_damaged_state() -> None:
    sections = {
        "idle": {"image": "IDLE", "start": "0", "rate": "0", "shadow": "yes"},
        "idle_damaged": {"image": "IDLE", "start": "1", "rate": "0", "shadow": "yes"},
    }

    assert _art_sibling_frame_count("IDLE", sections["idle"], sections) == 1
    assert _art_sibling_frame_count("IDLE_DAMAGED", sections["idle_damaged"], sections) is None


def test_eva_events_read_russian_field_without_using_unit_names_as_transcripts() -> None:
    boomer = GameEntity(
        id="BSUB",
        kind="vehicle",
        usage="buildable",
        display_name="雷鸣攻击潜舰",
        internal_name="Yuri Boomer",
        ui_name="Name:Boomer",
        ui_name_resolved=True,
        image="BSUB",
        voxel=True,
        countries=("YuriCountry",),
        sides=("ThirdSide",),
        affiliation=None,
        rules={},
        art={},
        components=(),
        dependencies=(),
        media=(),
    )

    events = _build_eva_events(
        {
            "unit_eva_boomer": {
                "allied": "CEVAU39",
                "russian": "CSOFU39",
            }
        },
        _AssetIndex({}, {}),
        {},
        (boomer,),
    )

    assert [event.slot for event in events] == ["eva_allied", "eva_soviet"]
    assert {event.samples[0].name for event in events} == {"CEVAU39", "CSOFU39"}
    for event in events:
        assert event.samples[0].text is None
        assert event.samples[0].original_text is None
        assert event.samples[0].localized_text is None


def test_verified_unit_intro_overrides_csf_unit_name_text() -> None:
    voice_strings = {
        "csofu39": VoiceText(
            "VOX:CSOFU39",
            "雷鸣攻击潜舰",
            None,
            "雷鸣攻击潜舰",
        )
    }

    _overlay_voice_transcripts(
        voice_strings,
        {
            "csofu39": {
                "text": "Yuri's Boomer submarine combines stealth and ballistic missiles.",
                "original_text": "Yuri's Boomer submarine combines stealth and ballistic missiles.",
                "translated_text": "尤里的雷鸣攻击潜艇兼具隐蔽性与弹道导弹能力。",
            }
        },
    )

    assert voice_strings["csofu39"].original_text.startswith("Yuri's Boomer")
    assert voice_strings["csofu39"].localized_text == "雷鸣攻击潜舰"
    assert (
        voice_strings["csofu39"].translated_text
        == "尤里的雷鸣攻击潜艇兼具隐蔽性与弹道导弹能力。"
    )
    assert voice_strings["csofu39"].text == voice_strings["csofu39"].translated_text
    assert voice_strings["csofu39"].localized_text_origin == "game"


def test_eva_media_groups_separate_missions_and_nonverbal_prompts() -> None:
    def asset(name: str) -> dict[str, object]:
        return {
            "id": name.casefold(),
            "display_name": f"{name}.WAV",
            "format": "wav",
            "virtual_path": f"langmd.mix::{name}.WAV",
            "size": 1024,
            "storage_kind": "mix",
        }

    mission_asset = asset("XA1EV01")
    prompt_asset = asset("SPSYREAD")
    dummy_asset = asset("DUMMY")
    unit_intel_asset = asset("CEVAU08")
    world_domination_asset = asset("WWD01")
    events = (
        MediaAssociation(
            "voice",
            "eva_allied",
            "mis_xa1_evabriefing01",
            "eva",
            (MediaSample("XA1EV01", None, mission_asset),),
        ),
        MediaAssociation(
            "voice",
            "eva_yuri",
            "eva_psychicrevealready",
            "eva",
            (MediaSample("SPSYREAD", None, prompt_asset),),
        ),
        MediaAssociation(
            "voice",
            "eva_yuri",
            "eva_psychicdominatoractivated",
            "eva",
            (MediaSample("DUMMY", None, dummy_asset),),
        ),
        MediaAssociation(
            "voice",
            "eva_allied",
            "unit_eva_kirov",
            "eva",
            (MediaSample("CEVAU08", "Kirov briefing", unit_intel_asset),),
        ),
        MediaAssociation(
            "voice",
            "eva_allied",
            "wwd_allied_win",
            "eva",
            (MediaSample("WWD01", "Allied victory", world_domination_asset),),
        ),
    )

    items = {
        item["asset"]["display_name"]: item
        for item in _build_media_items(
            [
                mission_asset,
                prompt_asset,
                dummy_asset,
                unit_intel_asset,
                world_domination_asset,
            ],
            (),
            {},
            events,
            {},
        )
    }

    assert items["XA1EV01.WAV"]["kind"] == "voice"
    assert items["XA1EV01.WAV"]["groups"] == ["mission_voice"]
    assert items["XA1EV01.WAV"]["mission"] == {
        "key": "yr:allied:1",
        "game": "yr",
        "campaign": "allied",
        "number": 1,
    }
    assert items["XA1EV01.WAV"]["slots"] == [
        "mission:yr:allied:1",
        "mission_briefing",
    ]
    assert items["SPSYREAD.WAV"]["kind"] == "sound"
    assert items["SPSYREAD.WAV"]["groups"] == ["notification_sound"]
    assert items["SPSYREAD.WAV"]["description"] == "心灵揭示就绪提示音"
    assert "eva_voice" not in items["DUMMY.WAV"]["groups"]
    assert items["CEVAU08.WAV"]["groups"] == ["unit_intel_voice"]
    assert items["CEVAU08.WAV"]["slots"] == ["advisor_eva"]
    assert items["WWD01.WAV"]["groups"] == ["world_domination_voice"]


def test_unassociated_voice_keeps_catalog_transcript_in_asset_data(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "runtime"
    settings = Settings(
        data_dir=data_dir,
        database_path=data_dir / "library.db",
        frontend_dir=tmp_path / "missing-frontend",
        known_names_path=data_dir / "reference" / "known_names_ra2.txt",
    )
    settings.prepare()
    settings.mission_audio_transcript_path.parent.mkdir(parents=True, exist_ok=True)
    settings.mission_audio_transcript_path.write_text(
        json.dumps(
            {
                "entries": {
                    "tauli02": {
                        "original_text": "The order is given. Attack!",
                        "localized_text": "下達指令了：攻擊！",
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    source_dir = tmp_path / "voice-only-installation"
    source_dir.mkdir()
    (source_dir / "tauli02.wav").write_bytes(_build_fixture_wav())
    client = TestClient(create_app(settings))

    source = client.post("/api/sources", json={"path": str(source_dir)}).json()
    media = client.get(
        "/api/media",
        params={"source_id": source["id"], "q": "tauli02"},
    ).json()
    assert media["total"] == 1
    item = media["items"][0]
    assert item["groups"] == ["multiplayer_voice"]
    assert item["slots"] == ["multiplayer_attack"]
    assert item["countries"] == ["Africans"]
    assert item["sides"] == ["Nod"]
    asset = item["asset"]

    associations = client.get(
        f"/api/assets/{asset['id']}/associations",
        params={"language": "zh-CN"},
    )

    assert associations.status_code == 200
    assert associations.json() == {
        "items": [],
        "total": 0,
        "texts": ["下达指令了：攻击！"],
        "original_texts": ["The order is given. Attack!"],
        "localized_texts": [],
        "localized_text_origins": [],
        "translated_texts": ["下达指令了：攻击！"],
    }


def test_multiplayer_taunts_are_separated_from_team_communications() -> None:
    def asset(name: str) -> dict[str, object]:
        return {
            "id": name.casefold(),
            "display_name": f"{name}.wav",
            "format": "wav",
            "virtual_path": f"audio.mix::{name}.wav",
            "size": 1024,
            "storage_kind": "mix",
        }

    communication = asset("tauli03")
    taunt = asset("tauli06")
    items = {
        item["asset"]["display_name"]: item
        for item in _build_media_items(
            [communication, taunt],
            (),
            {},
            (),
            {
                "tauli03": VoiceText("TRANSCRIPT:tauli03", "Help me!", "Help me!", None),
                "tauli06": VoiceText("TRANSCRIPT:tauli06", "Ha ha ha!", "Ha ha ha!", None),
            },
        )
    }

    assert items["tauli03.wav"]["groups"] == ["multiplayer_voice"]
    assert items["tauli03.wav"]["slots"] == ["multiplayer_help"]
    assert items["tauli06.wav"]["groups"] == ["taunt_voice"]
    assert items["tauli06.wav"]["slots"] == ["taunt_laugh"]


def test_standalone_sound_events_use_specific_retail_categories() -> None:
    def group(event: str, sample_name: str | None = None) -> str:
        return _standalone_sound_group(event, MediaSample(sample_name or event, None, None))

    assert group("OreRefineryProcessing") == "structure_sound"
    assert group("NukeLaunch") == "superweapon_sound"
    assert group("NuclearSiloReady") == "superweapon_sound"
    assert group("ChronosphereOpen") == "superweapon_sound"
    assert group("ChronoScreenSound") == "superweapon_sound"
    assert group("PsychicRevealActivate") == "superweapon_sound"
    assert group("CratePromoted") == "notification_sound"
    assert group("CrateMoney") == "notification_sound"
    assert group("ArnoldDie") == "death_sound"
    assert group("HornetTakeoff") == "movement_sound"
    assert group("KirovEliteBomb") == "weapon_sound"
    assert group("AirRaidSiren") == "notification_sound"
    assert group("ArnoldFear") == "action_sound"
    assert group("CommandBar") == "interface_sound"
    assert group("BuildingMetalDamaged", "bmetdamb") == "impact_sound"
    assert group("ExplosionWaterLarge") == "destruction_sound"
    assert group("TanyaEntersWater") == "action_sound"
    assert group("NavalUnitEmerge") == "action_sound"


def test_mission_audio_exposes_mission_and_event_facets() -> None:
    def asset(name: str) -> dict[str, object]:
        return {
            "id": name.casefold(),
            "display_name": f"{name}.wav",
            "format": "wav",
            "virtual_path": f"audio.mix::{name}.wav",
            "size": 1024,
            "storage_kind": "mix",
        }

    briefing = asset("XS5SO01")
    warning = asset("XS5SO13")
    items = {
        item["asset"]["display_name"]: item
        for item in _build_media_items(
            [briefing, warning],
            (),
            {},
            (
                MediaAssociation(
                    "voice",
                    "eva_soviet",
                    "mis_xs5_zofiabriefing01",
                    "eva",
                    (MediaSample("XS5SO01", "Approaching the island", briefing),),
                ),
                MediaAssociation(
                    "voice",
                    "eva_soviet",
                    "mis_xs5_zofiastrangereadings",
                    "eva",
                    (MediaSample("XS5SO13", "Strange readings", warning),),
                ),
            ),
            {},
        )
    }

    assert items["XS5SO01.wav"]["slots"] == [
        "mission:yr:soviet:5",
        "mission_briefing",
    ]
    assert items["XS5SO13.wav"]["slots"] == [
        "mission:yr:soviet:5",
        "mission_warning",
    ]


def test_orphaned_retail_audio_keeps_evidence_based_categories() -> None:
    def asset(name: str, asset_format: str, virtual_path: str) -> dict[str, object]:
        return {
            "id": name.casefold(),
            "display_name": name,
            "format": asset_format,
            "virtual_path": virtual_path,
            "size": 1024,
            "storage_kind": "mix",
        }

    propaganda = asset("aprotr1.wav", "bag_audio", "language.mix/audio.mix::aprotr1.wav")
    explosion = asset("gexp05a.wav", "bag_audio", "language.mix/audio.mix::gexp05a.wav")
    interface = asset("BARGRAPH.AUD", "aud", "ra2.mix/SIDENC02.MIX::BARGRAPH.AUD")
    unknown = asset("MYSTERY.AUD", "aud", "ra2.mix/local.mix::MYSTERY.AUD")

    items = {
        item["asset"]["display_name"]: item
        for item in _build_media_items(
            [propaganda, explosion, interface, unknown],
            (),
            {},
            (),
            {
                "aprotr1": VoiceText(
                    "TRANSCRIPT:aprotr1",
                    "宣传广播",
                    "Propaganda broadcast",
                    "宣传广播",
                )
            },
        )
    }

    assert items["aprotr1.wav"]["groups"] == ["ambient_voice"]
    assert items["aprotr1.wav"]["events"] == ["PropagandaTruck"]
    assert items["aprotr1.wav"]["slots"] == ["ambient"]
    assert items["gexp05a.wav"]["groups"] == ["destruction_sound"]
    assert items["gexp05a.wav"]["events"] == ["Explosion05"]
    assert items["gexp05a.wav"]["slots"] == ["explosion"]
    assert items["BARGRAPH.AUD"]["groups"] == ["interface_sound"]
    assert items["BARGRAPH.AUD"]["slots"] == ["interface"]
    assert items["MYSTERY.AUD"]["kind"] == "unknown"


def test_standalone_sound_events_receive_semantic_subcategories() -> None:
    def asset(name: str) -> dict[str, object]:
        return {
            "id": name.casefold(),
            "display_name": name,
            "format": "wav",
            "virtual_path": f"audio.mix::{name}",
            "size": 1024,
            "storage_kind": "mix",
        }

    selected = asset("iarnsea.wav")
    dying = asset("vintdia.wav")
    interface = asset("ucommand.wav")
    weapon = asset("laser.wav")
    dog = asset("idogatta.wav")
    placement = asset("uplace.wav")
    bonus = asset("ubonus.wav")
    items = {
        item["asset"]["display_name"]: item
        for item in _build_media_items(
            [
                selected,
                dying,
                interface,
                weapon,
                dog,
                placement,
                bonus,
            ],
            (),
            {
                "ArnoldSelect": (MediaSample("iarnsea", "Your orders", selected),),
                "IntruderVoiceDie": (MediaSample("vintdia", "Bail out", dying),),
                "CommandBar": (MediaSample("ucommand", "*Command units", interface),),
                "LaserFire": (MediaSample("laser", None, weapon),),
                "DogAttack": (MediaSample("idogatta", "*Bite*", dog, "Bite*", None),),
                "dogattack": (MediaSample("idogatta", "*Bite*", dog, "Bite*", None),),
                "PlaceBuilding": (
                    MediaSample("uplace", "*Place building", placement, "Place building", None),
                ),
                "CrateMoney": (MediaSample("ubonus", "*Money crate", bonus, "Money crate", None),),
            },
            (),
            {},
        )
    }

    assert items["iarnsea.wav"]["groups"] == ["selection_voice"]
    assert items["iarnsea.wav"]["slots"] == ["select", "sound_event"]
    assert items["vintdia.wav"]["groups"] == ["death_voice"]
    assert items["ucommand.wav"]["kind"] == "sound"
    assert items["ucommand.wav"]["groups"] == ["interface_sound"]
    assert items["ucommand.wav"]["texts"] == ["Command units"]
    assert items["laser.wav"]["groups"] == ["weapon_sound"]
    assert items["idogatta.wav"]["groups"] == ["weapon_sound"]
    assert items["idogatta.wav"]["texts"] == ["Bite"]
    assert items["idogatta.wav"]["events"] == ["DogAttack"]
    assert items["uplace.wav"]["groups"] == ["action_sound"]
    assert items["uplace.wav"]["texts"] == ["Place building"]
    assert items["ubonus.wav"]["groups"] == ["notification_sound"]
    assert items["ubonus.wav"]["texts"] == ["Money crate"]
    assert all(
        "combat_sound" not in item["groups"] and "pickup_sound" not in item["groups"]
        for item in items.values()
    )


def test_shared_media_entity_refs_preserve_affiliation() -> None:
    asset = {
        "id": "shared.wav",
        "display_name": "shared.wav",
        "format": "wav",
        "virtual_path": "loose::shared.wav",
        "size": 1024,
        "storage_kind": "loose",
    }
    sample = MediaSample("shared", "Shared line", asset)

    def entity(entity_id: str, country: str, side: str, side_name: str) -> GameEntity:
        return GameEntity(
            id=entity_id,
            kind="infantry",
            usage="buildable",
            display_name="工程师",
            internal_name="Engineer",
            ui_name=None,
            ui_name_resolved=True,
            image=entity_id,
            voxel=False,
            countries=(country,),
            sides=(side,),
            affiliation={"kind": "side", "id": side, "display_name": side_name},
            rules={},
            art={},
            components=(),
            dependencies=(),
            media=(MediaAssociation("voice", "select", "EngineerSelect", entity_id, (sample,)),),
        )

    item = _build_media_items(
        [asset],
        (
            entity("ENGINEER", "Americans", "GDI", "盟军"),
            entity("SENGINEER", "Russians", "Nod", "苏军"),
        ),
        {},
        (),
        {},
    )[0]

    assert [ref["display_name"] for ref in item["entities"]] == ["工程师", "工程师"]
    assert [ref["affiliation"]["display_name"] for ref in item["entities"]] == [
        "盟军",
        "苏军",
    ]


def test_retail_class_markers_do_not_fail_a_source(tmp_path: Path) -> None:
    source_dir = tmp_path / "retail"
    source_dir.mkdir()
    (source_dir / "thememd.mix").write_bytes(b"CLASS")
    data_dir = tmp_path / "runtime"
    settings = Settings(
        data_dir=data_dir,
        database_path=data_dir / "library.db",
        frontend_dir=tmp_path / "missing-frontend",
        known_names_path=data_dir / "reference" / "known_names_ra2.txt",
    )
    settings.prepare()
    client = TestClient(create_app(settings))

    response = client.post("/api/sources", json={"path": str(source_dir)})

    assert response.status_code == 201
    assert response.json()["state"] == "ready"
    assert response.json()["archive_count"] == 1


def test_scan_excludes_the_derived_workspace(tmp_path: Path) -> None:
    source_dir = tmp_path / "game-root"
    source_dir.mkdir()
    (source_dir / "rules.ini").write_text("[General]\n", encoding="ascii")
    data_dir = tmp_path / "runtime"
    derived_dir = source_dir / "RA2MD-Ext"
    settings = Settings(
        data_dir=data_dir,
        database_path=data_dir / "library.db",
        frontend_dir=tmp_path / "missing-frontend",
        known_names_path=data_dir / "reference" / "known_names_ra2.txt",
        derived_dir=derived_dir,
    )
    settings.prepare()
    (derived_dir / "should-not-load.ini").write_text("[Derived]\n", encoding="ascii")
    client = TestClient(create_app(settings))

    source = client.post("/api/sources", json={"path": str(source_dir)}).json()
    assets = client.get("/api/assets", params={"source_id": source["id"]}).json()

    assert [item["display_name"] for item in assets["items"]] == ["rules.ini"]


def test_serve_defaults_do_not_open_external_programs() -> None:
    from ra2_explorer.cli import build_parser
    from ra2_explorer.config import DEFAULT_PORT

    args = build_parser().parse_args(["serve"])

    assert args.port == DEFAULT_PORT == 46_120
    assert args.open_browser is False


def test_canonical_cli_name_is_ra2exp() -> None:
    from ra2_explorer.cli import build_parser

    assert build_parser().prog == "ra2exp"


def test_entity_usage_distinguishes_player_structures_and_scene_objects() -> None:
    assert (
        _entity_usage(
            "building",
            {
                "owner": "British,Americans",
                "cost": "3000",
                "techlevel": "-1",
                "constructionyard": "yes",
                "undeploysinto": "AMCV",
                "capturable": "yes",
            },
        )
        == "buildable"
    )
    assert (
        _entity_usage(
            "building",
            {"capturable": "yes", "needsengineer": "yes"},
        )
        == "tech"
    )
    assert (
        _entity_usage(
            "building",
            {"civilian": "yes", "nominal": "yes"},
        )
        == "civilian"
    )
    assert _entity_usage("building", {"owner": "Americans", "cost": "2800"}) == "scenario"
    assert (
        _entity_usage(
            "infantry",
            {"owner": "Americans", "cost": "1000", "techlevel": "8", "buildlimit": "1"},
        )
        == "hero"
    )


def test_entity_animation_fields_follow_art_semantics() -> None:
    assert _entity_animation_role("buildup") == "construction"
    assert _entity_animation_role("activeanim") == "operation"
    assert _entity_animation_role("activeanimtwo") == "operation"
    assert _entity_animation_role("productionanim") == "operation"
    assert _entity_animation_role("superanimtwo") == "operation"
    assert _entity_animation_role("specialanimthree") == "operation"
    assert _entity_animation_role("underroofdooranim") == "operation"
    assert _entity_animation_role("bibshape") is None
    assert _entity_animation_role("animactive") is None
    assert _entity_animation_role("activeanimdamaged") is None
    assert _entity_animation_role("chargeanim") is None
    assert _entity_animation_role("turretanim") is None


def test_non_voxel_unit_frames_follow_walk_and_firing_configuration() -> None:
    playbacks = _shp_unit_body_playbacks({"walkframes": "6", "firingframes": "4"})

    assert [event for event, _playback, _field in playbacks] == [
        "ready",
        "walk",
        "fire",
    ]
    assert playbacks[0][1].start_frame == 0
    assert playbacks[0][1].facing_step == 1
    assert playbacks[1][1].start_frame == 8
    assert playbacks[1][1].frame_count == 6
    assert playbacks[1][1].frame_step == 8
    assert playbacks[2][1].start_frame == 56
    assert playbacks[2][1].frame_count == 4
    assert playbacks[2][1].frame_step == 8


def test_default_building_layers_follow_operation_associations() -> None:
    def asset(asset_id: str, asset_format: str = "shp") -> dict[str, object]:
        return {
            "id": asset_id,
            "display_name": f"{asset_id}.{asset_format}",
            "format": asset_format,
            "virtual_path": f"fixture::{asset_id}.{asset_format}",
            "size": 128,
            "storage_kind": "mix",
        }

    first = MediaSample("FIRST", None, asset("first"))
    selected = MediaSample("SELECTED", None, asset("selected"))
    ignored = MediaSample("IGNORED", None, asset("ignored"))
    super_idle = MediaSample("SUPER_IDLE", None, asset("super-idle"))
    super_start = MediaSample("SUPER_START", None, asset("super-start"))
    production = MediaSample("PRODUCTION", None, asset("production"))
    entity = GameEntity(
        id="DemoBuilding",
        kind="building",
        usage="buildable",
        display_name="Demo Building",
        internal_name="Demo Building",
        ui_name=None,
        ui_name_resolved=True,
        image="DEMOBUILDING",
        voxel=False,
        countries=(),
        sides=(),
        affiliation=None,
        rules={},
        art={},
        components=(),
        dependencies=(),
        media=(
            MediaAssociation(
                "animation",
                "activeanim",
                "FIRST",
                "DemoBuilding",
                (first, selected),
                role="operation",
                selection="first",
                selected_sample="SELECTED",
            ),
            MediaAssociation(
                "animation",
                "activeanimtwo",
                "FIRST",
                "DemoBuilding",
                (first,),
                role="operation",
            ),
            MediaAssociation(
                "animation",
                "buildup",
                "IGNORED",
                "DemoBuilding",
                (ignored,),
                role="construction",
            ),
            MediaAssociation(
                "animation",
                "superanim",
                "SUPER_IDLE",
                "DemoBuilding",
                (super_idle,),
                role="operation",
            ),
            MediaAssociation(
                "animation",
                "superanimtwo",
                "SUPER_START",
                "DemoBuilding",
                (super_start,),
                role="operation",
            ),
            MediaAssociation(
                "animation",
                "productionanim",
                "PRODUCTION",
                "DemoBuilding",
                (production,),
                role="operation",
            ),
        ),
    )

    assert [sample.name for sample in _default_entity_operation_samples(entity)] == [
        "SELECTED",
        "FIRST",
        "SUPER_IDLE",
    ]
    assert [
        sample.name
        for sample in _default_entity_operation_samples(
            entity,
            excluded_asset_id="selected",
        )
    ] == ["FIRST", "SUPER_IDLE"]
    assert [
        sample.name
        for sample in _default_entity_operation_samples(
            entity,
            excluded_asset_id="super-start",
        )
    ] == ["SELECTED", "FIRST"]


def test_layered_building_thumbnail_uses_the_complete_visible_subject() -> None:
    body = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    body.paste((255, 0, 0, 255), (4, 55, 20, 72))
    operation = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    operation.paste((0, 255, 0, 255), (24, 8, 88, 62))
    composite = _alpha_composite_centered([body, operation])

    focus = _composite_focus_bounds(
        (4, 55, 20, 72),
        body.size,
        [operation],
        composite.size,
    )
    thumbnail = _crop_transparent_preview(composite, focus_bounds=focus)
    visible = thumbnail.getchannel("A").getbbox()

    assert focus == (4, 8, 88, 72)
    assert visible is not None
    assert abs(visible[0] - (thumbnail.width - visible[2])) <= 1
    assert abs(visible[1] - (thumbnail.height - visible[3])) <= 1


def test_building_components_include_bib_and_voxel_turret_parts() -> None:
    def asset(name: str, asset_format: str) -> dict[str, object]:
        return {
            "id": name.casefold(),
            "display_name": name,
            "name": name,
            "format": asset_format,
            "virtual_path": f"fixture::{name}",
            "size": 128,
            "storage_kind": "mix",
        }

    indexed = _index_assets(
        [
            asset("GAGCAN.SHP", "shp"),
            asset("GAGCANBB.SHP", "shp"),
            asset("GTGCANTUR.VXL", "vxl"),
            asset("GTGCANTUR.HVA", "hva"),
            asset("GTGCANBARL.VXL", "vxl"),
            asset("GTGCANBARL.HVA", "hva"),
        ]
    )

    components, voxel = _resolve_components(
        indexed,
        "building",
        "GTGCAN",
        "GAGCAN",
        {"turretanim": "GTGCANTUR", "turretanimisvoxel": "yes"},
        {"bibshape": "GAGCANBB"},
        True,
        True,
    )
    by_role = {component.role: component.asset for component in components}

    assert voxel is False
    assert by_role["body"]["display_name"] == "GAGCAN.SHP"
    assert by_role["bib"]["display_name"] == "GAGCANBB.SHP"
    assert by_role["turret"]["display_name"] == "GTGCANTUR.VXL"
    assert by_role["barrel"]["display_name"] == "GTGCANBARL.VXL"

    entity = GameEntity(
        id="GTGCAN",
        kind="building",
        usage="buildable",
        display_name="Grand Cannon",
        internal_name="Grand Cannon",
        ui_name=None,
        ui_name_resolved=True,
        image="GAGCAN",
        voxel=False,
        countries=(),
        sides=(),
        affiliation=None,
        rules={},
        art={},
        components=components,
        dependencies=(),
        media=(),
    )
    assert entity.summary()["body_format"] == "shp"
    assert entity.summary()["facing_format"] == "vxl"


def test_anchored_building_turret_expands_canvas_without_clipping() -> None:
    body = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
    body.paste((255, 0, 0, 255), (10, 12, 30, 28))
    turret = Image.new("RGBA", (20, 16), (0, 0, 0, 0))
    turret.paste((0, 255, 0, 255), (2, 1, 19, 10))

    composite, focus = _alpha_composite_anchored(
        body,
        turret,
        overlay_anchor=(10, 14),
        target_anchor=(20, 5),
        base_focus=(10, 12, 30, 28),
    )

    assert composite.size == (40, 39)
    assert focus == (10, 1, 30, 37)
    assert composite.getchannel("A").getbbox() == (10, 1, 30, 37)


def test_effective_entity_countries_follow_house_restrictions() -> None:
    owners = (
        "Russians,Confederation,Africans,Arabs,YuriCountry,"
        "British,French,Germans,Americans,Alliance"
    )

    assert _effective_entity_countries(
        {
            "owner": owners,
            "forbiddenhouses": "Russians,Confederation,Africans,Arabs,YuriCountry",
        }
    ) == ("British", "French", "Germans", "Americans", "Alliance")
    assert _effective_entity_countries(
        {
            "owner": owners,
            "forbiddenhouses": "British,French,Germans,Americans,Alliance,YuriCountry",
        }
    ) == ("Russians", "Confederation", "Africans", "Arabs")
    assert _effective_entity_countries({"owner": owners, "requiredhouses": "British"}) == (
        "British",
    )


def test_expansion_rules_replace_the_base_edition() -> None:
    base = {
        "id": "base",
        "display_name": "rules.ini",
        "virtual_path": "ra2.mix::rules.ini",
        "storage_kind": "mix",
    }
    expansion = {
        "id": "expansion",
        "display_name": "rulesmd.ini",
        "virtual_path": "ra2md.mix::rulesmd.ini",
        "storage_kind": "mix",
    }

    assert _edition_ini_inputs(
        {"rules.ini": [base], "rulesmd.ini": [expansion]},
        "rules.ini",
        "rulesmd.ini",
    ) == [expansion]
    assert _edition_ini_inputs(
        {"rules.ini": [base]},
        "rules.ini",
        "rulesmd.ini",
    ) == [base]
