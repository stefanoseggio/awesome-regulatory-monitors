#!/bin/bash
# Differential fuzz of the watchlist guard: the TypeScript guard (the reference), the Python port on every interpreter given, and the n8n Code node guard.
# Usage (from anywhere): run.sh SEED N_SANITIZE N_NORMALISE N_MATCH PYTHON_311 [PYTHON_OTHER ...]
# PYTHON_311 must be Python 3.11 (it generates the spec: the alphabet is the code points Unicode 14.0 assigns). The port needs no third-party package for
# this comparison, but the interpreters must be able to import regulatory_engines (its dependencies are installed: pip install -e distribution/python[dev]).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SEED="$1"; N_SAN="$2"; N_NORM="$3"; N_MATCH="$4"; shift 4
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
"$1" "$HERE/generate_spec.py" "$SEED" "$N_SAN" "$N_NORM" "$N_MATCH" "$WORK/spec.json"
(cd "$ROOT" && npx tsx "$HERE/evaluate_ts.ts" "$WORK/spec.json" "$WORK/expected.json")
status=0
for python in "$@"; do
  "$python" -I "$HERE/compare_python.py" "$WORK/spec.json" "$WORK/expected.json" || status=1
done
node "$HERE/compare_n8n.mjs" "$WORK/spec.json" "$WORK/expected.json" || status=1
exit $status
