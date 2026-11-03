"""Hand-derived expectations for the fourth round of the guard review.

Like ``test_guard_batch3.py`` these never read the parity fixture. Each test names the review finding it pins: F1 the halfwidth sound marks U+FF9E and
U+FF9F count in the run of marks, F5a an element that cannot be hashed, F5b a needle written as two separate surrogate halves, F5c only the first
``MAX_KEYWORDS`` needles are read.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from regulatory_engines import MAX_KEYWORDS, SanitizedKeywordList, find_keyword_match, normalise_keyword, sanitize_keyword_list
from regulatory_engines._guards import _cut_mark_runs, _has_long_combining_run

ACUTE = "́"
VOICED = "ﾞ"  # HALFWIDTH KATAKANA VOICED SOUND MARK: a letter (Lm) that NFKC turns into U+3099, a combining mark of class 8
SEMI_VOICED = "ﾟ"
GRAVE = "̀"


def forged(needles: list[Any], keywords: list[str] | None = None) -> SanitizedKeywordList:
    return SanitizedKeywordList(keywords=tuple(keywords if keywords is not None else [str(n) for n in needles]), needles=tuple(needles), rejected=(), malformed_container=False)


class TestHalfwidthSoundMarksCountInTheRun:  # F1
    def test_sixteen_marks_of_any_mix_are_fine_seventeen_are_not(self) -> None:
        assert sanitize_keyword_list([f"ab{(ACUTE + VOICED) * 8}"]).keywords != ()
        assert [r.reason for r in sanitize_keyword_list([f"ab{(ACUTE + VOICED) * 8}{ACUTE}"]).rejected] == ["empty_after_normalisation"]
        assert [r.reason for r in sanitize_keyword_list([f"ab{(ACUTE + VOICED) * 9}"]).rejected] == ["empty_after_normalisation"]
        assert sanitize_keyword_list([f"cd{(SEMI_VOICED + GRAVE) * 8}"]).keywords != ()
        assert [r.reason for r in sanitize_keyword_list([f"cd{(SEMI_VOICED + GRAVE) * 9}"]).rejected] == ["empty_after_normalisation"]

    def test_the_quadratic_shape_is_empty_at_once(self) -> None:
        started = time.perf_counter()
        assert normalise_keyword(f"ab{(ACUTE + VOICED) * 2000}") == ""
        assert time.perf_counter() - started < 0.5

    def test_the_run_predicate_and_the_cut_see_them(self) -> None:
        assert _has_long_combining_run("a" + (ACUTE + VOICED) * 9)
        assert not _has_long_combining_run("a" + (ACUTE + VOICED) * 8)
        assert _cut_mark_runs("a" + (ACUTE + VOICED) * 9) == "a" + (ACUTE + VOICED) * 8

    def test_a_haystack_run_is_cut_and_the_words_around_it_are_still_searched(self) -> None:
        keywords = sanitize_keyword_list(["Acme"])
        assert find_keyword_match("Acme Corp b" + (ACUTE + VOICED) * 2000, keywords) == "Acme"
        assert find_keyword_match("b" + (ACUTE + VOICED) * 200 + " Acme Corp", keywords) == "Acme"


class TestHandBuiltListsAgreeWithTypeScript:
    def test_an_element_that_cannot_be_hashed_is_skipped_alone(self) -> None:  # F5a
        for bad in (["x"], {"k": 1}, {1, 2}, 7, None, b"pfizer"):
            assert find_keyword_match("Pfizer Inc", forged(["pfizer", bad, "zz"], ["Pfizer", "x", "zz"])) == "Pfizer", repr(bad)

    def test_a_needle_of_two_separate_surrogate_halves_is_the_character_they_form(self) -> None:  # F5b
        needle = chr(0xD801) + chr(0xDC28) + chr(0xD801) + chr(0xDC29)
        assert find_keyword_match("xx \U00010428\U00010429 yy", forged([needle], ["kw"])) == "kw"

    def test_a_lone_surrogate_needle_is_still_skipped(self) -> None:
        assert find_keyword_match("xx \U00010428\U00010429 yy", forged([chr(0xD801) + "ab"], ["kw"])) is None

    def test_only_the_first_max_keywords_needles_are_read(self) -> None:  # F5c
        needles = ["zzzz"] * (MAX_KEYWORDS + 5) + ["pfizer"]
        assert find_keyword_match("Pfizer Inc", forged(needles)) is None
        assert find_keyword_match("Pfizer Inc", forged(["zzzz"] * (MAX_KEYWORDS - 1) + ["pfizer"])) == "pfizer"

    def test_the_rest_of_a_huge_list_is_never_touched(self) -> None:  # F5c
        class NoIteration(list):  # type: ignore[type-arg]
            def __iter__(self) -> Any:
                raise AssertionError("the whole list was iterated (and hashed)")

        needles = NoIteration(["zzzz"] * (MAX_KEYWORDS - 1) + ["pfizer"] + ["x"] * 1_000_000)
        huge = SanitizedKeywordList(keywords=tuple(["k"] * MAX_KEYWORDS), needles=needles, rejected=(), malformed_container=False)  # type: ignore[arg-type]
        assert find_keyword_match("Pfizer Inc", huge) == "k"

    @pytest.mark.parametrize("needles", [[], [None], [""], [[]]])
    def test_degenerate_lists_match_nothing_and_never_raise(self, needles: list[Any]) -> None:
        assert find_keyword_match("Pfizer Inc", forged(needles, ["x"] * len(needles))) is None
