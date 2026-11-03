"""``estimate_worst_case_usd``: arithmetic checked by hand against the committed event catalog."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any

import pytest

from regulatory_engines import (
    PATENTS,
    REGTECH,
    TENDERS,
    HeldSourceError,
    InvalidOptionError,
    UnknownEngineError,
    UnknownSourceError,
    estimate_worst_case_usd,
    load_registry,
)


def test_zero_rows_costs_only_the_start_event_per_gb() -> None:
    assert estimate_worst_case_usd(REGTECH, 0) == pytest.approx(0.01)  # 2 GB x 0.005
    assert estimate_worst_case_usd(TENDERS, 0) == pytest.approx(0.005)  # 1 GB
    assert estimate_worst_case_usd(PATENTS, 0) == pytest.approx(0.005)


def test_regtech_worst_case_uses_the_dearest_event_and_the_capped_hits() -> None:
    # start 0.01 + 1000 rows x 0.05 (enforcement-release) + min(1000, 200) hits x 0.15
    assert estimate_worst_case_usd(REGTECH, 1000) == pytest.approx(0.01 + 50 + 30)
    assert estimate_worst_case_usd(REGTECH, 1000, watchlist_hits=False) == pytest.approx(0.01 + 50)


def test_hits_are_limited_by_the_per_run_hit_cap() -> None:
    assert estimate_worst_case_usd(REGTECH, 100) == pytest.approx(0.01 + 100 * 0.05 + 100 * 0.15)
    assert estimate_worst_case_usd(REGTECH, 10_000) == pytest.approx(0.01 + 10_000 * 0.05 + 200 * 0.15)


def test_tenders_and_patents_use_their_own_catalogs() -> None:
    assert estimate_worst_case_usd(TENDERS, 10, watchlist_hits=False) == pytest.approx(0.005 + 10 * 0.02)  # notice-new / grant-new
    assert estimate_worst_case_usd(PATENTS, 10, watchlist_hits=False) == pytest.approx(0.005 + 10 * 0.03)  # sg-entity-new


def test_selecting_sources_narrows_the_dearest_event() -> None:
    assert estimate_worst_case_usd(REGTECH, 1000, sources=["ofac"], watchlist_hits=False) == pytest.approx(0.01 + 1000 * 0.0005)
    assert estimate_worst_case_usd(REGTECH, 1000, sources=["ofac", "sec_enforcement"], watchlist_hits=False) == pytest.approx(0.01 + 1000 * 0.05)
    assert estimate_worst_case_usd(TENDERS, 10, sources=["ar_santafe"], watchlist_hits=False) == pytest.approx(0.005 + 10 * 0.003)


def test_the_estimate_covers_every_delta_class_of_a_source() -> None:
    # eu_ted bills notice-new (0.02) for a new record and notice-updated (0.01) for an updated or unchanged one: the bound is the dearer.
    assert estimate_worst_case_usd(TENDERS, 1, sources=["eu_ted"], watchlist_hits=False) == pytest.approx(0.005 + 0.02)
    # world_bank_notices bills notice-record (0.001); the record-level tender-summary event (0.001) is included for every selection.
    assert estimate_worst_case_usd(TENDERS, 1, sources=["world_bank_notices"], watchlist_hits=False) == pytest.approx(0.005 + 0.001)


def test_the_estimate_is_the_maximum_over_the_catalog_not_a_hand_copy() -> None:
    registry = load_registry()
    for slug, engine in registry.engines.items():
        priced_by_active_sources = {name for source in engine.active_sources for name in (source.billing or {}).values()} | set(engine.record_level_events)
        dearest = max(engine.event_price(name) for name in priced_by_active_sources)
        expected = engine.start_price_usd * max(1, -(-engine.memory_mbytes // 1024)) + dearest * 7
        assert estimate_worst_case_usd(slug, 7, watchlist_hits=False) == float(expected), slug


def test_every_event_a_source_bills_exists_in_the_catalog() -> None:
    for engine in load_registry().engines.values():
        names = {event.name for event in engine.events}
        for source in engine.active_sources:
            assert source.billing is not None
            assert set(source.billing.values()) <= names, source.id
        assert set(engine.record_level_events) <= names


def test_a_bad_engine_or_source_is_refused_like_in_run() -> None:
    with pytest.raises(UnknownEngineError):
        estimate_worst_case_usd("nope", 1)
    with pytest.raises(UnknownSourceError):
        estimate_worst_case_usd(REGTECH, 1, sources=["nope"])
    with pytest.raises(HeldSourceError):
        estimate_worst_case_usd(REGTECH, 1, sources=["imo_gisis"])


@pytest.mark.parametrize("rows", [-1, 1.5, "10", None, True])
def test_rows_must_be_a_non_negative_integer(rows: Any) -> None:
    with pytest.raises(InvalidOptionError):
        estimate_worst_case_usd(REGTECH, rows)


def test_prices_are_exact_decimals_from_the_json() -> None:
    engine = load_registry().engine(REGTECH)
    assert engine.event_price("vessel-record") == Decimal("0.0005")
    assert engine.watchlist_hit_price_usd == Decimal("0.15")
    assert isinstance(engine.start_price_usd, Decimal)


def test_the_helper_is_reachable_from_the_run_and_the_client_classes_too() -> None:
    from regulatory_engines import EngineRun, RegulatoryEngines

    assert EngineRun.estimate_worst_case_usd(REGTECH, 1000) == estimate_worst_case_usd(REGTECH, 1000)
    assert RegulatoryEngines.estimate_worst_case_usd(TENDERS, 10, watchlist_hits=False) == estimate_worst_case_usd(TENDERS, 10, watchlist_hits=False)


def test_the_gigabyte_rounding_and_the_hit_spend_cap_follow_the_registry_not_the_current_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    """With the committed catalog neither rule ever binds (memory is a whole number of GB and 200 hits cost less than 50 USD); a registry that makes them bind pins both."""
    registry = load_registry()
    tweaked = replace(
        registry,
        limits=replace(registry.limits, default_max_watchlist_spend_usd=Decimal("1")),
        engines={**registry.engines, REGTECH: replace(registry.engine(REGTECH), memory_mbytes=1536)},
    )
    monkeypatch.setattr("regulatory_engines.pricing.load_registry", lambda: tweaked)
    # start: 1536 MB rounds UP to 2 GB x 0.005 = 0.01; 100 rows x 0.0005 (vessel-record) = 0.05; 100 hits x 0.15 = 15 cut to the 1 USD spend cap
    assert estimate_worst_case_usd(REGTECH, 100, sources=["ofac"]) == pytest.approx(1.06)
    assert estimate_worst_case_usd(REGTECH, 100, sources=["ofac"], watchlist_hits=False) == pytest.approx(0.06)
