import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JiraConnector } from '../src/core/connectors/jira.js';
import { startMockJira } from '../src/mock/jiraMock.js';

let mock: Awaited<ReturnType<typeof startMockJira>>;
let jira: JiraConnector;

beforeAll(async () => {
  mock = await startMockJira(0);
  jira = new JiraConnector({ baseUrl: mock.baseUrl, flavor: 'cloud', email: 'p@x.com', token: 'tok' });
});
afterAll(() => mock.close());

describe('JiraConnector', () => {
  it('tests the connection and reports who it acts as', async () => {
    expect(await jira.testConnection()).toEqual({ ok: true, actingAs: 'Priya Nair' });
  });

  it('flags a rejected token as needing re-auth', async () => {
    const bad = new JiraConnector({
      baseUrl: mock.baseUrl,
      flavor: 'cloud',
      token: '',
      fetchFn: (url, init) => fetch(url, { ...init, headers: {} }),
    });
    expect(await bad.testConnection()).toMatchObject({ ok: false, needsReauth: true });
  });

  it('asks only for project and issue type until they are known', async () => {
    const schema = await jira.getSchema({});
    expect(Object.keys(schema.properties)).toEqual(['project', 'issuetype']);
  });

  it('builds the Bug schema from createmeta with allowed values and defaults', async () => {
    const schema = await jira.getSchema({ project: 'WEB', issuetype: 'Bug' });
    expect(schema.required).toEqual(['project', 'issuetype', 'summary', 'priority', 'components']);
    expect(schema.properties.priority.enum).toEqual(['Highest', 'High', 'Medium', 'Low']);
    expect(schema.properties.priority.default).toBe('Medium');
    expect(schema.properties.assignee['x-lookup']).toBe('user');
  });

  it('does not require priority for a Story', async () => {
    const schema = await jira.getSchema({ project: 'WEB', issuetype: 'Story' });
    expect(schema.required).toEqual(['project', 'issuetype', 'summary']);
  });

  it('looks up people and returns both Arjuns for "arjun"', async () => {
    const people = await jira.lookup('user', 'arjun');
    expect(people.map((p) => p.label)).toEqual(['Arjun Kumar', 'Arjun Rao']);
  });

  it('looks up issue types per project', async () => {
    const types = await jira.lookup('issuetype', '', { project: 'APP' });
    expect(types.map((t) => t.label)).toEqual(['Bug', 'Task']);
  });

  it('creates an issue and returns key and browse url', async () => {
    const res = await jira.execute({
      connectionId: 'jira',
      op: 'create',
      params: { project: 'WEB', issuetype: 'Bug', summary: 'Login crashes', priority: 'High', components: 'Frontend' },
    });
    expect(res).toMatchObject({ ok: true, id: expect.stringMatching(/^WEB-\d+$/) });
    expect(mock.issues).toHaveLength(1);
  });

  it('surfaces the tool validation error and marks it not retryable', async () => {
    const res = await jira.execute({
      connectionId: 'jira',
      op: 'create',
      params: { project: 'WEB', issuetype: 'Bug', summary: 'No priority or component' },
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });
});
