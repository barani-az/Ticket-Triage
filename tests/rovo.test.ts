import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { fieldsToSchema, RovoJiraConnector } from '../src/core/connectors/rovo.js';
import { AuditLog } from '../src/core/executor.js';
import { Session, type CoreToUi } from '../src/core/session.js';
import { CLOUD_ID, createFakeRovo, type FakeRovo, SITE } from './helpers/fakeRovo.js';

let fake: FakeRovo;
let rovo: RovoJiraConnector;

beforeEach(async () => {
  fake = createFakeRovo();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(b);
  const client = new Client({ name: 'assistant', version: '0' });
  await client.connect(a);
  rovo = new RovoJiraConnector(client);
});

const questionOf = (msgs: CoreToUi[]) => (msgs.find((m) => m.type === 'question') as any)?.question;
const cardOf = (msgs: CoreToUi[]) => msgs.find((m) => m.type === 'card') as Extract<CoreToUi, { type: 'card' }>;

describe('fieldsToSchema', () => {
  it('keeps required fields and the optional ones we can ask about, and drops the rest', () => {
    const { properties, required } = fieldsToSchema([
      { fieldId: 'summary', name: 'Summary', required: true },
      { fieldId: 'reporter', name: 'Reporter', required: true },
      { fieldId: 'customfield_10019', name: 'Rank', required: false },
      { fieldId: 'attachment', name: 'Attachment', required: false },
      { fieldId: 'assignee', name: 'Assignee', required: false },
    ]);
    expect(Object.keys(properties)).toEqual(['summary', 'assignee']);
    expect(required).toEqual(['summary']);
  });

  it('turns allowed values into an enum and a required unknown field into free text', () => {
    const { properties, required } = fieldsToSchema([
      { fieldId: 'priority', name: 'Priority', required: true, allowedValues: [{ id: '1', name: 'High' }, { id: '2', value: 'Low' }] },
      { fieldId: 'customfield_9', name: 'Cost centre', required: true },
    ]);
    expect(properties.priority.enum).toEqual(['High', 'Low']);
    expect(properties.customfield_9.enum).toBeUndefined();
    expect(required).toEqual(['priority', 'customfield_9']);
  });
});

describe('RovoJiraConnector', () => {
  it('resolves the Jira site, labels the connection live, and reports who it acts as', async () => {
    expect(await rovo.testConnection()).toEqual({ ok: true, actingAs: 'Priya Nair @ example.atlassian.net' });
    expect(rovo.manifest.live).toBe(SITE);
  });

  it('passes the cloudId on every call after the first lookup', async () => {
    await rovo.lookup('project', '');
    expect(fake.calls.filter((c) => c.name !== 'getAccessibleAtlassianResources').every((c) => c.args.cloudId === CLOUD_ID)).toBe(true);
  });

  it('looks up projects, and issue types for a project', async () => {
    expect((await rovo.lookup('project', '')).map((p) => p.id)).toEqual(['KAN', 'SAM1']);
    expect((await rovo.lookup('project', 'billing')).map((p) => p.id)).toEqual(['SAM1']);
    expect((await rovo.lookup('issuetype', '', { project: 'KAN' })).map((t) => t.id)).toEqual(['Epic', 'Subtask', 'Task', 'Story']);
  });

  it('asks only project and issue type until both are known, then builds the schema from the real field list', async () => {
    expect(Object.keys((await rovo.getSchema({})).properties)).toEqual(['project', 'issuetype']);
    const task = await rovo.getSchema({ project: 'KAN', issuetype: 'Task' });
    expect(task.required).toEqual(['project', 'issuetype', 'summary']);
    expect(task.properties.priority).toBeUndefined(); // this project has no priority field
    const sub = await rovo.getSchema({ project: 'KAN', issuetype: 'Subtask' });
    expect(sub.required).toEqual(['project', 'issuetype', 'summary', 'parent']);
    const sam = await rovo.getSchema({ project: 'SAM1', issuetype: 'Task' });
    expect(sam.properties.priority.enum).toEqual(['High', 'Medium', 'Low']);
  });

  it('finds active people only, and returns nothing until the user types a name', async () => {
    expect(await rovo.lookup('user', '')).toEqual([]);
    expect((await rovo.lookup('user', 'arjun')).map((u) => u.label)).toEqual(['Arjun Kumar', 'Arjun Rao']);
  });

  it('creates an issue with the tool arguments Rovo expects', async () => {
    const res = await rovo.execute({
      connectionId: 'rovo',
      op: 'create',
      params: { project: 'SAM1', issuetype: 'Task', summary: 'Fix login', priority: 'High', assignee: 'acc-1', components: 'Frontend', labels: 'a, b' },
    });
    expect(res).toMatchObject({ ok: true, url: expect.stringContaining(`${SITE}/browse/SAM1-`) });
    const call = fake.calls.find((c) => c.name === 'createJiraIssue')!;
    expect(call.args).toMatchObject({
      cloudId: CLOUD_ID,
      projectKey: 'SAM1',
      issueType: 'Task',
      summary: 'Fix login',
      priority: 'High',
      assignee: 'acc-1',
      labels: ['a', 'b'],
      additional_fields: { components: [{ name: 'Frontend' }] },
    });
  });

  it("returns the tool's own error and does not mark it retryable (no duplicate risk)", async () => {
    const res = await rovo.execute({ connectionId: 'rovo', op: 'create', params: { project: 'KAN', issuetype: 'Subtask', summary: 'x' } });
    expect(res).toEqual({ ok: false, error: 'parent is required for sub-tasks', retryable: false });
  });
});

describe('Rovo through the questionnaire', () => {
  let session: Session;
  let audit: AuditLog;
  beforeEach(() => {
    audit = new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rovo-')), 'a.jsonl'));
    session = new Session({ connections: [{ id: 'rovo', name: 'Atlassian Rovo (live)', readOnly: false, connector: rovo }], audit });
  });

  it('creates a task after one question, with a live-site warning on the card', async () => {
    let msgs = await session.handle({ type: 'submit', text: 'Create a task for the billing export' });
    const q = questionOf(msgs);
    expect(q.field).toBe('project');
    expect(q.choices.map((c: any) => c.id)).toEqual(['KAN', 'SAM1']);
    msgs = await session.handle({ type: 'answer', choiceId: 'KAN' });
    const card = cardOf(msgs);
    expect(card.canConfirm).toBe(true);
    expect(card.card.warnings[0]).toBe(`This creates a real issue on ${SITE}.`);
    msgs = await session.handle({ type: 'confirm' });
    expect(msgs[0]).toMatchObject({ type: 'result', ok: true, text: expect.stringMatching(/^Created KAN-/) });
    expect(audit.list()).toHaveLength(1);
  });

  it('asks for the parent when creating a subtask', async () => {
    const msgs = await session.handle({ type: 'submit', text: 'Create a subtask in KAN for write tests' });
    // "subtask" is not one of the rule-based types, so the type is asked first
    expect(questionOf(msgs).field).toBe('issuetype');
    const next = await session.handle({ type: 'answer', choiceId: 'Subtask' });
    expect(questionOf(next).field).toBe('parent');
  });

  it('asks which person when a typed name matches two, never picking one', async () => {
    const msgs = await session.handle({ type: 'submit', text: 'Create a task in KAN for billing export, assign to Arjun' });
    const q = questionOf(msgs);
    expect(q).toMatchObject({ source: 4, field: 'assignee' });
    expect(q.choices.map((c: any) => c.label)).toEqual(['Arjun Kumar', 'Arjun Rao']);
  });
});
