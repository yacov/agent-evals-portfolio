"""Dataset builders, trace analyser and Cekura runner, with all HTTP replaced by fakes."""

import json

import pytest

import analyze_langfuse
import create_cekura_dataset
import create_datasets
import run_cekura_livekit
from evalkit import FIXTURE_DIR
from evalkit.langfuse_rest import LangfuseRestClient

INTENT = {"lead_disposition": "QUALIFIED", "next_intents": ["CRM_UPDATE"], "extracted_slots": {}, "reasoning": "r"}


def generation(name="analyze_call", output=INTENT):
    return {"type": "GENERATION", "name": name, "output": json.dumps(output),
            "input": {"messages": [{"role": "system", "content": "SYS"}, {"role": "user", "content": "USER"}]}}


class FakeLangfuse:
    def __init__(self, traces=None):
        self.traces = traces or {}
        self.datasets, self.items = [], []

    def fetch_traces(self, **kwargs):
        return [{"id": tid, "sessionId": f"session-{tid}", "timestamp": "2026-01-01T10:00:00Z"}
                for tid in self.traces]

    def fetch_trace(self, trace_id):
        return self.traces[trace_id]

    def create_dataset(self, name, description, metadata=None):
        self.datasets.append(name)

    def create_dataset_item(self, dataset_name, **kwargs):
        self.items.append((dataset_name, kwargs))


# --------------------------------------------------------------------------- create_datasets


def test_extract_phase2_prefers_named_generation():
    trace = {"observations": [generation("other", {"x": 1}), generation()]}
    data = create_datasets.extract_phase2_data(trace)
    assert data == {"system_prompt": "SYS", "user_message": "USER", "intent_json": INTENT}


def test_extract_phase2_falls_back_to_trace_output():
    data = create_datasets.extract_phase2_data({"observations": [], "output": INTENT, "input": {"a": 1}})
    assert data["intent_json"] == INTENT and data["system_prompt"] == ""
    assert create_datasets.extract_phase2_data({"observations": [], "output": "plain text"}) is None


def test_trace_metadata_and_dataset_name():
    trace = {"tags": ["phase2", "example_staffing", "funnel:funnel_a_b2b"]}
    meta = create_datasets.get_trace_metadata(trace, known_projects={"example_staffing"})
    assert meta == {"project_key": "example_staffing", "funnel_id": "funnel_a_b2b"}
    assert create_datasets.build_dataset_name("Benchmark", "example_staffing", "funnel a/b") == \
        "benchmark_example_staffing_funnel_a_b"


def test_create_datasets_filters_quality_and_marks_references_unreviewed():
    traces = {
        "t1": {"observations": [generation()], "metadata": {"project_key": "example_realty", "funnel_id": "seller"}},
        "t2": {"observations": [generation(output=dict(INTENT, lead_disposition="OPT_OUT"))],
               "metadata": {"project_key": "example_realty", "funnel_id": "seller"}},
        "t3": {"observations": []},
    }
    client = FakeLangfuse(traces)
    assert create_datasets.main(["--min-quality", "PARTIAL"], client=client) == 0
    assert client.datasets == ["benchmark_example_realty_seller"]
    assert len(client.items) == 1
    _, item = client.items[0]
    assert item["metadata"]["reference_status"] == "unreviewed"
    assert item["source_trace_id"] == "t1"


def test_create_datasets_dry_run_writes_nothing():
    client = FakeLangfuse({"t1": {"observations": [generation()]}})
    assert create_datasets.main(["--dry-run"], client=client) == 0
    assert client.datasets == [] and client.items == []


# --------------------------------------------------------------------------- create_cekura_dataset


def test_reviewer_notes_are_moved_out_of_the_transcript():
    item = {"id": "x", "input": {"transcript": [
        {"role": "user", "content": "hi"},
        {"role": "note", "content": "agent should have offered a callback"},
        {"role": "assistant", "content": "hello"},
    ]}, "expected_output": {}, "recorded_output": {}, "metadata": {}}
    cleaned = create_cekura_dataset.strip_reviewer_notes(item)
    assert [t["role"] for t in cleaned["input"]["transcript"]] == ["user", "assistant"]
    assert cleaned["metadata"]["reviewer_notes"] == ["agent should have offered a callback"]
    assert len(item["input"]["transcript"]) == 3  # original untouched


def test_cekura_upload_keeps_recorded_output_out_of_expected(tmp_path):
    client = FakeLangfuse()
    args = ["--items", str(FIXTURE_DIR / "offline_dataset.jsonl"), "--kind", "conversation",
            "--dataset-name", "example-voice-scenarios"]
    assert create_cekura_dataset.main(args, client=client) == 0
    assert client.datasets == ["example-voice-scenarios"]
    assert len(client.items) == 9
    for _, item in client.items:
        assert "recorded_output" in item["metadata"]
        assert "tool_calls" not in item["expected_output"]
        assert all(t["role"] != "note" for t in item["input"]["transcript"])


def test_cekura_dry_run_needs_no_credentials():
    args = ["--items", str(FIXTURE_DIR / "offline_dataset.jsonl"), "--dry-run"]
    assert create_cekura_dataset.main(args) == 0


def test_rest_client_requires_env_credentials():
    with pytest.raises(RuntimeError, match="LANGFUSE_PUBLIC_KEY"):
        LangfuseRestClient.from_env()


# --------------------------------------------------------------------------- analyze_langfuse

OBSERVATIONS = [
    {"name": "user_speaking", "startTime": "2026-01-01T10:00:01"},
    {"name": "llm_request", "startTime": "2026-01-01T10:00:02", "model": "m", "calculatedTotalCost": 0.001,
     "output": "Hello"},
    {"name": "function_tool", "startTime": "2026-01-01T10:00:03", "output": "recorded",
     "metadata": {"attributes": {"lk.function_tool.name": "collect_slot",
                                 "lk.function_tool.arguments": '{"name": "industry"}'}}},
    {"name": "function_tool", "startTime": "2026-01-01T10:00:04", "output": "timeout",
     "metadata": {"attributes": {"lk.function_tool.name": "check_calendar", "lk.function_tool.is_error": "true"}}},
    {"name": "drain_agent_activity", "startTime": "2026-01-01T10:00:05"},
    {"name": "tts_request", "startTime": "2026-01-01T10:00:02"},
]


def test_timeline_and_summary():
    timeline = "\n".join(analyze_langfuse.format_timeline(OBSERVATIONS))
    assert "TOOL collect_slot" in timeline and "ERROR" in timeline and "DRAIN" in timeline
    summary = analyze_langfuse.summarize(OBSERVATIONS)
    assert summary["llm_calls"] == 1 and summary["tool_errors"] == 1 and summary["tts_requests"] == 1
    assert summary["session_drained"] and not summary["on_exit_ran"]


def test_analyze_main_with_fake_client(capsys):
    client = FakeLangfuse({"t1": {"id": "t1", "latency": 12.0, "observations": OBSERVATIONS}})
    assert analyze_langfuse.main(["--session-id", "session-t1"], client=client) == 0
    assert "tool_calls: 2" in capsys.readouterr().out


# --------------------------------------------------------------------------- run_cekura_livekit


def test_run_scenarios_payload(monkeypatch):
    sent = {}

    def fake_http(method, path, *, params=None, body=None):
        sent.update(method=method, path=path, body=body)
        return {"id": 7, "status": "pending"}

    monkeypatch.setattr(run_cekura_livekit, "http_json", fake_http)
    assert run_cekura_livekit.run_scenarios([1, 2], frequency=3, project_id=9)["id"] == 7
    assert sent["method"] == "POST" and sent["path"].endswith("run_scenarios_livekit_v2/")
    assert sent["body"] == {"scenarios": [{"scenario": 1}, {"scenario": 2}], "frequency": 3, "project": 9}


def test_poll_until_all_runs_finish(monkeypatch):
    responses = iter([
        {"status": "running", "runs": {"1": {"id": 1, "status": "running"}}},
        {"status": "running", "runs": {"1": {"id": 1, "status": "completed", "scenario_name": "s",
                                             "metrics": [{"name": "m", "score": 1}]}}},
    ])
    monkeypatch.setattr(run_cekura_livekit, "http_json", lambda *a, **k: next(responses))
    ticks = iter(range(100))
    result = run_cekura_livekit.poll_results(7, sleep=lambda s: None, clock=lambda: next(ticks))
    assert run_cekura_livekit.runs_of(result)[0]["status"] == "completed"
    assert "[OK] s" in run_cekura_livekit.format_results(result)


def test_cekura_list_requires_agent_id():
    with pytest.raises(SystemExit):
        run_cekura_livekit.main(["--list"])


def test_cekura_requires_api_key():
    with pytest.raises(SystemExit, match="CEKURA_API_KEY"):
        run_cekura_livekit.http_json("GET", "/v1/scenarios/")
