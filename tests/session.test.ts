import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/core/connectors/contract.js';
import { JiraConnector } from '../src/core/connectors/jira.js';
import { McpConnector } from '../src/core/connectors/mcp.js';
import { AuditLog } from '../src/core/executor.js';
import { matchAnswer } from '../src/core/matcher.js';
import { Session, type CoreToUi } from '../src/core/session.js';
import { understandWithRules } from '../src/core/understand.js';
import { createJiraMcpServer } from '../src/mcp/jiraServer.js';
import { startMockJira } from '../src/mock/jiraMock.js';

let mock: Awaited<ReturnType<typeof startMockJira>>;
let connections: Connection[];
let session: Session;
let audit: AuditLog;

const questionOf = (msgs: CoreToUi[]) =>
  (msgs.find((m) => m.type === 'question') as Extract<CoreToUi, { type: 'question' }>)?.question;
const cardOf = (msgs: CoreToUi[]) => msgs.find((m) => m.type === 'card') as Extract<CoreToUi, { type: 'card' }>;
const pick = (q: { choices: { id: string; label: string }[] }, label: string) =>
  q.choices.find((c) => c.label === label)!.id;

beforeAll(async () => {
  mock = await startMockJira(0);
  const jira = new JiraConnector({ baseUrl: mock.baseUrl, flavor: 'cloud', token: 't' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createJiraMcpServer(new JiraConnector({ baseUrl: mock.baseUrl, flavor: 'cloud', token: 't' })).connect(b);
  const client = new Client({ name: 'assistant', version: '0.0.1' });
  await client.connect(a);
  connections = [
    { id: 'jira', name: 'Company Jira', readOnly: false, connector: jira },
    { id: 'jira-mcp', name: 'Company Jira (MCP)', readOnly: false, connector: new McpConnector(client) },
  ];
});
afterAll(() => mock.close());
beforeEach(() => {
  audit = new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'audit.jsonl'));
  session = new Session({ connections, audit });
});

describe('matcher', () => {
  const people = [
    { id: 'a', label: 'Arjun Kumar' },
    { id: 'b', label: 'Arjun Rao' },
  ];
  it('reports several matches instead of picking one', () => {
    expect(matchAnswer('Arjun', people).kind).toBe('many');
  });
  it('matches an exact full name', () => {
    expect(matchAnswer('arjun rao', people)).toMatchObject({ kind: 'one', matches: [{ id: 'b' }] });
  });
  it('reports no match', () => {
    expect(matchAnswer('Mallory', people).kind).toBe('none');
  });
});

describe('understanding', () => {
  it('reads the example request from the spec', () => {
    const u = understandWithRules('Create a bug for the login page crashing on Safari, high priority, frontend team');
    expect(u.operation).toBe('create');
    expect(u.fields.issuetype.value).toBe('Bug');
    expect(u.fields.priority.value).toBe('High');
    expect(u.fields.components.value).toBe('Frontend');
    expect(u.fields.summary.value).toBe('Login page crashing on Safari');
  });
});

describe('session: Jira connector', () => {
  it('asks project first, then creates the bug after confirmation, with the full audit trail', async () => {
    let msgs = await session.handle({
      type: 'submit',
      text: 'Create a bug for the login page crashing on Safari, high priority, frontend team',
    });
    let q = questionOf(msgs);
    expect(q.field).toBe('project'); // type, priority, component and summary were understood and are looked up, not asked
    expect(q.choices.map((c) => c.id)).toEqual(['WEB', 'APP']);

    msgs = await session.handle({ type: 'answer', choiceId: 'WEB' });
    const card = cardOf(msgs);
    expect(card.canConfirm).toBe(true);
    expect(card.card.rows.map((r) => [r.field, r.value])).toEqual([
      ['project', 'Website'],
      ['issuetype', 'Bug'],
      ['summary', 'Login page crashing on Safari'],
      ['priority', 'High'],
      ['components', 'Frontend'],
    ]);

    msgs = await session.handle({ type: 'confirm' });
    expect(msgs[0]).toMatchObject({ type: 'result', ok: true, text: expect.stringMatching(/^Created WEB-\d+/) });
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0].result.ok).toBe(true);
  });

  it('asks a follow-up when a typed name matches several people (never picks one)', async () => {
    const q = questionOf(
      await session.handle({ type: 'submit', text: 'Create a story in WEB for dark mode, assign to Arjun' }),
    );
    expect(q).toMatchObject({ source: 4, field: 'assignee' });
    expect(q.choices.map((c) => c.label)).toEqual(['Arjun Kumar', 'Arjun Rao']);
    const card = cardOf(await session.handle({ type: 'answer', choiceId: pick(q, 'Arjun Rao') }));
    expect(card.card.rows.find((r) => r.field === 'assignee')?.value).toBe('Arjun Rao');
  });

  it('rejects an invalid priority with the real choices, not a guess', async () => {
    const msgs = await session.handle({ type: 'submit', text: 'Create a bug in WEB for checkout error, urgent, frontend team' });
    const q = questionOf(msgs);
    expect(q.source).toBe(5);
    expect(q.text).toContain("'Urgent' isn't a valid priority");
    expect(q.choices.map((c) => c.label)).toEqual(['Highest', 'High', 'Medium', 'Low']);
  });

  it('on Stop fills priority from the tool default, labelled assumed, and never invents the component', async () => {
    let msgs = await session.handle({ type: 'submit', text: 'Create a bug in WEB for checkout error' });
    expect(questionOf(msgs).field).toBe('priority'); // understood bits applied, next required field asked
    msgs = await session.handle({ type: 'stop' });
    const card = cardOf(msgs);
    expect(card.card.rows.find((r) => r.field === 'priority')).toMatchObject({ value: 'Medium', assumed: true });
    expect(card.canConfirm).toBe(false);
    expect(card.unresolved).toEqual(['Component']);
    expect(card.options).toEqual(['answer-one', 'save-draft']);
    expect((await session.handle({ type: 'confirm' }))[0].type).toBe('error');
    expect(mock.issues.some((i) => i.fields.summary === 'Checkout error')).toBe(false);
  });

  it('lets the user answer just the one missing value after Stop', async () => {
    await session.handle({ type: 'submit', text: 'Create a bug in WEB for checkout error' });
    await session.handle({ type: 'stop' });
    let msgs = await session.handle({ type: 'fallback', option: 'answer-one' });
    expect(questionOf(msgs).field).toBe('components');
    msgs = await session.handle({ type: 'answer', text: 'frontend' });
    expect(cardOf(msgs).canConfirm).toBe(true);
  });

  it('gives up on a field after 3 failed answers and offers the fallback options', async () => {
    await session.handle({ type: 'submit', text: 'Create a bug in WEB for checkout error, high priority' });
    let msgs: CoreToUi[] = [];
    for (let i = 0; i < 3; i++) msgs = await session.handle({ type: 'answer', text: 'nonsense' });
    const card = cardOf(msgs);
    expect(card.unresolved).toEqual(['Component']);
    expect(card.options).toContain('save-draft');
  });

  it('cancel changes nothing', async () => {
    await session.handle({ type: 'submit', text: 'Create a bug in WEB for crash, high, frontend team' });
    const before = mock.issues.length;
    await session.handle({ type: 'cancel' });
    expect(mock.issues.length).toBe(before);
  });

  it('refuses to write on a read-only connection', async () => {
    const ro = new Session({
      connections: [{ ...connections[0], readOnly: true }],
      audit,
    });
    const msgs = await ro.handle({ type: 'submit', text: 'Create a story in WEB for docs' });
    expect(cardOf(msgs).canConfirm).toBe(false);
    expect(cardOf(msgs).card.warnings.join(' ')).toContain('read-only');
    expect((await ro.handle({ type: 'confirm' }))[0]).toMatchObject({ type: 'result', ok: false, text: 'This connection is read-only.' });
    expect(mock.issues.some((i) => i.fields.summary === 'Docs')).toBe(false);
  });
});

describe('session: auto-create', () => {
  it('creates straight away when the draft is complete and valid', async () => {
    const auto = new Session({ connections, audit, autoCreate: () => true });
    const msgs = await auto.handle({
      type: 'submit',
      text: 'Create a bug in WEB for crash on login, high priority, frontend team',
    });
    expect(msgs.find((m) => m.type === 'card')).toBeUndefined();
    expect(msgs.find((m) => m.type === 'result')).toMatchObject({ ok: true, text: expect.stringMatching(/^Created WEB-/) });
    expect(audit.list()).toHaveLength(1);
  });

  it('still asks for a missing required value instead of creating', async () => {
    const auto = new Session({ connections, audit, autoCreate: () => true });
    const msgs = await auto.handle({ type: 'submit', text: 'Create a bug in WEB for crash on login, high priority' });
    expect(questionOf(msgs).field).toBe('components');
    expect(audit.list()).toHaveLength(0);
  });

  it('still shows the card when the toggle is off', async () => {
    let on = false;
    const auto = new Session({ connections, audit, autoCreate: () => on });
    const msgs = await auto.handle({ type: 'submit', text: 'Create a story in WEB for docs page' });
    expect(cardOf(msgs).canConfirm).toBe(true);
    expect(audit.list()).toHaveLength(0);
    on = true;
    const again = await auto.handle({ type: 'submit', text: 'Create a story in WEB for docs page' });
    expect(again.find((m) => m.type === 'result')).toBeDefined();
  });

  it('never auto-creates on a read-only connection', async () => {
    const ro = new Session({ connections: [{ ...connections[0], readOnly: true }], audit, autoCreate: () => true });
    const msgs = await ro.handle({ type: 'submit', text: 'Create a story in WEB for docs' });
    expect(msgs.find((m) => m.type === 'result')).toBeUndefined();
    expect(cardOf(msgs).canConfirm).toBe(false);
  });
});

describe('session: routing and the MCP connection', () => {
  it('asks "Which tool?" when nothing identifies one', async () => {
    const q = questionOf(await session.handle({ type: 'submit', text: 'make something new in WEB' }));
    expect(q.field).toBe('__tool');
    expect(q.choices.map((c) => c.id)).toEqual(['jira', 'jira-mcp']);
  });

  it('routes @jira-mcp to the MCP connection and creates the issue through the MCP tool', async () => {
    let msgs = await session.handle({
      type: 'submit',
      text: '@jira-mcp create a story in WEB for add dark mode to settings',
    });
    expect(msgs[0]).toMatchObject({ type: 'info', text: 'Using Company Jira (MCP).' });
    const card = cardOf(msgs);
    expect(card.canConfirm).toBe(true);
    expect(card.card.warnings[0]).toContain('Basic connection');
    msgs = await session.handle({ type: 'confirm' });
    expect(msgs[0]).toMatchObject({ type: 'result', ok: true });
    expect(audit.list()[0].connection).toBe('Company Jira (MCP)');
  });

  it("lets Jira's own validation catch what a basic MCP schema cannot express", async () => {
    const card = cardOf(await session.handle({ type: 'submit', text: '@jira-mcp create a bug in WEB for crash' }));
    expect(card.canConfirm).toBe(true); // the MCP schema does not mark component as required
    const res = await session.handle({ type: 'confirm' });
    expect(res[0]).toMatchObject({ type: 'result', ok: false });
    expect((res[0] as { text: string }).text).toContain('components');
    expect(audit.list()[0].result.ok).toBe(false);
  });
});
