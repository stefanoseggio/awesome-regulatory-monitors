"""Hand-derived expectations for the Python guard and its JavaScript-semantics helpers.

These do not read the parity fixture: each expected value is written down here from the rules in ``lib/_guards.ts``, so a
regenerated fixture that drifted together with the port would still be caught by this file.
"""

from __future__ import annotations

from typing import Any

import pytest

from regulatory_engines import (
    MAX_KEYWORD_LENGTH,
    MAX_KEYWORDS,
    SanitizedKeywordList,
    describe_sanitization,
    find_keyword_match,
    normalise_keyword,
    sanitize_keyword_list,
)
from regulatory_engines._guards import is_supplied
from regulatory_engines._js import js_includes, js_json_stringify, js_number_to_string, to_js_string, utf16_length, utf16_slice

GHOST_BILLING_INPUTS: list[tuple[str, Any]] = [
    ("empty string element", [""]),
    ("blank element", [" "]),
    ("bare empty string", ""),
    ("bare one-letter string", "a"),
    ("one-letter element", ["a"]),
    ("bare blank string", "   "),
    ("tab and newline only", ["\t\n"]),
    ("punctuation only", ["--", "()", "..", "//"]),
    ("zero-width only", ["\u200b\u200b"]),
    ("zero-width around one letter", ["\u200ba\u200b"]),
    ("bidi controls only", ["\u202e\u202c"]),
    ("null element", [None]),
    ("number element", [42]),
    ("object element", [{}]),
    ("number container", 42),
    ("object container", {"a": 1}),
    ("boolean container", True),
    ("None", None),
    ("empty list", []),
    ("empty tuple", ()),
]


@pytest.mark.parametrize("label,value", GHOST_BILLING_INPUTS, ids=[label for label, _ in GHOST_BILLING_INPUTS])
def test_ghost_billing_inputs_yield_no_keyword_and_never_match(label: str, value: Any) -> None:
    result = sanitize_keyword_list(value)
    assert result.keywords == ()
    assert result.needles == ()
    assert find_keyword_match("anything at all, Acme Corp, 123", result) is None


def test_none_is_empty_not_malformed() -> None:
    result = sanitize_keyword_list(None)
    assert result.malformed_container is False
    assert result.rejected == ()


@pytest.mark.parametrize("value", [42, 1.5, True, False, {"a": 1}, {}, object(), b"Acme"])
def test_other_containers_are_malformed(value: Any) -> None:
    result = sanitize_keyword_list(value)
    assert result.malformed_container is True
    assert result.keywords == ()


def test_bare_string_is_split_on_newline_comma_semicolon_never_per_character() -> None:
    result = sanitize_keyword_list("Acme Corp,Beta Ltd;Gamma\nDelta\r\nEpsilon")
    assert result.keywords == ("Acme Corp", "Beta Ltd", "Gamma", "Delta", "Epsilon")
    assert sanitize_keyword_list("abc").keywords == ("abc",)
    assert sanitize_keyword_list("a,b,c").keywords == ()


def test_tuple_is_accepted_like_a_list() -> None:
    assert sanitize_keyword_list(("Acme", "Beta")).keywords == ("Acme", "Beta")


def test_normalisation_collapses_whitespace_and_keeps_casing() -> None:
    assert sanitize_keyword_list(["  Acme   Corp  "]).keywords == ("Acme Corp",)


def test_zero_width_space_fuses_a_word_but_a_tab_separates_one() -> None:
    assert normalise_keyword("Ac\u200bme") == "Acme"
    assert normalise_keyword("Acme\tCorp") == "Acme Corp"
    assert normalise_keyword("Acme\u0085Corp") == "Acme Corp"
    assert normalise_keyword("Acme\u2028Corp") == "Acme Corp"


def test_nfkc_folds_fullwidth_letters_and_ligatures() -> None:
    assert normalise_keyword("\uff21\uff23\uff2d\uff25") == "ACME"
    assert normalise_keyword("\ufb01nance") == "finance"
    assert normalise_keyword("\u2126") == "\u03a9"


def test_non_strings_are_rejected_not_coerced() -> None:
    result = sanitize_keyword_list([1, None, True, ["x"], {"k": "v"}, "Acme"])
    assert result.keywords == ("Acme",)
    assert [item.reason for item in result.rejected] == ["not_a_string"] * 5
    assert [item.value for item in result.rejected] == ["1", "null", "true", '["x"]', '{"k":"v"}']


def test_length_is_counted_in_code_points_after_normalisation() -> None:
    assert sanitize_keyword_list(["x"]).rejected[0].reason == "too_short"
    assert sanitize_keyword_list(["xy"]).keywords == ("xy",)
    assert sanitize_keyword_list(["\U0001d400"]).rejected[0].reason == "too_short"  # one astral letter is ONE code point
    assert sanitize_keyword_list(["a" * MAX_KEYWORD_LENGTH]).keywords == ("a" * MAX_KEYWORD_LENGTH,)
    assert sanitize_keyword_list(["a" * (MAX_KEYWORD_LENGTH + 1)]).rejected[0].reason == "too_long"
    # U+FB03 is one character that NFKC expands to "ffi": 67 of them are 201 characters after normalisation.
    assert sanitize_keyword_list(["\ufb03" * 67]).rejected[0].reason == "too_long"


def test_a_keyword_needs_a_letter_or_a_digit() -> None:
    result = sanitize_keyword_list(["--", "..", "()", "__", "-1-", "\u00bd", "\u0663\u0663"])
    assert [item.value for item in result.rejected] == ["--", "..", "()", "__"]
    assert all(item.reason == "no_letter_or_digit" for item in result.rejected)
    assert len(result.keywords) == 3


def test_duplicates_are_removed_case_insensitively_first_spelling_wins() -> None:
    result = sanitize_keyword_list(["bAnCo", "Banco", "BANCO", "Other"])
    assert result.keywords == ("bAnCo", "Other")
    assert result.needles == ("banco", "other")
    assert [item.reason for item in result.rejected] == ["duplicate", "duplicate"]


def test_turkish_dotted_capital_i_is_not_the_same_keyword_as_i() -> None:
    result = sanitize_keyword_list(["\u0130stanbul", "istanbul"])
    assert result.keywords == ("\u0130stanbul", "istanbul")


def test_at_most_max_keywords_are_accepted_and_the_rest_are_over_limit() -> None:
    words = [f"kw{index:04d}" for index in range(MAX_KEYWORDS + 3)]
    result = sanitize_keyword_list(words)
    assert len(result.keywords) == MAX_KEYWORDS
    assert [item.reason for item in result.rejected] == ["over_limit"] * 3
    again = sanitize_keyword_list([*words[:MAX_KEYWORDS], "kw0000", "brand-new"])
    assert [item.reason for item in again.rejected] == ["duplicate", "over_limit"]


def test_describe_sanitization_is_the_one_line_summary() -> None:
    assert describe_sanitization(sanitize_keyword_list(["Acme", "Beta"])) == "watchlistNames: 2 keyword(s) accepted."
    assert describe_sanitization(sanitize_keyword_list(["", "a", "a"])) == "watchlistNames: 0 accepted, 3 rejected (empty_after_normalisation=1, too_short=2)."
    assert describe_sanitization(sanitize_keyword_list(7)) == "watchlistNames: unsupported value type; watchlist disabled (0 keywords)."
    assert describe_sanitization(sanitize_keyword_list([]), "keywords") == "keywords: 0 keyword(s) accepted."


def test_match_is_case_insensitive_and_returns_the_keywords_own_spelling() -> None:
    watchlist = sanitize_keyword_list(["Banco Santander"])
    assert find_keyword_match("BANCO SANTANDER S.A.", watchlist) == "Banco Santander"
    assert find_keyword_match("Banco  Santander", watchlist) == "Banco Santander"
    assert find_keyword_match("Banco Bilbao", watchlist) is None


def test_match_returns_the_first_keyword_in_list_order() -> None:
    assert find_keyword_match("Beta and Acme", sanitize_keyword_list(["Acme", "Beta"])) == "Acme"


def test_match_on_nothing_is_none() -> None:
    watchlist = sanitize_keyword_list(["Acme"])
    for haystack in ("", None, 42, ["Acme"], "\u200b\u200b"):
        assert find_keyword_match(haystack, watchlist) is None


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, False),
        ("", False),
        ([], False),
        ((), False),
        ({}, False),
        (set(), False),
        (" ", True),
        ([""], True),
        ("a", True),
        (0, True),
        (False, True),
        ({"a": 1}, True),
    ],
)
def test_is_supplied_means_the_caller_passed_something(value: Any, expected: bool) -> None:
    assert is_supplied(value) is expected


@pytest.mark.parametrize(
    "number,expected",
    [
        (0, "0"),
        (1, "1"),
        (-3, "-3"),
        (1.5, "1.5"),
        (100.0, "100"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (123456789012345680000, "123456789012345680000"),
        (12345.6789, "12345.6789"),
        (1.2345e25, "1.2345e+25"),
        (float("nan"), "null"),
        (float("inf"), "null"),
        (10**400, "null"),
    ],
)
def test_js_number_formatting(number: float | int, expected: str) -> None:
    assert js_number_to_string(number) == expected


def test_js_json_stringify_orders_integer_keys_first_and_escapes_like_javascript() -> None:
    assert js_json_stringify({"b": 1, "2": 2, "1": 3, "a": [1, {"c": None}]}) == '{"1":3,"2":2,"b":1,"a":[1,{"c":null}]}'
    assert js_json_stringify("a\"b\\c\nd\u007f\u2028\ud800") == '"a\\"b\\\\c\\nd\u007f\u2028\\ud800"'
    assert js_json_stringify([True, False, None, "x"]) == '[true,false,null,"x"]'
    with pytest.raises(TypeError):
        js_json_stringify(object())


def test_utf16_helpers_count_and_cut_like_javascript() -> None:
    emoji = "\U0001f600"
    assert utf16_length(emoji) == 2
    assert utf16_length("ab") == 2
    cut = utf16_slice(emoji * 3, 0, 3)
    assert cut == emoji + "\ud83d"
    assert to_js_string("\U0001f600") == emoji
    assert to_js_string("\ud83d") == "\ud83d"


def test_halves_kept_apart_by_an_invisible_character_are_two_lone_surrogates_for_the_keyword_check() -> None:
    # normalise_keyword on its own joins the halves once U+200B between them is removed (JavaScript does the same) ...
    assert normalise_keyword("\ud83d\u200b\ude00") == "\U0001f600"
    # ... but the guard looks for lone surrogates BEFORE it cleans, and there they are two lone halves: invalid_unicode, not an emoji.
    result = sanitize_keyword_list(["\ud83d\u200b\ude00"])
    assert result.keywords == ()
    assert [item.reason for item in result.rejected] == ["invalid_unicode"]


def test_surrogate_halves_held_as_separate_code_points_are_read_as_one_character() -> None:
    # In Python source the two halves below are two code points; JavaScript reads them as one astral character (MATHEMATICAL BOLD CAPITAL A).
    halves = "\ud835\udc00"
    assert len(halves) == 2
    assert normalise_keyword(halves) == "A"
    assert normalise_keyword(halves + halves) == "AA"
    assert sanitize_keyword_list([halves + halves]).keywords == ("AA",)
    assert sanitize_keyword_list([halves]).rejected[0].reason == "too_short"
    assert sanitize_keyword_list(halves + "," + halves + halves).keywords == ("AA",)


def test_a_long_keyword_without_a_letter_is_too_long_before_it_is_letterless() -> None:
    # The order of the checks is part of the contract: lib/_guards.ts tests both length bounds before the letter-or-number rule.
    result = sanitize_keyword_list(["-" * (MAX_KEYWORD_LENGTH + 1), "-" * MAX_KEYWORD_LENGTH, "-"])
    assert [item.reason for item in result.rejected] == ["too_long", "no_letter_or_digit", "too_short"]


def test_a_hand_built_list_with_a_blank_or_one_character_needle_never_matches() -> None:
    # lib/_guards.ts re-checks the needle length so a list that bypassed the sanitiser still cannot match on "".
    forged = SanitizedKeywordList(keywords=("", "a", " "), needles=("", "a", " "), rejected=(), malformed_container=False)
    assert find_keyword_match("a haystack with an a in it", forged) is None
    mixed = SanitizedKeywordList(keywords=("a", "Acme"), needles=("a", "acme"), rejected=(), malformed_container=False)
    assert find_keyword_match("ACME corp", mixed) == "Acme"
    assert find_keyword_match("anything", SanitizedKeywordList((), (), (), False)) is None


def test_control_characters_in_a_previewed_value_are_escaped_like_json_stringify() -> None:
    assert js_json_stringify("\b\f\n\r\t\u0001\u001f") == '"\\b\\f\\n\\r\\t\\u0001\\u001f"'
    assert sanitize_keyword_list([{"k": "a\b\f"}]).rejected[0].value == '{"k":"a\\b\\f"}'


def test_a_circular_or_absurdly_deep_value_gets_the_javascript_fallback_preview_and_never_raises() -> None:
    # JSON.stringify throws on a cycle and on a nesting deeper than the stack; lib/_guards.ts then uses Object.prototype.toString.
    circular_list: list[Any] = []
    circular_list.append(circular_list)
    circular_dict: dict[str, Any] = {}
    circular_dict["self"] = circular_dict
    deep: list[Any] = []
    cursor = deep
    for _ in range(20_000):
        inner: list[Any] = []
        cursor.append(inner)
        cursor = inner
    result = sanitize_keyword_list([circular_list, circular_dict, {"wrapped": [circular_dict]}, deep, "Acme"])
    assert result.keywords == ("Acme",)
    assert [(item.value, item.reason) for item in result.rejected] == [
        ("[object Array]", "not_a_string"),
        ("[object Object]", "not_a_string"),
        ("[object Object]", "not_a_string"),
        ("[object Array]", "not_a_string"),
    ]
    assert sanitize_keyword_list(circular_list).rejected[0].value == "[object Array]"
    assert sanitize_keyword_list(circular_dict).malformed_container is True


def test_a_value_that_is_not_json_data_gets_the_object_fallback_preview() -> None:
    assert sanitize_keyword_list([object(), b"bytes", {1, 2}]).rejected[0].value == "[object Object]"
    assert [item.value for item in sanitize_keyword_list([b"bytes", {1, 2}]).rejected] == ["[object Object]", "[object Object]"]


def test_a_needle_with_a_lone_surrogate_cannot_come_out_of_the_sanitiser_so_matching_never_finds_half_a_character() -> None:
    # The TypeScript guard used to accept "a" + a lone high surrogate and then find it inside an astral character (a hit billed for text that
    # does not contain the keyword). A lone surrogate is invalid_unicode now, so no sanitised needle can do that.
    watchlist = sanitize_keyword_list(["a\ud83d", "\ude00b", "\ud83d", "Beta"])
    assert watchlist.keywords == ("Beta",)
    assert [item.reason for item in watchlist.rejected] == ["invalid_unicode"] * 3
    assert find_keyword_match("xa\U0001f600y", watchlist) is None
    assert find_keyword_match("x\U0001f600by", watchlist) is None


def test_matching_runs_over_utf16_units_like_javascript_includes_for_a_list_that_bypassed_the_sanitiser() -> None:
    # lib/_guards.ts uses text.includes(needle): a hand-built needle that ends in a lone high surrogate is found in the first half of an astral character.
    forged = SanitizedKeywordList(keywords=("a\ud83d", "\ude00b"), needles=("a\ud83d", "\ude00b"), rejected=(), malformed_container=False)
    assert find_keyword_match("xa\U0001f600y", forged) == "a\ud83d"
    assert find_keyword_match("x\U0001f600by", forged) == "\ude00b"
    assert find_keyword_match("xa\ud83d\ude00y", forged) == "a\ud83d", "the same text with the halves held as two code points"
    assert find_keyword_match("zz\U00010000\U00010000", forged) is None
    assert find_keyword_match("a\u200b\ud83d", forged) == "a\ud83d", "removing the invisible character leaves the half itself"


def test_js_includes_is_aligned_to_utf16_units_and_treats_pairs_and_halves_alike() -> None:
    assert js_includes("xa\U0001f600y", "a\ud83d") is True
    assert js_includes("xa\U0001f600y", "\ude00y") is True
    assert js_includes("xa\U0001f600y", "\U0001f600") is True
    assert js_includes("xa\U0001f600y", "\ud83d\ude00") is True, "a needle held as two halves equals the one character"
    assert js_includes("xa\U0001f601y", "\U0001f600") is False
    assert js_includes("abc", "") is True
    assert js_includes("", "a") is False
    # U+0142 U+0201 is the bytes 42 01 01 02: the pair 01 01 sits at an odd byte offset, across two units, and is not a hit for U+0101.
    assert js_includes("\u0142\u0201", "\u0101") is False
    assert js_includes("\u0142\u0201\u0101", "\u0101") is True
