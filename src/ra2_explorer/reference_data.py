from __future__ import annotations

import json
import re
import tempfile
import urllib.request
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from ra2_explorer.errors import Ra2ExplorerError

CNC_FORMATS_REVISION = "77da596ed72a1201740e054855bf2ff60640bfa9"
KNOWN_NAMES_URL = (
    "https://raw.githubusercontent.com/iron-curtain-engine/cnc-formats/"
    f"{CNC_FORMATS_REVISION}/src/mix/known_names_ra2.txt"
)
AUDIO_TRANSCRIPT_FILE_ID = "10u79FuSLL7F_BCMJa81BjjYh89ZdkGDU"
AUDIO_TRANSCRIPT_URL = (
    "https://drive.usercontent.google.com/download"
    f"?id={AUDIO_TRANSCRIPT_FILE_ID}&export=download&confirm=t"
)
AUDIO_TRANSCRIPT_SOURCE_URL = (
    "https://forums.cncnet.org/topic/12109-in-game-audio-database-transcript/"
)
BUNDLED_UNIT_INTEL_TRANSCRIPT_PATH = Path(__file__).with_name("data") / "unit-intel-transcript.json"
BUNDLED_UNIT_VOICE_TRANSCRIPT_PATH = Path(__file__).with_name("data") / "unit-voice-transcript.json"

# The community workbook rotates both retail harvester voice groups by one row.
# These filename-to-line bindings were verified against the decoded English BAG
# samples; keep the override in code so a future reference sync cannot restore
# the bad alignment.
_VERIFIED_AUDIO_TRANSCRIPT_CORRECTIONS = {
    "vchrhaa": "You'll get the cash in a flash",
    "vchrhab": "It's in the bank",
    "vchrhac": "Mining",
    "vchrhad": "Ah, there it is",
    "vchrhae": "Rolling with a chrono convoy",
    "vwarhaa": "Equal share for everyone",
    "vwarhab": "Let's keep the ore moving",
    "vwarhac": "Da, we will need that",
    "vwarhad": "Looks like good place to mine",
}

BUILTIN_NAMES = (
    "ra2.mix",
    "language.mix",
    "multi.mix",
    "cache.mix",
    "local.mix",
    "neutral.mix",
    "conquer.mix",
    "generic.mix",
    "isogen.mix",
    "cameo.mix",
    "audio.mix",
    "rules.ini",
    "art.ini",
    "ra2.csf",
    "local mix database.dat",
    "unittem.pal",
    "uniturb.pal",
    "unitsno.pal",
    "unitdes.pal",
    "isotem.pal",
    "temperat.pal",
    "apoc.vxl",
    "apoctur.vxl",
    "apocbarl.vxl",
    "apoc.hva",
    "apoctur.hva",
    "apocbarl.hva",
    "gaweap.shp",
)


def load_known_names(path: Path) -> tuple[str, ...]:
    names = list(BUILTIN_NAMES)
    if path.is_file():
        names.extend(
            line.strip()
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines()
            if line.strip() and not line.startswith("#")
        )
    return tuple(dict.fromkeys(names))


def sync_known_names(path: Path, *, timeout: float = 30.0) -> dict[str, object]:
    request = urllib.request.Request(
        KNOWN_NAMES_URL,
        headers={"User-Agent": "ra2-explorer/0.1 reference-sync"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content = response.read(2_000_001)
    except OSError as error:
        raise Ra2ExplorerError(f"名称库下载失败：{error}") from error
    if len(content) > 2_000_000:
        raise Ra2ExplorerError("名称库超过允许的 2 MB")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Ra2ExplorerError("名称库不是有效的 UTF-8 文本") from error
    names = [line.strip() for line in text.splitlines() if line.strip()]
    if len(names) < 1000:
        raise Ra2ExplorerError("名称库内容不完整")

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False, newline="\n"
    ) as temporary:
        temporary.write(text)
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)

    manifest = {
        "provider": "github",
        "repository": "iron-curtain-engine/cnc-formats",
        "revision": CNC_FORMATS_REVISION,
        "resource": "src/mix/known_names_ra2.txt",
        "url": KNOWN_NAMES_URL,
        "downloaded_at": datetime.now(UTC).isoformat(),
        "name_count": len(names),
    }
    manifest_path = path.with_name("manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def load_audio_transcript(
    path: Path, *, supplement_paths: tuple[Path, ...] = ()
) -> dict[str, dict[str, str]]:
    entries: dict[str, dict[str, str]] = {}
    if path.is_file():
        try:
            with path.open("rb") as stream:
                entries.update(_parse_audio_transcript(stream.read(2_000_001)))
        except (OSError, BadZipFile, KeyError, ValueError, ElementTree.ParseError):
            pass
    for supplement_path in supplement_paths:
        for file_id, supplement in _load_audio_transcript_supplement(supplement_path).items():
            current = entries.get(file_id, {})
            merged = {**current, **supplement}
            original_text = merged.get("original_text") or merged.get("text")
            if original_text:
                merged["text"] = original_text
                merged["original_text"] = original_text
            entries[file_id] = merged
    for file_id, text in _VERIFIED_AUDIO_TRANSCRIPT_CORRECTIONS.items():
        current = entries.get(file_id)
        if current is None:
            continue
        entries[file_id] = {**current, "text": text, "original_text": text}
    return entries


def _load_audio_transcript_supplement(path: Path) -> dict[str, dict[str, str]]:
    if not path.is_file():
        return {}
    try:
        content = path.read_bytes()
        if len(content) > 2_000_000:
            return {}
        payload = json.loads(content.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    raw_entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(raw_entries, dict):
        return {}
    default_localized_origin = payload.get("localized_text_origin")

    entries: dict[str, dict[str, str]] = {}
    for raw_name, raw_entry in raw_entries.items():
        if not isinstance(raw_name, str) or not isinstance(raw_entry, dict):
            continue
        file_id = _audio_stem(raw_name)
        original_text = raw_entry.get("original_text") or raw_entry.get("text")
        localized_text = raw_entry.get("localized_text")
        translated_text = raw_entry.get("translated_text")
        has_original = isinstance(original_text, str) and bool(original_text.strip())
        has_localized = isinstance(localized_text, str) and bool(localized_text.strip())
        has_translated = isinstance(translated_text, str) and bool(translated_text.strip())
        configured_origin = raw_entry.get("localized_text_origin") or default_localized_origin
        localized_is_translation = has_localized and configured_origin != "game"
        if localized_is_translation and not has_translated:
            translated_text = localized_text
            has_translated = True
            has_localized = False
        if not file_id or not (has_original or has_localized or has_translated):
            continue
        entry = {
            key: value.strip()
            for key, value in raw_entry.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        if has_original:
            entry["text"] = original_text.strip()
            entry["original_text"] = original_text.strip()
        if has_localized:
            entry["localized_text"] = localized_text.strip()
            entry["localized_text_origin"] = "game"
        else:
            entry.pop("localized_text", None)
            entry.pop("localized_text_origin", None)
        if has_translated:
            entry["translated_text"] = translated_text.strip()
        entries[file_id] = entry
    return entries


def sync_audio_transcript(path: Path, *, timeout: float = 30.0) -> dict[str, object]:
    request = urllib.request.Request(
        AUDIO_TRANSCRIPT_URL,
        headers={"User-Agent": "ra2-explorer/0.7 reference-sync"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content = response.read(2_000_001)
    except OSError as error:
        raise Ra2ExplorerError(f"声音转录表下载失败：{error}") from error
    if len(content) > 2_000_000:
        raise Ra2ExplorerError("声音转录表超过允许的 2 MB")
    try:
        entries = _parse_audio_transcript(content)
    except (BadZipFile, KeyError, ValueError, ElementTree.ParseError) as error:
        raise Ra2ExplorerError("声音转录表不是有效的 XLSX 文件") from error
    if len(entries) < 1_000:
        raise Ra2ExplorerError("声音转录表内容不完整")

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)
    manifest = {
        "provider": "CnCNet community",
        "resource": "RA2 in-game audio database and transcript",
        "source_url": AUDIO_TRANSCRIPT_SOURCE_URL,
        "download_url": AUDIO_TRANSCRIPT_URL,
        "downloaded_at": datetime.now(UTC).isoformat(),
        "entry_count": len(entries),
    }
    path.with_name("audio-transcript-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def _parse_audio_transcript(content: bytes) -> dict[str, dict[str, str]]:
    if len(content) > 2_000_000:
        raise ValueError("workbook is too large")
    with ZipFile(BytesIO(content)) as workbook:
        if sum(item.file_size for item in workbook.infolist()) > 20_000_000:
            raise ValueError("expanded workbook is too large")
        namespace = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        try:
            shared_root = ElementTree.fromstring(workbook.read("xl/sharedStrings.xml"))
        except KeyError:
            shared = []
        else:
            shared = ["".join(node.itertext()) for node in shared_root]
        book_root = ElementTree.fromstring(workbook.read("xl/workbook.xml"))
        relations_root = ElementTree.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
        targets = {node.attrib["Id"]: node.attrib["Target"] for node in relations_root}
        relation_key = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        sheets = book_root.findall("m:sheets/m:sheet", namespace)
        selected = next(
            (sheet for sheet in sheets if sheet.attrib.get("name") == "Complete List"),
            sheets[0] if sheets else None,
        )
        if selected is None:
            raise ValueError("workbook has no sheets")
        target = targets[selected.attrib[relation_key]].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        sheet_root = ElementTree.fromstring(workbook.read(target))

        entries: dict[str, dict[str, str]] = {}
        for row in sheet_root.findall(".//m:sheetData/m:row", namespace)[1:]:
            values: dict[str, str] = {}
            for cell in row.findall("m:c", namespace):
                column_match = re.match(r"[A-Z]+", cell.attrib.get("r", ""))
                if column_match is None:
                    continue
                if cell.attrib.get("t") == "inlineStr":
                    inline = cell.find("m:is", namespace)
                    raw = "".join(inline.itertext()) if inline is not None else ""
                else:
                    value = cell.find("m:v", namespace)
                    raw = value.text if value is not None and value.text else ""
                if cell.attrib.get("t") == "s" and raw:
                    shared_index = int(raw)
                    if not 0 <= shared_index < len(shared):
                        raise ValueError("shared string index is out of range")
                    raw = shared[shared_index]
                values[column_match.group()] = raw.strip()
            file_id = _audio_stem(values.get("A", ""))
            line = values.get("B", "")
            if not file_id or not line:
                continue
            entries[file_id] = {
                "text": line,
                "unit": values.get("C", ""),
                "category": values.get("D", ""),
                "comments": values.get("E", ""),
                "faction": values.get("F", ""),
            }
        return entries


def _audio_stem(value: str) -> str:
    selected = value.strip().strip("\"'").lstrip("$").replace("\\", "/")
    selected = selected.rsplit("/", 1)[-1]
    if "." in selected:
        selected = selected.rsplit(".", 1)[0]
    return selected.casefold()


def reference_status(path: Path) -> dict[str, object]:
    manifest_path = path.with_name("manifest.json")
    if not path.is_file() or not manifest_path.is_file():
        return {"available": False, "builtin_name_count": len(BUILTIN_NAMES)}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"available": True, "manifest_valid": False}
    return {"available": True, "manifest_valid": True, **manifest}


__all__ = [
    "BUILTIN_NAMES",
    "CNC_FORMATS_REVISION",
    "AUDIO_TRANSCRIPT_SOURCE_URL",
    "AUDIO_TRANSCRIPT_URL",
    "BUNDLED_UNIT_INTEL_TRANSCRIPT_PATH",
    "BUNDLED_UNIT_VOICE_TRANSCRIPT_PATH",
    "load_audio_transcript",
    "load_known_names",
    "reference_status",
    "sync_audio_transcript",
    "sync_known_names",
]
