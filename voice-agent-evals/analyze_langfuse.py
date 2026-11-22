"""Print the timeline of one voice-agent session from its Langfuse trace.

Shows LLM calls (model, cost, output head), tool calls (name, arguments,
result, error flag), turn boundaries and session shutdown, then a summary.
Useful for deciding whether a failed test is the agent's fault (wrong tool,
wrong arguments), the environment's (tool error, session never drained) or
the grader's (the trace shows the behaviour the judge said was missing).

Usage:
    LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_HOST=... \\
    python analyze_langfuse.py --session-id <room or session id>
    python analyze_langfuse.py --trace-id <trace id>
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from evalkit.langfuse_rest import LangfuseRestClient

TIMELINE_EVENTS = {
    "agent_turn", "user_turn", "user_speaking", "agent_speaking",
    "function_tool", "llm_request", "drain_agent_activity", "on_exit",
}


def _attributes(observation: dict[str, Any]) -> dict[str, Any]:
    metadata = observation.get("metadata") or {}
    return metadata.get("attributes", {}) if isinstance(metadata, dict) else {}


def format_timeline(observations: list[dict[str, Any]]) -> list[str]:
    lines = []
    for obs in sorted(observations, key=lambda o: o.get("startTime") or ""):
        name = obs.get("name", "")
        if name not in TIMELINE_EVENTS:
            continue
        ts = (obs.get("startTime") or "")[:19]
        attrs = _attributes(obs)
        if name == "llm_request":
            cost = obs.get("calculatedTotalCost") or 0
            lines.append(f"[{ts}] LLM ({obs.get('model', '?')}, ${cost:.5f})")
            if obs.get("output"):
                lines.append(f"    output: {str(obs['output'])[:300]}")
        elif name == "function_tool":
            lines.append(f"[{ts}] TOOL {attrs.get('lk.function_tool.name', '?')}")
            lines.append(f"    args:   {attrs.get('lk.function_tool.arguments', '')}")
            lines.append(f"    result: {str(obs.get('output') or '')[:200]}")
            if str(attrs.get("lk.function_tool.is_error", "false")).lower() == "true":
                lines.append("    ERROR")
        elif name == "drain_agent_activity":
            lines.append(f"[{ts}] === DRAIN (session ending) ===")
        elif name == "on_exit":
            lines.append(f"[{ts}] === ON_EXIT (cleanup) ===")
        else:
            lines.append(f"[{ts}] {name.upper().replace('_', ' ')}")
    return lines


def summarize(observations: list[dict[str, Any]]) -> dict[str, Any]:
    def named(n: str) -> list[dict[str, Any]]:
        return [o for o in observations if o.get("name") == n]

    tools = named("function_tool")
    return {
        "llm_calls": len(named("llm_request")),
        "tool_calls": [
            f"{_attributes(t).get('lk.function_tool.name', '?')}({_attributes(t).get('lk.function_tool.arguments', '')})"
            for t in sorted(tools, key=lambda o: o.get("startTime") or "")
        ],
        "tool_errors": sum(str(_attributes(t).get("lk.function_tool.is_error", "")).lower() == "true" for t in tools),
        "tts_requests": len(named("tts_request")),
        "stt_requests": len(named("stt_request")),
        "total_cost": round(sum(o.get("calculatedTotalCost") or 0 for o in observations), 6),
        "session_drained": bool(named("drain_agent_activity")),
        "on_exit_ran": bool(named("on_exit")),
    }


def load_trace(client: LangfuseRestClient, *, session_id: str | None, trace_id: str | None) -> dict[str, Any] | None:
    if not trace_id:
        traces = client.fetch_traces(session_id=session_id, limit=1)
        if not traces:
            return None
        trace_id = traces[0]["id"]
    return client.fetch_trace(trace_id)


def main(argv: list[str] | None = None, client: LangfuseRestClient | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--session-id")
    target.add_argument("--trace-id")
    args = parser.parse_args(argv)

    client = client or LangfuseRestClient.from_env()
    trace = load_trace(client, session_id=args.session_id, trace_id=args.trace_id)
    if trace is None:
        print("No trace found.")
        return 1
    observations = trace.get("observations") or []
    print(f"trace {trace.get('id')} | latency {trace.get('latency') or 0:.1f}s | "
          f"{len(observations)} observations")
    print("\n" + "=" * 80 + "\nTIMELINE\n" + "=" * 80)
    print("\n".join(format_timeline(observations)))
    print("\n" + "=" * 80 + "\nSUMMARY\n" + "=" * 80)
    for key, value in summarize(observations).items():
        if isinstance(value, list):
            print(f"  {key}: {len(value)}")
            for entry in value:
                print(f"    - {entry}")
        else:
            print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
