import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/core/connectors/contract.js';
import { RovoJiraConnector } from '../src/core/connectors/rovo.js';
import { createConnect } from '../src/server/connect.js';
import { createFakeRovo } from './helpers/fakeRovo.js';

async function rovoConnection(): Promise<Connection> {
  const fake = createFakeRovo();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(b);
  const client = new Client({ name: 'assistant', version: '0' });
  await client.connect(a);
  return { id: 'rovo', name: 'Atlassian Rovo (live)', readOnly: false, connector: new RovoJiraConnector(client) };
}

const AUTH_URL = 'https://mcp.atlassian.com/v1/authorize?client_id=x';

/** A Rovo sign-in that "opens the browser" and finishes when `approve()` is called, or fails when aborted. */
function browserSignIn() {
  let approve!: () => void;
  const approved = new Promise<void>((r) => (approve = r));
  const rovo = async ({ onUrl, signal }: { onUrl: (u: string) => void; signal: AbortSignal }) => {
    onUrl(AUTH_URL);
    await Promise.race([approved, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Sign-in cancelled.'))))]);
    return rovoConnection();
  };
  return { rovo, approve: () => approve() };
}

describe('createConnect: Jira Cloud', () => {
  it('opens the Atlassian sign-in, then adds the live connection and reports who it is', async () => {
    const connections: Connection[] = [];
    const { rovo, approve } = browserSignIn();
    const hooks = createConnect({ connections, rovo });
    expect(await hooks.status()).toContainEqual({ tool: 'jira', connected: false, detail: 'not connected' });

    expect(await hooks.start('jira', {})).toEqual({ how: 'browser', url: AUTH_URL });
    expect(connections).toHaveLength(0); // nothing is live until the user has signed in
    approve();
    expect(await hooks.finish('jira')).toBe('Jira Cloud as Priya Nair @ example.atlassian.net');
    expect(connections.map((c) => c.id)).toEqual(['rovo']);
    expect(await hooks.status()).toContainEqual({ tool: 'jira', connected: true, detail: 'connected as Priya Nair @ example.atlassian.net' });
  });

  it('needs no browser when the saved sign-in is still valid, and replaces the old connection', async () => {
    const old = await rovoConnection();
    const connections: Connection[] = [old];
    const hooks = createConnect({ connections, rovo: () => rovoConnection() });
    expect(await hooks.start('jira', {})).toEqual({ how: 'ready' });
    await hooks.finish('jira');
    expect(connections).toHaveLength(1);
    expect(connections[0]).not.toBe(old);
  });

  it('cancelling stops the sign-in and adds nothing', async () => {
    const connections: Connection[] = [];
    const hooks = createConnect({ connections, rovo: browserSignIn().rovo });
    await hooks.start('jira', {});
    const finished = hooks.finish('jira');
    hooks.cancel('jira');
    await expect(finished).rejects.toThrow('Sign-in cancelled.');
    expect(connections).toHaveLength(0);
  });
});
