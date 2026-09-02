from __future__ import annotations

import re
import threading
from functools import lru_cache
from typing import Literal

from opencc import OpenCC
from pypinyin import Style, lazy_pinyin

GameLanguage = Literal["zh-CN", "zh-TW"]
DEFAULT_GAME_LANGUAGE: GameLanguage = "zh-CN"

_converters = threading.local()
_SEARCH_CHARACTER_EQUIVALENTS = str.maketrans({"砲": "炮"})


def localize_game_text(value: str | None, language: GameLanguage) -> str | None:
    if value is None or language == "zh-TW":
        return value
    return _convert(value, "t2s")


def localized_search_match(query: str, text: str) -> bool:
    haystack = _canonical_search_text(text)
    return any(_canonical_search_text(variant) in haystack for variant in _query_variants(query))


def localized_fuzzy_search_match(query: str, text: str) -> bool:
    """Match a compact name query as an ordered, tightly bounded subsequence."""
    if localized_search_match(query, text):
        return True
    for variant in _query_variants(query):
        needle = _normalize_search_text(variant)
        if not _allows_fuzzy_match(needle):
            continue
        haystack = _normalize_search_text(text)
        if len(haystack) > max(64, len(needle) * 8):
            continue
        if _bounded_subsequence(needle, haystack) or _nearby_single_edit(needle, haystack):
            return True
    return False


def pinyin_search_aliases(value: str | None) -> dict[str, str] | None:
    """Return stable full-pinyin and initial aliases for a Chinese display name."""
    if not value or not any("\u3400" <= character <= "\u9fff" for character in value):
        return None
    return _pinyin_search_aliases(value)


def pinyin_search_match(query: str, *values: str | None) -> bool:
    """Match compact pinyin, spaced pinyin, or pinyin initials."""
    needle = _normalize_search_text(query)
    if len(needle) < 2 or not needle.isascii() or not needle.isalnum():
        return False
    for value in values:
        aliases = pinyin_search_aliases(value)
        if aliases is None:
            continue
        compact = aliases["pinyin_compact"]
        initials = aliases["pinyin_initials"]
        if needle in compact or needle in initials:
            return True
        if len(needle) >= 4 and _bounded_subsequence(needle, compact):
            return True
    return False


def localized_mixed_search_match(query: str, *values: str | None) -> bool:
    """Match every Chinese/Latin query segment across localized, English, ID, or pinyin values."""
    terms = _search_terms(query)
    searchable = tuple(value for value in values if value)
    if not terms or not searchable:
        return False
    return all(
        any(localized_fuzzy_search_match(term, value) for value in searchable)
        or pinyin_search_match(term, *searchable)
        for term in terms
    )


def _normalize_search_text(value: str) -> str:
    return "".join(character for character in _canonical_search_text(value) if character.isalnum())


def _canonical_search_text(value: str) -> str:
    return value.casefold().translate(_SEARCH_CHARACTER_EQUIVALENTS)


def _search_terms(value: str) -> tuple[str, ...]:
    return tuple(
        match.group(0).casefold() for match in re.finditer(r"[\u3400-\u9fff]+|[A-Za-z0-9]+", value)
    )


def _allows_fuzzy_match(value: str) -> bool:
    has_cjk = any("\u3400" <= character <= "\u9fff" for character in value)
    return len(value) >= (2 if has_cjk else 4)


def _bounded_subsequence(needle: str, haystack: str) -> bool:
    first = haystack.find(needle[0])
    while first >= 0:
        cursor = first
        for character in needle[1:]:
            cursor = haystack.find(character, cursor + 1)
            if cursor < 0:
                break
        else:
            if cursor - first + 1 <= max(len(needle) * 2, len(needle) + 2):
                return True
        first = haystack.find(needle[0], first + 1)
    return False


def _nearby_single_edit(needle: str, haystack: str) -> bool:
    has_cjk = any("\u3400" <= character <= "\u9fff" for character in needle)
    if len(needle) < (3 if has_cjk else 5):
        return False
    for width in range(max(1, len(needle) - 1), len(needle) + 2):
        for start in range(0, len(haystack) - width + 1):
            if _single_edit_or_transposition(needle, haystack[start : start + width]):
                return True
    return False


def _single_edit_or_transposition(left: str, right: str) -> bool:
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        differences = [
            index for index, pair in enumerate(zip(left, right, strict=True)) if pair[0] != pair[1]
        ]
        if len(differences) <= 1:
            return True
        return (
            len(differences) == 2
            and differences[1] == differences[0] + 1
            and left[differences[0]] == right[differences[1]]
            and left[differences[1]] == right[differences[0]]
        )
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    mismatch = 0
    short_index = 0
    for long_index, character in enumerate(longer):
        if short_index < len(shorter) and shorter[short_index] == character:
            short_index += 1
            continue
        mismatch += 1
        if mismatch > 1:
            return False
        if long_index == len(longer) - 1:
            return True
    return True


@lru_cache(maxsize=2_048)
def _query_variants(query: str) -> tuple[str, ...]:
    values = (query, _convert(query, "t2s"), _convert(query, "s2t"))
    return tuple(dict.fromkeys(value.casefold() for value in values if value))


@lru_cache(maxsize=16_384)
def _pinyin_search_aliases(value: str) -> dict[str, str]:
    syllables = lazy_pinyin(value, style=Style.NORMAL, errors="ignore")
    initials = lazy_pinyin(value, style=Style.FIRST_LETTER, errors="ignore")
    return {
        "pinyin": " ".join(syllables),
        "pinyin_compact": "".join(syllables),
        "pinyin_initials": "".join(initials),
    }


@lru_cache(maxsize=16_384)
def _convert(value: str, configuration: str) -> str:
    converter = getattr(_converters, configuration, None)
    if converter is None:
        converter = OpenCC(configuration)
        setattr(_converters, configuration, converter)
    return converter.convert(value)


__all__ = [
    "DEFAULT_GAME_LANGUAGE",
    "GameLanguage",
    "localized_fuzzy_search_match",
    "localized_mixed_search_match",
    "localized_search_match",
    "localize_game_text",
    "pinyin_search_aliases",
    "pinyin_search_match",
]
