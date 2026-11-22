"""Upload curated voice-test conversations (e.g. from Cekura runs) as a Langfuse dataset.

Input is a local JSONL file in the format of fixtures/offline_dataset.jsonl:
one item per line with ``input`` (scenario, transcript with tool turns,
slots_collected, slots_expected), ``expected_output`` (expected disposition,
tool calls and behaviour), ``recorded_output`` and ``metadata``.

Two rules keep the uploaded items fair to the judge:

1. Reviewer annotations never go into what the judge sees. Any transcript turn
   with role "note" is moved to metadata.reviewer_notes. A note such as
   "agent should have offered a callback here" inside the transcript tells the
   judge the verdict before it grades.
2. The recorded output goes into metadata.recorded_output (read by the replay
   task), never into expectedOutput.

Usage:
    python create_cekura_dataset.py --items fixtures/offline_dataset.jsonl \\
        --kind conversation --dataset-name example-voice-scenarios --dry-run
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import sys
from pathlib import Path
from typing import Any

from evalkit.dataset import item_problems, load_jsonl
from evalkit.langfuse_rest import LangfuseRestClient

logger = logging.getLogger("create_cekura_dataset")


def strip_reviewer_notes(item: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with 'note' turns moved from the transcript to metadata."""
    item = copy.deepcopy(item)
    transcript = (item.get("input") or {}).get("transcript")
    if not transcript:
        return item
    notes = [t.get("content", "") for t in transcript if t.get("role") == "note"]
    if notes:
        item["input"]["transcript"] = [t for t in transcript if t.get("role") != "note"]
        metadata = item.setdefault("metadata", {})
        metadata["reviewer_notes"] = list(metadata.get("reviewer_notes") or []) + notes
    return item


def to_langfuse_item(item: dict[str, Any], source: str) -> dict[str, Any]:
    item = strip_reviewer_notes(item)
    metadata = dict(item.get("metadata") or {})
    metadata.update({"item_id": item["id"], "source": source, "recorded_output": item.get("recorded_output")})
    return {"input": item["input"], "expectedOutput": item["expected_output"], "metadata": metadata}


def load_items(path: Path, kind: str | None) -> list[dict[str, Any]]:
    items = load_jsonl(path)
    problems = {it.get("id", f"line {i}"): p for i, it in enumerate(items, 1) if (p := item_problems(it))}
    if problems:
        raise SystemExit(f"invalid items in {path}: {json.dumps(problems, indent=2)}")
    return [it for it in items if kind is None or it["metadata"]["kind"] == kind]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--items", type=Path, required=True, help="JSONL file with curated items")
    parser.add_argument("--dataset-name", default="voice-scenarios")
    parser.add_argument("--kind", choices=["phase2", "conversation", "dispatcher"], help="only items of this kind")
    parser.add_argument("--source", default="cekura", help="value for metadata.source")
    parser.add_argument("--dry-run", action="store_true", help="validate and print, upload nothing")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, client: LangfuseRestClient | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    items = [to_langfuse_item(it, args.source) for it in load_items(args.items, args.kind)]
    logger.info("%d items for dataset '%s'", len(items), args.dataset_name)
    if args.dry_run:
        for item in items:
            meta = item["metadata"]
            logger.info("  %s (%s, %s)", meta["item_id"], meta["variant"], meta["kind"])
        return 0

    client = client or LangfuseRestClient.from_env()
    client.create_dataset(args.dataset_name, f"Curated voice-test conversations (source: {args.source}).",
                          metadata={"source": args.source})
    for item in items:
        client.create_dataset_item(args.dataset_name, input=item["input"],
                                   expected_output=item["expectedOutput"], metadata=item["metadata"])
        logger.info("  added %s", item["metadata"]["item_id"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
