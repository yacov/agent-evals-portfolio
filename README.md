# agent-evals-portfolio

How I check whether AI agents, and the tests that grade them, actually work.

I'm Iakov Volfkovich: 16+ years of test automation, and since 2024 building production AI agents
with Claude Code and Codex. This repository collects three pieces of that work, taken from my own
projects, translated to English and anonymised. Everything runs offline, without API keys.

| Folder | What it shows | Measured here |
|---|---|---|
| [`planted-bug-harness/`](planted-bug-harness/) | Validating a test suite against deliberately flawed implementations, and checking that it still accepts different correct ones | The project's original suite caught **10 of 21** planted bugs; a behaviour-pinned suite caught **21 of 21**. Both accept **4 of 4** correct variants |
| [`voice-agent-evals/`](voice-agent-evals/) | LLM-as-judge rubrics for a lead-qualification voice agent, a runner for Langfuse dataset experiments, scenario tests, and a check that each rubric separates correct runs from flawed ones | 13 rubrics, 20 scenarios, 141 tests; separates failures caused by the agent, the environment and the grader |
| [`spec-as-code/`](spec-as-code/) | An agent's allowed claims, actions and stages kept in a versioned YAML spec; the prompt is generated from it, and a check fails when the deployed agent drifts | 51 tests; breaking any one check in turn makes the suite fail (12 of 12) |

## How this maps to evaluation work

- **Validate evaluations against reference and flawed implementations:** `planted-bug-harness`
  plants 21 realistic bugs and 4 correct variants and reports, per suite, what is caught and what
  is wrongly rejected. `voice-agent-evals` does the same for rubrics with fixtures marked correct,
  deliberately flawed, or correct-agent-with-broken-tool.
- **Find missing checks, incorrect grades and over-constraining criteria:** the harness shows 11 bugs
  passing a green suite; the rubric check found that one rubric lets planted tool defects through
  at a 0.75 threshold (documented, left as it was); `spec-as-code` tests that reordering or
  reformatting is *not* treated as drift.
- **Attribute failures to the solution, the environment or the grading:** in `voice-agent-evals`, a
  failed judge call or an unparseable judge reply is counted as a grader or environment error, never
  as a score of 0.
- **Write task prompts, automated tests, shell checks and LLM grading prompts:** all three folders.

## Run everything

```bash
# voice-agent-evals (Python 3.12+, uv)
cd voice-agent-evals && uv run pytest -q && uv run python run_evaluation.py --offline

# spec-as-code (Node 20+)
cd spec-as-code && npm ci && npm test && npm run mutants

# planted-bug-harness (Node 22+)
cd planted-bug-harness && npm ci && npm test && npm run plant
```

CI runs the same commands plus a gitleaks secret scan on every push.

## About the sources

All three folders come from my own projects (a multi-tenant lead-qualification SaaS that never
shipped, an agent platform, and a moving-company quoting tool). Names of companies, people, places
and products are fictional. Nothing here comes from real conversations, leads, call traces or
recordings; fixtures and scenarios were written for this repository. Each folder's README lists
what was changed and what was left out.

Prompt-injection and other adversarial runs were done on the Cekura voice-testing platform;
results will be added to `voice-agent-evals`.

MIT licence.
