"""The fake judge must implement the rubric rules it claims to model."""

import copy

from evalkit import fake_judge as fj


def test_intent_accuracy_hard_rules(items_by_id):
    ref = items_by_id["realty-qualified-booked-reference"]
    assert fj.intent_accuracy(ref["input"], ref["recorded_output"], ref["expected_output"])["score"] == 1.0

    double = items_by_id["realty-qualified-booked-double-booking"]
    result = fj.intent_accuracy(double["input"], double["recorded_output"], double["expected_output"])
    assert result["score"] == 0.2
    assert result["unexpected_intents"] == ["BOOK_APPOINTMENT"]

    no_suppression = items_by_id["media-opt-out-no-suppression"]
    result = fj.intent_accuracy(no_suppression["input"], no_suppression["recorded_output"],
                                no_suppression["expected_output"])
    assert result["score"] == 0.1


def test_suppression_without_opt_out_is_zero():
    output = {"lead_disposition": "QUALIFIED", "next_intents": ["ADD_TO_SUPPRESSION_LIST"]}
    assert fj.intent_accuracy({}, output, {"next_intents": []})["score"] == 0.0


def test_gate_logic_bands():
    def score(actual, expected):
        return fj.gate_logic({}, {"lead_disposition": actual}, {"lead_disposition": expected})["score"]

    assert score("QUALIFIED", "QUALIFIED") == 1.0
    assert score("OPT_OUT", "PARTIAL") == 0.0
    assert score("QUALIFIED", "NOT_QUALIFIED") == 0.2
    assert score("PARTIAL", "NOT_QUALIFIED") == 0.5


def test_slot_quality_is_case_insensitive_but_catches_changed_values(items_by_id):
    ref = items_by_id["staffing-applicant-reference"]
    assert fj.slot_quality(ref["input"], ref["recorded_output"], ref["expected_output"])["score"] == 1.0
    bad = items_by_id["staffing-applicant-hallucinated-slot"]
    assert fj.slot_quality(bad["input"], bad["recorded_output"], bad["expected_output"])["score"] < 0.7


def test_tool_usage_weights_and_opt_out_short_circuit(items_by_id):
    ok = items_by_id["media-voice-opt-out-reference"]
    assert fj.tool_usage(ok["input"], ok["recorded_output"], ok["expected_output"])["score"] == 1.0

    selling = items_by_id["media-voice-opt-out-keeps-selling"]
    result = fj.tool_usage(selling["input"], selling["recorded_output"], selling["expected_output"])
    assert result["score"] == 0.8  # 0.30 + 0.25 + 0.25 + 0.20 * 0: no hard cap in the rubric
    assert any("opt-out" in issue for issue in result["issues"])

    early = items_by_id["staffing-voice-book-before-calendar"]
    result = fj.tool_usage(early["input"], early["recorded_output"], early["expected_output"])
    assert result["score"] == 0.75
    assert "book_appointment before check_calendar" in result["issues"]


def test_appointment_accuracy_separates_agent_from_environment(items_by_id):
    def score(item_id):
        item = items_by_id[item_id]
        return fj.appointment_accuracy(item["input"], None, item["expected_output"])

    assert score("staffing-voice-booking-reference")["score"] == 1.0
    agent_error = score("staffing-voice-booking-wrong-confirmation")
    assert agent_error["score"] == 0.0
    assert (agent_error["booked_time"], agent_error["confirmed_time"]) == ("11:00", "09:30")
    assert score("staffing-voice-booking-tool-moved-slot")["score"] == 0.5


def test_refusal_handling(items_by_id):
    ok = items_by_id["staffing-voice-refusal-reference"]
    result = fj.refusal_handling(ok["input"], None, ok["expected_output"])
    assert (result["score"], result["agent_reaction"], result["refusal_count"]) == (1.0, "callback", 2)

    bad = items_by_id["staffing-voice-refusal-rejected"]
    result = fj.refusal_handling(bad["input"], None, bad["expected_output"])
    assert (result["score"], result["agent_reaction"], result["refusal_count"]) == (0.0, "rejection", 3)

    no_refusal = items_by_id["staffing-voice-booking-reference"]
    assert fj.refusal_handling(no_refusal["input"], None, {})["agent_reaction"] == "not_applicable"


def test_slot_completeness_decisive_slot(items_by_id):
    bad = items_by_id["staffing-voice-disqualified-unrecorded-size"]
    result = fj.slot_completeness(bad["input"], None, bad["expected_output"])
    assert result["score"] == 0.0
    assert result["missing_slots"] == ["company_size"]

    recorded = copy.deepcopy(bad)
    recorded["input"]["slots_collected"]["company_size"] = "3"
    assert fj.slot_completeness(recorded["input"], None, recorded["expected_output"])["score"] == 1.0


def test_unmodelled_rubric_returns_none():
    assert fj.FakeJudge().complete("date_formatting", {}, "", input={}, output={}, ground_truth={}) is None
