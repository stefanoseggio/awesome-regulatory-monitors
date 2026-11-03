# regulatory-engines

Python SDK and LangChain tools for the three Master Engine Apify Actors:

* `global-regtech-compliance-feed`
* `latam-global-tender-intelligence`
* `global-corporate-patent-intelligence`

Install (from this directory, until the package is published): `pip install -e ".[dev]"`, or `pip install -e ".[langchain]"` for the LangChain tools.

```python
from regulatory_engines import RegulatoryEngines, REGTECH

engines = RegulatoryEngines(owner="your-apify-username")        # token from APIFY_TOKEN
run = engines.run(
    REGTECH,
    sources=["ofac", "world_bank_debarred"],
    max_total_charge_usd=2.00,                                   # required, no default
    watchlist_names=["Acme Corp"],
    state_namespace="weekly-sanctions",
)
for row in run.watchlist_hits():
    print(row.source, row.record_id, row.matched_watchlist_keyword)
```

The full documentation, the safety model and what has NOT been verified are in [`../README.md`](../README.md).
