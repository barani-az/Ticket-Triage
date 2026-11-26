import {
  actionUnderstanding,
  type Advice,
  advise,
  type AdvisorContext,
  type DraftContext,
  type SourceRequest,
  type TicketProposal,
  toUnderstanding,
  type Turn,
} from './advisor.js';
import type { Connection, SourceContent } from './connectors/contract.js';
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
  /** Sent by the window right after a sign-in card: resolves when the user has finished signing in. */
  | { type: 'wait' }
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
  | { type: 'result'; ok: boolean; text: string; url?: string; stamp?: string; linkText?: string; suggestions?: string[] }
  | { type: 'signin'; tool: ConnectTool; service: string; how: 'browser' | 'code'; text: string; url?: string; code?: string; alt?: Candidate }
  | { type: 'error'; message: string };

/** The tools /connect can sign in to. */
export type ConnectTool = 'm365' | 'jira';

export interface ToolStatus {
  tool: ConnectTool;
  connected: boolean;
  /** e.g. "connected as priya@contoso.com", "not connected", "needs sign-in again". */
  detail: string;
}

/** How a sign-in goes on: the service's page opens in the browser, or the user enters a code there. `ready`: already signed in. */
export type SignInStart = { how: 'browser'; url?: string } | { how: 'code'; url: string; code: string } | { how: 'ready' };

/** Signing in is the app's job (it opens browsers and starts servers); the session only drives the conversation. */
export interface ConnectHooks {
  status(): Promise<ToolStatus[]>;
  start(tool: ConnectTool, opts: { work?: boolean; deviceCode?: boolean }): Promise<SignInStart>;
  /** Resolves with who is now connected, once the user has finished signing in. */
  finish(tool: ConnectTool): Promise<string>;
  cancel(tool: ConnectTool): void;
  /** Disconnect and forget the sign-in. */
  signOut(tool: ConnectTool): Promise<void>;
  /** Whether a browser sign-in is possible (default yes). Microsoft 365 needs our own app registration for it. */
  canUseBrowser?(tool: ConnectTool): boolean;
}

const SERVICE: Record<ConnectTool, { name: string; owner: string }> = {
  m365: { name: 'Microsoft 365', owner: 'Microsoft' },
  jira: { name: 'Jira Cloud', owner: 'Atlassian' },
};

/** Sign-in errors in plain words. The raw codes (AADSTS…) mean nothing to most people. */
export function signInError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/AADSTS(65001|90094|90095)|admin (approval|consent)|need(s)? admin/i.test(m)) {
    return 'Your organisation needs an admin to approve this app before you can connect. Ask IT to approve it (the request is in docs/decisions.md), then try again.';
  }
  if (/AADSTS(50020|700016|50194)/i.test(m)) return "This account can't sign in to this app. Try the other account type, or ask IT for the company's own app registration.";
  if (/access_denied|declined|denied/i.test(m)) return 'Access was not approved, so nothing was connected.';
  if (/cancel/i.test(m)) return 'Sign-in was cancelled. Nothing was connected.';
  if (/timed? ?out|expired/i.test(m)) return 'Sign-in timed out. Run /connect to try again.';
  return `Could not connect: ${m}`;
}

type State =
  | { kind: 'idle' }
  | { kind: 'tool'; request: string; understanding: Understanding; candidates: Candidate[]; source?: SourceContent }
  | { kind: 'source'; request: string; from: SourceRequest['kind']; conn: Connection; candidates: Candidate[] }
  | { kind: 'asking'; request: string; conn: Connection; qn: Questionnaire; source?: SourceContent }
  | { kind: 'confirming'; request: string; conn: Connection; qn: Questionnaire; plan: Plan; unresolved: string[]; source?: SourceContent }
  | { kind: 'connect'; step: 'tool' | 'account' | 'retry' | 'manage'; tool?: ConnectTool; work?: boolean; choices: Candidate[]; connected?: ConnectTool[] }
  | { kind: 'signing-in'; tool: ConnectTool; work?: boolean; how: 'browser' | 'code' };

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
  /** Sign-in for /connect. Without it, /connect says it is not available. */
  connect?: ConnectHooks;
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
  private lastQuestion?: Question;
  private lastCard?: CoreToUi;
  /** True while a draft came out of a conversation: then it is never created without the user saying so. */
  private conversational = false;

  constructor(private deps: SessionDeps) {}

  private get reasoning() {
    return Boolean(this.deps.llm) && this.deps.advisor !== false;
  }

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
  private async consult(text: string, images?: string[], draft?: DraftContext, source?: SourceContent): Promise<Advice | undefined> {
    if (!this.deps.llm || this.deps.advisor === false) return undefined;
    const advice = await advise(this.history, text, await this.context(), this.deps.llm, images, draft, source);
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
          if (this.state.kind === 'signing-in') this.deps.connect?.cancel(this.state.tool);
          this.state = { kind: 'idle' };
          this.conversational = false;
          return [{ type: 'info', text: 'Cancelled. Nothing was changed.' }];
        case 'wait':
          return await this.finishSignIn();
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
    // Commands are handled here and never reach the LLM.
    const command = text.trim().match(/^\/(\w+)/)?.[1]?.toLowerCase();
    if (command) return command === 'connect' ? this.connectMenu() : [{ type: 'info', text: `Unknown command /${command}. Try /connect.` }];
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
      if (advice.intent === 'action' && advice.action) {
        const conn = this.m365();
        if (!conn) return [said, { type: 'info', text: 'Microsoft 365 is not connected. Type /connect to connect it.' }];
        this.conversational = true;
        const proposed = actionUnderstanding(advice.action);
        // Changing a message being drafted keeps what was settled, like a ticket draft.
        if (live && live.conn === conn) return [said, ...(await this.startFlow(live.request, conn, this.revise(live.qn.fields, proposed, text)))];
        return [said, ...(await this.startFlow(text, conn, proposed))];
      }
      if (advice.intent === 'ticket' && advice.from) return [said, ...(await this.askSource(text, advice.from))];
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
      return [said, ...(await this.toTicketTool(text, proposed))];
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
    const advice = await this.consult(`Draft a ticket from this ${kind}.`, undefined, undefined, content);
    let proposal: TicketProposal;
    if (advice?.intent === 'ticket' && advice.ticket) {
      this.conversational = true;
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

  /** `source` defaults to the open draft's, so revising a ticket made from an email keeps its link to that email. */
  private async startFlow(
    request: string,
    conn: Connection,
    understanding: Understanding,
    source = this.state.kind === 'asking' || this.state.kind === 'confirming' ? this.state.source : undefined,
  ): Promise<CoreToUi[]> {
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
    if (s.kind === 'signing-in') {
      // "Use a code instead" on the browser sign-in card.
      if (s.tool === 'm365' && msg.choiceId === 'code') {
        this.deps.connect?.cancel('m365');
        return this.beginSignIn('m365', { work: s.work, deviceCode: true });
      }
      return [{ type: 'info', text: 'Finish signing in first, or press Cancel.' }];
    }
    if (s.kind === 'connect') {
      const m = matchAnswer(msg.text ?? '', s.choices);
      const chosen = s.choices.find((c) => c.id === msg.choiceId) ?? (m.kind === 'one' ? m.matches[0] : undefined);
      if (!chosen) return [{ type: 'info', text: 'Please pick one of the listed options.' }];
      return this.onConnectChoice(s, chosen.id);
    }
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
    return [this.draftMessage(s.conn, s.qn), ...(await this.toCard(s.request, s.conn, s.qn, unresolvedRequired, s.source))];
  }

  private async toCard(request: string, conn: Connection, qn: Questionnaire, unresolved: string[], source?: SourceContent): Promise<CoreToUi[]> {
    const schema = await qn.schema();
    const plan = buildPlan(conn, qn.fields, schema);
    this.state = { kind: 'confirming', request, conn, qn, plan, unresolved, source };
    const ready = unresolved.length === 0 && plan.errors.length === 0 && !conn.readOnly;
    if (ready && !this.conversational && !conn.connector.manifest.confirmAlways && this.deps.autoCreate?.()) {
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
    if (!result.ok) return [{ type: 'result', ok: false, text: result.error }];
    const ticket = s.conn.connector.manifest.type !== 'ms365';
    // Remember what was made, so "add a comment to that one" has something to refer to.
    if (result.ok) this.history.push({ role: 'assistant', text: `Created ${result.id}: ${s.plan.step.params.summary ?? ''}` });
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

  /** /connect: which tool, with each one's live status. */
  private async connectMenu(): Promise<CoreToUi[]> {
    const hooks = this.deps.connect;
    if (!hooks) return [{ type: 'info', text: 'Connecting tools is not available here.' }];
    const status = await hooks.status();
    const detail = (t: ConnectTool) => status.find((x) => x.tool === t)?.detail ?? 'not connected';
    const choices: Candidate[] = [
      { id: 'm365', label: SERVICE.m365.name, detail: detail('m365') },
      { id: 'jira', label: SERVICE.jira.name, detail: detail('jira') },
      { id: 'other', label: 'Other connectors', detail: 'coming later' },
    ];
    this.state = { kind: 'connect', step: 'tool', choices, connected: status.filter((x) => x.connected).map((x) => x.tool) };
    return [this.pickQuestion('connect', '__connect', 'Connect which tool?', choices)];
  }

  private async onConnectChoice(s: Extract<State, { kind: 'connect' }>, id: string): Promise<CoreToUi[]> {
    if (s.step === 'tool') {
      if (id === 'other') {
        this.state = { kind: 'idle' };
        return [{ type: 'info', text: 'Other connectors are coming in a later version.' }];
      }
      const tool = id as ConnectTool;
      if (s.connected?.includes(tool)) {
        const choices: Candidate[] = [
          { id: 'again', label: 'Sign in again', detail: 'for example with another account' },
          { id: 'signout', label: 'Sign out', detail: 'disconnect and forget the sign-in' },
          { id: 'keep', label: 'Keep it as it is' },
        ];
        this.state = { kind: 'connect', step: 'manage', tool, choices };
        const detail = s.choices.find((c) => c.id === tool)?.detail ?? 'connected';
        return [this.pickQuestion('manage', '__connect', `${SERVICE[tool].name} is ${detail}. What would you like to do?`, choices)];
      }
      return tool === 'm365' ? this.askAccount() : this.beginSignIn('jira', {});
    }
    if (s.step === 'account') return this.beginSignIn('m365', { work: id === 'work' });
    if (s.step === 'manage') {
      const tool = s.tool!;
      if (id === 'keep') {
        this.state = { kind: 'idle' };
        return [{ type: 'info', text: 'Nothing changed.' }];
      }
      await this.deps.connect!.signOut(tool);
      this.projects = undefined;
      if (id === 'again') return tool === 'm365' ? this.askAccount() : this.beginSignIn('jira', {});
      this.state = { kind: 'idle' };
      return [{ type: 'result', ok: true, stamp: 'Signed out', text: `of ${SERVICE[tool].name}` }];
    }
    // step 'retry', after a failed sign-in
    if (id === 'code' || id === 'browser') return this.beginSignIn(s.tool!, { work: s.work, deviceCode: id === 'code' });
    this.state = { kind: 'idle' };
    return [{ type: 'info', text: 'Cancelled. Nothing was changed.' }];
  }

  private askAccount(): CoreToUi[] {
    const choices: Candidate[] = [
      { id: 'work', label: 'Work or school account', detail: 'Outlook, calendar, To Do and Teams' },
      { id: 'personal', label: 'Personal account', detail: 'Outlook.com or Hotmail, no Teams' },
    ];
    this.state = { kind: 'connect', step: 'account', choices };
    return [this.pickQuestion('account', '__connect', 'Which kind of Microsoft account?', choices)];
  }

  private async beginSignIn(tool: ConnectTool, opts: { work?: boolean; deviceCode?: boolean }): Promise<CoreToUi[]> {
    let start: SignInStart;
    try {
      start = await this.deps.connect!.start(tool, opts);
    } catch (e) {
      this.state = { kind: 'idle' };
      return [{ type: 'result', ok: false, text: signInError(e) }];
    }
    this.state = { kind: 'signing-in', tool, work: opts.work, how: start.how === 'code' ? 'code' : 'browser' };
    if (start.how === 'ready') return this.finishSignIn();
    const { name, owner } = SERVICE[tool];
    const text =
      start.how === 'code'
        ? `Enter this code on ${owner}'s sign-in page. This window updates when you're done.`
        : `Your browser is opening ${owner}'s sign-in page. Sign in and approve access there; this window updates when you're done.`;
    // If the browser sign-in doesn't work out (a blocked redirect, no browser), a code is the way in.
    const alt = tool === 'm365' && start.how === 'browser' ? { id: 'code', label: 'Use a code instead' } : undefined;
    return [{ type: 'signin', tool, service: name, how: start.how, text, url: start.url, ...(start.how === 'code' ? { code: start.code } : {}), ...(alt ? { alt } : {}) }];
  }

  private async finishSignIn(): Promise<CoreToUi[]> {
    const s = this.state;
    if (s.kind !== 'signing-in') return [];
    try {
      const who = await this.deps.connect!.finish(s.tool);
      if (this.state !== s) return []; // cancelled meanwhile
      this.state = { kind: 'idle' };
      this.projects = undefined; // a new connection brings new projects
      return [{ type: 'result', ok: true, stamp: 'Connected', text: who }];
    } catch (e) {
      if (this.state !== s) return [];
      const failed: CoreToUi = { type: 'result', ok: false, text: signInError(e) };
      if (/cancel/i.test(String((e as Error)?.message))) {
        this.state = { kind: 'idle' };
        return [failed];
      }
      // Offer another way in: a code works when the browser sign-in can't (Microsoft 365 only).
      const cancel = { id: 'cancel', label: 'Cancel' };
      const browser = this.deps.connect!.canUseBrowser?.(s.tool) ?? true;
      const choices: Candidate[] =
        s.tool !== 'm365'
          ? [{ id: 'browser', label: 'Try again' }, cancel]
          : s.how === 'code'
            ? [{ id: 'code', label: 'Get a new code' }, ...(browser ? [{ id: 'browser', label: 'Use the browser instead' }] : []), cancel]
            : [{ id: 'code', label: 'Sign in with a code instead' }, { id: 'browser', label: 'Try the browser again' }, cancel];
      this.state = { kind: 'connect', step: 'retry', tool: s.tool, work: s.work, choices };
      return [failed, this.pickQuestion('retry', '__connect', 'Try again?', choices)];
    }
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
