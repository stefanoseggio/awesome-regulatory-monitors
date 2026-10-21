# Differential fuzz of the watchlist guard

Compares the three implementations of the watchlist guard on the same hostile inputs. The TypeScript guard (`lib/_guards.ts`) is the reference.

| File | Role |
|---|---|
| `generate_spec.py` | Seeded generator. **Run it with Python 3.11**: its alphabet is every code point that interpreter assigns (Unicode 14.0), so no input holds a character only a newer Unicode knows (a documented, deliberate skew, see `../../README.md`). Writes sanitiser, normaliser and matcher inputs, including hand-built needle lists |
| `evaluate_ts.ts` | Runs the TypeScript guard on a spec and writes the expected outputs |
| `compare_python.py` | Runs the Python port (`distribution/python`) on a spec and compares it with the expected outputs: sanitiser result (keywords, needles, rejected values and reasons, container flag, description), both normaliser modes, matcher hit and hand-built-list hit |
| `compare_n8n.mjs` | Runs the guard section of the Code node of each n8n template in a Node `vm` and compares keywords, the count of every rejection reason and the container flag with the expected outputs (the Code node has no matcher) |
| `run.sh` | Runs all of it for one seed |

```bash
# from anywhere; PYTHON_3_11 generates the spec, every interpreter listed (the first included) is compared
distribution/tools/differential_fuzz/run.sh 301 6000 3000 3000 /path/to/py311/bin/python /path/to/py312/bin/python /path/to/py313/bin/python

# the n8n Code nodes on another Node: run the two steps by hand with that node binary
npx tsx distribution/tools/differential_fuzz/evaluate_ts.ts spec.json expected.json
/path/to/node20/bin/node distribution/tools/differential_fuzz/compare_n8n.mjs spec.json expected.json
```

Every interpreter must be able to import `regulatory_engines` (its dependencies installed: `pip install -e "distribution/python[dev]"`). The scripts print one line per implementation and exit non-zero on any mismatch; the first twelve mismatches are printed in full.

This is a differential test, not a proof: it finds a difference between implementations, not a defect that all three share. Results of the committed seeds are in `../../README.md` ("Safety model").
