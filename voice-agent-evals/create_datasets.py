"""Build Langfuse benchmark datasets from Phase 2 (post-call analysis) traces.

Fetches recent traces tagged ``phase2``, keeps those whose disposition meets a
minimum quality, groups them by tenant and funnel, and creates datasets named
``{prefix}_{project_key}_{funnel_id}`` (e.g. ``benchmark_example_staffing_funnel_a_b2b``).

Each item stores
  input:            {"system_prompt": ..., "user_message": ...}  (the Phase 2 LLM call)
  expected_output:  the IntentJson the traced system produced
  metadata:         tenant, funnel, disposition, reference_status = "unreviewed"

The stored IntentJson is only a *candidate* reference: it is what the system
did, not necessarily what it should have done. Review it before treating it as
ground truth. These datasets are meant for ``run_evaluation.py --task phase2``,
which re-runs the analysis with a new prompt and judges it against the
reference; replaying the stored output against itself would always pass.

Usage:
    LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_HOST=... \\
    python create_datasets.py --traces 50 --dataset-prefix benchmark --min-quality QUALIFIED --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from typing import Any

from evalkit.langfuse_rest import LangfuseRestClient

logger = logging.getLogger("create_datasets")

# Dispositions ordered by how much signal they carry for a benchmark.
QUALITY_RANK: dict[str, int] = {
    "QUALIFIED": 3,
    "PARTIAL": 2,
    "NOT_QUALIFIED": 1,
    "HANDOFF_REQUESTED": 1,
    "CALLBACK_REQUESTED": 0,
    "UNREACHABLE": -1,
    "OPT_OUT": -2,
    "DO_NOT_CONTACT": -2,
}
PHASE2_GENERATION_NAMES = ("analyze_call", "phase2_analysis", "intent_analysis")


# --------------------------------------------------------------------------- extraction


def _parse_intent_json(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, dict) and "lead_disposition" in raw:
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict) and "lead_disposition" in parsed:
            return parsed
    return None


def _messages(raw_input: Any) -> list[dict[str, Any]]:
    if isinstance(raw_input, dict):
        return list(raw_input.get("messages") or [])
    if isinstance(raw_input, list):
        return raw_input
    return []


def _parse_generation(observation: dict[str, Any]) -> dict[str, Any] | None:
    intent_json = _parse_intent_json(observation.get("output"))
    if intent_json is None:
        return None
    system_prompt = user_message = ""
    for message in _messages(observation.get("input")):
        content = message.get("content", "")
        content = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        if message.get("role") == "system":
            system_prompt = content
        elif message.get("role") == "user":
            user_message = content
    return {"system_prompt": system_prompt, "user_message": user_message, "intent_json": intent_json}


def extract_phase2_data(trace: dict[str, Any]) -> dict[str, Any] | None:
    """Find the Phase 2 LLM call in a trace.

    Order: a GENERATION with a known Phase 2 name, then any GENERATION whose
    output contains lead_disposition, then the trace-level output.
    """
    generations = [o for o in trace.get("observations") or [] if o.get("type") == "GENERATION"]
    named = [o for o in generations if (o.get("name") or "").lower() in PHASE2_GENERATION_NAMES]
    candidates = named or [o for o in generations if _parse_intent_json(o.get("output")) is not None]
    for observation in candidates:
        parsed = _parse_generation(observation)
        if parsed is not None:
            return parsed

    intent_json = _parse_intent_json(trace.get("output"))
    if intent_json is None:
        return None
    raw_input = trace.get("input", {})
    return {
        "system_prompt": "",  # not recoverable from trace-level data
        "user_message": raw_input if isinstance(raw_input, str) else json.dumps(raw_input, ensure_ascii=False),
        "intent_json": intent_json,
    }


def get_trace_metadata(trace: dict[str, Any], known_projects: set[str] | None = None) -> dict[str, str]:
    """Project key and funnel id from metadata, attributes, userId or tags."""
    metadata = trace.get("metadata") or {}
    attributes = metadata.get("attributes", {}) if isinstance(metadata, dict) else {}
    project_key = (metadata.get("project_key") or attributes.get("project_key")
                   or attributes.get("lk.project_key") or trace.get("userId") or "")
    funnel_id = (metadata.get("funnelId") or metadata.get("funnel_id") or metadata.get("funnel")
                 or attributes.get("funnel_id") or attributes.get("funnel") or "")
    for tag in trace.get("tags") or []:
        if not isinstance(tag, str):
            continue
        if tag.startswith("project:") and not project_key:
            project_key = tag.split(":", 1)[1].strip()
        elif tag.startswith("funnel:") and not funnel_id:
            funnel_id = tag.split(":", 1)[1].strip()
        elif known_projects and tag in known_projects and not project_key:
            project_key = tag
    return {"project_key": project_key or "unknown", "funnel_id": funnel_id or "unknown"}


def build_dataset_name(prefix: str, project_key: str, funnel_id: str) -> str:
    def clean(value: str) -> str:
        return value.lower().replace(" ", "_").replace("/", "_")

    return f"{clean(prefix)}_{clean(project_key)}_{clean(funnel_id)}"


# --------------------------------------------------------------------------- pipeline


def collect_items(client: LangfuseRestClient, *, traces_limit: int, dataset_prefix: str, min_quality: str,
                  known_projects: set[str] | None = None) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    min_rank = QUALITY_RANK[min_quality.upper()]
    traces = client.fetch_traces(tags=["phase2"], limit=traces_limit)
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    stats = {"fetched": len(traces), "added": 0, "no_phase2_data": 0, "low_quality": 0}

    for summary in traces:
        trace_id = summary.get("id", "")
        try:
            trace = client.fetch_trace(trace_id)
        except Exception as exc:
            logger.warning("skipping trace %s: %s", trace_id, exc)
            stats["no_phase2_data"] += 1
            continue
        phase2 = extract_phase2_data(trace)
        if phase2 is None:
            stats["no_phase2_data"] += 1
            continue
        disposition = str(phase2["intent_json"].get("lead_disposition", ""))
        if QUALITY_RANK.get(disposition.upper(), -99) < min_rank:
            stats["low_quality"] += 1
            continue
        meta = get_trace_metadata(trace, known_projects)
        name = build_dataset_name(dataset_prefix, meta["project_key"], meta["funnel_id"])
        groups[name].append({
            "trace_id": trace_id,
            "input": {"system_prompt": phase2["system_prompt"], "user_message": phase2["user_message"]},
            "expected_output": phase2["intent_json"],
            "metadata": {
                "project_key": meta["project_key"],
                "funnel_id": meta["funnel_id"],
                "disposition": disposition,
                "session_id": summary.get("sessionId") or trace_id,
                "timestamp": (summary.get("timestamp") or "")[:19],
                "reference_status": "unreviewed",
            },
        })
        stats["added"] += 1
    return groups, stats


def write_datasets(client: LangfuseRestClient, groups: dict[str, list[dict[str, Any]]], min_quality: str) -> int:
    errors = 0
    for name, items in sorted(groups.items()):
        first = items[0]["metadata"]
        description = (f"Benchmark for project={first['project_key']} funnel={first['funnel_id']}, "
                       f"built from traces tagged 'phase2' (min quality {min_quality}). "
                       "References are unreviewed until checked.")
        client.create_dataset(name, description)
        for item in items:
            try:
                client.create_dataset_item(name, input=item["input"], expected_output=item["expected_output"],
                                           metadata=item["metadata"], source_trace_id=item["trace_id"])
            except Exception as exc:
                logger.error("failed to add %s to %s: %s", item["trace_id"], name, exc)
                errors += 1
    return errors


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--traces", type=int, default=30, help="number of recent traces to fetch")
    parser.add_argument("--dataset-prefix", default="benchmark")
    parser.add_argument("--min-quality", default="QUALIFIED", choices=list(QUALITY_RANK))
    parser.add_argument("--project-tag", action="append", default=[],
                        help="a plain trace tag that is a project key (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="fetch and group, write nothing")
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, client: LangfuseRestClient | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
    client = client or LangfuseRestClient.from_env()
    groups, stats = collect_items(client, traces_limit=args.traces, dataset_prefix=args.dataset_prefix,
                                  min_quality=args.min_quality, known_projects=set(args.project_tag))
    logger.info("traces fetched: %(fetched)d | items: %(added)d | no phase2 data: %(no_phase2_data)d | "
                "below min quality: %(low_quality)d", stats)
    for name, items in sorted(groups.items()):
        logger.info("  %s: %d items", name, len(items))
    if args.dry_run or not groups:
        logger.info("nothing written (%s)", "dry run" if args.dry_run else "no items")
        return 0
    return 1 if write_datasets(client, groups, args.min_quality) else 0


if __name__ == "__main__":
    sys.exit(main())
