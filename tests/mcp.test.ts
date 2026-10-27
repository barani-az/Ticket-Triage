import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JiraConnector } from '../src/core/connectors/jira.js';
import { McpConnector } from '../src/core/connectors/mcp.js';
import { createJiraMcpServer } from '../src/mcp/jiraServer.js';
import { startMockJira } from '../src/mock/jiraMock.js';

let mock: Awaited<ReturnType<typeof startMockJira>>;
let mcp: McpConnector;

beforeAll(async () => {
  mock = await startMockJira(0);
  const jira = new JiraConnector({ baseUrl: mock.baseUrl, flavor: 'cloud', token: 't' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createJiraMcpServer(jira).connect(serverSide);
  const client = new Client({ name: 'assistant', version: '0.0.1' });
  await client.connect(clientSide);
  mcp = new McpConnector(client);
});
afterAll(async () => {
  await mcp.close();
  await mock.close();
});

describe('McpConnector', () => {
  it('connects and reports the server name', async () => {
    expect(await mcp.testConnection()).toEqual({ ok: true, actingAs: 'jira-mcp-demo' });
  });

  it('turns the write tool input schema into fields, with real enums from the server', async () => {
    const schema = await mcp.getSchema({});
    expect(schema.required).toEqual(['project', 'issuetype', 'summary']);
    expect(schema.properties.project.enum).toEqual(['WEB', 'APP']);
    expect(schema.properties.priority.default).toBe('Medium');
  });

  it('never picks the read-only tool as the write tool', async () => {
    const schema = await mcp.getSchema({});
    expect(schema.properties.summary).toBeDefined();
  });

  it('has no lookups (basic connection)', async () => {
    expect(await mcp.lookup('user', 'arjun')).toEqual([]);
  });

  it('creates an issue through the MCP tool', async () => {
    const res = await mcp.execute({
      connectionId: 'jira-mcp',
      op: 'create',
      params: { project: 'WEB', issuetype: 'Story', summary: 'Via MCP' },
    });
    expect(res).toMatchObject({ ok: true, id: expect.stringMatching(/^WEB-\d+$/) });
  });

  it('returns the tool error when Jira rejects the call', async () => {
    const res = await mcp.execute({
      connectionId: 'jira-mcp',
      op: 'create',
      params: { project: 'WEB', issuetype: 'Bug', summary: 'Missing required' },
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });
});
