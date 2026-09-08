#!/usr/bin/env python3
"""
run_all.py - unified loader for the awesome-regulatory-monitors actor fleet.

Runs one or more actors from the directory in README.md with a shared
onlyNew=true delta flag, and prints a consolidated summary across sources.
Each actor's own real input fields are respected - this script only sets
the fields that are common across the fleet (maxItems-style caps and the
delta flag); anything actor-specific should be passed via --extra-input.

Usage:
    pip install apify-client
    export APIFY_TOKEN=your_token_here
    python run_all.py --actors actor-19-maritime-sanctions-monitor actor-22-drug-safety-recalls-monitor
    python run_all.py --all
"""

import argparse
import json
import os
import sys

from apify_client import ApifyClient

# Real actor directory, actor slug -> its real delta-flag field name (NOT
# all identical across this fleet - actor-18 uses skipKnownLeads instead of
# onlyNew, since it has no content-change concept, only a "seen before"
# one; primer-actor uses onlyChanged, since it tracks per-URL content
# change rather than a registry listing).
ACTOR_DELTA_FLAGS = {
    "australia-grantconnect-monitor": "onlyNew",
    "uk-hse-enforcement-monitor": "onlyNew",
    "florida-tenders-monitor": "onlyNew",
    "santafe-compras-monitor": "onlyNew",
    "tucuman-compras-monitor": "onlyNew",
    "salta-compras-monitor": "onlyNew",
    "mendoza-compras-monitor": "onlyNew",
    "entrerios-compras-monitor": "onlyNew",
    "cordoba-compras-monitor": "onlyNew",
    "pba-tenders-monitor": "onlyNew",
    "diario-oficial-cl-monitor": "onlyNew",
    "primer-actor": "onlyChanged",
    "actor-18-b2b-lead-magnet": "skipKnownLeads",
    "actor-19-maritime-sanctions-monitor": "onlyNew",
    "actor-20-mdb-procurement-monitor": "onlyNew",
    "actor-21-patent-ip-enforcement-monitor": "onlyNew",
    "actor-22-drug-safety-recalls-monitor": "onlyNew",
}

OWNER = "stefano_seggio"


def run_one(client: ApifyClient, actor_slug: str, extra_input: dict) -> dict:
    delta_flag = ACTOR_DELTA_FLAGS.get(actor_slug)
    run_input = dict(extra_input)
    if delta_flag and delta_flag not in run_input:
        run_input[delta_flag] = True

    print(f"--- Running {actor_slug} (input: {json.dumps(run_input)}) ---")
    run = client.actor(f"{OWNER}/{actor_slug}").call(run_input=run_input)
    items = list(client.dataset(run["defaultDatasetId"]).iterate_items())
    print(f"    {len(items)} item(s) returned, run status: {run['status']}")
    return {"actor": actor_slug, "run_id": run["id"], "item_count": len(items), "status": run["status"]}


def main():
    parser = argparse.ArgumentParser(description="Run one or more actors from the awesome-regulatory-monitors fleet.")
    parser.add_argument("--actors", nargs="*", default=[], help="Specific actor slugs to run (see README.md for the full list)")
    parser.add_argument("--all", action="store_true", help="Run every actor in the directory (real cost - each run bills per this actor's own pricing)")
    parser.add_argument("--extra-input", type=str, default="{}", help="JSON object of additional input fields applied to every run, e.g. '{\"maxItems\": 50}'")
    args = parser.parse_args()

    token = os.environ.get("APIFY_TOKEN")
    if not token:
        print("Error: set the APIFY_TOKEN environment variable first.", file=sys.stderr)
        sys.exit(1)

    actors_to_run = list(ACTOR_DELTA_FLAGS.keys()) if args.all else args.actors
    if not actors_to_run:
        print("Nothing to run - pass --actors <slug...> or --all. See README.md for the full actor directory.", file=sys.stderr)
        sys.exit(1)

    extra_input = json.loads(args.extra_input)
    client = ApifyClient(token)

    results = [run_one(client, slug, extra_input) for slug in actors_to_run]

    print("\n=== Summary ===")
    for r in results:
        print(f"{r['actor']}: {r['item_count']} item(s), status={r['status']}")


if __name__ == "__main__":
    main()
