// compile.mjs: spec -> system prompt. Pure and deterministic: the same spec gives the same bytes.
//
// The prompt is never edited by hand. It is the compiled view of spec/assistant.yaml, emitted in
// a fixed section order with the spec's own item order preserved (rules are in priority order).
// Nothing time-, locale- or environment-dependent goes into it.
//
// What is deliberately NOT compiled: `why` rationale, `bindings` (deployment ids), `relations`,
// `evidence` and `tests`. The model needs the executable rule; humans need the explanation.
// lib/validate.mjs proves none of it leaks.
//
// Usage:
//   node compile.mjs                       # print the prompt for spec/assistant.yaml
//   node compile.mjs --spec <file> --out <file>
// Exit 0 on success, 2 if the spec is invalid (nothing is written).

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const human = (id) => String(id).replace(/_/g, ' ');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const series = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export const SECTIONS = Object.freeze({
  claims: 'CLAIMS YOU MAY MAKE',
});

export function compilePrompt(spec) {
  const out = [];
  const section = (title) => {
    if (out.length) out.push('');
    out.push(`# ${title}`);
  };
  const { meta } = spec;

  section('ROLE');
  out.push(`You are ${cap(meta.agent)}, the ${meta.role} for ${meta.company}.`);
  out.push(`Your goal: ${oneLine(meta.goal)}`);
  out.push('Everything you may know, say or do is listed below. If it is not listed, you do not do it.');

  section('WHAT YOU KEEP TRACK OF');
  for (const [type, description] of Object.entries(spec.types)) out.push(`- ${type}: ${oneLine(description)}`);

  section('TRADES');
  out.push(`You can arrange a visit for ${series(spec.trades.in_scope.map(human))} work.`);
  out.push('Any other kind of work is out of scope: you cannot arrange a visit for it.');

  section('STAGES');
  for (const stage of spec.stages) out.push(`- ${stage.id}: ${oneLine(stage.goal)}`);

  section('TOOLS');
  out.push('You have exactly these tools. No other tool exists, so never describe or promise one.');
  for (const [name, action] of Object.entries(spec.actions)) {
    const params = [...(action.required ?? []), ...(action.optional ?? []).map((p) => `${p}?`)];
    out.push(`- ${name}(${params.join(', ')}): ${oneLine(action.purpose)}`);
  }

  section('NEVER');
  for (const forbidden of spec.forbidden_actions) out.push(`- ${oneLine(forbidden.guard)}`);

  section(SECTIONS.claims);
  out.push(oneLine(spec.claims.retrieval_rule));
  for (const claim of spec.claims.approved) out.push(`- ${oneLine(claim.text)}`);

  section('POLICIES');
  for (const text of Object.values(spec.policies)) out.push(`- ${oneLine(text)}`);

  section('RULES');
  out.push('Rules are in priority order: when two apply, the earlier one wins.');
  for (const rule of spec.rules) {
    out.push('');
    out.push(`When ${oneLine(rule.when)}${rule.stage ? ` (stage ${rule.stage})` : ''}:`);
    if (rule.may) out.push(`- You may: ${oneLine(rule.may)}`);
    if (rule.using?.length) out.push(`- Using: ${rule.using.join(', ')}`);
    if (rule.must_not?.length) out.push(`- You must not: ${rule.must_not.map(oneLine).join('; ')}`);
    if (rule.if_unknown) out.push(`- If unsure: ${oneLine(rule.if_unknown)}`);
  }

  return out.join('\n') + '\n';
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function main(argv) {
  const { loadSpec, DEFAULT_SPEC } = await import('./lib/spec.mjs');
  const { validateSpec } = await import('./lib/validate.mjs');
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };

  const spec = loadSpec(flag('spec') ?? DEFAULT_SPEC);
  const { errors, warnings } = validateSpec(spec);
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length) {
    console.error(`spec is invalid (${errors.length} error(s)), nothing compiled:`);
    for (const e of errors) console.error(`  - ${e}`);
    return 2;
  }
  const prompt = compilePrompt(spec);
  const out = flag('out');
  if (out) {
    writeFileSync(out, prompt);
    console.error(`compiled -> ${out} (${prompt.length} chars, ${prompt.split('\n').length - 1} lines)`);
  } else {
    process.stdout.write(prompt);
  }
  return 0;
}

// No top-level await: lib/validate.mjs imports this module, and a module still suspended in a
// top-level await cannot be imported back by the module it is waiting for.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
