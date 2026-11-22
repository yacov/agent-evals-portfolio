"""Run Cekura voice-test scenarios against the LiveKit agent and poll for results.

Uses Cekura's LiveKit v2 endpoint, which creates the LiveKit rooms with the
right metadata, issues access tokens, dispatches Cekura's simulated caller
into the room, and cleans up afterwards.

Usage:
    python run_cekura_livekit.py --list --agent <agent id>
    python run_cekura_livekit.py --scenarios 101 102 --project <project id> --wait
    python run_cekura_livekit.py --tags qualified opt-out --agent <agent id> --wait
    python run_cekura_livekit.py --scenarios 101 --frequency 3   # repeat to measure flakiness

Environment:
    CEKURA_API_KEY      API key (required)
    CEKURA_AGENT_ID     default for --agent
    CEKURA_PROJECT_ID   default for --project
    CEKURA_BASE_URL     override the API base URL
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

BASE_URL = os.environ.get("CEKURA_BASE_URL", "https://api.cekura.ai/test_framework")
LIVEKIT_V2_PATH = "/v1/scenarios-external/run_scenarios_livekit_v2/"
SCENARIOS_PATH = "/v1/scenarios/"
RESULTS_PATH = "/v1/results/"
TERMINAL = {"completed", "failed", "error"}


def http_json(method: str, path: str, *, params: dict[str, Any] | None = None,
              body: dict[str, Any] | None = None) -> Any:
    api_key = os.environ.get("CEKURA_API_KEY")
    if not api_key:
        raise SystemExit("CEKURA_API_KEY is not set")
    url = f"{BASE_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"X-CEKURA-API-KEY": api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def list_scenarios(agent_id: int, tags: list[str] | None = None) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"agent": agent_id, "page_size": 100}
    if tags:
        params["tags"] = ",".join(tags)
    data = http_json("GET", SCENARIOS_PATH, params=params)
    return data.get("results", data) if isinstance(data, dict) else data


def run_scenarios(scenario_ids: list[int], frequency: int = 1, project_id: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"scenarios": [{"scenario": sid} for sid in scenario_ids], "frequency": frequency}
    if project_id is not None:
        payload["project"] = project_id
    return http_json("POST", LIVEKIT_V2_PATH, body=payload)


def runs_of(result: dict[str, Any]) -> list[dict[str, Any]]:
    """The batch's runs; the API returns them as a list or as a dict keyed by id."""
    runs = result.get("runs") or []
    runs = runs.values() if isinstance(runs, dict) else runs
    return [r for r in runs if isinstance(r, dict)]


def poll_results(batch_id: int, *, poll_interval: float = 15, timeout: float = 600,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    start = clock()
    result: dict[str, Any] = {}
    while clock() - start < timeout:
        result = http_json("GET", f"{RESULTS_PATH}{batch_id}/")
        runs = runs_of(result)
        done = sum(r.get("status") in TERMINAL for r in runs)
        status = result.get("status", "unknown")
        print(f"  [{int(clock() - start)}s] batch {batch_id}: {status} - {done}/{len(runs)} runs done")
        if status in TERMINAL or (runs and done == len(runs)):
            return result
        sleep(poll_interval)
    print(f"  timeout after {timeout}s; batch {batch_id} still {result.get('status', 'unknown')}")
    return result


def format_results(result: dict[str, Any]) -> str:
    labels = {"completed": "OK", "failed": "FAIL", "error": "ERR", "running": "..."}
    lines = [f"BATCH {result.get('id')} - {str(result.get('status', 'unknown')).upper()}"]
    for run in runs_of(result):
        lines.append(f"  [{labels.get(run.get('status', ''), '?')}] {run.get('scenario_name', 'scenario')} "
                     f"(run {run.get('id')}, {run.get('status')})")
        if run.get("duration"):
            lines.append(f"      duration: {run['duration']}s")
        for metric in run.get("metrics") or run.get("metric_results") or []:
            name = metric.get("metric_name", metric.get("name", "unknown"))
            lines.append(f"      {name}: {metric.get('score', metric.get('value', 'n/a'))}")
    return "\n".join(lines)


def _env_int(name: str) -> int | None:
    value = os.environ.get(name)
    return int(value) if value else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenarios", nargs="+", type=int, help="scenario ids to run")
    parser.add_argument("--tags", nargs="+", help="run (or list) scenarios with these tags")
    parser.add_argument("--agent", type=int, default=_env_int("CEKURA_AGENT_ID"))
    parser.add_argument("--project", type=int, default=_env_int("CEKURA_PROJECT_ID"))
    parser.add_argument("--frequency", type=int, default=1, help="times to run each scenario")
    parser.add_argument("--wait", action="store_true", help="poll until the batch finishes")
    parser.add_argument("--poll-interval", type=float, default=15)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--list", action="store_true", help="list scenarios instead of running")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    args = parser.parse_args(argv)

    if (args.list or (args.tags and not args.scenarios)) and args.agent is None:
        parser.error("--agent (or CEKURA_AGENT_ID) is required to list scenarios")

    if args.list:
        scenarios = list_scenarios(args.agent, args.tags)
        if args.json:
            print(json.dumps(scenarios, indent=2))
        else:
            for s in scenarios:
                print(f"  {s['id']:>6}  {s.get('name', 'unnamed'):<50}  {', '.join(s.get('tags') or [])}")
        return 0

    if not args.scenarios:
        if not args.tags:
            parser.error("provide --scenarios or --tags (or --list)")
        args.scenarios = [s["id"] for s in list_scenarios(args.agent, args.tags)]
        if not args.scenarios:
            print("No scenarios match those tags.")
            return 1

    batch = run_scenarios(args.scenarios, args.frequency, args.project)
    print(f"batch {batch.get('id')}: {batch.get('status')} ({len(args.scenarios)} scenarios x {args.frequency})")
    if not args.wait:
        if args.json:
            print(json.dumps(batch, indent=2))
        return 0
    if not batch.get("id"):
        print("No batch id returned.")
        return 1
    result = poll_results(batch["id"], poll_interval=args.poll_interval, timeout=args.timeout)
    print(json.dumps(result, indent=2) if args.json else format_results(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
