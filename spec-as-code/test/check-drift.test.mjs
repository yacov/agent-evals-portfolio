// The drift check catches every planted drift with the right message, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DeploymentShapeError, checkDrift } from '../check-drift.mjs';
import { buildFixtures, inSync } from '../fixtures/make-fixtures.mjs';
import { ROOT, loadSpec } from '../lib/spec.mjs';

const spec = loadSpec();
const FIXTURES = join(ROOT, 'fixtures');
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const read = (f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
const codes = (findings) => findings.map((f) => f.code).sort();

test('fixtures on disk are what make-fixtures.mjs builds from the current spec', () => {
  const built = buildFixtures(spec);
  assert.deepEqual(files, built.map((b) => b.file).sort());
  for (const { file, deployed } of built) assert.deepEqual(read(file), deployed, `${file} is stale: npm run fixtures`);
});

test('the in-sync deployment is clean', () => {
  assert.deepEqual(checkDrift(spec, read('deployed.in-sync.json')), []);
});

for (const file of files.filter((f) => f.startsWith('drift.'))) {
  test(`${file}: caught, with exactly the expected findings and messages`, () => {
    const fixture = read(file);
    const findings = checkDrift(spec, fixture);
    // Exact code set: catching the drift is half the job; not raising unrelated findings is the other half.
    assert.deepEqual(codes(findings), Object.keys(fixture._expect).sort(), fixture._planted);
    for (const [code, fragment] of Object.entries(fixture._expect)) {
      const f = findings.find((x) => x.code === code);
      assert.ok(f.message.includes(fragment), `${code} message should mention ${JSON.stringify(fragment)}, got: ${f.message}`);
    }
  });
}

// ── over-constraining: changes that must NOT count as drift ────────────────
for (const file of files.filter((f) => f.startsWith('equivalent.'))) {
  test(`${file}: not drift (${read(file)._planted})`, () => {
    assert.deepEqual(checkDrift(spec, read(file)), []);
  });
}

test('not drift: every permutation-style change at once, on a fresh deployment', () => {
  const d = inSync(spec);
  d.tools = [...d.tools].sort((a, b) => b.name.localeCompare(a.name)).map((t) => ({ ...t, required: [...t.required].reverse() }));
  d.stages = [...d.stages].sort();
  d.prompt = `\n\n${d.prompt.replace(/\n/g, '  \r\n')}\n\n`;
  d.unknown_platform_field = { anything: true };
  assert.deepEqual(checkDrift(spec, d), []);
});

test('still drift: a one-character change inside a sentence is not "whitespace"', () => {
  const d = inSync(spec);
  d.prompt = d.prompt.replace('booking form before the caller confirms.', 'booking form after the caller confirms.');
  assert.deepEqual(codes(checkDrift(spec, d)), ['PROMPT_MISMATCH', 'UNKNOWN_CLAIM']);
});

test('still drift: a renamed tool is one missing tool plus one unknown tool', () => {
  const d = inSync(spec);
  d.tools.find((t) => t.name === 'record_job').name = 'record_jobs';
  assert.deepEqual(codes(checkDrift(spec, d)), ['TOOL_MISSING', 'TOOL_NOT_ALLOWED']);
});

// ── layering: what each check catches on its own ───────────────────────────
test('without the exact-prompt check, guard and claim drift is still caught; a truncated prompt is not', () => {
  const semantic = (f) => codes(checkDrift(spec, read(f), { exactPrompt: false }));
  assert.deepEqual(semantic('drift.missing-guard.json'), ['GUARD_MISSING']);
  assert.deepEqual(semantic('drift.unknown-claim.json'), ['UNKNOWN_CLAIM']);
  assert.deepEqual(semantic('drift.banned-claim.json'), ['BANNED_CLAIM']);
  // The dropped rule carries no guard and no claim, so only the exact comparison sees it.
  assert.deepEqual(semantic('drift.truncated-prompt.json'), []);
});

test('a forbidden action deployed as a tool is called out as forbidden, not just unknown', () => {
  const d = inSync(spec);
  d.tools.push({ name: 'offer_discount', required: ['percent'] });
  const [f] = checkDrift(spec, d);
  assert.equal(f.code, 'TOOL_NOT_ALLOWED');
  assert.match(f.message, /FORBIDDEN/);
});

// ── vacuous input is refused, not reported clean ───────────────────────────
test('a deployment with no prompt or no tool list cannot be checked', () => {
  const ok = inSync(spec);
  for (const bad of [null, [], { ...ok, prompt: '' }, { ...ok, prompt: '   \n' }, { ...ok, tools: undefined }, { ...ok, stages: 'greet' }, { ...ok, tools: [{}] }]) {
    assert.throws(() => checkDrift(spec, bad), DeploymentShapeError);
  }
});

// ── CLI contract ───────────────────────────────────────────────────────────
const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'check-drift.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });

test('CLI exits 0 on the in-sync deployment', () => {
  const r = cli('fixtures/deployed.in-sync.json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CLEAN/);
});

test('CLI exits 1 and lists every finding on drift', () => {
  const r = cli('fixtures/drift.missing-guard.json');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /GUARD_MISSING/);
  assert.match(r.stdout, /PROMPT_MISMATCH/);
});

test('CLI exits 2 on an invalid spec and on a malformed deployment', () => {
  const badSpec = cli('fixtures/deployed.in-sync.json', '--spec', 'test/malformed/no-forbidden-actions.yaml');
  assert.equal(badSpec.status, 2);
  assert.match(badSpec.stderr, /forbidden_actions/);
  const badDeployment = cli('test/malformed/empty-prompt.deployed.json');
  assert.equal(badDeployment.status, 2);
  assert.match(badDeployment.stdout, /CANNOT CHECK/);
});
