import type { Connection } from './connectors/contract.js';
import { matchAnswer } from './matcher.js';
import type { Candidate, Fields, HintedField, JsonSchema, Question, Understanding } from './types.js';

export type Profile = 'guided' | 'expert';

export interface StopResult {
  assumed: string[];
  unresolvedRequired: string[];
}

interface Pending {
  q: Question;
  key: string;
  prop: JsonSchema;
}

const MAX_ATTEMPTS = 3;
const MAX_CHOICES = 8;

/**
 * Asks one question at a time until every required value is real and checked. Question
 * order is deterministic from the tool's schema and the draft, so no LLM call is needed per turn.
 */
export class Questionnaire {
  fields: Fields = {};
  private hints: Record<string, HintedField>;
  private attempts: Record<string, number> = {};
  private gaveUp = new Set<string>();
  private pending?: Pending;
  private queued?: Pending;
  private counter = 0;

  constructor(
    private conn: Connection,
    understanding: Understanding,
    private profile: Profile = 'guided',
    private prefs: Fields = {},
  ) {
    this.hints = { ...understanding.fields };
  }

  ctx(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.fields).map(([k, v]) => [k, v.id]));
  }

  schema(): Promise<JsonSchema> {
    return this.conn.connector.getSchema(this.ctx());
  }

  private isFree(prop: JsonSchema) {
    return !prop.enum && !prop['x-lookup'];
  }

  private async candidates(prop: JsonSchema, text: string): Promise<Candidate[]> {
    if (prop.enum) return (prop.enum as unknown[]).map((v) => ({ id: String(v), label: String(v) }));
    if (prop['x-lookup']) return this.conn.connector.lookup(prop['x-lookup'], text, this.ctx());
    return [];
  }

  private async make(
    key: string,
    prop: JsonSchema,
    source: Question['source'],
    text?: string,
    choices?: Candidate[],
  ): Promise<Pending> {
    const title = String(prop.title ?? key).toLowerCase();
    const list = choices ?? (await this.candidates(prop, '')).slice(0, MAX_CHOICES);
    const q: Question = {
      id: `${key}-${++this.counter}`,
      source,
      blocking: true,
      field: key,
      text: text ?? (this.isFree(prop) ? `What should the ${title} be?` : `Which ${title}?`),
      choices: list,
      allowFreeText: true,
    };
    return { q, key, prop };
  }

  private async ask(...args: Parameters<Questionnaire['make']>): Promise<Question> {
    this.pending = await this.make(...args);
    return this.pending.q;
  }

  async next(): Promise<Question | 'done'> {
    if (this.queued) {
      this.pending = this.queued;
      this.queued = undefined;
      return this.pending.q;
    }
    outer: for (let guard = 0; guard < 30; guard++) {
      const schema = await this.schema();
      const props: Record<string, JsonSchema> = schema.properties ?? {};

      const required = (schema.required ?? []) as string[];
      for (const key of Object.keys(props)) {
        if (this.fields[key] || this.gaveUp.has(key)) continue;
        const hint = this.hints[key];
        if (!hint) {
          // A required field we must ask comes first: later fields (e.g. issue type) may depend on it.
          if (required.includes(key)) break;
          continue;
        }
        delete this.hints[key];
        const q = await this.applyHint(key, props[key], hint);
        if (q) return q;
        continue outer; // the schema may now be larger (project and type unlock more fields)
      }

      const missing = ((schema.required ?? []) as string[]).find((k) => !this.fields[k] && !this.gaveUp.has(k));
      if (!missing) return 'done';
      return this.ask(missing, props[missing] ?? { type: 'string', title: missing }, 3);
    }
    return 'done';
  }

  private async applyHint(key: string, prop: JsonSchema, hint: HintedField): Promise<Question | undefined> {
    if (this.isFree(prop)) {
      this.fields[key] = { id: hint.value, label: hint.value };
      return;
    }
    const title = String(prop.title ?? key).toLowerCase();
    const m = matchAnswer(hint.value, await this.candidates(prop, hint.value));
    if (m.kind === 'one') {
      const c = m.matches[0];
      if (hint.confidence < 0.7 && this.profile === 'guided') {
        return this.ask(key, prop, 6, `I took the ${title} as ${c.label}. Correct?`, [c]);
      }
      this.fields[key] = { id: c.id, label: c.label };
      return;
    }
    if (m.kind === 'many') {
      return this.ask(key, prop, 4, `"${hint.value}" matches several ${title}s. Which one?`, m.matches);
    }
    return this.ask(key, prop, 5, `'${hint.value}' isn't a valid ${title} here. Pick one.`);
  }

  /** Answer the question last returned by next(). Follow-ups are queued for the next next(). */
  async answer(input: { choiceId?: string; text?: string }): Promise<void> {
    const p = this.pending;
    if (!p) throw new Error('No question is waiting for an answer.');
    const { key, prop } = p;
    this.attempts[key] = (this.attempts[key] ?? 0) + 1;
    const title = String(prop.title ?? key).toLowerCase();

    const chosen = input.choiceId !== undefined ? p.q.choices.find((c) => c.id === input.choiceId) : undefined;
    if (chosen) return this.set(key, chosen);

    const text = (input.text ?? '').trim();
    if (text && this.isFree(prop)) return this.set(key, { id: text, label: text });

    if (text) {
      const m = matchAnswer(text, await this.candidates(prop, text));
      if (m.kind === 'one') return this.set(key, m.matches[0]);
      if (this.attempts[key] < MAX_ATTEMPTS) {
        this.queued =
          m.kind === 'many'
            ? await this.make(key, prop, 4, `"${text}" matches several ${title}s. Which one?`, m.matches)
            : await this.make(key, prop, 5, `'${text}' isn't a valid ${title} here. Pick one.`);
      }
    } else if (this.attempts[key] < MAX_ATTEMPTS) {
      this.queued = await this.make(key, prop, 3);
    }
    if (!this.queued) this.gaveUp.add(key);
    this.pending = undefined;
  }

  private set(key: string, c: Candidate) {
    this.fields[key] = { id: c.id, label: c.label };
    this.pending = undefined;
  }

  /** Stop asking: fill gaps only from the tool's default, then saved preferences, else leave empty. */
  async stop(): Promise<StopResult> {
    this.pending = undefined;
    this.queued = undefined;
    const schema = await this.schema();
    const assumed: string[] = [];
    const unresolvedRequired: string[] = [];
    for (const key of (schema.required ?? []) as string[]) {
      if (this.fields[key]) continue;
      const def = schema.properties?.[key]?.default;
      if (def !== undefined) {
        this.fields[key] = { id: String(def), label: String(def), assumed: true };
        assumed.push(key);
      } else if (this.prefs[key]) {
        this.fields[key] = { ...this.prefs[key], assumed: true };
        assumed.push(key);
      } else {
        unresolvedRequired.push(key);
      }
    }
    return { assumed, unresolvedRequired };
  }

  /** Required fields still without a value (after next() reported 'done'). */
  async unresolved(): Promise<string[]> {
    const schema = await this.schema();
    return ((schema.required ?? []) as string[]).filter((k) => !this.fields[k]);
  }

  /** Fallback "answer just this one": ask a field again from scratch. */
  async reopen(key: string): Promise<Question> {
    this.gaveUp.delete(key);
    this.attempts[key] = 0;
    const schema = await this.schema();
    return this.ask(key, schema.properties?.[key] ?? { type: 'string', title: key }, 3);
  }
}
