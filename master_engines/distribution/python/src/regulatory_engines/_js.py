"""JavaScript string semantics the TypeScript guard relies on, reproduced exactly so the Python port can match it byte for byte.

Only what ``lib/_guards.ts`` uses is implemented: UTF-16 length, slicing and cutting (``String.prototype.slice``, ``.length``, the
surrogate-pair-safe ``cutUnits``), substring search over UTF-16 units (``String.prototype.includes``), the merging of adjacent surrogate
halves into one code point, and ``JSON.stringify`` (key order, number formatting and string escaping), which the guard uses to preview
rejected values in log lines.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

# ECMAScript WhiteSpace + LineTerminator, i.e. what ``\s`` matches and ``String.prototype.trim`` removes.
JS_WHITESPACE_CHARS = (
    "\t\n\x0b\x0c\r \xa0\u1680" + "".join(chr(code) for code in range(0x2000, 0x200B)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

_ARRAY_INDEX = re.compile(r"(?:0|[1-9][0-9]*)")
_MAX_ARRAY_INDEX = 2**32 - 2
_SURROGATE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")


def has_surrogate(text: str) -> bool:
    """True when ``text`` holds a surrogate code point (a half held as a code point of its own, in Python)."""
    return _SURROGATE.search(text) is not None


def to_js_string(text: str) -> str:
    """Merges an adjacent high+low surrogate pair into the one astral code point JavaScript would see.

    A Python ``str`` may hold the two halves as separate code points; JavaScript treats them as one character, so
    length, normalisation and iteration differ unless they are merged first. Lone surrogates are kept as they are.
    After this call every surrogate left in the text is a LONE one, which is what ``/\\p{Surrogate}/u`` finds in JavaScript.
    """
    if not has_surrogate(text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def utf16_length(text: str) -> int:
    """``text.length`` in JavaScript: the number of UTF-16 code units."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def utf16_slice(text: str, start: int, stop: int) -> str:
    """``text.slice(start, stop)`` in JavaScript for non-negative bounds; may cut a surrogate pair in half, as JavaScript does."""
    return text.encode("utf-16-le", "surrogatepass")[2 * start : 2 * stop].decode("utf-16-le", "surrogatepass")


def utf16_cut(text: str, max_units: int) -> str:
    """``cutUnits`` of the TypeScript guard: ``text`` cut to at most ``max_units`` UTF-16 units, never ending in the first half of a surrogate pair.

    A text that already fits is returned as it is. A cut that would end between the two halves of a pair gives the pair up whole
    (one unit fewer), and so does a cut that ends in a lone high surrogate, exactly as the TypeScript function does.
    """
    if len(text) > max_units:
        # More code points than the limit means more units than the limit: only the head can survive, so a giant text is never encoded whole.
        text = text[: max_units + 1]
    text = to_js_string(text)
    data = text.encode("utf-16-le", "surrogatepass")
    if len(data) <= 2 * max_units:
        return text
    last = int.from_bytes(data[2 * max_units - 2 : 2 * max_units], "little")
    keep = max_units - 1 if 0xD800 <= last <= 0xDBFF else max_units
    return data[: 2 * keep].decode("utf-16-le", "surrogatepass")


def js_includes(haystack: str, needle: str) -> bool:
    """``haystack.includes(needle)`` in JavaScript: the search runs over UTF-16 code units, not code points.

    A needle that ends in a lone high surrogate (or starts with a lone low one) is therefore found inside an astral character,
    and a needle of two separate halves equals the one character they form. A hit at an odd byte offset straddles two units and is skipped.
    """
    units = haystack.encode("utf-16-le", "surrogatepass")
    wanted = needle.encode("utf-16-le", "surrogatepass")
    start = 0
    while True:
        index = units.find(wanted, start)
        if index < 0:
            return False
        if index % 2 == 0:
            return True
        start = index + 1


def js_number_to_string(value: float | int) -> str:
    """``JSON.stringify(number)``: shortest round-trip digits, exponent form from 1e21 and below 1e-6, ``null`` for NaN and infinities."""
    try:
        number = float(value)
    except OverflowError:
        return "null"
    if number != number or number in (float("inf"), float("-inf")):
        return "null"
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    _, raw_digits, exponent = Decimal(repr(abs(number))).as_tuple()
    digits = "".join(str(d) for d in raw_digits)
    stripped = digits.rstrip("0")
    exponent = int(exponent) + (len(digits) - len(stripped))
    digits = stripped
    k = len(digits)
    n = exponent + k
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exponent_text = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + digits + "e" + exponent_text
    return sign + digits[0] + "." + digits[1:] + "e" + exponent_text


_SHORT_ESCAPES = {"\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", '"': '\\"', "\\": "\\\\"}


def _quote(text: str) -> str:
    out = ['"']
    for ch in to_js_string(text):
        code = ord(ch)
        if ch in _SHORT_ESCAPES:
            out.append(_SHORT_ESCAPES[ch])
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _ordered_keys(mapping: dict[Any, Any]) -> list[str]:
    keys = [str(key) for key in mapping]
    indexes = sorted((key for key in keys if _ARRAY_INDEX.fullmatch(key) and int(key) <= _MAX_ARRAY_INDEX), key=int)
    index_set = set(indexes)
    return indexes + [key for key in keys if key not in index_set]


def js_json_stringify(value: Any) -> str:
    """``JSON.stringify(value)`` for JSON data (None, bool, int, float, str, list, tuple, dict)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, (int, float)):
        return js_number_to_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_json_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        lookup = {str(key): item for key, item in value.items()}
        return "{" + ",".join(f"{_quote(key)}:{js_json_stringify(lookup[key])}" for key in _ordered_keys(value)) + "}"
    raise TypeError(f"not JSON data: {type(value).__name__}")
