"""regulatory-engines: Python access to the three Master Engine Apify Actors, with the spending cap and the watchlist guard enforced client-side.

``regulatory_engines.langchain_tools`` is the optional LangChain integration (``pip install 'regulatory-engines[langchain]'``);
importing this package never imports it, so the base install works without ``langchain-core``.
"""

from __future__ import annotations

__version__ = "0.1.0"

from ._guards import (
    MAX_BARE_STRING_UNITS,
    MAX_CANDIDATES,
    MAX_HAYSTACK_UNITS,
    MAX_KEYWORD_LENGTH,
    MAX_KEYWORDS,
    MAX_NORMALISE_PASSES,
    MAX_RAW_KEYWORD_UNITS,
    MIN_KEYWORD_LENGTH,
    RejectedKeyword,
    SanitizedKeywordList,
    describe_sanitization,
    find_keyword_match,
    normalise_keyword,
    sanitize_keyword_list,
)
from .client import EngineRow, EngineRun, PreparedRun, RegulatoryEngines, build_run_request, validate_max_total_charge_usd
from .errors import (
    ConfigurationError,
    CredentialError,
    EngineApiError,
    EngineRowError,
    HeldSourceError,
    InvalidOptionError,
    InvalidSourcesError,
    RegulatoryEnginesError,
    RunFailedError,
    RunInputError,
    RunNotFinishedError,
    RunNotSucceededWarning,
    SpendingCapError,
    UnknownEngineError,
    UnknownSourceError,
    WatchlistSanitisedToEmptyError,
    WatchlistSanitisedToEmptyWarning,
)
from .pricing import estimate_worst_case_usd
from .registry import EngineInfo, SourceInfo, load_registry

#: Engine slugs, for ``RegulatoryEngines.run(REGTECH, ...)``.
REGTECH = "global-regtech-compliance-feed"
TENDERS = "latam-global-tender-intelligence"
PATENTS = "global-corporate-patent-intelligence"

__all__ = [
    "MAX_BARE_STRING_UNITS",
    "MAX_CANDIDATES",
    "MAX_HAYSTACK_UNITS",
    "MAX_KEYWORDS",
    "MAX_KEYWORD_LENGTH",
    "MAX_NORMALISE_PASSES",
    "MAX_RAW_KEYWORD_UNITS",
    "MIN_KEYWORD_LENGTH",
    "PATENTS",
    "REGTECH",
    "TENDERS",
    "ConfigurationError",
    "CredentialError",
    "EngineApiError",
    "EngineInfo",
    "EngineRow",
    "EngineRowError",
    "EngineRun",
    "HeldSourceError",
    "InvalidOptionError",
    "InvalidSourcesError",
    "PreparedRun",
    "RegulatoryEngines",
    "RegulatoryEnginesError",
    "RejectedKeyword",
    "RunFailedError",
    "RunInputError",
    "RunNotFinishedError",
    "RunNotSucceededWarning",
    "SanitizedKeywordList",
    "SourceInfo",
    "SpendingCapError",
    "UnknownEngineError",
    "UnknownSourceError",
    "WatchlistSanitisedToEmptyError",
    "WatchlistSanitisedToEmptyWarning",
    "__version__",
    "build_run_request",
    "describe_sanitization",
    "estimate_worst_case_usd",
    "find_keyword_match",
    "load_registry",
    "normalise_keyword",
    "sanitize_keyword_list",
    "validate_max_total_charge_usd",
]
