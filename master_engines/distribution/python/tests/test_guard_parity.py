"""Byte-for-byte parity of the Python guard with the TypeScript guard, over the corpus generated from the TypeScript code.

``fixtures/guard_parity.json`` is written by ``scripts/generate_distribution_data.ts`` (named hostile cases plus a seeded
corpus); every ``expected`` value in it is what ``lib/_guards.ts`` returned for that input. A mismatch here means the
port and the TypeScript guard disagree, which is the one thing this layer must never allow.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from regulatory_engines import (
    MAX_BARE_STRING_UNITS,
    MAX_CANDIDATES,
    MAX_HAYSTACK_UNITS,
    MAX_KEYWORD_LENGTH,
    MAX_KEYWORDS,
    MAX_NORMALISE_PASSES,
    MAX_RAW_KEYWORD_UNITS,
    MIN_KEYWORD_LENGTH,
    describe_sanitization,
    find_keyword_match,
    load_registry,
    normalise_keyword,
    sanitize_keyword_list,
)
from regulatory_engines._guards import _INVISIBLE, REJECTION_REASONS
from regulatory_engines._js import utf16_length

FIXTURE = Path(__file__).parent / "fixtures" / "guard_parity.json"
CORPUS: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
SANITIZE = CORPUS["sanitize"]
NORMALISE = CORPUS["normalise"]
MATCH = CORPUS["match"]
ZERO_WIDTH = "\N{ZERO WIDTH SPACE}"


@pytest.mark.parametrize("case", SANITIZE, ids=[f"{index:03d}" for index in range(len(SANITIZE))])
def test_sanitize_matches_typescript(case: dict[str, Any]) -> None:
    result = sanitize_keyword_list(case["input"])
    assert result.to_dict() == case["expected"], case["name"]
    assert describe_sanitization(result) == case["description"], case["name"]


@pytest.mark.parametrize("case", NORMALISE, ids=[f"{index:03d}" for index in range(len(NORMALISE))])
def test_normalise_matches_typescript(case: dict[str, Any]) -> None:
    assert normalise_keyword(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", MATCH, ids=[f"{index:03d}" for index in range(len(MATCH))])
def test_match_matches_typescript(case: dict[str, Any]) -> None:
    assert find_keyword_match(case["haystack"], sanitize_keyword_list(case["keywords"])) == case["expected"], case["name"]


def test_corpus_is_large_and_seeded() -> None:
    assert len(SANITIZE) >= 400
    assert len(NORMALISE) >= 300
    assert len(MATCH) >= 200
    assert isinstance(CORPUS["seed"], int)
    assert sum(1 for case in SANITIZE if case["name"].startswith("seeded")) >= 300
    assert sum(1 for case in SANITIZE if not case["name"].startswith("seeded")) >= 100


def test_corpus_names_every_ghost_billing_input() -> None:
    inputs = [json.dumps(case["input"]) for case in SANITIZE if case["name"].startswith("ghost:")]
    for expected in ('[""]', '[" "]', '""', '"a"', '["a"]', "[]", "null"):
        assert expected in inputs


def test_corpus_exercises_every_rejection_reason_and_both_container_outcomes() -> None:
    reasons = {item["reason"] for case in SANITIZE for item in case["expected"]["rejected"]}
    assert reasons == set(REJECTION_REASONS)
    assert reasons == {"not_a_string", "empty_after_normalisation", "too_short", "too_long", "invalid_unicode", "no_letter_or_digit", "duplicate", "over_limit"}
    assert {case["expected"]["malformedContainer"] for case in SANITIZE} == {True, False}
    assert sum(1 for case in SANITIZE if case["expected"]["keywords"]) >= 200
    assert sum(1 for case in MATCH if case["expected"] is not None) >= 50
    assert sum(1 for case in MATCH if case["expected"] is None) >= 50


def test_corpus_covers_the_hard_unicode_cases() -> None:
    previews = [item["value"] for case in SANITIZE for item in case["expected"]["rejected"]]
    assert any(any(0xD800 <= ord(ch) <= 0xDFFF for ch in value) for value in previews), "a preview cut through a surrogate pair"
    keywords = [keyword for case in SANITIZE for keyword in case["expected"]["keywords"]]
    assert "ACME" in keywords, "fullwidth letters are NFKC-normalised"
    assert any("\u0307" in needle for case in SANITIZE for needle in case["expected"]["needles"]), "dotted capital I lowercases to i + combining dot"
    assert any(len(keyword) == MAX_KEYWORD_LENGTH for keyword in keywords)


def test_python_constants_equal_the_limits_generated_from_typescript() -> None:
    limits = load_registry().limits
    assert (MIN_KEYWORD_LENGTH, MAX_KEYWORD_LENGTH, MAX_KEYWORDS) == (limits.min_keyword_length, limits.max_keyword_length, limits.max_keywords)
    assert (MAX_RAW_KEYWORD_UNITS, MAX_CANDIDATES, MAX_BARE_STRING_UNITS, MAX_HAYSTACK_UNITS, MAX_NORMALISE_PASSES) == (
        limits.max_raw_keyword_units,
        limits.max_candidates,
        limits.max_bare_string_units,
        limits.max_haystack_units,
        limits.max_normalise_passes,
    )


def test_the_compiled_removal_expression_is_exactly_the_generated_ranges() -> None:
    ranges = load_registry().limits.removed_ranges
    inside = {code for first, last in ranges for code in (first, last, (first + last) // 2)}
    outside = {code for first, last in ranges for code in (first - 1, last + 1) if code >= 0 and not any(a <= code <= b for a, b in ranges) and not 0xD800 <= code <= 0xDFFF}
    assert len(inside) > 40 and len(outside) > 30
    for code in inside:
        assert _INVISIBLE.fullmatch(chr(code)), hex(code)
    for code in outside:
        assert not _INVISIBLE.fullmatch(chr(code)), hex(code)
    assert sum(1 for code in range(0x110000) if _INVISIBLE.fullmatch(chr(code))) == sum(last - first + 1 for first, last in ranges)


def named(name: str) -> dict[str, Any]:
    found = [case for case in SANITIZE if case["name"] == name]
    assert len(found) == 1, name
    return found[0]


def test_corpus_names_a_case_for_every_defect_class_of_the_rewritten_guard() -> None:
    def count(prefix: str) -> int:
        return sum(1 for case in SANITIZE if case["name"].startswith(prefix))

    assert count("unicode:") >= 15, "lone surrogates in every position"
    assert count("raw cap:") >= 7
    assert count("invisible:") >= 15
    assert count("fixpoint:") >= 9
    assert count("candidates:") + count("string:") >= 8
    for name in (
        "invisible: Hangul fillers only",
        "invisible: Arabic letter mark",
        "invisible: tag characters",
        "invisible: variation selectors",
        "invisible: Mongolian free variation selectors and vowel separator",
        "invisible: combining grapheme joiner",
        "invisible: Khmer inherent vowels",
    ):
        assert named(name)["expected"]["malformedContainer"] is False
    assert sum(1 for case in NORMALISE if "between two letters" in case["name"]) >= 40, "the ends, middles and neighbours of the 19 removed ranges"


def test_corpus_boundary_cases_test_what_they_claim_to() -> None:
    raw_cap = named("raw cap: 4096 units around a keyword are cleaned, 4097 are too_long")
    assert [utf16_length(text) for text in raw_cap["input"]] == [MAX_RAW_KEYWORD_UNITS, MAX_RAW_KEYWORD_UNITS + 1]
    assert raw_cap["expected"]["keywords"] == ["ab"] and [item["reason"] for item in raw_cap["expected"]["rejected"]] == ["too_long"]

    exactly = named("candidates: exactly 5000 entries are all inspected (no marker)")
    assert len(exactly["input"]) == MAX_CANDIDATES and exactly["expected"]["keywords"] == ["Acme Corp"]
    assert all(item["reason"] == "too_short" for item in exactly["expected"]["rejected"])

    beyond = named("candidates: the 5000th entry is inspected, the 5001st and later are one over_limit marker")
    assert len(beyond["input"]) == MAX_CANDIDATES + 2 and beyond["expected"]["keywords"] == ["Acme Corp"]
    assert beyond["expected"]["rejected"][-1] == {"value": "(2 further entries not inspected)", "reason": "over_limit"}

    whole = named("string: a bare string of exactly 200000 units is read whole, even when it ends in an astral character")
    assert utf16_length(whole["input"]) == MAX_BARE_STRING_UNITS and whole["expected"]["keywords"] == ["Alpha Corp", "Beta\U0001f600"]
    cut = named("string: a bare string longer than 200000 units is cut, and a pair straddling the cut is dropped whole")
    assert utf16_length(cut["input"]) > MAX_BARE_STRING_UNITS and cut["expected"]["keywords"] == ["Alpha Corp", "Beta"]

    every = named("invisible: a letter plus every removed code point is a one-letter keyword")
    count = sum(last - first + 1 for first, last in load_registry().limits.removed_ranges)
    assert len(every["input"]) == count and every["expected"]["keywords"] == []
    assert [item["reason"] for item in every["expected"]["rejected"]] == ["too_short"] * count

    by_name = {case["name"]: case for case in MATCH}
    assert by_name["cut: the keyword starts at unit 8000 and is found"]["expected"] == "Acme"
    assert by_name["cut: the keyword starts at unit 9000 and is not seen"]["expected"] is None
    assert by_name["cut: the keyword starts at unit 8000 and is found"]["haystack"].index("Acme") == 8000
    assert by_name["cut: the keyword starts at unit 9000 and is not seen"]["haystack"].index("Acme") == 9000
    assert by_name["cut: the keyword ends exactly at unit 8192 and is found"]["expected"] == "Acme"
    assert utf16_length(by_name["cut: the keyword ends exactly at unit 8192 and is found"]["haystack"]) == MAX_HAYSTACK_UNITS
    assert by_name["cut: the keyword ends one unit past 8192 and is not found"]["expected"] is None
    assert by_name["cut: astral characters count two units each (the keyword ends exactly at unit 8192)"]["expected"] == "Acme"
    assert by_name["cut: astral characters count two units each (the keyword ends one unit past 8192)"]["expected"] is None


def test_every_accepted_keyword_list_of_the_corpus_is_a_fixed_point_of_the_python_port_too() -> None:
    for case in SANITIZE:
        again = sanitize_keyword_list(case["expected"]["keywords"])
        assert (list(again.keywords), list(again.needles), again.rejected) == (case["expected"]["keywords"], case["expected"]["needles"], ()), case["name"]
    for case in NORMALISE:
        assert normalise_keyword(case["expected"]) == case["expected"], case["name"]
