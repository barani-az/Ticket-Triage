import { type Advice, advise, type AdvisorContext, toUnderstanding, type Turn } from './advisor.js';
import type { Connection } from './connectors/contract.js';
import { type AuditLog, buildPlan, executePlan, type Plan } from './executor.js';
import type { LlmGateway } from './llm.js';
import { matchAnswer } from './matcher.js';
import { Questionnaire, type Profile } from './questionnaire.js';
import { route } from './router.js';
import type { Candidate, ConfirmationCard, Fields, Question, Understanding } from './types.js';
import { understand } from './understand.js';

export type UiToCore =
  | { type: 'submit'; text: string }
  | { type: 'answer'; choiceId?: string; text?: string }
  | { type: 'stop' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'fallback'; option: 'answer-one' | 'save-draft' };

export type CoreToUi =
  | { type: 'info'; text: string }
  | { type: 'assistant'; text: string; reasoning?: string; suggestions?: string[] }
  | { type: 'question'; question: Question }
  | { type: 'draft'; connection: string; rows: { field: string; value: string; assumed: boolean }[] }
  | { type: 'card'; card: ConfirmationCard; canConfirm: boolean; unresolved: string[]; options: string[]; errors: string[] }
  | { type: 'result'; ok: boolean; text: string; url?: string }
  | { type: 'error'; message: string };

type State =
  | { kind: 'idle' }
  | { kind: 'tool'; request: string; understanding: Understanding; candidates: Candidate[] }
  | { kind: 'asking'; request: string; conn: Connection; qn: Questionnaire }
  | { kind: 'confirming'; request: string; conn: Connection; qn: Questionnaire; plan: Plan; unresolved: string[] };

export interface SessionDeps {
  connections: Connection[];
  audit: AuditLog;
  profile?: Profile;
  prefs?: Fields;
  llm?: LlmGateway;
  /** Let the LLM reason about each request (answer, ask, or propose a ticket). On by default when an LLM is set. */
  advisor?: boolean;
  /**
   * When true, a draft that is complete and valid is created straight away, without the confirm
   * click. Questions for missing values are still asked. Read on every request so it can be toggled.
   */
  autoCreate?: () => boolean;
}

/** The whole conversation flow. No UI code: it takes typed messages in and returns typed messages out. */
export class Session {
  private state: State = { kind: 'idle' };
  readonly drafts: { connection: string; fields: Fields }[] = [];
  /** The conversation so far, so a follow-up like "make it high priority" has something to refer to. */
  private history: Turn[] = [];
  private projects?: { at: number; list: string[] };

  constructor(private deps: SessionDeps) {}

  /** What the reasoning step may know: the connected tools, their real projects, and recent tickets. */
  private async context(): Promise<AdvisorContext> {
    const now = Date.now();
    if (!this.projects || now - this.projects.at > 5 * 60_000) {
      const list: string[] = [];
      for (const c of this.deps.connections) {
        try {
          for (const p of (await c.connector.lookup('project', '')).slice(0, 12)) list.push(`${p.id}: ${p.label}`);
        } catch {
          /* an unhealthy connection simply contributes nothing */
        }
      }
      this.projects = { at: now, list: [...new Set(list)] };
    }
    const recent = this.deps.audit
      .list(5)
      .filter((a) => a.result.ok)
      .map((a) => `${(a.result as { id: string }).id} ${a.step.params.summary ?? ''}`.trim());
    return { today: new Date().toISOString().slice(0, 10), connections: this.deps.connections.map((c) => c.name), projects: this.projects.list, recent };
  }

  /** Ask the reasoning layer. Returns undefined when there is no LLM or it fails, so the plain flow takes over. */
  private async consult(text: string): Promise<Advice | undefined> {
    if (!this.deps.llm || this.deps.advisor === false) return undefined;
    const advice = await advise(this.history, text, await this.context(), this.deps.llm);
    if (advice) {
      this.history.push({ role: 'user', text }, { role: 'assistant', text: advice.reply });
      this.history = this.history.slice(-10);
    }
    return advice;
  }

  async handle(msg: UiToCore): Promise<CoreToUi[]> {
    try {
      switch (msg.type) {
        case 'submit':
          return await this.submit(msg.text);
        case 'answer':
          return await this.answer(msg);
        case 'stop':
          return await this.stop();
        case 'confirm':
          return await this.confirm();
        case 'cancel':
          this.state = { kind: 'idle' };
          return [{ type: 'info', text: 'Cancelled. Nothing was changed.' }];
        case 'fallback':
          return await this.fallback(msg.option);
      }
    } catch (e) {
      return [{ type: 'error', message: (e as Error).message }];
    }
  }

  private async submit(text: string): Promise<CoreToUi[]> {
    const advice = await this.consult(text);
    if (advice) {
      const said: CoreToUi = { type: 'assistant', text: advice.reply, reasoning: advice.reasoning, suggestions: advice.suggestions };
      if (advice.intent !== 'ticket' || !advice.ticket) {
        this.state = { kind: 'idle' };
        return [said];
      }
      // A proposed ticket goes through the same checks as any request: routing, lookups, the questionnaire.
      const understanding = toUnderstanding(advice.ticket, text);
      const routed = route(text, this.deps.connections);
      if ('ask' in routed) return [said, ...this.askWhichTool(text, understanding, routed.ask)];
      return [said, ...(await this.startFlow(text, routed.connection, understanding))];
    }
    const understanding = await understand(text, this.deps.llm);
    if (understanding.operation === 'read') {
      return [{ type: 'info', text: 'Reads are not part of this demo. Try "create a bug for ...".' }];
    }
    const routed = route(text, this.deps.connections);
    if ('ask' in routed) return this.askWhichTool(text, understanding, routed.ask);
    return this.startFlow(text, routed.connection, understanding);
  }

  private askWhichTool(request: string, understanding: Understanding, candidates: Candidate[]): CoreToUi[] {
    this.state = { kind: 'tool', request, understanding, candidates };
    return [
      {
        type: 'question',
        question: {
          id: 'tool',
          source: 1,
          blocking: true,
          field: '__tool',
          text: 'Which tool should this go to?',
          choices: candidates,
          allowFreeText: true,
        },
      },
    ];
  }

  private async startFlow(request: string, conn: Connection, understanding: Understanding): Promise<CoreToUi[]> {
    const qn = new Questionnaire(conn, understanding, this.deps.profile ?? 'guided', this.deps.prefs ?? {});
    this.state = { kind: 'asking', request, conn, qn };
    return [{ type: 'info', text: `Using ${conn.name}.` }, ...(await this.advance())];
  }

  private async advance(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'asking') return [];
    const next = await s.qn.next();
    const out: CoreToUi[] = [this.draftMessage(s.conn, s.qn)];
    if (next === 'done') return [...out, ...(await this.toCard(s.request, s.conn, s.qn, await s.qn.unresolved()))];
    return [...out, { type: 'question', question: next }];
  }

  private draftMessage(conn: Connection, qn: Questionnaire): CoreToUi {
    return {
      type: 'draft',
      connection: conn.name,
      rows: Object.entries(qn.fields).map(([field, v]) => ({ field, value: v.label, assumed: Boolean(v.assumed) })),
    };
  }

  private async answer(msg: { choiceId?: string; text?: string }): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind === 'tool') {
      const chosen =
        s.candidates.find((c) => c.id === msg.choiceId) ??
        (() => {
          const m = matchAnswer(msg.text ?? '', s.candidates);
          return m.kind === 'one' ? m.matches[0] : undefined;
        })();
      if (!chosen) return [{ type: 'info', text: 'Please pick one of the listed tools.' }];
      const conn = this.deps.connections.find((c) => c.id === chosen.id)!;
      return this.startFlow(s.request, conn, s.understanding);
    }
    if (s.kind !== 'asking') return [{ type: 'info', text: 'Start with a request, e.g. "create a bug for the login page crashing".' }];
    await s.qn.answer(msg);
    return this.advance();
  }

  private async stop(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'asking') return [{ type: 'info', text: 'Nothing to stop.' }];
    const { unresolvedRequired } = await s.qn.stop();
    return [this.draftMessage(s.conn, s.qn), ...(await this.toCard(s.request, s.conn, s.qn, unresolvedRequired))];
  }

  private async toCard(request: string, conn: Connection, qn: Questionnaire, unresolved: string[]): Promise<CoreToUi[]> {
    const schema = await qn.schema();
    const plan = buildPlan(conn, qn.fields, schema);
    this.state = { kind: 'confirming', request, conn, qn, plan, unresolved };
    const ready = unresolved.length === 0 && plan.errors.length === 0 && !conn.readOnly;
    if (ready && this.deps.autoCreate?.()) {
      const summary = plan.card.rows.map((r) => `${r.title}: ${r.value}`).join(' · ');
      return [{ type: 'info', text: `Creating on ${conn.name}: ${summary}` }, ...(await this.confirm())];
    }
    const titles = unresolved.map((k) => String(schema.properties?.[k]?.title ?? k));
    return [
      {
        type: 'card',
        card: plan.card,
        canConfirm: unresolved.length === 0 && plan.errors.length === 0 && !conn.readOnly,
        unresolved: titles,
        options: unresolved.length ? ['answer-one', 'save-draft'] : [],
        errors: plan.errors,
      },
    ];
  }

  private async confirm(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'confirming') return [{ type: 'info', text: 'Nothing to confirm.' }];
    if (s.unresolved.length) return [{ type: 'error', message: 'Required values are missing, so this cannot be sent.' }];
    const result = await executePlan(s.conn, s.plan, s.request, this.deps.audit);
    this.state = { kind: 'idle' };
    return result.ok
      ? [{ type: 'result', ok: true, text: `Created ${result.id}`, url: result.url }]
      : [{ type: 'result', ok: false, text: result.error }];
  }

  private async fallback(option: 'answer-one' | 'save-draft'): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'confirming') return [];
    if (option === 'save-draft') {
      this.drafts.push({ connection: s.conn.name, fields: { ...s.qn.fields } });
      this.state = { kind: 'idle' };
      return [{ type: 'info', text: `Draft saved (${this.drafts.length} in this session). Nothing was sent.` }];
    }
    const key = s.unresolved[0];
    if (!key) return [];
    const question = await s.qn.reopen(key);
    this.state = { kind: 'asking', request: s.request, conn: s.conn, qn: s.qn };
    return [{ type: 'question', question }];
  }
}
