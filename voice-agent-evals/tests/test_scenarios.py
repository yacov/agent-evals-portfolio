import copy
from collections import defaultdict

import pytest

from evalkit.scenarios import consistency_problems, lint, load_scenarios, schema_problems

SCENARIOS = load_scenarios()
TENANTS = {"example_realty", "example_staffing", "example_media"}


def test_twenty_scenarios_across_three_tenants():
    assert len(SCENARIOS) == 20
    assert {s["tenant"] for _, s in SCENARIOS} == TENANTS


@pytest.mark.parametrize("path,scenario", SCENARIOS, ids=[f"{p.parent.name}/{p.stem}" for p, _ in SCENARIOS])
def test_scenario_matches_schema(path, scenario):
    assert schema_problems(scenario) == []


@pytest.mark.parametrize("path,scenario", SCENARIOS, ids=[f"{p.parent.name}/{p.stem}" for p, _ in SCENARIOS])
def test_scenario_does_not_contradict_rubric_rules(path, scenario):
    assert consistency_problems(scenario) == []


def test_lint_report_is_clean():
    assert {name: p for name, p in lint().items() if p} == {}


def test_each_tenant_covers_the_core_outcomes():
    coverage = defaultdict(set)
    for _, s in SCENARIOS:
        expected = s["expected"]
        tags = coverage[s["tenant"]]
        tags.add("opt_out" if expected.get("opt_out") else expected["disposition"])
        if (s.get("form_answers") or {}).get("channel_choice") == "continue_whatsapp":
            tags.add("whatsapp")
    for tenant in TENANTS:
        assert {"QUALIFIED", "NOT_QUALIFIED", "PARTIAL", "opt_out", "whatsapp"} <= coverage[tenant], tenant


def _scenario(scenario_id):
    return copy.deepcopy(next(s for _, s in SCENARIOS if s["id"] == scenario_id and s["tenant"] == "example_staffing"))


def test_consistency_check_catches_double_booking_expectation():
    s = _scenario("qualified-b2b-happy-path")
    s["expected"]["intents"].append("BOOK_APPOINTMENT")
    s["expected"]["forbidden_intents"].remove("BOOK_APPOINTMENT")
    problems = consistency_problems(s)
    assert any("double-book" in p for p in problems)


def test_consistency_check_catches_opt_out_without_suppression():
    s = _scenario("opt-out")
    s["expected"]["intents"] = ["CRM_UPDATE"]
    assert any("ADD_TO_SUPPRESSION_LIST is required" in p for p in consistency_problems(s))


def test_consistency_check_catches_partial_without_callback():
    s = _scenario("partial-callback")
    s["expected"]["intents"] = ["CRM_UPDATE"]
    assert any("SCHEDULE_CALLBACK" in p for p in consistency_problems(s))


def test_schema_rejects_non_fictional_phone_numbers():
    s = _scenario("opt-out")
    s["lead"]["phone"] = "+15551234567"
    assert schema_problems(s)
