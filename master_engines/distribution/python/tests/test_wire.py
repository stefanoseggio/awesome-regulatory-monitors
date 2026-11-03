"""The real ``apify-client`` under a fake transport: what actually goes on the wire, and that the library's own models parse the replies."""

from __future__ import annotations

import inspect
import json
import logging
from decimal import Decimal
from typing import Any

import pytest
from apify_client import ApifyClient
from apify_client._resource_clients import ActorClient, DatasetClient, KeyValueStoreClient, RunClient
from fakes import EPO_KEY, EPO_SECRET, FDA_KEY, TOKEN, USPTO_KEY, make_row
from wire import FakeResponse, WireRequest, build_client, dataset_page, json_response, run_object

from regulatory_engines import PATENTS, REGTECH, EngineApiError, RegulatoryEngines

# apify-client 3.x addresses Actors under /v2/actors/ (older clients and the n8n templates use the equivalent /v2/acts/ prefix).
ACTOR_PATH = "/v2/actors/acme-owner~global-regtech-compliance-feed/runs"


def standard_handler(request: WireRequest, *, status: str = "SUCCEEDED", items: list[dict[str, Any]] | None = None, cap: float | None = 2.5) -> FakeResponse:
    if request.method == "POST" and request.path.endswith("/runs"):
        return json_response({"data": run_object(status="READY", max_total_charge_usd=cap)}, status=201)
    if request.path == "/v2/actor-runs/RUNID1":
        return json_response({"data": run_object(status=status, max_total_charge_usd=cap)})
    if request.path == "/v2/datasets/DATASET1/items":
        return dataset_page(request, items if items is not None else [make_row()])
    if request.path == "/v2/key-value-stores/KVSTORE1/records/RUN_SUMMARY":
        return json_response({"engine": REGTECH, "totalEmitted": 1, "sources": []})
    return FakeResponse(404, b'{"error":{"type":"record-not-found","message":"no route"}}')


def make_engines(handler: Any = standard_handler) -> tuple[RegulatoryEngines, Any]:
    client, transport = build_client(TOKEN, handler)
    return RegulatoryEngines(token=TOKEN, owner="acme-owner", client=client), transport


def test_the_real_client_puts_the_cap_in_the_query_string_and_the_input_in_the_body() -> None:
    engines, transport = make_engines()
    engines.run(REGTECH, sources=["ofac", "sec_enforcement"], max_total_charge_usd=2.5, watchlist_names=["Acme"], state_namespace="weekly", delta_mode="onlyNew", max_items_per_source=40)
    start = transport.requests[0]
    assert start.method == "POST"
    assert start.path == ACTOR_PATH
    assert start.query["maxTotalChargeUsd"] == ["2.5"]
    assert start.json_body() == {
        "sources": ["ofac", "sec_enforcement"],
        "deltaMode": "onlyNew",
        "maxItemsPerSource": 40,
        "watchlistNames": ["Acme"],
        "stateNamespace": "weekly",
    }
    assert (start.header("Content-Type") or "").startswith("application/json")


@pytest.mark.parametrize("cap,expected", [(5, "5"), (0.01, "0.01"), (1e-9, "0.000000001"), (Decimal("12.50"), "12.50"), (100000, "100000")])
def test_the_cap_reaches_the_wire_in_plain_notation(cap: Any, expected: str) -> None:
    engines, transport = make_engines()
    engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=cap, wait=False)
    assert transport.requests[0].query["maxTotalChargeUsd"] == [expected]


def test_the_token_is_sent_only_as_the_bearer_header() -> None:
    engines, transport = make_engines()
    engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=2.5)
    for request in transport.requests:
        assert request.header("Authorization") == f"Bearer {TOKEN}"
        assert TOKEN not in request.url
        assert TOKEN not in (request.body or b"").decode("latin-1")


def test_wait_polls_the_run_and_the_rows_and_summary_come_through_the_real_helpers() -> None:
    engines, transport = make_engines(lambda request: standard_handler(request, items=[make_row(), make_row(record_id="ofac:2", is_watchlist_match=True, matched_watchlist_keyword="SEA")]))
    run = engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=2.5)
    assert (run.run_id, run.status, run.default_dataset_id, run.default_key_value_store_id) == ("RUNID1", "SUCCEEDED", "DATASET1", "KVSTORE1")
    assert [row.record_id for row in run.items()] == ["ofac:1", "ofac:2"]
    assert [hit.record_id for hit in run.watchlist_hits()] == ["ofac:2"]
    assert run.summary() == {"engine": REGTECH, "totalEmitted": 1, "sources": []}
    paths = [request.path for request in transport.requests]
    assert paths[0] == ACTOR_PATH
    assert "/v2/actor-runs/RUNID1" in paths
    assert "/v2/datasets/DATASET1/items" in paths
    assert "/v2/key-value-stores/KVSTORE1/records/RUN_SUMMARY" in paths


def test_the_run_model_of_the_real_client_reports_the_cap_back() -> None:
    engines, _ = make_engines()
    assert engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=2.5).confirmed_max_total_charge_usd == Decimal("2.5")
    engines_without, _ = make_engines(lambda request: standard_handler(request, cap=None))
    assert engines_without.run(REGTECH, sources=["ofac"], max_total_charge_usd=2.5).confirmed_max_total_charge_usd is None


def test_wait_false_starts_without_polling_and_refresh_reads_the_run() -> None:
    engines, transport = make_engines()
    run = engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=2.5, wait=False)
    assert run.status == "READY"
    assert [request.method for request in transport.requests] == ["POST"]
    run.refresh()
    assert run.status == "SUCCEEDED"
    assert transport.requests[-1].path == "/v2/actor-runs/RUNID1"


def test_credentials_travel_as_top_level_body_fields_only() -> None:
    engines, transport = make_engines()
    engines.run(
        PATENTS,
        sources=["uspto_ptab", "epo_opposition"],
        max_total_charge_usd=3,
        credentials={"usptoOdpApiKey": USPTO_KEY, "epoOpsConsumerKey": EPO_KEY, "epoOpsConsumerSecret": EPO_SECRET},
        source_options={"epo_opposition": {"patentNumbers": ["EP1234567"]}},
        wait=False,
    )
    request = transport.requests[0]
    assert request.path == "/v2/actors/acme-owner~global-corporate-patent-intelligence/runs"
    body = request.json_body()
    assert (body["usptoOdpApiKey"], body["epoOpsConsumerKey"], body["epoOpsConsumerSecret"]) == (USPTO_KEY, EPO_KEY, EPO_SECRET)
    assert json.dumps(body["sourceOptions"]) == '{"epo_opposition": {"patentNumbers": ["EP1234567"]}}'
    assert not any(secret in request.url for secret in (USPTO_KEY, EPO_KEY, EPO_SECRET))


def test_an_api_error_from_the_real_client_is_wrapped_with_its_status_and_scrubbed() -> None:
    def refuse(request: WireRequest) -> FakeResponse:
        return json_response({"error": {"type": "invalid-token", "message": f"Token {TOKEN} is not valid; key {FDA_KEY}"}}, status=401)

    engines, _ = make_engines(refuse)
    with pytest.raises(EngineApiError) as caught:
        engines.run(REGTECH, sources=["fda_ema_recalls"], max_total_charge_usd=2.5, credentials={"fdaApiKey": FDA_KEY})
    assert caught.value.status_code == 401
    assert caught.value.original_type == "UnauthorizedError"
    assert TOKEN not in str(caught.value) and FDA_KEY not in str(caught.value)
    assert "[redacted]" in str(caught.value)


def test_nothing_secret_is_logged_by_this_package_or_the_client(caplog: pytest.LogCaptureFixture) -> None:
    engines, _ = make_engines()
    with caplog.at_level(logging.DEBUG):
        run = engines.run(REGTECH, sources=["fda_ema_recalls"], max_total_charge_usd=2.5, credentials={"fdaApiKey": FDA_KEY}, watchlist_names=["Acme", "x"])
        list(run.items())
        run.summary()
    assert caplog.records, "the real client logs at DEBUG, so this test would notice a leak"
    assert TOKEN not in caplog.text and FDA_KEY not in caplog.text


def test_the_kwargs_this_package_passes_exist_on_the_installed_apify_client() -> None:
    """A contract check against the installed library: a renamed keyword would fail here, not in production."""
    call = inspect.signature(ActorClient.call).parameters
    start = inspect.signature(ActorClient.start).parameters
    for name in ("run_input", "max_total_charge_usd", "logger"):
        assert name in call, name
    for name in ("run_input", "max_total_charge_usd"):
        assert name in start, name
    assert "wait_duration" in inspect.signature(RunClient.wait_for_finish).parameters
    assert "limit" in inspect.signature(DatasetClient.iterate_items).parameters
    assert "key" in inspect.signature(KeyValueStoreClient.get_record).parameters
    for method in ("actor", "run", "dataset", "key_value_store"):
        assert hasattr(ApifyClient, method), method
