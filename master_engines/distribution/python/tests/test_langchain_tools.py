"""The LangChain tools, against the injected fake client."""

from __future__ import annotations

import json
import subprocess
import sys
from decimal import Decimal
from typing import Any

import pytest
from fakes import ALL_SECRETS, EPO_KEY, EPO_SECRET, FDA_KEY, TOKEN, USPTO_KEY, FakeApifyClient, FakeRun, make_row
from langchain_core.tools import StructuredTool

from regulatory_engines import PATENTS, REGTECH, TENDERS, InvalidOptionError, RegulatoryEngines, SpendingCapError, UnknownEngineError, load_registry
from regulatory_engines.langchain_tools import build_tools

CAP = 3


def tools_by_name(engines: RegulatoryEngines, **kwargs: Any) -> dict[str, StructuredTool]:
    kwargs.setdefault("max_total_charge_usd", CAP)
    return {tool.name: tool for tool in build_tools(engines, **kwargs)}


def test_one_structured_tool_per_engine(engines: RegulatoryEngines) -> None:
    tools = build_tools(engines, max_total_charge_usd=CAP)
    assert [tool.name for tool in tools] == ["global_regtech_compliance_feed", "latam_global_tender_intelligence", "global_corporate_patent_intelligence"]
    assert all(isinstance(tool, StructuredTool) for tool in tools)


def test_engines_can_be_selected_and_an_unknown_one_is_refused(engines: RegulatoryEngines) -> None:
    assert [tool.name for tool in build_tools(engines, [TENDERS], max_total_charge_usd=CAP)] == ["latam_global_tender_intelligence"]
    assert len(build_tools(engines, [REGTECH, REGTECH, PATENTS], max_total_charge_usd=CAP)) == 2
    with pytest.raises(UnknownEngineError):
        build_tools(engines, ["nope"], max_total_charge_usd=CAP)
    with pytest.raises(InvalidOptionError):
        build_tools(engines, [], max_total_charge_usd=CAP)


@pytest.mark.parametrize("bad", [None, 0, -1, float("nan"), float("inf"), True, "3"])
def test_a_bad_cap_fails_when_the_tools_are_built(engines: RegulatoryEngines, bad: Any) -> None:
    with pytest.raises(SpendingCapError):
        build_tools(engines, max_total_charge_usd=bad)


def test_the_cap_is_a_required_keyword(engines: RegulatoryEngines) -> None:
    with pytest.raises(TypeError, match="max_total_charge_usd"):
        build_tools(engines)  # type: ignore[call-arg]


@pytest.mark.parametrize("bad", [0, -1, 10_001, 1.5, True, None, "50"])
def test_max_rows_is_validated(engines: RegulatoryEngines, bad: Any) -> None:
    with pytest.raises(InvalidOptionError, match="max_rows"):
        build_tools(engines, max_total_charge_usd=CAP, max_rows=bad)


def test_the_client_must_be_a_regulatory_engines_instance() -> None:
    with pytest.raises(TypeError, match="RegulatoryEngines"):
        build_tools(FakeApifyClient(), max_total_charge_usd=CAP)  # type: ignore[arg-type]


def test_the_args_schema_offers_only_the_four_documented_arguments(engines: RegulatoryEngines) -> None:
    for tool in build_tools(engines, max_total_charge_usd=CAP):
        schema = tool.args_schema.model_json_schema()  # type: ignore[union-attr]
        assert set(schema["properties"]) == {"sources", "watchlist_names", "delta_mode", "max_items_per_source"}
        assert schema["required"] == ["sources"]
        assert schema["additionalProperties"] is False
        assert schema["properties"]["delta_mode"]["enum"] == ["all", "onlyChanged", "onlyNew"]
        assert schema["properties"]["sources"]["minItems"] == 1


def offered_sources(tool: StructuredTool) -> list[str]:
    return tool.args_schema.model_json_schema()["properties"]["sources"]["items"]["enum"]  # type: ignore[union-attr]


def test_the_sources_are_exactly_the_active_sources_of_that_engine(engines: RegulatoryEngines) -> None:
    by_name = tools_by_name(engines)
    assert offered_sources(by_name["global_regtech_compliance_feed"]) == ["ofac", "world_bank_debarred", "uk_modern_slavery", "sec_enforcement", "ai_crawler_signals", "fda_ema_recalls"]
    assert offered_sources(by_name["latam_global_tender_intelligence"]) == ["ar_santafe", "ar_tucuman", "ar_entrerios", "cl_diario_oficial", "eu_ted", "us_florida", "world_bank_notices", "it_lombardia_grants"]
    assert offered_sources(by_name["global_corporate_patent_intelligence"]) == ["uspto_ptab", "epo_opposition", "clinicaltrials_orange_book", "sg_acra", "ae_registers"]
    for engine in load_registry().engines.values():
        assert offered_sources(by_name[engine.slug.replace("-", "_")]) == [source.id for source in engine.active_sources]


def test_sources_that_need_a_credential_or_an_option_are_refused_until_the_application_supplies_them(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    locked = tools_by_name(engines)
    for tool_name, source in (("global_regtech_compliance_feed", "ai_crawler_signals"), ("global_corporate_patent_intelligence", "uspto_ptab"), ("global_corporate_patent_intelligence", "epo_opposition")):
        message = locked[tool_name].invoke({"sources": [source]})
        assert message.startswith(f"Source(s) {source} cannot be used with this tool")
        assert "Nothing was started or billed" in message
    assert not fake.touched_the_api

    unlocked = tools_by_name(
        engines,
        credentials={PATENTS: {"usptoOdpApiKey": USPTO_KEY, "epoOpsConsumerKey": EPO_KEY, "epoOpsConsumerSecret": EPO_SECRET}},
        source_options={REGTECH: {"ai_crawler_signals": {"domains": ["example.com"]}}},
    )
    unlocked["global_corporate_patent_intelligence"].invoke({"sources": ["uspto_ptab", "epo_opposition"]})
    unlocked["global_regtech_compliance_feed"].invoke({"sources": ["ai_crawler_signals"]})
    assert [call.actor_id.split("/")[1] for call in fake.calls] == [PATENTS, REGTECH]
    for tool in unlocked.values():
        assert "Currently unavailable" not in tool.description

    partly = tools_by_name(engines, credentials={PATENTS: {"epoOpsConsumerKey": EPO_KEY}})["global_corporate_patent_intelligence"]
    assert partly.invoke({"sources": ["epo_opposition"]}).startswith("Source(s) epo_opposition cannot be used")


def test_a_held_source_is_never_offered(engines: RegulatoryEngines) -> None:
    for tool in build_tools(engines, max_total_charge_usd=CAP):
        enum = offered_sources(tool)
        for held in ("imo_gisis", "paris_mou_thetis", "ar_cordoba", "ar_pba", "au_grantconnect"):
            assert held not in enum


def test_the_description_is_precise_and_carries_no_secret(engines: RegulatoryEngines) -> None:
    by_name = tools_by_name(engines, max_total_charge_usd=Decimal("3.5"), max_rows=20, credentials={PATENTS: {"usptoOdpApiKey": USPTO_KEY}})
    regtech = by_name["global_regtech_compliance_feed"].description
    assert "global-regtech-compliance-feed" in regtech
    assert "hard spending cap of 3.5 USD" in regtech and "you cannot change it" in regtech
    assert "at most 20 rows" in regtech and "truncated" in regtech
    assert "- ofac:" in regtech and "- sec_enforcement:" in regtech
    assert "imo_gisis" in regtech and "can never run" in regtech
    assert "Currently unavailable" in regtech and "ai_crawler_signals" in regtech.split("Currently unavailable")[1]
    assert "- ai_crawler_signals:" in regtech
    assert "0.15 USD per watchlist hit" in regtech
    assert "0.0005 to 0.05 USD per row" in regtech
    patents = by_name["global_corporate_patent_intelligence"].description
    assert "- uspto_ptab:" in patents and "epo_opposition" in patents.split("Currently unavailable")[1]
    assert "uspto_ptab" not in patents.split("Currently unavailable")[1], "a credential the application supplied makes the source available"
    for tool in by_name.values():
        for secret in ALL_SECRETS:
            assert secret not in tool.description
            assert secret not in json.dumps(tool.args_schema.model_json_schema())  # type: ignore[union-attr]


def test_invoking_a_tool_runs_the_engine_with_the_baked_cap_and_strict_watchlist(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tool = tools_by_name(engines, max_total_charge_usd=Decimal("3.5"))["global_regtech_compliance_feed"]
    output = json.loads(tool.invoke({"sources": ["ofac"], "watchlist_names": ["SEA"], "delta_mode": "onlyNew", "max_items_per_source": 7}))
    call = fake.calls[0]
    assert call.operation == "call"
    assert call.actor_id == "acme-owner/global-regtech-compliance-feed"
    assert call.max_total_charge_usd == Decimal("3.5")
    assert call.run_input == {"sources": ["ofac"], "deltaMode": "onlyNew", "maxItemsPerSource": 7, "watchlistNames": ["SEA"]}
    assert output["engine"] == REGTECH and output["status"] == "SUCCEEDED" and output["run_id"] == "run123"
    assert output["rows_shown"] == 1 and output["truncated"] is False
    assert output["note"] == "All 1 delivered row(s) are shown."
    assert output["rows"][0]["record_id"] == "ofac:1" and output["rows"][0]["vessel_name"] == "SEA STAR"


def test_defaults_apply_when_the_model_sends_only_sources(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tools_by_name(engines, max_rows=30)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]})
    assert fake.calls[0].run_input == {"sources": ["ofac"], "deltaMode": "onlyChanged", "maxItemsPerSource": 30}


def test_the_model_cannot_raise_the_cap_an_extra_argument_is_refused_and_nothing_runs(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tool = tools_by_name(engines)["global_regtech_compliance_feed"]
    message = tool.invoke({"sources": ["ofac"], "max_total_charge_usd": 1000})
    assert message.startswith("Tool input validation error:")
    assert "max_total_charge_usd: Extra inputs are not permitted" in message
    assert "1000" not in message, "the offending value is not echoed back"
    assert not fake.touched_the_api


def test_the_cap_passed_at_build_time_is_the_one_every_call_gets(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tools = tools_by_name(engines, max_total_charge_usd=0.25)
    tools["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]})
    tools["latam_global_tender_intelligence"].invoke({"sources": ["ar_santafe"]})
    assert [call.max_total_charge_usd for call in fake.calls] == [Decimal("0.25"), Decimal("0.25")]
    assert [call.actor_id for call in fake.calls] == ["acme-owner/global-regtech-compliance-feed", "acme-owner/latam-global-tender-intelligence"]


@pytest.mark.parametrize(
    "arguments",
    [
        {"sources": ["imo_gisis"]},
        {"sources": ["ar_cordoba"]},
        {"sources": []},
        {"sources": "ofac"},
        {"sources": ["ofac"], "delta_mode": "everything"},
        {"sources": ["ofac"], "max_items_per_source": 0},
        {"sources": ["ofac"], "max_items_per_source": 51},
        {"sources": ["ofac"], "watchlist_names": [1, 2]},
        {},
    ],
)
def test_arguments_outside_the_schema_never_reach_the_api(engines: RegulatoryEngines, fake: FakeApifyClient, arguments: dict[str, Any]) -> None:
    tool = tools_by_name(engines)["global_regtech_compliance_feed"]
    result = tool.invoke(arguments)
    assert result.startswith("Tool input validation error:"), result
    assert not fake.touched_the_api


def test_a_watchlist_that_sanitises_to_nothing_is_an_error_the_model_reads(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tool = tools_by_name(engines)["global_regtech_compliance_feed"]
    message = tool.invoke({"sources": ["ofac"], "watchlist_names": ["", "a"]})
    assert message.startswith("Request refused before any run started; nothing was billed.")
    assert "strict_watchlist=True" in message
    assert not fake.touched_the_api


def test_rows_are_cut_at_max_rows_with_a_clear_note_that_billing_is_unaffected(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [make_row(record_id=f"ofac:{index}") for index in range(120)]
    fake.records["RUN_SUMMARY"] = {"engine": REGTECH, "totalEmitted": 120, "sources": [{"source": "ofac", "fetched": 120, "emitted": 120}]}
    output = json.loads(tools_by_name(engines, max_rows=50)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]}))
    assert output["rows_shown"] == 50 and len(output["rows"]) == 50 and output["truncated"] is True
    assert output["rows"][-1]["record_id"] == "ofac:49"
    assert output["note"].startswith("TRUNCATED: showing the first 50 of 120 rows")
    assert "other 70" in output["note"] and "dataset ds123 of run run123" in output["note"]
    assert "delivered and billed even though they are not shown" in output["note"]


def test_truncation_without_a_summary_still_says_so(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [make_row(record_id=f"r{index}") for index in range(5)]
    output = json.loads(tools_by_name(engines, max_rows=3)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]}))
    assert output["rows_shown"] == 3 and output["truncated"] is True and output["summary"] is None
    assert output["note"].startswith("TRUNCATED: showing the first 3 rows; more exist in dataset ds123 of run run123.")
    assert "delivered and billed even though they are not shown" in output["note"]


def test_exactly_max_rows_is_not_truncated(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [make_row(record_id=f"r{index}") for index in range(4)]
    output = json.loads(tools_by_name(engines, max_rows=4)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]}))
    assert output["rows_shown"] == 4 and output["truncated"] is False


def test_an_empty_result_is_reported_plainly(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = []
    output = json.loads(tools_by_name(engines)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]}))
    assert output["rows"] == [] and output["note"] == "All 0 delivered row(s) are shown."


def test_the_summary_is_trimmed_to_what_a_model_needs(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.records["RUN_SUMMARY"] = {
        "engine": REGTECH,
        "deltaMode": "onlyChanged",
        "totalEmitted": 1,
        "stoppedOnChargeLimit": False,
        "startedAt": "2026-10-21T12:00:00.000Z",
        "watchlist": {"accepted": 1, "rejected": 0, "hitsCharged": 0, "hitsUnpriced": 0},
        "pricing": {"unpricedEvents": []},
        "sources": [{"source": "ofac", "fetched": 1, "emitted": 1, "firstSeen": 1, "updated": 0, "unchanged": 0, "watchlistHits": 0, "warnings": ["w1", "w2", "w3", "w4", "w5"], "error": "boom"}, "junk"],
    }
    output = json.loads(tools_by_name(engines)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]}))
    summary = output["summary"]
    assert "startedAt" not in summary
    assert summary["sources"] == [{"source": "ofac", "fetched": 1, "emitted": 1, "firstSeen": 1, "updated": 0, "unchanged": 0, "watchlistHits": 0, "error": "boom", "warnings": ["w1", "w2", "w3"]}]
    assert summary["watchlist"]["accepted"] == 1 and summary["stoppedOnChargeLimit"] is False


def test_a_failed_run_is_an_error_message_not_an_empty_success(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.run_after_call = FakeRun(status="FAILED", status_message="All 1 selected source(s) failed and nothing was delivered.")
    message = tools_by_name(engines)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]})
    assert message.startswith("Run run123 ended with status FAILED: All 1 selected source(s) failed")
    assert "may have been billed" in message and "dataset ds123" in message


def test_an_api_failure_is_reported_without_a_secret(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.fail("call", lambda: RuntimeError(f"upstream said no, token {TOKEN}"))
    message = tools_by_name(engines)["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]})
    assert message.startswith("The run could not be completed.")
    assert TOKEN not in message


def test_credentials_baked_into_the_tools_reach_the_run_only_for_the_selected_sources(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tool = tools_by_name(engines, credentials={PATENTS: {"usptoOdpApiKey": USPTO_KEY, "epoOpsConsumerKey": EPO_KEY, "epoOpsConsumerSecret": EPO_SECRET, "fdaApiKey": FDA_KEY}})["global_corporate_patent_intelligence"]
    tool.invoke({"sources": ["uspto_ptab", "sg_acra"]})
    run_input = fake.calls[0].run_input
    assert run_input["usptoOdpApiKey"] == USPTO_KEY
    assert not {"epoOpsConsumerKey", "epoOpsConsumerSecret", "fdaApiKey"} & set(run_input), "a secret is not sent to a run that cannot use it"
    output = tool.invoke({"sources": ["clinicaltrials_orange_book"]})
    assert fake.calls[1].run_input["fdaApiKey"] == FDA_KEY
    for secret in ALL_SECRETS:
        assert secret not in output


def test_source_options_baked_into_the_tools_are_sent_for_the_selected_sources_only(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tool = tools_by_name(engines, source_options={REGTECH: {"ai_crawler_signals": {"domains": ["example.com"]}, "ofac": {"vesselNameContains": "STAR"}}})["global_regtech_compliance_feed"]
    tool.invoke({"sources": ["ofac"]})
    assert fake.calls[0].run_input["sourceOptions"] == {"ofac": {"vesselNameContains": "STAR"}}
    tool.invoke({"sources": ["ai_crawler_signals"]})
    assert fake.calls[1].run_input["sourceOptions"] == {"ai_crawler_signals": {"domains": ["example.com"]}}


def test_the_state_namespace_is_baked_in(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    tools_by_name(engines, state_namespace="agent-prod")["global_regtech_compliance_feed"].invoke({"sources": ["ofac"]})
    assert fake.calls[0].run_input["stateNamespace"] == "agent-prod"


def test_baked_in_arguments_are_validated_when_the_tools_are_built(engines: RegulatoryEngines) -> None:
    with pytest.raises(InvalidOptionError):
        build_tools(engines, max_total_charge_usd=CAP, credentials={"not-an-engine": {}})
    with pytest.raises(InvalidOptionError):
        build_tools(engines, [PATENTS], max_total_charge_usd=CAP, credentials={PATENTS: {}}, source_options={"not-an-engine": {}})


def test_the_tools_are_synchronous_and_return_strings(engines: RegulatoryEngines) -> None:
    tool = tools_by_name(engines)["global_regtech_compliance_feed"]
    assert isinstance(tool.invoke({"sources": ["ofac"]}), str)
    assert tool.coroutine is None


def test_importing_the_package_does_not_import_langchain_and_the_submodule_explains_a_missing_one() -> None:
    program = (
        "import sys\n"
        "import regulatory_engines\n"
        "assert 'langchain_core' not in sys.modules, 'the base import must not need langchain'\n"
        "print('base import ok')\n"
        "sys.modules['langchain_core'] = None\n"
        "sys.modules['langchain_core.tools'] = None\n"
        "try:\n"
        "    import regulatory_engines.langchain_tools\n"
        "except ImportError as exc:\n"
        "    print(exc)\n"
        "else:\n"
        "    raise SystemExit('the import should have failed')\n"
    )
    completed = subprocess.run([sys.executable, "-I", "-c", program], capture_output=True, text=True, check=False, timeout=60)
    assert completed.returncode == 0, completed.stderr
    assert "base import ok" in completed.stdout
    assert "pip install 'regulatory-engines[langchain]'" in completed.stdout
    assert "langchain-core" in completed.stdout
