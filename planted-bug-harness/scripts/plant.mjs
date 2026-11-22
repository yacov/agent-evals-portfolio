#!/usr/bin/env node
// Planted-bug harness. For every patch it copies src/ and tests/ into a fresh directory, applies
// the patch, and runs the chosen test suite(s) against the copy with vitest's JSON reporter.
//
//   mutations/  deliberately flawed implementations: a good suite must FAIL on each (catch it)
//   variants/   different but correct implementations: a good suite must PASS on each
//               (a failure there means the suite over-constrains the solution)
//
// Usage: node scripts/plant.mjs [--suite naive|behaviour|both] [--only M01,V02] [--jobs N]
//                               [--verbose] [--keep] [--gate]
//
// Exit codes: 0 = report printed (surviving mutants are a finding, not an error)
//             1 = --gate given and the behaviour suite missed a mutation or rejected a variant
//             2 = harness problem: a patch did not apply, or the unmutated code fails a suite
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
// Inside the project so the copied tests resolve `vitest` from ./node_modules. Ignored by git.
const WORK = path.join(ROOT, '.plant');
const SUITES = { naive: 'tests/naive.test.ts', behaviour: 'tests/behaviour.test.ts' };
const RUN_TIMEOUT_MS = 120_000;
let keepWorkspaces = false;

function fail(message) {
  console.error(`plant: ${message}`);
  if (!keepWorkspaces) rmSync(WORK, { recursive: true, force: true });
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { suites: ['naive', 'behaviour'], only: null, jobs: 2, verbose: false, keep: false, gate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    if (arg === '--suite') {
      const v = value();
      if (v === 'both') opts.suites = ['naive', 'behaviour'];
      else if (v in SUITES) opts.suites = [v];
      else fail(`--suite must be naive, behaviour or both (got "${v}")`);
    } else if (arg === '--only') opts.only = value().split(',').map((s) => s.trim().toUpperCase());
    else if (arg === '--jobs') opts.jobs = Math.max(1, parseInt(value(), 10) || 1);
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--gate') opts.gate = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/plant.mjs [--suite naive|behaviour|both] [--only M01,V02] [--jobs N] [--verbose] [--keep] [--gate]');
      process.exit(0);
    } else fail(`unknown option ${arg}`);
  }
  if (opts.gate && !opts.suites.includes('behaviour')) fail('--gate checks the behaviour suite; do not combine it with --suite naive');
  keepWorkspaces = opts.keep;
  return opts;
}

const lf = (text) => text.replace(/\r\n/g, '\n');

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

async function loadPatches(dirName, expect) {
  const dir = path.join(ROOT, dirName);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const patches = [];
  for (const file of files) {
    const p = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    for (const key of ['id', 'name', 'description', 'file', 'search', 'replace']) {
      if (typeof p[key] !== 'string') fail(`${dirName}/${file}: field "${key}" missing or not a string`);
    }
    patches.push({ ...p, search: lf(p.search), replace: lf(p.replace), source: `${dirName}/${file}`, expect });
  }
  return patches;
}

/** Apply every patch in memory first; abort if any search text is not found exactly once. */
async function preparePatches(patches) {
  const originals = new Map();
  const problems = [];
  for (const p of patches) {
    if (!originals.has(p.file)) originals.set(p.file, lf(await readFile(path.join(ROOT, p.file), 'utf8')));
    const original = originals.get(p.file);
    const hits = countOccurrences(original, p.search);
    if (hits !== 1) {
      problems.push(`${p.id} (${p.source}): search text found ${hits} times in ${p.file}, expected exactly 1`);
      continue;
    }
    p.patched = original.replace(p.search, () => p.replace);
    if (p.patched === original) problems.push(`${p.id} (${p.source}): patch leaves ${p.file} unchanged`);
  }
  if (problems.length) fail(`patches did not apply cleanly:\n  ${problems.join('\n  ')}`);
}

/** Copy src/ and tests/ into a fresh directory and optionally overwrite one file with patched text. */
async function makeWorkspace(label, patch) {
  await mkdir(WORK, { recursive: true });
  const dir = await mkdtemp(path.join(WORK, `${label}-`));
  await cp(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  await cp(path.join(ROOT, 'tests'), path.join(dir, 'tests'), { recursive: true });
  if (patch) {
    await writeFile(path.join(dir, patch.file), patch.text, 'utf8');
    const written = lf(await readFile(path.join(dir, patch.file), 'utf8'));
    if (written !== patch.text) fail(`${label}: patched file did not land in the workspace`);
  }
  return dir;
}

/** Run one suite with vitest's JSON reporter inside `dir`. status: 'pass' | 'fail' | 'timeout' | 'error'. */
function runSuite(dir, suite) {
  const outFile = path.join(dir, `${suite}.json`);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [VITEST, 'run', SUITES[suite], '--reporter=json', `--outputFile=${outFile}`],
      { cwd: dir, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (signal) return resolve({ status: 'timeout', failed: [], total: 0 });
      let report;
      try {
        report = JSON.parse(await readFile(outFile, 'utf8'));
      } catch {
        return resolve({ status: 'error', detail: `exit ${code}, no JSON report. ${stderr.slice(0, 500)}`, failed: [], total: 0 });
      }
      const failed = report.testResults.flatMap((file) =>
        file.assertionResults.filter((t) => t.status === 'failed').map((t) => t.fullName),
      );
      const fileFailed = report.testResults.some((file) => file.status === 'failed');
      const total = report.numTotalTests;
      if (total === 0) return resolve({ status: 'error', detail: 'suite ran 0 tests', failed, total });
      const status = failed.length > 0 || fileFailed || report.numFailedTests > 0 ? 'fail' : 'pass';
      resolve({ status, failed, total, passed: report.numPassedTests });
    });
  });
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// A mutation is caught when the suite fails (a timeout counts as caught: the bug changed behaviour).
// A variant is accepted when the suite passes.
const caughtMutation = (r) => r.status === 'fail' || r.status === 'timeout';
const mutationCell = (r) => (r.status === 'timeout' ? 'caught (timeout)' : caughtMutation(r) ? 'caught' : 'missed');
const variantCell = (r) => (r.status === 'pass' ? 'accepted' : 'REJECTED');

function table(title, rows, suites, cellFor, totalLabel, countFor) {
  const header = ['ID', title, ...suites.map((s) => `${s[0].toUpperCase()}${s.slice(1)} suite`)];
  const out = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const { p, results } of rows) out.push(`| ${p.id} | ${p.description} | ${suites.map((s) => cellFor(results[s])).join(' | ')} |`);
  out.push(`| | **${totalLabel}** | ${suites.map((s) => `**${countFor(s)} / ${rows.length}**`).join(' | ')} |`);
  return out.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  let patches = [...(await loadPatches('mutations', 'fail')), ...(await loadPatches('variants', 'pass'))];
  if (opts.only) {
    const unknown = opts.only.filter((id) => !patches.some((p) => p.id === id));
    if (unknown.length) fail(`--only: no mutation or variant with id ${unknown.join(', ')}`);
    patches = patches.filter((p) => opts.only.includes(p.id));
  }
  if (patches.length === 0) fail('no patches found in mutations/ or variants/');
  await preparePatches(patches);
  console.log(`Patches: ${patches.length}/${patches.length} applied (each search text found exactly once, file changed).`);

  // 1. Baseline: the unmutated code must pass every chosen suite, through the same workspace path.
  const baseDir = await makeWorkspace('baseline', null);
  for (const suite of opts.suites) {
    const r = await runSuite(baseDir, suite);
    if (r.status !== 'pass') {
      const why = r.status === 'fail' ? `failing tests: ${r.failed.join('; ')}` : r.detail ?? r.status;
      fail(`baseline: the UNMUTATED code does not pass the ${suite} suite (${why}). Fix that first.`);
    }
    console.log(`Baseline (no patch): ${suite} suite ${r.passed}/${r.total} tests pass.`);
  }
  if (!opts.keep) await rm(baseDir, { recursive: true, force: true });

  // 2. One workspace per patch; each chosen suite runs against it.
  const tasks = patches.map((p) => async () => {
    const dir = await makeWorkspace(p.id, { file: p.file, text: p.patched });
    const results = {};
    for (const suite of opts.suites) results[suite] = await runSuite(dir, suite);
    if (!opts.keep) await rm(dir, { recursive: true, force: true });
    process.stderr.write('.');
    return { p, results };
  });
  const rows = await pool(tasks, opts.jobs);
  process.stderr.write('\n');
  if (!opts.keep) await rm(WORK, { recursive: true, force: true });

  const errors = rows.flatMap(({ p, results }) =>
    Object.entries(results)
      .filter(([, r]) => r.status === 'error')
      .map(([suite, r]) => `${p.id} ${suite}: ${r.detail}`),
  );
  if (errors.length) fail(`some runs could not be evaluated:\n  ${errors.join('\n  ')}`);

  // 3. Report
  const mutationRows = rows.filter(({ p }) => p.expect === 'fail');
  const variantRows = rows.filter(({ p }) => p.expect === 'pass');
  const caught = (suite) => mutationRows.filter(({ results }) => caughtMutation(results[suite])).length;
  const accepted = (suite) => variantRows.filter(({ results }) => results[suite].status === 'pass').length;

  if (mutationRows.length) {
    console.log(`\n${table('Planted bug (must fail)', mutationRows, opts.suites, mutationCell, 'Caught', caught)}\n`);
    for (const suite of opts.suites) {
      const missed = mutationRows.filter(({ results }) => !caughtMutation(results[suite])).map(({ p }) => p.id);
      console.log(`${suite} suite: caught ${caught(suite)} of ${mutationRows.length} planted bugs; missed: ${missed.length ? missed.join(', ') : 'none'}`);
    }
  }
  if (variantRows.length) {
    console.log(`\n${table('Correct variant (must pass)', variantRows, opts.suites, variantCell, 'Accepted', accepted)}\n`);
    for (const suite of opts.suites) {
      const rejected = variantRows.filter(({ results }) => results[suite].status !== 'pass').map(({ p }) => p.id);
      console.log(`${suite} suite: accepted ${accepted(suite)} of ${variantRows.length} correct variants; rejected: ${rejected.length ? rejected.join(', ') : 'none'}`);
    }
  }

  if (opts.verbose) {
    console.log('\nFailing tests per patch:');
    for (const { p, results } of rows) {
      for (const suite of opts.suites) {
        const failed = results[suite].failed;
        if (failed.length) console.log(`  ${p.id} ${suite}: ${failed.slice(0, 3).join(' | ')}${failed.length > 3 ? ` (+${failed.length - 3} more)` : ''}`);
      }
    }
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s on Node ${process.version}, ${os.platform()}.`);

  if (opts.gate && (caught('behaviour') < mutationRows.length || accepted('behaviour') < variantRows.length)) {
    console.error('gate: the behaviour suite missed a planted bug or rejected a correct variant.');
    process.exit(1);
  }
}

main().catch((error) => fail(error?.stack ?? String(error)));
