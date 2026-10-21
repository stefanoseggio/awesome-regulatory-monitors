"""The packaged engines.json: its shape, its internal consistency and how it is loaded."""

from __future__ import annotations

import json
from dataclasses import replace
from decimal import Decimal
from importlib import resources
from pathlib import Path

import pytest

from regulatory_engines import PATENTS, REGTECH, TENDERS, RegulatoryEngines, load_registry
from regulatory_engines.registry import CredentialField, credential_option_names, normalise_source_id, resolve_sources

DATA = Path(__file__).resolve().parents[1] / "src" / "regulatory_engines" / "data" / "engines.json"


def test_the_data_file_is_packaged_inside_the_import_package() -> None:
    packaged = resources.files("regulatory_engines").joinpath("data", "engines.json")
    assert packaged.is_file()
    assert json.loads(packaged.read_text(encoding="utf-8"))["schemaVersion"] == 1


def test_the_data_file_is_pure_ascii_and_generated() -> None:
    raw = DATA.read_bytes()
    raw.decode("ascii")
    assert json.loads(raw)["generatedBy"] == "scripts/generate_distribution_data.ts"


def test_three_engines_in_the_documented_order() -> None:
    assert list(load_registry().engines) == [REGTECH, TENDERS, PATENTS]
    assert [engine.slug for engine in RegulatoryEngines.engines()] == [REGTECH, TENDERS, PATENTS]


def test_the_active_sources_of_each_engine() -> None:
    registry = load_registry()
    assert [s.id for s in registry.engine(REGTECH).active_sources] == ["ofac", "world_bank_debarred", "uk_modern_slavery", "sec_enforcement", "ai_crawler_signals", "fda_ema_recalls"]
    assert [s.id for s in registry.engine(TENDERS).active_sources] == ["ar_santafe", "ar_tucuman", "ar_entrerios", "cl_diario_oficial", "eu_ted", "us_florida", "world_bank_notices", "it_lombardia_grants"]
    assert [s.id for s in registry.engine(PATENTS).active_sources] == ["uspto_ptab", "epo_opposition", "clinicaltrials_orange_book", "sg_acra", "ae_registers"]


def test_held_sources_have_a_reason_and_no_billing_and_active_ones_have_billing() -> None:
    for engine in load_registry().engines.values():
        for source in engine.sources:
            if source.is_held:
                assert source.held_reason and len(source.held_reason) > 20, source.id
                assert source.billing is None, source.id
            else:
                assert source.held_reason is None, source.id
                assert source.billing is not None and set(source.billing) == {"first_seen", "updated", "unchanged"}, source.id


def test_source_ids_are_unique_lowercase_and_already_normalised() -> None:
    for engine in load_registry().engines.values():
        ids = [source.id for source in engine.sources]
        assert len(ids) == len(set(ids))
        assert all(normalise_source_id(source_id) == source_id for source_id in ids)


def test_every_credential_field_feeds_an_active_source_of_its_engine() -> None:
    for engine in load_registry().engines.values():
        for field in engine.credential_fields.values():
            source = engine.source(field.source)
            assert source is not None and source.is_active, field.field


def test_required_options_are_known_for_the_three_sources_that_have_them() -> None:
    required = {(engine.slug, source.id): source.required_options for engine in load_registry().engines.values() for source in engine.sources if source.required_options}
    assert required == {
        (REGTECH, "ai_crawler_signals"): ("domains",),
        (PATENTS, "uspto_ptab"): ("usptoOdpApiKey",),
        (PATENTS, "epo_opposition"): ("epoOpsConsumerKey", "epoOpsConsumerSecret"),
    }


def test_the_credential_names_that_source_options_must_never_hold() -> None:
    assert credential_option_names(load_registry()) == {"fdaApiKey", "socrataAppToken", "usptoOdpApiKey", "epoOpsConsumerKey", "epoOpsConsumerSecret"}


def test_watchlist_hit_is_priced_in_every_engine_and_money_is_decimal() -> None:
    for engine in load_registry().engines.values():
        assert engine.watchlist_hit_event == "watchlist-hit"
        assert engine.watchlist_hit_price_usd == Decimal("0.15")
        assert engine.start_price_usd == Decimal("0.005")
        assert all(isinstance(event.price_usd, Decimal) and event.price_usd > 0 for event in engine.events)


def test_the_registry_is_loaded_once() -> None:
    assert load_registry() is load_registry()


def test_resolve_sources_returns_the_selected_infos_in_the_callers_order() -> None:
    engine = load_registry().engine(REGTECH)
    assert [info.id for info in resolve_sources(engine, ["fda_ema_recalls", "ofac"])] == ["fda_ema_recalls", "ofac"]


def test_describe_returns_the_registry_entry(engines: RegulatoryEngines) -> None:
    info = engines.describe(PATENTS)
    assert info.slug == PATENTS and info.memory_mbytes == 1024
    assert RegulatoryEngines.describe(REGTECH).memory_mbytes == 2048


def test_the_package_is_typed_and_versioned() -> None:
    import importlib.metadata

    import regulatory_engines

    assert resources.files("regulatory_engines").joinpath("py.typed").is_file()
    assert importlib.metadata.version("regulatory-engines") == regulatory_engines.__version__


def test_the_names_source_options_must_never_hold_include_both_the_field_and_the_option_it_feeds() -> None:
    """In the committed registry a field and its option share a name; a registry where they differ must forbid both."""
    registry = load_registry()
    engine = registry.engine(REGTECH)
    tweaked = replace(registry, engines={**registry.engines, REGTECH: replace(engine, credential_fields={"fdaApiKey": CredentialField(field="fdaApiKey", source="fda_ema_recalls", option="apiKeyOption")})})
    names = credential_option_names(tweaked)
    assert {"fdaApiKey", "apiKeyOption"} <= names


def test_the_declared_dependency_floors_are_ones_that_can_be_installed_next_to_apify_client() -> None:
    """A floor below what ``apify-client`` itself requires is a promise pip can never keep (apify-client 3.3.0 needs pydantic>=2.11)."""
    import tomllib
    from importlib.metadata import requires

    from packaging.requirements import Requirement
    from packaging.version import Version

    def floor(requirement: Requirement) -> Version:
        return max(Version(spec.version) for spec in requirement.specifier if spec.operator in (">=", "==", "~=", ">"))

    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    ours = {requirement.name: requirement for requirement in map(Requirement, pyproject["project"]["dependencies"])}
    theirs = [requirement for requirement in map(Requirement, requires("apify-client") or []) if requirement.marker is None]
    assert {"apify-client", "pydantic"} <= set(ours)
    for requirement in theirs:
        if requirement.name in ours and requirement.specifier:
            assert floor(ours[requirement.name]) >= floor(requirement), f"{requirement.name}: apify-client requires {requirement.specifier}, this package declares {ours[requirement.name].specifier}"


@pytest.mark.parametrize("slug", [REGTECH, TENDERS, PATENTS])
def test_every_engine_has_a_title_and_a_description(slug: str) -> None:
    info = load_registry().engine(slug)
    assert info.title and info.description
