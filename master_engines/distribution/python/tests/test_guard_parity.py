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
    MAX_COMBINING_RUN,
    MAX_HAYSTACK_UNITS,
    MAX_KEYWORD_LENGTH,
    MAX_KEYWORDS,
    MAX_NORMALISE_PASSES,
    MAX_RAW_KEYWORD_UNITS,
    MAX_TOTAL_RAW_UNITS,
    MIN_KEYWORD_LENGTH,
    describe_sanitization,
    find_keyword_match,
    load_registry,
    normalise_keyword,
    sanitize_keyword_list,
)
from regulatory_engines import _guards
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
    assert reasons == {"not_a_string", "empty_after_normalisation", "too_short", "too_long", "invalid_unicode", "no_letter_or_digit", "single_letter_or_digit", "duplicate", "over_limit"}
    assert {case["expected"]["malformedContainer"] for case in SANITIZE} == {True, False}
    assert sum(1 for case in SANITIZE if case["expected"]["keywords"]) >= 200
    assert sum(1 for case in MATCH if case["expected"] is not None) >= 50
    assert sum(1 for case in MATCH if case["expected"] is None) >= 50


def test_corpus_covers_the_hard_unicode_cases() -> None:
    previews = [item["value"] for case in SANITIZE for item in case["expected"]["rejected"]]
    assert any("\ufffd" in value for value in previews), "a lone surrogate or a control character shown as U+FFFD"
    assert any(ord(ch) > 0xFFFF for value in previews for ch in value), "an astral character kept whole by the cut at 57 units"
    assert not any(0xD800 <= ord(ch) <= 0xDFFF or ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F for value in previews for ch in value), "a preview is log-safe"
    assert {"[null]", "[array]", "[object]", "[number]", "[boolean]"} <= set(previews), "a non-string is a constant tag"
    keywords = [keyword for case in SANITIZE for keyword in case["expected"]["keywords"]]
    assert "ACME" in keywords, "fullwidth letters are NFKC-normalised"
    assert any("\u0307" in needle for case in SANITIZE for needle in case["expected"]["needles"]), "dotted capital I lowercases to i + combining dot"
    assert any(len(keyword) == MAX_KEYWORD_LENGTH for keyword in keywords)


def test_python_constants_equal_the_limits_generated_from_typescript() -> None:
    limits = load_registry().limits
    assert (MIN_KEYWORD_LENGTH, MAX_KEYWORD_LENGTH, MAX_KEYWORDS) == (limits.min_keyword_length, limits.max_keyword_length, limits.max_keywords)
    assert (MAX_RAW_KEYWORD_UNITS, MAX_CANDIDATES, MAX_BARE_STRING_UNITS, MAX_HAYSTACK_UNITS, MAX_NORMALISE_PASSES, MAX_COMBINING_RUN, MAX_TOTAL_RAW_UNITS) == (
        limits.max_raw_keyword_units,
        limits.max_candidates,
        limits.max_bare_string_units,
        limits.max_haystack_units,
        limits.max_normalise_passes,
        limits.max_combining_run,
        limits.max_total_raw_units,
    )
    assert _guards._WHITE_SPACE == {code for first, last in limits.white_space_ranges for code in range(first, last + 1)}


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
    assert count("marks:") >= 12 and count("total:") >= 3 and count("preview:") >= 3
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

    marker = f"(bare string cut at {MAX_BARE_STRING_UNITS} units; its last entry was dropped)"
    whole = named("string: a bare string of exactly 200000 units is read whole, even when it ends in an astral character")
    assert utf16_length(whole["input"]) == MAX_BARE_STRING_UNITS and whole["expected"]["keywords"] == ["Alpha Corp", "Beta\U0001f600"]
    assert [item["reason"] for item in whole["expected"]["rejected"]] == ["too_long"], "nothing dropped, no marker"
    straddle = named("string: 200012 units, the window ends in the high half of an astral character: the half and the last piece are dropped")
    assert utf16_length(straddle["input"]) == MAX_BARE_STRING_UNITS + 12 and straddle["expected"]["keywords"] == ["Alpha Corp"]
    assert straddle["expected"]["rejected"][-1] == {"value": marker, "reason": "over_limit"}
    pfizer = named("string: 200001 units, the cut falls inside the last piece, which is dropped")
    assert pfizer["input"].endswith("Pfizer Inc") and utf16_length(pfizer["input"]) == MAX_BARE_STRING_UNITS + 1 and pfizer["expected"]["keywords"] == ["Alpha Corp"]
    bare = named("string: 200001 units with no separator in the window: nothing is left but the marker")
    assert bare["expected"]["keywords"] == [] and bare["expected"]["rejected"] == [{"value": marker, "reason": "over_limit"}]

    exact = named("total: strings adding up to exactly 200000 units are all inspected, a one-unit entry after them is not (one marker)")
    assert sum(utf16_length(text) for text in exact["input"][:-1]) == MAX_TOTAL_RAW_UNITS and exact["input"][-1] == "Z"
    assert exact["expected"]["keywords"] == ["Acme"]
    assert [item["reason"] for item in exact["expected"]["rejected"]] == ["too_long"] * 49 + ["over_limit"]
    assert exact["expected"]["rejected"][-1]["value"] == "(1 further entries not inspected)"
    crossing = named("total: 49 entries of 4092 units, the 49th crosses the budget")
    assert [utf16_length(text) for text in crossing["input"]] == [MAX_RAW_KEYWORD_UNITS - 4] * 49
    assert [item["reason"] for item in crossing["expected"]["rejected"]] == ["too_long"] * 48 + ["over_limit"]
    mixed = named("total: entries that are not strings add nothing, nothing after the crossing entry is inspected (not even a later non-string)")
    assert mixed["expected"]["rejected"][-1]["value"] == "(3 further entries not inspected)" and mixed["expected"]["keywords"] == []
    counted = [text for text in mixed["input"][:-3] if isinstance(text, str) and utf16_length(text) <= MAX_RAW_KEYWORD_UNITS]
    assert sum(utf16_length(text) for text in counted) == MAX_TOTAL_RAW_UNITS

    run = named("marks: 16 consecutive combining marks are fine, 17 make the keyword empty")
    assert len(run["expected"]["keywords"]) == 3 and [item["reason"] for item in run["expected"]["rejected"]] == ["empty_after_normalisation"] * 2
    second_pass = named("marks: removal exposes a run on the second pass (the base does not compose with the first mark)")
    assert len(second_pass["expected"]["keywords"]) == 2 and [item["reason"] for item in second_pass["expected"]["rejected"]] == ["empty_after_normalisation"]
    attack = named("marks: the descending-class attack shape (NFKC must reorder it) is empty at once")
    assert utf16_length(attack["input"][0]) == MAX_RAW_KEYWORD_UNITS and [item["reason"] for item in attack["expected"]["rejected"]] == ["empty_after_normalisation"]

    previews = named("preview: an astral character straddling unit 57 is dropped whole, one ending on unit 57 is kept, short values are not cut")
    assert [item["value"] for item in previews["expected"]["rejected"]] == [
        "-" * 56 + "...",
        "-" * 55 + "\U0001f600...",
        "-" * 57 + "\U0001f600",
        "-" * 58 + "\U0001f600",
        "-" * 57 + "...",
        "-" * 56 + "...",
    ]

    every = named("invisible: a letter plus every removed code point is a one-letter keyword")
    count = sum(last - first + 1 for first, last in load_registry().limits.removed_ranges)
    assert len(every["input"]) == count and every["expected"]["keywords"] == []
    assert [item["reason"] for item in every["expected"]["rejected"]] == ["too_short"] * count

    by_name = {case["name"]: case for case in MATCH}
    found, nothing = "Acme", None
    for name, expected in [
        ("cut: a haystack of exactly 8192 units is searched whole", found),
        ("cut: the keyword starts at unit 8000 and the haystack is shorter than the window", found),
        ("cut: 8193 units without whitespace are not searched at all (the keyword ends on the last unit)", nothing),
        ("cut: 9004 units without whitespace are not searched at all (the keyword is at the start)", nothing),
        ("cut: whitespace beyond the window does not help", nothing),
        ("cut: whitespace on unit 8192, the first unit past the window: the whole window is searched", found),
        ("cut: whitespace on unit 8191: the keyword before it is found", found),
        ("cut: the last whitespace inside the window is before the keyword: it is not found", nothing),
        ("cut: the searched text ends at the LAST whitespace inside the window (a word before it is found)", "Beta"),
        ("cut: the searched text ends at the LAST whitespace inside the window (a word after it is not)", nothing),
        ("cut: astral characters count two units each (the haystack is exactly 8192 units)", found),
        ("cut: astral characters count two units each (8193 units and no whitespace)", nothing),
        ("cut: astral characters before the cut count two units each", "z\U0001f600z"),
        ("cut: a combining accent just beyond the window no longer creates a hit for the unaccented word", nothing),
        ("cut: the accented word inside the window is the accented word", "caf\u00e9"),
        ("marks: 16 marks in a haystack are fine and the keyword before them is found", found),
        ("marks: 17 marks in the haystack are cut to 16, so the keyword before them is still found", found),
        ("marks: 17 marks kept apart by zero-width spaces are a run once cleaning removes them; it is cut, the keyword is found", found),
        ("marks: a run beyond the cut is never seen, so the keyword before the cut is found", found),
        ("marks: a run inside the searched text is cut to 16 marks; the words around it are still searched", "zzzz"),
        ("marks: marks glued to the last letter compose with it, so the unaccented keyword is not in the text", nothing),
        ("marks: marks after a space are cut and the keyword before the space is found", "acme"),
        ("marks: cutting a run cannot invent a hit: the accent stays on the letter", nothing),
        ("expansion: a field of U+FDFA ligatures is cut out, the keyword after it is found", "acme"),
        ("expansion: a field past the allowance is cut out, the keyword next to it is found", "acme"),
        ("expansion: a window of ligatures with the name beyond the 8192-unit cut is not searched", nothing),
        ("expansion: a name between two fields of ligatures", "Acme Holdings"),
        ("expansion: nothing matches across a cut-out ligature (spaced keyword)", nothing),
        ("expansion: nothing matches across a cut-out ligature (fused keyword)", nothing),
        ("expansion: the other characters that expand more than 4x (U+FDFB, square units) are cut out as well", "Acme Holdings"),
    ]:
        assert by_name[name]["expected"] == expected, name
    assert utf16_length(by_name["cut: a haystack of exactly 8192 units is searched whole"]["haystack"]) == MAX_HAYSTACK_UNITS
    assert by_name["cut: the keyword starts at unit 8000 and the haystack is shorter than the window"]["haystack"].index("Acme") == 8000
    assert by_name["cut: whitespace on unit 8192, the first unit past the window: the whole window is searched"]["haystack"][MAX_HAYSTACK_UNITS] == " "
    accent = by_name["cut: a combining accent just beyond the window no longer creates a hit for the unaccented word"]["haystack"]
    assert accent[MAX_HAYSTACK_UNITS] == "\u0301" and accent[:MAX_HAYSTACK_UNITS].endswith("cafe")
    families = [case for case in MATCH if case["name"].endswith("as the only whitespace in a long haystack")]
    assert len(families) >= 15
    for case in families:
        assert case["expected"] == ("Acme" if case["haystack"][4] in " \t\n\r\x0b\x0c\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000" else None), case["name"]


def test_every_accepted_keyword_list_of_the_corpus_is_a_fixed_point_of_the_python_port_too() -> None:
    for case in SANITIZE:
        again = sanitize_keyword_list(case["expected"]["keywords"])
        assert (list(again.keywords), list(again.needles), again.rejected) == (case["expected"]["keywords"], case["expected"]["needles"], ()), case["name"]
    for case in NORMALISE:
        assert normalise_keyword(case["expected"]) == case["expected"], case["name"]
