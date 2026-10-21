# Distribution: Python SDK, LangChain tools and n8n templates

Programmatic ways to call the three Master Engine Apify Actors, built so that the TypeScript code stays the single source
of truth for source ids, held reasons, prices, limits and the watchlist guard.

| Path | What it is |
|---|---|
| [`python/`](python/) | `regulatory-engines` (import `regulatory_engines`): a safety-first wrapper around the official `apify-client`, plus optional LangChain tools |
| [`n8n/`](n8n/) | One workflow template per engine: schedule, run, poll, filter watchlist matches |
| `python/src/regulatory_engines/data/engines.json` | **Generated.** Engines, sources, held reasons, credential fields, event prices, limits, the watchlist guard's constants, the code point ranges it removes and the Unicode `White_Space` ranges |
| `python/tests/fixtures/guard_parity.json` | **Generated.** Inputs and the TypeScript guard's output for each, for the Python port |
| [`tools/differential_fuzz/`](tools/differential_fuzz/) | A seeded differential fuzz that compares the TypeScript guard with the Python port (3.11, 3.12, 3.13) and the n8n Code nodes |

The three Actors: `global-regtech-compliance-feed`, `latam-global-tender-intelligence`, `global-corporate-patent-intelligence`.

> **Status.** Nothing here has been run against the Apify platform. The Actors are not yet published, so no Actor id is
> reserved and no price is in force: the owner (your Apify username) and the Actor ids are yours to supply. See
> [What is NOT verified](#what-is-not-verified).

## Install

Python 3.11 or newer (the floor of `apify-client` 3.x). The package is not on PyPI; install it from this repository:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e "distribution/python"                # SDK only
pip install -e "distribution/python[langchain]"     # + the LangChain tools
pip install -e "distribution/python[dev]"           # + pytest and langchain-core, to run the tests
```

Dependencies: `apify-client>=3.3,<4` (the call signatures were read from 3.3.0, the only release in that range; the 3.x line renamed keywords of 2.x),
`pydantic>=2.11,<3` (the floor `apify-client` 3.3.0 itself sets), and for the extra `langchain-core>=1.0,<2`. Tested with Python 3.11.17, 3.12.3 and 3.13.16, each with `apify-client` 3.3.0,
`pydantic` 2.14.1 and `langchain-core` 1.6.12, and once on Python 3.11.17 with the oldest allowed `pydantic` 2.11.0 and `langchain-core` 1.0.0; other versions inside those ranges are not tested.

n8n needs no install: import a file from `n8n/` (see [n8n](#n8n)).

## Quick start

### Python SDK

```python
from regulatory_engines import REGTECH, RegulatoryEngines, estimate_worst_case_usd

engines = RegulatoryEngines(owner="your-apify-username")      # token from the APIFY_TOKEN environment variable

print(estimate_worst_case_usd(REGTECH, rows=200, sources=["ofac", "sec_enforcement"]))   # upper bound, from the event catalog

run = engines.run(
    REGTECH,
    sources=["ofac", "sec_enforcement"],
    max_total_charge_usd=2.00,          # REQUIRED, no default: the hard spending cap handed to the platform
    delta_mode="onlyChanged",           # all | onlyChanged | onlyNew
    max_items_per_source=200,           # 1..10000
    watchlist_names=["Acme Corp", "Banco Santander"],
    state_namespace="weekly-sanctions", # give each distinct job its own delta memory
)
run.raise_for_status()                  # SUCCEEDED, otherwise RunFailedError
print(run.summary())                    # the RUN_SUMMARY record
for hit in run.watchlist_hits():        # EngineRow models; connector fields are in hit.extras
    print(hit.source, hit.record_id, hit.matched_watchlist_keyword)
```

* `engines.prepare(...)` takes the same arguments as `run` (except `wait`) and returns the validated request without calling the API (a dry run);
  `prepared.redacted_input()` is safe to print.
* `run(..., wait=False)` starts the run and returns at once; `run.wait_for_finish()` then `run.items()`. `run(..., wait=True)` (the default) blocks until the run reaches a final status:
  `apify-client`'s `call` is used without a wait limit. To bound the wait use `wait=False` and `run.wait_for_finish(timeout_secs=...)`; the spending cap applies either way.
* Credentials for the bring-your-own-key sources go in `credentials=`, never in `source_options=`:
  `engines.run(PATENTS, sources=["uspto_ptab"], max_total_charge_usd=3, credentials={"usptoOdpApiKey": key})`.
* `run.confirmed_max_total_charge_usd` is the cap the platform reports for the run; compare it with what you passed.
* `RegulatoryEngines(client=...)` accepts any `ApifyClient`-compatible object; that is how the tests run offline.

### LangChain

```python
from regulatory_engines import RegulatoryEngines
from regulatory_engines.langchain_tools import build_tools

engines = RegulatoryEngines(owner="your-apify-username")
tools = build_tools(engines, max_total_charge_usd=1.00, max_rows=50)     # one StructuredTool per engine
# give `tools` to an agent; the model chooses sources, watchlist_names, delta_mode and max_items_per_source
```

* The spending cap is fixed here and is not an argument of any tool: the model cannot raise it, and an argument the schema does
  not define (such as `max_total_charge_usd`) is refused, not ignored.
* `sources` is limited to the engine's active sources; a held source is never offered. Sources that need a credential or a mandatory option
  (`uspto_ptab`, `epo_opposition`, `ai_crawler_signals`) are flagged "currently unavailable" in the tool description and refused (nothing started, nothing billed) unless the
  application passes `credentials={engine_slug: {...}}` / `source_options={engine_slug: {...}}` to `build_tools`; those never reach the model.
* The watchlist runs in strict mode, so a watchlist that cleans down to nothing is an error the model reads, not an unfiltered run.
* The cap is per tool call (one run), not a budget for the conversation: an agent that calls a tool 20 times can spend 20 times the cap. Bound the number of tool calls in your agent loop.
* The rows are third-party text (respondent names, notice titles, registry entries) and go into the model's context as they are: treat the tool output as untrusted input.
* The answer is cut to `max_rows` rows with a note. Truncation limits what the model reads, not what is billed: every row the run delivered was billed.
* Without `langchain-core`, `import regulatory_engines` works and `import regulatory_engines.langchain_tools` raises an `ImportError` that names the extra.

### n8n

Each file in [`n8n/`](n8n/) is one workflow:

```
Schedule Trigger -> Build run input (Code) -> Start Apify run (HTTP POST) -> Wait before polling -> Get run status (HTTP GET)
   -> Run still going? (IF) --true--> Wait before polling            (the loop)
                            --false-> Get dataset items (HTTP GET) -> Keep watchlist matches (Filter) -> Deliver matches downstream (NoOp)
```

| File | Actor | Default sources |
|---|---|---|
| `global-regtech-compliance-feed.workflow.json` | `global-regtech-compliance-feed` | `ofac`, `world_bank_debarred` |
| `latam-global-tender-intelligence.workflow.json` | `latam-global-tender-intelligence` | `world_bank_notices`, `ar_santafe` |
| `global-corporate-patent-intelligence.workflow.json` | `global-corporate-patent-intelligence` | `clinicaltrials_orange_book`, `sg_acra` |

Set up:

1. In n8n create a credential of type **Header Auth** named exactly `Apify API token`: header name `Authorization`, value `Bearer <your Apify API token>`.
   The token lives in n8n's credential store; no file in this repository contains one.
2. Import the workflow (Workflows, Import from File). Open each of the three HTTP Request nodes and confirm the `Apify API token` credential is selected.
3. In **Start Apify run** replace `YOUR_APIFY_USERNAME` in the URL with the Apify account that published the Actor, and set the
   **`maxTotalChargeUsd`** query parameter (the hard spending cap for each run, in USD; the templates ship with `5`).
   **Do not enable Retry On Fail on that node**: a retried POST could start a second billable run.
4. In **Build run input** edit `CONFIG` (sources, delta mode, per-source row limit, watchlist, state namespace). The node applies the
   same watchlist cleaning as the engine (a JavaScript port of `lib/_guards.ts`: the same rejection reasons and caps, with the cleaning repeated until the text stops changing), refuses held, unknown and credential-needing
   sources before any call, and stops the workflow if a watchlist you supplied cleans down to nothing.
5. Connect your own nodes after **Deliver matches downstream** (Slack, email, a ticket, a webhook). Activate the workflow.

How the loop ends: **Wait before polling** waits a fixed 30 seconds. **Run still going?** sends the item back to the Wait node while the
run has no final status (it is not `SUCCEEDED`, `FAILED`, `TIMED-OUT` or `ABORTED`) **and** fewer than 120 polls have happened (about an hour); otherwise it takes the false branch to the dataset.
A run still going after that is read as it stands and keeps running on Apify under its spending cap. Raise the 120 in the IF expression for longer runs.

Honest notes on the templates:

* They carry no credential, so the bring-your-own-key sources (`uspto_ptab`, `epo_opposition`) and `ai_crawler_signals` (which needs `domains`)
  are refused by the Code node. Adding a credential means putting a secret field into the request body from an n8n credential, which is deliberately not done here.
* The node types and versions are the long-standing core nodes `scheduleTrigger` 1.2, `code` 2, `httpRequest` 4.2, `wait` 1.1, `if` 2,
  `filter` 2 and `noOp` 1. The parameter shapes of the Schedule Trigger (`days` interval), the IF and Filter condition builder, and the
  credential reference (`{"id": null, "name": "Apify API token"}`, resolved by name) are written from the documented shapes and **have never been imported into n8n**.
  Where a shape was uncertain the simplest documented one was used: the IF and Filter compare strings (`'poll'` and `'true'`) instead of using a boolean operator.
  If n8n rejects or rewrites a node on import, fix it in the editor and tell us.
* The run is started on `/v2/acts/<owner>~<slug>/runs` (the documented REST path). The Python client addresses the same Actor on `/v2/actors/...`; both are expected to work, neither was called live.
* The dataset response is an array, which the HTTP Request node splits into one item per row; an empty dataset produces no items, so nothing is delivered.
* The template does not tell a `SUCCEEDED` run from a `FAILED`, `TIMED-OUT` or `ABORTED` one: the loop ends on any final status and the dataset is read either way, so the rows a run delivered before it stopped
  (all of them billed) go downstream. Add an IF on `data.status` before **Get dataset items** if a failed run must stop the workflow.

## Safety model

Every rule is enforced client-side **before** any API call, so a refused request starts nothing and bills nothing.

* **A required spending cap.** `max_total_charge_usd` is a required keyword with no default and must be a finite number greater than zero
  (`SpendingCapError` otherwise: `None`, `0`, negatives, `NaN`, `inf`, booleans and strings are all refused). It is passed to the platform as `maxTotalChargeUsd`
  (as a `Decimal` that prints in plain notation, checked on the wire in the tests). Passing it to the platform is all this package can do:
  the platform enforces the cap, and `run.confirmed_max_total_charge_usd` shows what it reports back.
* **Held and unknown sources are refused client-side.** An unknown engine, an unknown source, a source of another engine, an empty or bare-string `sources`, and
  any held source raise a specific exception; `HeldSourceError.reason` carries the reason recorded in `engines.json` (generated from the registry).
  One held source rejects the whole run, as the engine's own preflight does. Source ids are normalised and de-duplicated like the router does.
* **Watchlist sanitisation parity.** The watchlist goes through a Python port of `lib/_guards.ts`. A list is inspected entry by entry. At most `5000` entries are inspected, and the strings among them may add
  up to at most `200000` UTF-16 units: a string of `4096` units or fewer adds its length to a running total, and the entry that takes the total past `200000` ends the inspection (a total of exactly `200000` is allowed);
  a longer string and a value that is not a string add nothing and are rejected on their own terms. Whatever was not inspected, for either reason, is reported as one `over_limit` entry (`(N further entries not inspected)`).
  A bare string is first cut to `200000` UTF-16 units (never in the middle of a surrogate pair); the last piece of a string that was cut is dropped, because the cut may have truncated it, and one more `over_limit` entry says so
  (`(bare string cut at 200000 units; its last entry was dropped)`); the rest is split on newline, carriage return, comma and semicolon only (their fullwidth look-alikes are not separators).
  Per keyword, in this order: it must be a string (`not_a_string`); at most `4096` UTF-16 units, checked before any Unicode work because NFKC is quadratic on a long run of combining marks (`too_long`); well-formed Unicode,
  a lone surrogate is `invalid_unicode`; cleaned to a fixed point of NFKC, whitespace controls to a space, removal of every `Default_Ignorable_Code_Point` and `Bidi_Control` character plus the C0/C1 controls (zero-width characters,
  soft hyphen, bidi marks, Hangul fillers, variation selectors, tag characters and the rest), whitespace runs collapsed and ends trimmed (`empty_after_normalisation`), where a text with more than `16` combining marks (Unicode category M)
  in a row is declared empty at the start of every pass, before NFKC reorders it, and so is a text that NFKC makes longer than four times its length plus 16 UTF-16 units (U+FDFA becomes 18 characters; both are `empty_after_normalisation`);
  at least 2 code points after cleaning and at least 2 visible code points before it (`too_short`: one glyph that NFKC expands, such as the circled number twenty or the numero sign, is one character, not two); at least one letter or number (`no_letter_or_digit`)
  and at least two (`single_letter_or_digit`: `c.`, `a |` and `-0` hold one alphanumeric character, which is the one-letter needle of the original ghost-billing bug in disguise, and `BP`, `GE` and `3M` pass); at most 200 code points (`too_long`);
  case-insensitive de-duplication, first spelling wins (`duplicate`); at most 500 accepted (`over_limit`).
  Matching: a haystack of `8192` UTF-16 units or fewer is used whole; a longer one is cut to the text before the last Unicode `White_Space` character at index `8192` or earlier, so a word is never cut in half, and a longer haystack with no
  such character is not searched at all (no match). The cut happens before the haystack is cleaned. A haystack with a run of more than `16` combining marks is searched with the run cut to its first 16 marks, so one hostile field cannot hide a record
  (a *keyword* with such a run is rejected). Non-strings are dropped, never coerced. A log preview of a rejected string is cut at 57 units, never inside a surrogate pair, and its control, invisible and lone surrogate characters are shown as U+FFFD;
  a rejected value that is not a string is a constant tag (`[null]`, `[array]`, `[object]`, `[number]`, `[boolean]`) and is never serialised.
  The removed characters are not decided by Python: `engines.json` carries the 19 inclusive code point ranges (4,239 code points on Unicode 16.0) that the generator computes on Node from the same property
  escapes as the guard, and the port builds its expression from them; the 25 `White_Space` code points come the same way (so does the number of marks in a row and the total of units). Only the combining marks are read from Python's own tables (`unicodedata`, category M),
  see "What is NOT verified". The cleaning is repeated until the text stops changing, at most `8` passes (a text that has not settled becomes empty and is never matched;
  real text settles in at most 3), so the guard is idempotent: sanitising the keywords a sanitise returned accepts all of them and rejects nothing. That is why the client no longer cleans the list a second time.
  Nothing in the port raises: a container that cannot be read disables the watchlist (`unsupported value type`), an element that cannot be read is one rejected entry, and `find_keyword_match` and `describe_sanitization` answer `None` and a one-line notice for a list they cannot read.
  `find_keyword_match` also re-checks every needle (a string of at least 2 code points with at least 2 letters or numbers) and reads at most 500 of them, so a list built by hand cannot match `..`.
  The port is held to the TypeScript guard by `python/tests/fixtures/guard_parity.json` (3.7 MB, because the budget and cut cases hold strings of 200,000 units): 494 sanitiser inputs (174 named hostile cases, among them every defect class the guard was rewritten for,
  the 16/17 mark boundary on every pass, the 200,000-unit budget (exactly 200,000 units, and 49 entries of 4,092 units that cross it), entries over 4,096 units and non-strings that cost nothing, the bare-string cut at 200,000 and 200,001 units, the 8,192-unit haystack window with every kind of whitespace as the only cut point, and previews cut at unit 57, plus 320 seeded), 325 normaliser and 280 matcher cases, each with the output of the TypeScript guard, asserted byte for byte, including the log previews
  of rejected values. The sanitiser corpus names every removed code point once (a letter plus the character, one entry each) so that no entry of the generated table can be wrong unnoticed.
  The differential fuzz is committed (`tools/differential_fuzz/run.sh SEED N_SANITISE N_NORMALISE N_MATCH PYTHON_3_11 [PYTHON ...]`, see its README): a seeded generator, run on Python 3.11 so that its alphabet is exactly the code points Unicode 14.0 assigns, writes hostile inputs
  (arrays of mixed types, bare strings with separators, lists past 5,000 entries, strings past 4,096 and 200,000 units, runs of 13 to 19 combining marks in every shape, marks kept apart by invisible characters, one alphanumeric character padded with punctuation, glyphs that NFKC expands and runs of U+FDFA,
  haystacks with a hostile field next to a name, hand-built needle lists, every Unicode whitespace, control, default-ignorable, bidi, variation selector, lone surrogate, astral letter and fullwidth form), `evaluate_ts.ts` runs the TypeScript guard on them, and the port on each interpreter and the three n8n Code nodes are compared with its output.
  Twelve seeds (301 to 312) of 6,000 sanitiser, 3,000 normaliser and 3,000 matcher inputs each, 144,000 per implementation, found **no difference** between the TypeScript guard (Node 22.22.0) and the port on Python 3.11.17, 3.12.3 and 3.13.16, nor between it and the Code nodes of all three templates on Node 20.20.0, 21.7.3 and 22.22.0
  (sanitiser and normaliser: the Code node has no matcher). The corpus is not trivial: in seed 201, 4,112 of 6,000 sanitiser inputs accepted at least one keyword, with 8,835 `empty_after_normalisation`, 5,832 `too_short`, 2,632 `no_letter_or_digit` and 1,521 `single_letter_or_digit` rejections, 1,775 of 3,000 matcher inputs found a keyword, and 785 hand-built needle lists produced 37 hits. The generator is restricted to characters assigned in Unicode 14, see "What is NOT verified".
  A mutation check (scripts not committed) of 34 hand-made faults in this round's rules (15 in the TypeScript guard, 14 in the port, 5 in the Code node, applied to all three templates at once: the single-alphanumeric rule off, the visible-glyph check off or applied to the cleaned text, the expansion cap off or at 3x, a haystack run rejected instead of cut or cut to 15 marks,
  previews that serialise or do not replace unsafe characters, a matcher that can throw or reads every needle or only checks a needle's length, and the `too_long` check moved before the letter rules) found every one caught. Two survived the first attempt (the cut to 15 marks in the TypeScript guard, and the reordered `too_long` check in the Code node, whose old test compared only the number of rejections);
  each led to a new test and is caught now.
  If you pass a non-empty watchlist that sanitises to nothing, `run()` emits a `WatchlistSanitisedToEmptyWarning` (or raises `WatchlistSanitisedToEmptyError` with
  `strict_watchlist=True`) instead of silently running unfiltered. The cleaned keywords are what is sent.
* **Credentials.** They map to the engine's top-level secret input fields (`fdaApiKey`, `socrataAppToken`, `usptoOdpApiKey`, `epoOpsConsumerKey`, `epoOpsConsumerSecret`), because Apify
  only masks top-level secret fields. A credential inside `source_options` (at any depth) is refused, an unknown field is refused, and a credential aimed at a source that is not selected is refused rather than sent.
  A source that needs a credential or a mandatory option is refused until it is supplied.
* **No token logging.** The token is read from the argument or `APIFY_TOKEN`, held in a wrapper whose `repr`, `str` and `format` are redacted and which refuses to be pickled or copied.
  `repr` and `str` of the client, runs, rows, prepared requests and every exception are tested not to contain it, an error that comes back from the client is re-raised as `EngineApiError`
  with the token and this call's credentials scrubbed (plain, URL-encoded and base64 forms) and the original exception not chained (neither `__cause__` nor `__context__` leads to it, and no traceback frame holds it),
  and the real `apify-client` logging at DEBUG is tested to carry neither. The scrubbing replaces exact text: a token that an error message upper-cases, reverses or hex-encodes is not recognised.
  `engines.client` is the underlying `ApifyClient`, which keeps the token in the clear (`engines.client.token`): do not log that object's attributes.
* **Run status.** `run()` returns the run whatever its status; `run.raise_for_status()` raises for `FAILED`, `TIMED-OUT` and `ABORTED`. Reading rows from a run that did not succeed warns, because rows delivered before the failure were billed.
* **Delta memory.** With `state_namespace=None` every API-started run shares the engine's `default` memory, so runs with different watchlists or delta modes would consume each other's "new" records. Give each job its own namespace.

`estimate_worst_case_usd(engine, rows, sources=None, watchlist_hits=True)` is an upper bound derived from the committed event catalog (start event per GB, the dearest event of the selected sources for every row,
and watchlist hits up to the Actor's per-run hit cap). It is for choosing a cap, not a prediction.

## How the data stays in sync

`python/src/regulatory_engines/data/engines.json` and `python/tests/fixtures/guard_parity.json` are written by `scripts/generate_distribution_data.ts` from the engine registries,
`pricing/event_catalog.ts`, `EngineInputSchema` and `lib/_guards.ts` (its constants, and the removed and `White_Space` code point ranges computed on Node). `test/distribution_sync.test.ts` fails when a committed file differs from what the generator writes now, cross-checks
`engines.json` against the registries and the committed `.actor/input_schema.json` files, runs the real guard on every one of the 1,112,064 non-surrogate code points to prove the removed ranges exact (a change to the guard's pattern fails that test),
does the same for the `White_Space` ranges (each character of the set cuts a long haystack, no other BMP character does), and validates every n8n template (below). The Python tests assert that the Python constants equal the generated limits and that the compiled removal expression is exactly the generated ranges.

What `test/distribution_sync.test.ts` checks in each n8n template: valid JSON; unique node names and ids; only the vetted node types at their versions; exactly one trigger; every connection source and
target names an existing node; every node reachable from the trigger and the only dead end is `Deliver matches downstream`; the loop is bounded (the Wait node has a fixed interval, the IF has a false branch that
leaves the loop, every cycle passes through the Wait node, the IF caps the polls, and the longest wait is at most two hours); the run-start node is a POST to `acts/<owner>~<this engine's slug>/runs` with a
positive `maxTotalChargeUsd` and no retry; every HTTP node uses the Header Auth credential referenced by name only; no string looks like a token, a bearer header or a long base64 run; and the Code node is
**executed** in an isolated context against the whole guard corpus, against held, unknown and credential-needing sources, credentials in `sourceOptions`, and bad modes, limits and namespaces.

## What is NOT verified

* **Nothing here has been run against the Apify platform.** No Actor from this repository has been started through the Python SDK, the LangChain tools or n8n. The Actors are not yet published; their ids are not reserved and the prices in `engines.json` are the repository's proposal, not prices in force.
  The Python tests use an injected double and, for the wire-level tests, the real `apify-client` over a fake transport (what the library would send, never a socket).
* **The n8n templates are statically validated only.** They have never been imported into n8n and never executed there; only their Code node is executed, in Node's `vm`, outside n8n's own sandbox. The parameter shapes listed above are the uncertain part.
* Whether the platform applies `maxTotalChargeUsd` to these Actors, what it echoes back in `options.maxTotalChargeUsd`, and whether a run that fails preflight is still charged the start event: all expected from the pricing design, none observed.
* `owner` must be supplied; there is no default and no Actor-id lookup.
* `apify-client` other than 3.3.0 (there is no other release in the allowed range), `langchain-core` other than 1.6.12 and 1.0.0, and `pydantic` other than 2.14.1 and 2.11.0 were not run.
* **Unicode tables differ between the two sides.** The TypeScript guard runs on Node 22.22.0 (Unicode 16.0); the port uses Python's `unicodedata` for NFKC, lower-casing, the letter-or-number test and the combining-mark test (14.0 on 3.11, 15.0 on 3.12, 15.1 on 3.13).
  What is *removed* and what is *whitespace* do not depend on `unicodedata`: they come from the ranges in `engines.json`. A one-off probe over all 1,114,112 code points (NFKC, lower-casing and the letter-or-number test, each inside `a<char>b`; the probe script is
  not committed) found **no disagreement on any code point both versions assign**. The only differences are code points Python's tables do not assign yet: for NFKC 98, 36 and 36, for lower-casing 125, 63 and 63, for letter-or-number
  9,392, 5,004 and 4,382 (3.11, 3.12, 3.13). So on an older Python the client can drop, or leave unnormalised, a keyword made of characters assigned in newer Unicode versions. A keyword the client drops is never sent, so the Actor cannot
  rescue it: it shows only in the `logging` warning and in `engines.prepare(...).watchlist.rejected` (reason `no_letter_or_digit` when every character is unassigned). One it leaves unnormalised is normalised by the Actor's own pass.
  The same holds for the `16`-mark limit: Node 22.22.0 has 2,501 combining marks, Python 3.11 has 2,408 and 3.12 and 3.13 have 2,450, and every one of the 93, 51 and 51 marks that only Node knows is a code point that Python's tables do not assign (none is assigned and
  differs). A run of 17 or more marks that contains such a character is `''` for the TypeScript guard and is not recognised as a run by the port, so the port can accept a keyword the guard rejects (those characters have no combining class in an older
  table, so NFKC does no reordering on them and the text is cheap to clean). An earlier differential fuzz of 45,200 inputs (before the generator was restricted to characters assigned in Unicode 14) met the same skew twice, by accident (random surrogate halves joined into random astral characters): U+31DDB and U+313A5, in CJK Unified Ideographs Extension H (assigned in Unicode 15.0), are letters for the TypeScript guard and Python 3.12
  and 3.13 but unassigned for Python 3.11, which changed the verdict on one keyword each. The committed corpus and the 42,800-input fuzz above avoid it: a test asserts that every character in the corpus is assigned in the running Python's Unicode data (removed code points excepted, several of which are deliberately unassigned), which on Python 3.11 means
  Unicode 14.0, and a one-off probe over the 4,467 non-surrogate characters of the corpus found identical NFKC (alone and inside `a<char>b`), lower-casing and category on 3.11, 3.12 and 3.13. A character first assigned after Unicode 14.0 is
  therefore **not** exercised by the parity tests or the fuzz, and the port is not verified for it.
* **The n8n Code node uses the property escapes of the Node that runs n8n**, not of Node 22. The removed ranges and the `White_Space` set (25 code points) came out identical on Node 20.20.0 (Unicode 16.0), 21.7.3 (15.1) and 22.22.0 (16.0), the three versions that were run (`test/distribution_sync.test.ts` passes on all three); a Node that
  ships an older Unicode could remove fewer code points, and one that ships a newer Unicode could remove more. The combining-mark set differs: Node 21.7.3 has 2,450 marks, 51 fewer than Node 20.20.0 and 22.22.0 (2,501), so on that Node a run of 17 marks that includes one of the 51 is not recognised as a run.
* **Worst-case cost of the guard.** Each entry is at most 4,096 units, the strings of a list add up to at most 200,000 units and a list holds at most 5,000 entries, a haystack is read up to 8,192 units, a run of more than 16 marks is refused (keywords) or cut (haystacks) before NFKC can reorder it,
  a text that NFKC makes more than four times its length plus 16 units longer is empty, and a rejected value that is not a string is never serialised (a constant tag). One-off timings on this machine (best of 5, idle, not committed; measurements of chosen shapes, not a proof of a bound):
  5,000 entries of 4,096 units of combining marks in descending combining class (86 s in the first version of the TypeScript guard) take 5 ms in the TypeScript guard, 3 to 4 ms in the port and 3 to 4 ms in the Code node; 5,000 plain 4,096-unit entries 11 ms, 55 to 65 ms and 11 to 12 ms;
  the worst compatibility character, U+FDFA (one character, 18 after NFKC), in lists of 48 x 4,096 units or 5,000 x 40 units takes 16 ms in the TypeScript guard, 15 to 20 ms in the Code node (Node 20.20.0, 21.7.3, 22.22.0) and 240 to 290 ms in the port (Python's `normalize` is slower, and the port measures the expansion after it);
  5,000 references to an 8,000-deep array (TypeScript guard, Code node) or a 900-deep one (port) take 0.5 ms, 0.5 ms and 2 to 3 ms, and 5,000 references to a 100,000-element array 0.7 ms (TypeScript guard) and 2 to 5 ms (port): a rejected non-string costs a tag, where `JSON.stringify` cost 2.1 s and 40 s and ran Node out of heap on a 5,000,000-unit string;
  a haystack of 8,192 units against 500 needles, with a run of 40 marks or 8,188 ligatures, takes about 1 ms in the TypeScript guard and 10 to 15 ms in the port. The n8n Code node only ever cleans the watchlist written in its own `CONFIG`.
* Source options (`source_options`) are validated by the Actor, not client-side; only credential placement and mandatory options are checked here.
* The LangChain tools were exercised with `StructuredTool.invoke` against the fake client, not inside an agent loop with a model.

## Regenerating the data files

Run from `master_engines/` after any change to a registry, the pricing catalog, `EngineInputSchema` or `lib/_guards.ts`:

```bash
npx tsx scripts/generate_distribution_data.ts           # rewrites both files
npx tsx scripts/generate_distribution_data.ts --check   # exits 1 when a committed file is stale, writes nothing
```

then run the Python port's tests, which fail if the port no longer reproduces the regenerated corpus, and the sync test.

## Running the tests

```bash
cd master_engines
npx vitest run test/distribution_sync.test.ts
npx tsc --noEmit
python3 -m venv /path/to/venv && /path/to/venv/bin/pip install -e "distribution/python[dev]"
/path/to/venv/bin/python -m pytest distribution/python
```
