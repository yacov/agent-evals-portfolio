// scripts/mutants.mjs: are the tests able to fail? Seeded mutation testing for the checker itself.
//
// A green suite proves little until it has been shown to go red. Each mutant below breaks one
// check in a temporary copy of this folder, runs `node --test` there, and records whether any
// test failed (KILLED) or the suite stayed green (SURVIVED: a missing test).
//
// Usage: node scripts/mutants.mjs     Exit 0 if every mutant is killed, 1 otherwise.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/spec.mjs';

// [what the mutant breaks, file, exact text to find, replacement]
const MUTANTS = [
  ['guard check disabled', 'check-drift.mjs', 'if (!hay.includes(flatten(f.guard)))', 'if (false)'],
  ['unknown-claim scan disabled', 'check-drift.mjs', 'if (!approved.has(flatten(line)))', 'if (false)'],
  ['banned-claim scan disabled', 'check-drift.mjs', 'for (const hit of scanBanned(spec, deployed.prompt))', 'for (const hit of [])'],
  ['stage check disabled', 'check-drift.mjs', 'if (!sameSet(specStages, deployed.stages))', 'if (false)'],
  ['optional parameters ignored', 'check-drift.mjs', "for (const kind of ['required', 'optional'])", "for (const kind of ['required'])"],
  ['exact prompt check off by default', 'check-drift.mjs', '{ exactPrompt = true } = {}', '{ exactPrompt = false } = {}'],
  ['empty deployment accepted', 'check-drift.mjs', 'if (problems.length) throw', 'if (false) throw'],
  ['order-sensitive comparison (over-constraining)', 'check-drift.mjs', '].map(String).sort();', '].map(String);'],
  ['whitespace not normalised (over-constraining)', 'lib/spec.mjs', ".map((line) => line.replace(/\\s+/g, ' ').trim())", '.map((line) => line)'],
  ['compiler leaks rationale', 'compile.mjs', 'out.push(`- ${oneLine(forbidden.guard)}`)', "out.push(`- ${oneLine(forbidden.guard)} ${forbidden.why ?? ''}`)"],
  ['validator skips self-contradiction scan', 'lib/validate.mjs', 'if (!d.re.test(hay)) continue;', 'continue;'],
  ['validator accepts claims without evidence', 'lib/validate.mjs', 'if (!isStr(c?.evidence))', 'if (false)'],
];

let survived = 0;
for (const [name, file, find, replacement] of MUTANTS) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-as-code-mutant-'));
  try {
    cpSync(ROOT, dir, { recursive: true });
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    if (source.split(find).length !== 2) throw new Error(`mutant "${name}": expected exactly one match in ${file}`);
    writeFileSync(path, source.replace(find, () => replacement));
    const run = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' });
    const failed = Number(/ℹ fail (\d+)/.exec(run.stdout)?.[1] ?? NaN);
    const killed = failed > 0;
    if (!killed) survived++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'}  ${name.padEnd(48)} ${failed} failing test(s)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\n${MUTANTS.length - survived}/${MUTANTS.length} mutants killed`);
process.exitCode = survived ? 1 : 0;
