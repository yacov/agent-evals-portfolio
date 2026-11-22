// lib/spec.mjs: loading a spec, and the text helpers both the compiler and the checker share.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SPEC = resolve(ROOT, 'spec', 'assistant.yaml');

export function loadSpec(path = DEFAULT_SPEC) {
  return parse(readFileSync(path, 'utf8'));
}

// Whitespace is not meaning. Line endings, trailing spaces, indentation, runs of spaces and
// blank lines are all things a hosting platform's text box rewrites on save, and a check that
// fails on them is a check that is always red and therefore never read. Everything else counts.
export function normalizeLines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// One string, lower-cased, for phrase scanning. A phrase broken across a line still matches.
export function flatten(text) {
  return normalizeLines(text).join(' ').toLowerCase();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A banned claim's `detect` list holds plain phrases (case-insensitive substring) and
// `{ regex: '...' }` entries (case-insensitive). Throws on an invalid regex; the validator
// turns that into an error message.
export function detectorsOf(spec) {
  const out = [];
  for (const claim of spec?.claims?.banned ?? []) {
    for (const entry of claim?.detect ?? []) {
      if (typeof entry === 'string') {
        out.push({ claimId: claim.id, label: JSON.stringify(entry), re: new RegExp(escapeRe(entry.toLowerCase().replace(/\s+/g, ' ')), 'i') });
      } else if (entry && typeof entry.regex === 'string') {
        out.push({ claimId: claim.id, label: `/${entry.regex}/`, re: new RegExp(entry.regex, 'i') });
      }
    }
  }
  return out;
}

// One hit per banned claim, listing every detector of that claim that fired.
export function scanBanned(spec, text) {
  const hay = flatten(text);
  const hits = new Map();
  for (const d of detectorsOf(spec)) {
    if (!d.re.test(hay)) continue;
    if (!hits.has(d.claimId)) hits.set(d.claimId, []);
    hits.get(d.claimId).push(d.label);
  }
  return [...hits].map(([claimId, patterns]) => ({ claimId, patterns }));
}

// Bullet lines ("- ...") under a "# HEADING", up to the next heading. null if the heading is absent.
export function sectionBullets(text, heading) {
  const lines = normalizeLines(text);
  const start = lines.indexOf(`# ${heading}`);
  if (start === -1) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('# ')) break;
    if (line.startsWith('- ')) out.push(line.slice(2));
  }
  return out;
}
