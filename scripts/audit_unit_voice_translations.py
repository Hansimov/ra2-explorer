from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, build_opener

_ANGLE_CUE_PATTERN = re.compile(r"<[^<>]+>")
_ASTERISK_CUE_PATTERN = re.compile(r"\*[^*]+\*")
_TERMINAL_PUNCTUATION_PATTERN = re.compile(r"(?:\.{2,}|…+|[.!?,;:。！？；：，]+)$")


def _terminal_punctuation_kind(value: str) -> str:
    text = value.strip()
    if not text or _ANGLE_CUE_PATTERN.fullmatch(text):
        return ""
    match = _TERMINAL_PUNCTUATION_PATTERN.search(text)
    if match is None:
        return ""
    punctuation = match.group()
    if any(mark in punctuation for mark in "?？") and any(
        mark in punctuation for mark in "!！"
    ):
        return "question-exclamation"
    if any(mark in punctuation for mark in "?？"):
        return "question"
    if any(mark in punctuation for mark in "!！"):
        return "exclamation"
    if "…" in punctuation or punctuation.startswith(".."):
        return "ellipsis"
    if any(mark in punctuation for mark in ";；"):
        return "semicolon"
    if any(mark in punctuation for mark in ":："):
        return "colon"
    if any(mark in punctuation for mark in ",，"):
        return "comma"
    return "period"


def _request_json(base_url: str, path: str, query: dict[str, str] | None = None) -> Any:
    url = f"{base_url.rstrip('/')}{path}"
    if query:
        url = f"{url}?{urlencode(query)}"
    with build_opener(ProxyHandler({})).open(url, timeout=60) as response:
        return json.load(response)


def translation_format_violations(entries: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    violations: list[dict[str, str]] = []
    for stem, entry in entries.items():
        originals = entry["original_texts"]
        translations = entry["translated_texts"]
        if not originals or not translations:
            continue
        source_has_cue = any(
            _ANGLE_CUE_PATTERN.search(value) or _ASTERISK_CUE_PATTERN.search(value)
            for value in originals
        )
        translation_has_cue = any(_ANGLE_CUE_PATTERN.search(value) for value in translations)
        if source_has_cue != translation_has_cue:
            violations.append(
                {
                    "stem": stem,
                    "reason": "missing-cue" if source_has_cue else "unexpected-cue",
                    "original": " / ".join(originals),
                    "translation": " / ".join(translations),
                }
            )
            continue
        if (
            len(originals) == 1
            and len(translations) == 1
            and _terminal_punctuation_kind(originals[0])
            != _terminal_punctuation_kind(translations[0])
        ):
            violations.append(
                {
                    "stem": stem,
                    "reason": "terminal-punctuation",
                    "original": originals[0],
                    "translation": translations[0],
                }
            )
    return violations


def missing_translations_for_original(
    entries: dict[str, dict[str, Any]],
) -> list[str]:
    return [
        stem
        for stem, entry in entries.items()
        if entry["original_texts"] and not entry["translated_texts"]
    ]


def collect_unit_voice_inventory(base_url: str, source_id: str) -> dict[str, Any]:
    entity_page = _request_json(
        base_url, "/api/entities", {"source_id": source_id, "limit": "1000"}
    )
    entity_summaries = [
        item for item in entity_page["items"] if "voice" in item.get("media_kinds", [])
    ]
    inventory: dict[str, dict[str, Any]] = {}

    for summary in entity_summaries:
        entity_id = summary["id"]
        entity = _request_json(
            base_url,
            f"/api/entities/{quote(source_id, safe='')}/{quote(entity_id, safe='')}",
        )
        entity_context = {
            "id": entity_id,
            "name": entity["display_name"],
            "kind": entity["kind"],
            "usage": entity["usage"],
            "affiliation": (entity.get("affiliation") or {}).get("display_name"),
        }
        for association in entity["media"]:
            if association["kind"] != "voice":
                continue
            association_context = {
                "entity": entity_context,
                "slot": association["slot"],
                "event": association["event"],
                "source": association["source"],
            }
            for sample in association["samples"]:
                asset = sample.get("asset")
                if not asset:
                    continue
                stem = Path(asset["display_name"]).stem.casefold()
                row = inventory.setdefault(
                    stem,
                    {
                        "asset_id": asset["id"],
                        "asset": asset["display_name"],
                        "original_texts": set(),
                        "localized_texts": set(),
                        "translated_texts": set(),
                        "contexts": [],
                    },
                )
                for field in ("original_text", "localized_text", "translated_text"):
                    value = sample.get(field)
                    if value:
                        row[f"{field}s"].add(value.strip())
                if association_context not in row["contexts"]:
                    row["contexts"].append(association_context)

    by_kind: defaultdict[str, set[str]] = defaultdict(set)
    by_affiliation: defaultdict[str, set[str]] = defaultdict(set)
    by_entity: defaultdict[str, set[str]] = defaultdict(set)
    entries: dict[str, dict[str, Any]] = {}
    for stem, row in sorted(inventory.items()):
        contexts = sorted(
            row["contexts"],
            key=lambda item: (
                item["entity"]["kind"],
                item["entity"]["name"],
                item["slot"],
                item["event"],
            ),
        )
        for context in contexts:
            by_kind[context["entity"]["kind"]].add(stem)
            by_affiliation[context["entity"]["affiliation"] or "无阵营"].add(stem)
            entity_label = f"{context['entity']['id']} · {context['entity']['name']}"
            by_entity[entity_label].add(stem)
        entries[stem] = {
            "asset_id": row["asset_id"],
            "asset": row["asset"],
            "original_texts": sorted(row["original_texts"], key=str.casefold),
            "localized_texts": sorted(row["localized_texts"]),
            "translated_texts": sorted(row["translated_texts"]),
            "contexts": contexts,
        }

    missing_original = [stem for stem, entry in entries.items() if not entry["original_texts"]]
    missing_translation = [stem for stem, entry in entries.items() if not entry["translated_texts"]]
    missing_translation_for_original = missing_translations_for_original(entries)
    conflicting_original = [
        stem for stem, entry in entries.items() if len(entry["original_texts"]) > 1
    ]
    format_violations = translation_format_violations(entries)
    return {
        "schema": 1,
        "source_id": source_id,
        "summary": {
            "entity_count": len(entity_summaries),
            "voice_asset_count": len(entries),
            "with_original_text": len(entries) - len(missing_original),
            "with_game_localization": sum(
                bool(entry["localized_texts"]) for entry in entries.values()
            ),
            "with_editorial_translation": len(entries) - len(missing_translation),
            "missing_translation_for_original": len(missing_translation_for_original),
            "translation_format_violation_count": len(format_violations),
            "by_kind": {key: len(value) for key, value in sorted(by_kind.items())},
            "by_affiliation": {key: len(value) for key, value in sorted(by_affiliation.items())},
            "by_entity": {key: len(value) for key, value in sorted(by_entity.items())},
        },
        "missing_original": missing_original,
        "missing_translation": missing_translation,
        "missing_translation_for_original": missing_translation_for_original,
        "conflicting_original": conflicting_original,
        "translation_format_violations": format_violations,
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit editorial translation coverage for entity-linked voices."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:46120")
    parser.add_argument("--source-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--table-output", type=Path)
    parser.add_argument(
        "--fail-on-format-issues",
        action="store_true",
        help="Exit unsuccessfully when dialogue/cue bracket formatting is inconsistent.",
    )
    parser.add_argument(
        "--fail-on-missing-original-translations",
        action="store_true",
        help=(
            "Exit unsuccessfully when a unit-linked voice has original text "
            "but no editorial translation."
        ),
    )
    args = parser.parse_args()

    source_id = args.source_id
    if not source_id:
        sources = _request_json(args.base_url, "/api/sources")
        ready_sources = [source for source in sources if source["state"] == "ready"]
        if len(ready_sources) != 1:
            raise SystemExit(
                "Pass --source-id when the service has zero or multiple ready sources."
            )
        source_id = ready_sources[0]["id"]

    payload = collect_unit_voice_inventory(args.base_url, source_id)
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    if args.table_output:
        args.table_output.parent.mkdir(parents=True, exist_ok=True)
        with args.table_output.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream, delimiter="\t")
            writer.writerow(
                (
                    "stem",
                    "units",
                    "kinds",
                    "affiliations",
                    "slots",
                    "original",
                    "native",
                    "editorial",
                )
            )
            for stem, entry in payload["entries"].items():
                contexts = entry["contexts"]
                writer.writerow(
                    (
                        stem,
                        " / ".join(dict.fromkeys(item["entity"]["name"] for item in contexts)),
                        " / ".join(dict.fromkeys(item["entity"]["kind"] for item in contexts)),
                        " / ".join(
                            dict.fromkeys(
                                item["entity"]["affiliation"] or "无阵营" for item in contexts
                            )
                        ),
                        " / ".join(dict.fromkeys(item["slot"] for item in contexts)),
                        " / ".join(entry["original_texts"]),
                        " / ".join(entry["localized_texts"]),
                        " / ".join(entry["translated_texts"]),
                    )
                )

    if args.fail_on_format_issues and payload["translation_format_violations"]:
        raise SystemExit(1)
    if (
        args.fail_on_missing_original_translations
        and payload["missing_translation_for_original"]
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
