import { type Advice, advise, type AdvisorContext, type DraftContext, toUnderstanding, type Turn } from './advisor.js';
import type { Connection } from './connectors/contract.js';
import { type AuditLog, buildPlan, executePlan, type Plan } from './executor.js';
import type { LlmGateway } from './llm.js';
import { matchAnswer } from './matcher.js';
import { Questionnaire, type Profile } from './questionnaire.js';
import { route } from './router.js';
import type { Candidate, ConfirmationCard, Fields, Question, Understanding } from './types.js';
import { understand } from './understand.js';

export type UiToCore =
  | { type: 'submit'; text: string; images?: string[] }
  | { type: 'answer'; choiceId?: string; text?: string }
  | { type: 'stop' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'fallback'; option: 'answer-one' | 'save-draft' }
  /** Start a fresh conversation: forget the draft and what was said. */
  | { type: 'new' };

// Words that confirm or drop a draft. Matched by rule, never by the model, so the AI cannot trigger a write.
const YES = /^\s*(yes( please)?|yep|yeah|ok(ay)?|sure|create( it| the ticket)?|confirm|go ahead|do it|submit|looks good|lgtm)[\s.!]*$/i;
const CANCEL = /^\s*(cancel( it)?|discard( it)?|never ?mind|drop it|forget it|don'?t create( it)?)[\s.!]*$/i;
const NO = /^\s*(no|nope)[\s.!]*$/i;
// Small talk is answered here at once: no model call, no waiting, nothing sent anywhere.
const GREETING = /^\s*(hi|hii+|hello|hey|yo|good (morning|afternoon|evening))( there)?[\s.!]*$/i;
const THANKS = /^\s*(thanks|thank you|thx|ty)( so much| a lot)?[\s.!]*$/i;

export type CoreToUi =
  | { type: 'info'; text: string }
  /** `action: 'screenshot'` means the assistant is asking permission to look at the user's screen. */
  | { type: 'assistant'; text: string; reasoning?: string; suggestions?: string[]; action?: 'screenshot' }
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
  private lastQuestion?: Question;
  private lastCard?: CoreToUi;
  /** True while a draft came out of a conversation: then it is never created without the user saying so. */
  private conversational = false;

  constructor(private deps: SessionDeps) {}

  private get reasoning() {
    return Boolean(this.deps.llm) && this.deps.advisor !== false;
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
      .list(5)
      .filter((a) => a.result.ok)
      .map((a) => `${(a.result as { id: string }).id} ${a.step.params.summary ?? ''}`.trim());
    return { today: new Date().toISOString().slice(0, 10), connections: this.deps.connections.map((c) => c.name), projects: this.projects.list, recent };
  }

  /** Ask the reasoning layer. Returns undefined when there is no LLM or it fails, so the plain flow takes over. */
  private async consult(text: string, images?: string[], draft?: DraftContext): Promise<Advice | undefined> {
    if (!this.deps.llm || this.deps.advisor === false) return undefined;
    const advice = await advise(this.history, text, await this.context(), this.deps.llm, images, draft);
    if (advice) {
      // Images are not kept in the history (too big); a marker tells the model one was sent.
      this.history.push({ role: 'user', text: images?.length ? `${text} [screenshot attached]` : text }, { role: 'assistant', text: advice.reply });
      this.history = this.history.slice(-10);
    }
    return advice;
  }

  async handle(msg: UiToCore): Promise<CoreToUi[]> {
    try {
      switch (msg.type) {
        case 'submit':
          return await this.submit(msg.text, msg.images);
        case 'answer':
          return await this.answer(msg);
        case 'stop':
          return await this.stop();
        case 'confirm':
          return await this.confirm();
        case 'cancel':
          this.state = { kind: 'idle' };
          this.conversational = false;
          return [{ type: 'info', text: 'Cancelled. Nothing was changed.' }];
        case 'fallback':
          return await this.fallback(msg.option);
        case 'new':
          this.state = { kind: 'idle' };
          this.history = [];
          this.conversational = false;
          return [];
      }
    } catch (e) {
      return [{ type: 'error', message: (e as Error).message }];
    }
  }

  /** The question or card that is still waiting, so it can be shown again under a chat reply. */
  private repeatPrompt(): CoreToUi[] {
    if (this.state.kind === 'asking' && this.lastQuestion) return [{ type: 'question', question: this.lastQuestion }];
    if (this.state.kind === 'confirming' && this.lastCard) return [this.lastCard];
    return [];
  }

  private drop(): CoreToUi[] {
    this.state = { kind: 'idle' };
    this.conversational = false;
    this.history.push({ role: 'assistant', text: 'The draft was discarded. Nothing was created.' });
    return [{ type: 'assistant', text: 'Okay, I dropped that draft. Nothing was created.' }];
  }

  /** A change to a draft keeps everything already settled and applies only what the model returned. */
  private revise(fields: Fields, proposed: Understanding, said: string): Understanding {
    const merged: Understanding['fields'] = {};
    for (const [key, v] of Object.entries(fields)) merged[key] = { value: v.label, confidence: 0.95 };
    for (const [key, hint] of Object.entries(proposed.fields)) {
      // The project only moves when the user names a new one; the model re-guessing it does not.
      if (key === 'project' && merged.project && hint.confidence < 0.7) continue;
      merged[key] = hint;
    }
    return { operation: 'create', fields: merged };
  }

  private async submit(text: string, images?: string[]): Promise<CoreToUi[]> {
    const live = this.state.kind === 'asking' || this.state.kind === 'confirming' ? this.state : undefined;
    if (live && !images?.length) {
      if (CANCEL.test(text) || (live.kind === 'confirming' && NO.test(text))) return this.drop();
      if (live.kind === 'confirming' && YES.test(text)) return this.confirm();
    }
    if (!images?.length && (GREETING.test(text) || THANKS.test(text))) {
      const reply = THANKS.test(text) ? "You're welcome." : 'Hi. Tell me what you need: a problem, a task or a question.';
      return [{ type: 'assistant', text: reply }, ...this.repeatPrompt()];
    }
    const draft: DraftContext | undefined =
      live && this.reasoning
        ? {
            connection: live.conn.name,
            // People and components are never sent to the model (docs/decisions.md, decision 3). They are kept
            // in the draft by revise(), so the model does not need to see them to leave them unchanged.
            fields: Object.entries(live.qn.fields)
              .filter(([k]) => k !== 'assignee' && k !== 'components')
              .map(([k, v]) => `${k}: ${v.label}`),
            question: live.kind === 'asking' ? this.lastQuestion?.text : undefined,
          }
        : undefined;
    const advice = await this.consult(text, images, draft);
    if (advice) {
      const said: CoreToUi = {
        type: 'assistant',
        text: advice.reply,
        reasoning: advice.reasoning,
        suggestions: advice.suggestions,
        // Ask for permission only once: with an image already attached there is nothing more to capture.
        ...(advice.intent === 'screenshot' && !images?.length ? { action: 'screenshot' as const } : {}),
      };
      if (advice.intent !== 'ticket' || !advice.ticket) {
        // Chatting about a draft leaves it where it was.
        if (live) return [said, ...this.repeatPrompt()];
        this.state = { kind: 'idle' };
        return [said];
      }
      // A proposed ticket goes through the same checks as any request: routing, lookups, the questionnaire.
      this.conversational = true;
      const proposed = toUnderstanding(advice.ticket, text);
      if (live) return [said, ...(await this.startFlow(live.request, live.conn, this.revise(live.qn.fields, proposed, text)))];
      const routed = route(text, this.deps.connections);
      if ('ask' in routed) return [said, ...this.askWhichTool(text, proposed, routed.ask)];
      return [said, ...(await this.startFlow(text, routed.connection, proposed))];
    }
    if (live && this.reasoning) {
      return [
        { type: 'assistant', text: 'I could not work that out just now. Use the choices or buttons, or say "create it" or "cancel".' },
        ...this.repeatPrompt(),
      ];
    }
    this.conversational = false;
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
    this.lastQuestion = next;
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
    if (s.kind !== 'asking') {
      if (msg.text) return this.submit(msg.text);
      return [{ type: 'info', text: 'Start with a request, e.g. "create a bug for the login page crashing".' }];
    }
    const q = this.lastQuestion;
    if (msg.text && !msg.choiceId) {
      if (CANCEL.test(msg.text)) return this.drop();
      // "yes" to "I took X. Correct?" picks X; anything that is not one of the choices is conversation.
      if (q?.source === 6 && YES.test(msg.text) && q.choices[0]) {
        await s.qn.answer({ choiceId: q.choices[0].id });
        return this.advance();
      }
      if (this.reasoning && q && q.choices.length && matchAnswer(msg.text, q.choices).kind === 'none') return this.submit(msg.text);
    }
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
    if (ready && !this.conversational && this.deps.autoCreate?.()) {
      const summary = plan.card.rows.map((r) => `${r.title}: ${r.value}`).join(' · ');
      return [{ type: 'info', text: `Creating on ${conn.name}: ${summary}` }, ...(await this.confirm())];
    }
    const titles = unresolved.map((k) => String(schema.properties?.[k]?.title ?? k));
    this.lastCard = {
      type: 'card',
      card: plan.card,
      canConfirm: unresolved.length === 0 && plan.errors.length === 0 && !conn.readOnly,
      unresolved: titles,
      options: unresolved.length ? ['answer-one', 'save-draft'] : [],
      errors: plan.errors,
    };
    return [this.lastCard];
  }

  private async confirm(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'confirming') return [{ type: 'info', text: 'Nothing to confirm.' }];
    if (s.unresolved.length) return [{ type: 'error', message: 'Required values are missing, so this cannot be sent.' }];
    const result = await executePlan(s.conn, s.plan, s.request, this.deps.audit);
    this.state = { kind: 'idle' };
    this.conversational = false;
    // Remember what was made, so "add a comment to that one" has something to refer to.
    if (result.ok) this.history.push({ role: 'assistant', text: `Created ${result.id}: ${s.plan.step.params.summary ?? ''}` });
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
