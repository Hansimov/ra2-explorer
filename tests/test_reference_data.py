from __future__ import annotations

import json
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

from ra2_explorer.reference_data import (
    BUNDLED_UNIT_INTEL_TRANSCRIPT_PATH,
    load_audio_transcript,
)


def test_audio_transcript_reads_complete_list_and_normalizes_file_ids(tmp_path) -> None:
    path = tmp_path / "audio-transcript.xlsx"
    path.write_bytes(_audio_transcript_workbook())

    entries = load_audio_transcript(path)

    assert entries == {
        "giselea": {
            "text": "Sir, yes sir!",
            "unit": "GI",
            "category": "Select",
            "comments": "",
            "faction": "Allied",
        }
    }


def test_audio_transcript_ignores_invalid_workbook(tmp_path) -> None:
    path = tmp_path / "audio-transcript.xlsx"
    path.write_bytes(b"not an xlsx file")

    assert load_audio_transcript(path) == {}


def test_audio_transcript_merges_local_mission_supplement(tmp_path) -> None:
    workbook_path = tmp_path / "audio-transcript.xlsx"
    workbook_path.write_bytes(_audio_transcript_workbook())
    supplement_path = tmp_path / "mission-audio-transcript.json"
    supplement_path.write_text(
        json.dumps(
            {
                "entries": {
                    "$A01_P01.wav": {
                        "original_text": "Protect the Time Machine.",
                        "localized_text": "保护时间机器。",
                        "speaker": "EVA",
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    entries = load_audio_transcript(workbook_path, supplement_paths=(supplement_path,))

    assert entries["giselea"]["text"] == "Sir, yes sir!"
    assert entries["a01_p01"] == {
        "original_text": "Protect the Time Machine.",
        "localized_text": "保护时间机器。",
        "speaker": "EVA",
        "text": "Protect the Time Machine.",
    }


def test_audio_transcript_can_load_supplement_without_workbook(tmp_path) -> None:
    supplement_path = tmp_path / "mission-audio-transcript.json"
    supplement_path.write_text(
        '{"entries":{"S02_P01":{"text":"Destroy Einstein lab."}}}',
        encoding="utf-8",
    )

    entries = load_audio_transcript(tmp_path / "missing.xlsx", supplement_paths=(supplement_path,))

    assert entries["s02_p01"]["original_text"] == "Destroy Einstein lab."


def test_audio_transcript_merges_multiple_supplements(tmp_path) -> None:
    mission_path = tmp_path / "mission.json"
    mission_path.write_text(
        '{"entries":{"A01_P01":{"original_text":"Mission briefing."}}}',
        encoding="utf-8",
    )
    english_voice_path = tmp_path / "english-voice.json"
    english_voice_path.write_text(
        (
            '{"entries":{"CEVAU06":{"original_text":'
            '"The V3 is a powerful long-range artillery weapon."}}}'
        ),
        encoding="utf-8",
    )

    entries = load_audio_transcript(
        tmp_path / "missing.xlsx",
        supplement_paths=(mission_path, english_voice_path),
    )

    assert entries["a01_p01"]["original_text"] == "Mission briefing."
    assert entries["cevau06"]["original_text"].startswith("The V3")


def test_bundled_expansion_unit_intel_has_spoken_text_and_translation(tmp_path) -> None:
    entries = load_audio_transcript(
        tmp_path / "missing.xlsx",
        supplement_paths=(BUNDLED_UNIT_INTEL_TRANSCRIPT_PATH,),
    )

    assert len(entries) == 110
    assert entries["csofu39"]["original_text"].startswith("Yuri's Boomer submarine")
    assert "雷鸣攻击潜艇" in entries["csofu39"]["localized_text"]
    assert entries["cevau94"]["localized_text"].startswith("战乱中")


def test_audio_transcript_corrects_verified_rotated_harvest_groups(tmp_path) -> None:
    path = tmp_path / "audio-transcript.xlsx"
    path.write_bytes(
        _audio_transcript_workbook(
            (
                ("$vchrhaa.wav", "It's in the bank", "Chrono Miner", "Harvest", "", "Allied"),
                ("$vchrhab.wav", "Mining", "Chrono Miner", "Harvest", "", "Allied"),
                ("$vchrhac.wav", "Ah, there it is", "Chrono Miner", "Harvest", "", "Allied"),
                (
                    "$vchrhad.wav",
                    "Rolling with a chrono convoy",
                    "Chrono Miner",
                    "Harvest",
                    "",
                    "Allied",
                ),
                (
                    "$vchrhae.wav",
                    "You'll get the cash in a flash",
                    "Chrono Miner",
                    "Harvest",
                    "",
                    "Allied",
                ),
                ("$vwarhaa.wav", "Let's keep the ore moving", "War Miner", "Harvest", "", "Soviet"),
                ("$vwarhab.wav", "Da, we will need that", "War Miner", "Harvest", "", "Soviet"),
                (
                    "$vwarhac.wav",
                    "Looks like good place to mine",
                    "War Miner",
                    "Harvest",
                    "",
                    "Soviet",
                ),
                ("$vwarhad.wav", "Equal share for everyone", "War Miner", "Harvest", "", "Soviet"),
            )
        )
    )

    entries = load_audio_transcript(path)

    assert [entries[f"vchrha{suffix}"]["original_text"] for suffix in "abcde"] == [
        "You'll get the cash in a flash",
        "It's in the bank",
        "Mining",
        "Ah, there it is",
        "Rolling with a chrono convoy",
    ]
    assert [entries[f"vwarha{suffix}"]["original_text"] for suffix in "abcd"] == [
        "Equal share for everyone",
        "Let's keep the ore moving",
        "Da, we will need that",
        "Looks like good place to mine",
    ]
    assert entries["vwarhaa"]["unit"] == "War Miner"


def _audio_transcript_workbook(
    rows: tuple[tuple[str, str, str, str, str, str], ...] | None = None,
) -> bytes:
    selected_rows = rows or (("$giselea.wav", "Sir, yes sir!", "GI", "Select", "", "Allied"),)
    shared = ("File", "Line", "Unit", "Category", "Comments", "Faction")
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as workbook:
        workbook.writestr(
            "xl/sharedStrings.xml",
            "<?xml version='1.0' encoding='UTF-8'?>"
            "<sst xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'>"
            + "".join(f"<si><t>{value}</t></si>" for value in shared)
            + "</sst>",
        )
        workbook.writestr(
            "xl/workbook.xml",
            "<?xml version='1.0' encoding='UTF-8'?>"
            "<workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' "
            "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'>"
            "<sheets><sheet name='Complete List' sheetId='1' r:id='rId1'/></sheets>"
            "</workbook>",
        )
        workbook.writestr(
            "xl/_rels/workbook.xml.rels",
            "<?xml version='1.0' encoding='UTF-8'?>"
            "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>"
            "<Relationship Id='rId1' Type='worksheet' Target='worksheets/sheet1.xml'/>"
            "</Relationships>",
        )
        workbook.writestr(
            "xl/worksheets/sheet1.xml",
            "<?xml version='1.0' encoding='UTF-8'?>"
            "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'>"
            "<sheetData>"
            "<row r='1'>"
            + "".join(
                f"<c r='{column}1' t='s'><v>{index}</v></c>"
                for index, column in enumerate("ABCDEF")
            )
            + "</row>"
            + "".join(
                f"<row r='{row_index}'>"
                + "".join(
                    f"<c r='{column}{row_index}' t='inlineStr'><is><t>{value}</t></is></c>"
                    for column, value in zip("ABCDEF", row, strict=True)
                    if value
                )
                + "</row>"
                for row_index, row in enumerate(selected_rows, 2)
            )
            + "</sheetData></worksheet>",
        )
    return output.getvalue()
