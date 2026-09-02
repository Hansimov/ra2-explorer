from scripts.audit_unit_voice_translations import translation_format_violations


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
