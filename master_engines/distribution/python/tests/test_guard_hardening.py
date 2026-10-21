"""Hand-derived expectations for what the rewritten TypeScript guard added: lone surrogates, the raw cap, the removed-character table, cleaning to a
fixed point, the candidate cap, the bare-string and haystack cuts, and a guard that never raises.

Like ``test_guard_unit.py`` these do not read the parity fixture: each expected value is written down from the rules in ``lib/_guards.ts``,
so a regenerated fixture that drifted together with the port would still be caught here.
"""

from __future__ import annotations

import json
import random
import time
import unicodedata
from pathlib import Path
from typing import Any

import pytest

from regulatory_engines import (
    MAX_BARE_STRING_UNITS,
    MAX_CANDIDATES,
    MAX_COMBINING_RUN,
    MAX_HAYSTACK_UNITS,
    MAX_KEYWORDS,
    MAX_NORMALISE_PASSES,
    MAX_RAW_KEYWORD_UNITS,
    MAX_TOTAL_RAW_UNITS,
    REGTECH,
    RejectedKeyword,
    SanitizedKeywordList,
    build_run_request,
    describe_sanitization,
    find_keyword_match,
    load_registry,
    normalise_keyword,
    sanitize_keyword_list,
)
from regulatory_engines import _guards
from regulatory_engines._guards import REJECTION_REASONS, is_supplied
from regulatory_engines._js import has_surrogate, to_js_string, utf16_cut, utf16_length
from regulatory_engines.registry import _parse_ranges

DATA = Path(__file__).resolve().parents[1] / "src" / "regulatory_engines" / "data" / "engines.json"
ZERO_WIDTH = "\N{ZERO WIDTH SPACE}"
EMOJI = "\U0001f600"
ACUTE = "\u0301"
HIGH, LOW = "\ud83d", "\ude00"  # the two halves of EMOJI, as two code points of their own


def reasons(result: SanitizedKeywordList) -> list[str]:
    return [item.reason for item in result.rejected]


# ---- defect 1: a lone surrogate is invalid_unicode, checked before any cleaning ------------------------------------------------


def test_invalid_unicode_is_a_rejection_reason_between_too_long_and_no_letter_or_digit() -> None:
    assert REJECTION_REASONS == (
        "not_a_string",
        "empty_after_normalisation",
        "too_short",
        "too_long",
        "invalid_unicode",
        "no_letter_or_digit",
        "duplicate",
        "over_limit",
    )


LONE_SURROGATE_KEYWORDS = ["\ud800", "\udc00", "\ud800Acme", "Ac\ud800me", "Acme\ud800", "\udc00Acme", "Ac\udc00me", "Acme\udc00", "Ac\ud83d\ud83dme", "Ac\ude00\ude00me", "Ac\ude00\ud83dme"]


@pytest.mark.parametrize("keyword", LONE_SURROGATE_KEYWORDS, ids=[ascii(keyword) for keyword in LONE_SURROGATE_KEYWORDS])
def test_a_lone_surrogate_in_any_position_rejects_the_keyword_as_invalid_unicode(keyword: str) -> None:
    result = sanitize_keyword_list(["Acme Corp", keyword])
    assert result.keywords == ("Acme Corp",)
    assert [(item.value, item.reason) for item in result.rejected] == [(keyword, "invalid_unicode")]


def test_a_well_formed_pair_is_not_a_lone_surrogate_however_it_is_held() -> None:
    # One code point, and two halves held side by side as two code points: both are the one astral character JavaScript reads.
    assert sanitize_keyword_list(["Ac" + EMOJI + "me", "Beta" + HIGH + LOW]).keywords == ("Ac" + EMOJI + "me", "Beta" + EMOJI)
    assert not has_surrogate("Ac" + EMOJI + "me")
    assert has_surrogate("Beta" + HIGH + LOW) and not has_surrogate(to_js_string("Beta" + HIGH + LOW))


def test_halves_kept_apart_by_an_invisible_character_are_two_lone_surrogates() -> None:
    assert reasons(sanitize_keyword_list(["\ud83d" + ZERO_WIDTH + "\ude00", "Acme\ud83d" + ZERO_WIDTH + "\ude00"])) == ["invalid_unicode", "invalid_unicode"]


def test_invalid_unicode_is_decided_before_the_cleaning_rules_and_after_the_raw_cap() -> None:
    result = sanitize_keyword_list(
        [
            "a" * (MAX_RAW_KEYWORD_UNITS - 1) + "\ud800",  # exactly 4096 units: not too long, but a lone surrogate
            "a" * MAX_RAW_KEYWORD_UNITS + "\ud800",  # 4097 units: too_long wins
            ZERO_WIDTH + "\ud800" + ZERO_WIDTH,  # would be empty or too short once cleaned
            "\ud800a",  # would be too_short once cleaned
            "a" * 300 + "\ud800",  # would be too_long once cleaned
            "\ud800",
        ]
    )
    assert reasons(result) == ["invalid_unicode", "too_long", "invalid_unicode", "invalid_unicode", "invalid_unicode", "invalid_unicode"]


def test_a_lone_surrogate_in_a_bare_string_rejects_only_its_own_piece() -> None:
    result = sanitize_keyword_list("Acme,Be\ud800ta;Gamma")
    assert result.keywords == ("Acme", "Gamma")
    assert [(item.value, item.reason) for item in result.rejected] == [("Be\ud800ta", "invalid_unicode")]
    assert reasons(sanitize_keyword_list("\ud800")) == ["invalid_unicode"]


def test_a_keyword_with_a_lone_surrogate_never_matches_half_an_astral_character() -> None:
    for keyword in ("a\ud83d", "\ude00b", "\ud83d", "\ude00"):
        watchlist = sanitize_keyword_list([keyword, "Beta"])
        assert watchlist.keywords == ("Beta",)
        assert find_keyword_match("xa" + EMOJI + "by", watchlist) is None


# ---- defect 2: a raw keyword over 4096 UTF-16 units is too_long before any Unicode work ----------------------------------------


def test_a_raw_keyword_over_4096_units_is_too_long_even_when_its_cleaned_form_would_be_fine() -> None:
    fits = ZERO_WIDTH * (MAX_RAW_KEYWORD_UNITS - 2) + "ab"
    over = ZERO_WIDTH * (MAX_RAW_KEYWORD_UNITS - 1) + "cd"
    assert (utf16_length(fits), utf16_length(over)) == (4096, 4097)
    result = sanitize_keyword_list([fits, over])
    assert result.keywords == ("ab",)
    assert [(item.value, item.reason) for item in result.rejected] == [(ZERO_WIDTH * 57 + "...", "too_long")]


def test_the_raw_cap_counts_utf16_units_not_code_points() -> None:
    tag = "\U000e0020"  # a default-ignorable tag character: two UTF-16 units, one code point
    fits = tag * (MAX_RAW_KEYWORD_UNITS // 2 - 1) + "ab"
    over = tag * (MAX_RAW_KEYWORD_UNITS // 2 - 1) + "abc"
    assert (len(fits), len(over)) == (2049, 2050) and (utf16_length(fits), utf16_length(over)) == (4096, 4097)
    assert sanitize_keyword_list([fits]).keywords == ("ab",)
    assert reasons(sanitize_keyword_list([over])) == ["too_long"]


def test_the_raw_cap_is_checked_per_entry_and_before_the_empty_and_blank_rules() -> None:
    result = sanitize_keyword_list([ZERO_WIDTH * (MAX_RAW_KEYWORD_UNITS + 50), " " * 5000, "a" + "\u0301" * 9000, "a" * 4096, "a" * 4097])
    assert reasons(result) == ["too_long"] * 5
    several = [ZERO_WIDTH * (MAX_RAW_KEYWORD_UNITS - 2) + word for word in ("ab", "cd", "ef")]
    assert sanitize_keyword_list(several).keywords == ("ab", "cd", "ef")


def test_a_giant_entry_is_rejected_without_being_encoded_or_previewed_whole() -> None:
    result = sanitize_keyword_list(["x" * 5_000_000, "Acme"])
    assert result.keywords == ("Acme",)
    assert [(item.value, item.reason) for item in result.rejected] == [("x" * 57 + "...", "too_long")]


# ---- defect 3: the removed-character table comes from engines.json, not from unicodedata ---------------------------------------


def removed(code_point: int) -> bool:
    return any(first <= code_point <= last for first, last in load_registry().limits.removed_ranges)


# What the old hand-typed list missed, plus controls and the ends of the ranges it did have.
REMOVED_SAMPLES = [
    0x00, 0x01, 0x1F, 0x7F, 0x80, 0x9F, 0xAD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B, 0x180C, 0x180D, 0x180E, 0x180F, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067, 0x2068, 0x2069, 0x206A, 0x206F, 0x3164, 0xFE00, 0xFE0F, 0xFEFF, 0xFFA0,
    0xFFF0, 0xFFF8, 0x1BCA0, 0x1BCA3, 0x1D173, 0x1D17A, 0xE0000, 0xE0001, 0xE0020, 0xE007F, 0xE0100, 0xE01EF, 0xE0FFF,
]  # fmt: skip
# Next to a removed range and NOT removed (code points assigned in Unicode 14, so every supported Python agrees).
KEPT_SAMPLES = [0x20, 0xA0, 0xAC, 0xAE, 0x34E, 0x350, 0x61B, 0x61D, 0x115E, 0x1161, 0x17B3, 0x17B6, 0x180A, 0x1810, 0x200A, 0x2010, 0x2029, 0x202F, 0x205F, 0x2070, 0x3163, 0x3165, 0xFDFF, 0xFF9F, 0xFFA1, 0xFFF9, 0x1BC9F, 0x1D172, 0x1D17B]  # fmt: skip


@pytest.mark.parametrize("code_point", REMOVED_SAMPLES, ids=[f"U+{cp:04X}" for cp in REMOVED_SAMPLES])
def test_every_removed_character_vanishes_and_a_letter_plus_one_is_a_one_letter_keyword(code_point: int) -> None:
    assert removed(code_point)
    char = chr(code_point)
    if char in "\t\n\x0b\x0c\r\x85":  # whitespace controls become a space BEFORE the removal; the trim then drops it from the end
        assert normalise_keyword("a" + char + "b") == "a b"
    else:
        assert normalise_keyword("a" + char + "b") == "ab"
    assert reasons(sanitize_keyword_list(["a" + char])) == ["too_short"]
    assert reasons(sanitize_keyword_list([char, char + char])) == ["empty_after_normalisation"] * 2


@pytest.mark.parametrize("code_point", KEPT_SAMPLES, ids=[f"U+{cp:04X}" for cp in KEPT_SAMPLES])
def test_the_code_points_next_to_a_removed_range_are_not_removed(code_point: int) -> None:
    assert not removed(code_point)
    assert normalise_keyword("a" + chr(code_point) + "b") != "ab"


def test_the_ranges_are_the_ones_in_engines_json_and_nothing_else_decides_what_is_invisible(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = json.loads(DATA.read_text(encoding="ascii"))["limits"]["watchlist"]["removedRanges"]
    assert [list(pair) for pair in load_registry().limits.removed_ranges] == raw
    assert raw[0][0] == 0 and raw[-1][1] == 0xE0FFF
    assert "Ac" + ZERO_WIDTH + "me" != "Acme" and normalise_keyword("Ac" + ZERO_WIDTH + "me") == "Acme"
    # Swap the compiled table for one without U+200B: the character then survives, which proves the removal is driven by the table.
    monkeypatch.setattr(_guards, "_INVISIBLE", _guards._removed_expression(tuple(pair for pair in load_registry().limits.removed_ranges if not pair[0] <= 0x200B <= pair[1])))
    assert normalise_keyword("Ac" + ZERO_WIDTH + "me") == "Ac" + ZERO_WIDTH + "me"


def test_invisible_characters_that_the_old_list_missed_no_longer_make_a_keyword_longer() -> None:
    result = sanitize_keyword_list(
        [
            "a\u061c",  # Arabic letter mark
            "a\u3164",  # Hangul filler
            "\u115f\u1160\u3164\uffa0",  # only Hangul fillers
            "a\u034f",  # combining grapheme joiner
            "a\u17b4",  # Khmer inherent vowel
            "a\ufe0f",  # variation selector
            "a\U000e0067",  # tag character
            "Ac\u180bme",  # Mongolian free variation selector
        ]
    )
    assert result.keywords == ("Acme",)
    assert reasons(result) == ["too_short", "too_short", "empty_after_normalisation", "too_short", "too_short", "too_short", "too_short"]


def test_the_removed_ranges_are_validated_when_they_are_loaded() -> None:
    assert _parse_ranges([[0, 31], [127, 159]]) == ((0, 31), (127, 159))
    for bad in ([], [[5, 3]], [[0, 5], [5, 9]], [[0, 5], [6, 9]], [[9, 12], [0, 3]], [[0xD7FF, 0xD800]], [[0xDC00, 0xDC00]], [[0, 0x110000]], [[-1, 3]]):
        with pytest.raises(ValueError, match="removedRanges"):
            _parse_ranges(bad)


# ---- defect 4: cleaning runs to a fixed point, so the guard is idempotent -----------------------------------------------------


def test_cleaning_runs_until_nothing_changes() -> None:
    # "e", ZERO WIDTH SPACE, COMBINING ACUTE: the first pass leaves "e" + U+0301 (NFKC ran before the space went), the second composes U+00E9.
    assert normalise_keyword("e" + ZERO_WIDTH + "\u0301") == "\u00e9"
    assert normalise_keyword("a" + ZERO_WIDTH + "\u0301\u0301") == "\u00e1\u0301"
    # CHOSEONG HIEUH, ZWSP, JUNGSEONG A, ZWSP, JONGSEONG NIEUN: three jamo after one pass, the single syllable U+D55C after two.
    assert normalise_keyword("\u1112" + ZERO_WIDTH + "\u1161" + ZERO_WIDTH + "\u11ab") == "\ud55c"
    assert normalise_keyword("e\u3164\u0301") == "\u00e9"
    assert normalise_keyword("\uff45" + ZERO_WIDTH + "\u0301") == "\u00e9"


def test_a_keyword_that_a_second_pass_shortens_is_judged_as_its_settled_text_at_once() -> None:
    result = sanitize_keyword_list(["e" + ZERO_WIDTH + "\u0301", "a" + ZERO_WIDTH + "\u0301\u0301", "Acme"])
    assert result.keywords == ("\u00e1\u0301", "Acme")
    assert [(item.value, item.reason) for item in result.rejected] == [("e" + ZERO_WIDTH + "\u0301", "too_short")]
    assert describe_sanitization(result) == "watchlistNames: 2 accepted, 1 rejected (too_short=1)."


def test_sanitising_what_a_sanitise_returned_accepts_all_of_it_and_rejects_nothing() -> None:
    # This is why the client no longer cleans the list a second time: by construction the second pass is the identity.
    rng = random.Random(20261021)
    pieces = [
        "a", "e", "Acme", "\u00e9", "\u0301", "\u0308", "\u0323", "\u0345", ZERO_WIDTH, "\u00ad", "\u2060", "\ufeff", "\u061c", "\u034f", "\u115f", "\u1160", "\u3164", "\uffa0", "\u17b4",
        "\u180b", "\ufe0f", "\U000e0100", "\U000e0067", " ", "\t", "\u3000", "\u1112", "\u1161", "\u11ab", "\u1100", "\u1175", "\u11a8", "\uff21", "\uff45", "\uff9e", "\u3099", "\ufb03",
        "\u2126", "\u212a", "-", "7", EMOJI, "\ud800", "\udc00", "\u202e", "\u2066", "\u2065", "\ufff0", "\u0000", "\u0085", "\u2028",
    ]  # fmt: skip
    for _ in range(2500):
        value = ["".join(rng.choice(pieces) for _ in range(rng.randint(0, 8))) for _ in range(rng.randint(1, 4))]
        first = sanitize_keyword_list(value)
        again = sanitize_keyword_list(list(first.keywords))
        assert (again.keywords, again.needles, again.rejected) == (first.keywords, first.needles, ()), value
        for text in value:
            once = normalise_keyword(text)
            assert normalise_keyword(once) == once, text


def test_a_text_that_has_not_settled_after_eight_passes_becomes_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    original = _guards._clean_once

    def settles_after(changes: int) -> Any:
        # appends an "x" until the text holds `changes` of them: it settles after that many changing passes plus one pass that changes nothing
        return lambda text: (lambda base: base + "x" if base.count("x") < changes else base)(original(text))

    monkeypatch.setattr(_guards, "_clean_once", settles_after(MAX_NORMALISE_PASSES - 1))
    assert normalise_keyword("ab") == "ab" + "x" * 7
    assert sanitize_keyword_list(["ab"]).keywords == ("ab" + "x" * 7,)
    monkeypatch.setattr(_guards, "_clean_once", settles_after(MAX_NORMALISE_PASSES))
    assert normalise_keyword("ab") == ""
    result = sanitize_keyword_list(["ab", "Acme"])
    assert result.keywords == () and reasons(result) == ["empty_after_normalisation"] * 2
    hand_built = SanitizedKeywordList(keywords=("Acme",), needles=("acme",), rejected=(), malformed_container=False)
    assert find_keyword_match("Acme Corp", hand_built) is None, "a hostile haystack is never matched"
    monkeypatch.setattr(_guards, "_clean_once", settles_after(MAX_NORMALISE_PASSES - 1))
    assert find_keyword_match("Acme Corp", hand_built) == "Acme"


def test_the_client_sends_the_settled_keywords_without_a_second_cleaning_pass() -> None:
    watchlist = ["e" + ZERO_WIDTH + "\u0301", "a" + ZERO_WIDTH + "\u0301\u0301", "Acme"]
    prepared = build_run_request(REGTECH, owner="o", sources=["ofac"], max_total_charge_usd=1, watchlist_names=watchlist)
    sent = prepared.run_input["watchlistNames"]
    assert sent == ["\u00e1\u0301", "Acme"]
    assert sanitize_keyword_list(sent).keywords == tuple(sent)
    assert prepared.watchlist.keywords == tuple(sent)
    assert not hasattr(_guards, "settle_keyword_list")


# ---- defect 5: at most 5000 entries are inspected; a bare string is cut at 200000 units first -----------------------------------


def test_at_most_5000_entries_are_inspected_and_the_rest_is_one_over_limit_entry() -> None:
    junk = ["a"] * (MAX_CANDIDATES - 1)
    exactly = sanitize_keyword_list([*junk, "Acme Corp"])
    assert exactly.keywords == ("Acme Corp",)
    assert reasons(exactly) == ["too_short"] * (MAX_CANDIDATES - 1)

    beyond = sanitize_keyword_list([*junk, "Acme Corp", "Beta Corp", {"k": 1}, 7])
    assert beyond.keywords == ("Acme Corp",)
    assert beyond.rejected[-1] == RejectedKeyword("(3 further entries not inspected)", "over_limit")
    assert len(beyond.rejected) == MAX_CANDIDATES
    assert describe_sanitization(beyond) == "watchlistNames: 1 accepted, 5000 rejected (too_short=4999, over_limit=1)."

    assert sanitize_keyword_list([*junk, "Acme Corp", "x"]).rejected[-1] == RejectedKeyword("(1 further entries not inspected)", "over_limit")
    assert sanitize_keyword_list(tuple([*junk, "Acme Corp", "Beta Corp"])).keywords == ("Acme Corp",)


def test_the_marker_is_the_only_trace_of_the_entries_that_were_not_read() -> None:
    # Entries past the cap are not even looked at: an object whose preview would raise, and a string that would be accepted, leave nothing behind.
    class Unreadable:
        def __init__(self) -> None:
            self.touched = 0

        def __repr__(self) -> str:
            self.touched += 1
            raise RuntimeError("must not be read")

    guard = Unreadable()
    result = sanitize_keyword_list(["a"] * MAX_CANDIDATES + [guard, "Zeta Corp"])
    assert result.keywords == ()
    assert result.rejected[-1] == RejectedKeyword("(2 further entries not inspected)", "over_limit")
    assert guard.touched == 0


def test_a_bare_string_of_5002_pieces_is_cut_to_5000_candidates() -> None:
    pieces = [f"kw{index}" if index < 3 else "a" for index in range(MAX_CANDIDATES + 2)]
    result = sanitize_keyword_list(",".join(pieces))
    assert result.keywords == ("kw0", "kw1", "kw2")
    assert reasons(result) == ["too_short"] * (MAX_CANDIDATES - 3) + ["over_limit"]
    assert result.rejected[-1].value == "(2 further entries not inspected)"


def test_a_bare_string_longer_than_200000_units_is_cut_its_last_piece_dropped_and_one_marker_added() -> None:
    marker = f"(bare string cut at {MAX_BARE_STRING_UNITS} units; its last entry was dropped)"
    # the window ends in the high half of an astral character: the half goes, and so does the (complete) last piece, and Gamma Corp is never read
    straddle = " " * (MAX_BARE_STRING_UNITS - 17) + ",Alpha Corp,Beta" + EMOJI + ",Gamma Corp"
    assert utf16_length(straddle) == MAX_BARE_STRING_UNITS + 12
    result = sanitize_keyword_list(straddle)
    assert result.keywords == ("Alpha Corp",)
    assert [(item.value, item.reason) for item in result.rejected] == [(" " * 57 + "...", "too_long"), (marker, "over_limit")]

    # the cut falls inside the last piece: "Pfizer Inc" -> "Pfizer In" must not become a keyword
    pfizer = sanitize_keyword_list(" " * (MAX_BARE_STRING_UNITS - 21) + ",Alpha Corp,Pfizer Inc")
    assert pfizer.keywords == ("Alpha Corp",)
    assert pfizer.rejected[-1] == RejectedKeyword(marker, "over_limit")

    # no separator in the window: the one piece is dropped and only the marker is left
    nothing = sanitize_keyword_list("a" * (MAX_BARE_STRING_UNITS + 1))
    assert nothing.keywords == () and nothing.rejected == (RejectedKeyword(marker, "over_limit"),)
    assert describe_sanitization(nothing) == "watchlistNames: 0 accepted, 1 rejected (over_limit=1)."
    assert sanitize_keyword_list("Acme," + "b" * 300_000).keywords == ("Acme",), "the long tail is gone, and so is the piece the cut truncated"

    # the window ends exactly on a separator: the dropped piece is the empty one
    on_separator = sanitize_keyword_list(" " * (MAX_BARE_STRING_UNITS - 12) + ",Alpha Corp,Beta Ltd")
    assert on_separator.keywords == ("Alpha Corp",) and reasons(on_separator) == ["too_long", "over_limit"]

    # exactly 200000 units is not cut: nothing is dropped and there is no marker
    whole = " " * (MAX_BARE_STRING_UNITS - 18) + ",Alpha Corp,Beta" + EMOJI
    assert utf16_length(whole) == MAX_BARE_STRING_UNITS
    assert sanitize_keyword_list(whole).keywords == ("Alpha Corp", "Beta" + EMOJI)
    assert reasons(sanitize_keyword_list(whole)) == ["too_long"]
    assert reasons(sanitize_keyword_list(" " * (MAX_BARE_STRING_UNITS - 12) + ",Alpha Corp,")) == ["too_long", "empty_after_normalisation"]

    # both markers, in this order: the entries that were not inspected, then the cut
    many = sanitize_keyword_list("a," * (MAX_BARE_STRING_UNITS // 2 + 1))
    assert [item.value for item in many.rejected[-2:]] == [f"({MAX_BARE_STRING_UNITS // 2 - MAX_CANDIDATES} further entries not inspected)", marker]
    assert reasons(many) == ["too_short"] * MAX_CANDIDATES + ["over_limit", "over_limit"]


def test_utf16_cut_never_ends_in_half_a_pair() -> None:
    assert utf16_cut("ab" + EMOJI, 3) == "ab"
    assert utf16_cut("ab" + EMOJI, 4) == "ab" + EMOJI
    assert utf16_cut("abc", 3) == "abc" and utf16_cut("abcd", 3) == "abc" and utf16_cut("", 3) == ""
    assert utf16_cut("ab\ud83dc", 3) == "ab", "a lone high surrogate on the last kept unit is given up as well, as in TypeScript"
    assert utf16_cut("a\ude00b", 2) == "a\ude00", "a low surrogate on the last kept unit stays"
    assert utf16_cut((HIGH + LOW) * 3, 3) == EMOJI, "halves held as separate code points"
    assert utf16_cut(EMOJI * 100_000, 1000) == EMOJI * 500
    assert utf16_cut("x" * 1_000_000, 10) == "x" * 10


def test_a_haystack_of_up_to_8192_units_is_searched_whole_a_longer_one_up_to_its_last_whitespace_inside_the_window() -> None:
    watchlist = sanitize_keyword_list(["Acme"])

    def at(offset: int) -> str:
        return "z" * offset + "Acme"

    assert find_keyword_match(at(8000), watchlist) == "Acme"
    assert find_keyword_match(at(MAX_HAYSTACK_UNITS - 4), watchlist) == "Acme", "exactly 8192 units: searched whole, with or without whitespace"
    assert find_keyword_match(at(MAX_HAYSTACK_UNITS - 3), watchlist) is None, "8193 units and no whitespace: not searched at all"
    assert find_keyword_match("Acme" + "z" * 9000, watchlist) is None, "even though the keyword is at the very start"
    assert find_keyword_match("z" * 9000 + " Acme", watchlist) is None, "whitespace beyond the window does not help"
    assert find_keyword_match("Acme" + "z" * 1_000_000, watchlist) is None, "a giant haystack without whitespace is not searched (and not processed whole)"
    assert find_keyword_match("z" * 8188 + "Acme Corp", watchlist) == "Acme", "whitespace on unit 8192, the first unit past the window: the whole window is searched"
    assert find_keyword_match("z" * 8187 + "Acme X" + "z" * 20, watchlist) == "Acme", "whitespace on unit 8191"
    assert find_keyword_match("z" * 8186 + " Acme" + "z" * 20, watchlist) is None, "the last whitespace inside the window is before the keyword"
    beta = sanitize_keyword_list(["Beta"])
    assert find_keyword_match("Acme Beta " + "y" * 8200, beta) == "Beta", "the searched text ends at the LAST whitespace inside the window"
    assert find_keyword_match("Acme Beta " + "y" * 8200, sanitize_keyword_list(["yyyy"])) is None
    assert find_keyword_match("Acme Corp " + "z" * 9000 + " Beta", sanitize_keyword_list(["Beta", "Acme"])) == "Acme"
    # invisible characters are not whitespace, and use up units
    assert find_keyword_match(ZERO_WIDTH * MAX_HAYSTACK_UNITS + "Acme", watchlist) is None
    assert find_keyword_match("Ac" + ZERO_WIDTH * (MAX_HAYSTACK_UNITS - 2) + "me", watchlist) is None
    assert find_keyword_match("Ac" + ZERO_WIDTH * 4000 + "me", watchlist) == "Acme"
    # astral characters are two units each, so 100 of them move the end of the keyword from unit 8192 to 8193
    fits = "z" * (MAX_HAYSTACK_UNITS - 4 - 200) + EMOJI * 100 + "Acme"
    assert utf16_length(fits) == MAX_HAYSTACK_UNITS
    assert find_keyword_match(fits, watchlist) == "Acme"
    assert find_keyword_match("z" + fits, watchlist) is None, "the window is counted in UTF-16 units, not code points"
    both = sanitize_keyword_list(["Acme", "z" + EMOJI])
    assert find_keyword_match(("z" + EMOJI) * 2730 + " Acme" + "z" * 25, both) == "z" + EMOJI


def test_only_the_unicode_white_space_characters_cut_a_long_haystack() -> None:
    watchlist = sanitize_keyword_list(["Acme"])
    for code in (0x09, 0x0A, 0x0D, 0x85, 0xA0, 0x1680, 0x2003, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000):
        assert find_keyword_match("Acme" + chr(code) + "z" * (MAX_HAYSTACK_UNITS - 2), watchlist) == "Acme", hex(code)
    for code in (0x200B, 0xFEFF, 0x180E, 0x2060, 0xAD, 0x200D, 0x34F, 0x2D):
        assert find_keyword_match("Acme" + chr(code) + "z" * (MAX_HAYSTACK_UNITS - 2), watchlist) is None, hex(code)
    ranges = load_registry().limits.white_space_ranges
    assert sum(last - first + 1 for first, last in ranges) == 25 and (0x85, 0x85) in ranges and not any(first <= 0xFEFF <= last for first, last in ranges)


def test_the_searched_window_is_exactly_the_text_before_the_last_white_space_at_unit_8192_or_earlier() -> None:
    # Cleaning trims a trailing whitespace character, so a window that wrongly kept it would still match the same haystacks: pin the text itself.
    limit = MAX_HAYSTACK_UNITS
    whole = "ab cd" * 1000
    assert len(whole) == 5000 and _guards._cut_haystack(whole) == whole, "5000 units: whole"
    exact = ("a" * 99 + " ") * 81 + "b" * 92
    assert len(exact) == limit and _guards._cut_haystack(exact) == exact, "exactly 8192 units: whole, whatever it ends with"
    spaced = "z" * 100 + " " + "y" * 8100
    assert len(spaced) > limit and _guards._cut_haystack(spaced) == "z" * 100, "the text before the one whitespace character, which is not part of it"
    at_limit = "q" * limit + " " + "tail"
    assert _guards._cut_haystack(at_limit) == "q" * limit, "whitespace on unit 8192 (the first unit past the window): the whole window"
    last = "q" * 10 + "\u3000" + "r" * 8000 + "\u2028" + "s" * 500
    assert _guards._cut_haystack(last) == "q" * 10 + "\u3000" + "r" * 8000, "the LAST whitespace inside the window ends it; the earlier one stays in"
    assert _guards._cut_haystack("z" * (limit + 1)) == "" and _guards._cut_haystack("z" * 1_000_000) == "", "no whitespace in the window: nothing is searched"
    for code in (0x85, 0xA0, 0x2028):
        assert _guards._cut_haystack("k" * 7000 + chr(code) + "m" * 3000) == "k" * 7000, hex(code)
    before_space = "z" * (limit - 100) + EMOJI * 50
    assert utf16_length(before_space) == limit
    assert _guards._cut_haystack(before_space + " " + "y" * 200) == before_space, "counted in UTF-16 units: the whitespace is on unit 8192"
    pair_apart = "z" * (limit - 1) + EMOJI + " tail"
    assert _guards._cut_haystack(pair_apart) == "", "a window whose only whitespace lies beyond it, with a pair straddling unit 8192, is not searched"


def test_a_combining_accent_just_past_the_window_no_longer_creates_a_hit_for_the_unaccented_word() -> None:
    watchlist = sanitize_keyword_list(["cafe"])
    # "cafe" ends on unit 8191 and U+0301 is unit 8192: the old blind cut searched "...cafe" and hit; the whole text says "cafe" + U+0301, i.e. e-acute
    haystack = "z" * (MAX_HAYSTACK_UNITS - 5) + " cafe" + ACUTE + " Paris"
    assert haystack[MAX_HAYSTACK_UNITS] == ACUTE
    assert find_keyword_match(haystack, watchlist) is None
    inside = "z" * (MAX_HAYSTACK_UNITS - 20) + " cafe" + ACUTE + " Paris" + "z" * 30
    assert find_keyword_match(inside, sanitize_keyword_list(["cafe", "caf\u00e9"])) == "caf\u00e9"


def test_a_haystack_with_more_than_16_consecutive_marks_in_the_searched_text_is_never_matched() -> None:
    watchlist = sanitize_keyword_list(["Acme"])
    assert find_keyword_match("Acme Corp b" + ACUTE * 16, watchlist) == "Acme"
    assert find_keyword_match("Acme Corp b" + ACUTE * 17, watchlist) is None, "even the keyword before the run is lost: the whole text is empty"
    assert find_keyword_match("Acme Corp b" + (ACUTE + ZERO_WIDTH) * 17, watchlist) is None, "a run that only exists after removal"
    assert find_keyword_match("Acme Corp b" + (ACUTE + ZERO_WIDTH) * 16, watchlist) == "Acme"
    assert find_keyword_match("Acme " + "\u0345" * 1365 + "\u0300" * 1365 + "\u0316" * 1364, watchlist) is None
    assert find_keyword_match("Acme " + ("a" + ACUTE) * 50, watchlist) == "Acme", "marks between letters never form a run"
    # a run beyond the cut is never seen; one inside the searched text hides it
    assert find_keyword_match("z" * (MAX_HAYSTACK_UNITS - 12) + " Acme b" + ACUTE * 17, watchlist) == "Acme"
    assert find_keyword_match("z" * (MAX_HAYSTACK_UNITS - 40) + " b" + ACUTE * 17 + " Corp Acme" + "z" * 40, sanitize_keyword_list(["zzzz"])) is None


def test_a_keyword_list_is_accepted_up_to_500_and_read_up_to_5000() -> None:
    numbered = [f"kw{index:04d}" for index in range(MAX_KEYWORDS)]
    assert find_keyword_match("Zeta Corp", sanitize_keyword_list([*numbered[:-1], "Zeta Corp"])) == "Zeta Corp"
    assert find_keyword_match("Zeta Corp", sanitize_keyword_list([*numbered, "Zeta Corp"])) is None
    junk = ["a"] * (MAX_CANDIDATES - 1)
    assert find_keyword_match("Beta Corp", sanitize_keyword_list([*junk, "Beta Corp"])) == "Beta Corp"
    assert find_keyword_match("Beta Corp", sanitize_keyword_list([*junk, "a", "Beta Corp"])) is None


# ---- rule A: a text with more than 16 consecutive combining marks (\p{M}) is empty, tested before every pass's NFKC ------------------------------------------


def test_more_than_sixteen_consecutive_combining_marks_make_a_text_empty_before_it_is_normalised() -> None:
    assert MAX_COMBINING_RUN == 16
    assert normalise_keyword("b" + ACUTE * 16) == "b" + ACUTE * 16
    assert normalise_keyword("b" + ACUTE * 17) == ""
    mixed = "\u0301\u0308\u0323\u0300\u0345\u0316\u0483\u0903\u20dd\u0488\u093c\u3099\u0951\u0952\u0e31\u0e47\u0e48"
    assert len(mixed) == 17 and {unicodedata.category(mark) for mark in mixed} == {"Mn", "Mc", "Me"}
    assert normalise_keyword("a" + mixed) == ""
    assert normalise_keyword("a" + mixed[:-1]) != ""
    for mark in ("\u0903", "\u20dd"):  # a spacing mark and an enclosing mark count like a non-spacing one
        assert normalise_keyword("b" + mark * 17) == ""
        assert normalise_keyword("b" + mark * 16) == "b" + mark * 16
    assert normalise_keyword(("a" + ACUTE) * 40) == "\u00e1" * 40, "marks kept apart by letters never form a run"
    assert normalise_keyword(ZERO_WIDTH * 17 + "ab") == "ab", "invisible characters that are not marks are simply removed"


def test_the_run_is_tested_on_every_pass_so_a_run_that_removal_exposes_is_caught() -> None:
    assert normalise_keyword("b" + (ACUTE + ZERO_WIDTH) * 17) == ""  # "b" does not compose with U+0301: 17 marks are consecutive once the spaces are gone
    assert normalise_keyword("b" + (ACUTE + ZERO_WIDTH) * 16) == "b" + ACUTE * 16
    assert normalise_keyword("a" + (ACUTE + ZERO_WIDTH) * 17) == "\u00e1" + ACUTE * 16  # "a" composes with the first mark, so 16 remain
    assert normalise_keyword("a" + (ACUTE + ZERO_WIDTH) * 18) == ""
    assert normalise_keyword("ab" + "\uff9e" * 17) == ""  # NFKC turns the halfwidth voiced sound marks into 17 combining marks, which the next pass finds
    assert normalise_keyword("ab" + "\uff9e" * 16) == "ab" + "\u3099" * 16


def test_variation_selectors_and_the_combining_grapheme_joiner_are_marks_so_their_run_is_seen_before_removal() -> None:
    result = sanitize_keyword_list(["a" + "\ufe0f" * 17, "a" + "\ufe0f" * 16, "Acme" + "\u034f" * 17, "Acme" + "\u034f" * 16, "\U000e0100" * 17 + "ab", "\U000e0100" * 16 + "ab"])
    assert result.keywords == ("Acme", "ab")
    assert reasons(result) == ["empty_after_normalisation", "too_short", "empty_after_normalisation", "empty_after_normalisation"]


def test_a_long_run_is_empty_after_normalisation_when_the_keyword_is_within_the_raw_cap_and_too_long_above_it() -> None:
    result = sanitize_keyword_list(["ab" + ACUTE * 4000, "ab" + ACUTE * 4094, "ab" + ACUTE * 4095])
    assert reasons(result) == ["empty_after_normalisation", "empty_after_normalisation", "too_long"]


def test_the_descending_class_attack_shape_is_empty_at_once_and_a_short_one_is_normalised() -> None:
    attack = "ab" + "\u0345" * 1365 + "\u0300" * 1365 + "\u0316" * 1364
    assert utf16_length(attack) == MAX_RAW_KEYWORD_UNITS
    short = "cd" + "\u0345" * 6 + "\u0300" * 5 + "\u0316" * 5
    result = sanitize_keyword_list([attack, short])
    assert reasons(result) == ["empty_after_normalisation"]
    assert result.keywords == (normalise_keyword(short),) and result.keywords[0].startswith("cd")
    started = time.perf_counter()
    sanitize_keyword_list([attack] * 48)
    assert time.perf_counter() - started < 2.0, "48 of them (just under the total budget) cost milliseconds"


def test_the_combining_run_check_looks_at_code_points_and_never_at_the_ascii_fast_path() -> None:
    assert _guards._has_long_combining_run("a" * 100) is False
    assert _guards._has_long_combining_run(ACUTE * 16) is False and _guards._has_long_combining_run(ACUTE * 17) is True
    assert _guards._has_long_combining_run("\U000e0100" * 17) is True, "an astral mark is one code point"
    assert _guards._has_long_combining_run(ACUTE * 10 + "x" + ACUTE * 10) is False
    assert _guards._has_long_combining_run("\ud800" * 40) is False, "a lone surrogate is not a mark"
    assert all(unicodedata.category(chr(code)).startswith("M") for code in (0x300, 0x903, 0x20DD, 0xFE0F, 0x34F, 0xE0100))


# ---- rule E: the string entries of a list add up to at most 200000 units -------------------------------------------------------------------------


def test_the_string_entries_of_a_list_add_up_to_at_most_200000_units() -> None:
    assert MAX_TOTAL_RAW_UNITS == 200000
    exact = ["Acme", *["a" * MAX_RAW_KEYWORD_UNITS] * 48, "b" * (MAX_TOTAL_RAW_UNITS - 4 - 48 * MAX_RAW_KEYWORD_UNITS)]
    at_the_limit = sanitize_keyword_list(exact)
    assert at_the_limit.keywords == ("Acme",) and reasons(at_the_limit) == ["too_long"] * 49, "exactly 200000 units: every entry is inspected"
    over = sanitize_keyword_list([*exact, "Z"])
    assert reasons(over) == ["too_long"] * 49 + ["over_limit"]
    assert over.rejected[-1] == RejectedKeyword("(1 further entries not inspected)", "over_limit"), "one unit more: that entry is not inspected"
    crossing = sanitize_keyword_list(["a" * (MAX_RAW_KEYWORD_UNITS - 4)] * 49)
    assert reasons(crossing) == ["too_long"] * 48 + ["over_limit"], "the 49th entry of 4092 units crosses the budget"
    assert describe_sanitization(crossing) == "watchlistNames: 0 accepted, 49 rejected (too_long=48, over_limit=1)."


def test_strings_over_the_raw_cap_cost_no_budget_and_non_strings_cost_nothing() -> None:
    big = "a" * (MAX_RAW_KEYWORD_UNITS + 1)
    reads = sanitize_keyword_list([*[big] * (MAX_CANDIDATES - 1), "Acme Corp"])
    assert reads.keywords == ("Acme Corp",) and reasons(reads) == ["too_long"] * (MAX_CANDIDATES - 1), "4999 oversize strings (20 million units) use no budget"
    capped = sanitize_keyword_list([*[big] * MAX_CANDIDATES, "Acme Corp"])
    assert capped.keywords == () and reasons(capped) == ["too_long"] * MAX_CANDIDATES + ["over_limit"]
    assert capped.rejected[-1].value == "(1 further entries not inspected)", "the 5000 entry cap, not the budget, stopped it"
    mixed = [None, 1, {"k": 1}, "c" * 5000, *["a" * MAX_RAW_KEYWORD_UNITS] * 48, [1, 2], "d" * (MAX_TOTAL_RAW_UNITS - 48 * MAX_RAW_KEYWORD_UNITS), 7, "Acme", "Beta Corp", None]
    result = sanitize_keyword_list(mixed)
    assert result.keywords == ()
    assert reasons(result) == ["not_a_string"] * 3 + ["too_long"] * 49 + ["not_a_string", "too_long", "not_a_string", "over_limit"]
    assert result.rejected[-1].value == "(3 further entries not inspected)", "the entry that crosses the budget and everything after it, non-strings included"


def test_the_budget_counts_utf16_units_not_code_points() -> None:
    astral = "\U0001d400" * (MAX_RAW_KEYWORD_UNITS // 2)  # 2048 code points, 4096 units
    assert (len(astral), utf16_length(astral)) == (2048, 4096)
    result = sanitize_keyword_list([astral] * 49 + ["Acme"])
    assert reasons(result) == ["too_long"] * 48 + ["over_limit"]
    assert result.rejected[-1].value == "(2 further entries not inspected)"


def test_the_budget_is_met_before_the_candidate_cap_by_big_entries_and_after_it_by_small_ones() -> None:
    small = sanitize_keyword_list(["a"] * (MAX_CANDIDATES + 3))
    assert small.rejected[-1].value == "(3 further entries not inspected)"
    big = sanitize_keyword_list(["a" * 4000] * 100)
    assert big.rejected[-1].value == "(50 further entries not inspected)", "50 entries of 4000 units are exactly 200000"
    assert len(big.rejected) == 51


# ---- defect 7: the guard never raises ------------------------------------------------------------------------------------------


class _Boom(RuntimeError):
    pass


class _UnsizedList(list[Any]):
    def __len__(self) -> int:
        raise _Boom("length")


class _UniterableList(list[Any]):
    def __iter__(self) -> Any:
        raise _Boom("iteration")


class _Unprintable:
    def __repr__(self) -> str:
        raise _Boom("repr")

    __str__ = __repr__


class _Shapeshifter:
    @property  # type: ignore[misc]
    def __class__(self) -> Any:
        raise _Boom("__class__")


class _ExplodingDict(dict[str, Any]):
    def items(self) -> Any:
        raise _Boom("items")


def _unsized() -> Any:
    return _UnsizedList(["Acme"])


def _uniterable() -> Any:
    return _UniterableList(["Acme"])


@pytest.mark.parametrize("make", [_unsized, _uniterable, _Shapeshifter], ids=["len raises", "iteration raises", "__class__ raises"])
def test_a_container_that_cannot_be_read_disables_the_watchlist_and_never_raises(make: Any) -> None:
    result = sanitize_keyword_list(make())
    assert result == SanitizedKeywordList((), (), (RejectedKeyword("[unreadable value]", "not_a_string"),), True)
    assert describe_sanitization(result) == "watchlistNames: unsupported value type; watchlist disabled (0 keywords)."
    assert find_keyword_match("Acme Corp", result) is None


def test_an_element_that_cannot_be_read_is_one_rejected_entry_and_the_rest_of_the_list_survives() -> None:
    result = sanitize_keyword_list(["Acme Corp", _Unprintable(), _Shapeshifter(), _ExplodingDict(a=1), "Beta Corp"])
    assert result.keywords == ("Acme Corp", "Beta Corp")
    assert [(item.value, item.reason) for item in result.rejected] == [
        ("[object Object]", "not_a_string"),
        ("[unreadable value]", "not_a_string"),
        ("[object Object]", "not_a_string"),
    ]


def test_a_value_that_cannot_be_inspected_counts_as_supplied_so_the_client_never_runs_unfiltered_silently() -> None:
    assert is_supplied(_UnsizedList(["Acme"])) is True
    with pytest.warns(Warning, match="NO watchlist"):
        prepared = build_run_request(REGTECH, owner="o", sources=["ofac"], max_total_charge_usd=1, watchlist_names=_UnsizedList(["Acme"]))
    assert "watchlistNames" not in prepared.run_input


# ---- Unicode versions: what the committed corpus may contain -------------------------------------------------------------------


def test_the_parity_corpus_contains_no_character_that_is_unassigned_in_this_pythons_unicode() -> None:
    """Python 3.11 ships Unicode 14.0, Node 22 ships 16.0. A character assigned after 14.0 could be normalised or classified differently on an older Python, so the corpus avoids
    them. Run on the oldest supported Python this proves it for Unicode 14.0; run on a newer one it only proves it for that one (the README says which versions were run).
    The removed code points are exempt: their table comes from engines.json, and several of them are deliberately unassigned (U+2065, U+FFF0-U+FFF8, most tag code points)."""
    import unicodedata

    corpus = json.loads((Path(__file__).parent / "fixtures" / "guard_parity.json").read_text(encoding="utf-8"))
    seen: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, str):
            seen.update(value)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                walk(key)
                walk(item)

    walk(corpus)
    assert len(seen) > 4000
    unassigned = sorted(f"U+{ord(ch):04X}" for ch in seen if not 0xD800 <= ord(ch) <= 0xDFFF and unicodedata.category(ch) == "Cn" and not removed(ord(ch)))
    assert unassigned == []
