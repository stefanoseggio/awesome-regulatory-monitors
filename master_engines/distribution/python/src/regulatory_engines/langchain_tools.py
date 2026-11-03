"""LangChain tools for the three engines: one ``StructuredTool`` per engine.

Needs ``langchain-core`` (``pip install 'regulatory-engines[langchain]'``); importing this module without it raises an ``ImportError``
that says so. Importing ``regulatory_engines`` itself never imports this module.

What the model can and cannot do:

* It chooses ``sources`` (only active sources of that engine), ``watchlist_names``, ``delta_mode`` and ``max_items_per_source``.
* It cannot raise the spending cap: ``max_total_charge_usd`` is fixed by the application when it calls ``build_tools`` and is not
  an argument of any tool. An argument the schema does not define (such as ``max_total_charge_usd``) is refused, not ignored.
* It never sees a credential. Credentials and source options are passed to ``build_tools`` by the application. ``sources`` lists every
  active source of the engine (never a held one); a source that needs a credential or a mandatory option the application did not give
  is flagged in the description and refused, with nothing billed, if the model asks for it.
* The watchlist is run in strict mode: a watchlist that sanitises to nothing is an error the model reads, not a silently unfiltered run.
* The answer is cut to ``max_rows`` rows with an explicit truncation note. Truncation limits what the model reads; every row the run
  delivered was still billed, and the note says so.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from decimal import Decimal
from typing import Any, Literal

try:
    from langchain_core.tools import StructuredTool, ToolException
except ImportError as exc:  # pragma: no cover - exercised by simulating the missing module in the tests
    raise ImportError(
        "regulatory_engines.langchain_tools needs the 'langchain-core' package. "
        "Install it with: pip install 'regulatory-engines[langchain]'"
    ) from exc

from pydantic import ConfigDict, Field, create_model

from .client import RegulatoryEngines, validate_max_total_charge_usd
from .errors import InvalidOptionError, RegulatoryEnginesError, RunInputError
from .registry import EngineInfo, SourceInfo, load_registry

MAX_ROWS_LIMIT = 10_000
_DESCRIPTION_SOURCE_CHARS = 170


def _first_sentence(text: str) -> str:
    cut = text.split(". ")[0].strip()
    if not cut.endswith("."):
        cut += "."
    return cut if len(cut) <= _DESCRIPTION_SOURCE_CHARS else cut[: _DESCRIPTION_SOURCE_CHARS - 3].rstrip() + "..."


def _runnable_sources(
    engine: EngineInfo,
    credentials: Mapping[str, str],
    source_options: Mapping[str, Mapping[str, Any]],
) -> tuple[SourceInfo, ...]:
    """Active sources whose mandatory options are all supplied by the application (credential fields or source options)."""
    runnable: list[SourceInfo] = []
    for source in engine.active_sources:
        provided = {field.option for name, field in engine.credential_fields.items() if field.source == source.id and name in credentials}
        provided |= {key for key, value in source_options.get(source.id, {}).items() if value not in (None, "")}
        if all(option in provided for option in source.required_options):
            runnable.append(source)
    return tuple(runnable)


def _price_range(engine: EngineInfo, sources: tuple[SourceInfo, ...]) -> tuple[Decimal, Decimal]:
    names: set[str] = set(engine.record_level_events)
    for source in sources:
        if source.billing is not None:
            names.update(source.billing.values())
    prices = [engine.event_price(name) for name in names]
    return min(prices), max(prices)


def _describe(engine: EngineInfo, runnable: tuple[SourceInfo, ...], cap: Decimal, max_rows: int) -> str:
    low, high = _price_range(engine, runnable)
    usable = {source.id for source in runnable}
    unavailable = [source.id for source in engine.active_sources if source.id not in usable]
    held = [source.id for source in engine.held_sources]
    lines = [
        f"{engine.title}. Runs the Apify Actor {engine.slug} once per call and returns the rows it delivers.",
        "Sources (pass these ids in `sources`):",
        *[f"- {source.id}: {_first_sentence(source.description)}" for source in engine.active_sources],
    ]
    if unavailable:
        lines.append(f"Currently unavailable, because they need a credential or a mandatory option this tool was not given (a call that asks for them is refused): {', '.join(unavailable)}.")
    if held:
        lines.append(f"Held sources that can never run: {', '.join(held)}.")
    lines += [
        f"Cost: every delivered row is billed (about {low} to {high} USD per row depending on the source) plus {engine.watchlist_hit_price_usd} USD per watchlist hit "
        f"and a start fee of {engine.start_price_usd} USD per GB of Actor memory. Each call has a hard spending cap of {cap} USD fixed by the application; you cannot change it, "
        "and a run stops charging when it is reached.",
        "delta_mode: 'onlyChanged' (default) returns records that are new or changed since the previous run with the same state; 'onlyNew' returns only new ones; "
        "'all' returns every record, unchanged ones included. Records already delivered are not returned again in the first two modes.",
        "watchlist_names: optional keywords matched case-insensitively against each record's names; matching rows have is_watchlist_match=true. "
        "Entries shorter than 2 characters, blank or punctuation-only are dropped; if none survive the call fails instead of running unfiltered.",
        f"Output: JSON with the run id and status, a short run summary and at most {max_rows} rows; when more rows exist the output says it is truncated "
        "(the truncated rows were still delivered and billed).",
    ]
    return "\n".join(lines)


def _explain_validation_error(error: Exception) -> str:
    """What the model reads when its arguments do not fit the schema: the fields and the rules, never the values it sent."""
    details = getattr(error, "errors", None)
    if not callable(details):
        return "Tool input validation error: the arguments do not match the tool's schema."
    problems = "; ".join(f"{'.'.join(str(part) for part in item['loc']) or '(input)'}: {item['msg']}" for item in details(include_input=False))
    return f"Tool input validation error: {problems}"


def _trim_summary(summary: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if summary is None:
        return None
    sources = []
    for entry in summary.get("sources", []) if isinstance(summary.get("sources"), list) else []:
        if not isinstance(entry, Mapping):
            continue
        trimmed = {key: entry.get(key) for key in ("source", "fetched", "emitted", "firstSeen", "updated", "unchanged", "watchlistHits") if key in entry}
        if "error" in entry:
            trimmed["error"] = entry["error"]
        warnings_list = entry.get("warnings")
        if isinstance(warnings_list, list) and warnings_list:
            trimmed["warnings"] = warnings_list[:3]
        sources.append(trimmed)
    keep = {key: summary[key] for key in ("engine", "deltaMode", "totalEmitted", "stoppedOnChargeLimit", "watchlist", "pricing") if key in summary}
    keep["sources"] = sources
    return keep


def _make_function(
    client: RegulatoryEngines,
    engine: EngineInfo,
    cap: Decimal,
    max_rows: int,
    default_items: int,
    credentials: Mapping[str, str],
    source_options: Mapping[str, Mapping[str, Any]],
    state_namespace: str | None,
    unavailable: frozenset[str],
) -> Any:
    def run_engine(
        sources: list[str],
        watchlist_names: list[str] | None = None,
        delta_mode: str = "onlyChanged",
        max_items_per_source: int = default_items,
    ) -> str:
        selected = {source.lower().strip() for source in sources}
        blocked = sorted(selected & unavailable)
        if blocked:
            raise ToolException(
                f"Source(s) {', '.join(blocked)} cannot be used with this tool: they need a credential or a mandatory option the application did not configure. "
                f"Nothing was started or billed. Choose other sources."
            )
        run_credentials = {name: value for name, value in credentials.items() if engine.credential_fields[name].source in selected}
        run_options = {source: dict(options) for source, options in source_options.items() if source in selected}
        try:
            run = client.run(
                engine.slug,
                sources=sources,
                max_total_charge_usd=cap,
                delta_mode=delta_mode,
                max_items_per_source=max_items_per_source,
                watchlist_names=watchlist_names,
                source_options=run_options or None,
                credentials=run_credentials or None,
                state_namespace=state_namespace,
                strict_watchlist=True,
                wait=True,
            )
            summary = run.summary()
            if not run.succeeded:
                raise ToolException(
                    f"Run {run.run_id} ended with status {run.status}"
                    + (f": {run.status_message}" if run.status_message else "")
                    + ". Rows it delivered before stopping may have been billed and are in dataset "
                    + f"{run.default_dataset_id}."
                )
            rows: list[dict[str, Any]] = []
            truncated = False
            for row in run.items():
                if len(rows) >= max_rows:
                    truncated = True
                    break
                rows.append(row.model_dump(mode="json"))
        except ToolException:
            raise
        except RunInputError as exc:
            raise ToolException(f"Request refused before any run started; nothing was billed. {exc}") from None
        except RegulatoryEnginesError as exc:
            raise ToolException(f"The run could not be completed. {exc}") from None

        total = summary.get("totalEmitted") if summary else None
        if not truncated:
            note = f"All {len(rows)} delivered row(s) are shown."
        elif isinstance(total, int) and not isinstance(total, bool) and total >= len(rows):
            note = (
                f"TRUNCATED: showing the first {len(rows)} of {total} rows delivered by this run. The other {total - len(rows)} are in dataset "
                f"{run.default_dataset_id} of run {run.run_id}; they were delivered and billed even though they are not shown here."
            )
        else:
            note = (
                f"TRUNCATED: showing the first {len(rows)} rows; more exist in dataset {run.default_dataset_id} of run {run.run_id}. "
                "They were delivered and billed even though they are not shown here."
            )
        payload = {
            "engine": engine.slug,
            "run_id": run.run_id,
            "status": run.status,
            "rows_shown": len(rows),
            "truncated": truncated,
            "note": note,
            "summary": _trim_summary(summary),
            "rows": rows,
        }
        return json.dumps(payload, ensure_ascii=False, default=str)

    return run_engine


def build_tools(
    client: RegulatoryEngines,
    engines: Iterable[str] | None = None,
    *,
    max_total_charge_usd: float | int | Decimal,
    max_rows: int = 50,
    credentials: Mapping[str, Mapping[str, str]] | None = None,
    source_options: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
    state_namespace: str | None = None,
) -> list[StructuredTool]:
    """One ``StructuredTool`` per engine (all three when ``engines`` is None), each with the spending cap baked in.

    ``client`` is a ``RegulatoryEngines`` (it carries the owner and the API client). ``max_total_charge_usd`` is validated exactly like
    ``RegulatoryEngines.run`` does, here, so a bad cap fails at build time. ``credentials`` and ``source_options`` are keyed by engine
    slug and stay inside the application: they are never part of a schema, a description or a result.
    """
    if not isinstance(client, RegulatoryEngines):
        raise TypeError("client must be a RegulatoryEngines instance (it supplies the owner and the API client).")
    cap = validate_max_total_charge_usd(max_total_charge_usd)
    if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= MAX_ROWS_LIMIT:
        raise InvalidOptionError(f"max_rows must be an integer between 1 and {MAX_ROWS_LIMIT}.")
    registry = load_registry()
    slugs = list(registry.engines) if engines is None else list(dict.fromkeys(engines))
    if not slugs:
        raise InvalidOptionError("engines must name at least one engine, or be None for all three.")
    infos = [registry.engine(slug) for slug in slugs]
    all_credentials = credentials or {}
    all_options = source_options or {}
    for mapping_name, mapping in (("credentials", all_credentials), ("source_options", all_options)):
        for slug in mapping:
            if slug not in registry.engines:
                raise InvalidOptionError(f"{mapping_name} names {slug!r}, which is not an engine.")

    tools: list[StructuredTool] = []
    for info in infos:
        engine_credentials = dict(all_credentials.get(info.slug, {}))
        engine_options = {key: dict(value) for key, value in all_options.get(info.slug, {}).items()}
        runnable = _runnable_sources(info, engine_credentials, engine_options)
        if not runnable:
            raise InvalidOptionError(f"No source of {info.slug} can run with the credentials and options given.")
        source_literal = Literal[tuple(source.id for source in info.active_sources)]  # type: ignore[valid-type]
        limits = registry.limits
        item_limit = min(limits.max_items_max, max_rows)
        args_model = create_model(
            "".join(part.title() for part in info.slug.split("-")) + "Args",
            __config__=ConfigDict(extra="forbid"),
            sources=(list[source_literal], Field(min_length=1, description="Source ids to run: " + ", ".join(source.id for source in info.active_sources) + ".")),  # type: ignore[valid-type]
            watchlist_names=(
                list[str] | None,
                Field(default=None, description="Optional keywords to flag in the rows (case-insensitive substrings of names)."),
            ),
            delta_mode=(
                Literal["all", "onlyChanged", "onlyNew"],
                Field(default="onlyChanged", description="onlyChanged (default), onlyNew or all."),
            ),
            max_items_per_source=(
                int,
                Field(default=item_limit, ge=limits.max_items_min, le=item_limit, description=f"Upper bound on records taken from each source (1 to {item_limit}); every delivered row is billed."),
            ),
        )
        unavailable = frozenset(source.id for source in info.active_sources) - frozenset(source.id for source in runnable)
        function = _make_function(client, info, cap, max_rows, item_limit, engine_credentials, engine_options, state_namespace, unavailable)
        tools.append(
            StructuredTool.from_function(
                func=function,
                name=info.slug.replace("-", "_"),
                description=_describe(info, runnable, cap, max_rows),
                args_schema=args_model,
                handle_tool_error=True,
                handle_validation_error=_explain_validation_error,
            )
        )
    return tools
