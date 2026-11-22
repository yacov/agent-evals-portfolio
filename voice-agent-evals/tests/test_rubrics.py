import copy

import pytest

from evalkit.rubrics import PHASE2_RUBRICS, lint_rubric, load_rubric, render_prompt, rubric_keys

EXPECTED_RUBRICS = {
    "action_execution", "agent_behavior", "appointment_accuracy", "conversation_quality",
    "date_formatting", "gate_logic", "intent_accuracy", "psychological_profile",
    "redundant_questions", "refusal_handling", "slot_completeness", "slot_quality", "tool_usage",
}


def test_all_thirteen_rubrics_present():
    assert set(rubric_keys()) == EXPECTED_RUBRICS
    assert set(PHASE2_RUBRICS) <= EXPECTED_RUBRICS


@pytest.mark.parametrize("key", sorted(EXPECTED_RUBRICS))
def test_rubric_is_valid(key):
    assert lint_rubric(load_rubric(key)) == []


@pytest.mark.parametrize("key", sorted(EXPECTED_RUBRICS))
def test_rubric_scale_is_zero_to_one(key):
    assert load_rubric(key)["score_range"] == [0, 1]


def test_score_names_are_unique():
    names = [load_rubric(k)["score_name"] for k in rubric_keys()]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("key", sorted(EXPECTED_RUBRICS))
def test_render_fills_every_placeholder(key):
    prompt = render_prompt(load_rubric(key), input={"a": 1}, output={"b": 2}, ground_truth={"c": 3})
    assert "{{" not in prompt


def test_missing_ground_truth_is_marked_not_available():
    prompt = render_prompt(load_rubric("gate_logic"), input={}, output={})
    assert "(not available)" in prompt


def test_render_does_not_resubstitute_placeholders_inside_data():
    # A transcript that happens to contain "{{output}}" must not pull the output into the input slot.
    prompt = render_prompt(load_rubric("tool_usage"), input={"note": "{{output}}"}, output={"secret": "X"})
    assert prompt.count('"secret": "X"') == 1
    assert '"note": "{{output}}"' in prompt


def test_lint_catches_seeded_defects():
    rubric = load_rubric("gate_logic")

    undeclared = copy.deepcopy(rubric)
    undeclared["variables"] = ["input", "output"]
    assert any("undeclared" in p for p in lint_rubric(undeclared))

    unused = copy.deepcopy(rubric)
    unused["prompt"] = unused["prompt"].replace("{{ground_truth}}", "")
    assert any("never used" in p for p in lint_rubric(unused))

    no_score = copy.deepcopy(rubric)
    no_score["prompt"] = no_score["prompt"].replace('"score"', '"rating"')
    assert any("score" in p for p in lint_rubric(no_score))

    bad_range = copy.deepcopy(rubric)
    bad_range["score_range"] = [0, 10]
    assert any(p.startswith("schema") for p in lint_rubric(bad_range))
