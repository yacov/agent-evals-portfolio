"""Run one rubric against one item and classify what came back.

Every judging attempt ends in exactly one status:

- ``scored``            the judge returned a usable score in [0, 1]
- ``skipped``           this judge does not model the rubric (fake judge only)
- ``grader_error``      the judge answered, but not with a usable score
                        (bad JSON, missing/non-numeric/out-of-range score)
- ``environment_error`` the call itself failed (network, auth, quota, timeout)

Only ``scored`` results enter averages. Turning a judge failure into a 0.0
would make a broken grader look like a broken agent.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

from evalkit.rubrics import render_prompt

SCORED, SKIPPED, GRADER_ERROR, ENVIRONMENT_ERROR = "scored", "skipped", "grader_error", "environment_error"


@dataclass
class JudgeResult:
    status: str
    score: float | None = None
    reasoning: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Judge(Protocol):
    name: str

    def complete(self, rubric_key: str, rubric: dict[str, Any], prompt: str, *,
                 input: Any, output: Any, ground_truth: Any) -> str | None: ...


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def parse_judge_response(text: str) -> JudgeResult:
    try:
        data = json.loads(_strip_code_fence(text))
    except (json.JSONDecodeError, TypeError) as exc:
        return JudgeResult(GRADER_ERROR, error=f"unparseable judge output: {exc}; head={str(text)[:120]!r}")
    if not isinstance(data, dict) or "score" not in data:
        return JudgeResult(GRADER_ERROR, error="judge output has no 'score' field")
    score = data.pop("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return JudgeResult(GRADER_ERROR, error=f"non-numeric score: {score!r}")
    if not 0.0 <= float(score) <= 1.0:
        return JudgeResult(GRADER_ERROR, error=f"score out of range [0, 1]: {score}")
    reasoning = str(data.pop("reasoning", ""))
    return JudgeResult(SCORED, score=float(score), reasoning=reasoning, details=data)


def judge_item(judge: Judge, rubric_key: str, rubric: dict[str, Any], *,
               input: Any, output: Any, ground_truth: Any) -> JudgeResult:
    prompt = render_prompt(rubric, input=input, output=output, ground_truth=ground_truth)
    try:
        raw = judge.complete(rubric_key, rubric, prompt, input=input, output=output, ground_truth=ground_truth)
    except Exception as exc:  # the judge call failed; that is not a verdict on the agent
        return JudgeResult(ENVIRONMENT_ERROR, error=f"{type(exc).__name__}: {exc}")
    if raw is None:
        return JudgeResult(SKIPPED, error=f"rubric '{rubric_key}' is not modelled by the {judge.name} judge")
    return parse_judge_response(raw)


class OpenAIJudge:
    """LLM judge via the OpenAI Chat Completions API (JSON mode).

    The judge model should be at least as capable as the model under test; the
    rubric files default to gpt-4.1. ``model`` overrides the rubric's model.
    """

    name = "openai"

    def __init__(self, client: Any = None, *, model: str | None = None,
                 max_completion_tokens: int = 500, temperature: float = 0.1) -> None:
        if client is None:
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise RuntimeError("OPENAI_API_KEY is not set (use --offline for the fake judge)")
            import openai  # optional dependency: uv sync --extra online

            client = openai.OpenAI(api_key=api_key)
        self.client = client
        self.model = model
        self.max_completion_tokens = max_completion_tokens
        self.temperature = temperature

    def complete(self, rubric_key: str, rubric: dict[str, Any], prompt: str, **_: Any) -> str | None:
        response = self.client.chat.completions.create(
            model=self.model or rubric.get("model", "gpt-4.1"),
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_completion_tokens=self.max_completion_tokens,
            temperature=self.temperature,
        )
        return response.choices[0].message.content
