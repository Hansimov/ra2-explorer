from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from collections import Counter, OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, replace
from typing import Any

from PIL import Image

from ra2_explorer.codecs.csf import parse_csf
from ra2_explorer.codecs.hva import parse_hva
from ra2_explorer.codecs.mix import classic_mix_hash, ra2_mix_hash
from ra2_explorer.codecs.pal import Palette, grayscale_palette
from ra2_explorer.codecs.shp import ShpFile, parse_shp
from ra2_explorer.codecs.text import parse_ini
from ra2_explorer.codecs.vpl import VplFile, parse_vpl
from ra2_explorer.codecs.vxl import (
    VxlRenderPart,
    VxlScene,
    build_vxl_scene,
    parse_vxl,
    render_vxl_composite,
    render_vxl_composite_with_anchor,
)
from ra2_explorer.errors import AssetNotFoundError, InvalidFormatError, Ra2ExplorerError
from ra2_explorer.library import AssetReader
from ra2_explorer.localization import (
    DEFAULT_GAME_LANGUAGE,
    GameLanguage,
    localize_game_text,
    localized_mixed_search_match,
    pinyin_search_aliases,
)
from ra2_explorer.storage import Database

ENTITY_KINDS = ("vehicle", "infantry", "aircraft", "building")
ENTITY_USAGES = ("buildable", "hero", "tech", "civilian", "scenario")
UNAFFILIATED_SIDE = "unaffiliated"
SEMANTIC_CATALOG_CACHE_IDENTITY = ("semantic-catalog-v22",)
_PLANNING_SIDE_IDS = ("GDI", "Nod", "ThirdSide")
_TYPE_SECTIONS = {
    "vehicle": "VehicleTypes",
    "infantry": "InfantryTypes",
    "aircraft": "AircraftTypes",
    "building": "BuildingTypes",
}
_RULE_FIELDS = {
    "category": "category",
    "owner": "owner",
    "cost": "cost",
    "strength": "strength",
    "armor": "armor",
    "speed": "speed",
    "sight": "sight",
    "tech_level": "techlevel",
    "prerequisite": "prerequisite",
    "primary": "primary",
    "secondary": "secondary",
    "elite_primary": "eliteprimary",
    "elite_secondary": "elitesecondary",
    "turret": "turret",
    "turret_anim": "turretanim",
    "turret_anim_is_voxel": "turretanimisvoxel",
    "turret_anim_x": "turretanimx",
    "turret_anim_y": "turretanimy",
    "turret_anim_z_adjust": "turretanimzadjust",
    "naval": "naval",
    "considered_aircraft": "consideredaircraft",
    "ai_base_planning_side": "aibaseplanningside",
    "movement_zone": "movementzone",
    "required_houses": "requiredhouses",
    "forbidden_houses": "forbiddenhouses",
}
_ART_FIELDS = {
    "cameo": "cameo",
    "alt_cameo": "altcameo",
    "turret_offset": "turretoffset",
    "primary_fire_flh": "primaryfireflh",
    "secondary_fire_flh": "secondaryfireflh",
    "elite_primary_fire_flh": "eliteprimaryfireflh",
    "elite_secondary_fire_flh": "elitesecondaryfireflh",
    **{f"weapon_{index}_flh": f"weapon{index}flh" for index in range(1, 18)},
    "remapable": "remapable",
    "voxel": "voxel",
    "new_theater": "newtheater",
    "foundation": "foundation",
    "bib_shape": "bibshape",
    "facings": "facings",
    "sequence": "sequence",
    "walk_frames": "walkframes",
    "firing_frames": "firingframes",
}
_AUDIO_RULE_FIELDS = {
    "select": "voiceselect",
    "move": "voicemove",
    "attack": "voiceattack",
    "feedback": "voicefeedback",
    "special_attack": "voicespecialattack",
    "enter": "voiceenter",
    "capture": "voicecapture",
    "deploy": "voicedeploy",
    "harvest": "voiceharvest",
    "die": "diesound",
    "create": "createsound",
    "movement": "movesound",
    "deploy_sound": "deploysound",
    "undeploy": "undeploysound",
    "enter_transport": "entertransportsound",
    "leave_transport": "leavetransportsound",
    "turret_rotate": "turretrotatesound",
    "start_moving": "startmovingsound",
    "stop_moving": "stopmovingsound",
    "activate": "activatesound",
    "deactivate": "deactivatesound",
    "cloak": "cloaksound",
    "uncloak": "uncloaksound",
    "chrono_in": "chronoinsound",
    "chrono_out": "chronooutsound",
    "crashing": "crashingsound",
    "impact_land": "impactlandsound",
}
_WEAPON_FIELDS = {
    "damage": "damage",
    "rate_of_fire": "rof",
    "range": "range",
    "minimum_range": "minimumrange",
    "burst": "burst",
    "speed": "speed",
    "projectile": "projectile",
    "warhead": "warhead",
    "report": "report",
    "animation": "anim",
}
_PROJECTILE_FIELDS = {
    "image": "image",
    "arcing": "arcing",
    "invisible": "invisible",
    "proximity": "proximity",
    "rotation": "rot",
    "acceleration": "acceleration",
    "inaccurate": "inaccurate",
}
_WARHEAD_FIELDS = {
    "verses": "verses",
    "cell_spread": "cellspread",
    "percent_at_max": "percentatmax",
    "infantry_death": "infdeath",
    "animation_list": "animlist",
    "splash_list": "splashlist",
    "em_effect": "emeffect",
    "conventional": "conventional",
    "wall": "wall",
    "wood": "wood",
    "radiation": "radiation",
}
_WEAPON_SLOTS = (
    ("primary", "primary"),
    ("secondary", "secondary"),
    ("elite_primary", "eliteprimary"),
    ("elite_secondary", "elitesecondary"),
)

_COUNTRY_ICON_FILES = {
    "americans": ("USAI.PCX",),
    "alliance": ("JAPI.PCX",),
    "french": ("FRAI.PCX",),
    "germans": ("GERI.PCX",),
    "british": ("GBRI.PCX",),
    "africans": ("DJBI.PCX",),
    "arabs": ("ARBI.PCX",),
    "confederation": ("LATI.PCX",),
    "russians": ("RUSI.PCX",),
    "yuricountry": ("OBS_YURI.PCX", "OBSYURI.SHP"),
}
_SIDE_ICON_FILES = {
    "gdi": ("GDII.PCX", "OBS_ALLI.PCX"),
    "nod": ("NODI.PCX", "OBS_SOVI.PCX"),
    "thirdside": ("OBS_YURI.PCX", "OBSYURI.SHP"),
}
_SIDE_DISPLAY_NAMES = {
    "gdi": "盟军",
    "nod": "苏军",
    "thirdside": "尤里",
}
_EVA_UNIT_ENTITY_IDS = {
    "aegis": "AEGIS",
    "aircraftcarrier": "CARRIER",
    "apocalypse": "APOC",
    "barracksyuri": "YABRCK",
    "batlabyuri": "YATECH",
    "battlebunker": "NABNKR",
    "battlefortress": "BFRT",
    "bioreactor": "YAPOWR",
    "bioriactor": "YAPOWR",
    "blackeagle": "BEAG",
    "boomer": "BSUB",
    "boris": "BORIS",
    "brute": "BRUTE",
    "chaos": "CAOS",
    "chaosdrone": "CAOS",
    "chronolegion": "CCOMAND",
    "clonevat": "NACLON",
    "cloningvat": "NACLON",
    "demotruck": "DTRUCK",
    "desolator": "DESO",
    "destroyer": "DEST",
    "dreadnought": "DRED",
    "engineer": "ENGINEER",
    "floatdisc": "DISK",
    "gatcannon": "YAGGUN",
    "gattank": "YTNK",
    "geneticmut": "YAGNTC",
    "grandcannon": "GTGCAN",
    "grinder": "YAGRND",
    "guardiangi": "GGI",
    "hoveryuri": "YHVR",
    "industrialplant": "NAINDP",
    "ifv": "FV",
    "initiate": "INIT",
    "intruder": "ORCA",
    "kirov": "ZEP",
    "lasercosmo": "LUNR",
    "lasher": "LTNK",
    "magnetron": "TELE",
    "mastermind": "MIND",
    "mcvyuri": "PCV",
    "psychicdomin": "YAPPPT",
    "psychicsensor": "NAPSIS",
    "psychsensor": "NAPSIS",
    "psychictower": "YAPSYT",
    "psicorpse": "YURI",
    "psychtower": "YAPSYT",
    "robotcontrol": "GAROBO",
    "robottank": "ROBO",
    "siegechopper": "SCHP",
    "seascorpion": "HYD",
    "seal": "GHOST",
    "slave": "SLAV",
    "slaveminer": "SMIN",
    "sniper": "SNIPE",
    "spyplane": "SPYP",
    "spy": "SPY",
    "squid": "SQD",
    "sub": "SUB",
    "subpen": "YAYARD",
    "tankbunk": "NATBNK",
    "tankdestroyer": "TNKD",
    "techhospital": "CATHOSP",
    "techmachshop": "CAMACH",
    "techsecretlab": "CASLAB",
    "terrorist": "TERROR",
    "terrordrone": "DRON",
    "teslatank": "TTNK",
    "v3": "V3",
    "virus": "VIRUS",
    "wallyuri": "GAFWLL",
    "yuriclone": "YURI",
    "yurieng": "YENGINEER",
    "yuriprime": "YURIPR",
    "yuriwar": "YAWEAP",
    "crazyivan": "IVAN",
    "gi": "E1",
    "miragetank": "MGTK",
    "paratrooper": "E1",
    "prismtank": "SREF",
    "rocketeer": "JUMPJET",
    "shocktrooper": "SHK",
}
_MEDIA_EVENT_DESCRIPTIONS = {
    "eva_psychicrevealready": "心灵揭示就绪提示音",
    "explosion05": "爆炸音效 05",
    "explosion10": "爆炸音效 10",
}
_TAUNT_AFFILIATIONS = {
    "am": ("Americans", "GDI"),
    "br": ("British", "GDI"),
    "cu": ("Confederation", "Nod"),
    "fr": ("French", "GDI"),
    "ge": ("Germans", "GDI"),
    "ir": ("Arabs", "Nod"),
    "ko": ("Alliance", "GDI"),
    "li": ("Africans", "Nod"),
    "ru": ("Russians", "Nod"),
    "yu": ("YuriCountry", "ThirdSide"),
}
_LEGACY_INTERFACE_AUDIO_DESCRIPTIONS = {
    "bargraph": "战役结算图表音效",
    "bestbox": "战役结算最佳成绩音效",
    "clktarg": "战役界面目标点击音效",
    "efficien": "战役结算效率音效",
    "gsweep": "战役界面扫描音效",
    "intro": "开场界面音频",
    "maps": "地图界面音频",
    "mouseoff": "界面指针离开音效",
    "mouseon": "界面指针进入音效",
    "nsweep": "战役界面扫描音效",
    "text1": "界面文字音效 1",
    "text2": "界面文字音效 2",
    "text3": "界面文字音效 3",
    "type": "界面打字音效",
    "wipe": "界面切换音效",
}
_NULL_IMAGES = {"", "none", "null", "<none>"}


@dataclass(frozen=True, slots=True)
class EntityComponent:
    role: str
    expected_name: str
    asset: dict[str, Any] | None

    def as_dict(self) -> dict[str, object]:
        selected = None
        if self.asset:
            selected = {
                key: self.asset[key]
                for key in (
                    "id",
                    "display_name",
                    "format",
                    "virtual_path",
                    "size",
                    "storage_kind",
                )
            }
        return {
            "role": self.role,
            "expected_name": self.expected_name,
            "asset": selected,
        }


@dataclass(frozen=True, slots=True)
class EntityDependency:
    id: str
    kind: str
    slot: str
    parent: str | None
    resolved: bool
    properties: dict[str, str]

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "kind": self.kind,
            "slot": self.slot,
            "parent": self.parent,
            "resolved": self.resolved,
            "properties": self.properties,
        }


@dataclass(frozen=True, slots=True)
class VoiceText:
    label: str
    text: str
    original_text: str | None
    localized_text: str | None
    localized_text_origin: str | None = None
    translated_text: str | None = None


@dataclass(frozen=True, slots=True)
class AnimationPlayback:
    start_frame: int = 0
    frame_count: int | None = None
    facing_step: int = 0
    frame_step: int = 1
    rate_ms: int | None = None
    loop_start: int | None = None
    loop_end: int | None = None
    loop_count: int | None = None
    direction: str | None = None
    shadow: bool = False
    reverse: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "start_frame": self.start_frame,
            "frame_count": self.frame_count,
            "facing_step": self.facing_step,
            "frame_step": self.frame_step,
            "rate_ms": self.rate_ms,
            "loop_start": self.loop_start,
            "loop_end": self.loop_end,
            "loop_count": self.loop_count,
            "direction": self.direction,
            "shadow": self.shadow,
            "reverse": self.reverse,
        }


@dataclass(frozen=True, slots=True)
class MediaSample:
    name: str
    text: str | None
    asset: dict[str, Any] | None
    original_text: str | None = None
    localized_text: str | None = None
    text_label: str | None = None
    animation: AnimationPlayback | None = None
    weight: int = 1
    palette: str | None = None
    localized_text_origin: str | None = None
    translated_text: str | None = None

    def as_dict(self, language: GameLanguage = DEFAULT_GAME_LANGUAGE) -> dict[str, object]:
        return {
            "name": self.name,
            "text": localize_game_text(self.text, language),
            "original_text": self.original_text,
            "localized_text": localize_game_text(self.localized_text, language),
            "localized_text_origin": self.localized_text_origin,
            "translated_text": localize_game_text(self.translated_text, language),
            "text_label": self.text_label,
            "asset": _asset_summary(self.asset),
            "animation": self.animation.as_dict() if self.animation else None,
            "weight": self.weight,
            "palette": self.palette,
        }


@dataclass(frozen=True, slots=True)
class MediaAssociation:
    kind: str
    slot: str
    event: str
    source: str
    samples: tuple[MediaSample, ...]
    role: str | None = None
    aliases: tuple[str, ...] = ()
    selection: str | None = None
    selected_sample: str | None = None
    selection_value: int | None = None
    rule_field: str | None = None

    def as_dict(self, language: GameLanguage = DEFAULT_GAME_LANGUAGE) -> dict[str, object]:
        samples = (
            tuple(_sound_description_sample(sample) for sample in self.samples)
            if self.kind == "sound"
            else self.samples
        )
        return {
            "kind": self.kind,
            "slot": self.slot,
            "event": self.event,
            "source": self.source,
            "role": self.role,
            "aliases": list(self.aliases),
            "selection": self.selection,
            "selected_sample": self.selected_sample,
            "selection_value": self.selection_value,
            "rule_field": self.rule_field,
            "samples": [sample.as_dict(language) for sample in samples],
        }


@dataclass(frozen=True, slots=True)
class GameEntity:
    id: str
    kind: str
    usage: str
    display_name: str
    internal_name: str
    ui_name: str | None
    ui_name_resolved: bool
    image: str
    voxel: bool
    countries: tuple[str, ...]
    sides: tuple[str, ...]
    affiliation: dict[str, Any] | None
    rules: dict[str, str]
    art: dict[str, str]
    components: tuple[EntityComponent, ...]
    dependencies: tuple[EntityDependency, ...]
    media: tuple[MediaAssociation, ...]

    @property
    def renderable(self) -> bool:
        return self.component("body") is not None

    def component(self, role: str) -> dict[str, Any] | None:
        return next(
            (component.asset for component in self.components if component.role == role),
            None,
        )

    def summary(self, language: GameLanguage = DEFAULT_GAME_LANGUAGE) -> dict[str, object]:
        body = self.component("body")
        turret = self.component("turret")
        body_is_voxel = bool(body and body["format"] == "vxl")
        turret_is_voxel = bool(turret and turret.get("format") == "vxl")
        facing_format = (
            "vxl"
            if body_is_voxel or turret_is_voxel
            else "shp"
            if body
            else None
        )
        display_name = localize_game_text(self.display_name, language) or self.display_name
        affiliation = None
        if self.affiliation is not None:
            affiliation = {
                "kind": self.affiliation["kind"],
                "id": self.affiliation["id"],
                "display_name": localize_game_text(str(self.affiliation["display_name"]), language),
                "icon": _asset_summary(self.affiliation.get("icon")),
            }
        return {
            "id": self.id,
            "kind": self.kind,
            "usage": self.usage,
            "display_name": display_name,
            "internal_name": self.internal_name,
            "ui_name": self.ui_name,
            "search_aliases": pinyin_search_aliases(display_name),
            "image": self.image,
            "voxel": self.voxel,
            "countries": list(self.countries),
            "sides": list(self.sides),
            "affiliation": affiliation,
            "renderable": self.renderable,
            "body_status": (
                "available"
                if self.renderable
                else "not_defined"
                if _is_null_image(self.image)
                else "missing"
            ),
            "component_count": sum(component.asset is not None for component in self.components),
            "body_format": body["format"] if body else None,
            "facing_format": facing_format,
            "media_kinds": sorted({association.kind for association in self.media}),
            "media_count": len(self.media),
            "cost": self.rules.get("cost"),
            "strength": self.rules.get("strength"),
            "tech_level": self.rules.get("tech_level"),
            "ai_base_planning_side": self.rules.get("ai_base_planning_side"),
            "naval": _yes(self.rules.get("naval")),
            "considered_aircraft": _yes(self.rules.get("considered_aircraft")),
            "owner": self.rules.get("owner"),
            "primary": self.rules.get("primary"),
        }

    def as_dict(self, language: GameLanguage = DEFAULT_GAME_LANGUAGE) -> dict[str, object]:
        return {
            **self.summary(language),
            "rules": self.rules,
            "art": self.art,
            "components": [component.as_dict() for component in self.components],
            "dependencies": [dependency.as_dict() for dependency in self.dependencies],
            "media": [association.as_dict(language) for association in self.media],
        }


@dataclass(frozen=True, slots=True)
class SemanticCatalog:
    source_id: str
    entities: tuple[GameEntity, ...]
    inputs: dict[str, tuple[dict[str, object], ...]]
    warnings: tuple[str, ...]
    audio_events: dict[str, tuple[MediaSample, ...]]
    eva_events: tuple[MediaAssociation, ...]
    countries: tuple[dict[str, str], ...]
    media_items: tuple[dict[str, object], ...]

    def get(self, entity_id: str) -> GameEntity:
        folded = entity_id.casefold()
        entity = next((item for item in self.entities if item.id.casefold() == folded), None)
        if entity is None:
            raise AssetNotFoundError("单位不存在")
        return entity


def serialize_semantic_catalog(catalog: SemanticCatalog) -> dict[str, object]:
    return {
        "schema": 1,
        "kind": "ra2-explorer-semantic-catalog",
        "catalog": asdict(catalog),
    }


def deserialize_semantic_catalog(payload: dict[str, object]) -> SemanticCatalog:
    if payload.get("schema") != 1 or payload.get("kind") != "ra2-explorer-semantic-catalog":
        raise ValueError("unsupported semantic catalog snapshot")
    raw_catalog = _snapshot_mapping(payload.get("catalog"))

    def playback(value: object) -> AnimationPlayback | None:
        if value is None:
            return None
        values = _snapshot_mapping(value)
        return AnimationPlayback(
            start_frame=int(values.get("start_frame") or 0),
            frame_count=_optional_int(values.get("frame_count")),
            facing_step=int(values.get("facing_step") or 0),
            frame_step=max(1, int(values.get("frame_step") or 1)),
            rate_ms=_optional_int(values.get("rate_ms")),
            loop_start=_optional_int(values.get("loop_start")),
            loop_end=_optional_int(values.get("loop_end")),
            loop_count=_optional_int(values.get("loop_count")),
            direction=_optional_text(values.get("direction")),
            shadow=bool(values.get("shadow")),
            reverse=bool(values.get("reverse")),
        )

    def sample(value: object) -> MediaSample:
        values = _snapshot_mapping(value)
        asset = values.get("asset")
        return MediaSample(
            name=str(values["name"]),
            text=_optional_text(values.get("text")),
            asset=dict(_snapshot_mapping(asset)) if asset is not None else None,
            original_text=_optional_text(values.get("original_text")),
            localized_text=_optional_text(values.get("localized_text")),
            text_label=_optional_text(values.get("text_label")),
            animation=playback(values.get("animation")),
            weight=int(values.get("weight") or 1),
            palette=_optional_text(values.get("palette")),
            localized_text_origin=_optional_text(values.get("localized_text_origin")),
            translated_text=_optional_text(values.get("translated_text")),
        )

    def association(value: object) -> MediaAssociation:
        values = _snapshot_mapping(value)
        return MediaAssociation(
            kind=str(values["kind"]),
            slot=str(values["slot"]),
            event=str(values["event"]),
            source=str(values["source"]),
            samples=tuple(sample(item) for item in _snapshot_sequence(values.get("samples"))),
            role=_optional_text(values.get("role")),
            aliases=tuple(str(item) for item in _snapshot_sequence(values.get("aliases"))),
            selection=_optional_text(values.get("selection")),
            selected_sample=_optional_text(values.get("selected_sample")),
            selection_value=_optional_int(values.get("selection_value")),
            rule_field=_optional_text(values.get("rule_field")),
        )

    def entity(value: object) -> GameEntity:
        values = _snapshot_mapping(value)
        components = []
        for item in _snapshot_sequence(values.get("components")):
            component = _snapshot_mapping(item)
            asset = component.get("asset")
            components.append(
                EntityComponent(
                    str(component["role"]),
                    str(component["expected_name"]),
                    dict(_snapshot_mapping(asset)) if asset is not None else None,
                )
            )
        dependencies = []
        for item in _snapshot_sequence(values.get("dependencies")):
            dependency = _snapshot_mapping(item)
            dependencies.append(
                EntityDependency(
                    str(dependency["id"]),
                    str(dependency["kind"]),
                    str(dependency["slot"]),
                    _optional_text(dependency.get("parent")),
                    bool(dependency.get("resolved")),
                    {
                        str(key): str(value)
                        for key, value in _snapshot_mapping(dependency.get("properties")).items()
                    },
                )
            )
        affiliation = values.get("affiliation")
        return GameEntity(
            id=str(values["id"]),
            kind=str(values["kind"]),
            usage=str(values["usage"]),
            display_name=str(values["display_name"]),
            internal_name=str(values["internal_name"]),
            ui_name=_optional_text(values.get("ui_name")),
            ui_name_resolved=bool(values.get("ui_name_resolved")),
            image=str(values["image"]),
            voxel=bool(values.get("voxel")),
            countries=tuple(str(item) for item in _snapshot_sequence(values.get("countries"))),
            sides=tuple(str(item) for item in _snapshot_sequence(values.get("sides"))),
            affiliation=(dict(_snapshot_mapping(affiliation)) if affiliation is not None else None),
            rules={
                str(key): str(value)
                for key, value in _snapshot_mapping(values.get("rules")).items()
            },
            art={
                str(key): str(value) for key, value in _snapshot_mapping(values.get("art")).items()
            },
            components=tuple(components),
            dependencies=tuple(dependencies),
            media=tuple(association(item) for item in _snapshot_sequence(values.get("media"))),
        )

    audio_events = {
        str(key): tuple(sample(item) for item in _snapshot_sequence(value))
        for key, value in _snapshot_mapping(raw_catalog.get("audio_events")).items()
    }
    inputs = {
        str(key): tuple(dict(_snapshot_mapping(item)) for item in _snapshot_sequence(value))
        for key, value in _snapshot_mapping(raw_catalog.get("inputs")).items()
    }
    return SemanticCatalog(
        source_id=str(raw_catalog["source_id"]),
        entities=tuple(entity(item) for item in _snapshot_sequence(raw_catalog.get("entities"))),
        inputs=inputs,
        warnings=tuple(str(item) for item in _snapshot_sequence(raw_catalog.get("warnings"))),
        audio_events=audio_events,
        eva_events=tuple(
            association(item) for item in _snapshot_sequence(raw_catalog.get("eva_events"))
        ),
        countries=tuple(
            {str(key): str(value) for key, value in _snapshot_mapping(item).items()}
            for item in _snapshot_sequence(raw_catalog.get("countries"))
        ),
        media_items=tuple(
            dict(_snapshot_mapping(item))
            for item in _snapshot_sequence(raw_catalog.get("media_items"))
        ),
    )


def _snapshot_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid semantic catalog mapping")
    return value


def _snapshot_sequence(value: object) -> list[object] | tuple[object, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError("invalid semantic catalog sequence")
    return value


def _optional_text(value: object) -> str | None:
    return None if value is None else str(value)


def _optional_int(value: object) -> int | None:
    return None if value is None else int(value)


class SemanticLibrary:
    def __init__(
        self,
        database: Database,
        reader: AssetReader,
        voice_transcripts: dict[str, dict[str, str]] | None = None,
    ):
        self.database = database
        self.reader = reader
        self.voice_transcripts = voice_transcripts or {}
        self._voice_transcript_revision = hashlib.sha256(
            json.dumps(
                self.voice_transcripts,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()[:16]
        self._cache: dict[str, tuple[tuple[object, ...], SemanticCatalog]] = {}
        self._parsed_cache: OrderedDict[str, object] = OrderedDict()
        self._shp_frame_cache: dict[str, tuple[int, ...]] = {}
        self._lock = threading.RLock()

    def catalog(self, source_id: str) -> SemanticCatalog:
        source = self.database.get_source(source_id)
        token = (
            source.get("scanned_at"),
            source.get("asset_count"),
            source.get("state"),
            self._voice_transcript_revision,
        )
        with self._lock:
            cached = self._cache.get(source_id)
            if cached and cached[0] == token:
                return cached[1]
            self._parsed_cache.clear()
            self._shp_frame_cache.clear()
            catalog = self._load_catalog_snapshot(source)
            if catalog is None:
                catalog = self._build(source_id)
                self._store_catalog_snapshot(source, catalog)
            self._cache[source_id] = (token, catalog)
            return catalog

    def catalog_snapshot_path(self, source_id: str):
        """Return the exact persisted snapshot selected by this library instance."""
        source = self.database.get_source(source_id)
        self.catalog(source_id)
        return self._catalog_snapshot_path(source)

    def _catalog_snapshot_path(self, source: dict[str, object]):
        if self.reader.derived is None:
            return None
        return self.reader.derived.artifact_path(
            "metadata",
            source_id=source["id"],
            revision=source.get("scanned_at") or source["created_at"],
            identity=(
                *SEMANTIC_CATALOG_CACHE_IDENTITY,
                self._voice_transcript_revision,
            ),
            extension="json",
        )

    def _load_catalog_snapshot(self, source: dict[str, object]) -> SemanticCatalog | None:
        path = self._catalog_snapshot_path(source)
        if path is None:
            return None
        payload = self.reader.derived.read_json(path)
        if payload is None:
            return None
        try:
            catalog = deserialize_semantic_catalog(payload)
        except (KeyError, TypeError, ValueError):
            return None
        return catalog if catalog.source_id == str(source["id"]) else None

    def _store_catalog_snapshot(
        self,
        source: dict[str, object],
        catalog: SemanticCatalog,
    ) -> None:
        path = self._catalog_snapshot_path(source)
        if path is not None:
            self.reader.derived.write_json(path, serialize_semantic_catalog(catalog))

    def list_entities(
        self,
        source_id: str,
        *,
        query: str | None = None,
        kind: str | None = None,
        kinds: tuple[str, ...] = (),
        usage: str | None = None,
        usages: tuple[str, ...] = (),
        side: str | None = None,
        renderable: bool | None = None,
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, object]:
        catalog = self.catalog(source_id)
        entities = list(catalog.entities)
        if renderable is not None:
            entities = [entity for entity in entities if entity.renderable is renderable]
        counts = Counter(entity.kind for entity in entities)
        if kinds:
            selected_kinds = set(kinds)
            entities = [entity for entity in entities if entity.kind in selected_kinds]
        elif kind:
            entities = [entity for entity in entities if entity.kind == kind]
        if query:
            entities = [
                entity
                for entity in entities
                if localized_mixed_search_match(
                    query,
                    _entity_search_text(entity),
                    *_entity_fuzzy_search_values(entity),
                    *_entity_pinyin_search_values(entity),
                )
            ]
        usage_counts = Counter(entity.usage for entity in entities)
        if usages:
            selected_usages = set(usages)
            entities = [entity for entity in entities if entity.usage in selected_usages]
        elif usage:
            entities = [entity for entity in entities if entity.usage == usage]
        country_counts = Counter(country for entity in entities for country in entity.countries)
        side_counts = Counter(
            faction_id for entity in entities for faction_id in _entity_faction_ids(entity)
        )
        if side:
            selected_side = side.casefold()
            entities = [
                entity
                for entity in entities
                if any(
                    faction_id.casefold() == selected_side
                    for faction_id in _entity_faction_ids(entity)
                )
            ]
        total = len(entities)
        selected = entities[offset : offset + limit]
        return {
            "items": [entity.summary(language) for entity in selected],
            "total": total,
            "kinds": [
                {"kind": entity_kind, "count": counts.get(entity_kind, 0)}
                for entity_kind in ENTITY_KINDS
            ],
            "usages": [
                {"usage": entity_usage, "count": usage_counts.get(entity_usage, 0)}
                for entity_usage in ENTITY_USAGES
                if usage_counts.get(entity_usage, 0)
            ],
            "countries": [
                {
                    **country,
                    "display_name": localize_game_text(country["display_name"], language),
                    "count": country_counts.get(country["id"], 0),
                }
                for country in catalog.countries
                if country_counts.get(country["id"], 0)
            ],
            "sides": [
                {"id": side, "count": count} for side, count in sorted(side_counts.items()) if side
            ],
            "warnings": list(catalog.warnings),
        }

    def list_media(
        self,
        source_id: str,
        *,
        query: str | None = None,
        kind: str | None = None,
        group: str | None = None,
        event_type: str | None = None,
        sort: str = "name_asc",
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
        limit: int = 500,
        offset: int = 0,
    ) -> dict[str, object]:
        catalog = self.catalog(source_id)
        all_items = list(catalog.media_items)
        kind_counts = Counter(str(item["kind"]) for item in all_items)
        group_counts = Counter(
            str(media_group)
            for item in all_items
            for media_group in item["groups"]  # type: ignore[union-attr]
        )
        items = all_items
        if kind:
            items = [item for item in items if item["kind"] == kind]
        if group:
            items = [item for item in items if group in item["groups"]]  # type: ignore[operator]
        if query:
            items = [
                item
                for item in items
                if localized_mixed_search_match(
                    query,
                    _media_search_text(item),
                    *_media_pinyin_search_values(item),
                )
            ]
        event_type_counts = Counter(
            str(slot)
            for item in items
            for slot in item["slots"]  # type: ignore[union-attr]
        )
        if event_type:
            items = [item for item in items if event_type in item["slots"]]  # type: ignore[operator]
        country_counts = Counter(
            str(country)
            for item in items
            for country in item["countries"]  # type: ignore[union-attr]
        )
        if sort == "description_asc":
            items.sort(
                key=lambda item: (
                    item.get("description") is None,
                    str(item.get("description") or "").casefold(),
                    str(item["asset"]["display_name"]).casefold(),  # type: ignore[index]
                )
            )
        else:
            items.sort(
                key=lambda item: str(item["asset"]["display_name"]).casefold(),  # type: ignore[index]
                reverse=sort == "name_desc",
            )
        total = len(items)
        return {
            "items": [
                _localized_media_item(item, language) for item in items[offset : offset + limit]
            ],
            "total": total,
            "kinds": [
                {"kind": media_kind, "count": kind_counts.get(media_kind, 0)}
                for media_kind in ("voice", "sound", "unknown")
            ],
            "groups": [
                {"group": media_group, "count": count}
                for media_group, count in sorted(group_counts.items())
            ],
            "event_types": [
                {"event_type": slot, "count": count}
                for slot, count in sorted(event_type_counts.items())
            ],
            "countries": [
                {
                    **country,
                    "display_name": localize_game_text(country["display_name"], language),
                    "count": country_counts.get(country["id"], 0),
                }
                for country in catalog.countries
                if country_counts.get(country["id"], 0)
            ],
        }

    def get_entity(
        self,
        source_id: str,
        entity_id: str,
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
    ) -> dict[str, object]:
        entity = self.catalog(source_id).get(entity_id)
        return {
            **entity.as_dict(language),
            "preview": self._preview_info(source_id, entity),
        }

    def asset_associations(
        self,
        source_id: str,
        asset_id: str,
        language: GameLanguage = DEFAULT_GAME_LANGUAGE,
    ) -> dict[str, object]:
        catalog = self.catalog(source_id)
        requested_asset = self.database.get_asset(asset_id)
        items: list[dict[str, object]] = []
        seen: set[tuple[str, ...]] = set()
        entities_by_id = {entity.id.casefold(): entity for entity in catalog.entities}

        def append(item: dict[str, object], key: tuple[str, ...]) -> None:
            if key not in seen:
                seen.add(key)
                items.append(item)

        for entity in catalog.entities:
            for component in entity.components:
                if component.asset and component.asset["id"] == asset_id:
                    append(
                        {
                            "scope": "entity",
                            "kind": "component",
                            "slot": component.role,
                            "event": component.expected_name,
                            "entity": entity.summary(language),
                            "text": None,
                            "original_text": None,
                            "localized_text": None,
                            "localized_text_origin": None,
                            "translated_text": None,
                        },
                        ("entity", entity.id, "component", component.role),
                    )
            for association in entity.media:
                for sample in association.samples:
                    if sample.asset and sample.asset["id"] == asset_id:
                        presented = (
                            _sound_description_sample(sample)
                            if association.kind == "sound"
                            else sample
                        )
                        append(
                            {
                                "scope": "entity",
                                "kind": association.kind,
                                "slot": association.slot,
                                "event": association.event,
                                "entity": entity.summary(language),
                                "text": localize_game_text(presented.text, language),
                                "original_text": presented.original_text,
                                "localized_text": localize_game_text(
                                    presented.localized_text, language
                                ),
                                "localized_text_origin": presented.localized_text_origin,
                                "translated_text": localize_game_text(
                                    presented.translated_text, language
                                ),
                            },
                            (
                                "entity",
                                entity.id,
                                association.kind,
                                association.slot,
                                association.event.casefold(),
                            ),
                        )

        for association in catalog.eva_events:
            event_entity = _eva_event_entity(association.event, entities_by_id)
            semantic_slot = _unit_intel_advisor_slot(association.event)
            display_slot = semantic_slot or association.slot
            for sample in association.samples:
                if sample.asset and sample.asset["id"] == asset_id:
                    presented = (
                        _sound_description_sample(sample) if association.kind == "sound" else sample
                    )
                    append(
                        {
                            "scope": "event",
                            "kind": association.kind,
                            "slot": display_slot,
                            "event": association.event,
                            "entity": (
                                event_entity.summary(language) if event_entity is not None else None
                            ),
                            "text": localize_game_text(presented.text, language),
                            "original_text": presented.original_text,
                            "localized_text": localize_game_text(
                                presented.localized_text, language
                            ),
                            "localized_text_origin": presented.localized_text_origin,
                            "translated_text": localize_game_text(
                                presented.translated_text, language
                            ),
                        },
                        (
                            "event",
                            display_slot,
                            association.event.casefold(),
                            sample.name.casefold(),
                        ),
                    )

        for event, samples in catalog.audio_events.items():
            for sample in samples:
                if sample.asset and sample.asset["id"] == asset_id:
                    media_kind = _media_kind_for_asset(catalog.media_items, sample.asset)
                    presented = (
                        _sound_description_sample(sample) if media_kind == "sound" else sample
                    )
                    append(
                        {
                            "scope": "event",
                            "kind": media_kind,
                            "slot": "sound_event",
                            "event": event,
                            "entity": None,
                            "text": localize_game_text(presented.text, language),
                            "original_text": presented.original_text,
                            "localized_text": localize_game_text(
                                presented.localized_text, language
                            ),
                            "localized_text_origin": presented.localized_text_origin,
                            "translated_text": localize_game_text(
                                presented.translated_text, language
                            ),
                        },
                        (media_kind, event.casefold(), sample.name.casefold()),
                    )
        requested_name = str(requested_asset["display_name"]).casefold()
        media_item = next(
            (
                item
                for item in catalog.media_items
                if str(item["asset"]["id"]) == asset_id  # type: ignore[index]
            ),
            None,
        )
        if media_item is None:
            media_item = next(
                (
                    item
                    for item in catalog.media_items
                    if str(item["asset"]["display_name"]).casefold()  # type: ignore[index]
                    == requested_name
                ),
                None,
            )
        return {
            "items": items[:100],
            "total": len(items),
            "texts": [
                localize_game_text(str(value), language)
                for value in (media_item or {}).get("texts", [])  # type: ignore[union-attr]
            ],
            "original_texts": [
                str(value)
                for value in (media_item or {}).get("original_texts", [])  # type: ignore[union-attr]
            ],
            "localized_texts": [
                localize_game_text(str(value), language)
                for value in (media_item or {}).get("localized_texts", [])  # type: ignore[union-attr]
            ],
            "localized_text_origins": sorted(
                str(value)
                for value in (media_item or {}).get("localized_text_origins", [])  # type: ignore[union-attr]
            ),
            "translated_texts": [
                localize_game_text(str(value), language)
                for value in (media_item or {}).get("translated_texts", [])  # type: ignore[union-attr]
            ],
        }

    def diagnostics(self, source_id: str, *, limit: int = 20) -> dict[str, object]:
        catalog = self.catalog(source_id)
        entities = catalog.entities
        missing_roles = Counter(
            component.role
            for entity in entities
            for component in entity.components
            if component.asset is None
        )
        dependency_count = sum(len(entity.dependencies) for entity in entities)
        unresolved_dependencies = [
            (entity, dependency)
            for entity in entities
            for dependency in entity.dependencies
            if not dependency.resolved
        ]
        renderable_count = sum(entity.renderable for entity in entities)
        localized_count = sum(entity.ui_name_resolved for entity in entities)
        resolved_components = sum(
            component.asset is not None for entity in entities for component in entity.components
        )
        component_count = sum(len(entity.components) for entity in entities)
        return {
            "status": "ready" if entities else "empty",
            "entity_count": len(entities),
            "renderable_count": renderable_count,
            "renderable_percent": _percentage(renderable_count, len(entities)),
            "localized_count": localized_count,
            "localized_percent": _percentage(localized_count, len(entities)),
            "component_count": component_count,
            "resolved_component_count": resolved_components,
            "component_percent": _percentage(resolved_components, component_count),
            "dependency_count": dependency_count,
            "unresolved_dependency_count": len(unresolved_dependencies),
            "kinds": [
                {
                    "kind": kind,
                    "count": sum(entity.kind == kind for entity in entities),
                    "renderable_count": sum(
                        entity.kind == kind and entity.renderable for entity in entities
                    ),
                }
                for kind in ENTITY_KINDS
            ],
            "missing_components": [
                {"role": role, "count": count} for role, count in missing_roles.most_common()
            ],
            "samples": {
                "missing_body": [
                    {"id": entity.id, "display_name": entity.display_name}
                    for entity in entities
                    if not entity.renderable
                ][:limit],
                "unresolved_ui_name": [
                    {"id": entity.id, "ui_name": entity.ui_name}
                    for entity in entities
                    if entity.ui_name and not entity.ui_name_resolved
                ][:limit],
                "unresolved_dependencies": [
                    {
                        "entity_id": entity.id,
                        "id": dependency.id,
                        "kind": dependency.kind,
                        "slot": dependency.slot,
                    }
                    for entity, dependency in unresolved_dependencies[:limit]
                ],
            },
            "inputs": catalog.inputs,
            "warnings": list(catalog.warnings),
        }

    def render(
        self,
        source_id: str,
        entity_id: str,
        *,
        palette: Palette | None,
        frame: int,
        facing: int,
        player_color: str | None,
        scale: int,
    ) -> tuple[GameEntity, Image.Image, tuple[int, int, int, int] | None]:
        entity = self.catalog(source_id).get(entity_id)
        body = entity.component("body")
        if body is None:
            raise InvalidFormatError("该单位没有可渲染的主体资产")
        if body["format"] == "vxl":
            parts = self._voxel_parts(entity)
            return (
                entity,
                render_vxl_composite(
                    parts,
                    palette=palette,
                    frame=frame,
                    facing=facing,
                    player_color=player_color,
                    vpl=self.voxel_lighting(source_id),
                    scale=scale,
                ),
                None,
            )
        sprite = self._parse_asset(body, parse_shp)
        if not sprite.frames:
            raise InvalidFormatError("单位 SHP 没有可渲染帧")
        visible_frames = self._entity_shp_frames(entity, body, sprite)
        if not visible_frames and entity.kind != "building":
            raise InvalidFormatError("单位 SHP 的所有帧均为空")
        active_palette = palette
        if player_color:
            active_palette = (palette or grayscale_palette()).with_player_color(player_color)
        sequence_frame = _body_sequence_preview_frame(entity, frame, facing)
        source_frame = (
            sequence_frame
            if sequence_frame is not None and sequence_frame < len(sprite.frames)
            else visible_frames[frame % len(visible_frames)]
            if visible_frames
            else 0
        )
        focus_bounds = sprite.content_bounds(source_frame)
        image = sprite.render(
            source_frame,
            active_palette,
            scale=scale,
            shadow_frame=sprite.paired_shadow_frame(source_frame),
        )
        scaled_focus_bounds = (
            (
                focus_bounds[0] * scale,
                focus_bounds[1] * scale,
                (focus_bounds[0] + focus_bounds[2]) * scale,
                (focus_bounds[1] + focus_bounds[3]) * scale,
            )
            if focus_bounds is not None
            else None
        )
        bib = entity.component("bib") if entity.kind == "building" else None
        if bib is not None:
            bib_sprite = self._parse_asset(bib, parse_shp)
            if bib_sprite.frames:
                bib_frame = next(
                    (item.index for item in bib_sprite.frames if not item.empty),
                    0,
                )
                bib_image = bib_sprite.render(
                    bib_frame,
                    active_palette,
                    scale=scale,
                    shadow_frame=bib_sprite.paired_shadow_frame(bib_frame),
                )
                width = max(image.width, bib_image.width)
                height = max(image.height, bib_image.height)
                combined = Image.new("RGBA", (width, height), (0, 0, 0, 0))
                combined.alpha_composite(
                    bib_image,
                    ((width - bib_image.width) // 2, (height - bib_image.height) // 2),
                )
                combined.alpha_composite(
                    image,
                    ((width - image.width) // 2, (height - image.height) // 2),
                )
                image = combined
                scaled_focus_bounds = image.getchannel("A").getbbox()
        return (
            entity,
            image,
            scaled_focus_bounds,
        )

    def render_building_voxel_turret(
        self,
        source_id: str,
        entity: GameEntity,
        *,
        palette: Palette | None,
        frame: int,
        facing: int,
        player_color: str | None,
        scale: int,
    ) -> tuple[Image.Image, tuple[int, int]] | None:
        body = entity.component("body")
        if entity.kind != "building" or body is None or body["format"] != "shp":
            return None
        parts = self._voxel_parts(
            entity,
            roles=(("turret", "turret_hva"), ("barrel", "barrel_hva")),
        )
        if not parts:
            return None
        raster_scale = max(1, math.ceil(scale / 4))
        image, anchor = render_vxl_composite_with_anchor(
            parts,
            palette=palette,
            frame=frame,
            facing=facing,
            player_color=player_color,
            vpl=self.voxel_lighting(source_id),
            scale=raster_scale,
        )
        resize_factor = scale / (4 * raster_scale)
        if resize_factor != 1:
            image = image.resize(
                (
                    max(1, round(image.width * resize_factor)),
                    max(1, round(image.height * resize_factor)),
                ),
                Image.Resampling.NEAREST,
            )
            anchor = (
                round(anchor[0] * resize_factor),
                round(anchor[1] * resize_factor),
            )
        return image, anchor

    def model_scene(
        self,
        source_id: str,
        entity_id: str,
        *,
        palette: Palette | None,
        frame: int,
        player_color: str | None,
    ) -> tuple[GameEntity, VxlScene]:
        entity = self.catalog(source_id).get(entity_id)
        body = entity.component("body")
        if body is None or body["format"] != "vxl":
            raise InvalidFormatError("该单位不是可交互的 VXL 模型")
        return entity, build_vxl_scene(
            self._voxel_parts(entity),
            palette=palette,
            frame=frame,
            player_color=player_color,
            vpl=self.voxel_lighting(source_id),
        )

    def voxel_lighting(self, source_id: str) -> VplFile | None:
        candidates = self.database.assets_named(source_id, ("voxels.vpl",))
        if not candidates:
            return None

        def priority(asset: dict[str, Any]) -> tuple[int, int, str]:
            path = str(asset.get("virtual_path") or "").casefold()
            return (
                1 if "ra2md.mix" in path else 0,
                1 if "localmd.mix" in path else 0,
                path,
            )

        return self._parse_asset(max(candidates, key=priority), parse_vpl)

    def _voxel_parts(
        self,
        entity: GameEntity,
        *,
        roles: tuple[tuple[str, str], ...] = (
            ("body", "body_hva"),
            ("turret", "turret_hva"),
            ("barrel", "barrel_hva"),
        ),
    ) -> tuple[VxlRenderPart, ...]:
        parts = []
        for role, animation_role in roles:
            asset = entity.component(role)
            if not asset:
                continue
            model = self._parse_asset(asset, parse_vxl)
            animation_asset = entity.component(animation_role)
            animation = None
            if animation_asset:
                animation = self._parse_asset(animation_asset, parse_hva)
            parts.append(VxlRenderPart(model, animation))
        return tuple(parts)

    def _preview_info(
        self,
        source_id: str,
        entity: GameEntity,
    ) -> dict[str, object]:
        source = self.database.get_source(source_id)
        path = (
            self.reader.derived.artifact_path(
                "metadata",
                source_id=source["id"],
                revision=source.get("scanned_at") or source["created_at"],
                identity=(entity.id, "entity-preview-info-v4"),
                extension="json",
            )
            if self.reader.derived is not None
            else None
        )
        cached = self.reader.derived.read_json(path) if path is not None else None
        if cached is not None:
            return cached
        body = entity.component("body")
        voxel_turret = entity.component("turret")
        has_voxel_turret = bool(voxel_turret and voxel_turret.get("format") == "vxl")
        body_is_voxel = bool(body and body["format"] == "vxl")
        sequence_facings = any(
            sample.animation and sample.animation.facing_step > 0
            for association in entity.media
            if association.slot == "body_sequence"
            for sample in association.samples
        )
        facing_count = (
            8
            if entity.voxel or has_voxel_turret or sequence_facings
            else _positive_int(entity.art.get("facings"), 1)
        )
        base: dict[str, object] = {
            "format": str(body["format"]) if body else None,
            "facing_format": (
                "vxl"
                if body_is_voxel or has_voxel_turret
                else "shp"
                if body
                else None
            ),
            "frame_count": 0 if body is None else 1,
            "facing_count": facing_count,
            "supports_facing": bool(
                body and (body["format"] == "vxl" or has_voxel_turret or sequence_facings)
            ),
            # Every VXL carries an explicit remap range. Some retail ART sections omit
            # Remapable even though the renderer can apply that range (for example DDBX).
            "supports_player_color": (
                entity.voxel or has_voxel_turret or _yes(entity.art.get("remapable"))
            ),
        }
        if body is None:
            if path is not None:
                self.reader.derived.write_json(path, base)
            return base
        warnings = []
        try:
            if body["format"] == "vxl":
                model = self._parse_asset(body, parse_vxl)
                frame_counts = []
                for role in ("body_hva", "turret_hva", "barrel_hva"):
                    asset = entity.component(role)
                    if asset:
                        animation = self._parse_asset(asset, parse_hva)
                        frame_counts.append(animation.frame_count)
                base.update(
                    {
                        "frame_count": max((1, *frame_counts)),
                        "limb_count": sum(
                            len(self._parse_asset(asset, parse_vxl).limbs)
                            for role in ("body", "turret", "barrel")
                            if (asset := entity.component(role))
                        ),
                        "voxel_count": sum(
                            self._parse_asset(asset, parse_vxl).voxel_count
                            for role in ("body", "turret", "barrel")
                            if (asset := entity.component(role))
                        ),
                        "remap_range": [model.remap_start, model.remap_end],
                    }
                )
            else:
                sprite = self._parse_asset(body, parse_shp)
                visible_frames = self._entity_shp_frames(entity, body, sprite)
                base.update(
                    {
                        "frame_count": len(visible_frames),
                        "source_frame_count": len(sprite.frames),
                        "frame_indices": visible_frames,
                        "width": sprite.width,
                        "height": sprite.height,
                    }
                )
        except (OSError, Ra2ExplorerError, ValueError) as error:
            warnings.append(str(error))
        if warnings:
            base["warnings"] = warnings
        if path is not None:
            self.reader.derived.write_json(path, base)
        return base

    def _visible_shp_frames(
        self,
        asset: dict[str, Any],
        sprite: ShpFile,
    ) -> tuple[int, ...]:
        asset_id = str(asset["id"])
        with self._lock:
            cached = self._shp_frame_cache.get(asset_id)
            if cached is not None:
                return cached
        visible = tuple(
            frame.index
            for frame in sprite.frames
            if not frame.empty and any(sprite.pixels(frame.index))
        )
        with self._lock:
            self._shp_frame_cache[asset_id] = visible
        return visible

    def _entity_shp_frames(
        self,
        entity: GameEntity,
        asset: dict[str, Any],
        sprite: ShpFile,
    ) -> tuple[int, ...]:
        visible = self._visible_shp_frames(asset, sprite)
        return _shp_content_frames(sprite, visible)

    def _parse_asset(
        self,
        asset: dict[str, Any],
        parser: Callable[[bytes], Any],
    ) -> Any:
        asset_id = str(asset["id"])
        with self._lock:
            cached = self._parsed_cache.get(asset_id)
            if cached is not None:
                self._parsed_cache.move_to_end(asset_id)
                return cached
        _, data = self.reader.read(asset_id)
        parsed = parser(data)
        with self._lock:
            self._parsed_cache[asset_id] = parsed
            self._parsed_cache.move_to_end(asset_id)
            while len(self._parsed_cache) > 24:
                self._parsed_cache.popitem(last=False)
        return parsed

    def _build(self, source_id: str) -> SemanticCatalog:
        assets = self.database.assets_for_formats(
            source_id,
            (
                "ini",
                "csf",
                "vxl",
                "hva",
                "shp",
                "bag_audio",
                "wav",
                "aud",
                "video",
                "binary",
                "pcx",
            ),
        )
        asset_index = _index_assets(assets)

        warnings = []
        rules_assets = _edition_ini_inputs(
            asset_index.by_name,
            "rules.ini",
            "rulesmd.ini",
        )
        art_assets = _named_inputs(asset_index.by_name, ("art.ini", "artmd.ini"))
        sound_assets = _named_inputs(asset_index.by_name, ("sound.ini", "soundmd.ini"))
        eva_assets = _named_inputs(asset_index.by_name, ("eva.ini", "evamd.ini"))
        csf_assets = sorted(
            (asset for asset in assets if asset["format"] == "csf"),
            key=_config_precedence,
        )
        rules = _merge_ini_inputs(self.reader, rules_assets, warnings)
        art = _merge_ini_inputs(self.reader, art_assets, warnings)
        sounds = _merge_ini_inputs(self.reader, sound_assets, warnings)
        eva = _merge_ini_inputs(self.reader, eva_assets, warnings)
        strings, voice_strings = _merge_csf_inputs(
            self.reader,
            csf_assets,
            warnings,
            self.voice_transcripts,
        )
        audio_events = _build_audio_events(sounds, asset_index, voice_strings)
        country_definitions = _build_country_definitions(rules, strings)
        country_lookup = {country["id"].casefold(): country for country in country_definitions}

        entities = []
        seen = set()
        for kind, type_section in _TYPE_SECTIONS.items():
            for entity_id in _type_values(rules.get(type_section.casefold(), {})):
                folded = entity_id.casefold()
                if folded in seen:
                    continue
                seen.add(folded)
                rule_values = rules.get(folded, {})
                art_key = rule_values.get("image") or entity_id
                art_values = art.get(art_key.casefold(), {})
                # A TechnoType's body is selected by the Rules Image key.  An
                # Image value inside that ART section is meaningful to several
                # animation definitions, but retail ARTMD also uses it on
                # concrete units such as BFRT and CAML even though their own
                # BFRT.VXL/CAML.SHP bodies exist.  Following it here therefore
                # replaces those units with SREF/JOSH instead of resolving the
                # body named by the TechnoType.
                image = art_key
                ui_name = rule_values.get("uiname")
                internal_name = rule_values.get("name") or entity_id
                localized_name = strings.get(ui_name.casefold()) if ui_name else None
                display_name = localized_name or internal_name
                voxel = _yes(art_values.get("voxel"))
                components, resolved_voxel = _resolve_components(
                    asset_index,
                    kind,
                    entity_id,
                    image,
                    rule_values,
                    art_values,
                    voxel,
                    _yes(rule_values.get("turret")),
                )
                dependencies = _resolve_dependencies(rule_values, rules)
                body_asset = next(
                    (component.asset for component in components if component.role == "body"),
                    None,
                )
                countries = _effective_entity_countries(rule_values)
                sides = tuple(
                    dict.fromkeys(
                        country_lookup.get(country.casefold(), {}).get("side", "")
                        for country in countries
                    )
                )
                entities.append(
                    GameEntity(
                        entity_id,
                        kind,
                        _entity_usage(kind, rule_values),
                        display_name,
                        internal_name,
                        ui_name,
                        localized_name is not None,
                        image,
                        resolved_voxel,
                        countries,
                        tuple(side for side in sides if side),
                        _entity_affiliation(
                            rule_values,
                            countries,
                            tuple(side for side in sides if side),
                            country_lookup,
                            asset_index,
                        ),
                        _selected_fields(rule_values, _RULE_FIELDS),
                        _selected_fields(art_values, _ART_FIELDS),
                        components,
                        dependencies,
                        _resolve_media(
                            entity_id,
                            rule_values,
                            art_values,
                            dependencies,
                            rules,
                            art,
                            asset_index,
                            audio_events,
                            voice_strings,
                            body_asset,
                        ),
                    )
                )
        entities.sort(key=lambda entity: (entity.display_name.casefold(), entity.id.casefold()))
        eva_events = _build_eva_events(
            eva,
            asset_index,
            voice_strings,
            tuple(entities),
        )
        inputs = {
            "rules": tuple(_input_summary(asset) for asset in rules_assets),
            "art": tuple(_input_summary(asset) for asset in art_assets),
            "sound": tuple(_input_summary(asset) for asset in sound_assets),
            "eva": tuple(_input_summary(asset) for asset in eva_assets),
            "csf": tuple(_input_summary(asset) for asset in csf_assets),
        }
        if not rules_assets:
            warnings.append("未找到 rules.ini 或 rulesmd.ini")
        if not art_assets:
            warnings.append("未找到 art.ini 或 artmd.ini")
        media_items = _build_media_items(
            assets,
            tuple(entities),
            audio_events,
            eva_events,
            voice_strings,
        )
        return SemanticCatalog(
            source_id,
            tuple(entities),
            inputs,
            tuple(warnings),
            audio_events,
            eva_events,
            country_definitions,
            media_items,
        )


def _build_country_definitions(
    rules: dict[str, dict[str, str]],
    strings: dict[str, str],
) -> tuple[dict[str, str], ...]:
    countries = []
    for country_id in _type_values(rules.get("countries", {})):
        values = rules.get(country_id.casefold(), {})
        ui_name = values.get("uiname")
        display_name = (
            (strings.get(ui_name.casefold(), "") if ui_name else "")
            or values.get("name")
            or country_id
        )
        countries.append(
            {
                "id": country_id,
                "display_name": display_name,
                "side": values.get("side", ""),
            }
        )
    return tuple(countries)


def _effective_entity_countries(values: dict[str, str]) -> tuple[str, ...]:
    owners = _references(values.get("owner"))
    required = _references(values.get("requiredhouses"))
    forbidden = {value.casefold() for value in _references(values.get("forbiddenhouses"))}
    if required:
        required_keys = {value.casefold() for value in required}
        selected = tuple(value for value in owners if value.casefold() in required_keys)
        if not selected:
            selected = required
    else:
        selected = owners
    return tuple(value for value in selected if value.casefold() not in forbidden)


def _entity_affiliation(
    values: dict[str, str],
    countries: tuple[str, ...],
    sides: tuple[str, ...],
    country_lookup: dict[str, dict[str, str]],
    assets: _AssetIndex,
) -> dict[str, Any] | None:
    owners = _references(values.get("owner"))
    required = _references(values.get("requiredhouses"))
    country_specific = len(countries) == 1 and (bool(required) or len(owners) == 1)
    if country_specific:
        country_id = countries[0]
        definition = country_lookup.get(country_id.casefold(), {})
        icon = _find_asset(
            assets,
            _COUNTRY_ICON_FILES.get(country_id.casefold(), ()),
            ("pcx", "shp"),
        )
        return {
            "kind": "country",
            "id": country_id,
            "display_name": definition.get("display_name") or country_id,
            "icon": icon,
        }
    if len(sides) == 1:
        return _side_affiliation(sides[0], assets)
    planning_side = _integer(values.get("aibaseplanningside"))
    if planning_side is not None and 0 <= planning_side < len(_PLANNING_SIDE_IDS):
        return _side_affiliation(_PLANNING_SIDE_IDS[planning_side], assets)
    return None


def _side_affiliation(side_id: str, assets: _AssetIndex) -> dict[str, Any]:
    icon = _find_asset(
        assets,
        _SIDE_ICON_FILES.get(side_id.casefold(), ()),
        ("pcx", "shp"),
    )
    return {
        "kind": "side",
        "id": side_id,
        "display_name": _SIDE_DISPLAY_NAMES.get(side_id.casefold(), side_id),
        "icon": icon,
    }


def _entity_faction_ids(entity: GameEntity) -> tuple[str, ...]:
    affiliation = entity.affiliation
    if affiliation is None:
        return (UNAFFILIATED_SIDE,)
    if affiliation.get("kind") == "side":
        side_id = str(affiliation.get("id") or "").strip()
        return (side_id,) if side_id else (UNAFFILIATED_SIDE,)
    if affiliation.get("kind") == "country" and len(entity.sides) == 1:
        return entity.sides
    return (UNAFFILIATED_SIDE,)


_VOICE_MEDIA_GROUP_SLOTS = (
    ("selection_voice", frozenset({"select"})),
    ("movement_voice", frozenset({"move"})),
    ("combat_voice", frozenset({"attack", "special_attack"})),
    ("feedback_voice", frozenset({"feedback"})),
    ("death_voice", frozenset({"die"})),
    (
        "ability_voice",
        frozenset({"capture", "harvest", "deploy", "enter", "create"}),
    ),
)
_SOUND_MEDIA_GROUP_SLOTS = (
    ("weapon_sound", frozenset({"attack", "special_attack"})),
    ("death_sound", frozenset({"die"})),
    (
        "movement_sound",
        frozenset({"movement", "start_moving", "stop_moving", "turret_rotate"}),
    ),
    (
        "action_sound",
        frozenset(
            {
                "create",
                "deploy",
                "deploy_sound",
                "undeploy",
                "enter",
                "enter_transport",
                "leave_transport",
                "activate",
                "deactivate",
                "cloak",
                "uncloak",
                "chrono_in",
                "chrono_out",
                "capture",
                "harvest",
            }
        ),
    ),
    ("impact_sound", frozenset({"crashing", "impact_land", "impact_water", "sinking"})),
    ("destruction_sound", frozenset({"destruction", "explosion"})),
)


def _normalized_media_event(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _inferred_voice_event_slots(events: tuple[str, ...] | list[str]) -> set[str]:
    inferred: set[str] = set()
    for event in events:
        normalized = _normalized_media_event(event)
        if "select" in normalized:
            inferred.add("select")
        if "move" in normalized:
            inferred.add("move")
        if any(token in normalized for token in ("attack", "airstrike", "crushing")):
            inferred.add("attack")
        if "specialattack" in normalized:
            inferred.add("special_attack")
        if any(
            token in normalized
            for token in ("fear", "psyresist", "overload", "powerdown", "missionaborted")
        ):
            inferred.add("feedback")
        if any(token in normalized for token in ("voicedie", "die", "death")):
            inferred.add("die")
        if "created" in normalized or "createvoice" in normalized:
            inferred.add("create")
        if "deploy" in normalized or "transform" in normalized:
            inferred.add("deploy")
        if any(token in normalized for token in ("capture", "liberated", "steal")):
            inferred.add("capture")
        if "harvest" in normalized:
            inferred.add("harvest")
    return inferred


def _is_descriptive_media_text(value: str | None) -> bool:
    text = (value or "").strip()
    return text.startswith("*") or text.isdecimal()


def _is_descriptive_sound_text(sample: MediaSample) -> bool:
    return _is_descriptive_media_text(sample.text)


def _sound_description_sample(sample: MediaSample) -> MediaSample:
    def cleaned(value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip().strip("*").strip()

    return replace(
        sample,
        text=cleaned(sample.text),
        original_text=cleaned(sample.original_text),
        localized_text=cleaned(sample.localized_text),
        translated_text=cleaned(sample.translated_text),
    )


def _standalone_sound_group(event: str, sample: MediaSample) -> str:
    # SOUND/SOUNDMD section names are the authoritative event identity. Sample
    # names are often abbreviated and contain accidental substrings such as
    # ``amb``; use them only for truly orphaned samples without an event name.
    folded = _normalized_media_event(event) or _normalized_media_event(sample.name)
    if any(
        token in folded
        for token in (
            "voicedie",
            "die",
            "death",
            "victimswell",
            "infantrypsycrush",
            "infantrymelt",
            "infantrysquish",
            "infantryzap",
            "trexfall",
        )
    ):
        return "death_sound"
    if any(
        token in folded
        for token in (
            "cratearmor",
            "cratefreeunit",
            "healcrate",
            "cratepromoted",
            "cratespeed",
            "upgradeelite",
            "upgradeveteran",
        )
    ):
        return "notification_sound"
    if any(
        token in folded
        for token in (
            "forceshield",
            "geneticmutator",
            "ironcurtain",
            "nuke",
            "nuclear",
            "chronosphere",
            "chronoscreen",
            "psychicdominator",
            "psychicreveal",
            "weather",
        )
    ):
        return "superweapon_sound"
    if any(
        token in folded
        for token in (
            "bioreactor",
            "grindergrinding",
            "oilderrick",
            "orerefinery",
            "prismtowerpowerup",
            "spyuplink",
            "tankbunker",
            "teslacoilpowerup",
            "poweron",
            "poweroff",
            "psychicamplifier",
            "oremineextract",
        )
    ):
        return "structure_sound"
    if any(token in folded for token in ("bigbenbell", "fountainloop", "policesiren")):
        return "ambient_sound"
    if any(
        token in folded
        for token in (
            "psychicsensordetect",
            "airraidsiren",
            "mindcleared",
            "flare",
            "crazyivanbombtick",
            "bonus",
            "cratemoney",
            "creditdown",
            "creditup",
            "cameraswitch",
            "cheer",
            "gameclosed",
            "genericbeep",
            "buildinggarrisoned",
            "bridgerepaired",
            "buildingrepaired",
            "nocando",
            "playerjoined",
            "newgame",
            "radaroff",
            "radaron",
        )
    ):
        return "notification_sound"
    if "wallcrush" in folded:
        return "destruction_sound"
    if "tankcrush" in folded:
        return "impact_sound"
    if "fear" in folded:
        return "action_sound"
    if any(token in folded for token in ("yurimindcontrol", "kirovelitebomb")):
        return "weapon_sound"
    if any(
        token in folded
        for token in (
            "landing",
            "takeoff",
            "trexfoot",
        )
    ):
        return "movement_sound"
    if any(
        token in folded
        for token in (
            "parachutedrop",
            "floatingdiscchargeup",
            "floatingdiscsteal",
        )
    ):
        return "action_sound"
    if any(token in folded for token in ("expl", "detonat", "blast", "destruct")):
        return "destruction_sound"
    if any(
        token in folded
        for token in ("impact", "crash", "splash", "sinking", "damaged", "collision")
    ):
        return "impact_sound"
    if any(
        token in folded
        for token in ("underattack", "warning", "alarm", "beacon", "detected", "ready")
    ):
        return "notification_sound"
    if any(
        token in folded
        for token in (
            "menu",
            "commandbar",
            "options",
            "message",
            "movie",
            "planningmode",
            "score",
            "textbleep",
        )
    ):
        return "interface_sound"
    if any(token in folded for token in ("attack", "fire", "weapon", "shot")):
        return "weapon_sound"
    if any(
        token in folded
        for token in ("move", "engine", "motor", "drive", "tread", "turret", "rotate")
    ):
        return "movement_sound"
    if any(
        token in folded
        for token in (
            "deploy",
            "undeploy",
            "create",
            "build",
            "repair",
            "transform",
            "activate",
            "deactivate",
            "cloak",
            "chrono",
            "transport",
            "harvest",
            "enter",
            "leave",
            "emerge",
            "merge",
            "select",
        )
    ):
        return "action_sound"
    if any(token in folded for token in ("ambient", "amb", "bird", "wind", "water")):
        return "ambient_sound"
    return "other_sound"


def _refined_media_groups(
    kind: str,
    groups: set[str],
    slots: set[str],
) -> set[str]:
    refined = set(groups)
    if kind == "voice" and refined.intersection({"unit_voice", "other_voice"}):
        semantic_groups = {
            group
            for group, group_slots in _VOICE_MEDIA_GROUP_SLOTS
            if slots.intersection(group_slots)
        }
        if semantic_groups:
            refined.difference_update({"unit_voice", "other_voice"})
            refined.update(semantic_groups)
    elif kind == "sound" and refined.intersection({"combat_sound", "unit_sound", "other_sound"}):
        semantic_groups = {
            group
            for group, group_slots in _SOUND_MEDIA_GROUP_SLOTS
            if slots.intersection(group_slots)
        }
        if any(
            re.fullmatch(r"(?:elite_)?(?:primary|secondary|weapon_\d+)", slot) for slot in slots
        ):
            semantic_groups.add("weapon_sound")
        if semantic_groups:
            refined.difference_update({"combat_sound", "unit_sound", "other_sound"})
            refined.update(semantic_groups)
    return refined


def _mission_number(value: str) -> int | None:
    folded = value.casefold()
    if folded.isdigit():
        return int(folded)
    if len(folded) == 1 and "a" <= folded <= "c":
        return 10 + ord(folded) - ord("a")
    return None


def _mission_context(
    asset_stem: str,
    events: Iterable[str],
) -> dict[str, object] | None:
    def context(game: str, campaign: str, number_value: str) -> dict[str, object] | None:
        number = _mission_number(number_value)
        if number is None:
            return None
        return {
            "key": f"{game}:{campaign}:{number}",
            "game": game,
            "campaign": campaign,
            "number": number,
        }

    for raw_event in events:
        event = raw_event.casefold()
        coop_match = re.match(r"^coop_x[asy](\d{2})_", event)
        if coop_match:
            return context("yr", "coop", coop_match.group(1))
        mission_match = re.match(r"^mis_(x?)([ast])(\d+|[a-c])_", event)
        if mission_match:
            return context(
                "yr" if mission_match.group(1) else "ra2",
                {"a": "allied", "s": "soviet", "t": "tutorial"}[mission_match.group(2)],
                mission_match.group(3),
            )
        briefing_match = re.match(r"^([as])(\d{2})[_-]p\d+$", event)
        if briefing_match:
            return context(
                "yr",
                {"a": "allied", "s": "soviet"}[briefing_match.group(1)],
                briefing_match.group(2),
            )

    stem = asset_stem.casefold()
    coop_stem_match = re.match(r"^xc([0-3])", stem)
    if coop_stem_match:
        return context("yr", "coop", coop_stem_match.group(1))
    expansion_stem_match = re.match(r"^x([as])([1-7])", stem)
    if expansion_stem_match:
        return context(
            "yr",
            {"a": "allied", "s": "soviet"}[expansion_stem_match.group(1)],
            expansion_stem_match.group(2),
        )
    original_stem_match = re.match(r"^m([ast])([1-9a-c])", stem)
    if original_stem_match:
        return context(
            "ra2",
            {"a": "allied", "s": "soviet", "t": "tutorial"}[original_stem_match.group(1)],
            original_stem_match.group(2),
        )
    briefing_stem_match = re.match(r"^([as])(\d{2})[_-]p\d+$", stem)
    if briefing_stem_match:
        return context(
            "yr",
            {"a": "allied", "s": "soviet"}[briefing_stem_match.group(1)],
            briefing_stem_match.group(2),
        )
    return None


def _mission_description(mission: dict[str, object]) -> str:
    game = "红色警戒 2" if mission["game"] == "ra2" else "尤里的复仇"
    campaign = {
        "allied": "盟军战役",
        "soviet": "苏军战役",
        "tutorial": "教程",
        "coop": "合作任务",
    }[str(mission["campaign"])]
    number = int(mission["number"])
    display_number = number + 1 if mission["campaign"] == "coop" else number
    return f"{game} · {campaign} · 第 {display_number} 关"


def _mission_event_slot(asset_stem: str, events: Iterable[str]) -> str:
    tokens = " ".join((asset_stem, *events)).casefold()
    if re.search(r"(?:briefing|[_-]p\d+)", tokens):
        return "mission_briefing"
    if any(
        marker in tokens
        for marker in (
            "dead",
            "lost",
            "fail",
            "abort",
            "nopowerleft",
            "destroyed",
        )
    ):
        return "mission_failure"
    if any(
        marker in tokens
        for marker in (
            "warn",
            "lookout",
            "underattack",
            "under_attack",
            "threat",
            "ambush",
            "prepared",
            "defensesahead",
            "strangereadings",
        )
    ):
        return "mission_warning"
    if any(
        marker in tokens
        for marker in (
            "capture",
            "capt",
            "rescue",
            "destroy",
            "protect",
            "find",
            "getromanov",
            "savetimemach",
            "donot",
            "needpower",
            "oilfieldstoeast",
        )
    ):
        return "mission_objective"
    if any(
        marker in tokens
        for marker in (
            "intro",
            "described",
            "notice",
            "discovered",
        )
    ):
        return "mission_introduction"
    if any(
        marker in tokens
        for marker in (
            "ready",
            "online",
            "welldone",
            "good",
            "found",
            "gone",
            "enoughpower",
            "command",
            "inbound",
            "rescued",
        )
    ):
        return "mission_progress"
    return "mission_dialogue"


def _build_media_items(
    assets: list[dict[str, Any]],
    entities: tuple[GameEntity, ...],
    audio_events: dict[str, tuple[MediaSample, ...]],
    eva_events: tuple[MediaAssociation, ...],
    voice_strings: dict[str, VoiceText],
) -> tuple[dict[str, object], ...]:
    entities_by_id = {entity.id.casefold(): entity for entity in entities}
    representatives: dict[str, dict[str, Any]] = {}
    for asset in assets:
        if asset["format"] not in {"bag_audio", "wav", "aud"}:
            continue
        key = str(asset["display_name"]).casefold()
        current = representatives.get(key)
        if current is None or _asset_precedence(asset) > _asset_precedence(current):
            representatives[key] = asset

    states: dict[str, dict[str, Any]] = {
        key: {
            "asset": asset,
            "voice": False,
            "sound": False,
            "groups": set(),
            "texts": set(),
            "original_texts": set(),
            "localized_texts": set(),
            "localized_text_origins": set(),
            "translated_texts": set(),
            "events": set(),
            "slots": set(),
            "entities": {},
            "countries": set(),
            "sides": set(),
        }
        for key, asset in representatives.items()
    }

    def state_for(sample: MediaSample) -> dict[str, Any] | None:
        if sample.asset is None:
            return None
        return states.get(str(sample.asset["display_name"]).casefold())

    def add_sample(
        sample: MediaSample,
        *,
        kind: str,
        group: str,
        event: str,
        slot: str | tuple[str, ...],
        entity: GameEntity | None = None,
    ) -> None:
        if kind == "sound":
            sample = _sound_description_sample(sample)
        state = state_for(sample)
        if state is None:
            return
        state[kind] = True
        state["groups"].add(group)
        if sample.text:
            state["texts"].add(sample.text.strip())
        if sample.original_text:
            state["original_texts"].add(sample.original_text.strip())
        if sample.localized_text:
            state["localized_texts"].add(sample.localized_text.strip())
            if sample.localized_text_origin:
                state["localized_text_origins"].add(sample.localized_text_origin)
        if sample.translated_text:
            state["translated_texts"].add(sample.translated_text.strip())
        if event:
            state["events"].add(event)
        if isinstance(slot, str) and slot:
            state["slots"].add(slot)
        elif slot:
            state["slots"].update(slot)
        if entity is not None:
            state["entities"][entity.id.casefold()] = {
                "id": entity.id,
                "display_name": entity.display_name,
                "internal_name": entity.internal_name,
                "kind": entity.kind,
                "affiliation": (
                    {key: entity.affiliation[key] for key in ("kind", "id", "display_name")}
                    if entity.affiliation is not None
                    else None
                ),
            }
            state["countries"].update(entity.countries)
            state["sides"].update(entity.sides)

    combat_slots = {slot for slot, _ in _WEAPON_SLOTS}
    for entity in entities:
        for association in entity.media:
            if association.kind == "animation":
                continue
            for sample in association.samples:
                is_voice = association.kind == "voice" or (
                    sample.text is not None and not _is_descriptive_sound_text(sample)
                )
                if is_voice:
                    add_sample(
                        sample,
                        kind="voice",
                        group="unit_voice",
                        event=association.event,
                        slot=association.slot,
                        entity=entity,
                    )
                else:
                    group = (
                        "weapon_sound"
                        if association.slot in combat_slots or association.source != entity.id
                        else "unit_sound"
                    )
                    add_sample(
                        sample,
                        kind="sound",
                        group=group,
                        event=association.event,
                        slot=association.slot,
                        entity=entity,
                    )

    for association in eva_events:
        for sample in association.samples:
            if sample.name.rsplit(".", 1)[0].casefold() == "dummy":
                continue
            event_name = association.event.casefold()
            asset_stem = sample.name.rsplit(".", 1)[0].casefold()
            mission = _mission_context(asset_stem, (association.event,))
            if mission is not None:
                kind, group = "voice", "mission_voice"
                slot: str | tuple[str, ...] = (
                    f"mission:{mission['key']}",
                    _mission_event_slot(asset_stem, (association.event,)),
                )
            elif (advisor_slot := _unit_intel_advisor_slot(event_name)) is not None:
                kind, group = "voice", "unit_intel_voice"
                slot = advisor_slot
            elif event_name.startswith(("wwd_", "wwd-")):
                kind, group = "voice", "world_domination_voice"
                slot = association.slot
            elif sample.text is None:
                kind, group = "sound", "notification_sound"
                slot = association.slot
            else:
                kind, group = "voice", "eva_voice"
                slot = association.slot
            add_sample(
                sample,
                kind=kind,
                group=group,
                event=association.event,
                slot=slot,
                entity=(
                    _eva_event_entity(association.event, entities_by_id)
                    if group == "unit_intel_voice"
                    else None
                ),
            )

    for event, samples in audio_events.items():
        for sample in samples:
            if sample.text and not _is_descriptive_sound_text(sample):
                inferred_slots = tuple(sorted(_inferred_voice_event_slots([event])))
                add_sample(
                    sample,
                    kind="voice",
                    group="other_voice",
                    event=event,
                    slot=("sound_event", *inferred_slots),
                )
                continue
            add_sample(
                _sound_description_sample(sample),
                kind="sound",
                group=_standalone_sound_group(event, sample),
                event=event,
                slot="sound_event",
            )

    for key, value in voice_strings.items():
        for suffix in (".wav", ".aud"):
            state = states.get(f"{key}{suffix}")
            if state is None:
                continue
            descriptive_text = _is_descriptive_media_text(value.text)
            if descriptive_text:
                state["sound"] = True
                if not any(group.endswith("_sound") for group in state["groups"]):
                    state["groups"].add("interface_sound")
                cleaned = _sound_description_sample(
                    MediaSample(
                        key,
                        value.text,
                        None,
                        value.original_text,
                        value.localized_text,
                        localized_text_origin=value.localized_text_origin,
                        translated_text=value.translated_text,
                    )
                )
                if cleaned.text:
                    state["texts"].add(cleaned.text)
                if cleaned.original_text:
                    state["original_texts"].add(cleaned.original_text)
                if cleaned.localized_text:
                    state["localized_texts"].add(cleaned.localized_text)
                    if cleaned.localized_text_origin:
                        state["localized_text_origins"].add(cleaned.localized_text_origin)
                if cleaned.translated_text:
                    state["translated_texts"].add(cleaned.translated_text)
                continue
            state["voice"] = True
            state["texts"].add(value.text.strip())
            if value.original_text:
                state["original_texts"].add(value.original_text.strip())
            if value.localized_text:
                state["localized_texts"].add(value.localized_text.strip())
                if value.localized_text_origin:
                    state["localized_text_origins"].add(value.localized_text_origin)
            if value.translated_text:
                state["translated_texts"].add(value.translated_text.strip())
            stem = key.casefold()
            if not any(group.endswith("_voice") for group in state["groups"]):
                state["groups"].add(
                    "mission_voice" if re.match(r"^[a-z]\d{2}[_-]p\d+", stem) else "other_voice"
                )
            taunt_match = re.fullmatch(r"tau([a-z]{2})(\d{2})", stem)
            if taunt_match:
                line_number = int(taunt_match.group(2))
                if line_number <= 4:
                    state["groups"].add("multiplayer_voice")
                    state["slots"].add(
                        {
                            1: "multiplayer_funds",
                            2: "multiplayer_attack",
                            3: "multiplayer_help",
                            4: "multiplayer_coordination",
                        }[line_number]
                    )
                else:
                    state["groups"].add("taunt_voice")
                    state["slots"].add(
                        {
                            5: "taunt_surrender",
                            6: "taunt_laugh",
                            7: "taunt_retort",
                            8: "taunt_victory",
                        }.get(line_number, "taunt")
                    )
                affiliation = _TAUNT_AFFILIATIONS.get(taunt_match.group(1))
                if affiliation:
                    country, side = affiliation
                    state["countries"].add(country)
                    state["sides"].add(side)
            elif re.fullmatch(r"aprotr[1-5]", stem):
                # RA2's SOUND.INI binds these samples to PropagandaTruck and
                # RULES uses that event as an ambient sound. SOUNDMD comments
                # the samples out, but the retail audio and transcript remain.
                state["groups"].add("ambient_voice")
                state["events"].add("PropagandaTruck")
                state["slots"].add("ambient")

    for state in states.values():
        if state["voice"] or state["sound"]:
            continue
        asset = state["asset"]
        stem = str(asset["display_name"]).rsplit(".", 1)[0].casefold()
        virtual_path = str(asset.get("virtual_path") or "").casefold()
        explosion_match = re.fullmatch(r"gexp(\d{2})a", stem)
        if explosion_match:
            event = f"Explosion{explosion_match.group(1)}"
            state["sound"] = True
            state["groups"].add("destruction_sound")
            state["events"].add(event)
            state["slots"].add("explosion")
            continue
        description = _LEGACY_INTERFACE_AUDIO_DESCRIPTIONS.get(stem)
        if (
            description is not None
            and asset["format"] == "aud"
            and ("sidenc" in virtual_path or "local.mix" in virtual_path)
        ):
            # These retail AUD files live in SIDENC campaign-shell archives or
            # LOCAL.MIX and are not SOUND.INI events. Preserve that distinction
            # while still exposing their known interface/transition purpose.
            state["sound"] = True
            state["groups"].add("interface_sound")
            state["events"].add(stem.upper())
            state["slots"].add("interface")
            state["texts"].add(description)

    items = []
    for state in states.values():
        kind = "voice" if state["voice"] else "sound" if state["sound"] else "unknown"
        asset_stem = str(state["asset"]["display_name"]).rsplit(".", 1)[0].casefold()
        events = []
        seen_events: set[str] = set()
        for event in sorted(
            state["events"],
            key=lambda value: (value.casefold(), value == value.casefold(), value),
        ):
            folded_event = event.casefold()
            if folded_event in seen_events:
                continue
            seen_events.add(folded_event)
            events.append(event)
        mission = _mission_context(asset_stem, events) if kind == "voice" else None
        if mission is not None:
            state["slots"].difference_update({"eva_allied", "eva_soviet", "eva_yuri"})
            state["slots"].add(f"mission:{mission['key']}")
            state["slots"].add(_mission_event_slot(asset_stem, events))
        refined_groups = _refined_media_groups(
            kind,
            state["groups"],
            state["slots"],
        )
        groups = sorted(
            group
            for group in refined_groups
            if (kind == "voice" and group.endswith("_voice"))
            or (kind == "sound" and group.endswith("_sound"))
        )
        if kind == "voice" and len(groups) > 1 and "other_voice" in groups:
            groups.remove("other_voice")
        if kind == "sound" and len(groups) > 1 and "other_sound" in groups:
            groups.remove("other_sound")
        if kind == "unknown":
            groups = ["unclassified"]
        if kind == "voice" and mission is not None and not state["entities"]:
            groups = [group for group in groups if group not in {"eva_voice", "other_voice"}]
            if "mission_voice" not in groups:
                groups.append("mission_voice")
                groups.sort()
        for specific_group in (
            "unit_intel_voice",
            "world_domination_voice",
            "multiplayer_voice",
            "taunt_voice",
        ):
            if specific_group in groups:
                groups = [
                    group
                    for group in groups
                    if group not in {"eva_voice", "other_voice"} or group == specific_group
                ]
        texts = sorted(state["texts"], key=str.casefold)
        original_texts = sorted(state["original_texts"], key=str.casefold)
        localized_texts = sorted(state["localized_texts"], key=str.casefold)
        translated_texts = sorted(state["translated_texts"], key=str.casefold)
        entity_refs = sorted(
            state["entities"].values(),
            key=lambda item: (item["display_name"].casefold(), item["id"].casefold()),
        )
        description = texts[0] if texts else None
        if description is None and mission is not None:
            description = _mission_description(mission)
        elif description is None and entity_refs:
            description = str(entity_refs[0]["display_name"])
            if events:
                description += f" · {events[0]}"
        elif description is None and "eva_voice" in groups and events:
            description = f"EVA 播报 · {events[0]}"
        elif description is None and events:
            description = _MEDIA_EVENT_DESCRIPTIONS.get(events[0].casefold(), events[0])
        items.append(
            {
                "asset": _asset_summary(state["asset"]),
                "kind": kind,
                "groups": groups,
                "texts": texts,
                "original_texts": original_texts,
                "localized_texts": localized_texts,
                "localized_text_origins": sorted(state["localized_text_origins"]),
                "translated_texts": translated_texts,
                "events": events,
                "slots": sorted(state["slots"]),
                "entities": entity_refs,
                "countries": sorted(state["countries"], key=str.casefold),
                "sides": sorted(state["sides"], key=str.casefold),
                "mission": mission,
                "description": description,
            }
        )
    items.sort(
        key=lambda item: str(item["asset"]["display_name"]).casefold()  # type: ignore[index]
    )
    return tuple(items)


def _named_inputs(
    by_name: dict[str, list[dict[str, Any]]],
    names: tuple[str, ...],
) -> list[dict[str, Any]]:
    assets = []
    for name in names:
        assets.extend(by_name.get(name.casefold(), ()))
    return sorted(assets, key=_config_precedence)


def _edition_ini_inputs(
    by_name: dict[str, list[dict[str, Any]]],
    base_name: str,
    expansion_name: str,
) -> list[dict[str, Any]]:
    expansion = _named_inputs(by_name, (expansion_name,))
    return expansion or _named_inputs(by_name, (base_name,))


def _merge_ini_inputs(
    reader: AssetReader,
    assets: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, dict[str, str]]:
    merged: dict[str, dict[str, str]] = {}
    for asset in assets:
        try:
            _, data = reader.read(str(asset["id"]))
            parsed = parse_ini(data)
        except (OSError, Ra2ExplorerError, ValueError) as error:
            warnings.append(f"{asset['display_name']}: {error}")
            continue
        for section in parsed.sections:
            target = merged.setdefault(section.name.casefold(), {})
            for entry in section.entries:
                target[entry.key.casefold()] = _clean_value(entry.value)
    return merged


def _merge_csf_inputs(
    reader: AssetReader,
    assets: list[dict[str, Any]],
    warnings: list[str],
    voice_transcripts: dict[str, dict[str, str]],
) -> tuple[dict[str, str], dict[str, VoiceText]]:
    strings: dict[str, str] = {}
    voice_strings: dict[str, VoiceText] = {}
    for asset in assets:
        try:
            _, data = reader.read(str(asset["id"]))
            parsed = parse_csf(data)
        except (OSError, Ra2ExplorerError, ValueError) as error:
            warnings.append(f"{asset['display_name']}: {error}")
            continue
        for label in parsed.labels:
            if label.values:
                folded = label.name.casefold()
                strings[folded] = label.values[0].text
                if folded.startswith("vox:"):
                    value = label.values[0]
                    for alias in _voice_aliases(folded[4:], value.extra):
                        current = voice_strings.get(alias)
                        original_text = current.original_text if current else None
                        localized_text = current.localized_text if current else None
                        localized_text_origin = (
                            current.localized_text_origin if current else None
                        )
                        translated_text = current.translated_text if current else None
                        if parsed.language == 9:
                            localized_text = value.text
                            localized_text_origin = "game"
                        elif parsed.language == 0:
                            original_text = value.text
                        voice_strings[alias] = VoiceText(
                            label.name,
                            translated_text or localized_text or original_text or value.text,
                            original_text,
                            localized_text,
                            localized_text_origin,
                            translated_text,
                        )
    _overlay_voice_transcripts(voice_strings, voice_transcripts)
    return strings, voice_strings


def _overlay_voice_transcripts(
    voice_strings: dict[str, VoiceText],
    voice_transcripts: dict[str, dict[str, str]],
) -> None:
    """Apply verified spoken lines after CSF labels, which can contain only a unit name."""
    for key, transcript in voice_transcripts.items():
        current = voice_strings.get(key)
        original_text = (
            transcript.get("original_text")
            or transcript.get("text")
            or (current.original_text if current else None)
        )
        incoming_localized_text = transcript.get("localized_text")
        incoming_origin = transcript.get("localized_text_origin")
        translated_text = transcript.get("translated_text") or (
            current.translated_text if current else None
        )
        if incoming_localized_text and incoming_origin != "game":
            translated_text = translated_text or incoming_localized_text
            incoming_localized_text = None
        localized_text = incoming_localized_text or (current.localized_text if current else None)
        if original_text is None and localized_text is None and translated_text is None:
            continue
        localized_text_origin = "game" if localized_text else None
        display_text = translated_text or localized_text or original_text or (
            current.text if current else None
        )
        if display_text is None:
            continue
        voice_strings[key] = VoiceText(
            current.label if current else f"TRANSCRIPT:{key}",
            display_text,
            original_text,
            localized_text,
            localized_text_origin,
            translated_text,
        )


def _voice_aliases(label_name: str, extra: str | None) -> tuple[str, ...]:
    aliases = [label_name.casefold()]
    for raw in re.split(r"[,;|\s]+", extra or ""):
        token = raw.strip().strip("\"'").lstrip("$").replace("\\", "/")
        token = token.rsplit("/", 1)[-1]
        if "." in token:
            token = token.rsplit(".", 1)[0]
        if token:
            aliases.append(token.casefold())
    return tuple(dict.fromkeys(aliases))


@dataclass(slots=True)
class _AssetIndex:
    by_name: dict[str, list[dict[str, Any]]]
    by_crc: dict[int, list[dict[str, Any]]]


def _index_assets(assets: list[dict[str, Any]]) -> _AssetIndex:
    by_name: dict[str, list[dict[str, Any]]] = {}
    by_crc: dict[int, list[dict[str, Any]]] = {}
    for asset in assets:
        for value in (asset.get("display_name"), asset.get("name")):
            if value:
                bucket = by_name.setdefault(str(value).casefold(), [])
                if asset not in bucket:
                    bucket.append(asset)
        if isinstance(asset.get("crc"), int):
            by_crc.setdefault(int(asset["crc"]), []).append(asset)
    return _AssetIndex(by_name, by_crc)


def _asset_summary(asset: dict[str, Any] | None) -> dict[str, object] | None:
    if asset is None:
        return None
    return {
        key: asset[key]
        for key in (
            "id",
            "display_name",
            "format",
            "virtual_path",
            "size",
            "storage_kind",
        )
    }


def _build_audio_events(
    sections: dict[str, dict[str, str]],
    assets: _AssetIndex,
    voice_strings: dict[str, VoiceText],
) -> dict[str, tuple[MediaSample, ...]]:
    events = {}
    for event, values in sections.items():
        sample_names = _tokens(values.get("sounds") or values.get("sound"))
        if sample_names:
            samples: list[MediaSample] = []
            positions: dict[str, int] = {}
            for name in sample_names:
                sample = _audio_sample(name, assets, voice_strings)
                identity = (
                    str(sample.asset["id"]) if sample.asset is not None else sample.name.casefold()
                )
                position = positions.get(identity)
                if position is None:
                    positions[identity] = len(samples)
                    samples.append(sample)
                else:
                    current = samples[position]
                    samples[position] = replace(current, weight=current.weight + 1)
            events[event] = tuple(samples)
    return events


def _build_eva_events(
    sections: dict[str, dict[str, str]],
    assets: _AssetIndex,
    voice_strings: dict[str, VoiceText],
    entities: tuple[GameEntity, ...] = (),
) -> tuple[MediaAssociation, ...]:
    associations = []
    seen_unit_intel_samples: set[tuple[str, str, str]] = set()
    for event, values in sections.items():
        fallback_voice_text = _eva_event_voice_text(event, values)
        advisor_slot = _unit_intel_advisor_slot(event)
        for faction, fields in (
            ("allied", ("allied",)),
            ("soviet", ("soviet", "russian")),
            ("yuri", ("yuri",)),
        ):
            sample_names = tuple(
                dict.fromkeys(
                    sample_name for field in fields for sample_name in _tokens(values.get(field))
                )
            )
            for sample_name in sample_names:
                sample = _audio_sample(sample_name, assets, voice_strings)
                if sample.text is None and fallback_voice_text is not None:
                    sample = replace(
                        sample,
                        text=fallback_voice_text.text,
                        original_text=fallback_voice_text.original_text,
                        localized_text=fallback_voice_text.localized_text,
                        text_label=fallback_voice_text.label,
                        localized_text_origin=fallback_voice_text.localized_text_origin,
                        translated_text=fallback_voice_text.translated_text,
                    )
                slot = advisor_slot or f"eva_{faction}"
                if advisor_slot is not None:
                    sample_identity = (
                        str(sample.asset["id"])
                        if sample.asset is not None
                        else sample.name.rsplit(".", 1)[0].casefold()
                    )
                    identity = (event.casefold(), advisor_slot, sample_identity)
                    if identity in seen_unit_intel_samples:
                        continue
                    seen_unit_intel_samples.add(identity)
                associations.append(
                    MediaAssociation("voice", slot, event, "eva", (sample,))
                )
    return tuple(associations)


def _eva_event_voice_text(
    event: str,
    values: dict[str, str],
) -> VoiceText | None:
    configured = values.get("text")
    if configured:
        return VoiceText(f"EVA:{event}", configured, configured, None)
    return None


def _unit_intel_advisor_slot(event: str) -> str | None:
    folded = event.casefold()
    if folded.startswith("unit_eva_"):
        return "advisor_eva"
    if folded.startswith("unit_sofia_"):
        return "advisor_sofia"
    return None


def _eva_event_entity(
    event: str,
    entities_by_id: dict[str, GameEntity],
) -> GameEntity | None:
    match = re.match(r"unit_(?:eva|sofia)_(.+)$", event, re.IGNORECASE)
    if match is None:
        return None
    entity_id = (
        "SENGINEER"
        if event.casefold() == "unit_sofia_engineer"
        else _EVA_UNIT_ENTITY_IDS.get(match.group(1).casefold())
    )
    return entities_by_id.get((entity_id or "").casefold())


def _body_sequence_preview_frame(
    entity: GameEntity,
    frame: int,
    facing: int,
) -> int | None:
    sequences = [
        association
        for association in entity.media
        if association.slot == "body_sequence"
        and association.samples
        and association.samples[0].animation is not None
    ]
    if not sequences:
        return None
    preferred_events = ("ready", "guard", "deployed", "hover", "fly", "walk")
    sequence = next(
        (
            association
            for event in preferred_events
            for association in sequences
            if association.event.casefold() == event
        ),
        sequences[0],
    )
    playback = sequence.samples[0].animation
    if playback is None:
        return None
    frame_count = max(1, playback.frame_count or 1)
    facing_offset = (facing % 8) * playback.facing_step if playback.facing_step else 0
    return (
        playback.start_frame + facing_offset + (frame % frame_count) * max(1, playback.frame_step)
    )


def _merge_duplicate_body_sequences(
    associations: list[MediaAssociation],
) -> tuple[MediaAssociation, ...]:
    merged: list[MediaAssociation] = []
    sequence_indices: dict[tuple[object, ...], int] = {}
    for association in associations:
        if (
            association.slot != "body_sequence"
            or len(association.samples) != 1
            or association.samples[0].animation is None
        ):
            merged.append(association)
            continue
        sample = association.samples[0]
        playback = sample.animation
        asset_key = sample.asset["id"] if sample.asset else sample.name.casefold()
        key = (
            association.source.casefold(),
            asset_key,
            playback.start_frame,
            playback.frame_count,
            playback.facing_step,
            playback.frame_step,
            playback.rate_ms,
            playback.loop_start,
            playback.loop_end,
            playback.loop_count,
            playback.direction,
        )
        existing_index = sequence_indices.get(key)
        if existing_index is None:
            sequence_indices[key] = len(merged)
            merged.append(association)
            continue
        existing = merged[existing_index]
        aliases = list(existing.aliases)
        known = {existing.event.casefold(), *(alias.casefold() for alias in aliases)}
        for alias in (association.event, *association.aliases):
            if alias.casefold() not in known:
                known.add(alias.casefold())
                aliases.append(alias)
        merged[existing_index] = replace(existing, aliases=tuple(aliases))
    return tuple(merged)


def _resolve_media(
    entity_id: str,
    rules: dict[str, str],
    entity_art: dict[str, str],
    dependencies: tuple[EntityDependency, ...],
    rules_sections: dict[str, dict[str, str]],
    art_sections: dict[str, dict[str, str]],
    assets: _AssetIndex,
    audio_events: dict[str, tuple[MediaSample, ...]],
    voice_strings: dict[str, VoiceText],
    body_asset: dict[str, Any] | None,
) -> tuple[MediaAssociation, ...]:
    associations: list[MediaAssociation] = []
    seen: set[tuple[str, str, str, str, str]] = set()

    def add(association: MediaAssociation) -> None:
        key = (
            association.kind,
            association.slot,
            association.event.casefold(),
            association.source.casefold(),
            (association.rule_field or "").casefold(),
        )
        if association.samples and key not in seen:
            seen.add(key)
            associations.append(association)

    for slot, field in _AUDIO_RULE_FIELDS.items():
        for event in _references(rules.get(field)):
            samples = audio_events.get(event.casefold()) or (
                _audio_sample(event, assets, voice_strings),
            )
            add(
                MediaAssociation(
                    "voice" if field.startswith("voice") else "sound",
                    slot,
                    event,
                    entity_id,
                    samples,
                )
            )

    weapon_dependencies = {
        (dependency.slot, dependency.id.casefold()): dependency
        for dependency in dependencies
        if dependency.kind == "weapon"
    }
    for dependency in dependencies:
        if dependency.kind == "weapon":
            for event in _references(dependency.properties.get("report")):
                samples = audio_events.get(event.casefold()) or (
                    _audio_sample(event, assets, voice_strings),
                )
                add(MediaAssociation("sound", dependency.slot, event, dependency.id, samples))
            animations = tuple(dict.fromkeys(_references(dependency.properties.get("animation"))))
            if animations:
                add(
                    MediaAssociation(
                        "animation",
                        dependency.slot,
                        animations[0],
                        dependency.id,
                        tuple(
                            sample
                            for animation in animations
                            for sample in _animation_samples(animation, art_sections, assets)
                        ),
                        role=("destruction" if dependency.slot == "destruction" else "weapon"),
                        rule_field="WeaponType.Anim",
                    )
                )
        elif dependency.kind == "warhead":
            weapon = weapon_dependencies.get(
                (dependency.slot, (dependency.parent or "").casefold())
            )
            damage = _integer(weapon.properties.get("damage")) if weapon else None
            if damage is not None and dependency.slot == "destruction":
                try:
                    modifier = float(rules.get("deathweapondamagemodifier", "1"))
                except ValueError:
                    modifier = 1.0
                damage = int(damage * modifier)
            random_selection = _yes(dependency.properties.get("em_effect"))
            if damage is not None and damage <= 0 and not random_selection:
                continue
            for property_name, rule_field in (
                ("animation_list", "WarheadType.AnimList"),
                ("splash_list", "WarheadType.SplashList"),
            ):
                animations = tuple(
                    dict.fromkeys(_references(dependency.properties.get(property_name)))
                )
                if not animations:
                    continue
                selected_index = (
                    min(max(damage or 0, 0) // 25, len(animations) - 1)
                    if damage is not None and not random_selection
                    else 0
                )
                selected_animation = animations[selected_index]
                add(
                    MediaAssociation(
                        "animation",
                        dependency.slot,
                        selected_animation,
                        dependency.id,
                        tuple(
                            sample
                            for animation in animations
                            for sample in _animation_samples(animation, art_sections, assets)
                        ),
                        role=("destruction" if dependency.slot == "destruction" else "impact"),
                        selection=(
                            "random"
                            if random_selection
                            else "damage"
                            if damage is not None
                            else "first"
                        ),
                        selected_sample=selected_animation,
                        selection_value=damage,
                        rule_field=rule_field,
                    )
                )

    max_debris = _integer(rules.get("maxdebris"), 0) or 0
    if max_debris > 0:
        debris_types = tuple(dict.fromkeys(_references(rules.get("debristypes"))))
        debris_animations = tuple(dict.fromkeys(_references(rules.get("debrisanims"))))
        debris_samples: tuple[MediaSample, ...] = ()
        debris_rule_field = "TechnoType.DebrisTypes"
        if debris_types:
            resolved = []
            for reference in debris_types:
                values = rules_sections.get(reference.casefold(), {})
                image = values.get("image") or reference
                asset = _find_asset(
                    assets,
                    (f"{image}.vxl", f"{image}.hva"),
                    ("vxl", "hva"),
                )
                resolved.append(MediaSample(reference, None, asset))
            debris_samples = tuple(resolved)
        else:
            references = debris_animations or tuple(
                dict.fromkeys(
                    _references(
                        rules_sections.get("general", {}).get("metallicdebris")
                        or rules_sections.get("audiovisual", {}).get("metallicdebris")
                    )
                )
            )
            debris_rule_field = (
                "TechnoType.DebrisAnims" if debris_animations else "General.MetallicDebris"
            )
            debris_samples = tuple(
                sample
                for reference in references
                for sample in _animation_samples(reference, art_sections, assets)
            )
        if debris_samples:
            add(
                MediaAssociation(
                    "animation",
                    "destruction",
                    debris_samples[0].name,
                    entity_id,
                    debris_samples,
                    role="debris",
                    selection="random",
                    selected_sample=debris_samples[0].name,
                    selection_value=max_debris,
                    rule_field=debris_rule_field,
                )
            )

    for field, value in entity_art.items():
        role = _entity_animation_role(field)
        if role is None:
            continue
        for animation in _references(value):
            add(
                MediaAssociation(
                    "animation",
                    field,
                    animation,
                    entity_id,
                    _animation_samples(
                        animation,
                        art_sections,
                        assets,
                        palette=("unit" if role in {"construction", "operation"} else None),
                        force_shadow=role == "construction",
                    ),
                    role=role,
                    rule_field=f"ArtType.{field}",
                )
            )
    sequence_name = entity_art.get("sequence")
    if sequence_name and body_asset and body_asset.get("format") == "shp":
        for event, value in art_sections.get(sequence_name.casefold(), {}).items():
            playback = _sequence_playback(value)
            if playback is None:
                continue
            add(
                MediaAssociation(
                    "animation",
                    "body_sequence",
                    event,
                    sequence_name,
                    (
                        MediaSample(
                            str(body_asset["display_name"]),
                            None,
                            body_asset,
                            animation=playback,
                        ),
                    ),
                    role="body",
                    rule_field=f"Sequence.{event}",
                )
            )
    elif body_asset and body_asset.get("format") == "shp":
        for event, playback, rule_field in _shp_unit_body_playbacks(entity_art):
            add(
                MediaAssociation(
                    "animation",
                    "body_sequence",
                    event,
                    entity_id,
                    (
                        MediaSample(
                            str(body_asset["display_name"]),
                            None,
                            body_asset,
                            animation=playback,
                            palette="unit",
                        ),
                    ),
                    role="body",
                    rule_field=rule_field,
                )
            )
    return _merge_duplicate_body_sequences(associations)


def _audio_sample(
    raw_name: str,
    assets: _AssetIndex,
    voice_strings: dict[str, VoiceText],
) -> MediaSample:
    name = raw_name.strip().lstrip("$")
    stem = name.rsplit(".", 1)[0]
    names = (name,) if "." in name else (f"{name}.wav", f"{name}.aud")
    asset = _find_asset(assets, names, ("bag_audio", "wav", "aud"))
    voice_text = voice_strings.get(stem.casefold())
    return MediaSample(
        name,
        voice_text.text if voice_text else None,
        asset,
        voice_text.original_text if voice_text else None,
        voice_text.localized_text if voice_text else None,
        voice_text.label if voice_text else None,
        localized_text_origin=voice_text.localized_text_origin if voice_text else None,
        translated_text=voice_text.translated_text if voice_text else None,
    )


def _animation_samples(
    reference: str,
    art_sections: dict[str, dict[str, str]],
    assets: _AssetIndex,
    *,
    palette: str | None = None,
    force_shadow: bool = False,
) -> tuple[MediaSample, ...]:
    values = art_sections.get(reference.casefold(), {})
    image = values.get("image") or reference
    names = (image,) if "." in image else (f"{image}.shp", f"{image}.hva")
    asset = _find_asset(assets, names, ("shp", "hva", "video"))
    playback = _art_animation_playback(
        values,
        end_is_frame_count=_art_end_is_frame_count(reference, values, art_sections),
    )
    if playback is not None and playback.frame_count is None:
        sibling_count = _art_sibling_frame_count(reference, values, art_sections)
        if sibling_count is not None:
            playback = replace(playback, frame_count=sibling_count)
    if force_shadow:
        playback = replace(playback or AnimationPlayback(), shadow=True)
    direction_match = re.search(r"-(NE|SE|SW|NW|N|E|S|W)$", reference, re.IGNORECASE)
    if direction_match:
        playback = replace(
            playback or AnimationPlayback(),
            direction=direction_match.group(1).upper(),
        )
    palette_kind = palette or ("unit" if _yes(values.get("altpalette")) else "animation")
    return (
        MediaSample(
            reference,
            None,
            asset,
            animation=playback,
            palette=palette_kind,
        ),
    )


def _entity_animation_role(field: str) -> str | None:
    normalized = field.casefold()
    if normalized == "buildup":
        return "construction"
    if re.fullmatch(
        r"(?:active|idle|special|super)anim(?:two|three|four)?"
        r"|productionanim"
        r"|deployinganim|roofdeployinganim|underdooranim|underroofdooranim",
        normalized,
    ):
        return "operation"
    return None


def _art_end_is_frame_count(
    reference: str,
    values: dict[str, str],
    art_sections: dict[str, dict[str, str]],
) -> bool:
    """Detect the retail repair-bay convention where End stores a frame count.

    Most ART animations use End as an inclusive source-frame index. The retail
    repair bays explicitly use it as a count; their normal and damaged sections
    share one image, and at least one sibling consequently has End <= Start.
    """
    if "end" not in values or "loopend" in values:
        return False
    image = (values.get("image") or reference).casefold()
    for section_name, candidate in art_sections.items():
        if (candidate.get("image") or section_name).casefold() != image:
            continue
        if "end" not in candidate or "loopend" in candidate:
            continue
        start = _integer(candidate.get("start"), 0) or 0
        end = _integer(candidate.get("end"))
        if start > 0 and end is not None and end <= start:
            return True
    return False


def _art_sibling_frame_count(
    reference: str,
    values: dict[str, str],
    art_sections: dict[str, dict[str, str]],
) -> int | None:
    """Bound range-less animations before the next state sharing their image."""
    image = (values.get("image") or reference).casefold()
    start = _integer(values.get("start"), 0) or 0
    later_starts = []
    for section_name, candidate in art_sections.items():
        if (candidate.get("image") or section_name).casefold() != image:
            continue
        candidate_start = _integer(candidate.get("start"), 0) or 0
        if candidate_start > start:
            later_starts.append(candidate_start)
    if not later_starts:
        return None
    return min(later_starts) - start


def _art_animation_playback(
    values: dict[str, str],
    *,
    end_is_frame_count: bool = False,
) -> AnimationPlayback | None:
    playback_fields = {
        "start",
        "end",
        "loopstart",
        "loopend",
        "loopcount",
        "rate",
        "shadow",
        "reverse",
    }
    if not playback_fields.intersection(values):
        return None
    start = _integer(values.get("start"), 0) or 0
    loop_start = _integer(values.get("loopstart"))
    loop_end = _integer(values.get("loopend"))
    end = _integer(values.get("end"))
    if loop_end is not None:
        frame_count = loop_end - start + 1 if loop_end >= start else None
    elif end is not None and end_is_frame_count:
        frame_count = max(1, end)
    else:
        frame_count = end - start + 1 if end is not None and end >= start else None
    return AnimationPlayback(
        start_frame=max(0, start),
        frame_count=frame_count,
        rate_ms=_integer(values.get("rate")),
        loop_start=loop_start,
        loop_end=loop_end,
        loop_count=_integer(values.get("loopcount")),
        shadow=_yes(values.get("shadow")),
        reverse=_yes(values.get("reverse")),
    )


def _sequence_playback(value: str) -> AnimationPlayback | None:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) < 3:
        return None
    start = _integer(parts[0])
    frame_count = _integer(parts[1])
    facing_step = _integer(parts[2])
    if start is None or start < 0 or frame_count is None or frame_count <= 0 or facing_step is None:
        return None
    return AnimationPlayback(
        start_frame=start,
        frame_count=frame_count,
        facing_step=max(0, facing_step),
        direction=parts[3] if len(parts) > 3 and parts[3] else None,
    )


def _shp_unit_body_playbacks(
    art: dict[str, str],
) -> tuple[tuple[str, AnimationPlayback, str], ...]:
    """Map Westwood's interleaved SHP unit frames to configured actions.

    Non-voxel vehicles such as the Terror Drone, Dolphin, and Giant Squid store
    eight facings for each animation step. ``WalkFrames`` and ``FiringFrames``
    define the action lengths; the initial eight frames are the standing pose.
    """
    walk_frames = max(0, _integer(art.get("walkframes"), 0) or 0)
    firing_frames = max(0, _integer(art.get("firingframes"), 0) or 0)
    if walk_frames == 0 and firing_frames == 0:
        return ()

    playbacks: list[tuple[str, AnimationPlayback, str]] = [
        (
            "ready",
            AnimationPlayback(frame_count=1, facing_step=1),
            "ArtType.Facings",
        )
    ]
    next_frame = 8
    if walk_frames:
        playbacks.append(
            (
                "walk",
                AnimationPlayback(
                    start_frame=next_frame,
                    frame_count=walk_frames,
                    facing_step=1,
                    frame_step=8,
                ),
                "ArtType.WalkFrames",
            )
        )
        next_frame += walk_frames * 8
    if firing_frames:
        playbacks.append(
            (
                "fire",
                AnimationPlayback(
                    start_frame=next_frame,
                    frame_count=firing_frames,
                    facing_step=1,
                    frame_step=8,
                ),
                "ArtType.FiringFrames",
            )
        )
    return tuple(playbacks)


def _shp_content_frames(
    sprite: ShpFile,
    visible_frames: tuple[int, ...],
) -> tuple[int, ...]:
    """Exclude second-half palette-index-1 shadows from playable SHP frames."""
    shadow_frames = {
        shadow
        for frame in range(len(sprite.frames) // 2)
        if (shadow := sprite.paired_shadow_frame(frame)) is not None
    }
    return tuple(frame for frame in visible_frames if frame not in shadow_frames)


def _type_values(section: dict[str, str]) -> list[str]:
    def key(item: tuple[str, str]) -> tuple[int, object]:
        name = item[0]
        return (0, int(name)) if name.isdigit() else (1, name)

    return [value for _, value in sorted(section.items(), key=key) if value]


def _resolve_components(
    assets: _AssetIndex,
    kind: str,
    entity_id: str,
    image: str,
    rules: dict[str, str],
    art: dict[str, str],
    voxel: bool,
    has_turret: bool,
) -> tuple[tuple[EntityComponent, ...], bool]:
    if _is_null_image(image):
        return (), False
    body_vxl = _find_asset(assets, (f"{image}.vxl",), ("vxl",))
    body_shp = _find_asset(
        assets,
        _theater_shp_names(image, _yes(art.get("newtheater"))),
        ("shp",),
    )
    voxel_turret = (
        kind == "building"
        and _yes(rules.get("turretanimisvoxel"))
        and bool(rules.get("turretanim"))
    )
    prefer_shp_body = voxel_turret and body_shp is not None
    resolved_voxel = (voxel or body_vxl is not None) and not prefer_shp_body
    components = []
    if resolved_voxel:
        components.append(EntityComponent("body", f"{image}.vxl", body_vxl))
        components.append(
            EntityComponent(
                "body_hva",
                f"{image}.hva",
                _find_asset(assets, (f"{image}.hva",), ("hva",)),
            )
        )
        for role, suffix in (("turret", "TUR"), ("barrel", "BARL")):
            asset = _find_asset(assets, (f"{image}{suffix}.vxl",), ("vxl",))
            if asset or (role == "turret" and has_turret):
                components.append(EntityComponent(role, f"{image}{suffix}.vxl", asset))
                components.append(
                    EntityComponent(
                        f"{role}_hva",
                        f"{image}{suffix}.hva",
                        _find_asset(assets, (f"{image}{suffix}.hva",), ("hva",)),
                    )
                )
    else:
        expected = f"{image}.shp"
        components.append(
            EntityComponent(
                "body",
                expected,
                body_shp,
            )
        )
        if kind == "building":
            bib_shape = art.get("bibshape")
            if bib_shape:
                expected = f"{bib_shape}.shp"
                components.append(
                    EntityComponent(
                        "bib",
                        expected,
                        _find_asset(assets, (expected,), ("shp",)),
                    )
                )
            if voxel_turret:
                turret_name = str(rules["turretanim"])
                turret_expected = f"{turret_name}.vxl"
                components.append(
                    EntityComponent(
                        "turret",
                        turret_expected,
                        _find_asset(assets, (turret_expected,), ("vxl",)),
                    )
                )
                components.append(
                    EntityComponent(
                        "turret_hva",
                        f"{turret_name}.hva",
                        _find_asset(assets, (f"{turret_name}.hva",), ("hva",)),
                    )
                )
                barrel_names = tuple(dict.fromkeys((f"{entity_id}BARL", f"{turret_name}BARL")))
                barrel_asset = _find_asset(
                    assets,
                    tuple(f"{name}.vxl" for name in barrel_names),
                    ("vxl",),
                )
                if barrel_asset is not None:
                    barrel_name = str(barrel_asset["display_name"]).rsplit(".", 1)[0]
                    components.append(EntityComponent("barrel", f"{barrel_name}.vxl", barrel_asset))
                    components.append(
                        EntityComponent(
                            "barrel_hva",
                            f"{barrel_name}.hva",
                            _find_asset(assets, (f"{barrel_name}.hva",), ("hva",)),
                        )
                    )

    for role, field in (("cameo", "cameo"), ("alt_cameo", "altcameo")):
        value = art.get(field)
        if value:
            expected = f"{value}.shp"
            components.append(
                EntityComponent(role, expected, _find_asset(assets, (expected,), ("shp",)))
            )
    return tuple(components), resolved_voxel


def _is_null_image(image: str) -> bool:
    return image.strip().casefold() in _NULL_IMAGES


def _theater_shp_names(image: str, new_theater: bool) -> tuple[str, ...]:
    names = [f"{image}.shp"]
    if new_theater and len(image) > 1:
        for theater in "ATSUNLD":
            variant = f"{image[0]}{theater}{image[2:]}.shp"
            if variant.casefold() not in {name.casefold() for name in names}:
                names.append(variant)
    return tuple(names)


def _resolve_dependencies(
    entity_rules: dict[str, str],
    sections: dict[str, dict[str, str]],
) -> tuple[EntityDependency, ...]:
    dependencies = []
    seen = set()

    def add(
        dependency_id: str,
        kind: str,
        slot: str,
        parent: str | None,
        fields: dict[str, str],
    ) -> dict[str, str]:
        values = sections.get(dependency_id.casefold(), {})
        key = (dependency_id.casefold(), kind, slot, (parent or "").casefold())
        if key not in seen:
            seen.add(key)
            dependencies.append(
                EntityDependency(
                    dependency_id,
                    kind,
                    slot,
                    parent,
                    bool(values),
                    _selected_fields(values, fields),
                )
            )
        return values

    def resolve_weapon(slot: str, weapon_id: str) -> None:
        weapon = add(weapon_id, "weapon", slot, None, _WEAPON_FIELDS)
        for projectile_id in _references(weapon.get("projectile")):
            add(projectile_id, "projectile", slot, weapon_id, _PROJECTILE_FIELDS)
        for warhead_id in _references(weapon.get("warhead")):
            add(warhead_id, "warhead", slot, weapon_id, _WARHEAD_FIELDS)

    for slot, field in _WEAPON_SLOTS:
        for weapon_id in _references(entity_rules.get(field)):
            resolve_weapon(slot, weapon_id)

    weapon_count = _integer(entity_rules.get("weaponcount"), 0) or 0
    for index in range(1, min(weapon_count, 64) + 1):
        for prefix, field_prefix in (("weapon", "weapon"), ("elite_weapon", "eliteweapon")):
            for weapon_id in _references(entity_rules.get(f"{field_prefix}{index}")):
                resolve_weapon(f"{prefix}_{index}", weapon_id)

    death_weapons = _references(entity_rules.get("deathweapon"))
    if not death_weapons and _yes(entity_rules.get("explodes")):
        death_weapons = _references(sections.get("combatdamage", {}).get("deathweapon"))
    for weapon_id in death_weapons:
        resolve_weapon("destruction", weapon_id)
    return tuple(dependencies)


def _find_asset(
    assets: _AssetIndex,
    names: tuple[str, ...],
    formats: tuple[str, ...],
) -> dict[str, Any] | None:
    for name in names:
        candidates = [
            asset for asset in assets.by_name.get(name.casefold(), ()) if asset["format"] in formats
        ]
        if candidates:
            return max(candidates, key=_asset_precedence)
        try:
            hashes = {ra2_mix_hash(name), classic_mix_hash(name)}
        except ValueError:
            continue
        candidates = [
            asset
            for crc in hashes
            for asset in assets.by_crc.get(crc, ())
            if asset["format"] in formats or asset["format"] == "binary"
        ]
        if candidates:
            selected = dict(max(candidates, key=_asset_precedence))
            display_name = name.replace("\\", "/").rsplit("/", 1)[-1]
            extension = display_name.rsplit(".", 1)[-1].casefold() if "." in display_name else ""
            expected_format = {
                "aud": "aud",
                "bik": "video",
                "hva": "hva",
                "pcx": "pcx",
                "shp": "shp",
                "vqa": "video",
                "vxl": "vxl",
                "wav": "wav",
            }.get(extension)
            selected.update(
                {
                    "name": display_name,
                    "display_name": display_name,
                    "extension": extension,
                    "confidence": "semantic",
                }
            )
            if selected["format"] == "binary" and expected_format:
                selected["format"] = expected_format
            return selected
    return None


def _asset_precedence(asset: dict[str, Any]) -> tuple[int, str]:
    path = str(asset["virtual_path"]).replace("\\", "/").casefold()
    score = 1_000_000 if asset["storage_kind"] == "loose" else 0
    for pattern, base in ((r"expandmd(\d+)", 800_000), (r"expand(\d+)", 600_000)):
        match = re.search(pattern, path)
        if match:
            score += base + int(match.group(1))
            break
    if "ra2md.mix" in path:
        score += 400_000
    elif "ra2.mix" in path:
        score += 200_000
    return score, path


def _config_precedence(asset: dict[str, Any]) -> tuple[int, str]:
    score, path = _asset_precedence(asset)
    if "md." in str(asset["display_name"]).casefold():
        score += 100_000
    return score, path


def _entity_usage(kind: str, values: dict[str, str]) -> str:
    owners = _references(values.get("owner"))
    tech_level = _integer(values.get("techlevel"))
    deployed_construction_yard = kind == "building" and (
        _yes(values.get("constructionyard")) or bool(values.get("undeploysinto"))
    )
    can_build = bool(
        owners
        and values.get("cost")
        and (tech_level is not None and tech_level >= 0 or deployed_construction_yard)
    )
    if kind == "building":
        if can_build:
            return "buildable"
        if _yes(values.get("needsengineer")) or _yes(values.get("capturable")):
            return "tech"
        if any(_yes(values.get(field)) for field in ("civilian", "insignificant", "nominal")):
            return "civilian"
        return "scenario"
    if kind == "infantry":
        if _yes(values.get("civilian")) or _yes(values.get("nothuman")):
            return "civilian"
        if can_build and _integer(values.get("buildlimit")) == 1:
            return "hero"
        return "buildable" if can_build else "scenario"
    return "buildable" if can_build else "scenario"


def _selected_fields(values: dict[str, str], mapping: dict[str, str]) -> dict[str, str]:
    return {
        output: values[source]
        for output, source in mapping.items()
        if values.get(source) not in {None, ""}
    }


def _input_summary(asset: dict[str, Any]) -> dict[str, object]:
    return {
        "id": asset["id"],
        "display_name": asset["display_name"],
        "virtual_path": asset["virtual_path"],
    }


def _clean_value(value: str) -> str:
    return value.split(";", 1)[0].strip()


def _references(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(
        item for raw in value.split(",") if (item := raw.strip()) and item.casefold() != "none"
    )


def _tokens(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(
        token for token in re.split(r"[,\s]+", value) if token and token.casefold() != "none"
    )


def _yes(value: str | None) -> bool:
    return bool(value and value.casefold() in {"yes", "true", "1"})


def _positive_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _integer(value: str | None, fallback: int | None = None) -> int | None:
    try:
        return int(value or "")
    except ValueError:
        return fallback


def _percentage(selected: int, total: int) -> float:
    return round(selected * 100 / total, 1) if total else 0.0


def _entity_search_text(entity: GameEntity) -> str:
    return "\n".join(
        (
            entity.id,
            entity.display_name,
            entity.internal_name,
            entity.ui_name or "",
            entity.image,
            *entity.rules.values(),
            *(dependency.id for dependency in entity.dependencies),
            *(
                value
                for dependency in entity.dependencies
                for value in dependency.properties.values()
            ),
            *(association.event for association in entity.media),
            *(sample.name for association in entity.media for sample in association.samples),
            *(sample.text or "" for association in entity.media for sample in association.samples),
        )
    ).casefold()


def _entity_fuzzy_search_values(entity: GameEntity) -> tuple[str, ...]:
    return (
        entity.id,
        entity.display_name,
        entity.internal_name,
        entity.ui_name or "",
        entity.image,
    )


def _entity_pinyin_search_values(entity: GameEntity) -> tuple[str | None, ...]:
    return (
        entity.display_name,
        localize_game_text(entity.display_name, "zh-CN"),
        localize_game_text(entity.display_name, "zh-TW"),
        entity.ui_name,
    )


def _media_search_text(item: dict[str, object]) -> str:
    asset = item["asset"]
    entities = item["entities"]
    mission = item.get("mission")
    return "\n".join(
        (
            str(asset["display_name"]),  # type: ignore[index]
            str(item.get("description") or ""),
            *(str(value) for value in item["texts"]),  # type: ignore[union-attr]
            *(str(value) for value in item["original_texts"]),  # type: ignore[union-attr]
            *(str(value) for value in item["localized_texts"]),  # type: ignore[union-attr]
            *(str(value) for value in item["translated_texts"]),  # type: ignore[union-attr]
            *(str(value) for value in item["events"]),  # type: ignore[union-attr]
            *(str(value) for value in item["slots"]),  # type: ignore[union-attr]
            *(str(value) for value in item["countries"]),  # type: ignore[union-attr]
            *(str(value) for value in item["sides"]),  # type: ignore[union-attr]
            *((str(value) for value in mission.values()) if isinstance(mission, dict) else ()),
            *(
                f"{entity['id']} {entity['display_name']} {_media_entity_affiliation_name(entity)}"
                for entity in entities  # type: ignore[union-attr]
            ),
        )
    ).casefold()


def _media_pinyin_search_values(item: dict[str, object]) -> tuple[str, ...]:
    entities = item["entities"]
    return tuple(
        str(value)
        for value in (
            item.get("description"),
            *item["texts"],  # type: ignore[union-attr]
            *item["localized_texts"],  # type: ignore[union-attr]
            *item["translated_texts"],  # type: ignore[union-attr]
            *(
                entity["display_name"]
                for entity in entities  # type: ignore[union-attr]
            ),
        )
        if value
    )


def _media_search_aliases(item: dict[str, object]) -> dict[str, list[str]]:
    compact: list[str] = []
    initials: list[str] = []
    for value in _media_pinyin_search_values(item):
        aliases = pinyin_search_aliases(value)
        if aliases is None:
            continue
        if aliases["pinyin_compact"] not in compact:
            compact.append(aliases["pinyin_compact"])
        if aliases["pinyin_initials"] not in initials:
            initials.append(aliases["pinyin_initials"])
    return {"pinyin_compact": compact, "pinyin_initials": initials}


def _localized_media_item(item: dict[str, object], language: GameLanguage) -> dict[str, object]:
    entities = item["entities"]
    localized = {
        **item,
        "description": localize_game_text(
            str(item["description"]) if item.get("description") is not None else None,
            language,
        ),
        "texts": [
            localize_game_text(str(value), language)
            for value in item["texts"]  # type: ignore[union-attr]
        ],
        "localized_texts": [
            localize_game_text(str(value), language)
            for value in item["localized_texts"]  # type: ignore[union-attr]
        ],
        "translated_texts": [
            localize_game_text(str(value), language)
            for value in item["translated_texts"]  # type: ignore[union-attr]
        ],
        "entities": [
            _localized_media_entity(entity, language)
            for entity in entities  # type: ignore[union-attr]
        ],
    }
    return {**localized, "search_aliases": _media_search_aliases(localized)}


def _media_entity_affiliation_name(entity: dict[str, object]) -> str:
    affiliation = entity.get("affiliation")
    return str(affiliation.get("display_name") or "") if isinstance(affiliation, dict) else ""


def _localized_media_entity(entity: dict[str, object], language: GameLanguage) -> dict[str, object]:
    affiliation = entity.get("affiliation")
    localized_affiliation = None
    if isinstance(affiliation, dict):
        localized_affiliation = {
            **affiliation,
            "display_name": localize_game_text(
                str(affiliation.get("display_name") or ""), language
            ),
        }
    return {
        **entity,
        "display_name": localize_game_text(str(entity["display_name"]), language),
        "affiliation": localized_affiliation,
    }


def _media_kind_for_asset(
    media_items: tuple[dict[str, object], ...],
    asset: dict[str, Any],
) -> str:
    asset_id = str(asset["id"])
    display_name = str(asset["display_name"]).casefold()
    for item in media_items:
        selected = item["asset"]
        if (
            str(selected["id"]) == asset_id  # type: ignore[index]
            or str(selected["display_name"]).casefold() == display_name  # type: ignore[index]
        ):
            return str(item["kind"])
    return "unknown"


__all__ = [
    "ENTITY_KINDS",
    "ENTITY_USAGES",
    "SEMANTIC_CATALOG_CACHE_IDENTITY",
    "EntityComponent",
    "EntityDependency",
    "GameEntity",
    "MediaAssociation",
    "MediaSample",
    "VoiceText",
    "SemanticCatalog",
    "SemanticLibrary",
    "deserialize_semantic_catalog",
    "serialize_semantic_catalog",
]
