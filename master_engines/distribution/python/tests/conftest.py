from __future__ import annotations

import pytest

from fakes import TOKEN, FakeApifyClient
from regulatory_engines import RegulatoryEngines

OWNER = "acme-owner"


@pytest.fixture
def fake() -> FakeApifyClient:
    return FakeApifyClient()


@pytest.fixture
def engines(fake: FakeApifyClient) -> RegulatoryEngines:
    return RegulatoryEngines(token=TOKEN, owner=OWNER, client=fake)
