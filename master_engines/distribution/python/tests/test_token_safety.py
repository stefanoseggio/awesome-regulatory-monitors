"""The Apify token and every credential stay out of reprs, strings, exception messages, warnings, logs and pickles."""

from __future__ import annotations

import base64
import copy
import logging
import pickle
import warnings
from typing import Any
from urllib.parse import quote

import pytest
from apify_client import ApifyClient
from fakes import ALL_SECRETS, FDA_KEY, TOKEN, FakeApifyClient, make_row

import regulatory_engines
from regulatory_engines import (
    PATENTS,
    REGTECH,
    ConfigurationError,
    CredentialError,
    EngineApiError,
    EngineRun,
    HeldSourceError,
    InvalidOptionError,
    InvalidSourcesError,
    RegulatoryEngines,
    RegulatoryEnginesError,
    SpendingCapError,
    UnknownEngineError,
    UnknownSourceError,
    WatchlistSanitisedToEmptyError,
    build_run_request,
)
from regulatory_engines.client import _Secret


def assert_clean(text: str) -> None:
    for secret in ALL_SECRETS:
        assert secret not in text, f"{secret!r} leaked"


def assert_nothing_secret_is_reachable(error: BaseException) -> None:
    """Walks everything an error object leads to (cause, context, the exceptions held by its traceback frames) and checks every text."""
    assert error.__cause__ is None and error.__context__ is None, "the original exception must not be chained, not even hidden"
    seen: set[int] = set()
    pending: list[BaseException | None] = [error]
    while pending:
        item = pending.pop()
        if item is None or id(item) in seen:
            continue
        seen.add(id(item))
        for text in (str(item), repr(item), repr(item.args)):
            assert_clean(text)
            for secret in ALL_SECRETS:
                assert quote(secret, safe="") not in text and base64.b64encode(secret.encode()).decode() not in text
        pending.extend([item.__cause__, item.__context__])
        frame_walker = item.__traceback__
        while frame_walker is not None:
            pending.extend(value for value in list(frame_walker.tb_frame.f_locals.values()) if isinstance(value, BaseException))
            frame_walker = frame_walker.tb_next


def test_repr_and_str_of_the_client_hide_the_token(engines: RegulatoryEngines) -> None:
    for text in (repr(engines), str(engines), f"{engines}", f"{engines!r}", "%s" % engines, "{}".format(engines)):
        assert_clean(text)
    assert "<redacted>" in repr(engines)
    assert "acme-owner" in repr(engines)


def test_the_secret_wrapper_is_redacted_everywhere_and_cannot_be_pickled_or_copied() -> None:
    secret = _Secret(TOKEN)
    for text in (repr(secret), str(secret), f"{secret}", f"{secret!r}", format(secret, ">30"), repr([secret]), repr({"k": secret})):
        assert_clean(text)
    with pytest.raises(TypeError):
        pickle.dumps(secret)
    with pytest.raises(TypeError):
        copy.copy(secret)
    with pytest.raises(TypeError):
        copy.deepcopy(secret)
    assert secret.reveal() == TOKEN


def test_the_client_object_cannot_be_pickled_with_its_token(engines: RegulatoryEngines) -> None:
    with pytest.raises(Exception):
        pickle.dumps(engines)
    assert_clean(repr(vars(engines)))


def test_run_objects_and_rows_carry_no_secret(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    run = engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=1)
    for text in (repr(run), str(run), f"{run}"):
        assert_clean(text)
    row = next(iter(run.items()))
    assert_clean(repr(row))
    assert_clean(str(row.model_dump()))
    assert not any(hasattr(run, name) for name in ("token", "_token", "credentials", "run_input"))
    assert_clean(repr(vars(run)))


def test_every_exception_class_this_package_raises_is_clean() -> None:
    errors: list[BaseException] = []
    engines = RegulatoryEngines(token=TOKEN, owner="acme-owner", client=FakeApifyClient())
    probes: list[tuple[Any, dict[str, Any]]] = [
        (REGTECH, {"sources": ["ofac"], "max_total_charge_usd": None}),
        ("nope", {"sources": ["ofac"], "max_total_charge_usd": 1}),
        (REGTECH, {"sources": "ofac", "max_total_charge_usd": 1}),
        (REGTECH, {"sources": ["nope"], "max_total_charge_usd": 1}),
        (REGTECH, {"sources": ["imo_gisis"], "max_total_charge_usd": 1}),
        (REGTECH, {"sources": ["ofac"], "max_total_charge_usd": 1, "delta_mode": "x"}),
        (REGTECH, {"sources": ["ofac"], "max_total_charge_usd": 1, "watchlist_names": [""], "strict_watchlist": True}),
        (REGTECH, {"sources": ["ofac"], "max_total_charge_usd": 1, "credentials": {"fdaApiKey": FDA_KEY}}),
        (REGTECH, {"sources": ["fda_ema_recalls"], "max_total_charge_usd": 1, "source_options": {"fda_ema_recalls": {"fdaApiKey": FDA_KEY}}}),
        (REGTECH, {"sources": ["fda_ema_recalls"], "max_total_charge_usd": 1, "credentials": {"fdaApiKey": FDA_KEY + "\n"}}),
        (PATENTS, {"sources": ["uspto_ptab"], "max_total_charge_usd": 1}),
    ]
    for engine, kwargs in probes:
        with pytest.raises(RegulatoryEnginesError) as caught:
            engines.run(engine, **kwargs)
        errors.append(caught.value)
    with pytest.raises(ConfigurationError) as no_owner:
        RegulatoryEngines(token=TOKEN, client=FakeApifyClient()).run(REGTECH, sources=["ofac"], max_total_charge_usd=1)
    errors.append(no_owner.value)
    assert {type(error) for error in errors} >= {
        SpendingCapError,
        UnknownEngineError,
        InvalidSourcesError,
        UnknownSourceError,
        HeldSourceError,
        InvalidOptionError,
        WatchlistSanitisedToEmptyError,
        CredentialError,
        ConfigurationError,
    }
    for error in errors:
        assert_clean(str(error))
        assert_clean(repr(error))


def test_a_malformed_token_error_does_not_echo_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    bad = "apify_api_SECRET with space"
    with pytest.raises(ConfigurationError) as caught:
        RegulatoryEngines(token=bad, owner="o")
    assert "SECRET" not in str(caught.value)


def test_no_token_and_no_client_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    with pytest.raises(ConfigurationError, match="APIFY_TOKEN"):
        RegulatoryEngines(owner="o")
    with pytest.raises(ConfigurationError):
        RegulatoryEngines(token="   ", owner="o")


def test_the_token_comes_from_the_environment_and_stays_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIFY_TOKEN", TOKEN)
    engines = RegulatoryEngines(owner="o")
    assert isinstance(engines.client, ApifyClient)
    assert_clean(repr(engines))
    assert_clean(str(engines))


class RecordingClient(FakeApifyClient):
    """Stands in for ``apify_client.ApifyClient`` to see which token the wrapper hands to it."""

    received: list[str] = []

    def __init__(self, token: str | None = None, **kwargs: Any) -> None:
        super().__init__()
        type(self).received.append(token or "")


def test_an_explicit_token_wins_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIFY_TOKEN", "env-token-SHOULD-NOT-BE-USED")
    monkeypatch.setattr("apify_client.ApifyClient", RecordingClient)
    RecordingClient.received = []
    engines = RegulatoryEngines(token=TOKEN, owner="o")
    assert RecordingClient.received == [TOKEN]
    assert "env-token" not in repr(engines)


def test_the_environment_token_is_what_the_client_is_built_with(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIFY_TOKEN", TOKEN)
    monkeypatch.setattr("apify_client.ApifyClient", RecordingClient)
    RecordingClient.received = []
    RegulatoryEngines(owner="o")
    assert RecordingClient.received == [TOKEN]


def test_an_injected_client_needs_no_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    engines = RegulatoryEngines(owner="o", client=FakeApifyClient())
    assert "token=None" in repr(engines)
    run = engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=1)
    assert isinstance(run, EngineRun)


def test_an_unusable_env_token_does_not_break_an_injected_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APIFY_TOKEN", "has a space")
    assert RegulatoryEngines(owner="o", client=FakeApifyClient()).owner == "o"


def test_the_token_is_stripped_of_surrounding_whitespace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    engines = RegulatoryEngines(token=f"  {TOKEN}\n", owner="o")
    assert isinstance(engines.client, ApifyClient)


def test_no_log_record_and_no_warning_carries_a_secret(caplog: pytest.LogCaptureFixture, engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    fake.items = [make_row()]
    with caplog.at_level(logging.DEBUG), warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        run = engines.run(REGTECH, sources=["fda_ema_recalls"], max_total_charge_usd=1, credentials={"fdaApiKey": FDA_KEY}, watchlist_names=["a", {"k": TOKEN}])
        list(run.items())
    assert_clean(caplog.text)
    for item in caught:
        assert_clean(str(item.message))


def test_a_watchlist_containing_a_secret_like_value_is_not_echoed_in_the_warning() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        build_run_request(REGTECH, owner="o", sources=["ofac"], max_total_charge_usd=1, watchlist_names=[{"token": TOKEN}, 12345])
    assert caught and all(TOKEN not in str(item.message) for item in caught)


def test_the_package_never_exports_or_reads_the_token_anywhere_but_the_client_module() -> None:
    import inspect
    import pkgutil

    for module in pkgutil.iter_modules(regulatory_engines.__path__):
        if module.name in {"client"}:
            continue
        source = inspect.getsource(__import__(f"regulatory_engines.{module.name}", fromlist=["x"]))
        assert "APIFY_TOKEN" not in source, module.name
        assert ".reveal(" not in source, module.name


def leaky_error() -> Exception:
    return ConnectionError(f"401 for Bearer {TOKEN}; key {FDA_KEY}; encoded {quote(TOKEN, safe='')}; b64 {base64.b64encode(FDA_KEY.encode()).decode()}")


def _run_failing_at(fake: FakeApifyClient, engines: RegulatoryEngines, operation: str) -> None:
    """Starts a run and makes the double fail with a secret-bearing error at ``operation``, then performs the step that reaches it."""
    request: dict[str, Any] = {"sources": ["fda_ema_recalls"], "max_total_charge_usd": 1, "credentials": {"fdaApiKey": FDA_KEY}}
    if operation in ("call", "start"):
        fake.fail(operation, leaky_error)
        engines.run(REGTECH, **request, wait=operation == "call")
        return
    run = engines.run(REGTECH, **request, wait=False)
    fake.fail(operation, leaky_error)
    if operation == "get":
        run.refresh()
    elif operation == "wait":
        run.wait_for_finish()
    elif operation == "summary":
        run.wait_for_finish()
        run.summary()
    else:  # "items" fails when the first row is requested, "items_after" when the second is
        run.wait_for_finish()
        rows = run.items()
        next(rows)
        next(rows)


@pytest.mark.parametrize("operation", ["call", "start", "get", "wait", "summary", "items", "items_after"])
def test_no_error_from_the_client_leaves_a_secret_reachable_from_the_error_we_raise(engines: RegulatoryEngines, fake: FakeApifyClient, operation: str) -> None:
    """``raise ... from None`` only hides the original from the printed traceback: its message stays one attribute away unless it is never chained."""
    with pytest.raises(EngineApiError) as caught:
        _run_failing_at(fake, engines, operation)
    assert caught.value.original_type == "ConnectionError"
    assert "[redacted]" in str(caught.value)
    assert_nothing_secret_is_reachable(caught.value)


def test_the_formatted_chain_of_a_wrapped_error_is_clean_too(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    import traceback

    with pytest.raises(EngineApiError) as caught:
        _run_failing_at(fake, engines, "call")
    text = "".join(traceback.format_exception(caught.value))
    assert_clean(text)
    assert "During handling of the above exception" not in text and "direct cause" not in text


def test_an_error_whose_text_cannot_be_rendered_is_still_wrapped_and_leaks_nothing(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    class Unprintable(Exception):
        @property
        def status_code(self) -> int:
            raise RuntimeError(f"no status for {TOKEN}")

        def __str__(self) -> str:
            raise RuntimeError(f"cannot print {TOKEN}")

    fake.fail("call", Unprintable)
    with pytest.raises(EngineApiError) as caught:
        engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=1)
    assert caught.value.original_type == "Unprintable"
    assert caught.value.status_code is None
    assert_nothing_secret_is_reachable(caught.value)


def test_an_error_this_package_raises_itself_passes_through_the_guard_unchanged(engines: RegulatoryEngines, fake: FakeApifyClient) -> None:
    sentinel = InvalidOptionError("raised by the double")
    fake.fail("call", lambda: sentinel)
    with pytest.raises(InvalidOptionError) as caught:
        engines.run(REGTECH, sources=["ofac"], max_total_charge_usd=1)
    assert caught.value is sentinel


def test_the_token_is_not_found_in_the_state_of_the_objects_a_caller_can_log() -> None:
    """``engines.client`` is the injected or built ``ApifyClient`` and holds the token in the clear by design; nothing else may."""
    engines = RegulatoryEngines(token=TOKEN, owner="o", client=FakeApifyClient())
    for name, value in vars(engines).items():
        if name != "_client":
            assert_clean(repr(value))
    prepared = engines.prepare(REGTECH, sources=["fda_ema_recalls"], max_total_charge_usd=1, credentials={"fdaApiKey": FDA_KEY})
    for text in (repr(prepared), str(prepared), repr(prepared.watchlist), repr(prepared.redacted_input())):
        assert_clean(text)
