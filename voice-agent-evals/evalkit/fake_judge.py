"""Deterministic, rule-based stand-in for the LLM judge.

It lets the whole pipeline (prompt rendering, response parsing, aggregation,
reference-vs-flawed comparison) run without API keys, and it doubles as a
cross-check: each rule below is a literal reading of the hard rules and
weights written in the matching rubric. It only models rubrics whose verdict
can be computed from structured fields; the rest need judgement (tone,
grammar, redundancy) and return ``None`` so the runner reports them as
skipped instead of inventing a score.

Known limits (by design, it is a test double):
- refusal_handling only notices a question sentence repeated word for word;
- appointment_accuracy only reads HH:MM times;
- slot_quality compares normalised strings, not meaning.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Callable
from typing import Any

BOOKING_TOOLS = {"check_calendar", "book_appointment"}
TIME_RE = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


# --------------------------------------------------------------------------- helpers


def _norm(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return " ".join(str(value).casefold().split())


def _intent_names(intents: Any) -> list[str]:
    names = []
    for entry in intents or []:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict):
            names.append(entry.get("intent") or entry.get("name") or "")
    return [n for n in names if n]


def _appointment_booked(data: Any) -> bool:
    """Find appointment.booked in the Phase 2 input (top level or inside user_message)."""
    if not isinstance(data, dict):
        return False
    for container in (data, data.get("user_message")):
        if isinstance(container, dict):
            appointment = container.get("appointment")
            if isinstance(appointment, dict) and appointment.get("booked") is True:
                return True
    return False


def _transcript(data: Any) -> list[dict[str, Any]]:
    return list((data or {}).get("transcript") or [])


def _tool_turns(turns: list[dict[str, Any]], name: str) -> list[tuple[int, dict[str, Any]]]:
    return [
        (i, t["tool"])
        for i, t in enumerate(turns)
        if t.get("role") == "tool" and isinstance(t.get("tool"), dict) and t["tool"].get("name") == name
    ]


def _first_time(text: str) -> str | None:
    match = TIME_RE.search(text or "")
    return f"{int(match.group(1)):02d}:{match.group(2)}" if match else None


# --------------------------------------------------------------------------- rules


def gate_logic(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    expected = (ground_truth or {}).get("lead_disposition")
    actual = (output or {}).get("lead_disposition")
    if actual == expected:
        score, why = 1.0, f"Disposition {actual} matches the reference."
    elif actual == "OPT_OUT":
        score, why = 0.0, f"OPT_OUT given but the reference is {expected} (no opt-out signal)."
    elif actual == "QUALIFIED" and expected in {"NOT_QUALIFIED", "OPT_OUT"}:
        score, why = 0.2, f"QUALIFIED although the reference is {expected} (gate violation ignored)."
    elif {actual, expected} <= {"PARTIAL", "NOT_QUALIFIED", "CALLBACK_REQUESTED"}:
        score, why = 0.5, f"{actual} instead of {expected}: adjacent outcome, partly understandable."
    else:
        score, why = 0.3, f"{actual} instead of {expected}."
    return {"score": score, "reasoning": why, "disposition_match": actual == expected}


def intent_accuracy(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    actual = _intent_names((output or {}).get("next_intents"))
    expected = _intent_names((ground_truth or {}).get("next_intents"))
    disposition = (output or {}).get("lead_disposition")
    missing = sorted(set(expected) - set(actual))
    unexpected = sorted(set(actual) - set(expected))
    union = set(actual) | set(expected)
    jaccard = len(set(actual) & set(expected)) / len(union) if union else 1.0

    if "ADD_TO_SUPPRESSION_LIST" in actual and disposition != "OPT_OUT":
        score, why = 0.0, "ADD_TO_SUPPRESSION_LIST without an OPT_OUT disposition."
    elif disposition == "OPT_OUT" and "ADD_TO_SUPPRESSION_LIST" not in actual:
        score, why = 0.1, "OPT_OUT without ADD_TO_SUPPRESSION_LIST."
    elif _appointment_booked(input) and "BOOK_APPOINTMENT" in actual:
        score, why = 0.2, "BOOK_APPOINTMENT although appointment.booked = true (double booking)."
    elif "CLOSE_LEAD" in actual and "BOOK_APPOINTMENT" in actual:
        score, why = 0.2, "Contradictory CLOSE_LEAD + BOOK_APPOINTMENT."
    elif not missing and not unexpected:
        score, why = 1.0, "Intent set matches the reference."
    elif jaccard >= 0.5:
        score, why = 0.7, "Main intents right, minor deviations."
    else:
        score, why = 0.4, "Important intents missing or wrong."
    return {"score": score, "reasoning": why, "missing_intents": missing, "unexpected_intents": unexpected}


def slot_quality(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    expected = (ground_truth or {}).get("extracted_slots") or {}
    actual = (output or {}).get("extracted_slots") or {}
    if not expected:
        score = 1.0 if not actual else 0.5
        return {"score": score, "reasoning": "No slots expected." + ("" if not actual else " Extra slots present.")}
    if not actual:
        return {"score": 0.0, "reasoning": "extracted_slots is empty."}
    wrong = [k for k in expected if k in actual and _norm(actual[k]) != _norm(expected[k])]
    missing = [k for k in expected if k not in actual]
    correct = len(expected) - len(wrong) - len(missing)
    score = round(correct / len(expected), 3)
    why = f"{correct}/{len(expected)} slots correct; wrong={wrong}, missing={missing}."
    return {"score": score, "reasoning": why}


def tool_usage(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    calls = list((output or {}).get("tool_calls") or [])
    names = [c.get("name") for c in calls]
    expected = list((ground_truth or {}).get("expected_tool_calls") or [])
    expected_status = (ground_truth or {}).get("expected_disposition")
    opt_out = expected == ["end_call"]
    issues: list[str] = []

    if opt_out and names == ["end_call"]:
        return {"score": 1.0, "reasoning": "Opt-out: only end_call was called.", "issues": []}

    missing = [t for t in dict.fromkeys(expected) if t not in names]
    completeness = 1.0 if not missing else 0.5 if len(missing) == 1 else 0.0
    if missing:
        issues.append(f"missing tools: {missing}")

    seen = list(dict.fromkeys(n for n in names if n in expected))
    expected_order = [t for t in dict.fromkeys(expected) if t in seen]
    book_before_check = (
        "book_appointment" in names
        and "check_calendar" in names
        and names.index("book_appointment") < names.index("check_calendar")
    )
    end_not_last = "end_call" in names and names[-1] != "end_call"
    if book_before_check or end_not_last:
        order = 0.0
        issues.append("book_appointment before check_calendar" if book_before_check else "end_call is not last")
    else:
        order = 1.0 if seen == expected_order else 0.5

    end_calls = [c for c in calls if c.get("name") == "end_call"]
    if not end_calls:
        parameters = 0.0
        issues.append("no end_call")
    elif expected_status and (end_calls[-1].get("args") or {}).get("final_status") != expected_status:
        parameters = 0.0
        issues.append(f"end_call final_status != {expected_status}")
    else:
        parameters = 1.0

    extra = [n for n in names if n not in expected]
    duplicates = sum(c - 1 for n, c in Counter(names).items() if n != "collect_slot" and c > 1)
    n_extra = len(extra) + duplicates
    if opt_out and any(n in BOOKING_TOOLS for n in names):
        superfluous = 0.0
        issues.append("booking tool called in an opt-out scenario")
    else:
        superfluous = 1.0 if n_extra == 0 else 0.5 if n_extra == 1 else 0.0
        if n_extra:
            issues.append(f"{n_extra} superfluous call(s)")

    score = round(0.30 * completeness + 0.25 * order + 0.25 * parameters + 0.20 * superfluous, 3)
    why = (
        f"completeness={completeness}, order={order}, parameters={parameters}, "
        f"no_superfluous={superfluous}"
    )
    return {"score": score, "reasoning": why, "issues": issues}


def appointment_accuracy(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    turns = _transcript(input)
    bookings = _tool_turns(turns, "book_appointment")
    requested = _first_time(str((ground_truth or {}).get("user_requested_time") or ""))
    if not bookings:
        return {"score": 1.0, "reasoning": "No appointment booked (not applicable).",
                "user_requested_time": requested, "booked_time": None, "confirmed_time": None}
    index, tool = bookings[-1]
    booked = _first_time(str((tool.get("result") or {}).get("booked_time") or ""))
    confirmation = next(
        (t.get("content", "") for t in turns[index + 1:] if t.get("role") == "assistant"), ""
    )
    confirmed = _first_time(confirmation)
    if confirmed is None:
        score, why = 0.5, "The agent did not state a time after booking."
    elif confirmed != booked:
        score, why = 0.0, f"Agent confirmed {confirmed} but the booking tool returned {booked}."
    elif requested and requested != booked:
        score, why = 0.5, f"Confirmed the booked {booked}, but the user asked for {requested} (booking-system issue)."
    else:
        score, why = 1.0, f"Confirmed time {confirmed} matches the booking."
    return {"score": score, "reasoning": why, "user_requested_time": requested,
            "booked_time": booked, "confirmed_time": confirmed}


def refusal_handling(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    turns = _transcript(input)
    agent_lines = [t.get("content", "") for t in turns if t.get("role") == "assistant"]
    questions = Counter(
        _norm(sentence)
        for line in agent_lines
        for sentence in SENTENCE_SPLIT_RE.split(line)
        if sentence.strip().endswith("?")
    )
    asks = max(questions.values(), default=0)
    end_calls = _tool_turns(turns, "end_call")
    status = (end_calls[-1][1].get("args") or {}).get("final_status") if end_calls else None
    offered_callback = any("callback" in line.casefold() for line in agent_lines)

    if asks <= 1:
        score, reaction, why = 1.0, "not_applicable", "No question was asked repeatedly."
    elif status == "NOT_QUALIFIED":
        score = 0.25 if offered_callback else 0.0
        reaction, why = "rejection", f"Same question asked {asks}x, then the lead was rejected as NOT_QUALIFIED."
    elif status == "PARTIAL" and offered_callback:
        score = 1.0 if asks == 2 else 0.75 if asks == 3 else 0.5
        reaction, why = "callback", f"Same question asked {asks}x, then a callback was offered."
    else:
        score, reaction, why = 0.5, "appropriate", f"Same question asked {asks}x; no clear callback switch."
    return {"score": score, "reasoning": why, "refusal_count": asks if asks > 1 else 0,
            "agent_reaction": reaction}


def slot_completeness(input: Any, output: Any, ground_truth: Any) -> dict[str, Any]:
    data = input or {}
    collected = data.get("slots_collected") or {}
    expected = data.get("slots_expected") or {}
    required = set((ground_truth or {}).get("required_slots") or expected)
    decisive = set((ground_truth or {}).get("decisive_slots") or [])
    missing = [k for k in expected if k not in collected]
    ended = bool(_tool_turns(_transcript(data), "end_call"))
    missing_required = [k for k in missing if k in required]

    if not missing:
        score = 1.0
    elif ended and decisive.intersection(missing):
        score = 0.0
    elif not missing_required:
        score = 0.75
    elif len(missing_required) == 1:
        score = 0.5
    else:
        score = 0.25
    why = "All expected slots recorded." if not missing else f"Not recorded via collect_slot: {missing}."
    return {"score": score, "reasoning": why, "missing_slots": missing,
            "collected_count": len(collected), "expected_count": len(expected)}


RULES: dict[str, Callable[[Any, Any, Any], dict[str, Any]]] = {
    "gate_logic": gate_logic,
    "intent_accuracy": intent_accuracy,
    "slot_quality": slot_quality,
    "tool_usage": tool_usage,
    "appointment_accuracy": appointment_accuracy,
    "refusal_handling": refusal_handling,
    "slot_completeness": slot_completeness,
}


class FakeJudge:
    """Judge with the same interface as the LLM judge; returns raw JSON text."""

    name = "fake"

    def complete(self, rubric_key: str, rubric: dict[str, Any], prompt: str, *,
                 input: Any, output: Any, ground_truth: Any) -> str | None:
        rule = RULES.get(rubric_key)
        if rule is None:
            return None
        return json.dumps(rule(input, output, ground_truth), ensure_ascii=False)
