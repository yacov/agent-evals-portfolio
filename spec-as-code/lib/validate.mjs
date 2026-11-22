// lib/validate.mjs: is the spec well-formed, internally consistent, and safe to compile?
//
// Errors block compilation and drift checking. Warnings flag missing checks: a forbidden action
// no embedded test exercises, a tool no rule tells the agent when to use.
//
// The last group of checks compiles the spec and scans the result. A spec whose own guard
// sentence trips its own banned-claim detector would make every drift check permanently red
// (an over-constraining criterion), and one whose prompt carries a deployment id or a `why`
// rationale leaks engineering context to the model. Both are caught here, before deployment.

import { compilePrompt } from '../compile.mjs';
import { detectorsOf, flatten, normalizeLines } from './spec.mjs';

const REQUIRED_KEYS = [
  'spec_version', 'meta', 'types', 'relations', 'trades', 'stages',
  'actions', 'forbidden_actions', 'claims', 'policies', 'rules', 'tests',
];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.trim().length > 0;
const isStrList = (x) => Array.isArray(x) && x.every(isStr);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function collectWhy(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectWhy(n, out));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'why' && isStr(v)) out.push(v);
      else collectWhy(v, out);
    }
  }
  return out;
}

function uniqueIds(list, where, err) {
  const seen = new Set();
  for (const item of list) {
    if (!isStr(item?.id)) { err(`${where}: every entry needs an id`); continue; }
    if (seen.has(item.id)) err(`${where}: duplicate id "${item.id}"`);
    seen.add(item.id);
  }
  return seen;
}

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!isObj(spec)) return { errors: ['spec is not a mapping'], warnings };
  for (const key of REQUIRED_KEYS) if (!(key in spec)) err(`missing top-level key "${key}"`);
  if (errors.length) return { errors, warnings }; // later checks would only repeat this

  // ── meta, types, relations ───────────────────────────────────────────────
  for (const k of ['agent', 'company', 'role', 'goal']) {
    if (!isStr(spec.meta?.[k])) err(`meta.${k} must be a non-empty string`);
  }
  if (!isObj(spec.types)) err('types must be a mapping of name -> description');
  const typeNames = new Set(Object.keys(isObj(spec.types) ? spec.types : {}));
  for (const [name, description] of Object.entries(isObj(spec.types) ? spec.types : {})) {
    if (!isStr(description)) err(`types.${name} needs a description`);
  }
  const agentName = isStr(spec.meta?.agent) ? cap(spec.meta.agent) : null;
  if (!Array.isArray(spec.relations)) err('relations must be a list');
  for (const rel of Array.isArray(spec.relations) ? spec.relations : []) {
    const m = /^(.+?) --(\w+)--> (.+)$/.exec(String(rel));
    if (!m) { err(`relation "${rel}" is not of the form "A --verb--> B [+ C]"`); continue; }
    for (const end of [m[1], ...m[3].split('+')].map((s) => s.trim())) {
      if (!typeNames.has(end) && end !== agentName) err(`relation "${rel}": "${end}" is not a declared type`);
    }
  }

  // ── trades and stages ────────────────────────────────────────────────────
  const tradesAll = spec.trades?.all;
  const inScope = spec.trades?.in_scope;
  if (!isStrList(tradesAll) || !isStrList(inScope) || inScope.length === 0) {
    err('trades.all and trades.in_scope must be non-empty lists of names');
  } else {
    const outside = inScope.filter((t) => !tradesAll.includes(t));
    if (outside.length) err(`trades.in_scope names trade(s) not in trades.all: ${outside.join(', ')}`);
  }
  if (!Array.isArray(spec.stages) || spec.stages.length === 0) err('stages must be a non-empty list');
  const stageIds = uniqueIds(Array.isArray(spec.stages) ? spec.stages : [], 'stages', err);
  for (const s of Array.isArray(spec.stages) ? spec.stages : []) {
    if (!isStr(s?.goal)) err(`stage "${s?.id}" needs a goal`);
  }

  // ── actions and forbidden actions ────────────────────────────────────────
  if (!isObj(spec.actions) || Object.keys(spec.actions).length === 0) err('actions must be a non-empty mapping');
  const actionNames = new Set(Object.keys(isObj(spec.actions) ? spec.actions : {}));
  for (const [name, a] of Object.entries(isObj(spec.actions) ? spec.actions : {})) {
    if (!isStr(a?.purpose)) err(`action "${name}" needs a purpose`);
    if (!Array.isArray(a?.required) || !a.required.every(isStr)) err(`action "${name}".required must be a list of parameter names (use [] for none)`);
    if (a?.optional !== undefined && !isStrList(a.optional)) err(`action "${name}".optional must be a list of parameter names`);
    const both = (a?.required ?? []).filter((p) => (a?.optional ?? []).includes(p));
    if (both.length) err(`action "${name}": parameter(s) both required and optional: ${both.join(', ')}`);
  }
  if (!Array.isArray(spec.forbidden_actions)) err('forbidden_actions must be a list');
  const forbidden = Array.isArray(spec.forbidden_actions) ? spec.forbidden_actions : [];
  const forbiddenIds = uniqueIds(forbidden, 'forbidden_actions', err);
  for (const f of forbidden) {
    if (!isStr(f?.guard)) err(`forbidden action "${f?.id}" needs a guard sentence for the prompt`);
    if (actionNames.has(f?.id)) err(`"${f.id}" is both an allowed action and a forbidden action`);
  }

  // ── claims ───────────────────────────────────────────────────────────────
  if (!isStr(spec.claims?.retrieval_rule)) err('claims.retrieval_rule must be a non-empty string');
  const approved = Array.isArray(spec.claims?.approved) ? spec.claims.approved : (err('claims.approved must be a list'), []);
  const banned = Array.isArray(spec.claims?.banned) ? spec.claims.banned : (err('claims.banned must be a list'), []);
  uniqueIds([...approved, ...banned], 'claims', err);
  for (const c of approved) {
    if (!isStr(c?.text)) err(`approved claim "${c?.id}" needs text`);
    if (!isStr(c?.evidence)) err(`approved claim "${c?.id}" has no evidence: an approved claim must cite where it is true`);
  }
  for (const b of banned) {
    if (!Array.isArray(b?.detect) || b.detect.length === 0) {
      err(`banned claim "${b?.id}" has no detect patterns: a ban with no detector checks nothing`);
    }
  }
  let detectors = [];
  try {
    detectors = detectorsOf(spec);
  } catch (e) {
    err(`a banned-claim detector is not a valid regex: ${e.message}`);
  }
  for (const c of approved) {
    for (const d of detectors) {
      if (isStr(c?.text) && d.re.test(flatten(c.text))) {
        err(`approved claim "${c.id}" trips banned claim ${d.claimId} ${d.label}: the spec approves and bans the same thing`);
      }
    }
  }

  // ── policies, rules, tests ───────────────────────────────────────────────
  if (!isObj(spec.policies)) err('policies must be a mapping of id -> text');
  for (const [id, text] of Object.entries(isObj(spec.policies) ? spec.policies : {})) {
    if (!isStr(text)) err(`policy "${id}" needs text`);
  }

  if (!Array.isArray(spec.rules) || spec.rules.length === 0) err('rules must be a non-empty list');
  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  const ruleIds = uniqueIds(rules, 'rules', err);
  const usedActions = new Set();
  for (const r of rules) {
    if (!isStr(r?.when)) err(`rule "${r?.id}" needs a "when" condition`);
    if (!isStr(r?.may) && !(Array.isArray(r?.must_not) && r.must_not.length)) err(`rule "${r?.id}" says neither what it may do nor what it must not do`);
    if (r?.must_not !== undefined && !isStrList(r.must_not)) err(`rule "${r?.id}".must_not must be a list`);
    if (r?.stage !== undefined && !stageIds.has(r.stage)) err(`rule "${r?.id}" names unknown stage "${r.stage}"`);
    for (const a of r?.using ?? []) {
      if (!actionNames.has(a)) err(`rule "${r?.id}" uses unknown action "${a}"`);
      usedActions.add(a);
    }
  }

  if (!Array.isArray(spec.tests)) err('tests must be a list');
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  uniqueIds(tests, 'tests', err);
  const exercised = new Set();
  for (const t of tests) {
    if (!isStr(t?.given) || !isStr(t?.expect)) err(`test "${t?.id}" needs "given" and "expect"`);
    if (t?.expect_rule !== undefined && !ruleIds.has(t.expect_rule)) err(`test "${t?.id}" expects unknown rule "${t.expect_rule}"`);
    for (const a of t?.expect_actions ?? []) if (!actionNames.has(a)) err(`test "${t?.id}" expects unknown action "${a}"`);
    for (const f of t?.expect_not ?? []) {
      if (!forbiddenIds.has(f)) err(`test "${t?.id}" expects unknown forbidden action "${f}"`);
      exercised.add(f);
    }
  }

  // ── missing checks (warnings) ────────────────────────────────────────────
  for (const id of forbiddenIds) if (!exercised.has(id)) warn(`forbidden action "${id}" is not exercised by any test (no expect_not names it)`);
  for (const name of actionNames) if (!usedActions.has(name)) warn(`action "${name}" is used by no rule: the agent has the tool and no instruction for when to use it`);

  if (errors.length) return { errors, warnings };

  // ── self-consistency: compile, then scan the output ──────────────────────
  const prompt = compilePrompt(spec);
  const lines = normalizeLines(prompt);
  const hay = flatten(prompt);
  for (const d of detectors) {
    if (!d.re.test(hay)) continue;
    const line = lines.find((l) => d.re.test(l.toLowerCase()));
    err(`the compiled prompt trips its own banned claim ${d.claimId} ${d.label}${line ? ` in "${line}"` : ''}: a guard, rule or policy says what the spec bans`);
  }
  for (const [key, value] of Object.entries(isObj(spec.bindings) ? spec.bindings : {})) {
    if (isStr(String(value)) && hay.includes(String(value).toLowerCase())) err(`leak: bindings.${key} "${value}" appears in the compiled prompt`);
  }
  for (const why of collectWhy(spec)) {
    if (hay.includes(flatten(why))) err(`leak: a "why" rationale appears in the compiled prompt: "${why.slice(0, 60)}..."`);
  }

  return { errors, warnings };
}
