"""Offline doubles for the Apify client. They record every call so tests can prove what was (and was not) sent."""

from __future__ import annotations

import warnings
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

# Obviously fake secrets: the tests assert that these exact strings never appear in a repr, a message or a log.
TOKEN = "apify_api_TESTTOKEN0123456789abcdefghij"
FDA_KEY = "fda-key-SECRET-0123456789"
USPTO_KEY = "uspto-key-SECRET-9876543210"
EPO_KEY = "epo-consumer-key-SECRET-1111"
EPO_SECRET = "epo-consumer-secret-SECRET-2222"
SOCRATA_TOKEN = "socrata-token-SECRET-3333"
ALL_SECRETS = (TOKEN, FDA_KEY, USPTO_KEY, EPO_KEY, EPO_SECRET, SOCRATA_TOKEN)


@dataclass
class FakeRun:
    """Mirrors the attributes of ``apify_client`` ``Run`` that this package reads."""

    id: str = "run123"
    status: str = "SUCCEEDED"
    default_dataset_id: str = "ds123"
    default_key_value_store_id: str = "kv123"
    status_message: str | None = None
    options: Any = None


def make_row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "engine": "global-regtech-compliance-feed",
        "source": "ofac",
        "record_id": "ofac:1",
        "delta_status": "first_seen",
        "is_new": True,
        "is_watchlist_match": False,
        "matched_watchlist_keyword": None,
        "scraped_at": "2026-10-21T12:00:00.000Z",
        "vessel_name": "SEA STAR",
    }
    row.update(overrides)
    return row


@dataclass
class Call:
    operation: str
    actor_id: str
    run_input: Any
    max_total_charge_usd: Any
    extra: dict[str, Any] = field(default_factory=dict)


class FakeActorClient:
    def __init__(self, parent: FakeApifyClient, actor_id: str) -> None:
        self._parent = parent
        self._actor_id = actor_id

    def call(self, *, run_input: Any = None, max_total_charge_usd: Any = None, logger: Any = "default", **extra: Any) -> Any:
        self._parent.calls.append(Call("call", self._actor_id, run_input, max_total_charge_usd, {"logger": logger, **extra}))
        self._parent.maybe_raise("call")
        return self._parent.run_after_call

    def start(self, *, run_input: Any = None, max_total_charge_usd: Any = None, **extra: Any) -> Any:
        self._parent.calls.append(Call("start", self._actor_id, run_input, max_total_charge_usd, dict(extra)))
        self._parent.maybe_raise("start")
        return self._parent.run_after_start


class FakeRunClient:
    def __init__(self, parent: FakeApifyClient, run_id: str) -> None:
        self._parent = parent
        self._run_id = run_id

    def get(self) -> Any:
        self._parent.events.append(("run.get", self._run_id))
        self._parent.maybe_raise("get")
        return self._parent.run_on_get

    def wait_for_finish(self, *, wait_duration: timedelta | None = None) -> Any:
        self._parent.events.append(("run.wait_for_finish", self._run_id, wait_duration))
        self._parent.maybe_raise("wait")
        return self._parent.run_on_wait


class FakeDatasetClient:
    def __init__(self, parent: FakeApifyClient, dataset_id: str) -> None:
        self._parent = parent
        self._dataset_id = dataset_id

    def iterate_items(self, *, limit: int | None = None, **extra: Any) -> Iterator[Any]:
        self._parent.events.append(("dataset.iterate_items", self._dataset_id, limit, dict(extra)))
        self._parent.maybe_raise("items")
        items = self._parent.items if limit is None else self._parent.items[:limit]
        yield from items
        self._parent.maybe_raise("items_after")


class FakeKeyValueStoreClient:
    def __init__(self, parent: FakeApifyClient, store_id: str) -> None:
        self._parent = parent
        self._store_id = store_id

    def get_record(self, key: str) -> Any:
        self._parent.events.append(("kvs.get_record", self._store_id, key))
        self._parent.maybe_raise("summary")
        if key not in self._parent.records:
            return None
        return {"key": key, "value": self._parent.records[key], "content_type": "application/json; charset=utf-8"}


class FakeApifyClient:
    """An ``ApifyClient``-compatible object. Configure the attributes, then inspect ``calls`` and ``events``."""

    def __init__(self, *, run: Any = None, items: list[Any] | None = None, summary: Any = None) -> None:
        self.run_after_call: Any = run if run is not None else FakeRun()
        self.run_after_start: Any = FakeRun(status="RUNNING")
        self.run_on_get: Any = self.run_after_call
        self.run_on_wait: Any = self.run_after_call
        self.items: list[Any] = items if items is not None else [make_row()]
        self.records: dict[str, Any] = {} if summary is None else {"RUN_SUMMARY": summary}
        self.calls: list[Call] = []
        self.events: list[tuple[Any, ...]] = []
        self.failures: dict[str, Callable[[], BaseException]] = {}

    def fail(self, operation: str, make_error: Callable[[], BaseException]) -> None:
        self.failures[operation] = make_error

    def maybe_raise(self, operation: str) -> None:
        if operation in self.failures:
            raise self.failures[operation]()

    @property
    def touched_the_api(self) -> bool:
        return bool(self.calls or self.events)

    def actor(self, actor_id: str) -> FakeActorClient:
        self.events.append(("actor", actor_id))
        return FakeActorClient(self, actor_id)

    def run(self, run_id: str) -> FakeRunClient:
        return FakeRunClient(self, run_id)

    def dataset(self, dataset_id: str) -> FakeDatasetClient:
        return FakeDatasetClient(self, dataset_id)

    def key_value_store(self, key_value_store_id: str) -> FakeKeyValueStoreClient:
        return FakeKeyValueStoreClient(self, key_value_store_id)


@contextmanager
def no_warnings() -> Iterator[None]:
    """Turns any warning raised inside the block into an error."""
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        yield
