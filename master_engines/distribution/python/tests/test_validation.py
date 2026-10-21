"""Every refusal happens client-side, before any API call: the fake client must stay untouched."""

from __future__ import annotations

import copy
import json
import logging
import pickle
import warnings
from decimal import Decimal
from typing import Any

import pytest
from fakes import ALL_SECRETS, EPO_KEY, EPO_SECRET, FDA_KEY, SOCRATA_TOKEN, TOKEN, USPTO_KEY, FakeApifyClient, no_warnings

from regulatory_engines import (
    PATENTS,
    REGTECH,
    TENDERS,
    ConfigurationError,
    CredentialError,
    HeldSourceError,
    InvalidOptionError,
    InvalidSourcesError,
    RegulatoryEngines,
    RunInputError,
    SpendingCapError,
    UnknownEngineError,
    UnknownSourceError,
    WatchlistSanitisedToEmptyError,
    WatchlistSanitisedToEmptyWarning,
    build_run_request,
    load_registry,
    sanitize_keyword_list,
    validate_max_total_charge_usd,
)
from regulatory_engines import errors as package_errors

CAP = 2.5


def run_kwargs(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"sources": ["ofac"], "max_total_charge_usd": CAP}
    kwargs.update(overrides)
    return kwargs


# ---- spending cap -------------------------------------------------------------------------------


def test_the_spending_cap_is_a_required_keyword(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(TypeError, match="max_total_charge_usd"):
        engines.run(REGTECH, sources=["ofac"])  # type: ignore[call-arg]
    assert not fake.touched_the_api


@pytest.mark.parametrize("bad", [None, 0, 0.0, -1, -0.01, float("nan"), float("inf"), float("-inf"), Decimal("NaN"), Decimal("Infinity"), Decimal(0), True, False, "5", [5], {"usd": 5}])
def test_a_bad_spending_cap_is_refused_before_any_call(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(SpendingCapError):
        engines.run(REGTECH, **run_kwargs(max_total_charge_usd=bad))
    assert not fake.touched_the_api


@pytest.mark.parametrize("good,expected", [(5, "5"), (2.5, "2.5"), (0.01, "0.01"), (Decimal("1.25"), "1.25"), (1e-9, "0.000000001"), (1e16, "10000000000000000")])
def test_a_valid_spending_cap_becomes_a_plain_decimal(good: Any, expected: str) -> None:
    cap = validate_max_total_charge_usd(good)
    assert isinstance(cap, Decimal)
    assert str(cap) == expected


def test_the_cap_error_is_a_value_error_and_a_run_input_error() -> None:
    assert issubclass(SpendingCapError, ValueError)
    assert issubclass(SpendingCapError, RunInputError)


# ---- engine and sources ---------------------------------------------------------------------------


def test_an_unknown_engine_names_the_known_ones(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(UnknownEngineError) as caught:
        engines.run("global-weather-feed", **run_kwargs())
    assert caught.value.engine == "global-weather-feed"
    assert REGTECH in caught.value.known
    assert not fake.touched_the_api


@pytest.mark.parametrize("bad", [None, 7, ["x"], "", "GLOBAL-REGTECH-COMPLIANCE-FEED"])
def test_an_engine_must_be_an_exact_slug(engines: RegulatoryEngines, bad: Any) -> None:
    with pytest.raises(UnknownEngineError):
        engines.run(bad, **run_kwargs())


def test_an_unknown_source_lists_the_active_ones(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(UnknownSourceError) as caught:
        engines.run(REGTECH, **run_kwargs(sources=["ofac", "no_such_source"]))
    assert caught.value.source == "no_such_source"
    assert "ofac" in caught.value.available
    assert "imo_gisis" not in caught.value.available
    assert not fake.touched_the_api


def test_a_source_of_another_engine_is_unknown_here(engines: RegulatoryEngines) -> None:
    with pytest.raises(UnknownSourceError):
        engines.run(TENDERS, **run_kwargs(sources=["ofac"]))


HELD = [
    (REGTECH, "imo_gisis"),
    (REGTECH, "paris_mou_thetis"),
    (REGTECH, "tokyo_mou_apcis"),
    (TENDERS, "ar_cordoba"),
    (TENDERS, "ar_salta"),
    (TENDERS, "ar_mendoza"),
    (TENDERS, "ar_pba"),
    (TENDERS, "au_grantconnect"),
    (TENDERS, "adb_procurement"),
    (TENDERS, "idb_procurement"),
]


@pytest.mark.parametrize("engine,source", HELD)
def test_a_held_source_raises_with_the_recorded_reason(engines: RegulatoryEngines, fake: FakeApifyClient, engine: str, source: str) -> None:
    recorded = load_registry().engine(engine).source(source)
    assert recorded is not None and recorded.held_reason
    with pytest.raises(HeldSourceError) as caught:
        engines.run(engine, **run_kwargs(sources=[source]))
    assert caught.value.reason == recorded.held_reason
    assert caught.value.source == source
    assert recorded.held_reason in str(caught.value)
    assert not fake.touched_the_api


def test_ten_sources_are_held_and_nineteen_are_active() -> None:
    registry = load_registry()
    assert sum(len(engine.held_sources) for engine in registry.engines.values()) == 10
    assert sum(len(engine.active_sources) for engine in registry.engines.values()) == 19
    assert {(engine, source) for engine, source in HELD} == {(e.slug, s.id) for e in registry.engines.values() for s in e.held_sources}


def test_one_held_source_rejects_the_whole_run_even_next_to_an_active_one(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(HeldSourceError):
        engines.run(TENDERS, **run_kwargs(sources=["ar_santafe", "ar_cordoba"]))
    assert not fake.touched_the_api


@pytest.mark.parametrize("bad", ["ofac", b"ofac", None, 5, {"ofac": 1}, {"ofac"}, [], (), [""], ["  "], [None], [5], [["ofac"]]])
def test_sources_must_be_a_non_empty_list_of_id_strings(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(InvalidSourcesError):
        engines.run(REGTECH, **run_kwargs(sources=bad))
    assert not fake.touched_the_api


def test_source_ids_are_normalised_and_deduplicated_like_the_router_does() -> None:
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(sources=[" OFAC ", "ofac", "World_Bank_Debarred", "OFAC"]))
    assert prepared.sources == ("ofac", "world_bank_debarred")
    assert prepared.run_input["sources"] == ["ofac", "world_bank_debarred"]


# ---- the other run parameters --------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["all", "onlyChanged", "onlyNew"])
def test_the_three_delta_modes_are_accepted(mode: str) -> None:
    assert build_run_request(REGTECH, owner="o", **run_kwargs(delta_mode=mode)).run_input["deltaMode"] == mode


@pytest.mark.parametrize("bad", ["onlychanged", "changed", "", None, 1, ["all"]])
def test_other_delta_modes_are_refused(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(InvalidOptionError, match="delta_mode"):
        engines.run(REGTECH, **run_kwargs(delta_mode=bad))
    assert not fake.touched_the_api


@pytest.mark.parametrize("value", [1, 500, 10000])
def test_max_items_per_source_boundaries_are_accepted(value: int) -> None:
    assert build_run_request(REGTECH, owner="o", **run_kwargs(max_items_per_source=value)).run_input["maxItemsPerSource"] == value


@pytest.mark.parametrize("bad", [0, -1, 10001, 1.5, "10", None, True])
def test_max_items_per_source_out_of_range_is_refused(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(InvalidOptionError, match="max_items_per_source"):
        engines.run(REGTECH, **run_kwargs(max_items_per_source=bad))
    assert not fake.touched_the_api


@pytest.mark.parametrize("good", ["weekly-eu", "a", "x" * 40, "0-9", "default"])
def test_valid_state_namespaces(good: str) -> None:
    assert build_run_request(REGTECH, owner="o", **run_kwargs(state_namespace=good)).run_input["stateNamespace"] == good


@pytest.mark.parametrize("bad", ["", "Weekly", "x" * 41, "has space", "under_score", "abc\n", "\u00fcn\u00ef", 5, ["a"]])
def test_invalid_state_namespaces_are_refused(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(InvalidOptionError, match="state_namespace"):
        engines.run(REGTECH, **run_kwargs(state_namespace=bad))
    assert not fake.touched_the_api


def test_no_namespace_means_the_key_is_not_sent() -> None:
    assert "stateNamespace" not in build_run_request(REGTECH, owner="o", **run_kwargs()).run_input


@pytest.mark.parametrize("name", ["wait", "strict_watchlist"])
def test_flags_must_be_booleans(engines: RegulatoryEngines, name: str) -> None:
    with pytest.raises(InvalidOptionError):
        engines.run(REGTECH, **run_kwargs(**{name: "yes"}))


def test_limits_come_from_the_generated_registry() -> None:
    limits = load_registry().limits
    assert (limits.max_items_min, limits.max_items_max, limits.max_items_default) == (1, 10000, 500)
    assert limits.delta_modes == ("all", "onlyChanged", "onlyNew")


# ---- owner ---------------------------------------------------------------------------------------


def test_run_without_an_owner_is_refused_before_any_call(fake: FakeApifyClient) -> None:
    ownerless = RegulatoryEngines(token=TOKEN, client=fake)
    with pytest.raises(ConfigurationError, match="owner"):
        ownerless.run(REGTECH, **run_kwargs())
    assert not fake.touched_the_api


@pytest.mark.parametrize("bad", ["", "a/b", "a~b", "a b", "../x", "x" * 101, "\u00fcn\u00ef", 5])
def test_a_malformed_owner_is_refused(fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(ConfigurationError):
        RegulatoryEngines(token=TOKEN, owner=bad, client=fake)


def test_the_actor_id_is_owner_slash_slug(engines: RegulatoryEngines) -> None:
    for slug in (REGTECH, TENDERS, PATENTS):
        sources = {"global-regtech-compliance-feed": ["ofac"], "latam-global-tender-intelligence": ["ar_santafe"], "global-corporate-patent-intelligence": ["sg_acra"]}[slug]
        assert engines.prepare(slug, **run_kwargs(sources=sources)).actor_id == f"acme-owner/{slug}"


# ---- watchlist ------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [[""], [" "], "   ", "a", ["a"], ["--", "()"], [None, 5], 42, {"a": 1}, ["\u200b\u200b"]])
def test_a_supplied_watchlist_that_sanitises_to_nothing_warns_and_runs_unfiltered(value: Any) -> None:
    with pytest.warns(WatchlistSanitisedToEmptyWarning, match="NO watchlist"):
        prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=value))
    assert "watchlistNames" not in prepared.run_input
    assert prepared.watchlist.keywords == ()


def test_the_run_still_starts_without_a_watchlist_after_the_warning(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.warns(WatchlistSanitisedToEmptyWarning) as caught:
        engines.run(REGTECH, **run_kwargs(watchlist_names=[""]))
    assert caught[0].filename == __file__, "the warning points at the caller of run(), not at the library"
    assert len(fake.calls) == 1
    assert "watchlistNames" not in fake.calls[0].run_input


@pytest.mark.parametrize("value", [[""], "   ", "a", ["a", "--"], 42])
def test_strict_watchlist_raises_instead(engines: RegulatoryEngines, fake: FakeApifyClient, value: Any) -> None:
    with pytest.raises(WatchlistSanitisedToEmptyError):
        engines.run(REGTECH, **run_kwargs(watchlist_names=value, strict_watchlist=True))
    assert not fake.touched_the_api


@pytest.mark.parametrize("value", [None, [], "", (), {}])
def test_no_watchlist_at_all_is_silent_and_sends_nothing(value: Any) -> None:
    with no_warnings():
        prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=value, strict_watchlist=True))
    assert "watchlistNames" not in prepared.run_input


def test_the_cleaned_keywords_are_what_is_sent() -> None:
    raw = ["  Acme   Corp ", "ACME CORP", "", "a", 7, "Ba\u200bnco", "\uff21\uff23\uff2d\uff25"]
    with no_warnings():
        prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=raw))
    assert prepared.run_input["watchlistNames"] == ["Acme Corp", "Banco", "ACME"]


def test_a_bare_string_watchlist_is_split_not_iterated() -> None:
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names="Acme Corp; Beta Ltd\nGamma"))
    assert prepared.run_input["watchlistNames"] == ["Acme Corp", "Beta Ltd", "Gamma"]


def test_partial_rejection_is_logged_without_the_rejected_text(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="regulatory_engines"), no_warnings():
        build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=["Acme", {"codename": "HiddenName"}, "x"]))
    assert "watchlistNames: 1 accepted, 2 rejected (not_a_string=1, too_short=1)." in caplog.text
    assert "HiddenName" not in caplog.text


def test_the_warning_does_not_echo_the_watchlist_text() -> None:
    with pytest.warns(WatchlistSanitisedToEmptyWarning) as caught:
        build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=["hidden-name-" * 30]))  # 360 characters: too_long
    assert "too_long=1" in str(caught[0].message)
    assert "hidden" not in str(caught[0].message)


def test_a_keyword_that_settles_to_one_character_is_rejected_at_once_and_what_is_sent_is_a_fixed_point() -> None:
    # "e", ZERO WIDTH SPACE, COMBINING ACUTE: the guard cleans until nothing changes, so it is judged as U+00E9 (one code point) and is too_short. There is no
    # second pass in the client: the keywords it sends are a fixed point of the guard, so the engine's own pass over them changes nothing.
    lone = ["e\u200b\u0301"]
    with pytest.warns(WatchlistSanitisedToEmptyWarning, match="too_short=1"):
        prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=lone))
    assert "watchlistNames" not in prepared.run_input
    with pytest.raises(WatchlistSanitisedToEmptyError):
        build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=lone, strict_watchlist=True))
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=[*lone, "a\u200b\u0301\u0301", "Acme"]))
    sent = prepared.run_input["watchlistNames"]
    assert sent == ["Acme"], "U+00E1 + U+0301 holds one letter: single_letter_or_digit"
    again = sanitize_keyword_list(sent)
    assert again.keywords == tuple(sent) and again.rejected == ()
    assert prepared.watchlist.keywords == tuple(sent)


def test_a_lone_surrogate_in_the_watchlist_is_rejected_not_sent() -> None:
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=["Acme", "Be\ud800ta", "Gamma"]))
    assert prepared.run_input["watchlistNames"] == ["Acme", "Gamma"]
    assert [item.reason for item in prepared.watchlist.rejected] == ["invalid_unicode"]
    with pytest.warns(WatchlistSanitisedToEmptyWarning, match="invalid_unicode=1"):
        build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=["\ud800"]))


def test_a_circular_watchlist_entry_is_dropped_not_a_crash(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    circular: list[Any] = []
    circular.append(circular)
    engines.run(REGTECH, **run_kwargs(watchlist_names=[circular, "Acme"]))
    assert fake.calls[0].run_input["watchlistNames"] == ["Acme"]


def test_more_than_the_maximum_keywords_are_cut_and_logged() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        prepared = build_run_request(REGTECH, owner="o", **run_kwargs(watchlist_names=[f"kw{index:04d}" for index in range(520)]))
    assert len(prepared.run_input["watchlistNames"]) == 500


# ---- credentials ----------------------------------------------------------------------------------


def test_credentials_go_to_the_top_level_secret_fields_and_never_into_source_options() -> None:
    prepared = build_run_request(
        PATENTS,
        owner="o",
        **run_kwargs(
            sources=["uspto_ptab", "epo_opposition"],
            credentials={"usptoOdpApiKey": USPTO_KEY, "epoOpsConsumerKey": EPO_KEY, "epoOpsConsumerSecret": EPO_SECRET},
            source_options={"epo_opposition": {"patentNumbers": ["EP1234567"]}},
        ),
    )
    run_input = prepared.run_input
    assert run_input["usptoOdpApiKey"] == USPTO_KEY
    assert run_input["epoOpsConsumerKey"] == EPO_KEY
    assert run_input["epoOpsConsumerSecret"] == EPO_SECRET
    assert run_input["sourceOptions"] == {"epo_opposition": {"patentNumbers": ["EP1234567"]}}
    for secret in (USPTO_KEY, EPO_KEY, EPO_SECRET):
        assert secret not in json.dumps(run_input["sourceOptions"])
    assert set(prepared.credential_fields) == {"usptoOdpApiKey", "epoOpsConsumerKey", "epoOpsConsumerSecret"}


def test_credential_fields_in_the_registry_match_the_documented_ones() -> None:
    registry = load_registry()
    assert set(registry.engine(REGTECH).credential_fields) == {"fdaApiKey"}
    assert set(registry.engine(TENDERS).credential_fields) == {"socrataAppToken"}
    assert set(registry.engine(PATENTS).credential_fields) == {"usptoOdpApiKey", "epoOpsConsumerKey", "epoOpsConsumerSecret", "fdaApiKey"}


def test_an_unknown_credential_field_is_refused_and_lists_the_valid_ones(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(CredentialError, match="fdaApiKey"):
        engines.run(REGTECH, **run_kwargs(sources=["fda_ema_recalls"], credentials={"apiKey": FDA_KEY}))
    assert not fake.touched_the_api


@pytest.mark.parametrize("bad", ["", "   ", None, 5, ["k"], "key\nwith-newline", "key\twith-tab", "k\u00e9y", "key\x00"])
def test_a_malformed_credential_value_is_refused_without_echoing_it(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(CredentialError) as caught:
        engines.run(REGTECH, **run_kwargs(sources=["fda_ema_recalls"], credentials={"fdaApiKey": bad}))
    if isinstance(bad, str) and bad.strip():
        assert bad not in str(caught.value)
    assert not fake.touched_the_api


def test_a_credential_for_a_source_that_is_not_selected_is_not_sent(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(CredentialError, match="not selected"):
        engines.run(REGTECH, **run_kwargs(sources=["ofac"], credentials={"fdaApiKey": FDA_KEY}))
    assert not fake.touched_the_api


def test_credentials_must_be_a_mapping() -> None:
    with pytest.raises(CredentialError):
        build_run_request(REGTECH, owner="o", **run_kwargs(sources=["fda_ema_recalls"], credentials=[("fdaApiKey", FDA_KEY)]))


@pytest.mark.parametrize(
    "options",
    [
        {"fdaApiKey": FDA_KEY},
        {"FDAAPIKEY": FDA_KEY},
        {"subSources": ["fda"], "nested": {"deeper": [{"fdaApiKey": FDA_KEY}]}},
    ],
)
def test_a_credential_inside_source_options_is_refused_at_any_depth(engines: RegulatoryEngines, fake: FakeApifyClient, options: dict[str, Any]) -> None:
    with pytest.raises(CredentialError, match="source_options") as caught:
        engines.run(REGTECH, **run_kwargs(sources=["fda_ema_recalls"], source_options={"fda_ema_recalls": options}))
    assert FDA_KEY not in str(caught.value)
    assert not fake.touched_the_api


def test_every_credential_name_of_every_engine_is_refused_in_source_options() -> None:
    for engine in load_registry().engines.values():
        first = engine.active_sources[0].id
        for field in engine.credential_fields.values():
            for name in (field.field, field.option):
                with pytest.raises(CredentialError):
                    build_run_request(engine.slug, owner="o", **run_kwargs(sources=[first], source_options={first: {name: "x"}}))


def test_a_source_that_needs_credentials_is_refused_until_they_are_given(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(InvalidOptionError, match="uspto_ptab requires usptoOdpApiKey"):
        engines.run(PATENTS, **run_kwargs(sources=["uspto_ptab"]))
    with pytest.raises(InvalidOptionError, match="epoOpsConsumerSecret"):
        engines.run(PATENTS, **run_kwargs(sources=["epo_opposition"], credentials={"epoOpsConsumerKey": EPO_KEY}))
    assert not fake.touched_the_api


def test_a_mandatory_source_option_must_come_through_source_options(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(InvalidOptionError, match="ai_crawler_signals requires domains"):
        engines.run(REGTECH, **run_kwargs(sources=["ai_crawler_signals"]))
    for blank in ("", "  ", None):
        with pytest.raises(InvalidOptionError, match="domains"):
            engines.run(REGTECH, **run_kwargs(sources=["ai_crawler_signals"], source_options={"ai_crawler_signals": {"domains": blank}}))
    assert not fake.touched_the_api
    prepared = engines.prepare(REGTECH, **run_kwargs(sources=["ai_crawler_signals"], source_options={"ai_crawler_signals": {"domains": ["example.com"]}}))
    assert prepared.run_input["sourceOptions"] == {"ai_crawler_signals": {"domains": ["example.com"]}}


def test_optional_credentials_are_optional() -> None:
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(sources=["fda_ema_recalls"]))
    assert "fdaApiKey" not in prepared.run_input
    with_key = build_run_request(REGTECH, owner="o", **run_kwargs(sources=["fda_ema_recalls"], credentials={"fdaApiKey": f"  {FDA_KEY}  "}))
    assert with_key.run_input["fdaApiKey"] == FDA_KEY
    tenders = build_run_request(TENDERS, owner="o", **run_kwargs(sources=["it_lombardia_grants"], credentials={"socrataAppToken": SOCRATA_TOKEN}))
    assert tenders.run_input["socrataAppToken"] == SOCRATA_TOKEN


# ---- source_options -------------------------------------------------------------------------------


def test_source_options_for_a_source_that_is_not_selected_are_refused(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    with pytest.raises(InvalidOptionError, match="not one of the selected sources"):
        engines.run(REGTECH, **run_kwargs(sources=["ofac"], source_options={"world_bank_debarred": {}}))
    assert not fake.touched_the_api


@pytest.mark.parametrize("bad", [[("ofac", {})], "ofac", 5, {"ofac": "x"}, {"ofac": [1]}, {"ofac": {1: "x"}}, {5: {}}, {"ofac": {"f": {1, 2}}}, {"ofac": {"f": float("nan")}}])
def test_malformed_source_options_are_refused(engines: RegulatoryEngines, fake: FakeApifyClient, bad: Any) -> None:
    with pytest.raises(InvalidOptionError):
        engines.run(REGTECH, **run_kwargs(source_options=bad))
    assert not fake.touched_the_api


def test_circular_or_absurdly_deep_source_options_are_refused_cleanly_not_with_a_recursion_error(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    circular: dict[str, Any] = {}
    circular["self"] = circular
    deep: dict[str, Any] = {}
    cursor = deep
    for _ in range(5000):
        inner: dict[str, Any] = {}
        cursor["k"] = inner
        cursor = inner
    for options in (circular, deep, {"domains": [circular]}):
        with pytest.raises(InvalidOptionError):
            engines.run(REGTECH, **run_kwargs(sources=["ai_crawler_signals"], source_options={"ai_crawler_signals": options}))
    assert not fake.touched_the_api


def test_source_option_keys_are_normalised_and_the_caller_s_dict_is_not_aliased() -> None:
    options = {"programFilter": ["IRAN"]}
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(source_options={" OFAC ": options}))
    assert prepared.run_input["sourceOptions"] == {"ofac": {"programFilter": ["IRAN"]}}
    options["programFilter"].append("RUSSIA")
    assert prepared.run_input["sourceOptions"]["ofac"]["programFilter"] == ["IRAN"]


def test_two_spellings_of_one_source_in_source_options_are_refused() -> None:
    with pytest.raises(InvalidOptionError, match="two entries"):
        build_run_request(REGTECH, owner="o", **run_kwargs(source_options={"ofac": {}, "OFAC": {}}))


def test_empty_source_options_are_not_sent() -> None:
    assert "sourceOptions" not in build_run_request(REGTECH, owner="o", **run_kwargs(source_options={})).run_input
    assert "sourceOptions" not in build_run_request(REGTECH, owner="o", **run_kwargs(source_options={"ofac": {}})).run_input


# ---- the request as a whole ----------------------------------------------------------------------


def test_a_complete_request_has_exactly_the_documented_input_keys() -> None:
    prepared = build_run_request(
        REGTECH,
        owner="o",
        sources=["sec_enforcement", "fda_ema_recalls"],
        max_total_charge_usd=7,
        delta_mode="onlyNew",
        max_items_per_source=40,
        watchlist_names=["Acme"],
        source_options={"fda_ema_recalls": {"subSources": ["fda"]}},
        credentials={"fdaApiKey": FDA_KEY},
        state_namespace="weekly-eu",
    )
    assert prepared.run_input == {
        "sources": ["sec_enforcement", "fda_ema_recalls"],
        "deltaMode": "onlyNew",
        "maxItemsPerSource": 40,
        "sourceOptions": {"fda_ema_recalls": {"subSources": ["fda"]}},
        "watchlistNames": ["Acme"],
        "stateNamespace": "weekly-eu",
        "fdaApiKey": FDA_KEY,
    }
    assert prepared.max_total_charge_usd == Decimal("7")


def test_prepare_is_a_dry_run_that_never_touches_the_client(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    engines.prepare(REGTECH, **run_kwargs(watchlist_names=["Acme"]))
    assert not fake.touched_the_api


def test_the_redacted_input_hides_credentials_and_the_repr_never_shows_the_input() -> None:
    prepared = build_run_request(REGTECH, owner="o", **run_kwargs(sources=["fda_ema_recalls"], credentials={"fdaApiKey": FDA_KEY}))
    assert prepared.redacted_input()["fdaApiKey"] == "***"
    assert prepared.run_input["fdaApiKey"] == FDA_KEY, "redacting must not mutate the real input"
    for text in (repr(prepared), str(prepared), f"{prepared}", f"{prepared!r}"):
        for secret in ALL_SECRETS:
            assert secret not in text


# ---- errors ---------------------------------------------------------------------------------------


EVERY_ERROR: list[BaseException] = [
    package_errors.RegulatoryEnginesError("base"),
    package_errors.ConfigurationError("config"),
    package_errors.RunInputError("input"),
    package_errors.SpendingCapError("cap"),
    package_errors.UnknownEngineError("nope", ["a", "b"]),
    package_errors.InvalidSourcesError("sources"),
    package_errors.UnknownSourceError("engine", "nope", ["a", "b"]),
    package_errors.HeldSourceError("engine", "src", "a reason"),
    package_errors.InvalidOptionError("option"),
    package_errors.WatchlistSanitisedToEmptyError("watchlist"),
    package_errors.CredentialError("credential"),
    package_errors.EngineApiError("api", original_type="ApiError", status_code=402),
    package_errors.RunNotFinishedError("running"),
    package_errors.RunFailedError("run1", "FAILED", "out of memory"),
    package_errors.RunFailedError("run2", "ABORTED", None),
    package_errors.EngineRowError("row"),
    package_errors.WatchlistSanitisedToEmptyWarning("warn"),
    package_errors.RunNotSucceededWarning("warn"),
]


def test_the_list_of_errors_below_covers_every_error_and_warning_class_of_the_package() -> None:
    declared = {value for value in vars(package_errors).values() if isinstance(value, type) and issubclass(value, (Exception, Warning)) and value.__module__ == package_errors.__name__}
    assert {type(error) for error in EVERY_ERROR} == declared


@pytest.mark.parametrize("error", EVERY_ERROR, ids=[f"{type(error).__name__}-{index}" for index, error in enumerate(EVERY_ERROR)])
def test_every_error_survives_pickle_copy_and_deepcopy_with_its_fields(error: BaseException) -> None:
    """An error raised in a worker process must reach the parent as itself, not as a TypeError about a constructor."""
    clones = [pickle.loads(pickle.dumps(error)), copy.copy(error), copy.deepcopy(error)]
    for clone in clones:
        assert type(clone) is type(error)
        assert str(clone) == str(error)
        assert clone.args == error.args
        assert {key: value for key, value in vars(clone).items()} == {key: value for key, value in vars(error).items()}
