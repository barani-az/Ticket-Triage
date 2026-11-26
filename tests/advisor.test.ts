import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAdvice, toUnderstanding } from '../src/core/advisor.js';
import type { Connection } from '../src/core/connectors/contract.js';
import { JiraConnector } from '../src/core/connectors/jira.js';
import { AuditLog } from '../src/core/executor.js';
import type { LlmCall, LlmGateway } from '../src/core/llm.js';
import { Session, type CoreToUi } from '../src/core/session.js';
import { startMockJira } from '../src/mock/jiraMock.js';

let mock: Awaited<ReturnType<typeof startMockJira>>;
let connections: Connection[];
let audit: AuditLog;

beforeAll(async () => {
  mock = await startMockJira(0);
  connections = [{ id: 'jira', name: 'Company Jira', readOnly: false, connector: new JiraConnector({ baseUrl: mock.baseUrl, flavor: 'cloud', token: 't' }) }];
});
afterAll(() => mock.close());
beforeEach(() => {
  audit = new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-')), 'audit.jsonl'));
});

/** A gateway that returns scripted replies in order (the last one repeats), or throws an Error entry. */
const scripted = (replies: unknown[]) => {
  const calls: LlmCall[] = [];
  let i = 0;
  const gw: LlmGateway = {
    extractJson: async (o) => {
      calls.push(o);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { gw, calls };
};

const questionOf = (msgs: CoreToUi[]) => (msgs.find((m) => m.type === 'question') as Extract<CoreToUi, { type: 'question' }> | undefined)?.question;
const cardOf = (msgs: CoreToUi[]) => msgs.find((m) => m.type === 'card') as Extract<CoreToUi, { type: 'card' }> | undefined;
const assistantOf = (msgs: CoreToUi[]) => msgs.find((m) => m.type === 'assistant') as Extract<CoreToUi, { type: 'assistant' }> | undefined;

const BUG = {
  intent: 'ticket',
  reply: 'That sounds like a real bug that customers are hitting, so I drafted a ticket.',
  reasoning: 'Customers are blocked from logging in, so it is a high-priority bug.',
  suggestions: ['Assign it to the frontend team'],
  ticket: {
    issuetype: 'Bug',
    summary: 'Login page crashes on Safari',
    description: '## What happens\nThe login page crashes in Safari.\n\n## Impact\nCustomers cannot log in.',
    priority: 'High',
    project: 'WEB',
    components: 'Frontend',
  },
};

describe('parseAdvice', () => {
  it('accepts a well-formed answer and trims suggestions to three', () => {
    const a = parseAdvice({ intent: 'answer', reply: 'Use the self-service portal.', suggestions: ['a', 'b', 'c', 'd'] });
    expect(a).toMatchObject({ intent: 'answer', reply: 'Use the self-service portal.' });
    expect(a?.suggestions).toEqual(['a', 'b', 'c']);
  });
  it('tidies suggestions written as sentence continuations', () => {
    const a = parseAdvice({ intent: 'answer', reply: 'ok', suggestions: [', assign this to me', ' - change priority', ', '] });
    expect(a?.suggestions).toEqual(['Assign this to me', 'Change priority']);
  });

  it('rejects an unknown intent, a missing reply, and a ticket with no title', () => {
    expect(parseAdvice({ intent: 'dance', reply: 'x' })).toBeUndefined();
    expect(parseAdvice({ intent: 'answer' })).toBeUndefined();
    expect(parseAdvice({ intent: 'ticket', reply: 'x', ticket: {} })).toBeUndefined();
    expect(parseAdvice('nonsense')).toBeUndefined();
  });
  it('turns a proposal into hints, with inferred values at lower confidence than stated ones', () => {
    const u = toUnderstanding(BUG.ticket);
    expect(u.operation).toBe('create');
    expect(u.fields.summary.value).toBe('Login page crashes on Safari');
    expect(u.fields.priority.confidence).toBeLessThan(u.fields.summary.confidence);
  });
  it('treats a project the model picked as a guess, but one the user typed as stated', () => {
    expect(toUnderstanding(BUG.ticket).fields.project.confidence).toBeLessThan(0.7);
    expect(toUnderstanding(BUG.ticket, 'login crashes on safari, project unknown').fields.project.confidence).toBeLessThan(0.7);
    expect(toUnderstanding(BUG.ticket, 'create a bug in WEB for the login crash').fields.project.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe('session with the reasoning layer', () => {
  it('thinks about a problem, explains why, and drafts a complete ticket that creates after confirmation', async () => {
    const { gw, calls } = scripted([BUG]);
    const session = new Session({ connections, audit, llm: gw });
    let msgs = await session.handle({ type: 'submit', text: 'our login page keeps crashing on safari and customers are complaining' });
    expect(assistantOf(msgs)).toMatchObject({ reasoning: expect.stringContaining('high-priority bug'), suggestions: ['Assign it to the frontend team'] });
    // The model picked the project itself, so the app confirms it instead of accepting it silently.
    expect(questionOf(msgs)).toMatchObject({ source: 6, field: 'project' });
    msgs = await session.handle({ type: 'answer', choiceId: 'WEB' });
    const card = cardOf(msgs)!;
    expect(card.canConfirm).toBe(true);
    expect(card.card.rows.map((r) => r.field)).toEqual(['project', 'issuetype', 'summary', 'description', 'priority', 'components']);
    expect(calls[0].effort).toBe('medium'); // it asks the model to think
    msgs = await session.handle({ type: 'confirm' });
    expect(msgs[0]).toMatchObject({ type: 'result', ok: true });
    expect(mock.issues.at(-1)?.fields.description).toContain('Customers cannot log in.');
  });

  it('answers a question without creating anything', async () => {
    const { gw } = scripted([{ intent: 'answer', reply: 'Use the self-service portal to reset it.', suggestions: [] }]);
    const session = new Session({ connections, audit, llm: gw, autoCreate: () => true });
    const before = mock.issues.length;
    const msgs = await session.handle({ type: 'submit', text: 'how do I reset my vpn password' });
    expect(msgs).toHaveLength(1);
    expect(assistantOf(msgs)?.text).toContain('self-service portal');
    expect(mock.issues.length).toBe(before);
    expect(audit.list()).toHaveLength(0);
  });

  it('asks one clarifying question and remembers the conversation for the follow-up', async () => {
    const { gw, calls } = scripted([
      { intent: 'clarify', reply: 'Which page is broken, and what do you see?', suggestions: [] },
      { intent: 'answer', reply: 'Thanks, noted.', suggestions: [] },
    ]);
    const session = new Session({ connections, audit, llm: gw });
    const first = await session.handle({ type: 'submit', text: 'something is wrong with checkout' });
    expect(assistantOf(first)?.text).toBe('Which page is broken, and what do you see?');
    expect(cardOf(first)).toBeUndefined();
    await session.handle({ type: 'submit', text: 'the pay button does nothing' });
    expect(calls[1].user).toContain('Assistant: Which page is broken, and what do you see?');
    expect(calls[1].user).toContain('User: something is wrong with checkout');
  });

  it("still validates against the tool's data: an invented priority becomes a question, not a ticket", async () => {
    const { gw } = scripted([{ ...BUG, ticket: { ...BUG.ticket, priority: 'Urgent' } }]);
    const session = new Session({ connections, audit, llm: gw, autoCreate: () => true });
    const before = mock.issues.length;
    let msgs = await session.handle({ type: 'submit', text: 'login crashes on safari' });
    expect(questionOf(msgs)).toMatchObject({ source: 6, field: 'project' }); // the guessed project is confirmed first
    msgs = await session.handle({ type: 'answer', choiceId: 'WEB' });
    expect(questionOf(msgs)).toMatchObject({ source: 5, field: 'priority' });
    expect(mock.issues.length).toBe(before);
  });

  it('never auto-creates a draft that came out of a conversation: it waits to be told', async () => {
    const { gw } = scripted([BUG]);
    const session = new Session({ connections, audit, llm: gw, autoCreate: () => true });
    let msgs = await session.handle({ type: 'submit', text: 'login crashes on safari for customers' });
    msgs = await session.handle({ type: 'answer', choiceId: 'WEB' });
    expect(msgs.find((m) => m.type === 'result')).toBeUndefined();
    expect(cardOf(msgs)?.canConfirm).toBe(true);
    msgs = await session.handle({ type: 'submit', text: 'create it' });
    expect(msgs.find((m) => m.type === 'result')).toMatchObject({ ok: true, text: expect.stringMatching(/^Created WEB-/) });
  });

  it('does not ask "Correct?" about a project the user typed', async () => {
    const { gw } = scripted([BUG]);
    const session = new Session({ connections, audit, llm: gw });
    const msgs = await session.handle({ type: 'submit', text: 'create a bug in WEB: login page crashes on safari' });
    expect(questionOf(msgs)).toBeUndefined();
    expect(cardOf(msgs)?.canConfirm).toBe(true);
  });

  it('asks a plain question when the model names no project at all', async () => {
    const { gw } = scripted([{ ...BUG, ticket: { ...BUG.ticket, project: undefined } }]);
    const session = new Session({ connections, audit, llm: gw });
    const msgs = await session.handle({ type: 'submit', text: 'login crashes on safari' });
    expect(questionOf(msgs)).toMatchObject({ source: 3, field: 'project' }); // no guess to confirm: a plain missing-value question
  });

  it('falls back to the plain flow when the model fails or returns nonsense', async () => {
    for (const reply of [new Error('503 high demand'), { intent: 'nonsense' }]) {
      const { gw } = scripted([reply]);
      const session = new Session({ connections, audit, llm: gw });
      const msgs = await session.handle({ type: 'submit', text: 'Create a story in WEB for docs page' });
      expect(assistantOf(msgs)).toBeUndefined();
      expect(cardOf(msgs)?.canConfirm).toBe(true);
    }
  });

  it('is off when there is no LLM, or when switched off', async () => {
    const { gw, calls } = scripted([BUG]);
    const off = new Session({ connections, audit, llm: gw, advisor: false });
    await off.handle({ type: 'submit', text: 'Create a story in WEB for docs page' });
    expect(calls.every((c) => c.effort === undefined)).toBe(true); // only the plain extraction ran
    const none = new Session({ connections, audit });
    expect(assistantOf(await none.handle({ type: 'submit', text: 'Create a story in WEB for docs page' }))).toBeUndefined();
  });

  it('gives the model the real projects, so it can pick one instead of inventing it', async () => {
    const { gw, calls } = scripted([{ intent: 'answer', reply: 'ok', suggestions: [] }]);
    const session = new Session({ connections, audit, llm: gw });
    await session.handle({ type: 'submit', text: 'what can you do' });
    expect(calls[0].user).toContain('WEB: Website');
    expect(calls[0].user).toContain('APP: Mobile App');
  });
});

describe('screenshots', () => {
  const ASK = { intent: 'screenshot', reply: 'Can I take a screenshot of your screen to see the error?', suggestions: [] };
  const SHOT = 'data:image/jpeg;base64,/9j/4AAQ';

  it('asks permission instead of guessing when the user points at their screen, and creates nothing', async () => {
    const { gw } = scripted([ASK]);
    const session = new Session({ connections, audit, llm: gw, autoCreate: () => true });
    const before = mock.issues.length;
    const msgs = await session.handle({ type: 'submit', text: 'there is an error on this page' });
    expect(msgs).toHaveLength(1);
    expect(assistantOf(msgs)).toMatchObject({ action: 'screenshot', text: expect.stringContaining('screenshot') });
    expect(mock.issues.length).toBe(before);
  });

  it('reads the attached image, drafts from it, and does not ask for a screenshot again', async () => {
    const { gw, calls } = scripted([ASK, { ...BUG, ticket: { ...BUG.ticket, summary: 'Checkout returns 500 error ERR-7731' } }]);
    const session = new Session({ connections, audit, llm: gw });
    await session.handle({ type: 'submit', text: 'there is an error on this page' });
    const msgs = await session.handle({ type: 'submit', text: 'here it is', images: [SHOT] });
    expect(calls[1].images).toEqual([SHOT]);
    expect(calls[1].user).toContain('screenshot of the user');
    expect(assistantOf(msgs)?.action).toBeUndefined();
    expect(questionOf(msgs) ?? cardOf(msgs)).toBeDefined(); // it moved on to the normal flow
  });

  it('never asks twice: with an image already attached the permission action is dropped', async () => {
    const { gw } = scripted([ASK]);
    const session = new Session({ connections, audit, llm: gw });
    const msgs = await session.handle({ type: 'submit', text: 'see this', images: [SHOT] });
    expect(assistantOf(msgs)?.action).toBeUndefined();
  });

  it('keeps only a marker of the image in the conversation, never the image itself', async () => {
    const { gw, calls } = scripted([{ intent: 'answer', reply: 'That looks like a server error.', suggestions: [] }]);
    const session = new Session({ connections, audit, llm: gw });
    await session.handle({ type: 'submit', text: 'what is this', images: [SHOT] });
    await session.handle({ type: 'submit', text: 'and what should I do' });
    expect(calls[1].user).toContain('User: what is this [screenshot attached]');
    expect(calls[1].user).not.toContain(SHOT);
    expect(calls[1].images).toBeUndefined();
  });
});

describe('talking about a draft', () => {
  const NAMED = { ...BUG, ticket: { ...BUG.ticket, project: 'WEB' } };
  const open = async (replies: unknown[]) => {
    const s = scripted(replies);
    const session = new Session({ connections, audit, llm: s.gw });
    const first = await session.handle({ type: 'submit', text: 'bug in WEB: login crashes on safari' });
    expect(cardOf(first)?.canConfirm).toBe(true);
    return { session, calls: s.calls };
  };
  const row = (msgs: CoreToUi[], field: string) => cardOf(msgs)?.card.rows.find((r) => r.field === field)?.value;

  it('applies a requested change and keeps everything else', async () => {
    const { session, calls } = await open([NAMED, { ...BUG, reply: 'Raised it to Highest.', ticket: { summary: 'Login page crashes on Safari', priority: 'Highest' } }]);
    const msgs = await session.handle({ type: 'submit', text: 'make it highest' });
    expect(assistantOf(msgs)?.text).toBe('Raised it to Highest.');
    expect(row(msgs, 'priority')).toBe('Highest');
    expect(row(msgs, 'project')).toBe('Website');
    expect(row(msgs, 'components')).toBe('Frontend');
    expect(row(msgs, 'description')).toContain('Customers cannot log in.');
    expect(calls[1].user).toContain('Draft ticket being discussed (NOT created yet) on Company Jira');
    expect(calls[1].user).toContain('priority: High');
  });

  it('never shows the model the people or components in a draft', async () => {
    const { session, calls } = await open([NAMED, { intent: 'answer', reply: 'ok', suggestions: [] }]);
    await session.handle({ type: 'submit', text: 'why high?' });
    expect(calls[1].user).toContain('summary: Login page crashes on Safari');
    expect(calls[1].user).not.toContain('components:');
    expect(calls[1].user).not.toContain('Frontend');
    expect(calls[1].user).not.toContain('assignee:');
  });

  it('does not move the project just because the model guessed another one', async () => {
    const { session } = await open([NAMED, { ...BUG, ticket: { ...BUG.ticket, project: 'APP' } }]);
    const msgs = await session.handle({ type: 'submit', text: 'add that it started yesterday' });
    expect(row(msgs, 'project')).toBe('Website');
  });

  it('answers a side question and shows the draft again, unchanged', async () => {
    const { session } = await open([NAMED, { intent: 'answer', reply: 'High means customers are blocked.', suggestions: [] }]);
    const msgs = await session.handle({ type: 'submit', text: 'why high?' });
    expect(assistantOf(msgs)?.text).toContain('customers are blocked');
    expect(row(msgs, 'priority')).toBe('High');
  });

  it('creates on "create it" and drops on "cancel", by rule and without asking the model', async () => {
    const yes = await open([NAMED]);
    const created = await yes.session.handle({ type: 'submit', text: 'yes' });
    expect(created.find((m) => m.type === 'result')).toMatchObject({ ok: true });
    expect(yes.calls).toHaveLength(1);

    const no = await open([NAMED]);
    const before = mock.issues.length;
    const dropped = await no.session.handle({ type: 'submit', text: 'never mind' });
    expect(assistantOf(dropped)?.text).toContain('Nothing was created');
    expect(mock.issues.length).toBe(before);
    expect(no.calls).toHaveLength(1);
  });

  it('treats a reply that is not one of the choices as conversation', async () => {
    const noComponent = { ...BUG, ticket: { ...BUG.ticket, project: 'WEB', components: undefined } };
    const { gw, calls } = scripted([noComponent, { intent: 'answer', reply: 'A component is the part of the product it affects.', suggestions: [] }]);
    const session = new Session({ connections, audit, llm: gw });
    const first = await session.handle({ type: 'submit', text: 'bug in WEB: login crashes' });
    expect(questionOf(first)?.field).toBe('components');
    const msgs = await session.handle({ type: 'answer', text: 'what is a component?' });
    expect(assistantOf(msgs)?.text).toContain('part of the product');
    expect(questionOf(msgs)?.field).toBe('components'); // still waiting for it
    expect(calls[1].user).toContain('The app is asking the user: Which component?');
    const done = await session.handle({ type: 'answer', text: 'frontend' });
    expect(cardOf(done)?.canConfirm).toBe(true);
    expect(calls).toHaveLength(2); // a matching answer needs no model
  });

  it('forgets the conversation on "new"', async () => {
    const { session, calls } = await open([NAMED, { intent: 'answer', reply: 'ok', suggestions: [] }]);
    expect(await session.handle({ type: 'new' })).toEqual([]);
    await session.handle({ type: 'submit', text: 'what can you do' });
    expect(calls[1].user).not.toContain('Conversation so far');
    expect(calls[1].user).not.toContain('Draft ticket');
  });
});

describe('answering without delay', () => {
  it('replies to a greeting at once, without calling the model', async () => {
    const { gw, calls } = scripted([BUG]);
    const session = new Session({ connections, audit, llm: gw });
    const msgs = await session.handle({ type: 'submit', text: 'hi' });
    expect(assistantOf(msgs)?.text).toContain('Tell me what you need');
    expect(calls).toHaveLength(0);
  });

  it('does not repeat an overloaded round, but retries once if the request itself was rejected', async () => {
    const busy = scripted([new Error('LLM request failed: 503 high demand')]);
    await new Session({ connections, audit, llm: busy.gw }).handle({ type: 'submit', text: 'my vpn drops' });
    expect(busy.calls.filter((c) => c.system.includes('reasoning layer'))).toHaveLength(1);

    const picky = scripted([new Error('LLM request failed: 400 unknown field'), { intent: 'answer', reply: 'ok', suggestions: [] }]);
    const msgs = await new Session({ connections, audit, llm: picky.gw }).handle({ type: 'submit', text: 'my vpn drops' });
    expect(picky.calls).toHaveLength(2);
    expect(assistantOf(msgs)?.text).toBe('ok');
  });
});
