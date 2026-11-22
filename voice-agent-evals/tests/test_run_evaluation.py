import copy
import json
import sys
import types
from types import SimpleNamespace

import pytest

import run_evaluation as rev
from evalkit.dataset import item_problems
from evalkit.fake_judge import FakeJudge
from evalkit.judges import ENVIRONMENT_ERROR
from evalkit.rubrics import load_rubric

MODELLED = {"gate_logic", "intent_accuracy", "slot_quality", "tool_usage",
            "appointment_accuracy", "refusal_handling", "slot_completeness"}


def test_fixtures_are_valid_and_synthetic(offline_items):
    assert len(offline_items) >= 20
    assert all(item_problems(item) == [] for item in offline_items)
    variants = {item["metadata"]["variant"] for item in offline_items}
    assert variants == {"reference", "flawed", "environment_fault"}


def test_offline_end_to_end(tmp_path, capsys):
    out = tmp_path / "report.json"
    assert rev.main(["--offline", "--out", str(out)]) == 0

    printed = capsys.readouterr().out
    assert "judge: fake" in printed
    assert "grader errors: 0 | environment errors: 0" in printed

    report = json.loads(out.read_text(encoding="utf-8"))
    summary = report["summary"]
    assert len(summary) == 13
    for key in MODELLED:
        assert summary[key]["verdict"] == "separates", key
        assert summary[key]["false_alarms"] == [] and summary[key]["missed_defects"] == []
    assert summary["psychological_profile"]["verdict"] == "no items"  # reported, not silently dropped
    for key in set(summary) - MODELLED - {"psychological_profile"}:
        assert summary[key]["scored"] == 0 and summary[key]["skipped"] > 0
    assert summary["appointment_accuracy"]["environment_fault_scores"] == {
        "staffing-voice-booking-tool-moved-slot": 0.5}
    assert all(o["status"] in {"scored", "skipped"} for o in report["outcomes"])


def test_offline_run_is_deterministic(tmp_path):
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    rev.main(["--offline", "--out", str(first)])
    rev.main(["--offline", "--out", str(second)])
    assert json.loads(first.read_text()) == json.loads(second.read_text())


def test_looser_threshold_exposes_lenient_tool_usage_weights(offline_items):
    rubrics = {"tool_usage": load_rubric("tool_usage")}
    summary = rev.summarize(rev.evaluate_items(offline_items, rubrics, FakeJudge()), threshold=0.75)
    assert summary["tool_usage"]["verdict"] == "misses defects"
    assert len(summary["tool_usage"]["missed_defects"]) == 3


def test_replay_never_falls_back_to_expected_output(items_by_id):
    item = copy.deepcopy(items_by_id["staffing-small-company-gate-ignored"])
    del item["recorded_output"]
    outcomes = rev.evaluate_items([item], {"gate_logic": load_rubric("gate_logic")}, FakeJudge())
    assert [o.result.status for o in outcomes] == [ENVIRONMENT_ERROR]


def test_rubric_filter_and_applicability(items_by_id):
    item = items_by_id["staffing-voice-refusal-reference"]
    rubrics = {k: load_rubric(k) for k in ("refusal_handling", "gate_logic")}
    outcomes = rev.evaluate_items([item], rubrics, FakeJudge())
    assert [o.rubric for o in outcomes] == ["refusal_handling"]  # gate_logic does not apply to this item


def test_cli_argument_rules():
    with pytest.raises(SystemExit):
        rev.parse_args(["--offline", "--judge", "openai"])
    with pytest.raises(SystemExit):
        rev.parse_args(["--offline", "--task", "phase2"])
    with pytest.raises(SystemExit):
        rev.parse_args([])
    assert rev.parse_args(["--dataset", "x"]).judge == "openai"


def test_phase2_task_calls_model_with_item_prompts(items_by_id):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        message = SimpleNamespace(content='{"lead_disposition": "PARTIAL", "next_intents": []}')
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    item = items_by_id["media-callback-reference"]
    task = rev.make_phase2_task(client, "task-model", system_prompt="NEW PROMPT")
    assert task(item=item)["lead_disposition"] == "PARTIAL"
    assert calls[0]["model"] == "task-model"
    assert calls[0]["messages"][0] == {"role": "system", "content": "NEW PROMPT"}
    assert json.loads(calls[0]["messages"][1]["content"])["tenant"] == "example_media"


# --------------------------------------------------------------------------- Langfuse flow (mocked SDK)


class FakeEvaluation:
    def __init__(self, *, name, value, comment=None, metadata=None, **_):
        self.name, self.value, self.comment, self.metadata = name, value, comment, metadata


class FakeDataset:
    """Mimics DatasetClient.run_experiment: task, then item evaluators, then run evaluators."""

    def __init__(self, items):
        self.items = items
        self.kwargs = None

    def run_experiment(self, *, task, evaluators, run_evaluators, **kwargs):
        self.kwargs = kwargs
        results = []
        for item in self.items:
            output = task(item=item)
            evaluations = []
            for evaluator in evaluators:
                result = evaluator(input=item.input, output=output, expected_output=item.expected_output,
                                   metadata=item.metadata)
                evaluations += result if isinstance(result, list) else [result]
            results.append(SimpleNamespace(item=item, output=output, evaluations=evaluations))
        run_evaluations = [ev for aggregate in run_evaluators for ev in aggregate(item_results=results)]
        return SimpleNamespace(item_results=results, run_evaluations=run_evaluations, format=lambda: "done")


@pytest.fixture
def fake_langfuse(monkeypatch, offline_items):
    items = [
        SimpleNamespace(input=item["input"], expected_output=item["expected_output"],
                        metadata=dict(item["metadata"], recorded_output=item["recorded_output"]))
        for item in offline_items if item["metadata"]["kind"] == "phase2"
    ]
    dataset = FakeDataset(items)
    client = SimpleNamespace(get_dataset=lambda name: dataset, flushed=False)
    client.flush = lambda: setattr(client, "flushed", True)
    module = types.ModuleType("langfuse")
    module.Evaluation = FakeEvaluation
    module.get_client = lambda: client
    monkeypatch.setitem(sys.modules, "langfuse", module)
    return SimpleNamespace(dataset=dataset, client=client)


def test_langfuse_cli_path(fake_langfuse, capsys):
    assert rev.main(["--dataset", "benchmark_example", "--experiment", "baseline", "--judge", "fake",
                     "--rubrics", "gate_logic", "intent_accuracy"]) == 0
    assert fake_langfuse.client.flushed
    assert fake_langfuse.dataset.kwargs["name"] == "baseline"
    assert "done" in capsys.readouterr().out


def test_langfuse_scores_use_score_names(fake_langfuse):
    rubrics = {k: load_rubric(k) for k in ("gate_logic", "slot_quality", "tool_usage")}
    result = rev.run_langfuse_experiment("ds", "exp", rubrics, FakeJudge(), rev.replay_task)
    names = {ev.name for r in result.item_results for ev in r.evaluations}
    # tool_usage does not apply to Phase 2 items, so it produces no score there
    assert names == {"gate_logic_correctness", "slot_collection_quality"}
    run_level = {ev.name: ev.value for ev in result.run_evaluations}
    assert run_level["judge_errors"] == 0
    assert 0.0 <= run_level["avg_gate_logic_correctness"] <= 1.0


def test_langfuse_evaluators_skip_failed_judgements(fake_langfuse):
    class FlakyJudge:
        name = "flaky"

        def complete(self, rubric_key, *args, **kwargs):
            return "not json" if rubric_key == "intent_accuracy" else '{"score": 1, "reasoning": "ok"}'

    rubrics = {k: load_rubric(k) for k in ("gate_logic", "intent_accuracy")}
    result = rev.run_langfuse_experiment("ds", "exp", rubrics, FlakyJudge(), rev.replay_task)
    names = {ev.name for r in result.item_results for ev in r.evaluations}
    assert names == {"gate_logic_correctness"}  # a grader error is not recorded as a 0.0
    run_level = {ev.name: ev.value for ev in result.run_evaluations}
    assert run_level["avg_gate_logic_correctness"] == 1.0
    assert run_level["judge_errors"] == len(result.item_results)
