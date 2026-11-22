"""Local JSONL datasets and helpers shared by the local and Langfuse runs."""

from __future__ import annotations

import json
from collections.abc import Iterable
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from evalkit import SCHEMA_DIR
from evalkit.rubrics import PHASE2_RUBRICS


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / "dataset_item.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def item_problems(item: dict[str, Any]) -> list[str]:
    return [f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in _validator().iter_errors(item)]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    items = []
    for line_no, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
    return items


def field(item: Any, name: str) -> Any:
    """Read a field from a plain dict item or a Langfuse DatasetItem."""
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def applicable_rubrics(metadata: dict[str, Any] | None, selected: Iterable[str]) -> list[str]:
    """Rubrics to run on an item: those it declares, else the Phase 2 set."""
    declared = (metadata or {}).get("rubrics") or PHASE2_RUBRICS
    return [key for key in selected if key in declared]


def recorded_output(item: Any) -> Any:
    """The output of the system under test, used by the replay task.

    Local items carry it as ``recorded_output``; Langfuse items carry it in
    ``metadata.recorded_output``. It is deliberately NOT ``expected_output``:
    replaying the reference as the output makes every judge compare the
    reference with itself, so nothing can ever fail.
    """
    value = field(item, "recorded_output")
    if value is None:
        value = (field(item, "metadata") or {}).get("recorded_output")
    if value is None:
        raise ValueError("item has no recorded output; use --task phase2 to produce one")
    return value
