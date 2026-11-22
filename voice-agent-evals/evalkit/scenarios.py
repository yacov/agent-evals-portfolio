"""Load scripted test conversations and check them against the rubric rules.

The schema check catches malformed files. The consistency check catches a
quieter problem: a scenario whose expected outcome contradicts a rule that a
judge enforces (for example, expecting BOOK_APPOINTMENT after the agent has
already booked during the call). Such a scenario makes a correct agent fail.

Run as a script to lint the scenarios/ folder:  python -m evalkit.scenarios
"""

from __future__ import annotations

import json
import sys
from functools import cache
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

from evalkit import SCENARIO_DIR, SCHEMA_DIR

OUTBOUND_INTENTS = {"SEND_WA_QUALIFIED", "NOTIFY_AGENT_TELEGRAM", "BOOK_APPOINTMENT"}


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / "scenario.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def load_scenarios(root: Path = SCENARIO_DIR) -> list[tuple[Path, dict[str, Any]]]:
    return [
        (path, yaml.safe_load(path.read_text(encoding="utf-8")))
        for path in sorted(root.glob("*/*.yaml"))
    ]


def schema_problems(scenario: dict[str, Any]) -> list[str]:
    return [f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in _validator().iter_errors(scenario)]


def consistency_problems(scenario: dict[str, Any]) -> list[str]:
    """Contradictions between a scenario's expectations and the judges' rules."""
    expected = scenario.get("expected") or {}
    tools = list(expected.get("tool_calls") or [])
    intents = set(expected.get("intents") or [])
    forbidden = set(expected.get("forbidden_intents") or [])
    disposition = expected.get("disposition")
    problems = []

    if overlap := intents & forbidden:
        problems.append(f"intents both expected and forbidden: {sorted(overlap)}")
    if tools and tools[-1] != "end_call":
        problems.append("end_call must be the last tool call")
    if "book_appointment" in tools:
        if "BOOK_APPOINTMENT" in intents:
            problems.append("agent books during the call, so BOOK_APPOINTMENT would double-book")
        if "BOOK_APPOINTMENT" not in forbidden:
            problems.append("booked during the call: BOOK_APPOINTMENT should be forbidden")
        if "check_calendar" not in tools or tools.index("check_calendar") > tools.index("book_appointment"):
            problems.append("book_appointment must follow check_calendar")
    if expected.get("opt_out"):
        if tools != ["end_call"]:
            problems.append("opt-out: only end_call is allowed")
        if expected.get("slots"):
            problems.append("opt-out: no slots should be collected")
        if "ADD_TO_SUPPRESSION_LIST" not in intents:
            problems.append("opt-out: ADD_TO_SUPPRESSION_LIST is required")
        if OUTBOUND_INTENTS - forbidden:
            problems.append(f"opt-out: outbound intents must be forbidden: {sorted(OUTBOUND_INTENTS - forbidden)}")
    elif "ADD_TO_SUPPRESSION_LIST" in intents:
        problems.append("ADD_TO_SUPPRESSION_LIST without opt-out")
    if disposition == "PARTIAL":
        if {"check_calendar", "book_appointment"} & set(tools):
            problems.append("PARTIAL: no calendar or booking tools expected")
        if "BOOK_APPOINTMENT" in intents:
            problems.append("PARTIAL: BOOK_APPOINTMENT not allowed")
        if not {"SCHEDULE_CALLBACK", "RETRY_CALL"} & intents:
            problems.append("PARTIAL: SCHEDULE_CALLBACK or RETRY_CALL expected")
    if disposition == "QUALIFIED" and "book_appointment" not in tools and "BOOK_APPOINTMENT" not in intents:
        problems.append("QUALIFIED without any booking path")
    return problems


def lint(root: Path = SCENARIO_DIR) -> dict[str, list[str]]:
    report: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for path, scenario in load_scenarios(root):
        name = f"{path.parent.name}/{path.name}"
        problems = schema_problems(scenario) + consistency_problems(scenario)
        if scenario.get("tenant") != path.parent.name:
            problems.append(f"tenant '{scenario.get('tenant')}' does not match folder '{path.parent.name}'")
        if f"{scenario.get('id')}.yaml" != path.name:
            problems.append("id does not match file name")
        key = (path.parent.name, scenario.get("id"))
        if key in seen:
            problems.append("duplicate id within tenant")
        seen.add(key)
        report[name] = problems
    return report


def main() -> int:
    report = lint()
    bad = {name: problems for name, problems in report.items() if problems}
    for name, problems in bad.items():
        for problem in problems:
            print(f"{name}: {problem}")
    print(f"{len(report)} scenarios, {len(bad)} with problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
