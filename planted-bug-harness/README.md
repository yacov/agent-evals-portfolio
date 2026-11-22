# Planted-bug harness

Does a test suite actually check anything? This folder answers that by measurement, not by
coverage numbers. It plants realistic bugs in a small pricing engine, one at a time, and records
which test suite notices. It also plants different-but-correct implementations, to see whether a
suite rejects solutions it should accept.

The code under test is the quote engine of a moving-company quoting tool: inventory volume, crew
and truck choice, hours, travel, stairs and carry distance, heavy items, a pensioner discount, VAT
and the Swedish RUT tax deduction with its cap.

## Result (measured, `npm run plant`)

Two suites test the same `src/quote.ts`:

- **Naive suite** (`tests/naive.test.ts`, 17 tests): a realistic first-pass suite. Tests 1-14 are
  the source project's own pricing tests, ported scenario by scenario with the same inputs and
  expected numbers. One expected value changed: the packing case now expects a deduction of 1 927
  instead of 1 927.5, because this version rounds the deduction down. The source's two
  translation tests were dropped along with the translation layer. Tests 15-17 add one quick
  case for each feature this version added. It is what a developer or coding agent typically
  writes in the same pass as the code: happy paths that assert today's outputs.
- **Behaviour suite** (`tests/behaviour.test.ts`, 60 tests): pins the required behaviour in
  [SPEC.md](SPEC.md), rule by rule, through the public `quote()` function only. It covers
  boundaries, rounding, caps, zero, negative and invalid inputs, and combinations.

Both suites pass on the unmodified code. This is the exact output of the last run (Node 26, Windows):

```
Patches: 25/25 applied (each search text found exactly once, file changed).
Baseline (no patch): naive suite 17/17 tests pass.
Baseline (no patch): behaviour suite 60/60 tests pass.
```

| ID | Planted bug (must fail) | Naive suite | Behaviour suite |
|---|---|---|---|
| M01 | A volume exactly equal to a truck capacity is sent to the next, bigger crew (<= became <). | missed | caught |
| M02 | Handling hours are rounded to the nearest hour instead of up (ceil became round). | caught | caught |
| M03 | The crew's minimum billable hours are no longer enforced. | missed | caught |
| M04 | The 5 m3 minimum applies only when nothing was measured, not to a small measured inventory. | missed | caught |
| M05 | Inventory lines marked as staying behind are counted in the volume (filter removed). | missed | caught |
| M06 | The m3-per-m2 factor for the living-area estimate has its digits swapped (0.35 became 0.53). | missed | caught |
| M07 | Once a move is over 20 km, the whole distance is charged instead of only the part above 20 km. | caught | caught |
| M08 | A move of exactly 50 km is flagged for review (> became >=). | missed | caught |
| M09 | A volume exactly equal to the largest truck is flagged as over capacity (> became >=). | missed | caught |
| M10 | Stairs are charged even when there is an elevator. | caught | caught |
| M11 | The stairs price, which includes VAT, is booked as an ex-VAT amount (VAT charged twice). | caught | caught |
| M12 | The 10-30 m and over-30 m carry prices are swapped. | caught | caught |
| M13 | The heavy-items flag alone no longer adds the surcharge; only a special-items list does. | missed | caught |
| M14 | The pensioner discount is taken off every line, including travel, which is not labour. | caught | caught |
| M15 | The RUT deduction ignores the allowance the customer has left (no cap). | caught | caught |
| M16 | The RUT deduction is rounded to the nearest krona instead of down (can over-promise by 1 kr). | caught | caught |
| M17 | The RUT base is taken ex VAT instead of inc VAT (deduction 20 % too small). | caught | caught |
| M18 | Number validation only rejects negatives; NaN and Infinity slip through. | missed | caught |
| M19 | A negative inventory quantity is accepted (only fractional quantities are rejected). | missed | caught |
| M20 | RUT is granted to every move that is not an office move, so storage moves get it too. | missed | caught |
| M21 | The crew sort comparator has its arguments swapped, so crews are tried largest first. | caught | caught |
| | **Caught** | **10 / 21** | **21 / 21** |

```
naive suite: caught 10 of 21 planted bugs; missed: M01, M03, M04, M05, M06, M08, M09, M13, M18, M19, M20
behaviour suite: caught 21 of 21 planted bugs; missed: none
```

| ID | Correct variant (must pass) | Naive suite | Behaviour suite |
|---|---|---|---|
| V01 | Emits the labour line after the travel line (line order is unspecified). | accepted | accepted |
| V02 | Always emits a travel line, 0 SEK within 20 km (zero-amount lines are allowed). | accepted | accepted |
| V03 | Different error message wording (wording is unspecified). | accepted | accepted |
| V04 | Lists review reasons newest first (reason order is unspecified). | accepted | accepted |
| | **Accepted** | **4 / 4** | **4 / 4** |

```
naive suite: accepted 4 of 4 correct variants; rejected: none
behaviour suite: accepted 4 of 4 correct variants; rejected: none

Done in 28.7 s on Node v26.11.1, win32.
```

**Reading it:** the naive suite was green and still let 11 of 21 bugs through. Each of those 11
breaks a rule in SPEC.md: a price, a review decision, or which input is accepted. What they have in
common is where they live:

- exact boundaries (15 m3, 25 m3, 50 km);
- rules the default numbers never trigger: the minimum hours never bind with the default rate
  card, so M03 only shows up with a card where they do;
- inputs nobody typed in a happy path: NaN, a negative quantity, a storage move;
- flags tested for their review effect but not their price effect (M13).

Coverage would not have warned you. `npm run coverage:naive` (real output):

```
Statements   : 94.87% ( 111/117 )
Branches     : 80.72% ( 67/83 )
Functions    : 100% ( 21/21 )
Lines        : 97.82% ( 90/92 )
```

The two uncovered lines (171 and 178) are error throws. None of the 21 mutated lines is among
them, so all 11 surviving bugs sit on lines the naive suite runs and coverage reports as tested.

The behaviour suite caught all 21 and did not reject any of the four correct variants. Its extra
strictness did not cost a correct solution here.

**Limits of these numbers:** they hold for this code and these 21 mutations, nothing wider. The
same person wrote the spec, the behaviour suite and the mutations, so 21 of 21 shows the suite
covers the spec's rules. It is not an independent estimate of how many real-world bugs it would
catch. The mutations were written once, before the first harness run; none was added, changed or
dropped after seeing results. A fairer check is to have someone else write patches: the harness
accepts any patch file.

## The method, in plain English

A passing test suite tells you the code does what the tests say. It does not tell you the tests
say anything important. The usual proxy, line coverage, measures which lines ran, not whether a
wrong result on those lines would be noticed.

The direct way to find out is to break the code on purpose and watch the tests:

1. **Reference first.** Run the suite on the correct implementation. It must pass. If it fails,
   the suite grades a correct solution as wrong, and nothing else it says can be trusted.
2. **Deliberately flawed implementations.** Apply one small, realistic bug at a time: an
   off-by-one at a boundary, `<` for `<=`, a dropped condition, a missing cap, rounding in the
   wrong direction, swapped arguments, a wrong constant, inc VAT mixed up with ex VAT. A good
   suite fails on each. A bug the suite does not notice (a "surviving mutant") is a check the
   suite is missing.
3. **Correct alternatives.** Apply a change the spec allows, such as a different line order or a
   different error message. A good suite passes. If it fails, it is grading the author's
   implementation choices instead of the required behaviour.

The harness automates this. It verifies every patch applies exactly once, verifies the
unmodified code passes, then gives each patch its own copy of the code and runs each suite
against it.

## How this maps to validating evaluation tasks for coding agents

An evaluation task for a coding agent is a problem statement, a reference solution and a grader
(usually hidden tests). The grader has the same job as a test suite: accept correct solutions,
reject wrong ones. The same three checks validate it:

| Evaluation-task problem | Shows up here as | How the harness finds it |
|---|---|---|
| **Incorrect grade on a correct solution** | the reference fails the suite | baseline run must pass, or the harness aborts |
| **Missing check** (a flawed solution scores full marks) | a planted bug the suite misses | `mutations/`: 11 of 21 survive the naive suite |
| **Criterion that over-constrains** (a valid solution is failed for an incidental choice) | a correct variant the suite rejects | `variants/`: line order, zero lines, error wording, reason order |

A suite written in the same pass as the code tends to share the code's blind spots. It checks the
cases the author was thinking about, with the values the author already had in mind. The fix is
the one the behaviour suite applies: write the checks from a spec of required behaviour, aim them
at boundaries and at rules the defaults never exercise, assert only through the public interface,
and state what is deliberately unspecified (SPEC.md ends with that list) so the grader does not
pin it.

Background, from a different codebase: on an earlier project, a passing suite written in the same
pass as the code missed 7 of 12 deliberately planted bugs. Rewritten to pin required behaviour, it
caught 12 of 12. That code is not in this repository. This folder repeats the experiment on new
code and reports its own measured numbers above.

## Run it

Needs Node 22.12+, 24 or 26 (the versions vitest 5 supports). After `npm install`, nothing uses
the network.

```sh
npm install
npm test                                   # both suites on the unmodified code (77 tests)
npm run plant                              # the report above; exit code 0 even when bugs survive
npm run plant -- --verbose                 # also lists which tests failed for each patch
npm run plant -- --gate                    # exit 1 if the behaviour suite misses a bug or rejects a variant
npm run plant -- --suite naive --only M01,M08,V02
npm run coverage:naive                     # line coverage of quote.ts under the naive suite
npm run typecheck                          # tsc --noEmit over src and tests
```

`plant` exits with 2 and prints why if a patch does not apply exactly once or the unmodified code
fails a suite. Copies of the code go to a gitignored `.plant/` folder inside the project (so the
copied tests resolve `vitest` from `node_modules`) and are deleted after each run; `--keep` leaves
them for inspection.

## Adding a patch

One JSON file per patch: `mutations/` for bugs (must be caught), `variants/` for correct
alternatives (must be accepted).

```json
{
  "id": "M08",
  "name": "long-distance-flag-inclusive",
  "kind": "boundary",
  "description": "A move of exactly 50 km is flagged for review (> became >=).",
  "file": "src/quote.ts",
  "search": "if (distanceKm > REVIEW_DISTANCE_KM)",
  "replace": "if (distanceKm >= REVIEW_DISTANCE_KM)"
}
```

The `search` text must occur exactly once in the file, or the harness refuses to run.

## Layout

| Path | What it is |
|---|---|
| `src/quote.ts` | The quote engine: one public function, `quote(input, rateCard?)` |
| `SPEC.md` | Required behaviour, with rule IDs (V1, C1, ...) and the list of things left unspecified |
| `tests/naive.test.ts` | First-pass suite (17 tests) |
| `tests/behaviour.test.ts` | Spec-pinned suite (60 tests), grouped by SPEC rule |
| `mutations/` | 21 planted bugs, one search/replace patch each |
| `variants/` | 4 correct alternative implementations |
| `scripts/plant.mjs` | The harness |

## Where the code comes from

`src/quote.ts` is the pricing logic of a moving-company quoting tool I built,
copied out of the app and made self-contained: no UI, database, maps, translations or ID
generation. Prices, crews, thresholds, the access and heavy-item surcharges, the pensioner discount,
VAT and the 50 % RUT rate for private moves are unchanged from the source. The volume rules (item
volume = upper estimate x load factor, staying items excluded, living-area fallback, 5 m3
minimum) come from the same tool's inventory and pricing code.

Added in this version so the spec is complete: the RUT annual allowance cap (the source showed RUT
as a possible deduction to confirm before invoicing), explicit rounding (whole ore, RUT rounded
down to whole kronor), input validation, and one flag per reason. The 75 000 SEK default cap is a
rate-card setting. Check the current figure before relying on it.
