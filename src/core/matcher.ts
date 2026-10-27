import type { Candidate } from './types.js';

export interface MatchResult {
  kind: 'one' | 'many' | 'none';
  matches: Candidate[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Match typed text to real candidates. Never guesses: several matches or none are reported as such. */
export function matchAnswer(text: string, candidates: Candidate[]): MatchResult {
  const t = norm(text);
  if (!t) return { kind: 'none', matches: [] };

  const exact = candidates.filter((c) => norm(c.label) === t || norm(c.id) === t);
  if (exact.length === 1) return { kind: 'one', matches: exact };

  const partial = candidates.filter((c) => {
    const label = norm(c.label);
    return label.includes(t) || (label.length >= 3 && t.includes(label)) || norm(c.id) === t;
  });
  if (partial.length === 1) return { kind: 'one', matches: partial };
  if (partial.length > 1) return { kind: 'many', matches: partial };
  return { kind: 'none', matches: [] };
}
