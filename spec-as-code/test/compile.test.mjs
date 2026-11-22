// The prompt is a deterministic, leak-free function of the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compilePrompt } from '../compile.mjs';
import { ROOT, flatten, loadSpec, scanBanned } from '../lib/spec.mjs';

const spec = loadSpec();

test('compile is deterministic: same spec, same bytes, across separate loads', () => {
  const a = compilePrompt(spec);
  const b = compilePrompt(loadSpec());
  const c = compilePrompt(structuredClone(spec));
  assert.equal(a, b);
  assert.equal(a, c);
});

test('compile does not mutate the spec it is given', () => {
  const before = JSON.stringify(spec);
  compilePrompt(spec);
  assert.equal(JSON.stringify(spec), before);
});

test('the committed generated prompt is exactly compile(spec): nobody hand-edited it', () => {
  const golden = readFileSync(join(ROOT, 'generated', 'assistant.prompt.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(golden, compilePrompt(spec), 'regenerate with: npm run compile');
});

test('output is LF-only with a single trailing newline and no trailing spaces', () => {
  const p = compilePrompt(spec);
  assert.ok(!p.includes('\r'));
  assert.ok(p.endsWith('\n') && !p.endsWith('\n\n'));
  assert.ok(p.split('\n').every((l) => l === l.trimEnd()));
});

test('every typed element of the spec reaches the prompt', () => {
  const p = compilePrompt(spec);
  for (const f of spec.forbidden_actions) assert.ok(p.includes(f.guard), `guard for ${f.id}`);
  for (const c of spec.claims.approved) assert.ok(p.includes(`- ${c.text}`), `claim ${c.id}`);
  for (const name of Object.keys(spec.actions)) assert.ok(p.includes(`- ${name}(`), `tool ${name}`);
  for (const s of spec.stages) assert.ok(p.includes(`- ${s.id}: `), `stage ${s.id}`);
  for (const r of spec.rules) assert.ok(flatten(p).includes(flatten(`When ${r.when}`)), `rule ${r.id}`);
});

test('nothing for humans only leaks into the prompt: why, evidence, bindings, tests', () => {
  const hay = flatten(compilePrompt(spec));
  const why = [];
  const walk = (n) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) (k === 'why' ? why.push(v) : walk(v));
  };
  walk(spec);
  assert.ok(why.length >= 5, 'the spec carries rationale to leak');
  for (const w of why) assert.ok(!hay.includes(flatten(w)), `why leaked: ${w.slice(0, 40)}`);
  for (const c of spec.claims.approved) assert.ok(!hay.includes(flatten(c.evidence)), `evidence leaked: ${c.id}`);
  for (const v of Object.values(spec.bindings)) assert.ok(!hay.includes(String(v).toLowerCase()), `binding leaked: ${v}`);
  for (const t of spec.tests) assert.ok(!hay.includes(flatten(t.given)), `test leaked: ${t.id}`);
});

test('the compiled prompt trips none of the spec\'s own banned-claim detectors', () => {
  assert.deepEqual(scanBanned(spec, compilePrompt(spec)), []);
});
