"""The run flow against an injected ApifyClient-compatible double: what is sent, what comes back, how failures surface."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest
from fakes import FDA_KEY, TOKEN, FakeApifyClient, FakeRun, make_row, no_warnings

from regulatory_engines import (
    REGTECH,
    EngineApiError,
    EngineRow,
    EngineRowError,
    EngineRun,
    InvalidOptionError,
    RegulatoryEngines,
    RunFailedError,
    RunNotFinishedError,
    RunNotSucceededWarning,
)

KWARGS: dict[str, Any] = {"sources": ["ofac"], "max_total_charge_usd": 2.5}


def test_run_calls_the_actor_with_the_input_and_the_cap_and_waits(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS, watchlist_names=["Acme"], state_namespace="weekly")
    assert [call.operation for call in fake.calls] == ["call"]
    call = fake.calls[0]
    assert call.actor_id == "acme-owner/global-regtech-compliance-feed"
    assert call.run_input == {"sources": ["ofac"], "deltaMode": "onlyChanged", "maxItemsPerSource": 500, "watchlistNames": ["Acme"], "stateNamespace": "weekly"}
    assert call.max_total_charge_usd == Decimal("2.5")
    assert str(call.max_total_charge_usd) == "2.5"
    assert call.extra == {"logger": None}, "no log-streaming thread is started on the caller's behalf"
    assert isinstance(run, EngineRun)
    assert (run.run_id, run.status, run.default_dataset_id, run.default_key_value_store_id) == ("run123", "SUCCEEDED", "ds123", "kv123")
    assert run.engine == REGTECH


def test_run_without_wait_starts_and_returns_immediately(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS, wait=False)
    assert [call.operation for call in fake.calls] == ["start"]
    assert fake.calls[0].max_total_charge_usd == Decimal("2.5")
    assert run.status == "RUNNING"
    assert not run.is_finished
    with pytest.raises(RunNotFinishedError):
        run.items()
    with pytest.raises(RunNotFinishedError):
        run.raise_for_status()


def test_wait_for_finish_updates_the_status_and_unlocks_the_rows(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS, wait=False)
    fake.run_on_wait = FakeRun(status="SUCCEEDED")
    assert run.wait_for_finish(timeout_secs=90) is run
    assert run.status == "SUCCEEDED"
    assert ("run.wait_for_finish", "run123", timedelta(seconds=90)) in fake.events
    assert [row.record_id for row in run.items()] == ["ofac:1"]


@pytest.mark.parametrize("bad", [0, -1, float("nan"), float("inf"), True, "5"])
def test_wait_for_finish_rejects_a_bad_timeout(engines: RegulatoryEngines, bad: Any) -> None:
    run = engines.run(REGTECH, **KWARGS, wait=False)
    with pytest.raises(InvalidOptionError):
        run.wait_for_finish(timeout_secs=bad)


def test_refresh_re_reads_the_run(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS, wait=False)
    fake.run_on_get = FakeRun(status="FAILED", status_message="boom")
    run.refresh()
    assert (run.status, run.status_message) == ("FAILED", "boom")


def test_refresh_of_a_vanished_run_is_an_api_error(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS, wait=False)
    fake.run_on_get = None
    with pytest.raises(EngineApiError, match="not found"):
        run.refresh()


def test_items_are_typed_rows_with_the_connector_fields_as_extras(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [make_row(), make_row(record_id="ofac:2", delta_status="updated", is_new=False, is_watchlist_match=True, matched_watchlist_keyword="SEA", imo="9876543")]
    rows = list(engines.run(REGTECH, **KWARGS).items())
    assert all(isinstance(row, EngineRow) for row in rows)
    first, second = rows
    assert first.engine == REGTECH and first.source == "ofac" and first.record_id == "ofac:1"
    assert first.delta_status == "first_seen" and first.is_new is True
    assert first.is_watchlist_match is False and first.matched_watchlist_keyword is None
    assert first.scraped_at == datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
    assert first.extras == {"vessel_name": "SEA STAR"}
    assert second.delta_status == "updated" and second.matched_watchlist_keyword == "SEA"
    assert second.extras == {"vessel_name": "SEA STAR", "imo": "9876543"}


def test_items_passes_the_limit_to_the_dataset_client(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [make_row(record_id=f"ofac:{index}") for index in range(5)]
    assert len(list(engines.run(REGTECH, **KWARGS).items(limit=2))) == 2
    assert fake.events[-1][:3] == ("dataset.iterate_items", "ds123", 2)


@pytest.mark.parametrize("bad", [0, -1, 1.5, True, "3"])
def test_items_rejects_a_bad_limit(engines: RegulatoryEngines, bad: Any) -> None:
    with pytest.raises(InvalidOptionError):
        engines.run(REGTECH, **KWARGS).items(limit=bad)


def test_watchlist_hits_are_the_matching_rows_only(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [
        make_row(record_id="a"),
        make_row(record_id="b", is_watchlist_match=True, matched_watchlist_keyword="Acme"),
        make_row(record_id="c"),
        make_row(record_id="d", is_watchlist_match=True, matched_watchlist_keyword="Beta"),
    ]
    hits = list(engines.run(REGTECH, **KWARGS).watchlist_hits())
    assert [(hit.record_id, hit.matched_watchlist_keyword) for hit in hits] == [("b", "Acme"), ("d", "Beta")]


def test_a_row_that_breaks_the_contract_names_its_index_and_field(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    broken = make_row()
    del broken["record_id"]
    broken["delta_status"] = "novel"
    fake.items = [make_row(), broken]
    iterator = engines.run(REGTECH, **KWARGS).items()
    assert next(iterator).record_id == "ofac:1"
    with pytest.raises(EngineRowError, match=r"Row 1 of dataset ds123.*record_id.*delta_status") as caught:
        next(iterator)
    assert "novel" not in str(caught.value), "the offending value is not echoed"


def test_a_non_object_row_is_a_contract_error(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = ["not a row"]
    with pytest.raises(EngineRowError):
        list(engines.run(REGTECH, **KWARGS).items())


def test_rows_of_a_failed_run_are_readable_but_warn(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.run_after_call = FakeRun(status="FAILED", status_message="All 1 selected source(s) failed")
    run = engines.run(REGTECH, **KWARGS)
    assert not run.succeeded and run.is_finished
    with pytest.warns(RunNotSucceededWarning, match="FAILED"):
        assert len(list(run.items())) == 1
    with pytest.raises(RunFailedError, match="All 1 selected source") as caught:
        run.raise_for_status()
    assert (caught.value.run_id, caught.value.status) == ("run123", "FAILED")


@pytest.mark.parametrize("status", ["FAILED", "TIMED-OUT", "ABORTED"])
def test_every_non_success_terminal_status_fails_raise_for_status(engines: RegulatoryEngines, fake: FakeApifyClient, status: str) -> None:
    fake.run_after_call = FakeRun(status=status)
    with pytest.raises(RunFailedError):
        engines.run(REGTECH, **KWARGS).raise_for_status()


def test_a_succeeded_run_passes_raise_for_status_and_reads_without_warning(engines: RegulatoryEngines) -> None:
    run = engines.run(REGTECH, **KWARGS)
    assert run.raise_for_status() is run
    with no_warnings():
        assert len(list(run.items())) == 1


@pytest.mark.parametrize("status", ["READY", "RUNNING", "TIMING-OUT", "ABORTING"])
def test_a_run_that_is_still_going_cannot_be_read(engines: RegulatoryEngines, fake: FakeApifyClient, status: str) -> None:
    fake.run_after_call = FakeRun(status=status)
    with pytest.raises(RunNotFinishedError, match=status):
        engines.run(REGTECH, **KWARGS).items()


def test_summary_is_the_run_summary_record(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.records["RUN_SUMMARY"] = {"engine": REGTECH, "totalEmitted": 7, "sources": [{"source": "ofac", "emitted": 7}]}
    assert engines.run(REGTECH, **KWARGS).summary() == {"engine": REGTECH, "totalEmitted": 7, "sources": [{"source": "ofac", "emitted": 7}]}
    assert ("kvs.get_record", "kv123", "RUN_SUMMARY") in fake.events


def test_summary_is_none_when_the_record_is_missing_or_not_an_object(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS)
    assert run.summary() is None
    fake.records["RUN_SUMMARY"] = ["not", "an", "object"]
    assert run.summary() is None


def test_summary_without_a_store_id_does_not_call_the_api(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.run_after_call = FakeRun(default_key_value_store_id="")
    assert engines.run(REGTECH, **KWARGS).summary() is None
    assert not [event for event in fake.events if event[0] == "kvs.get_record"]


def test_a_run_given_as_a_camel_case_mapping_is_understood(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.run_after_call = {
        "id": "runABC",
        "status": "SUCCEEDED",
        "defaultDatasetId": "dsABC",
        "defaultKeyValueStoreId": "kvABC",
        "statusMessage": "Done",
        "options": {"maxTotalChargeUsd": 2.5},
    }
    run = engines.run(REGTECH, **KWARGS)
    assert (run.run_id, run.default_dataset_id, run.default_key_value_store_id, run.status_message) == ("runABC", "dsABC", "kvABC", "Done")
    assert run.confirmed_max_total_charge_usd == Decimal("2.5")


def test_the_cap_the_platform_reports_is_exposed_and_may_be_absent(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    assert engines.run(REGTECH, **KWARGS).confirmed_max_total_charge_usd is None
    fake.run_after_call = FakeRun(options=type("Options", (), {"max_total_charge_usd": 7})())
    assert engines.run(REGTECH, **KWARGS).confirmed_max_total_charge_usd == Decimal("7")


def test_a_status_enum_like_object_is_read_by_value(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.run_after_call = FakeRun(status=type("Status", (), {"value": "SUCCEEDED"})())  # type: ignore[arg-type]
    assert engines.run(REGTECH, **KWARGS).status == "SUCCEEDED"


def test_the_platform_returning_no_run_is_an_error(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.run_after_call = None
    with pytest.raises(EngineApiError, match="no run object"):
        engines.run(REGTECH, **KWARGS)


@pytest.mark.parametrize("broken", [FakeRun(id=""), {"status": "SUCCEEDED"}, FakeRun(status=None)])  # type: ignore[arg-type]
def test_a_run_without_an_id_or_a_status_is_an_error(engines: RegulatoryEngines, fake: FakeApifyClient, broken: Any) -> None:
    fake.run_after_call = broken
    with pytest.raises(EngineApiError):
        engines.run(REGTECH, **KWARGS)


def test_client_errors_become_engine_api_errors_scrubbed_of_every_secret(fake: FakeApifyClient) -> None:
    engines = RegulatoryEngines(token=TOKEN, owner="acme-owner", client=fake)
    fake.fail("call", lambda: RuntimeError(f"401 for Bearer {TOKEN} and key {FDA_KEY}"))
    with pytest.raises(EngineApiError) as caught:
        engines.run(REGTECH, sources=["fda_ema_recalls"], max_total_charge_usd=1, credentials={"fdaApiKey": FDA_KEY})
    message = str(caught.value)
    assert TOKEN not in message and FDA_KEY not in message
    assert message.count("[redacted]") == 2
    assert message.startswith("RuntimeError: ")
    assert caught.value.original_type == "RuntimeError"
    assert caught.value.__cause__ is None and caught.value.__context__ is None, "the original exception, which holds the secret, is not chained at all"


def test_url_encoded_and_base64_forms_of_a_secret_are_scrubbed_too(fake: FakeApifyClient) -> None:
    import base64
    from urllib.parse import quote

    secret = "tok en/with+odd=chars"
    engines = RegulatoryEngines(token=secret.replace(" ", "-"), owner="acme-owner", client=fake)
    token = secret.replace(" ", "-")
    fake.fail("call", lambda: RuntimeError(f"{quote(token, safe='')} {base64.b64encode(token.encode()).decode()}"))
    with pytest.raises(EngineApiError) as caught:
        engines.run(REGTECH, **KWARGS)
    assert quote(token, safe="") not in str(caught.value)
    assert base64.b64encode(token.encode()).decode() not in str(caught.value)


def test_the_http_status_of_a_client_error_is_kept(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    class ApiError(Exception):
        status_code = 402

    fake.fail("start", lambda: ApiError("Insufficient funds"))
    with pytest.raises(EngineApiError) as caught:
        engines.run(REGTECH, **KWARGS, wait=False)
    assert caught.value.status_code == 402
    assert caught.value.original_type == "ApiError"


def test_a_failure_while_reading_rows_is_wrapped_too(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS)
    fake.fail("items_after", lambda: ConnectionError(f"reset while using {TOKEN}"))
    iterator = run.items()
    next(iterator)
    with pytest.raises(EngineApiError) as caught:
        next(iterator)
    assert TOKEN not in str(caught.value)


def test_a_failure_while_reading_the_summary_is_wrapped(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, **KWARGS)
    fake.fail("summary", lambda: TimeoutError("slow"))
    with pytest.raises(EngineApiError, match="TimeoutError"):
        run.summary()


def test_very_long_client_errors_are_cut(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.fail("call", lambda: RuntimeError("x" * 50_000))
    with pytest.raises(EngineApiError) as caught:
        engines.run(REGTECH, **KWARGS)
    assert len(str(caught.value)) <= 2000


def test_two_runs_do_not_share_state(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    first = engines.run(REGTECH, **KWARGS, watchlist_names=["Acme"])
    second = engines.run(REGTECH, **KWARGS)
    assert fake.calls[0].run_input is not fake.calls[1].run_input
    assert "watchlistNames" in fake.calls[0].run_input and "watchlistNames" not in fake.calls[1].run_input
    assert first.run_id == second.run_id == "run123"
