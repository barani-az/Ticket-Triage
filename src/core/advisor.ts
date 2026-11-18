import type { LlmGateway } from './llm.js';
import type { HintedField, Understanding } from './types.js';

/**
 * The reasoning layer. Gemini reads what the user said (plus the conversation so far and what the
 * connected tools contain), and decides: answer a question, ask ONE clarifying question, or propose
 * a ticket with its reasoning. It only proposes. Every ticket value is still matched against the
 * tool's own data by the questionnaire, so a wrong guess becomes a question, never a bad ticket.
 */

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AdvisorContext {
  today: string;
  /** Names of the connected tools, e.g. "Company Jira". */
  connections: string[];
  /** Real projects the user can create in, e.g. "KAN: My Software Team". */
  projects: string[];
  /** Tickets created recently, e.g. "KAN-7 Update the onboarding checklist". */
  recent: string[];
}

export interface TicketProposal {
  issuetype?: string;
  summary: string;
  description?: string;
  priority?: string;
  project?: string;
  components?: string;
  assignee?: string;
}

export interface Advice {
  intent: 'answer' | 'ticket' | 'clarify';
  /** What to say to the user: help, analysis or the one question. Short. */
  reply: string;
  /** Why this ticket, type and priority, in a sentence or two. */
  reasoning?: string;
  /** Follow-ups the user can click. */
  suggestions: string[];
  ticket?: TicketProposal;
}

const SYSTEM = `You are the reasoning layer of a small work assistant that sits behind a hotkey on the user's PC. The user types in plain language. Think about what they actually need, then respond.

Decide ONE intent:
- "answer": they ask a question or want help or advice. Answer it directly and usefully. Create nothing.
- "ticket": they describe specific work, a problem or a request that should be tracked. Propose a ticket.
- "clarify": a ticket is wanted but the message is too vague to write a useful one, meaning it does not say WHAT is broken or WHAT is needed (for example "something is wrong with checkout"). Ask exactly ONE short question that would make it specific, and propose no ticket.

When proposing a ticket:
- summary: a clear title, at most 80 characters, no trailing period.
- description: markdown. Include ONLY the sections you have real facts for, chosen from Context, What happens, Expected, Steps to reproduce, Impact. Leave a section out rather than writing "Unknown". Use only facts the user gave. Never invent versions, names, steps or numbers.
- issuetype: one of Bug, Task, Story, Epic.
- priority: one of Highest, High, Medium, Low, judged from real impact. Highest: security exposure, outage or data loss. High: users are blocked or revenue is affected. Medium: normal work, including a plain deadline. Low: minor or cosmetic. If nothing signals urgency, use Medium.
- project, components, assignee: set ONLY if the user named them, or exactly one project in the list below clearly fits. Use the exact project key. Otherwise leave them out and the app will ask.
- reasoning: one or two sentences on why this type and priority.

Style: plain and direct, no filler, no emoji, at most three short sentences. For a ticket, say what you concluded and why (the type and how urgent it is) and note that the draft is below. Do NOT ask whether to create it: the app shows the draft for the user to confirm. "suggestions" are up to three genuinely useful things the user might say next, such as adding detail or assigning someone. Never "Create" or "Cancel". An empty list is fine. If the conversation shows the user is following up, use what was said before.

Respond with JSON only, in this shape:
{"intent":"answer"|"ticket"|"clarify","reply":string,"reasoning":string?,"suggestions":string[],"ticket":{"issuetype":string?,"summary":string,"description":string?,"priority":string?,"project":string?,"components":string?,"assignee":string?}?}`;

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Check the model's JSON. Anything malformed is dropped rather than trusted. */
export function parseAdvice(raw: unknown): Advice | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return undefined;
  if (r.intent !== 'answer' && r.intent !== 'ticket' && r.intent !== 'clarify') return undefined;
  const reply = str(r.reply, 700);
  if (!reply) return undefined;
  const suggestions = Array.isArray(r.suggestions)
    ? (r.suggestions.map((s) => str(s, 90)).filter(Boolean) as string[]).slice(0, 3)
    : [];
  const advice: Advice = { intent: r.intent, reply, reasoning: str(r.reasoning, 400), suggestions };
  if (r.intent === 'ticket') {
    const t = (r.ticket ?? {}) as Record<string, unknown>;
    const summary = str(t.summary, 120);
    if (!summary) return undefined; // a ticket intent without a title is unusable
    advice.ticket = {
      summary,
      issuetype: str(t.issuetype, 20),
      description: str(t.description, 4000),
      priority: str(t.priority, 20), // an invalid one is caught later against the tool's own list
      project: str(t.project, 40),
      components: str(t.components, 60),
      assignee: str(t.assignee, 80),
    };
  }
  return advice;
}

function buildPrompt(history: Turn[], text: string, ctx: AdvisorContext): string {
  const lines: string[] = [];
  lines.push(`Today: ${ctx.today}`);
  lines.push(`Connected tools: ${ctx.connections.join(', ') || 'none'}`);
  lines.push(`Projects the user can create in:\n${ctx.projects.length ? ctx.projects.map((p) => `- ${p}`).join('\n') : '- (not available)'}`);
  if (ctx.recent.length) lines.push(`Tickets created recently:\n${ctx.recent.map((p) => `- ${p}`).join('\n')}`);
  if (history.length) lines.push(`Conversation so far:\n${history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n')}`);
  lines.push(`The user just said:\n${text}`);
  return lines.join('\n\n');
}

/** Ask Gemini what to do. Returns undefined when it fails, so the caller falls back to the plain flow. */
export async function advise(history: Turn[], text: string, ctx: AdvisorContext, llm: LlmGateway): Promise<Advice | undefined> {
  const user = buildPrompt(history, text, ctx);
  try {
    // Thinking takes longer than plain extraction, so this call gets its own, longer timeout.
    return parseAdvice(await llm.extractJson({ system: SYSTEM, user, effort: 'medium', timeoutMs: 25_000 }));
  } catch {
    try {
      // Some models reject the reasoning setting; one retry without it.
      return parseAdvice(await llm.extractJson({ system: SYSTEM, user, timeoutMs: 20_000 }));
    } catch {
      return undefined;
    }
  }
}

/** Turn a ticket proposal into the hints the questionnaire validates against the tool's own data. */
export function toUnderstanding(t: TicketProposal, said = ''): Understanding {
  const fields: Record<string, HintedField> = {};
  const put = (key: string, value: string | undefined, confidence: number) => {
    if (value) fields[key] = { value, confidence };
  };
  // A project the user typed (e.g. "in WEB") is stated; one the model picked on its own is a guess.
  const named = (v: string) => new RegExp(`\\b${v.replace(/[.*+?^${'$'}{}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(said);
  put('summary', t.summary, 0.85);
  put('description', t.description, 0.85);
  put('issuetype', t.issuetype, 0.85);
  put('priority', t.priority, 0.75);
  // A guessed project sits below the confirm threshold, so the guided profile asks "Correct?".
  put('project', t.project, t.project && named(t.project) ? 0.9 : 0.6);
  put('components', t.components, 0.75);
  put('assignee', t.assignee, 0.75);
  return { operation: 'create', fields };
}
