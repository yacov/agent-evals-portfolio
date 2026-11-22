from types import SimpleNamespace

import pytest

from evalkit.fake_judge import FakeJudge
from evalkit.judges import (
    ENVIRONMENT_ERROR,
    GRADER_ERROR,
    SCORED,
    SKIPPED,
    OpenAIJudge,
    judge_item,
    parse_judge_response,
)
from evalkit.rubrics import load_rubric


@pytest.mark.parametrize("text,score", [
    ('{"score": 0.8, "reasoning": "ok", "disposition_match": true}', 0.8),
    ('```json\n{"score": 1, "reasoning": "fenced"}\n```', 1.0),
    ('{"score": 0}', 0.0),
])
def test_parse_valid_responses(text, score):
    result = parse_judge_response(text)
    assert result.status == SCORED
    assert result.score == score


def test_parse_keeps_extra_fields_as_details():
    result = parse_judge_response('{"score": 0.5, "reasoning": "r", "missing_intents": ["CLOSE_LEAD"]}')
    assert result.details == {"missing_intents": ["CLOSE_LEAD"]}
    assert result.reasoning == "r"


@pytest.mark.parametrize("text", [
    "not json at all",
    '{"reasoning": "no score"}',
    '{"score": "high"}',
    '{"score": true}',
    '{"score": 1.4}',
    '{"score": -0.1}',
    "[0.5]",
])
def test_unusable_judge_output_is_a_grader_error_not_a_zero(text):
    result = parse_judge_response(text)
    assert result.status == GRADER_ERROR
    assert result.score is None


class RaisingJudge:
    name = "raising"

    def complete(self, *args, **kwargs):
        raise TimeoutError("judge API timed out")


class GarbageJudge:
    name = "garbage"

    def complete(self, *args, **kwargs):
        return "I think this is a 7/10"


def test_judge_item_statuses():
    rubric = load_rubric("gate_logic")
    data = {"input": {}, "output": {"lead_disposition": "PARTIAL"},
            "ground_truth": {"lead_disposition": "PARTIAL"}}
    assert judge_item(FakeJudge(), "gate_logic", rubric, **data).status == SCORED
    assert judge_item(FakeJudge(), "date_formatting", load_rubric("date_formatting"), **data).status == SKIPPED
    assert judge_item(RaisingJudge(), "gate_logic", rubric, **data).status == ENVIRONMENT_ERROR
    assert judge_item(GarbageJudge(), "gate_logic", rubric, **data).status == GRADER_ERROR


class FakeCompletions:
    def __init__(self, content):
        self.content = content
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = SimpleNamespace(content=self.content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def test_openai_judge_sends_rendered_prompt_in_json_mode():
    completions = FakeCompletions('{"score": 0.9, "reasoning": "fine"}')
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    rubric = load_rubric("intent_accuracy")
    result = judge_item(OpenAIJudge(client), "intent_accuracy", rubric,
                        input={"x": 1}, output={"next_intents": []}, ground_truth={"next_intents": []})
    assert result.status == SCORED and result.score == 0.9
    call = completions.calls[0]
    assert call["model"] == rubric["model"]
    assert call["response_format"] == {"type": "json_object"}
    assert "{{" not in call["messages"][0]["content"]


def test_openai_judge_model_override():
    completions = FakeCompletions('{"score": 1}')
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    judge_item(OpenAIJudge(client, model="judge-model-x"), "gate_logic", load_rubric("gate_logic"),
               input={}, output={}, ground_truth={})
    assert completions.calls[0]["model"] == "judge-model-x"


def test_openai_judge_requires_a_key():
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        OpenAIJudge()
