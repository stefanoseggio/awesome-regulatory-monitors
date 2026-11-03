"""``RegulatoryEngines``: a safety-first wrapper around the official ``apify-client`` for the three Master Engine Actors.

Every rule below is enforced client-side, BEFORE any API call, so a refused request starts nothing and bills nothing:

* ``max_total_charge_usd`` is a required keyword and must be a finite number greater than zero. There is no default.
* The engine, every source and the held status of every source are checked against ``data/engines.json``, which is
  generated from the TypeScript registries. A held source raises ``HeldSourceError`` carrying the recorded reason.
* The watchlist goes through an exact port of the TypeScript guard. A non-empty watchlist that sanitises to nothing
  warns (or raises with ``strict_watchlist=True``) instead of silently running unfiltered.
* Credentials go to the engine's top-level secret input fields, never into ``source_options``.

The Apify token is held in a wrapper whose ``repr`` and ``str`` are redacted, is never logged, and is scrubbed from the
message of every error that comes back from the client.

Call signatures were read from ``apify-client`` 3.3.0 (``ActorClient.call``/``start``, ``RunClient.get``/``wait_for_finish``,
``DatasetClient.iterate_items``, ``KeyValueStoreClient.get_record``); the dependency is pinned to ``>=3.3,<4`` for that reason.
"""

from __future__ import annotations

import base64
import copy
import json
import logging
import math
import os
import re
import warnings
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Literal, Protocol, TypeVar
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, ValidationError

from ._guards import SanitizedKeywordList, describe_sanitization, is_supplied, sanitize_keyword_list
from .errors import (
    ConfigurationError,
    CredentialError,
    EngineApiError,
    EngineRowError,
    InvalidOptionError,
    RegulatoryEnginesError,
    RunFailedError,
    RunNotFinishedError,
    RunNotSucceededWarning,
    SpendingCapError,
    WatchlistSanitisedToEmptyError,
    WatchlistSanitisedToEmptyWarning,
)
from .pricing import estimate_worst_case_usd
from .registry import EngineInfo, SourceInfo, credential_option_names, load_registry, normalise_source_id, resolve_sources

logger = logging.getLogger("regulatory_engines")

#: Statuses after which a run no longer changes (``apify-client`` ``_TERMINAL_STATUSES``).
TERMINAL_STATUSES = frozenset({"SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"})
SUMMARY_KEY = "RUN_SUMMARY"

_OWNER_PATTERN = re.compile(r"[A-Za-z0-9_.-]{1,100}")
_MAX_ERROR_CHARS = 2000


class ApifyClientLike(Protocol):
    """The slice of ``apify_client.ApifyClient`` this package uses; an injected test double only needs these four."""

    def actor(self, actor_id: str) -> Any: ...

    def run(self, run_id: str) -> Any: ...

    def dataset(self, dataset_id: str) -> Any: ...

    def key_value_store(self, key_value_store_id: str) -> Any: ...


class _Secret:
    """Holds a secret string. ``repr``, ``str`` and ``format`` are redacted and the object refuses to be pickled or copied."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "<redacted>"

    __str__ = __repr__

    def __format__(self, format_spec: str) -> str:
        return format("<redacted>", format_spec)

    def __reduce__(self) -> Any:
        raise TypeError("a secret cannot be pickled or copied")


def _redactor(secrets: Sequence[str]) -> Callable[[str], str]:
    """Builds a function that removes each secret, its URL-encoded form and its base64 form from a text."""
    needles: set[str] = set()
    for secret in secrets:
        if not secret:
            continue
        needles.add(secret)
        needles.add(quote(secret, safe=""))
        needles.add(base64.b64encode(secret.encode("utf-8")).decode("ascii"))
    ordered = sorted(needles, key=len, reverse=True)

    def redact(text: str) -> str:
        for needle in ordered:
            text = text.replace(needle, "[redacted]")
        return text

    return redact


def _wrap_client_error(exc: BaseException, redact: Callable[[str], str]) -> EngineApiError:
    try:
        text = f"{type(exc).__name__}: {exc}"
    except Exception:
        text = f"{type(exc).__name__}: (the error text could not be rendered)"
    try:
        status = getattr(exc, "status_code", None)
    except Exception:
        status = None
    return EngineApiError(
        redact(text)[:_MAX_ERROR_CHARS],
        original_type=type(exc).__name__,
        status_code=status if isinstance(status, int) and not isinstance(status, bool) else None,
    )


_T = TypeVar("_T")


def _call_client(operation: Callable[[], _T], redact: Callable[[str], str]) -> _T:
    """Runs a call into the Apify client; any failure comes out as an ``EngineApiError`` whose text is scrubbed of the secrets.

    The replacement is raised AFTER the ``except`` block has ended. Raised inside it, Python would keep the original exception
    (whose message may carry the token) reachable as ``__context__``: ``raise ... from None`` only hides it from the printed traceback.
    """
    failure: EngineApiError | None = None
    try:
        return operation()
    except RegulatoryEnginesError:
        raise
    except Exception as exc:
        failure = _wrap_client_error(exc, redact)
    raise failure


class PlainDecimal(Decimal):
    """A ``Decimal`` whose ``str`` is always positional notation. ``apify-client`` puts ``str(max_total_charge_usd)`` in the query string,
    and ``str(Decimal('0.000000001'))`` is ``'1E-9'``, which is not a form to leave to the server's number parser."""

    __slots__ = ()

    def __str__(self) -> str:
        return format(self, "f")


def validate_max_total_charge_usd(value: Any) -> Decimal:
    """Returns the spending cap as a ``Decimal`` that prints in plain notation; raises ``SpendingCapError`` unless it is a finite number greater than zero."""
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise SpendingCapError("max_total_charge_usd is required and must be a finite number greater than zero (USD).")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SpendingCapError("max_total_charge_usd must be a finite number greater than zero (USD).")
        cap = Decimal(repr(value))
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise SpendingCapError("max_total_charge_usd must be a finite number greater than zero (USD).")
        cap = value
    else:
        cap = Decimal(value)
    if cap <= 0:
        raise SpendingCapError("max_total_charge_usd must be greater than zero (USD).")
    return PlainDecimal(format(cap, "f"))


class EngineRow(BaseModel):
    """One dataset row. The fields below are stamped by the router on every row; the connector's own fields are kept as extras."""

    model_config = ConfigDict(extra="allow")

    engine: str
    source: str
    record_id: str
    delta_status: Literal["first_seen", "updated", "unchanged"]
    is_new: bool
    is_watchlist_match: bool
    matched_watchlist_keyword: str | None
    scraped_at: datetime

    @property
    def extras(self) -> dict[str, Any]:
        """The connector-specific fields of the row."""
        return dict(self.model_extra or {})


@dataclass(frozen=True)
class PreparedRun:
    """A validated run request. Nothing has been sent. ``run_input`` may carry credentials, so it is hidden from ``repr``."""

    engine: str
    actor_id: str
    sources: tuple[str, ...]
    max_total_charge_usd: Decimal
    watchlist: SanitizedKeywordList
    run_input: dict[str, Any] = field(repr=False)
    credential_fields: tuple[str, ...] = ()

    def __repr__(self) -> str:
        return (
            f"PreparedRun(engine={self.engine!r}, actor_id={self.actor_id!r}, sources={list(self.sources)!r}, "
            f"max_total_charge_usd={str(self.max_total_charge_usd)!r}, watchlist_keywords={len(self.watchlist.keywords)})"
        )

    __str__ = __repr__

    def redacted_input(self) -> dict[str, Any]:
        """The run input with every credential value replaced by ``***``; safe to print or log."""
        shown = copy.deepcopy(self.run_input)
        for name in self.credential_fields:
            if name in shown:
                shown[name] = "***"
        return shown


def _check_owner(owner: Any) -> str:
    if not isinstance(owner, str) or _OWNER_PATTERN.fullmatch(owner) is None:
        raise ConfigurationError("owner must be the Apify username: letters, digits, '.', '_' or '-' only, 1-100 characters.")
    return owner


def _check_options(engine_info: EngineInfo, delta_mode: Any, max_items_per_source: Any, state_namespace: Any, wait: Any = True) -> None:
    limits = load_registry().limits
    if not isinstance(delta_mode, str) or delta_mode not in limits.delta_modes:
        raise InvalidOptionError(f"delta_mode must be one of {', '.join(limits.delta_modes)}.")
    if isinstance(max_items_per_source, bool) or not isinstance(max_items_per_source, int):
        raise InvalidOptionError("max_items_per_source must be an integer.")
    if not limits.max_items_min <= max_items_per_source <= limits.max_items_max:
        raise InvalidOptionError(f"max_items_per_source must be between {limits.max_items_min} and {limits.max_items_max}.")
    if state_namespace is not None and (not isinstance(state_namespace, str) or re.fullmatch(limits.state_namespace_pattern, state_namespace) is None):
        raise InvalidOptionError('state_namespace must be 1-40 characters of a-z, 0-9 and "-".')
    if not isinstance(wait, bool):
        raise InvalidOptionError("wait must be a bool.")


def _contains_credential_key(value: Any, names: frozenset[str]) -> bool:
    if isinstance(value, Mapping):
        return any(str(key).lower() in names or _contains_credential_key(item, names) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_credential_key(item, names) for item in value)
    return False


def _check_source_options(source_options: Any, selected: tuple[SourceInfo, ...]) -> dict[str, dict[str, Any]]:
    if source_options is None:
        return {}
    if not isinstance(source_options, Mapping):
        raise InvalidOptionError("source_options must be a mapping of source id to that source's options.")
    selected_ids = {source.id for source in selected}
    names = frozenset(name.lower() for name in credential_option_names(load_registry()))
    checked: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    for key, options in source_options.items():
        if not isinstance(key, str):
            raise InvalidOptionError("source_options keys must be source id strings.")
        source_id = normalise_source_id(key)
        if source_id not in selected_ids:
            raise InvalidOptionError(f"source_options has an entry for {key!r}, which is not one of the selected sources.")
        if source_id in seen:
            raise InvalidOptionError(f"source_options has two entries for {source_id!r}.")
        if not isinstance(options, Mapping) or not all(isinstance(option_key, str) for option_key in options):
            raise InvalidOptionError(f"source_options[{key!r}] must be a mapping with string keys.")
        try:
            holds_credential = _contains_credential_key(options, names)
        except RecursionError:
            raise InvalidOptionError(f"source_options[{key!r}] is circular or nested too deeply to be checked.") from None
        if holds_credential:
            raise CredentialError(
                f"source_options[{key!r}] contains a credential field. Credentials are never accepted inside source_options "
                "(Apify only masks top-level secret fields); pass them in credentials=."
            )
        try:
            json.dumps(options, allow_nan=False)
        except (TypeError, ValueError, RecursionError):
            raise InvalidOptionError(f"source_options[{key!r}] must be JSON-serialisable (and not circular or deeply nested).") from None
        seen.add(source_id)
        if options:
            checked[source_id] = copy.deepcopy(dict(options))
    return checked


def _check_credentials(engine_info: EngineInfo, credentials: Any, selected: tuple[SourceInfo, ...]) -> dict[str, str]:
    if credentials is None:
        return {}
    if not isinstance(credentials, Mapping):
        raise CredentialError("credentials must be a mapping of the engine's secret input field names to their values.")
    selected_ids = {source.id for source in selected}
    checked: dict[str, str] = {}
    for name, value in credentials.items():
        if not isinstance(name, str) or name not in engine_info.credential_fields:
            valid = ", ".join(engine_info.credential_fields) or "none"
            raise CredentialError(f"Unknown credential field {name!r} for {engine_info.slug}. Valid fields: {valid}.")
        target = engine_info.credential_fields[name]
        if not isinstance(value, str) or value.strip() == "":
            raise CredentialError(f"credentials[{name!r}] must be a non-empty string.")
        if not all(0x20 <= ord(ch) <= 0x7E for ch in value):
            raise CredentialError(f"credentials[{name!r}] must be printable ASCII (no line breaks or control characters).")
        if target.source not in selected_ids:
            raise CredentialError(
                f"credentials[{name!r}] belongs to source {target.source!r}, which is not selected; "
                "it is not sent so that a secret never reaches a run that cannot use it."
            )
        checked[name] = value.strip()
    return checked


def _check_required_options(
    engine_info: EngineInfo,
    selected: tuple[SourceInfo, ...],
    credentials: Mapping[str, str],
    source_options: Mapping[str, Mapping[str, Any]],
) -> None:
    problems: list[str] = []
    for source in selected:
        provided_by_credentials = {field.option for name, field in engine_info.credential_fields.items() if field.source == source.id and name in credentials}
        provided_by_options = {key for key, value in source_options.get(source.id, {}).items() if value is not None and not (isinstance(value, str) and value.strip() == "")}
        missing = [option for option in source.required_options if option not in provided_by_credentials and option not in provided_by_options]
        if missing:
            problems.append(f"{source.id} requires {', '.join(missing)}")
    if problems:
        raise InvalidOptionError("Missing required input: " + "; ".join(problems) + ". Credentials go in credentials=, other options in source_options=.")


def build_run_request(
    engine: str,
    *,
    owner: str | None,
    sources: Any,
    max_total_charge_usd: Any,
    delta_mode: Any = "onlyChanged",
    max_items_per_source: Any = 500,
    watchlist_names: Any = None,
    source_options: Any = None,
    credentials: Any = None,
    state_namespace: Any = None,
    strict_watchlist: bool = False,
    wait: Any = True,
) -> PreparedRun:
    """Validates everything and builds the Actor input. Pure: no client, no network, no environment.

    Raises a ``RunInputError`` subclass (or ``ConfigurationError`` for a missing/malformed ``owner``) on the first problem.
    """
    cap = validate_max_total_charge_usd(max_total_charge_usd)
    engine_info = load_registry().engine(engine)
    selected = resolve_sources(engine_info, sources)
    _check_options(engine_info, delta_mode, max_items_per_source, state_namespace, wait)
    if not isinstance(strict_watchlist, bool):
        raise InvalidOptionError("strict_watchlist must be a bool.")
    if owner is None:
        raise ConfigurationError("owner is required to build the Actor id '<owner>/<engine>': pass the Apify username that published the Actors.")
    owner = _check_owner(owner)

    watchlist = sanitize_keyword_list(watchlist_names)
    if is_supplied(watchlist_names) and not watchlist.keywords:
        description = describe_sanitization(watchlist)
        if strict_watchlist:
            raise WatchlistSanitisedToEmptyError(f"{description} Nothing usable is left, and strict_watchlist=True refuses to run unfiltered.")
        warnings.warn(
            f"{description} Nothing usable is left, so this run goes ahead with NO watchlist: no record will match and no watchlist-hit will be billed.",
            WatchlistSanitisedToEmptyWarning,
            stacklevel=3,
        )
    elif watchlist.rejected:
        logger.warning("%s", describe_sanitization(watchlist))

    options = _check_source_options(source_options, selected)
    secrets = _check_credentials(engine_info, credentials, selected)
    _check_required_options(engine_info, selected, secrets, options)

    run_input: dict[str, Any] = {
        "sources": [source.id for source in selected],
        "deltaMode": delta_mode,
        "maxItemsPerSource": max_items_per_source,
    }
    if options:
        run_input["sourceOptions"] = options
    if watchlist.keywords:
        run_input["watchlistNames"] = list(watchlist.keywords)
    if state_namespace is not None:
        run_input["stateNamespace"] = state_namespace
    run_input.update(secrets)
    return PreparedRun(
        engine=engine_info.slug,
        actor_id=f"{owner}/{engine_info.slug}",
        sources=tuple(source.id for source in selected),
        max_total_charge_usd=cap,
        watchlist=watchlist,
        run_input=run_input,
        credential_fields=tuple(secrets),
    )


def _field(run: Any, name: str) -> Any:
    """Reads a field from a run object: an ``apify_client`` ``Run`` model (snake_case attributes) or a plain mapping (snake_case or camelCase)."""
    if isinstance(run, Mapping):
        if name in run:
            return run[name]
        parts = name.split("_")
        return run.get(parts[0] + "".join(part.title() for part in parts[1:]))
    return getattr(run, name, None)


class EngineRun:
    """A started (and, with ``wait=True``, finished) Actor run."""

    def __init__(self, client: ApifyClientLike, engine: str, run: Any, *, redact: Callable[[str], str] | None = None) -> None:
        self._client = client
        self._engine = engine
        self._redact: Callable[[str], str] = redact if redact is not None else _redactor(())
        self._load(run)

    def _load(self, run: Any) -> None:
        run_id = _field(run, "id")
        status = _field(run, "status")
        if not isinstance(run_id, str) or run_id == "":
            raise EngineApiError("The platform returned a run without an id.")
        if status is None:
            raise EngineApiError(f"The platform returned run {run_id} without a status.")
        self._run_id: str = run_id
        self._status: str = str(getattr(status, "value", status))
        self._dataset_id: str | None = _field(run, "default_dataset_id")
        self._store_id: str | None = _field(run, "default_key_value_store_id")
        message = _field(run, "status_message")
        self._status_message: str | None = message if isinstance(message, str) else None
        options = _field(run, "options")
        reported = _field(options, "max_total_charge_usd") if options is not None else None
        self._reported_cap: Decimal | None = (
            Decimal(format(Decimal(repr(reported)) if isinstance(reported, float) else Decimal(reported), "f"))
            if isinstance(reported, (int, float)) and not isinstance(reported, bool) and math.isfinite(reported)
            else None
        )

    def __repr__(self) -> str:
        return f"EngineRun(engine={self._engine!r}, run_id={self._run_id!r}, status={self._status!r})"

    __str__ = __repr__

    #: ``estimate_worst_case_usd(engine, rows)``: the upper bound for a run, from the committed event catalog (also exported at package level).
    estimate_worst_case_usd = staticmethod(estimate_worst_case_usd)

    @property
    def engine(self) -> str:
        return self._engine

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def status(self) -> str:
        return self._status

    @property
    def status_message(self) -> str | None:
        return self._status_message

    @property
    def default_dataset_id(self) -> str | None:
        return self._dataset_id

    @property
    def default_key_value_store_id(self) -> str | None:
        return self._store_id

    @property
    def confirmed_max_total_charge_usd(self) -> Decimal | None:
        """The spending cap the platform reports for this run (``options.maxTotalChargeUsd``), or ``None`` when it reports none.

        ``run()`` hands the cap to the platform; this is what the platform says it applied. Compare the two before
        trusting a run to be capped: a ``None`` here means the platform did not echo a cap back.
        """
        return self._reported_cap

    @property
    def is_finished(self) -> bool:
        return self._status in TERMINAL_STATUSES

    @property
    def succeeded(self) -> bool:
        return self._status == "SUCCEEDED"

    def raise_for_status(self) -> EngineRun:
        """Raises ``RunNotFinishedError`` for a running run and ``RunFailedError`` for FAILED, TIMED-OUT or ABORTED; returns ``self`` otherwise."""
        if not self.is_finished:
            raise RunNotFinishedError(f"Run {self._run_id} has status {self._status}; call wait_for_finish() first.")
        if not self.succeeded:
            raise RunFailedError(self._run_id, self._status, self._status_message)
        return self

    def _guard(self, operation: Callable[[], Any]) -> Any:
        return _call_client(operation, self._redact)

    def refresh(self) -> EngineRun:
        """Re-reads the run from the platform and updates ``status``."""
        run = self._guard(lambda: self._client.run(self._run_id).get())
        if run is None:
            raise EngineApiError(f"Run {self._run_id} was not found.")
        self._load(run)
        return self

    def wait_for_finish(self, timeout_secs: float | None = None) -> EngineRun:
        """Blocks until the run reaches a terminal status, or ``timeout_secs`` elapse, then updates ``status``."""
        if timeout_secs is not None and (isinstance(timeout_secs, bool) or not isinstance(timeout_secs, (int, float)) or not math.isfinite(timeout_secs) or timeout_secs <= 0):
            raise InvalidOptionError("timeout_secs must be a finite number greater than zero, or None.")
        duration = None if timeout_secs is None else timedelta(seconds=timeout_secs)
        run = self._guard(lambda: self._client.run(self._run_id).wait_for_finish(wait_duration=duration))
        if run is None:
            raise EngineApiError(f"Run {self._run_id} was not found.")
        self._load(run)
        return self

    def summary(self) -> dict[str, Any] | None:
        """The ``RUN_SUMMARY`` key-value record the engine writes when it finishes, or ``None`` when it was not written (yet)."""
        if not self._store_id:
            return None
        record = self._guard(lambda: self._client.key_value_store(self._store_id).get_record(SUMMARY_KEY))
        value = _field(record, "value") if record is not None else None
        return value if isinstance(value, dict) else None

    def items(self, *, limit: int | None = None) -> Iterator[EngineRow]:
        """Yields the dataset rows as ``EngineRow`` models. The run must have finished (see ``wait_for_finish``)."""
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 1):
            raise InvalidOptionError("limit must be a positive integer, or None.")
        if not self.is_finished:
            raise RunNotFinishedError(f"Run {self._run_id} has status {self._status}; call wait_for_finish() before reading rows.")
        if not self._dataset_id:
            raise EngineApiError(f"Run {self._run_id} has no default dataset.")
        if not self.succeeded:
            warnings.warn(f"Run {self._run_id} ended with status {self._status}; the rows below are whatever was delivered before it stopped.", RunNotSucceededWarning, stacklevel=2)
        return self._iterate_rows(self._dataset_id, limit)

    def _iterate_rows(self, dataset_id: str, limit: int | None) -> Iterator[EngineRow]:
        failure: EngineApiError | None = None
        try:
            for index, item in enumerate(self._client.dataset(dataset_id).iterate_items(limit=limit)):
                try:
                    yield EngineRow.model_validate(item)
                except ValidationError as exc:
                    problems = "; ".join(f"{'.'.join(str(part) for part in error['loc']) or '(row)'}: {error['msg']}" for error in exc.errors(include_input=False))
                    raise EngineRowError(f"Row {index} of dataset {dataset_id} does not satisfy the EngineRow contract: {problems}") from None
        except RegulatoryEnginesError:
            raise
        except Exception as exc:
            failure = _wrap_client_error(exc, self._redact)
        if failure is not None:
            raise failure

    def watchlist_hits(self, *, limit: int | None = None) -> Iterator[EngineRow]:
        """Yields only the rows whose ``is_watchlist_match`` is true. ``limit`` bounds the rows READ, not the hits returned."""
        rows = self.items(limit=limit)
        return (row for row in rows if row.is_watchlist_match)


class RegulatoryEngines:
    """Entry point. ``RegulatoryEngines(token=None, owner=None, client=None)``.

    ``token`` defaults to the ``APIFY_TOKEN`` environment variable. ``owner`` is the Apify username, giving the Actor id
    ``<owner>/<engine-slug>``. ``client`` may be any ``ApifyClient``-compatible object (this is how the tests run offline);
    when it is given no token is needed.
    """

    def __init__(self, token: str | None = None, owner: str | None = None, client: ApifyClientLike | None = None) -> None:
        resolved = token if token is not None else os.environ.get("APIFY_TOKEN")
        if resolved is not None:
            if not isinstance(resolved, str):
                raise ConfigurationError("token must be a string.")
            resolved = resolved.strip() or None
        self._token: _Secret | None = _Secret(resolved) if resolved is not None else None
        self._owner: str | None = _check_owner(owner) if owner is not None else None
        if client is None:
            if resolved is None:
                raise ConfigurationError("No Apify token: pass token=... or set the APIFY_TOKEN environment variable (or inject client=...).")
            if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in resolved):
                raise ConfigurationError("The Apify token must not contain whitespace or control characters.")
            from apify_client import ApifyClient

            client = ApifyClient(token=resolved)
        self._client: ApifyClientLike = client

    def __repr__(self) -> str:
        return f"RegulatoryEngines(owner={self._owner!r}, token={'<redacted>' if self._token is not None else None})"

    __str__ = __repr__

    @property
    def owner(self) -> str | None:
        return self._owner

    @property
    def client(self) -> ApifyClientLike:
        return self._client

    #: ``estimate_worst_case_usd(engine, rows)``: the upper bound for a run, from the committed event catalog (also exported at package level).
    estimate_worst_case_usd = staticmethod(estimate_worst_case_usd)

    @staticmethod
    def engines() -> tuple[EngineInfo, ...]:
        """The three engines, with their sources, held reasons, credential fields and event prices."""
        return tuple(load_registry().engines.values())

    @staticmethod
    def describe(engine: str) -> EngineInfo:
        return load_registry().engine(engine)

    def _redactor_for(self, secrets: Sequence[str]) -> Callable[[str], str]:
        extra = [self._token.reveal()] if self._token is not None else []
        return _redactor([*extra, *secrets])

    def prepare(
        self,
        engine: str,
        *,
        sources: Sequence[str],
        max_total_charge_usd: float | int | Decimal,
        delta_mode: str = "onlyChanged",
        max_items_per_source: int = 500,
        watchlist_names: Sequence[str] | str | None = None,
        source_options: Mapping[str, Mapping[str, Any]] | None = None,
        credentials: Mapping[str, str] | None = None,
        state_namespace: str | None = None,
        strict_watchlist: bool = False,
    ) -> PreparedRun:
        """Validates a run exactly as ``run`` does and returns it without calling the API (a dry run)."""
        return build_run_request(
            engine,
            owner=self._owner,
            sources=sources,
            max_total_charge_usd=max_total_charge_usd,
            delta_mode=delta_mode,
            max_items_per_source=max_items_per_source,
            watchlist_names=watchlist_names,
            source_options=source_options,
            credentials=credentials,
            state_namespace=state_namespace,
            strict_watchlist=strict_watchlist,
        )

    def run(
        self,
        engine: str,
        *,
        sources: Sequence[str],
        max_total_charge_usd: float | int | Decimal,
        delta_mode: str = "onlyChanged",
        max_items_per_source: int = 500,
        watchlist_names: Sequence[str] | str | None = None,
        source_options: Mapping[str, Mapping[str, Any]] | None = None,
        credentials: Mapping[str, str] | None = None,
        state_namespace: str | None = None,
        strict_watchlist: bool = False,
        wait: bool = True,
    ) -> EngineRun:
        """Starts the engine and, with ``wait=True``, waits for it to finish. Returns an ``EngineRun``.

        ``max_total_charge_usd`` is the hard spending cap handed to the platform (``maxTotalChargeUsd``): the run stops
        charging at that amount. It has no default on purpose. All validation happens before the API is called.

        With ``state_namespace=None`` the engine keeps ONE delta memory called ``default`` for every run started this way.
        Runs with different watchlists, source options or delta modes would then consume each other's "new" records, so
        give each distinct job its own namespace.
        """
        request = build_run_request(
            engine,
            owner=self._owner,
            sources=sources,
            max_total_charge_usd=max_total_charge_usd,
            delta_mode=delta_mode,
            max_items_per_source=max_items_per_source,
            watchlist_names=watchlist_names,
            source_options=source_options,
            credentials=credentials,
            state_namespace=state_namespace,
            strict_watchlist=strict_watchlist,
            wait=wait,
        )
        redact = self._redactor_for([request.run_input[name] for name in request.credential_fields])

        def start_the_run() -> Any:
            actor = self._client.actor(request.actor_id)
            if wait:
                return actor.call(run_input=request.run_input, max_total_charge_usd=request.max_total_charge_usd, logger=None)
            return actor.start(run_input=request.run_input, max_total_charge_usd=request.max_total_charge_usd)

        run = _call_client(start_the_run, redact)
        if run is None:
            raise EngineApiError("The platform returned no run object.")
        return EngineRun(self._client, request.engine, run, redact=redact)
