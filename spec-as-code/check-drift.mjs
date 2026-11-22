// check-drift.mjs: does the deployed agent still match its spec? Read-only.
//
// The deployed agent is described by a JSON document of the shape a hosting platform's API
// returns: { prompt, tools: [{ name, required, optional }], stages: [...] }. Here it is an
// offline fixture; in production it would be the API response.
//
// Five checks (tools, stages, guards, claims, exact prompt), eight finding codes. Each finding
// names what drifted in words a reviewer can act on:
//   TOOL_NOT_ALLOWED  a deployed tool the spec does not list (an ungoverned capability)
//   TOOL_MISSING      a spec action the agent does not carry (it would narrate a call that never fires)
//   TOOL_SCHEMA       required/optional parameters differ (e.g. a new place to put a phone number)
//   STAGE_MISMATCH    the platform's stage list differs from the spec's
//   GUARD_MISSING     a forbidden action's guard sentence is absent from the deployed prompt
//   UNKNOWN_CLAIM     the claims section states something with no approved, evidenced entry
//   BANNED_CLAIM      a banned claim's detector fires anywhere in the deployed prompt
//   PROMPT_MISMATCH   the deployed prompt is not compile(spec), up to whitespace
//
// What deliberately does NOT count as drift (over-constraining a check makes it useless):
// tool and stage ORDER, parameter order, whitespace and line endings in the prompt, tool
// descriptions and any other field the spec does not own.
//
// Usage:
//   node check-drift.mjs [deployed.json | directory ...] [--spec <file>] [--no-exact-prompt]
// Exit 0 clean, 1 drift, 2 cannot check (invalid spec, unreadable or malformed deployment).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePrompt, SECTIONS } from './compile.mjs';
import { DEFAULT_SPEC, ROOT, flatten, loadSpec, normalizeLines, scanBanned, sectionBullets } from './lib/spec.mjs';
import { validateSpec } from './lib/validate.mjs';

export class DeploymentShapeError extends Error {}

// An empty prompt or a missing tool list would let the claim scans pass for the wrong reason:
// a prompt that says nothing contains no banned phrase. Refuse rather than report a vacuous result.
function assertShape(d) {
  const problems = [];
  if (d === null || typeof d !== 'object' || Array.isArray(d)) problems.push('not a JSON object');
  else {
    if (typeof d.prompt !== 'string' || d.prompt.trim() === '') problems.push('"prompt" is missing or empty');
    if (!Array.isArray(d.tools)) problems.push('"tools" is not a list');
    else if (d.tools.some((t) => typeof t?.name !== 'string')) problems.push('a tool has no name');
    if (!Array.isArray(d.stages)) problems.push('"stages" is not a list');
  }
  if (problems.length) throw new DeploymentShapeError(`cannot check this deployment: ${problems.join('; ')}`);
}

const sorted = (xs) => [...new Set(xs ?? [])].map(String).sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const minus = (a, b) => sorted(a).filter((x) => !(b ?? []).includes(x));
const fmt = (xs) => `[${xs.join(', ')}]`;
const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function checkDrift(spec, deployed, { exactPrompt = true } = {}) {
  assertShape(deployed);
  const findings = [];
  const add = (code, message) => findings.push({ code, message });

  // ── tools ────────────────────────────────────────────────────────────────
  const forbiddenIds = new Set(spec.forbidden_actions.map((f) => f.id));
  const deployedTools = new Map(deployed.tools.map((t) => [t.name, t]));
  for (const name of deployedTools.keys()) {
    if (!(name in spec.actions)) {
      const why = forbiddenIds.has(name) ? 'and the spec lists it as a FORBIDDEN action' : 'no rule in the prompt governs it';
      add('TOOL_NOT_ALLOWED', `"${name}" is deployed but not in spec.actions; ${why}`);
    }
  }
  for (const [name, action] of Object.entries(spec.actions)) {
    const tool = deployedTools.get(name);
    if (!tool) {
      add('TOOL_MISSING', `"${name}" is in spec.actions but not deployed; the prompt tells the agent to call a tool that does not exist`);
      continue;
    }
    for (const kind of ['required', 'optional']) {
      const want = action[kind] ?? [];
      const have = tool[kind] ?? [];
      if (sameSet(want, have)) continue;
      const extra = minus(have, want);
      const missing = minus(want, have);
      const parts = [];
      if (extra.length) parts.push(`deployed adds ${fmt(extra)}`);
      if (missing.length) parts.push(`deployed lacks ${fmt(missing)}`);
      add('TOOL_SCHEMA', `${name}.${kind}: ${parts.join(', ')} (spec ${fmt(sorted(want))})`);
    }
  }

  // ── stages ───────────────────────────────────────────────────────────────
  const specStages = spec.stages.map((s) => s.id);
  if (!sameSet(specStages, deployed.stages)) {
    add('STAGE_MISMATCH', `spec-only ${fmt(minus(specStages, deployed.stages))}, deployed-only ${fmt(minus(deployed.stages, specStages))}`);
  }

  // ── guards ───────────────────────────────────────────────────────────────
  const hay = flatten(deployed.prompt);
  for (const f of spec.forbidden_actions) {
    if (!hay.includes(flatten(f.guard))) {
      add('GUARD_MISSING', `forbidden action "${f.id}" has no guard in the deployed prompt; expected "${f.guard}"`);
    }
  }

  // ── claims ───────────────────────────────────────────────────────────────
  const stated = sectionBullets(deployed.prompt, SECTIONS.claims);
  if (stated === null) {
    add('UNKNOWN_CLAIM', `the deployed prompt has no "# ${SECTIONS.claims}" section, so its claims cannot be checked against the spec`);
  } else {
    const approved = new Set(spec.claims.approved.map((c) => flatten(c.text)));
    for (const line of stated) {
      if (!approved.has(flatten(line))) add('UNKNOWN_CLAIM', `"${clip(line)}" is stated as a claim but has no approved, evidenced entry in the spec`);
    }
  }
  for (const hit of scanBanned(spec, deployed.prompt)) {
    add('BANNED_CLAIM', `${hit.claimId}: the deployed prompt matches ${hit.patterns.join(', ')}`);
  }

  // ── exact prompt ─────────────────────────────────────────────────────────
  if (exactPrompt) {
    const want = normalizeLines(compilePrompt(spec));
    const have = normalizeLines(deployed.prompt);
    let i = 0;
    while (i < want.length && i < have.length && want[i] === have[i]) i++;
    if (i < want.length || i < have.length) {
      const detail = i >= have.length ? `the deployed prompt is missing the last ${want.length - have.length} line(s); truncated paste?`
        : i >= want.length ? `the deployed prompt has ${have.length - want.length} extra line(s) at the end`
          : `first difference at non-blank line ${i + 1}: compiled "${clip(want[i])}" vs deployed "${clip(have[i])}"`;
      add('PROMPT_MISMATCH', `deployed prompt is not compile(spec), ignoring whitespace; ${detail}`);
    }
  }

  return findings;
}

// A one-line description of what was compared, so a clean result says what it is clean OF.
export function coverage(spec) {
  return `${Object.keys(spec.actions).length} tools, ${spec.stages.length} stages, ${spec.forbidden_actions.length} guards, `
    + `${spec.claims.approved.length} approved claims, ${spec.claims.banned.length} banned claims`;
}

// ── CLI ────────────────────────────────────────────────────────────────────
function expand(paths) {
  return paths.flatMap((p) => (statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => join(p, f))
    : [p]));
}

function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
  const specPath = flag('spec') ?? DEFAULT_SPEC;
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--spec');
  const exactPrompt = !argv.includes('--no-exact-prompt');

  const spec = loadSpec(specPath);
  const { errors } = validateSpec(spec);
  if (errors.length) {
    console.error(`spec is invalid (${errors.length} error(s)); refusing to check against it:`);
    for (const e of errors) console.error(`  - ${e}`);
    return 2;
  }

  let files;
  try {
    files = expand(positional.length ? positional : [join(ROOT, 'fixtures', 'deployed.in-sync.json')]);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  console.log(`spec : ${relative(process.cwd(), specPath) || specPath} (v${spec.spec_version}; ${coverage(spec)}${exactPrompt ? ', exact prompt' : ''})`);
  let worst = 0;
  for (const file of files) {
    const name = relative(process.cwd(), file) || file;
    let findings;
    try {
      findings = checkDrift(spec, JSON.parse(readFileSync(file, 'utf8')), { exactPrompt });
    } catch (e) {
      console.log(`\n${name}\n  CANNOT CHECK  ${e.message}`);
      worst = 2;
      continue;
    }
    console.log(`\n${name}`);
    if (!findings.length) { console.log('  CLEAN'); continue; }
    for (const f of findings) console.log(`  ${f.code.padEnd(16)} ${f.message}`);
    console.log(`  DRIFT: ${findings.length} finding(s)`);
    worst = Math.max(worst, 1);
  }
  return worst;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
