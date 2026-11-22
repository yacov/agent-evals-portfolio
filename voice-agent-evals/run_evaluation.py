"""Run LLM-as-judge rubrics over a dataset and report the scores.

Three ways to run it:

  Offline (no keys, no network): local JSONL + deterministic fake judge
      python run_evaluation.py --offline

  Local dataset, real LLM judge (needs OPENAI_API_KEY)
      python run_evaluation.py --dataset-file fixtures/offline_dataset.jsonl

  Langfuse dataset experiment; scores are written back to Langfuse as an
  experiment run (needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY,
  LANGFUSE_HOST and, for the LLM judge, OPENAI_API_KEY)
      python run_evaluation.py --dataset benchmark_example_staffing_funnel_a_b2b \
          --experiment baseline

Tasks (what produces the output that gets judged):
  replay  use the recorded output stored with each item (default)
  phase2  re-run the Phase 2 analysis prompt on the item input, e.g. to compare
          a new system prompt (--system-prompt-file) against the stored reference

Local items carry a metadata.variant of reference, flawed or environment_fault.
The report then also shows whether each rubric separates correct behaviour from
the planted defects it is supposed to catch.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Any

from evalkit import FIXTURE_DIR
from evalkit.dataset import applicable_rubrics, field, load_jsonl, recorded_output
from evalkit.fake_judge import FakeJudge
from evalkit.judges import (
    ENVIRONMENT_ERROR,
    GRADER_ERROR,
    SCORED,
    SKIPPED,
    Judge,
    JudgeResult,
    OpenAIJudge,
    judge_item,
)
from evalkit.rubrics import lint_rubric, load_rubric, rubric_keys

logger = logging.getLogger("run_evaluation")

DEFAULT_DATASET_FILE = FIXTURE_DIR / "offline_dataset.jsonl"
DEFAULT_PASS_THRESHOLD = 0.9  # "production quality" band of the score guide in the README

Task = Callable[..., Any]


# --------------------------------------------------------------------------- tasks


def replay_task(*, item: Any, **_: Any) -> Any:
    return recorded_output(item)


def make_phase2_task(client: Any, model: str, system_prompt: str | None = None) -> Task:
    """Re-run the post-call analysis (Phase 2) prompt and return its IntentJson."""

    def phase2_task(*, item: Any, **_: Any) -> Any:
        data = field(item, "input") or {}
        user_message = data.get("user_message", "")
        if not isinstance(user_message, str):
            user_message = json.dumps(user_message, ensure_ascii=False)
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt or data.get("system_prompt", "")},
                {"role": "user", "content": user_message},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        return json.loads(response.choices[0].message.content)

    return phase2_task


# --------------------------------------------------------------------------- local runs


@dataclass
class Outcome:
    item_id: str
    rubric: str
    variant: str
    targeted: bool
    result: JudgeResult

    def to_dict(self) -> dict[str, Any]:
        return {"item_id": self.item_id, "rubric": self.rubric, "variant": self.variant,
                "targeted": self.targeted, **self.result.to_dict()}


def evaluate_items(items: Iterable[dict[str, Any]], rubrics: dict[str, dict[str, Any]],
                   judge: Judge, task: Task = replay_task) -> list[Outcome]:
    outcomes: list[Outcome] = []
    for item in items:
        metadata = item.get("metadata") or {}
        keys = applicable_rubrics(metadata, rubrics)
        variant = metadata.get("variant", "reference")
        targets = set(metadata.get("defect_targets") or [])
        try:
            output = task(item=item)
        except Exception as exc:  # no output to judge: an environment problem, not a verdict
            error = JudgeResult(ENVIRONMENT_ERROR, error=f"task failed: {type(exc).__name__}: {exc}")
            outcomes += [Outcome(item["id"], key, variant, key in targets, error) for key in keys]
            continue
        for key in keys:
            result = judge_item(judge, key, rubrics[key], input=item.get("input"), output=output,
                                ground_truth=item.get("expected_output"))
            outcomes.append(Outcome(item["id"], key, variant, key in targets, result))
    return outcomes


def summarize(outcomes: list[Outcome], threshold: float,
              rubric_names: Iterable[str] = ()) -> dict[str, dict[str, Any]]:
    """Per-rubric statistics. Rubrics in ``rubric_names`` with no items are reported too."""
    by_rubric: dict[str, list[Outcome]] = {name: [] for name in rubric_names}
    for outcome in outcomes:
        by_rubric.setdefault(outcome.rubric, []).append(outcome)

    summary: dict[str, dict[str, Any]] = {}
    for key, group in sorted(by_rubric.items()):
        scored = [o for o in group if o.result.status == SCORED]
        reference = [o for o in scored if o.variant == "reference"]
        flawed = [o for o in scored if o.variant == "flawed" and o.targeted]
        env_fault = [o for o in scored if o.variant == "environment_fault" and o.targeted]
        false_alarms = [o.item_id for o in reference if o.result.score < threshold]
        missed = [o.item_id for o in flawed if o.result.score >= threshold]
        ref_min = min((o.result.score for o in reference), default=None)
        flawed_max = max((o.result.score for o in flawed), default=None)

        if not group:
            verdict = "no items"
        elif not scored:
            verdict = "not scored"
        elif not flawed:
            verdict = "no planted defects"
        elif false_alarms and missed:
            verdict = "false alarms + missed defects"
        elif missed:
            verdict = "misses defects"
        elif false_alarms:
            verdict = "false alarms"
        else:
            verdict = "separates"

        summary[key] = {
            "items": len(group),
            "scored": len(scored),
            "mean": round(mean(o.result.score for o in scored), 3) if scored else None,
            "skipped": sum(o.result.status == SKIPPED for o in group),
            "grader_errors": sum(o.result.status == GRADER_ERROR for o in group),
            "environment_errors": sum(o.result.status == ENVIRONMENT_ERROR for o in group),
            "reference_min": ref_min,
            "flawed_max": flawed_max,
            "margin": round(ref_min - flawed_max, 3) if ref_min is not None and flawed_max is not None else None,
            "false_alarms": false_alarms,
            "missed_defects": missed,
            "environment_fault_scores": {o.item_id: o.result.score for o in env_fault},
            "verdict": verdict,
        }
    return summary


def _fmt(value: float | None) -> str:
    return "-" if value is None else f"{value:.2f}"


def format_report(summary: dict[str, dict[str, Any]], *, judge_name: str, n_items: int,
                  threshold: float) -> str:
    lines = [
        f"judge: {judge_name} | items: {n_items} | pass threshold: {threshold:.2f}",
        "",
        f"{'rubric':<22} {'scored':>6} {'mean':>5} {'ref min':>8} {'flawed max':>10} {'margin':>7}  verdict",
    ]
    not_scored, no_items = [], []
    for key, s in summary.items():
        if not s["items"]:
            no_items.append(key)
            continue
        if not s["scored"]:
            not_scored.append(f"{key} ({s['items']} items)")
            continue
        lines.append(
            f"{key:<22} {s['scored']:>6} {_fmt(s['mean']):>5} {_fmt(s['reference_min']):>8} "
            f"{_fmt(s['flawed_max']):>10} {_fmt(s['margin']):>7}  {s['verdict']}"
        )
        for item_id in s["missed_defects"]:
            lines.append(f"{'':<24}missed defect: {item_id}")
        for item_id in s["false_alarms"]:
            lines.append(f"{'':<24}false alarm: {item_id}")
    if not_scored:
        lines += ["", "not scored by this judge: " + ", ".join(not_scored)]
    if no_items:
        lines += ["", "no dataset items for: " + ", ".join(no_items)]
    env = [(key, item_id, score) for key, s in summary.items()
           for item_id, score in s["environment_fault_scores"].items()]
    if env:
        lines += ["", "environment-fault items (agent correct, tool misbehaved):"]
        lines += [f"  {item_id}: {key} = {score:.2f}" for key, item_id, score in env]
    grader = sum(s["grader_errors"] for s in summary.values())
    environment = sum(s["environment_errors"] for s in summary.values())
    lines += ["", f"grader errors: {grader} | environment errors: {environment}"]
    return "\n".join(lines)


# --------------------------------------------------------------------------- Langfuse runs


def make_langfuse_evaluator(key: str, rubric: dict[str, Any], judge: Judge, evaluation_cls: Any,
                            status_counts: dict[str, int]) -> Callable[..., Any]:
    def evaluator(*, input: Any, output: Any, expected_output: Any, metadata: Any = None, **_: Any):
        if key not in applicable_rubrics(metadata, [key]):
            return []
        result = judge_item(judge, key, rubric, input=input, output=output, ground_truth=expected_output)
        status_counts[result.status] += 1
        if result.status != SCORED:
            logger.warning("%s: %s (%s)", key, result.status, result.error)
            return []  # a failed judgement is not a score
        logger.info("  %s: %.2f - %s", key, result.score, result.reasoning[:80])
        return evaluation_cls(name=rubric["score_name"], value=result.score, comment=result.reasoning,
                              metadata=result.details or None)

    evaluator.__name__ = key
    return evaluator


def make_run_aggregator(evaluation_cls: Any, status_counts: dict[str, int]) -> Callable[..., Any]:
    def aggregate(*, item_results: list[Any], **_: Any) -> list[Any]:
        values: dict[str, list[float]] = defaultdict(list)
        for result in item_results:
            for ev in result.evaluations:
                if isinstance(ev.value, (int, float)) and not isinstance(ev.value, bool):
                    values[ev.name].append(float(ev.value))
        evaluations = [
            evaluation_cls(name=f"avg_{name}", value=round(mean(v), 3), comment=f"Average of {len(v)} items")
            for name, v in sorted(values.items())
        ]
        errors = status_counts[GRADER_ERROR] + status_counts[ENVIRONMENT_ERROR]
        evaluations.append(evaluation_cls(name="judge_errors", value=errors,
                                          comment="grader + environment errors (excluded from averages)"))
        return evaluations

    return aggregate


def run_langfuse_experiment(dataset_name: str, experiment: str, rubrics: dict[str, dict[str, Any]],
                            judge: Judge, task: Task, max_concurrency: int = 4) -> Any:
    try:
        from langfuse import Evaluation, get_client
    except ImportError as exc:
        raise SystemExit("langfuse is not installed: uv sync --extra online") from exc

    langfuse = get_client()  # reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST
    dataset = langfuse.get_dataset(dataset_name)
    status_counts: dict[str, int] = defaultdict(int)
    result = dataset.run_experiment(
        name=experiment,
        description=f"LLM-as-judge rubrics: {', '.join(rubrics)} (judge={judge.name})",
        task=task,
        evaluators=[make_langfuse_evaluator(k, r, judge, Evaluation, status_counts) for k, r in rubrics.items()],
        run_evaluators=[make_run_aggregator(Evaluation, status_counts)],
        max_concurrency=max_concurrency,
    )
    try:
        print(result.format())
    except Exception:
        print(f"Experiment '{experiment}' finished; see the Langfuse UI.")
    langfuse.flush()
    return result


# --------------------------------------------------------------------------- CLI


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--offline", action="store_true",
                        help="local JSONL + deterministic fake judge; no keys, no network")
    source.add_argument("--dataset-file", type=Path, help="local JSONL dataset (judged by the LLM judge)")
    source.add_argument("--dataset", help="Langfuse dataset name")
    parser.add_argument("--experiment", default="eval-run", help="Langfuse experiment name")
    parser.add_argument("--rubrics", nargs="*", help="rubric keys to run (default: all in rubrics/)")
    parser.add_argument("--judge", choices=["fake", "openai"], help="default: fake offline, openai otherwise")
    parser.add_argument("--judge-model", help="override the model named in each rubric")
    parser.add_argument("--task", choices=["replay", "phase2"], default="replay")
    parser.add_argument("--task-model", default="gpt-4.1-mini", help="model for --task phase2")
    parser.add_argument("--system-prompt-file", type=Path, help="Phase 2 system prompt to test (--task phase2)")
    parser.add_argument("--pass-threshold", type=float, default=DEFAULT_PASS_THRESHOLD)
    parser.add_argument("--max-concurrency", type=int, default=4, help="Langfuse experiment concurrency")
    parser.add_argument("--out", type=Path, help="write the full local report as JSON")
    parser.add_argument("--show-items", action="store_true", help="print one line per item and rubric")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)

    if not (args.offline or args.dataset_file or args.dataset):
        parser.error("choose one of --offline, --dataset-file or --dataset")
    if args.offline:
        if args.judge == "openai" or args.task != "replay":
            parser.error("--offline uses the fake judge and the replay task only")
        args.judge = "fake"
        args.dataset_file = DEFAULT_DATASET_FILE
    args.judge = args.judge or "openai"
    return args


def load_rubrics(keys: list[str] | None) -> dict[str, dict[str, Any]]:
    rubrics = {}
    for key in keys or rubric_keys():
        rubric = load_rubric(key)
        if problems := lint_rubric(rubric):
            raise SystemExit(f"rubric {key} is invalid: {problems}")
        rubrics[key] = rubric
    return rubrics


def build_task(args: argparse.Namespace) -> Task:
    if args.task == "replay":
        return replay_task
    import os

    import openai  # optional dependency: uv sync --extra online

    system_prompt = args.system_prompt_file.read_text(encoding="utf-8") if args.system_prompt_file else None
    client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return make_phase2_task(client, args.task_model, system_prompt)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
    rubrics = load_rubrics(args.rubrics)
    judge: Judge = FakeJudge() if args.judge == "fake" else OpenAIJudge(model=args.judge_model)
    task = build_task(args)

    if args.dataset:
        run_langfuse_experiment(args.dataset, args.experiment, rubrics, judge, task, args.max_concurrency)
        return 0

    items = load_jsonl(args.dataset_file)
    outcomes = evaluate_items(items, rubrics, judge, task)
    summary = summarize(outcomes, args.pass_threshold, rubric_names=rubrics)
    if args.show_items:
        for o in outcomes:
            print(f"{o.item_id:<45} {o.rubric:<22} {o.variant:<17} {o.result.status:<17} {_fmt(o.result.score)}")
        print()
    print(format_report(summary, judge_name=judge.name, n_items=len(items), threshold=args.pass_threshold))
    if args.out:
        args.out.write_text(json.dumps({
            "judge": judge.name, "pass_threshold": args.pass_threshold, "items": len(items),
            "summary": summary, "outcomes": [o.to_dict() for o in outcomes],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    errors = sum(s["grader_errors"] + s["environment_errors"] for s in summary.values())
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
