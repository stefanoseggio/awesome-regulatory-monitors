"""The engine registry, loaded from ``data/engines.json`` (generated from the TypeScript registries by ``scripts/generate_distribution_data.ts``)."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from importlib import resources
from typing import Any

from .errors import HeldSourceError, InvalidSourcesError, UnknownEngineError, UnknownSourceError


@dataclass(frozen=True)
class CredentialField:
    """A top-level secret input field of an engine and the source option it feeds."""

    field: str
    source: str
    option: str


@dataclass(frozen=True)
class SourceInfo:
    id: str
    status: str
    description: str
    held_reason: str | None
    required_options: tuple[str, ...]
    #: PPE event billed per delta class (``first_seen``, ``updated``, ``unchanged``); ``None`` for a held source.
    billing: Mapping[str, str] | None

    @property
    def is_active(self) -> bool:
        return self.status == "active"

    @property
    def is_held(self) -> bool:
        return self.status == "held"


@dataclass(frozen=True)
class EventInfo:
    name: str
    title: str
    price_usd: Decimal
    basis: str


@dataclass(frozen=True)
class EngineInfo:
    slug: str
    title: str
    description: str
    memory_mbytes: int
    start_event: str
    start_price_usd: Decimal
    credential_fields: Mapping[str, CredentialField]
    sources: tuple[SourceInfo, ...]
    events: tuple[EventInfo, ...]
    record_level_events: tuple[str, ...]
    watchlist_hit_event: str
    watchlist_hit_price_usd: Decimal

    @property
    def active_sources(self) -> tuple[SourceInfo, ...]:
        return tuple(source for source in self.sources if source.is_active)

    @property
    def held_sources(self) -> tuple[SourceInfo, ...]:
        return tuple(source for source in self.sources if source.is_held)

    def source(self, source_id: str) -> SourceInfo | None:
        for candidate in self.sources:
            if candidate.id == source_id:
                return candidate
        return None

    def event_price(self, name: str) -> Decimal:
        for event in self.events:
            if event.name == name:
                return event.price_usd
        raise KeyError(f"{self.slug} has no event {name!r}")


@dataclass(frozen=True)
class Limits:
    delta_modes: tuple[str, ...]
    default_delta_mode: str
    max_items_min: int
    max_items_max: int
    max_items_default: int
    state_namespace_pattern: str
    min_keyword_length: int
    max_keyword_length: int
    max_keywords: int
    #: A raw keyword longer than this many UTF-16 units is rejected before any Unicode work.
    max_raw_keyword_units: int
    #: Entries of a watchlist that are inspected; the rest are reported as one ``over_limit`` entry.
    max_candidates: int
    #: A bare-string watchlist is cut to this many UTF-16 units before it is split.
    max_bare_string_units: int
    #: A haystack is cut to this many UTF-16 units before it is cleaned and searched.
    max_haystack_units: int
    #: Cleaning passes before a text that keeps changing is declared hostile and treated as empty.
    max_normalise_passes: int
    #: Longest run of consecutive combining marks (``\p{M}``) a text may contain; a text with a longer one is treated as empty.
    max_combining_run: int
    #: The string entries of one list that proceed to Unicode work (``max_raw_keyword_units`` or fewer) may add up to this many UTF-16 units.
    max_total_raw_units: int
    #: Inclusive ``(first, last)`` ranges of the Unicode White_Space characters, which cut a haystack longer than ``max_haystack_units``.
    white_space_ranges: tuple[tuple[int, int], ...]
    #: Inclusive ``(first, last)`` code point ranges the guard removes from keywords and haystacks (Default_Ignorable_Code_Point,
    #: Bidi_Control and the C0/C1 controls), computed on Node by the generator: Python's ``unicodedata`` cannot say what JavaScript removes.
    removed_ranges: tuple[tuple[int, int], ...]
    default_max_watchlist_hits_per_run: int
    default_max_watchlist_spend_usd: Decimal


@dataclass(frozen=True)
class Registry:
    limits: Limits
    engines: Mapping[str, EngineInfo]

    def engine(self, slug: Any) -> EngineInfo:
        if not isinstance(slug, str) or slug not in self.engines:
            raise UnknownEngineError(slug, tuple(self.engines))
        return self.engines[slug]


def _parse_ranges(raw: Any, name: str = "removedRanges") -> tuple[tuple[int, int], ...]:
    """A table of code point ranges, checked: sorted, disjoint, not even adjacent (the generator merges), inside Unicode and free of surrogates."""
    ranges: list[tuple[int, int]] = []
    previous_last = -2
    for entry in raw:
        first, last = int(entry[0]), int(entry[1])
        if not 0 <= first <= last <= 0x10FFFF:
            raise ValueError(f"engines.json {name}: [{first}, {last}] is not a range of code points")
        if first <= previous_last + 1:
            raise ValueError(f"engines.json {name}: [{first}, {last}] overlaps, touches or precedes the range before it")
        if first <= 0xDFFF and last >= 0xD800:
            raise ValueError(f"engines.json {name}: [{first}, {last}] contains surrogates, which the guard rejects before cleaning")
        ranges.append((first, last))
        previous_last = last
    if not ranges:
        raise ValueError(f"engines.json {name} is empty")
    return tuple(ranges)


def _parse_registry(raw: Mapping[str, Any]) -> Registry:
    limits = raw["limits"]
    watchlist = limits["watchlist"]
    parsed_limits = Limits(
        delta_modes=tuple(limits["deltaModes"]),
        default_delta_mode=limits["defaultDeltaMode"],
        max_items_min=int(limits["maxItemsPerSource"]["min"]),
        max_items_max=int(limits["maxItemsPerSource"]["max"]),
        max_items_default=int(limits["maxItemsPerSource"]["default"]),
        state_namespace_pattern=limits["stateNamespacePattern"],
        min_keyword_length=int(watchlist["minKeywordLength"]),
        max_keyword_length=int(watchlist["maxKeywordLength"]),
        max_keywords=int(watchlist["maxKeywords"]),
        max_raw_keyword_units=int(watchlist["maxRawKeywordUnits"]),
        max_candidates=int(watchlist["maxCandidates"]),
        max_bare_string_units=int(watchlist["maxBareStringUnits"]),
        max_haystack_units=int(watchlist["maxHaystackUnits"]),
        max_normalise_passes=int(watchlist["maxNormalisePasses"]),
        max_combining_run=int(watchlist["maxCombiningRun"]),
        max_total_raw_units=int(watchlist["maxTotalRawUnits"]),
        white_space_ranges=_parse_ranges(watchlist["whiteSpaceRanges"], "whiteSpaceRanges"),
        removed_ranges=_parse_ranges(watchlist["removedRanges"]),
        default_max_watchlist_hits_per_run=int(limits["defaultMaxWatchlistHitsPerRun"]),
        default_max_watchlist_spend_usd=Decimal(str(limits["defaultMaxWatchlistSpendUsd"])),
    )
    engines: dict[str, EngineInfo] = {}
    for slug, entry in raw["engines"].items():
        engines[slug] = EngineInfo(
            slug=slug,
            title=entry["title"],
            description=entry["description"],
            memory_mbytes=int(entry["memoryMbytes"]),
            start_event=entry["startEvent"],
            start_price_usd=Decimal(str(entry["startPriceUsd"])),
            credential_fields={
                field: CredentialField(field=field, source=target["source"], option=target["option"])
                for field, target in entry["credentialFields"].items()
            },
            sources=tuple(
                SourceInfo(
                    id=source["id"],
                    status=source["status"],
                    description=source["description"],
                    held_reason=source["heldReason"],
                    required_options=tuple(source["requiredOptions"]),
                    billing=dict(source["billing"]) if source["billing"] is not None else None,
                )
                for source in entry["sources"]
            ),
            events=tuple(
                EventInfo(name=event["name"], title=event["title"], price_usd=Decimal(str(event["priceUsd"])), basis=event["basis"])
                for event in entry["events"]
            ),
            record_level_events=tuple(entry["recordLevelEvents"]),
            watchlist_hit_event=entry["watchlistHit"]["event"],
            watchlist_hit_price_usd=Decimal(str(entry["watchlistHit"]["priceUsd"])),
        )
    return Registry(limits=parsed_limits, engines=engines)


@lru_cache(maxsize=1)
def load_registry() -> Registry:
    """Reads the packaged engines.json once. Prices are parsed as exact decimals (``0.0005`` stays ``0.0005``)."""
    text = resources.files("regulatory_engines").joinpath("data", "engines.json").read_text(encoding="utf-8")
    return _parse_registry(json.loads(text, parse_float=Decimal))


def normalise_source_id(source_id: str) -> str:
    """The router's own normalisation: ``OFAC``, `` ofac `` and ``ofac`` select the same connector."""
    return source_id.strip().lower()


def resolve_sources(engine: EngineInfo, sources: Any) -> tuple[SourceInfo, ...]:
    """Validates ``sources`` against ``engine`` and returns the selected active sources, de-duplicated, in the caller's order.

    Raises ``InvalidSourcesError`` for anything but a non-empty list/tuple of strings, ``UnknownSourceError`` for an
    id the engine does not register and ``HeldSourceError`` (carrying the recorded reason) for a held one. A bare
    string is refused rather than iterated character by character.
    """
    if isinstance(sources, (str, bytes)) or not isinstance(sources, (list, tuple)):
        raise InvalidSourcesError("sources must be a non-empty list of source id strings (a bare string is not accepted).")
    if len(sources) == 0:
        raise InvalidSourcesError("sources must contain at least one source id.")
    selected: list[SourceInfo] = []
    seen: set[str] = set()
    for requested in sources:
        if not isinstance(requested, str) or requested.strip() == "":
            raise InvalidSourcesError("every entry of sources must be a non-empty string.")
        source_id = normalise_source_id(requested)
        if source_id in seen:
            continue
        seen.add(source_id)
        info = engine.source(source_id)
        if info is None:
            raise UnknownSourceError(engine.slug, requested, [s.id for s in engine.active_sources])
        if info.is_held:
            raise HeldSourceError(engine.slug, info.id, info.held_reason or "no reason recorded")
        selected.append(info)
    return tuple(selected)


def credential_option_names(registry: Registry) -> frozenset[str]:
    """Every credential name that must never appear inside ``source_options``: top-level field names and the option names they feed."""
    names: set[str] = set()
    for engine in registry.engines.values():
        for field in engine.credential_fields.values():
            names.add(field.field)
            names.add(field.option)
    return frozenset(names)


def active_source_ids(engine: EngineInfo) -> Sequence[str]:
    return [source.id for source in engine.active_sources]
