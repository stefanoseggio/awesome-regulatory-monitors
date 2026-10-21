"""Worst-case cost estimates derived from the event catalog in engines.json."""

from __future__ import annotations

import math
from collections.abc import Sequence
from decimal import Decimal

from .errors import InvalidOptionError
from .registry import EngineInfo, load_registry, resolve_sources


def _row_event_prices(engine: EngineInfo, source_ids: Sequence[str] | None) -> list[Decimal]:
    if source_ids is None:
        selected = engine.active_sources
    else:
        selected = resolve_sources(engine, list(source_ids))
    names: set[str] = set(engine.record_level_events)
    for source in selected:
        if source.billing is not None:
            names.update(source.billing.values())
    return [engine.event_price(name) for name in sorted(names)]


def estimate_worst_case_usd(engine: str, rows: int, *, sources: Sequence[str] | None = None, watchlist_hits: bool = True) -> float:
    """The most a run of ``engine`` can bill for ``rows`` delivered rows, in USD.

    It adds up, with the prices of the committed event catalog:

    * the actor-start event: its price times the Actor's memory in GB, at least one;
    * every row at the highest-priced event any of the selected sources (all of them when ``sources`` is None) can
      bill, whatever the delta class of the row;
    * with ``watchlist_hits`` (the default), a ``watchlist-hit`` for as many rows as the Actor's per-run hit cap
      allows (200 by default), never more than its per-run hit spend cap (50 USD by default).

    It is an upper bound for choosing ``max_total_charge_usd``, not a prediction: real runs bill far less, and the
    platform enforces the cap you pass to ``run()``, not this number. The catalog prices are the ones the repository
    proposes; the Actors are not published, so the price actually in force on the platform is not verified here.
    """
    if isinstance(rows, bool) or not isinstance(rows, int):
        raise InvalidOptionError("rows must be an integer.")
    if rows < 0:
        raise InvalidOptionError("rows must not be negative.")
    registry = load_registry()
    info = registry.engine(engine)
    gigabytes = max(1, math.ceil(info.memory_mbytes / 1024))
    total = info.start_price_usd * gigabytes
    total += max(_row_event_prices(info, sources)) * rows
    if watchlist_hits:
        hits = min(rows, registry.limits.default_max_watchlist_hits_per_run)
        total += min(info.watchlist_hit_price_usd * hits, registry.limits.default_max_watchlist_spend_usd)
    return float(total)
