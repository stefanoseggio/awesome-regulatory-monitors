"""A fake HTTP transport under the REAL ``apify_client.ApifyClient``.

Everything above the socket is the real library (request preparation, query parameters, retries, the ``Run`` model, dataset
and key-value helpers); only ``send_request`` is replaced, so the tests see the exact URL, headers and body the library would
put on the wire, and nothing ever leaves the process.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

from apify_client import ApifyClient
from apify_client.http_clients import HttpClient


class FakeResponse:
    """Satisfies the ``HttpResponse`` protocol of ``apify_client``."""

    def __init__(self, status: int, body: bytes = b"", headers: Mapping[str, str] | None = None) -> None:
        self._status = status
        self._body = body
        self._headers = {"content-type": "application/json; charset=utf-8", **(headers or {})}

    @property
    def status_code(self) -> int:
        return self._status

    @property
    def text(self) -> str:
        return self._body.decode("utf-8")

    @property
    def content(self) -> bytes:
        return self._body

    @property
    def headers(self) -> Mapping[str, str]:
        return self._headers

    def json(self) -> Any:
        return json.loads(self._body)

    def read(self) -> bytes:
        return self._body

    async def aread(self) -> bytes:
        return self._body

    def close(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    def iter_bytes(self) -> Iterator[bytes]:
        yield self._body

    async def aiter_bytes(self) -> Any:
        yield self._body


@dataclass
class WireRequest:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None

    @property
    def path(self) -> str:
        return urlsplit(self.url).path

    @property
    def query(self) -> dict[str, list[str]]:
        return parse_qs(urlsplit(self.url).query)

    def header(self, name: str) -> str | None:
        return next((value for key, value in self.headers.items() if key.lower() == name.lower()), None)

    def json_body(self) -> Any:
        assert self.body is not None
        raw = gzip.decompress(self.body) if self.header("Content-Encoding") == "gzip" else self.body
        return json.loads(raw)


Handler = Callable[[WireRequest], FakeResponse]


class Transport(HttpClient):
    """Only ``send_request`` is implemented, as the ``HttpClient`` base class documents."""

    def __init__(self, handler: Handler) -> None:
        super().__init__(max_retries=1)
        self.handler = handler
        self.requests: list[WireRequest] = []

    def send_request(self, *, method: str, url: str, headers: dict[str, str], content: Any, timeout: float | None, stream: bool) -> FakeResponse:  # type: ignore[override]
        request = WireRequest(method, url, dict(headers), content if isinstance(content, (bytes, type(None))) else b"".join(content))
        self.requests.append(request)
        return self.handler(request)


def build_client(token: str, handler: Handler) -> tuple[ApifyClient, Transport]:
    transport = Transport(handler=handler)
    return ApifyClient.with_custom_http_client(token, http_client=transport), transport


def run_object(*, status: str = "SUCCEEDED", run_id: str = "RUNID1", max_total_charge_usd: float | None = 2.5) -> dict[str, Any]:
    """A run object with every field the ``Run`` model of apify-client 3.3 requires."""
    options: dict[str, Any] = {"build": "latest", "timeoutSecs": 3600, "memoryMbytes": 2048, "diskMbytes": 4096}
    if max_total_charge_usd is not None:
        options["maxTotalChargeUsd"] = max_total_charge_usd
    return {
        "id": run_id,
        "actId": "ACTID1",
        "userId": "USERID1",
        "startedAt": "2026-10-21T12:00:00.000Z",
        "finishedAt": None if status in ("READY", "RUNNING") else "2026-10-21T12:01:00.000Z",
        "status": status,
        "statusMessage": "Done",
        "meta": {"origin": "API"},
        "stats": {},
        "options": options,
        "buildId": "BUILDID1",
        "defaultKeyValueStoreId": "KVSTORE1",
        "defaultDatasetId": "DATASET1",
        "defaultRequestQueueId": "RQUEUE1",
    }


def json_response(payload: Any, status: int = 200, headers: Mapping[str, str] | None = None) -> FakeResponse:
    return FakeResponse(status, json.dumps(payload).encode("utf-8"), headers)


def dataset_page(request: WireRequest, items: list[dict[str, Any]]) -> FakeResponse:
    """Serves the page the request asks for (``offset`` and ``limit``); the library keeps paging until it gets an empty page."""
    offset = int(request.query.get("offset", ["0"])[0])
    limit = int(request.query.get("limit", [str(len(items) or 1)])[0])
    page = items[offset : offset + limit] if limit > 0 else items[offset:]
    return json_response(
        page,
        headers={
            "x-apify-pagination-total": str(len(items)),
            "x-apify-pagination-offset": str(offset),
            "x-apify-pagination-count": str(len(page)),
            "x-apify-pagination-limit": str(limit),
            "x-apify-pagination-desc": "false",
        },
    )
