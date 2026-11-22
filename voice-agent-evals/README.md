# voice-agent-evals

This folder has the evaluation suite for a lead-qualification agent. The agent
talks to inbound leads by voice (LiveKit) or WhatsApp. It asks qualification
questions, books appointments and hands the result to a dispatcher. The suite
contains:

- **13 LLM-as-judge rubrics** (`rubrics/`), each scoring one behaviour from 0.0 to 1.0
- **20 scripted test conversations** (`scenarios/`) across three fictional tenants
- **a runner** (`run_evaluation.py`) that applies the rubrics to a dataset, either
  offline with a deterministic stand-in judge or online as a Langfuse dataset experiment
- **dataset builders** that turn traces or curated voice-test runs into Langfuse datasets
- **a small synthetic dataset** (`fixtures/`) of correct runs and runs with
  deliberate defects, used to check whether each rubric can tell them apart

It comes from my own multi-tenant SaaS project, which never shipped. I translated
and anonymised it for this portfolio (see "What was anonymised or left out").

## The system under test

The rubrics follow the agent's pipeline:

1. **Conversation (Phase 1).** The agent ("Anna") talks to the lead and calls
   tools: `collect_slot` (record an answer), `check_calendar`,
   `book_appointment`, `end_call(final_status)`.
2. **Post-call analysis (Phase 2).** An LLM turns the collected data and the
   transcript into an *IntentJson*: `lead_disposition` (QUALIFIED, PARTIAL,
   NOT_QUALIFIED, CALLBACK_REQUESTED, OPT_OUT, …), `next_intents` (CRM_UPDATE,
   SCHEDULE_CALLBACK, ADD_TO_SUPPRESSION_LIST, …), `extracted_slots` and
   `reasoning`. Per-tenant *gates* drive the disposition: required questions,
   values that disqualify a lead, and how many gates must pass.
3. **Dispatch.** A dispatcher executes the intents, either immediately or
   deferred to a queue.

The three fictional tenants are Example Realty (a real-estate agency looking for
sellers), Example Staffing (a recruiting agency with an employer funnel and an
applicant funnel) and Example Media (an advertising agency).

## Layout

| Path | What it is |
|---|---|
| `rubrics/*.json` | Judge prompts with `{{input}}`, `{{output}}`, `{{ground_truth}}` placeholders |
| `scenarios/<tenant>/*.yaml` | Scripted lead messages plus the expected tool calls, intents and slots |
| `fixtures/offline_dataset.jsonl` | 21 synthetic items: reference, flawed and environment-fault variants |
| `schemas/*.schema.json` | JSON Schemas for rubrics, scenarios and dataset items |
| `run_evaluation.py` | Runner: offline, local dataset with the LLM judge, or Langfuse experiment |
| `create_datasets.py` | Builds Langfuse benchmark datasets from Phase 2 traces |
| `create_cekura_dataset.py` | Uploads curated voice-test conversations as a Langfuse dataset |
| `run_cekura_livekit.py` | Starts Cekura voice-test scenarios against the LiveKit agent and polls results |
| `analyze_langfuse.py` | Prints the timeline of one session from its trace (turns, LLM calls, tool calls, errors) |
| `evalkit/` | Shared code: rubric loading and linting, judges, scenario lint, REST client |
| `tests/` | pytest suite; runs offline with no keys |

## The rubrics

| Rubric file | Score name | What it checks | Fake judge |
|---|---|---|---|
| `slot_quality` | slot_collection_quality | Slots extracted in Phase 2 match the reference | yes |
| `gate_logic` | gate_logic_correctness | Gate rules were applied in the right order to reach the disposition | yes |
| `intent_accuracy` | intent_classification_accuracy | Right next actions; no second booking; suppression on opt-out | yes |
| `conversation_quality` | conversation_quality | Reasoning, GDPR awareness, no hallucinated facts (no reference needed) | no |
| `psychological_profile` | psychological_profile_quality | The generated lead profile is complete, consistent and useful | no |
| `action_execution` | action_execution_correctness | The dispatcher ran the right actions, immediately or deferred | no |
| `tool_usage` | tool_usage_correctness | Tool calls complete, in order, with the right parameters, no extras | yes |
| `slot_completeness` | slot_completeness | Every relevant answer was recorded before a decision was made | yes |
| `refusal_handling` | refusal_handling | After two refusals, offer a callback; never reject a willing lead | yes |
| `appointment_accuracy` | appointment_accuracy | The time the agent confirms is the time that was booked | yes |
| `redundant_questions` | redundant_questions | No re-asking for information the lead already gave | no |
| `agent_behavior` | agent_behavior_quality | Goodbye, no questions stored as answers, how times are offered, transitions | no |
| `date_formatting` | date_formatting | Spoken dates and times are complete and grammatical | no |

The "Fake judge" column shows which rubrics the offline stand-in can score (see below).

Score guide carried over from the original project: 0.90–1.0 production
quality; 0.75–0.89 good with minor issues; 0.50–0.74 needs work; below 0.50
blocking. The runner's default pass threshold is 0.90.

## How to run

Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```bash
cd voice-agent-evals
uv sync                                   # core deps + pytest
uv run pytest                             # offline; no keys, network blocked in tests
uv run python run_evaluation.py --offline # synthetic dataset + deterministic fake judge
uv run python -m evalkit.scenarios        # lint the scenario files
```

Online paths need `uv sync --extra online` and keys in environment variables only:

```bash
# Local dataset, real LLM judge (OPENAI_API_KEY)
uv run python run_evaluation.py --dataset-file fixtures/offline_dataset.jsonl --out results.json

# Langfuse (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST)
uv run python create_datasets.py --traces 50 --min-quality QUALIFIED --dry-run
uv run python run_evaluation.py --dataset benchmark_example_staffing_funnel_a_b2b \
    --task phase2 --system-prompt-file new_prompt.txt --experiment prompt-v2
uv run python create_cekura_dataset.py --items fixtures/offline_dataset.jsonl \
    --kind conversation --dataset-name example-voice-scenarios
uv run python run_evaluation.py --dataset example-voice-scenarios --experiment voice-baseline \
    --rubrics tool_usage refusal_handling appointment_accuracy slot_completeness

# Cekura (CEKURA_API_KEY, CEKURA_AGENT_ID) and trace inspection
uv run python run_cekura_livekit.py --tags opt-out --wait
uv run python analyze_langfuse.py --session-id <session id>
```

`--task replay` (the default) judges the output recorded with each item.
`--task phase2` re-runs the Phase 2 prompt on each item's input, so a new
prompt can be compared with the stored reference. In a Langfuse run, every
rubric is written as a score on the experiment run, plus `avg_<score>` and a
`judge_errors` count at run level.

I have not run the online paths in this folder, so no LLM-judge results are
shown here. The Langfuse wiring is tested with a mocked SDK. I also checked it
once against the real SDK's local `run_experiment`, with tracing off and no
server.

## What the offline run shows

Each fixture item is marked `reference` (correct behaviour), `flawed` (one
planted defect, with `defect_targets` naming the rubrics that should notice it)
or `environment_fault` (the agent behaved correctly but a tool misbehaved). The
runner scores every applicable rubric and then checks the judge itself. Do
correct runs pass? Do flawed runs fail? How wide is the gap between them? This
is the output of `uv run python run_evaluation.py --offline`:

```
judge: fake | items: 21 | pass threshold: 0.90

rubric                 scored  mean  ref min flawed max  margin  verdict
appointment_accuracy        4  0.62     1.00       0.00    1.00  separates
gate_logic                 10  0.87     1.00       0.50    0.50  separates
intent_accuracy            10  0.71     1.00       0.40    0.60  separates
refusal_handling            8  0.88     1.00       0.00    1.00  separates
slot_completeness           9  0.89     1.00       0.00    1.00  separates
slot_quality               10  0.97     1.00       0.67    0.33  separates
tool_usage                  9  0.92     1.00       0.80    0.20  separates

not scored by this judge: action_execution (2 items), agent_behavior (9 items), conversation_quality (10 items), date_formatting (4 items), redundant_questions (6 items)

no dataset items for: psychological_profile

environment-fault items (agent correct, tool misbehaved):
  staffing-voice-booking-tool-moved-slot: appointment_accuracy = 0.50

grader errors: 0 | environment errors: 0
```

What these numbers do and do not mean:

- They come from the **rule-based fake judge** on **21 synthetic items**. They
  show that the pipeline works and that the rubric rules, read literally, can
  separate the planted defects. They say nothing about how an LLM judge
  scores real conversations.
- **`tool_usage` has the narrowest margin (0.20).** Its total is a weighted
  average, so a single critical violation costs at most 20–30 points. Here are
  three examples: booking before checking the calendar, ending a refusal call
  with the wrong status, and checking the calendar after the lead opted out.
  At the runner's 0.90 threshold all three still fail. At the original "good"
  threshold of 0.75 all three pass:

  ```
  $ uv run python run_evaluation.py --offline --pass-threshold 0.75 --rubrics tool_usage gate_logic intent_accuracy slot_quality
  ...
  tool_usage                  9  0.92     1.00       0.80    0.20  misses defects
                          missed defect: staffing-voice-book-before-calendar
                          missed defect: staffing-voice-refusal-rejected
                          missed defect: media-voice-opt-out-keeps-selling
  ```

  `action_execution` avoids this by capping the total at 0.3 when an opt-out
  is violated. `tool_usage` has no such cap. I left the rubric as it was. The
  likely fix is to add hard caps for opt-out and booking-order violations.
- **Agent fault vs environment fault.** `appointment_accuracy` gives 0.0 when
  the agent confirms a time the booking tool did not return (agent error). It
  gives 0.5 when the tool booked a different slot than the one agreed and the
  agent correctly reported it (environment error). The two cases score
  differently, so the 0.5 points at the booking tool rather than the agent.

## Evaluation design choices

- **Every judging attempt gets one status:** `scored`, `skipped` (the fake judge
  does not model that rubric), `grader_error` (bad JSON, missing,
  non-numeric or out-of-range score) or `environment_error` (the API call or
  the task failed). Only `scored` results count towards averages. Recording a
  broken judge reply as 0.0 would make the agent look broken when the grader is
  the problem.
- **Replay never uses the reference as the output.** The replay task reads
  `recorded_output`. An item without one becomes an environment error; the
  runner does not fall back to `expected_output`.
- **The judge never sees reviewer notes.** `create_cekura_dataset.py` moves any
  `note` turns out of the transcript into metadata. A note such as "agent
  should have offered a callback here" would tell the judge the verdict.
- **Placeholders are filled in a single pass,** so a transcript that contains
  the text `{{output}}` cannot pull the output into the wrong slot.
- **References built from traces are marked `unreviewed`.** A trace shows what
  the system did, not what it should have done.
- **Scenarios are checked against the judges' rules.** `evalkit/scenarios.py`
  flags any expectation that a correct agent would fail. Examples: expecting
  BOOK_APPOINTMENT after the agent already booked during the call, an opt-out
  without suppression, or a callback request without SCHEDULE_CALLBACK.

### Fixed while porting

- I ran the scenario consistency check over the original, untranslated scenario
  files (read-only). **14 of 20** had expectations that contradict the rubrics:
  8 booking scenarios expected a second BOOK_APPOINTMENT, 3 opt-out scenarios
  had no ADD_TO_SUPPRESSION_LIST, and 3 callback scenarios had no
  SCHEDULE_CALLBACK or RETRY_CALL. The translated scenarios now list required
  intents in `intents` and banned ones in `forbidden_intents`.
- The original runner's replay task returned the reference as the output. The
  judges therefore compared the reference with itself, and nothing could fail.
  The task output was also passed into the `{{input}}` slot.
- A judge reply that could not be parsed was recorded as 0.0. It is now a
  grader error.
- One rubric had no `score_name`. The runner now lints every rubric on load:
  schema, placeholders used and declared, and a `"score"` field requested.
- The Cekura result printer did not handle runs returned as a dict rather than
  a list, although the poller already did. Both now share one helper.

### Limits of the fake judge

The fake judge models the 7 rubrics whose verdict can be computed from
structured fields. It only notices a question repeated word for word, it only
reads HH:MM times, and it compares slot values as normalised strings, not by
meaning. The other 6 rubrics need judgement (tone, grammar, redundancy,
holistic quality), so the fake judge reports them as not scored rather than
guessing.

## Adversarial runs (Cekura)

I ran prompt-injection and other adversarial conversations against the voice
agent on the Cekura platform. The results will be added here; none are
reported yet. `run_cekura_livekit.py` can start Cekura scenarios like these
and collect their metrics.

## What was anonymised or left out

- Client and product names, the agent persona, people, companies, places and
  phone numbers were replaced with clearly fictional ones. Prompts, scenarios
  and comments were translated into English. The judge criteria, weights and
  the 0.0–1.0 scale are unchanged. The date-formatting rubric's examples were
  adapted to English.
- No credentials, account or agent IDs, original dataset names or deployment
  endpoints are included. All keys come from environment variables.
- Scripts that held embedded data now read local files instead. Nothing here
  comes from real conversations, leads, traces, recordings or evaluation
  reports. The fixtures were written from scratch.
- Left out: the agent itself (prompts, tools, telephony), the CRM and calendar
  integrations, deployment configuration, and test harnesses tied to the
  original infrastructure.
