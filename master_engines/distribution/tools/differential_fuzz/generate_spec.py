"""Seeded generator of hostile guard inputs for the differential fuzz (see README.md in this directory).

Run it with the OLDEST supported Python (3.11, Unicode 14.0): the alphabet is every code point that interpreter assigns, so no input holds a
character that only a newer Unicode version knows (those are a documented, deliberate skew between the TypeScript guard and an older Python).
Usage: generate_spec.py SEED N_SANITIZE N_NORMALISE N_MATCH OUT.json
"""
import json
import random
import sys
import unicodedata

seed = int(sys.argv[1])
n_sanitize = int(sys.argv[2])
n_normalise = int(sys.argv[3])
n_match = int(sys.argv[4])
out_path = sys.argv[5]
rng = random.Random(seed)

ASSIGNED = [cp for cp in range(0x110000) if not (0xD800 <= cp <= 0xDFFF) and unicodedata.category(chr(cp)) != 'Cn']


def cps(lo, hi):
    return [chr(c) for c in range(lo, hi + 1)]


ALPHA = {
    'ascii_letters': list('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    'ascii_digits': list('0123456789'),
    'ascii_punct': list('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'),
    'js_whitespace': ['\t', '\n', '\x0b', '\x0c', '\r', ' ', '\xa0', ' '] + cps(0x2000, 0x200A) + [' ', ' ', ' ', ' ', '　', '﻿'],
    'ws_like': ['\x85', '᠎', '​', '⁣', '⠀', 'ㅤ', '·', ' '],
    'controls': cps(0, 0x1f) + cps(0x7f, 0x9f),
    'zero_width': ['​', '‌', '‍', '⁠', '﻿', '­', '͏'],
    'bidi': cps(0x200e, 0x200f) + cps(0x202a, 0x202e) + cps(0x2066, 0x2069) + cps(0x2061, 0x2064) + ['⁪', '⁯'],
    'other_invisible': ['؜', 'ᅟ', 'ᅠ', '឴', '឵', '᠋', '᠌', '᠍', 'ㅤ', 'ﾠ', '\U000e0001', '\U000e0041', '\U000e007f', '\U0001d173'],
    'variation': cps(0xfe00, 0xfe0f) + cps(0xe0100, 0xe01ef),
    'combining': cps(0x300, 0x36f) + cps(0x483, 0x489) + cps(0x591, 0x5bd) + cps(0x1ab0, 0x1abd) + cps(0x20d0, 0x20dc) + cps(0xfe20, 0xfe2f),
    'lone_surrogates': ['\ud800', '\ud83d', '\udbff', '\udc00', '\ude00', '\udfff', '\ud83d', '\ude00'],
    'astral': ['\U00010000', '\U00010400', '\U0001d400', '\U0001d4d0', '\U0001d7d8', '\U0001f1e6', '\U0001f600', '\U0001f4a9', '\U00020000', '\U0002a6d6', '\U0001f44d\U0001f3fd'],
    'fullwidth': cps(0xff21, 0xff3a) + cps(0xff41, 0xff5a) + cps(0xff01, 0xff0f) + cps(0xff66, 0xff9f) + cps(0xff10, 0xff19),
    'digits': cps(0x660, 0x669) + cps(0x6f0, 0x6f9) + cps(0x966, 0x96f) + cps(0x1d7ce, 0x1d7d7) + ['²', '³', '①', 'Ⅷ', '½', '⅕'],
    'compat': ['ﬁ', 'ﬃ', 'ǆ', '㎒', '℃', '㈱', 'ŉ', 'ᾳ', 'Ω', 'K', 'Å', 'ẞ', 'ß', 'İ', 'ı', 'ς', 'Σ', 'σ', 'ᾈ', 'ﷺ', '⑴', '㏇', '㌀', '‥', '…', '¨', 'µ', 'ſ'],
    'greek': cps(0x391, 0x3a9) + cps(0x3b1, 0x3c9),
    'cyrillic': cps(0x410, 0x44f),
    'cjk': cps(0x4e00, 0x4e50) + cps(0x3041, 0x3093) + cps(0x30a1, 0x30f6) + cps(0xac00, 0xac50),
    'rtl': cps(0x5d0, 0x5ea) + cps(0x627, 0x64a),
    'indic_thai': cps(0x915, 0x939) + cps(0xe01, 0xe2e),
    'latin_ext': list('éèñüöåøçğşıİßœæÿŁłẞ'),
    # third review round: glyphs NFKC expands, the worst expansion (U+FDFA), punctuation that pads one letter, Thai marks that the runs are made of
    'expanding': ['\u2473', '\u2116', '\ufb01', '\u2474', '\u249c', '\u2488', '\ufdfa', '\u00bd', '\u2460', '\u33cc', '\ufb03', '\u3300'],
    'padding_punct': ['.', '-', '(', ')', '|', ',', '/', '_', '&', "'"],
    'thai_marks': cps(0xe31, 0xe3a) + cps(0xe47, 0xe4e),
}
WEIGHTS = {
    'ascii_letters': 22, 'ascii_digits': 6, 'ascii_punct': 8, 'js_whitespace': 8, 'ws_like': 3, 'controls': 4, 'zero_width': 5, 'bidi': 4,
    'other_invisible': 3, 'variation': 2, 'combining': 3, 'lone_surrogates': 3, 'astral': 4, 'fullwidth': 4, 'digits': 3, 'compat': 5,
    'greek': 4, 'cyrillic': 2, 'cjk': 2, 'rtl': 2, 'indic_thai': 2, 'latin_ext': 3,
    'expanding': 3, 'padding_punct': 4, 'thai_marks': 2,
}
NAMES = list(WEIGHTS)
WEIGHT_LIST = [WEIGHTS[k] for k in NAMES]
WORDS = ['Acme', 'Corp', 'Pfizer', 'Banco', 'OFAC', 'Siemens', 'ΑΣ', 'ΟΔΥΣΣΕΥΣ', 'İstanbul', 'STRASSE', 'Straße', 'ǅ', 'ﬃ', 'ŉ', 'ǰ', 'Σίσυφος', 'ΑΣ.']


def char():
    roll = rng.random()
    if roll < 0.07:
        return chr(rng.choice(ASSIGNED))
    pool = ALPHA[rng.choices(NAMES, WEIGHT_LIST)[0]]
    return rng.choice(pool)


def text(max_len):
    length = rng.randint(0, max_len)
    out = []
    for _ in range(length):
        if rng.random() < 0.06:
            out.append(rng.choice(WORDS))
        else:
            out.append(char())
    return ''.join(out)


def noise(word):
    out = []
    for ch in word:
        out.append(ch)
        r = rng.random()
        if r < 0.15:
            out.append(rng.choice(ALPHA['zero_width'] + ALPHA['bidi'] + ALPHA['controls']))
        elif r < 0.2:
            out.append(rng.choice(ALPHA['js_whitespace']))
    s = ''.join(out)
    if rng.random() < 0.3:
        s = s.upper()
    elif rng.random() < 0.3:
        s = s.swapcase()
    elif rng.random() < 0.2:
        s = ''.join(chr(ord(c) + 0xFEE0) if 0x21 <= ord(c) <= 0x7e else c for c in s)
    return s


def exact_len_text(target):
    out = []
    count = 0
    pool_names = ['ascii_letters', 'astral', 'cjk', 'zero_width', 'js_whitespace', 'combining', 'digits']
    while count < target:
        name = rng.choice(pool_names)
        piece = rng.choice(ALPHA[name])
        out.append(piece)
        count += len([c for c in piece if True])
        # count in code points of the final merged string is not tracked exactly: the guard decides
    return ''.join(out)


def number():
    r = rng.random()
    if r < 0.2:
        return rng.randint(-1000, 1000)
    if r < 0.4:
        return rng.choice([1e21, 1e20, 1e-7, 1e-6, 123456789012345680000.0, 0.1 + 0.2, 5e-324, 1.7976931348623157e308, 100.0, 2.5, -1.5e-10, 4.35, 1e300, 123456.789e3, 0.000001, 0.0000001, 1e22, 9007199254740993.0])
    if r < 0.6:
        return rng.randint(2**40, 2**60)
    return round(rng.uniform(-1e6, 1e6), rng.randint(0, 8))


def json_value(depth=0):
    r = rng.random()
    if depth >= 3 or r < 0.3:
        return rng.choice([None, True, False, number(), text(8), number(), text(30)])
    if r < 0.6:
        return [json_value(depth + 1) for _ in range(rng.randint(0, 4))]
    keys = [rng.choice(['0', '1', '2', '10', '4294967294', '4294967295', '01', '-1', '1.5', 'a', 'b', 'zz', 'ß', '\ud83d', 'k' + text(3)]) for _ in range(rng.randint(0, 5))]
    d = {}
    for k in keys:
        d[k] = json_value(depth + 1)
    return d


def candidate():
    r = rng.random()
    if r < 0.62:
        return text(rng.choice([2, 4, 8, 12, 20]))
    if r < 0.70:
        return rng.choice(WORDS) + text(3)
    if r < 0.76:
        return noise(rng.choice(WORDS + ['Acme Corp', 'OFAC SDN', 'Pfizer']))
    if r < 0.80:
        return text(rng.choice([60, 61, 62, 70, 100]))
    if r < 0.83:
        # around the 200 code point limit, mixing astral characters and removable noise
        target = rng.choice([198, 199, 200, 201, 202])
        body = ''.join(rng.choice(['a', 'b', '\U0001f600', '漢', '\U0001d400', 'Z']) for _ in range(target))
        if rng.random() < 0.5:
            body = body[: rng.randint(0, len(body))] + rng.choice(['​', '​​', '\x00', ' ']) * rng.randint(1, 3) + body[rng.randint(0, len(body)):]
        return body
    if r < 0.845:
        # long keywords without any letter or number: the order of the too_long and no_letter_or_digit checks
        return rng.choice(['-' * rng.choice([1, 2, 199, 200, 201, 250]), '\u200b' * 300 + '--', '\U0001f600' * rng.choice([199, 200, 201]), ('.' + '\u200b') * 150, '()' * 101])
    if r < 0.86:
        return rng.choice(['', ' ', '  ', '​', 'a', 'é', 'ß', '--', '..', '()', '12', '٣٤', 'ab', 'Ab', 'AB', 'aB', ' ab ', '\ud83d', '\ude00', '\ud83d​\ude00', '\ud83d \ude00'])
    if r < 0.90:
        return third_round_candidate()
    return json_value()


def third_round_candidate():
    kind = rng.randrange(7)
    letter = rng.choice('abcdeXYZ09')
    if kind == 0:  # one alphanumeric character padded with punctuation, in either order
        pad = ''.join(rng.choice(ALPHA['padding_punct']) for _ in range(rng.randint(1, 3)))
        return pad + letter if rng.random() < 0.5 else letter + pad
    if kind == 1:  # two alphanumeric characters padded with punctuation
        pad = rng.choice(ALPHA['padding_punct'])
        return pad + letter + pad + rng.choice('abXY17') + rng.choice(['', pad])
    if kind == 2:  # expanding glyphs, alone, doubled or with invisible padding
        glyph = rng.choice(ALPHA['expanding'])
        return rng.choice([glyph, glyph * 2, glyph + '\u200b', '\u200b' + glyph + '\u00ad', glyph + glyph + glyph, glyph + letter])
    if kind == 3:  # runs of the ligature with the expansion cap near its boundary
        return '\ufdfa' * rng.randint(1, 14) + rng.choice(['', 'a', 'ab', 'abcd', ' acme'])
    if kind == 4:  # letters followed by a run of marks near the limit of 16
        return letter + rng.choice('abXY') + rng.choice(ALPHA['thai_marks'] + ALPHA['combining']) * rng.randint(14, 19)
    if kind == 5:  # marks kept apart by invisible characters so that the run only exists after removal
        return 'ab' + (rng.choice(ALPHA['combining']) + rng.choice(['\u200b', '\u2060', '\u00ad'])) * rng.randint(8, 19)
    return rng.choice(['c.', 'd.', 'a |', '-0', '.0', '1)', '(a)', 'BP', 'GE', '3M', 'a.b', 'S.A.', 'J.', 'Inc.', 'Ltd.'])


def sanitize_input():
    r = rng.random()
    if r < 0.60:
        return [candidate() for _ in range(rng.randint(0, 9))]
    if r < 0.66:
        # many candidates: exercises the 500 limit with duplicates and rejects mixed in
        count = rng.choice([498, 499, 500, 501, 502, 520, 560])
        out = []
        for i in range(count):
            roll = rng.random()
            if roll < 0.80:
                out.append('kw%d' % i)
            elif roll < 0.86:
                out.append('KW%d' % rng.randint(0, i))
            elif roll < 0.90:
                out.append(rng.choice(['x', '--', '\u200b', '']))
            elif roll < 0.94:
                out.append(rng.choice(['ß%d' % i, 'SS%d' % i, 'ss%d' % i, '\uff4b\uff57%d' % i, 'ﬃ%d' % i, 'FFI%d' % i]))
            else:
                out.append(candidate())
        return out
    if r < 0.82:
        seps = ['\n', '\r', ',', ';', ',,', '\r\n', ' , ', ';\n']
        parts = []
        for _ in range(rng.randint(0, 8)):
            parts.append(candidate() if rng.random() < 0.8 else text(6))
        out = ''
        for p in parts:
            out += p if isinstance(p, str) else json.dumps(p)
            out += rng.choice(seps)
        return out
    if r < 0.88:
        return text(rng.choice([0, 1, 2, 5, 30]))
    if r < 0.96:
        return json_value()
    return rng.choice([None, 0, 1, True, False, {}, [], {'a': 1}, 3.5, [[]], [None], ['a'], 'a', ''])


spec = {'seed': seed, 'sanitize': [], 'normalise': [], 'match': []}
for _ in range(n_sanitize):
    spec['sanitize'].append(sanitize_input())
for _ in range(n_normalise):
    spec['normalise'].append(third_round_candidate() if rng.random() < 0.3 else text(rng.choice([3, 8, 20, 60])))
for _ in range(n_match):
    kws = []
    base = []
    for _ in range(rng.randint(1, 4)):
        word = rng.choice(WORDS + ['Acme', 'Corp', 'Pfizer', 'OFAC', 'ab', 'Z9', text(4), text(6)])
        base.append(word)
        kws.append(noise(word) if rng.random() < 0.4 else word)
    if rng.random() < 0.3:
        kws.append(candidate() if isinstance(candidate(), str) else 'zz')
    parts = []
    for _ in range(rng.randint(0, 5)):
        parts.append(text(8))
    if base and rng.random() < 0.85:
        parts.insert(rng.randint(0, len(parts)), noise(rng.choice(base)))
    hay = ''.join(parts)
    if rng.random() < 0.05:
        hay = rng.choice([None, 5, [], ['a']])
    if rng.random() < 0.25:
        # needles made of halves of astral characters against haystacks that hold the whole characters
        astral = rng.choice(['\U0001f600', '\U0001d400', '\U00010000', '\U0002a6d6', '\U0001f44d'])
        hi, lo = astral.encode('utf-16-le', 'surrogatepass')[:2].decode('utf-16-le', 'surrogatepass'), astral.encode('utf-16-le', 'surrogatepass')[2:].decode('utf-16-le', 'surrogatepass')
        lead = rng.choice(['a', 'ab', 'Z9', '\u00e9'])
        tail = rng.choice(['b', 'xy', '7'])
        half_kws = [lead + hi, lo + tail, hi + lo + tail, lead + hi + lo]
        kws = kws[:1] + rng.sample(half_kws, rng.randint(1, 3))
        hay = rng.choice(['', 'q']) + lead + astral + tail + rng.choice(['', '!', '\u200b' + astral])
        if rng.random() < 0.3:
            hay = hay.replace(astral, hi + lo)
    if rng.random() < 0.2:
        # a hostile field next to a name: a run of marks (cut, never fatal), glued or after a space, or a run of ligatures
        name = rng.choice(['Acme', 'Pfizer', 'ab', 'Corp'])
        run = rng.choice(ALPHA['thai_marks'] + ALPHA['combining']) * rng.randint(12, 40)
        field = rng.choice([run, 'x' + run, ' ' + run, '\u200b' + run, ('\u0e31' + '\u200b') * rng.randint(8, 20), '\ufdfa' * rng.randint(1, 12)])
        hay = rng.choice([name + ' ' + field, field + ' | ' + name, name + field, field + name, name + ' x' + field + ' ' + name])
        kws = [name] + kws[:2]
    forged = None
    if rng.random() < 0.25:
        # a list built by hand, bypassing the sanitiser: findKeywordMatch applies the needle floor again
        forged = [rng.choice(['..', ' a', 'a ', 'a.', '-0', '()', '  ', 'ab', 'acme', 'pfizer', 'a\ud83d', 'ab\ud83d', '\ude00bc', text(3), text(5)]) for _ in range(rng.randint(1, 4))]
    spec['match'].append({'keywords': [k for k in kws if isinstance(k, str)], 'haystack': hay, 'forged': forged})

with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(spec, fh, ensure_ascii=True)
print('written', out_path, len(spec['sanitize']), len(spec['normalise']), len(spec['match']))
