"""Compares the Python port with the TypeScript guard's expected outputs. Usage: compare_python.py SPEC.json EXPECTED.json"""

import json
import os
import sys
import unicodedata

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python", "src"))

from regulatory_engines import SanitizedKeywordList, describe_sanitization, find_keyword_match, normalise_keyword, sanitize_keyword_list  # noqa: E402

spec_path, expected_path = sys.argv[1], sys.argv[2]
with open(spec_path, encoding="utf-8") as handle:
    spec = json.load(handle)
with open(expected_path, encoding="utf-8") as handle:
    expected = json.load(handle)

bad = 0
total = 0


def show(value: object) -> str:
    return json.dumps(value, ensure_ascii=True)[:500]


def report(kind: str, index: int, given: object, got: object, want: object) -> None:
    global bad
    bad += 1
    if bad <= 12:
        print(f"{kind} MISMATCH #{index} input {show(given)}\n   py {show(got)}\n   ts {show(want)}")


for index, (given, want) in enumerate(zip(spec["sanitize"], expected["sanitize"])):
    total += 1
    result = sanitize_keyword_list(given)
    got = result.to_dict()
    got["description"] = describe_sanitization(result)
    if got != want:
        report("SANITIZE", index, given, got, want)
for index, (given, want) in enumerate(zip(spec["normalise"], expected["normalise"])):
    total += 1
    got = {"reject": normalise_keyword(given), "cut": normalise_keyword(given, "cut")}
    if got != want:
        report("NORMALISE", index, given, got, want)
for index, (given, want) in enumerate(zip(spec["match"], expected["match"])):
    total += 1
    result = sanitize_keyword_list(given["keywords"])
    forged = given["forged"]
    forged_list = SanitizedKeywordList(tuple(forged), tuple(forged), (), False) if forged else None
    got = {
        "list": {"keywords": list(result.keywords), "needles": list(result.needles), "rejected": result.to_dict()["rejected"], "malformedContainer": result.malformed_container},
        "hit": find_keyword_match(given["haystack"], result),
        "forgedHit": find_keyword_match(given["haystack"], forged_list) if forged_list else None,
    }
    want_list = want["list"]
    wanted = {"list": {key: want_list[key] for key in ("keywords", "needles", "rejected", "malformedContainer")}, "hit": want["hit"], "forgedHit": want["forgedHit"]}
    if got != wanted:
        report("MATCH", index, given, got, wanted)
print(f"python {sys.version.split()[0]} unicodedata {unicodedata.unidata_version} cases {total} mismatches {bad}")
sys.exit(1 if bad else 0)
