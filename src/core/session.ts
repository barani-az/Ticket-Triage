import { actionUnderstanding, type Advice, advise, type AdvisorContext, type SourceRequest, type TicketProposal, toUnderstanding, type Turn } from './advisor.js';
import type { Connection, SourceContent } from './connectors/contract.js';
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
  | { type: 'result'; ok: boolean; text: string; url?: string; stamp?: string; linkText?: string; suggestions?: string[] }
  | { type: 'error'; message: string };

type State =
  | { kind: 'idle' }
  | { kind: 'tool'; request: string; understanding: Understanding; candidates: Candidate[]; source?: SourceContent }
  | { kind: 'source'; request: string; from: SourceRequest['kind']; conn: Connection; candidates: Candidate[] }
  | { kind: 'asking'; request: string; conn: Connection; qn: Questionnaire; source?: SourceContent }
  | { kind: 'confirming'; request: string; conn: Connection; qn: Questionnaire; plan: Plan; unresolved: string[]; source?: SourceContent };

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
   * Connections marked `confirmAlways` (Microsoft 365: messages can't be unsent) always show the card.
   */
  autoCreate?: () => boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The whole conversation flow. No UI code: it takes typed messages in and returns typed messages out. */
export class Session {
  private state: State = { kind: 'idle' };
  readonly drafts: { connection: string; fields: Fields }[] = [];
  /** The conversation so far, so a follow-up like "make it high priority" has something to refer to. */
  private history: Turn[] = [];
  private projects?: { at: number; list: string[] };
  /** The email or chat the last ticket was drafted from, so "reply to them" has a target. */
  private lastSource?: SourceContent;

  constructor(private deps: SessionDeps) {}

  private m365() {
    return this.deps.connections.find((c) => c.connector.manifest.type === 'ms365');
  }
  private m365Actions(): string[] {
    return (this.m365()?.connector as { actions?: () => string[] } | undefined)?.actions?.() ?? [];
  }

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
      .list(10)
      .filter((a) => a.result.ok && a.step.params.summary)
      .slice(0, 5)
      .map((a) => {
        const r = a.result as { id: string; url: string };
        return `${r.id} ${a.step.params.summary} ${r.url ?? ''}`.trim();
      });
    const d = new Date();
    const src = this.lastSource;
    return {
      today: d.toISOString().slice(0, 10),
      now: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}, ${d.toLocaleDateString('en-US', { weekday: 'long' })}`,
      connections: this.deps.connections.map((c) => c.name),
      projects: this.projects.list,
      recent,
      actions: this.m365Actions(),
      source: src ? `the ${src.kind} "${src.title}" from ${src.from}` : undefined,
    };
  }

  /** Ask the reasoning layer. Returns undefined when there is no LLM or it fails, so the plain flow takes over. */
  private async consult(text: string, source?: SourceContent): Promise<Advice | undefined> {
    if (!this.deps.llm || this.deps.advisor === false) return undefined;
    const advice = await advise(this.history, text, await this.context(), this.deps.llm, source);
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
      if (advice.intent === 'action' && advice.action) {
        const conn = this.m365();
        if (!conn) return [said, { type: 'info', text: 'Microsoft 365 is not connected. Set M365=1 in .env and run npm run m365:login.' }];
        return [said, ...(await this.startFlow(text, conn, actionUnderstanding(advice.action)))];
      }
      if (advice.intent === 'ticket' && advice.from) return [said, ...(await this.askSource(text, advice.from))];
      if (advice.intent !== 'ticket' || !advice.ticket) {
        this.state = { kind: 'idle' };
        return [said];
      }
      // A proposed ticket goes through the same checks as any request: routing, lookups, the questionnaire.
      return [said, ...(await this.toTicketTool(text, toUnderstanding(advice.ticket, text)))];
    }
    const understanding = await understand(text, this.deps.llm);
    if (understanding.operation === 'read') {
      return [{ type: 'info', text: 'Reads are not part of this demo. Try "create a bug for ...".' }];
    }
    const routed = route(text, this.deps.connections);
    if ('ask' in routed) return this.askWhichTool(text, understanding, routed.ask);
    return this.startFlow(text, routed.connection, understanding);
  }

  /** A ticket goes to a ticket tool, never to Microsoft 365. */
  private async toTicketTool(request: string, understanding: Understanding, source?: SourceContent): Promise<CoreToUi[]> {
    const tools = this.deps.connections.filter((c) => c.connector.manifest.type !== 'ms365');
    if (!tools.length) return [{ type: 'info', text: 'No ticket tool is connected.' }];
    const routed = route(request, tools);
    if ('ask' in routed) return this.askWhichTool(request, understanding, routed.ask, source);
    return this.startFlow(request, routed.connection, understanding, source);
  }

  private askWhichTool(request: string, understanding: Understanding, candidates: Candidate[], source?: SourceContent): CoreToUi[] {
    this.state = { kind: 'tool', request, understanding, candidates, source };
    return [this.pickQuestion('tool', '__tool', 'Which tool should this go to?', candidates)];
  }

  private pickQuestion(id: string, field: string, text: string, choices: Candidate[]): CoreToUi {
    return { type: 'question', question: { id, source: 1, blocking: true, field, text, choices, allowFreeText: true } };
  }

  /** "Make a ticket from Priya's email": list the matching emails or chats to pick from. */
  private async askSource(request: string, from: SourceRequest): Promise<CoreToUi[]> {
    const conn = this.m365();
    const noun = from.kind === 'email' ? 'emails' : 'chats';
    if (!conn) return [{ type: 'info', text: `Connect Microsoft 365 to make tickets from ${noun}.` }];
    if (!this.m365Actions().includes(from.kind)) return [{ type: 'info', text: 'Teams chats need a work or school account.' }];
    const candidates = (await conn.connector.lookup(from.kind, from.query)).slice(0, 8);
    if (!candidates.length) return [{ type: 'info', text: `No ${noun} match "${from.query}". Try other words.` }];
    this.state = { kind: 'source', request, from: from.kind, conn, candidates };
    return [this.pickQuestion('source', '__source', from.kind === 'email' ? 'Which email?' : 'Which chat?', candidates)];
  }

  /** Read the picked email or chat, draft a ticket from it, and continue to the ticket tool. */
  private async fromSource(request: string, conn: Connection, kind: SourceRequest['kind'], id: string): Promise<CoreToUi[]> {
    const content = await conn.connector.read!(kind, id);
    this.lastSource = content;
    const out: CoreToUi[] = [];
    const advice = await this.consult(`Draft a ticket from this ${kind}.`, content);
    let proposal: TicketProposal;
    if (advice?.intent === 'ticket' && advice.ticket) {
      out.push({ type: 'assistant', text: advice.reply, reasoning: advice.reasoning, suggestions: advice.suggestions });
      proposal = advice.ticket;
    } else {
      // No model (or it failed): the subject becomes the title and the text the description.
      proposal = { summary: content.title.slice(0, 80), description: content.text.slice(0, 1500) };
    }
    const origin = `${kind === 'email' ? 'Email' : 'Teams chat'} from ${content.from}${content.link ? `: ${content.link}` : ''}`;
    proposal = { ...proposal, description: `${proposal.description ? `${proposal.description}\n\n` : ''}Source: ${origin}` };
    return [...out, ...(await this.toTicketTool(request, toUnderstanding(proposal, request), content))];
  }

  private async startFlow(request: string, conn: Connection, understanding: Understanding, source?: SourceContent): Promise<CoreToUi[]> {
    if (conn.connector.manifest.type === 'ms365') this.aimAtSource(understanding);
    const qn = new Questionnaire(conn, understanding, this.deps.profile ?? 'guided', this.deps.prefs ?? {});
    this.state = { kind: 'asking', request, conn, qn, source };
    return [{ type: 'info', text: `Using ${conn.name}.` }, ...(await this.advance())];
  }

  /** "Reply to them" or "tell the chat" means the email or chat the last ticket came from. */
  private aimAtSource(u: Understanding) {
    const src = this.lastSource;
    const kind = u.fields.action?.value;
    if (!src) return;
    if (kind === 'reply' && src.kind === 'email' && !u.fields.email) u.fields.email = { value: src.id, confidence: 0.9 };
    if (kind === 'chat' && src.kind === 'chat') {
      const named = u.fields.chat?.value.toLowerCase();
      const title = src.title.toLowerCase();
      if (!named || title.includes(named) || named.includes(title)) u.fields.chat = { value: src.id, confidence: 0.9 };
    }
  }

  private async advance(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'asking') return [];
    const next = await s.qn.next();
    const out: CoreToUi[] = [this.draftMessage(s.conn, s.qn)];
    if (next === 'done') return [...out, ...(await this.toCard(s.request, s.conn, s.qn, await s.qn.unresolved(), s.source))];
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
    if (s.kind === 'tool' || s.kind === 'source') {
      const chosen =
        s.candidates.find((c) => c.id === msg.choiceId) ??
        (() => {
          const m = matchAnswer(msg.text ?? '', s.candidates);
          return m.kind === 'one' ? m.matches[0] : undefined;
        })();
      if (!chosen) return [{ type: 'info', text: s.kind === 'tool' ? 'Please pick one of the listed tools.' : 'Please pick one of the listed items.' }];
      if (s.kind === 'source') return this.fromSource(s.request, s.conn, s.from, chosen.id);
      const conn = this.deps.connections.find((c) => c.id === chosen.id)!;
      return this.startFlow(s.request, conn, s.understanding, s.source);
    }
    if (s.kind !== 'asking') return [{ type: 'info', text: 'Start with a request, e.g. "create a bug for the login page crashing".' }];
    await s.qn.answer(msg);
    return this.advance();
  }

  private async stop(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'asking') return [{ type: 'info', text: 'Nothing to stop.' }];
    const { unresolvedRequired } = await s.qn.stop();
    return [this.draftMessage(s.conn, s.qn), ...(await this.toCard(s.request, s.conn, s.qn, unresolvedRequired, s.source))];
  }

  private async toCard(request: string, conn: Connection, qn: Questionnaire, unresolved: string[], source?: SourceContent): Promise<CoreToUi[]> {
    const schema = await qn.schema();
    const plan = buildPlan(conn, qn.fields, schema);
    this.state = { kind: 'confirming', request, conn, qn, plan, unresolved, source };
    const ready = unresolved.length === 0 && plan.errors.length === 0 && !conn.readOnly;
    if (ready && !conn.connector.manifest.confirmAlways && this.deps.autoCreate?.()) {
      const summary = plan.card.rows.map((r) => `${r.title}: ${r.value}`).join(' · ');
      return [{ type: 'info', text: `Creating on ${conn.name}: ${summary}` }, ...(await this.confirm())];
    }
    const titles = unresolved.map((k) => String(schema.properties?.[k]?.title ?? k));
    return [
      {
        type: 'card',
        card: plan.card,
        canConfirm: ready,
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
    if (!result.ok) return [{ type: 'result', ok: false, text: result.error }];
    const ticket = s.conn.connector.manifest.type !== 'ms365';
    return [
      {
        type: 'result',
        ok: true,
        text: result.stamp ? result.id : `Created ${result.id}`,
        url: result.url || undefined,
        stamp: result.stamp,
        linkText: result.linkText,
        suggestions: ticket ? this.followUps(result.id, s.source) : [],
      },
    ];
  }

  /**
   * After a ticket: tell the reporter and the team. Each one is a new request with its own card, since
   * messages can't be unsent. ponytail: not the spec's "one plan, confirmed once"; add multi-step plans when asked.
   */
  private followUps(key: string, source?: SourceContent): string[] {
    const acts = this.m365Actions();
    const out: string[] = [];
    if (source?.kind === 'email' && acts.includes('reply')) out.push(`Reply to ${source.from} that it's logged as ${key}`);
    if (source?.kind === 'chat' && acts.includes('chat')) out.push(`Tell the ${source.title} chat it's logged as ${key}`);
    if (acts.includes('channel')) out.push(`Post ${key} in a Teams channel`);
    if (acts.includes('email')) out.push(`Email someone about ${key}`);
    if (acts.includes('task')) out.push(`Remind me to follow up on ${key} on Friday`);
    return out.slice(0, 3);
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
    this.state = { kind: 'asking', request: s.request, conn: s.conn, qn: s.qn, source: s.source };
    return [{ type: 'question', question }];
  }
}
