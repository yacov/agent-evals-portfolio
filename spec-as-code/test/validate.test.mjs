// Spec validation: malformed or self-contradictory specs are caught before anything is compiled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, loadSpec } from '../lib/spec.mjs';
import { validateSpec } from '../lib/validate.mjs';

const spec = loadSpec();
const mutated = (fn) => {
  const s = structuredClone(spec);
  fn(s);
  return validateSpec(s);
};

test('the shipped spec is valid, with no warnings', () => {
  assert.deepEqual(validateSpec(spec), { errors: [], warnings: [] });
});

// [what is wrong, mutation, the error it must produce]
const ERRORS = [
  ['a required section is missing',
    (s) => { delete s.forbidden_actions; }, /missing top-level key "forbidden_actions"/],
  ['a rule uses an action the agent does not have',
    (s) => { s.rules.find((r) => r.id === 'rule.booking').using.push('book_now'); }, /rule "rule.booking" uses unknown action "book_now"/],
  ['a rule names a stage that does not exist',
    (s) => { s.rules.find((r) => r.id === 'rule.booking').stage = 'quote'; }, /unknown stage "quote"/],
  ['a rule says neither what it may do nor what it must not do',
    (s) => { s.rules.push({ id: 'rule.empty', when: 'always' }); }, /rule "rule.empty" says neither/],
  ['an approved claim has no evidence',
    (s) => { delete s.claims.approved[0].evidence; }, /"claim.licensed_technicians" has no evidence/],
  ['a banned claim has no detectors',
    (s) => { s.claims.banned[0].detect = []; }, /checks nothing/],
  ['a detector is not a valid regex',
    (s) => { s.claims.banned[2].detect.push({ regex: '([0-9]' }); }, /not a valid regex/],
  ['a relation points at an undeclared type',
    (s) => { s.relations.push('Visit --produces--> Invoice'); }, /"Invoice" is not a declared type/],
  ['a relation is not in A --verb--> B form',
    (s) => { s.relations.push('Caller has Job'); }, /is not of the form/],
  ['an in-scope trade is not a trade',
    (s) => { s.trades.in_scope.push('roofing'); }, /not in trades\.all: roofing/],
  ['a test expects a forbidden action that does not exist',
    (s) => { s.tests[0].expect_not.push('quote_a_price'); }, /unknown forbidden action "quote_a_price"/],
  ['a test expects a rule that does not exist',
    (s) => { s.tests[0].expect_rule = 'rule.pricing'; }, /unknown rule "rule.pricing"/],
  ['two stages share an id',
    (s) => { s.stages.push({ id: 'greet', goal: 'again' }); }, /stages: duplicate id "greet"/],
  ['the same id is allowed and forbidden',
    (s) => { s.actions.offer_discount = { purpose: 'x', required: [] }; }, /both an allowed action and a forbidden action/],
  ['a parameter is both required and optional',
    (s) => { s.actions.record_job.optional.push('trade'); }, /both required and optional: trade/],
  ['a guard sentence trips the spec\'s own banned-claim detector',
    (s) => { s.forbidden_actions[2].guard = 'Never say we are the cheapest, and never offer a discount.'; },
    /trips its own banned claim claim\.cheapest "cheapest" in "- Never say we are the cheapest/],
  ['the spec approves and bans the same claim',
    (s) => { s.claims.approved.push({ id: 'claim.fast', text: 'We can be there within the hour.', evidence: 'flyer' }); },
    /"claim\.fast" trips banned claim claim\.same_day_guarantee/],
  ['a deployment id would leak into the prompt',
    (s) => { s.actions.record_job.purpose += ' Stored under intake-demo-01.'; }, /leak: bindings\.deployment "intake-demo-01"/],
  ['a rationale would leak into the prompt',
    (s) => { s.policies.copied = s.forbidden_actions[0].why; }, /leak: a "why" rationale/],
];

for (const [what, fn, expected] of ERRORS) {
  test(`malformed spec is caught: ${what}`, () => {
    const { errors } = mutated(fn);
    assert.ok(errors.some((e) => expected.test(e)), `expected ${expected}, got:\n  ${errors.join('\n  ')}`);
  });
}

// Missing checks: not errors (the spec still compiles), but a reviewer should see them.
test('warns when a forbidden action is not exercised by any embedded test', () => {
  const { errors, warnings } = mutated((s) => { s.tests = s.tests.filter((t) => t.id !== 't.role_claim'); });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ['forbidden action "reveal_internals" is not exercised by any test (no expect_not names it)']);
});

test('warns when a tool is used by no rule', () => {
  const { errors, warnings } = mutated((s) => { s.rules = s.rules.filter((r) => r.id !== 'rule.record_job'); });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ['action "record_job" is used by no rule: the agent has the tool and no instruction for when to use it']);
});

test('compile.mjs refuses an invalid spec with exit 2 and writes nothing to stdout', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'compile.mjs'), '--spec', 'test/malformed/no-forbidden-actions.yaml'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /missing top-level key "forbidden_actions"/);
});
