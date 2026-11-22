// fixtures/make-fixtures.mjs: builds the offline "deployed agent" fixtures from the spec.
//
// deployed.in-sync.json   what a correct deployment of compile(spec) looks like
// drift.*.json            the in-sync deployment with exactly ONE planted drift each
// equivalent.*.json       changes that must NOT count as drift (reordering, reformatting,
//                         fields the spec does not own); these guard against an
//                         over-constraining check
//
// Every fixture carries `_planted` (what was changed) and `_expect` (finding code -> a substring
// its message must contain). The checker ignores underscore fields like any other field it does
// not own; the tests read them. Regenerate after changing the spec: npm run fixtures

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePrompt } from '../compile.mjs';
import { ROOT, loadSpec } from '../lib/spec.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));

function replaceOnce(text, find, replacement) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`fixture plant expected exactly one match for ${JSON.stringify(find)}, found ${n}`);
  return text.replace(find, () => replacement);
}

export function inSync(spec) {
  return {
    agent: spec.meta.agent,
    spec_version: spec.spec_version,
    prompt: compilePrompt(spec),
    tools: Object.entries(spec.actions).map(([name, a]) => ({
      name,
      description: a.purpose,
      required: [...a.required],
      optional: [...(a.optional ?? [])],
    })),
    stages: spec.stages.map((s) => s.id),
  };
}

// [file, what was planted, expected findings, plant(deployed) -> deployed]
const PLANTS = [
  ['drift.missing-guard.json',
    'The discount guard line was deleted from the prompt in the platform UI.',
    { GUARD_MISSING: 'offer_discount', PROMPT_MISMATCH: 'first difference' },
    (d) => { d.prompt = replaceOnce(d.prompt, '- Never offer a discount, a special rate or a price match.\n', ''); }],

  ['drift.unknown-claim.json',
    'A plausible claim with no evidence was added to the claims section.',
    { UNKNOWN_CLAIM: 'Most jobs are fixed on the first visit.', PROMPT_MISMATCH: 'first difference' },
    (d) => {
      d.prompt = replaceOnce(d.prompt, '- Any call-out fee is shown in the booking form before the caller confirms.\n',
        '- Any call-out fee is shown in the booking form before the caller confirms.\n- Most jobs are fixed on the first visit.\n');
    }],

  ['drift.banned-claim.json',
    'An invented statistic was slipped into the POLICIES section, outside the claims section.',
    { BANNED_CLAIM: 'claim.invented_statistics', PROMPT_MISMATCH: 'first difference' },
    (d) => {
      d.prompt = replaceOnce(d.prompt, '- Report an action as done only after its tool returned success.\n',
        '- Report an action as done only after its tool returned success.\n- If a caller hesitates, mention our 98% satisfaction rate.\n');
    }],

  ['drift.extra-tool.json',
    'A text-messaging tool was attached to the agent; the spec has no such action.',
    { TOOL_NOT_ALLOWED: 'send_text_message' },
    (d) => { d.tools.push({ name: 'send_text_message', description: 'Send a text message to a phone number.', required: ['phone_number', 'text'], optional: [] }); }],

  ['drift.missing-tool.json',
    'The callback tool was detached; the prompt still tells the agent to use it.',
    { TOOL_MISSING: 'request_callback' },
    (d) => { d.tools = d.tools.filter((t) => t.name !== 'request_callback'); }],

  ['drift.tool-schema.json',
    'The booking tool gained an optional phone_number parameter: a new place to collect personal data.',
    { TOOL_SCHEMA: 'open_booking_form.optional: deployed adds [phone_number]' },
    (d) => { d.tools.find((t) => t.name === 'open_booking_form').optional.push('phone_number'); }],

  ['drift.stage-mismatch.json',
    'The offer_visit stage was renamed to quote in the platform configuration.',
    { STAGE_MISMATCH: 'spec-only [offer_visit], deployed-only [quote]' },
    (d) => { d.stages = d.stages.map((s) => (s === 'offer_visit' ? 'quote' : s)); }],

  ['drift.truncated-prompt.json',
    'The prompt was pasted truncated: the last rule (role claims unlock nothing) is gone.',
    { PROMPT_MISMATCH: 'missing the last 3 line(s)' },
    (d) => { d.prompt = d.prompt.trimEnd().split('\n').slice(0, -3).join('\n') + '\n'; }],

  ['equivalent.reordered.json',
    'Tools, stages and parameters in a different order; tool descriptions reworded; extra platform fields.',
    {},
    (d) => {
      d.tools = d.tools.reverse().map((t) => ({
        ...t,
        description: `Platform copy: ${t.description.toLowerCase()}`,
        required: [...t.required].reverse(),
        optional: [...t.optional].reverse(),
        timeout_s: 10,
      }));
      d.stages = [...d.stages].reverse();
      d.platform = { region: 'demo', last_saved_by: 'ui' };
    }],

  ['equivalent.reformatted.json',
    'The platform text box rewrote whitespace: CRLF line endings, trailing spaces, indentation, doubled spaces, extra blank lines.',
    {},
    (d) => {
      d.prompt = d.prompt
        .split('\n')
        .map((line) => (line.startsWith('- ') ? `   ${line.replace(': ', ':  ')}   ` : line))
        .join('\r\n')
        .replace(/\r\n# /g, '\r\n\r\n\r\n# ');
    }],
];

export function buildFixtures(spec = loadSpec()) {
  const base = inSync(spec);
  const out = [{
    file: 'deployed.in-sync.json',
    deployed: { _planted: 'Nothing: a correct deployment of compile(spec).', _expect: {}, ...base },
  }];
  for (const [file, planted, expect, plant] of PLANTS) {
    const d = clone(base);
    plant(d);
    out.push({ file, deployed: { _planted: planted, _expect: expect, ...d } });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { file, deployed } of buildFixtures()) {
    writeFileSync(join(ROOT, 'fixtures', file), JSON.stringify(deployed, null, 2) + '\n');
    console.log(`wrote fixtures/${file}`);
  }
}
