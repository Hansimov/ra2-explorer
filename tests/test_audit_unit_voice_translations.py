from scripts.audit_unit_voice_translations import (
    missing_translations_for_original,
    translation_format_violations,
)


def _entry(original: str, translation: str) -> dict[str, object]:
    return {
        "original_texts": [original],
        "translated_texts": [translation],
    }


def test_translation_format_accepts_dialogue_and_matching_nonverbal_cues() -> None:
    entries = {
        "dialogue": _entry("Ready, commander.", "准备就绪，指挥官。"),
        "nonverbal": _entry("<maniacal laughter>", "<癫狂大笑>"),
        "mixed": _entry("<whispering> Nobody here.", "<低声耳语>这里没人。"),
        "asterisk": _entry("*Whimp*", "<呜咽声>"),
    }

    assert translation_format_violations(entries) == []


def test_translation_format_rejects_missing_nonverbal_cue_brackets() -> None:
    entries = {"voice": _entry("<cry>", "哭喊")}

    assert translation_format_violations(entries) == [
        {
            "stem": "voice",
            "reason": "missing-cue",
            "original": "<cry>",
            "translation": "哭喊",
        }
    ]


def test_translation_format_rejects_angle_brackets_on_dialogue() -> None:
    entries = {"voice": _entry("Ready, commander.", "<准备就绪，指挥官。>")}

    assert translation_format_violations(entries) == [
        {
            "stem": "voice",
            "reason": "unexpected-cue",
            "original": "Ready, commander.",
            "translation": "<准备就绪，指挥官。>",
        }
    ]


def test_translation_format_rejects_terminal_punctuation_mismatch() -> None:
    entries = {
        "missing": _entry("Hold position", "坚守阵地。"),
        "wrong": _entry("Ready?", "准备好了！"),
    }

    assert translation_format_violations(entries) == [
        {
            "stem": "missing",
            "reason": "terminal-punctuation",
            "original": "Hold position",
            "translation": "坚守阵地。",
        },
        {
            "stem": "wrong",
            "reason": "terminal-punctuation",
            "original": "Ready?",
            "translation": "准备好了！",
        },
    ]


def test_missing_translation_gate_only_targets_entries_with_original_text() -> None:
    entries = {
        "complete": _entry("Ready.", "准备就绪。"),
        "missing": {"original_texts": ["Move out!"], "translated_texts": []},
        "nonverbal_without_original": {
            "original_texts": [],
            "translated_texts": ["<机械声>"],
        },
    }

    assert missing_translations_for_original(entries) == ["missing"]
