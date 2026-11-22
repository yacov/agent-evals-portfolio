# spec-as-code

An AI agent's allowed claims, actions, stages and rules live in a versioned YAML spec. The
system prompt is **generated** from that spec and never edited by hand. A check **fails** when
the deployed agent drifts from the spec.

The idea behind it, in one sentence: any prompt sentence that is not attached to a type, a
relation and a rule is a sentence the agent improvises around, and improvisation is how
invented claims reach customers.

Everything here is fictional: "Nova", an intake assistant for "Example Home Services", which
books home-repair visits.

## Why this matters for agent evaluation

- **You can only evaluate the agent you can name.** Prompts get edited in a hosting platform's
  UI, pasted truncated, or given an extra tool by someone in a hurry. An evaluation run against
  the reviewed prompt then grades an agent that is not the one in production. The drift check
  ties the evaluated artefact to the deployed one.
- **Limits must be machine-checkable, not prose.** Every forbidden action carries the exact guard
  sentence that must appear in the prompt. Every approved claim must cite evidence. Every banned
  claim must carry detectors, because a ban with no detector checks nothing.
- **The check is itself an evaluation, so it is evaluated too.** It is run against a correct
  deployment, against deliberately drifted deployments (does it catch each one, with the right
  message, and raise nothing unrelated?), against equivalent deployments (does it stay quiet about
  changes that are not drift?), and against deliberately broken copies of itself (can the tests
  fail at all?).

## Files

| Path | What it is |
|---|---|
| `spec/assistant.yaml` | The spec: types, relations, trades, stages, actions (tools), forbidden actions with guard sentences, claims (approved with evidence, banned with detectors), policies, rules (WHEN / MAY / USING / MUST NOT / IF UNKNOWN), embedded tests |
| `compile.mjs` | Spec to system prompt. Pure and deterministic. Never emits `why` rationale, evidence, deployment ids or tests |
| `generated/assistant.prompt.txt` | The compiled prompt (103 lines, 5,972 characters). A test fails if it is edited by hand |
| `check-drift.mjs` | Compares the spec with a deployed-agent description and exits 1 listing every drift |
| `lib/validate.mjs` | Spec validation: structure, reference integrity, self-consistency, leak scan, coverage warnings |
| `fixtures/` | Offline stand-ins for the hosting platform's API response: one in sync, eight drifted, two equivalent. `make-fixtures.mjs` builds them from the spec |
| `test/` | `node:test` suites (51 tests) |
| `scripts/mutants.mjs` | Seeded mutation run: breaks one check at a time and confirms a test fails |

## How to run

Requires Node.js 20 or newer. Everything runs offline.

```bash
npm install
npm test                 # node --test: 51 tests
npm run check            # the in-sync fixture: CLEAN, exit 0
npm run check:all        # every fixture; exit 1 because the drift fixtures drift
node check-drift.mjs fixtures/drift.tool-schema.json
npm run compile          # regenerate generated/assistant.prompt.txt
npm run fixtures         # regenerate fixtures after changing the spec
npm run mutants          # seeded mutation run (12 full test runs, under a minute)
```

`check-drift.mjs` exits 0 when clean, 1 on drift, and 2 when it cannot check: an invalid spec,
or a deployment with an empty prompt or no tool list. That last case is refused on purpose: a
prompt that says nothing contains no banned phrase, so a claim scan over it would pass for the
wrong reason.

## What the check catches

Output of `npm run check:all`, one planted drift per fixture:

| Fixture | Planted drift | Findings |
|---|---|---|
| `deployed.in-sync.json` | none | CLEAN |
| `drift.missing-guard.json` | the discount guard line deleted from the prompt | `GUARD_MISSING` offer_discount, `PROMPT_MISMATCH` |
| `drift.unknown-claim.json` | "Most jobs are fixed on the first visit." added to the claims section | `UNKNOWN_CLAIM`, `PROMPT_MISMATCH` |
| `drift.banned-claim.json` | "98% satisfaction rate" slipped into the policies, outside the claims section | `BANNED_CLAIM` claim.invented_statistics, `PROMPT_MISMATCH` |
| `drift.extra-tool.json` | a `send_text_message` tool attached | `TOOL_NOT_ALLOWED` |
| `drift.missing-tool.json` | `request_callback` detached while the prompt still tells the agent to use it | `TOOL_MISSING` |
| `drift.tool-schema.json` | `open_booking_form` gains an optional `phone_number` parameter | `TOOL_SCHEMA` |
| `drift.stage-mismatch.json` | stage `offer_visit` renamed to `quote` on the platform | `STAGE_MISMATCH` |
| `drift.truncated-prompt.json` | the prompt pasted without its last 3 lines | `PROMPT_MISMATCH` ("truncated paste?") |
| `equivalent.reordered.json` | tools, stages and parameters reordered; tool descriptions reworded; extra platform fields | CLEAN |
| `equivalent.reformatted.json` | CRLF line endings, trailing spaces, indentation, doubled spaces, extra blank lines | CLEAN |

The tests assert the **exact** set of finding codes for each fixture, not just that something
fired, and that each message names the thing that drifted.

The tool-schema case is the one worth a second look. The spec's booking tool has no contact
fields: the caller types contact details into the form. An instruction not to collect a phone
number is something an agent can talk its way around; a tool schema with nowhere to put one is
enforcement. Adding a `phone_number` parameter silently reopens that door, and no prompt scan
would notice.

### Layered on purpose

The exact-prompt comparison catches every prompt edit but says little about why it matters. The
guard and claim checks say exactly what broke and keep working if the exact comparison has to be
relaxed. With `--no-exact-prompt`, the missing guard, unknown claim and banned claim are still
caught, and the truncated prompt is **not**: the dropped rule carries no guard and no claim. A test
pins that gap so it stays visible.

## What deliberately does not count as drift

Over-constraining a check makes it useless: a check that is always red is a check nobody reads.

- The order of tools, stages and parameters. They are compared as sets.
- Whitespace in the prompt: line endings, trailing spaces, indentation, runs of spaces, blank
  lines. Hosting platforms rewrite these on save.
- Fields the spec does not own, such as tool descriptions or platform metadata.

And the reverse, also tested: a one-word change inside a sentence is drift, and a renamed tool is
reported as one missing tool plus one unknown tool.

## What spec validation catches

`lib/validate.mjs` runs before every compile and every drift check. It rejects a spec with a
missing section, a rule that uses an action or stage that does not exist, an approved claim with
no evidence, a banned claim with no detectors or an invalid detector regex, a relation to an
undeclared type, an in-scope trade outside the trade list, a test that references a rule or
forbidden action that does not exist, duplicate ids, an id that is both allowed and forbidden, and
a parameter that is both required and optional.

It also compiles the spec and scans the result:

- **Self-contradiction.** If a guard sentence trips the spec's own banned-claim detector (for
  example "Never say we are the cheapest" against a detector for "cheapest"), every drift check
  would be permanently red. This is reported as a spec error, naming the offending line.
- **Leaks.** Deployment ids and `why` rationale must never reach the model.

The suite has 19 malformed-spec tests, one per error above, each asserting the specific message.

Two warnings flag missing checks: a forbidden action that no embedded test exercises, and a tool
that no rule tells the agent when to use. The shipped spec has zero errors and zero warnings.

## Are the tests able to fail?

`npm run mutants` breaks one thing at a time in a temporary copy and runs the suite there:

```
KILLED    guard check disabled                             3 failing test(s)
KILLED    unknown-claim scan disabled                      3 failing test(s)
KILLED    banned-claim scan disabled                       2 failing test(s)
KILLED    stage check disabled                             1 failing test(s)
KILLED    optional parameters ignored                      1 failing test(s)
KILLED    exact prompt check off by default                5 failing test(s)
KILLED    empty deployment accepted                        2 failing test(s)
KILLED    order-sensitive comparison (over-constraining)   2 failing test(s)
KILLED    whitespace not normalised (over-constraining)    2 failing test(s)
KILLED    compiler leaks rationale                         18 failing test(s)
KILLED    validator skips self-contradiction scan          1 failing test(s)
KILLED    validator accepts claims without evidence        1 failing test(s)

12/12 mutants killed
```

Two of the mutants make the checker stricter rather than weaker. They are killed by the
equivalent fixtures, which is the point of having them.

## Known gaps

Stated rather than hidden:

- **Only the exact comparison sees dropped rules and policies.** Guards and claims have dedicated
  checks; rules and policies do not.
- **Embedded tests are validated, not executed.** Their references and coverage are checked
  offline. Running them needs a live model and a transcript judge, which is outside this folder.
- **Detectors match phrasing, not meaning.** A banned claim is caught in the words its detectors
  list. A paraphrase gets through unless the exact-prompt check is on.
- **The deployed read is trusted to be complete.** On some platforms a lower-privilege API read
  silently omits some tools. A checker whose view depends on its credentials will then report
  drift that is not there. The fixture format does not model this.

## What was generalised from the original

This folder is an anonymised, reduced version of work on a production voice agent for a small
business website, running on a hosted agent platform:

- The original spec was about 800 lines covering the same structure: types, relations, site
  actions with their mechanism, forbidden actions, stages, claims (approved, banned, citable
  statistics), policies, compilable rules and a manual test script. The content here is new and
  invented; only the structure was kept.
- The original drift checker read the live agent through the platform's API, read-only, and
  compared tool names, required parameters, stage and scope enums, configuration ids and
  banned-claim patterns, then compared the live prompt with the compiled one. Here the API read is
  an offline JSON fixture, and configuration-id checks were dropped.
- The original compiler started as a set of surgical edits applied to the hand-written deployed
  prompt, each required to match exactly once, with a plan to generate the prompt entirely from
  the spec. This version is the fully generating one.
- Kept from the original: one-way compile direction; default-deny claims; banned claims carry
  detectors and "a ban with no detector checks nothing"; the leak scan for ids and rationale;
  refusing a vacuous deployment read; whitespace normalisation, because the platform's text box
  rewrote whitespace on save; and enforcing limits through tool schemas rather than instructions.
- Added here: required evidence for approved claims, per-forbidden-action guard sentences checked
  by presence, the unknown-claim check, reference-integrity validation with coverage warnings,
  equivalent fixtures for over-constraint, and the mutation run.
