"""Load, lint and render the LLM-as-judge rubrics in rubrics/*.json.

A rubric is addressed by its file stem (e.g. ``gate_logic``); its ``score_name``
(e.g. ``gate_logic_correctness``) is the name the score is recorded under.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from evalkit import RUBRIC_DIR, SCHEMA_DIR

PLACEHOLDER_RE = re.compile(r"\{\{(\w+)\}\}")
NOT_AVAILABLE = "(not available)"

# Rubrics that score the Phase 2 analysis (IntentJson). Used for dataset items
# that do not declare which rubrics apply to them.
PHASE2_RUBRICS = ("slot_quality", "gate_logic", "intent_accuracy", "conversation_quality")


@cache
def _schema_validator() -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / "rubric.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def rubric_keys(rubric_dir: Path = RUBRIC_DIR) -> list[str]:
    return sorted(p.stem for p in rubric_dir.glob("*.json"))


def load_rubric(key: str, rubric_dir: Path = RUBRIC_DIR) -> dict[str, Any]:
    path = rubric_dir / f"{key}.json"
    if not path.exists():
        raise FileNotFoundError(f"Rubric not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def lint_rubric(rubric: dict[str, Any]) -> list[str]:
    """Return a list of problems (empty if the rubric is valid).

    Beyond the JSON schema this checks the things that silently break a judge:
    a placeholder in the prompt that is never filled, a declared variable that
    the prompt never uses, and a prompt that does not ask for a "score" field.
    """
    problems = [
        f"schema: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}"
        for e in _schema_validator().iter_errors(rubric)
    ]
    prompt = rubric.get("prompt", "")
    used = set(PLACEHOLDER_RE.findall(prompt))
    declared = set(rubric.get("variables", []))
    if undeclared := used - declared:
        problems.append(f"prompt uses undeclared placeholders: {sorted(undeclared)}")
    if unused := declared - used:
        problems.append(f"declared variables never used in prompt: {sorted(unused)}")
    if '"score"' not in prompt:
        problems.append('prompt does not ask for a JSON "score" field')
    if rubric.get("name") != rubric.get("score_name"):
        problems.append("name and score_name differ")
    return problems


def _as_text(value: Any) -> str:
    if value is None:
        return NOT_AVAILABLE
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def render_prompt(
    rubric: dict[str, Any],
    *,
    input: Any = None,
    output: Any = None,
    ground_truth: Any = None,
) -> str:
    """Fill the {{input}}/{{output}}/{{ground_truth}} placeholders."""
    values = {"input": input, "output": output, "ground_truth": ground_truth}
    return PLACEHOLDER_RE.sub(lambda m: _as_text(values.get(m.group(1))), rubric["prompt"])
