"""Exceptions and warnings. No message here ever contains the Apify token or a credential value.

Every exception can be pickled and copied (the ones with their own constructor arguments define ``__reduce__``), so an error raised in a
worker process reaches the parent as itself.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any


class RegulatoryEnginesError(Exception):
    """Base class of every error this package raises on purpose."""


class ConfigurationError(RegulatoryEnginesError):
    """The client itself is not usable: no token, no owner, a malformed owner."""


class RunInputError(RegulatoryEnginesError, ValueError):
    """The run request was refused client-side, before any API call. Nothing was started and nothing was billed."""


class SpendingCapError(RunInputError):
    """``max_total_charge_usd`` is missing, not a number, not finite or not greater than zero."""


class UnknownEngineError(RunInputError):
    def __init__(self, engine: Any, known: Sequence[str]) -> None:
        self.engine = engine
        self.known = tuple(known)
        super().__init__(f"Unknown engine {engine!r}. Known engines: {', '.join(self.known)}.")

    def __reduce__(self) -> tuple[Any, ...]:
        return (type(self), (self.engine, self.known))


class InvalidSourcesError(RunInputError):
    """``sources`` is not a non-empty list of source id strings."""


class UnknownSourceError(RunInputError):
    def __init__(self, engine: str, source: str, available: Sequence[str]) -> None:
        self.engine = engine
        self.source = source
        self.available = tuple(available)
        super().__init__(f"Unknown source {source!r} for {engine}. Active sources: {', '.join(self.available)}.")

    def __reduce__(self) -> tuple[Any, ...]:
        return (type(self), (self.engine, self.source, self.available))


class HeldSourceError(RunInputError):
    """The source is registered but held: it cannot run, and ``reason`` is the reason engines.json records for it."""

    def __init__(self, engine: str, source: str, reason: str) -> None:
        self.engine = engine
        self.source = source
        self.reason = reason
        super().__init__(f"Source {source!r} of {engine} is HELD and cannot run: {reason}")

    def __reduce__(self) -> tuple[Any, ...]:
        return (type(self), (self.engine, self.source, self.reason))


class InvalidOptionError(RunInputError):
    """``delta_mode``, ``max_items_per_source``, ``state_namespace``, ``source_options`` or ``wait`` is out of range or malformed."""


class WatchlistSanitisedToEmptyError(RunInputError):
    """Raised with ``strict_watchlist=True``: a non-empty watchlist was supplied but the guard accepted none of it."""


class CredentialError(RunInputError):
    """A credential is unknown for the engine, aimed at a source that is not selected, empty, or missing for a source that needs it."""


class WatchlistSanitisedToEmptyWarning(UserWarning):
    """A non-empty watchlist was supplied but the guard accepted none of it, so the run goes ahead with NO watchlist."""


class RunNotSucceededWarning(UserWarning):
    """Rows are being read from a run that ended in a status other than SUCCEEDED."""


class EngineApiError(RegulatoryEnginesError):
    """The Apify API (or the injected client) failed. The message is scrubbed of the token and of this call's credentials."""

    def __init__(self, message: str, *, original_type: str | None = None, status_code: int | None = None) -> None:
        self.original_type = original_type
        self.status_code = status_code
        super().__init__(message)


class RunNotFinishedError(RegulatoryEnginesError):
    """Rows were requested from a run that has not reached a terminal status."""


class RunFailedError(RegulatoryEnginesError):
    """A run ended in a status other than SUCCEEDED (raised by ``EngineRun.raise_for_status``)."""

    def __init__(self, run_id: str, status: str, status_message: str | None) -> None:
        self.run_id = run_id
        self.status = status
        self.status_message = status_message
        detail = f": {status_message}" if status_message else ""
        super().__init__(f"Run {run_id} ended with status {status}{detail}")

    def __reduce__(self) -> tuple[Any, ...]:
        return (type(self), (self.run_id, self.status, self.status_message))


class EngineRowError(RegulatoryEnginesError):
    """A dataset item does not satisfy the EngineRow contract (a required router field is missing or has the wrong type)."""
