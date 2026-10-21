"""Hand-derived expectations for the third round of the guard review (an independent adversarial review of ``lib/_guards.ts``).

Like ``test_guard_unit.py`` and ``test_guard_hardening.py`` these never read the parity fixture: every expected value is written down from the rules
in ``lib/_guards.ts``, so a regenerated fixture that drifted together with the port would still be caught here.

Each test names the review finding it pins: F1 constant-time previews, F2 one alphanumeric character, F3 one visible glyph that NFKC expands,
F4 the NFKC expansion cap, F5 never raising, F6 the needle floor of a hand-built list, F7 a haystack run of marks is cut, F9 log-safe previews.
"""

from __future__ import annotations

import time
import unicodedata
from typing import Any

import pytest

from regulatory_engines import (
    MAX_KEYWORDS,
    SanitizedKeywordList,
    describe_sanitization,
    find_keyword_match,
    normalise_keyword,
    sanitize_keyword_list,
)
from regulatory_engines._guards import _cut_mark_runs, _preview
from regulatory_engines._js import utf16_length

FDFA = "ﷺ"  # ARABIC LIGATURE SALLALLAHOU ALAYHE WASALLAM: one character that NFKC expands to 18
ACUTE = "́"
ZERO_WIDTH = "​"


def reasons(result: SanitizedKeywordList) -> list[str]:
    return [item.reason for item in result.rejected]


def forged(*needles: str) -> SanitizedKeywordList:
    return SanitizedKeywordList(keywords=needles, needles=needles, rejected=(), malformed_container=False)


# ---- F1 / F9: a preview is constant time and log-safe ----------------------------------------------------------------------------


def test_a_deeply_nested_or_huge_rejected_value_is_a_constant_tag_and_costs_nothing() -> None:
    deep: list[Any] = []
    for _ in range(900):
        deep = [deep]
    wide = list(range(100_000))
    started = time.perf_counter()
    result = sanitize_keyword_list([deep] * 5_000)
    sanitize_keyword_list([wide] * 5_000)
    assert time.perf_counter() - started < 1.0
    assert [item.value for item in result.rejected] == ["[array]"] * 5_000
    assert set(reasons(result)) == {"not_a_string"}


@pytest.mark.parametrize(
    ("value", "tag"),
    [(None, "[null]"), ([], "[array]"), ((1, 2), "[array]"), ({}, "[object]"), ({"a": [1]}, "[object]"), (7, "[number]"), (1.5, "[number]"), (True, "[boolean]"), (False, "[boolean]")],
)
def test_a_non_string_is_previewed_as_a_constant_tag(value: Any, tag: str) -> None:
    assert _preview(value) == tag
    assert sanitize_keyword_list([value]).rejected[0].value == tag


def test_a_string_preview_replaces_controls_invisibles_and_lone_surrogates() -> None:
    assert _preview("\x1b[31mred") == "�[31mred"
    assert _preview("a‮b\u0000c") == "a�b�c"
    assert _preview("x\ud800y") == "x�y"
    assert _preview("​​") == "��"
    assert _preview("plain text") == "plain text"
    assert _preview("\U0001f600 kept whole") == "\U0001f600 kept whole", "a well-formed astral character is not a lone surrogate"


def test_a_long_string_preview_is_cut_at_57_units_and_then_cleaned() -> None:
    assert _preview("\x1b" + "x" * 100) == "�" + "x" * 56 + "..."
    assert _preview("x" * 60) == "x" * 60
    assert _preview("x" * 61) == "x" * 57 + "..."
    assert _preview("-" * 56 + "\U0001f600" + "-" * 5) == "-" * 56 + "..."


def test_the_review_reproduction_of_a_log_injection_is_neutralised() -> None:
    value = sanitize_keyword_list(["\ud800\u001b[31m\nFAKE"]).rejected[0].value
    assert value == "��[31m�FAKE"
    assert all(ord(char) >= 0x20 and not 0x7F <= ord(char) <= 0x9F for char in value)


# ---- F2: one letter or digit padded with punctuation is the one-letter needle in disguise ------------------------------------------


@pytest.mark.parametrize("padded", ["c.", "d.", "a.", "(a)", "a |", "-0", ".0", "1)", "A-", "(1)", "..a", "aͅ"])
def test_one_letter_or_digit_with_punctuation_is_rejected(padded: str) -> None:
    result = sanitize_keyword_list([padded])
    assert result.keywords == ()
    assert reasons(result) == ["single_letter_or_digit"]
    assert find_keyword_match("Pfizer Inc. | Acme Ltd. | S.A. 2024-01-02", result) is None


@pytest.mark.parametrize("kept", ["BP", "GE", "3M", "a.b", "a-1", "(ab)", "1.2", "S.A."])
def test_two_letters_or_digits_are_enough_wherever_the_punctuation_sits(kept: str) -> None:
    assert sanitize_keyword_list([kept]).keywords == (kept,)


def test_a_pasted_company_list_keeps_the_names_and_drops_the_legal_form_fragments() -> None:
    result = sanitize_keyword_list("Smith, J.\nBrown, A.; Acme Corp")
    assert result.keywords == ("Smith", "Brown", "Acme Corp")
    assert reasons(result) == ["single_letter_or_digit", "single_letter_or_digit"]
    assert find_keyword_match("Banco Santander S.A.", result) is None
    assert describe_sanitization(result) == "watchlistNames: 3 accepted, 2 rejected (single_letter_or_digit=2)."


def test_the_checks_run_in_the_order_of_the_typescript_guard() -> None:
    result = sanitize_keyword_list(["-" * 201, "-", "a" + "-" * 200, "ab" + "-" * 199, "--", "x"])
    assert reasons(result) == ["no_letter_or_digit", "too_short", "single_letter_or_digit", "too_long", "no_letter_or_digit", "too_short"]


# ---- F3: one visible glyph that NFKC expands is one character ---------------------------------------------------------------------


@pytest.mark.parametrize("glyph", ["⑳", "№", "ﬁ", "⑴", "⒜", "⒈", FDFA, "½", "①", "⑳​", "​№", "ﬁ­"])
def test_one_visible_glyph_that_nfkc_expands_is_too_short(glyph: str) -> None:
    result = sanitize_keyword_list([glyph])
    assert result.keywords == ()
    assert reasons(result) == ["too_short"]


def test_two_expanding_glyphs_are_two_characters_and_match_their_expansion() -> None:
    result = sanitize_keyword_list(["⑳⑳", "№№"])
    assert result.keywords == ("2020", "NoNo")
    assert find_keyword_match("Annual report 2020", result) == "2020"
    assert find_keyword_match("Annual report 2020", sanitize_keyword_list(["⑳"])) is None


# ---- F4: the NFKC expansion cap ---------------------------------------------------------------------------------------------------


def test_a_text_that_nfkc_grows_past_four_times_its_length_plus_16_units_is_empty() -> None:
    # the allowance is on UTF-16 units: n ligatures grow to 18n, which exceeds 4n + 16 from n = 2 on
    assert normalise_keyword(FDFA) != "", "one ligature: 18 units against 1 * 4 + 16 = 20 is inside the allowance"
    assert normalise_keyword(FDFA * 2) == "", "36 units against 24"
    assert normalise_keyword(FDFA * 40) == ""
    assert normalise_keyword(FDFA + "a" * 30) != "", "an ordinary text holding one ligature is fine"
    assert normalise_keyword(FDFA * 3 + "abcd") == ""
    assert reasons(sanitize_keyword_list([FDFA * 11, FDFA * 12, FDFA * 40])) == ["empty_after_normalisation"] * 3


def test_a_hostile_list_of_ligatures_costs_well_under_a_second() -> None:
    started = time.perf_counter()
    for entries in ([FDFA * 4_000 + "e" + ZERO_WIDTH + ACUTE] * 48, [FDFA * 39 + "e" + ZERO_WIDTH + ACUTE] * 5_000, [FDFA * 4_096] * 48):
        result = sanitize_keyword_list(entries)
        assert result.keywords == ()
    assert time.perf_counter() - started < 5.0, "generous bound for a slow runner; the TypeScript guard needs well under a second"


def test_a_field_of_ligatures_is_cut_out_and_hides_no_name_in_another_field() -> None:
    watchlist = sanitize_keyword_list(["acme"])
    assert find_keyword_match(FDFA * 8_000 + " acme", watchlist) == "acme"
    assert find_keyword_match(FDFA * 8 + " acme corp", watchlist) == "acme"
    assert find_keyword_match("Acme " + FDFA, watchlist) == "acme", "one ligature next to a name is inside the allowance"
    assert find_keyword_match(f"{FDFA * 100} | Acme Holdings | {FDFA * 100}", sanitize_keyword_list(["Acme Holdings"])) == "Acme Holdings"
    # a haystack that is nothing but the field has nothing to find, and nothing can match across a cut-out character
    assert find_keyword_match(FDFA * 8_000, watchlist) is None
    for joined in ("Acme" + FDFA + "Holdings", "Acme " + FDFA + " Holdings", "Acme" + FDFA * 50 + "Holdings"):
        assert find_keyword_match(joined, sanitize_keyword_list(["Acme Holdings"])) is None
        assert find_keyword_match(joined, sanitize_keyword_list(["AcmeHoldings"])) is None


def test_every_code_point_that_expands_more_than_four_times_is_cut_out() -> None:
    heavy = [chr(cp) for cp in range(0x110000) if not 0xD800 <= cp <= 0xDFFF and utf16_length(unicodedata.normalize("NFKC", chr(cp))) > utf16_length(chr(cp)) * 4]
    assert len(heavy) >= 19
    watchlist = sanitize_keyword_list(["Acme Holdings"])
    for ch in heavy:
        for times in (1, 40):
            assert find_keyword_match(f"Acme Holdings Ltd {ch * times}", watchlist) == "Acme Holdings", (hex(ord(ch)), times)
            assert find_keyword_match(f"{ch * times} Acme Holdings Ltd", watchlist) == "Acme Holdings", (hex(ord(ch)), times)


@pytest.mark.parametrize("padded", ["\u2473.", "\u2116.", "\ufb01.", "(\u2473)", "\u2116-", "\u3392,"])
def test_one_expanding_glyph_padded_with_punctuation_is_too_short(padded: str) -> None:
    result = sanitize_keyword_list([padded])
    assert result.keywords == () and reasons(result) == ["too_short"]
    assert find_keyword_match("Filed 2020. Casino. x", result) is None


@pytest.mark.parametrize("kept", ["no.", "S.A.", "a.b", "\u2116\u2116", "\u2473\u2473.", "\u2116 x", "AT&T"])
def test_two_glyphs_or_a_typed_word_are_kept(kept: str) -> None:
    assert len(sanitize_keyword_list([kept]).keywords) == 1


def test_a_preview_hides_the_line_and_paragraph_separators() -> None:
    for value in sanitize_keyword_list(["\u2028\u2029", "a\u2028--", "--\u2029"]).rejected:
        assert "\u2028" not in value.value and "\u2029" not in value.value and "\ufffd" in value.value


def test_a_hand_built_list_gets_no_more_than_the_sanitiser_gives() -> None:
    assert find_keyword_match("ab\U0001f600", forged("ab\ud83d")) is None, "half of an astral character"
    assert find_keyword_match("x\U0001f600bc", forged("\ude00bc")) is None
    assert find_keyword_match("Acme" + FDFA + "Holdings x", forged("acme\x00holdings")) is None, "a cut marker"
    started = time.perf_counter()
    assert find_keyword_match("Acme Corp", forged(*["a" * 100_000] * 500)) is None
    assert time.perf_counter() - started < 1.0, "needles over 400 units are skipped"
    assert find_keyword_match("Acme Corp", SanitizedKeywordList(keywords=(None,), needles=("acme corp",), rejected=(), malformed_container=False)) == "acme corp"  # type: ignore[arg-type]
    assert find_keyword_match("Acme Corp", SanitizedKeywordList(keywords=(7,), needles=("acme corp",), rejected=(), malformed_container=False)) == "acme corp"  # type: ignore[arg-type]


# ---- F5 / F6: find_keyword_match and describe_sanitization never raise, and a hand-built list gets the sanitiser's floor ------------


class _Exploding:
    def __getattr__(self, name: str) -> Any:
        raise RuntimeError(name)


@pytest.mark.parametrize(
    "bad_list",
    [None, 0, "acme", [], {}, _Exploding(), SanitizedKeywordList(("a",), (5,), (), False)],  # type: ignore[arg-type]
    ids=["None", "int", "str", "list", "dict", "raising attributes", "non-string needle"],
)
def test_find_keyword_match_never_raises_whatever_it_is_given(bad_list: Any) -> None:
    assert find_keyword_match("Acme Corp", bad_list) is None
    assert isinstance(describe_sanitization(bad_list), str)


def test_describe_sanitization_of_an_unreadable_list_is_one_line() -> None:
    assert describe_sanitization(_Exploding()) == "watchlistNames: unreadable keyword list; watchlist disabled."  # type: ignore[arg-type]
    assert describe_sanitization(None, "keywords") == "keywords: unreadable keyword list; watchlist disabled."  # type: ignore[arg-type]


@pytest.mark.parametrize("needle", ["..", " a", "a ", "a.", "-0", "()", "  "])
def test_a_hand_built_needle_below_the_floor_never_matches(needle: str) -> None:
    assert find_keyword_match("Wait.. a. -0 () a b", forged(needle)) is None


def test_a_hand_built_list_still_matches_its_valid_needle_beside_a_bad_one() -> None:
    assert find_keyword_match("Wait.. acme", forged("..", "acme")) == "acme"


def test_only_the_first_500_needles_of_a_hand_built_list_are_read() -> None:
    needles = [f"zz{index}" for index in range(1_000)]
    needles[700] = "acme"
    assert find_keyword_match("Acme Corp", forged(*needles)) is None
    needles[MAX_KEYWORDS - 100] = "acme"
    assert find_keyword_match("Acme Corp", forged(*needles)) == "acme"


# ---- F7: one hostile field must not hide a watchlisted name in another -------------------------------------------------------------


def test_a_run_of_marks_in_a_haystack_is_cut_to_16_marks() -> None:
    assert _cut_mark_runs("b" + ACUTE * 17) == "b" + ACUTE * 16
    assert _cut_mark_runs("b" + ACUTE * 16) == "b" + ACUTE * 16
    assert _cut_mark_runs("a" + ACUTE * 40 + "b" + ACUTE * 3 + "c" + ACUTE * 17) == "a" + ACUTE * 16 + "b" + ACUTE * 3 + "c" + ACUTE * 16
    assert normalise_keyword("Pfizer" + " " + "ั" * 17, "cut") == "Pfizer " + "ั" * 16
    assert normalise_keyword("Pfizer" + " " + "ั" * 17) == "", "a keyword with such a run is empty"


def test_a_hostile_marks_run_in_one_field_does_not_hide_a_name_in_another() -> None:
    pfizer = sanitize_keyword_list(["Pfizer"])
    run = "ั" * 17
    assert find_keyword_match(f"Pfizer Inc x{run}", pfizer) == "Pfizer"
    assert find_keyword_match(f"{run} | Pfizer Inc", pfizer) == "Pfizer"
    assert find_keyword_match("Pfizer Inc x" + "ั" * 9 + ZERO_WIDTH + "ั" * 9, pfizer) == "Pfizer"
    assert find_keyword_match("Pfizer Inc x" + "ั" * 16, pfizer) == "Pfizer"


def test_cutting_a_run_cannot_invent_a_hit() -> None:
    acme = sanitize_keyword_list(["acme"])
    assert find_keyword_match("acme" + ZERO_WIDTH * 3 + ACUTE * 9 + ZERO_WIDTH + ACUTE * 9, acme) is None, "the accent composes with the last letter"
    assert find_keyword_match("acme " + ZERO_WIDTH * 3 + ACUTE * 9 + ZERO_WIDTH + ACUTE * 9, acme) == "acme"
    assert find_keyword_match("cafe" + ACUTE * 30, sanitize_keyword_list(["cafe"])) is None


def test_a_keyword_with_a_run_of_17_marks_is_still_rejected() -> None:
    result = sanitize_keyword_list(["Acme" + ACUTE * 17, "ab" + ACUTE * 16])
    assert reasons(result) == ["empty_after_normalisation"]
    assert result.keywords == ("ab" + ACUTE * 16,)
