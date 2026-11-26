import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/core/connectors/contract.js';
import { Ms365Connector } from '../src/core/connectors/ms365.js';
import { RovoJiraConnector } from '../src/core/connectors/rovo.js';
import { createConnect } from '../src/server/connect.js';
import { createFakeMs365, enterCode, type FakeMs365State } from './helpers/fakeMs365.js';
import { createFakeRovo } from './helpers/fakeRovo.js';

async function rovoConnection(): Promise<Connection> {
  const fake = createFakeRovo();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(b);
  const client = new Client({ name: 'assistant', version: '0' });
  await client.connect(a);
  return { id: 'rovo', name: 'Atlassian Rovo (live)', readOnly: false, connector: new RovoJiraConnector(client) };
}

/** A Microsoft 365 server process; every one made with the same state shares its sign-in, like the token cache. */
async function ms365Connection(state: FakeMs365State, work: boolean): Promise<Connection> {
  const fake = createFakeMs365(state);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(b);
  const client = new Client({ name: 'assistant', version: '0' });
  await client.connect(a);
  return { id: 'm365', name: 'Microsoft 365', readOnly: false, connector: new Ms365Connector(client, { work }) };
}
const noMs365 = () => Promise.reject(new Error('not used in this test'));

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
    const hooks = createConnect({ connections, rovo, ms365: noMs365 });
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
    const hooks = createConnect({ connections, rovo: () => rovoConnection(), ms365: noMs365 });
    expect(await hooks.start('jira', {})).toEqual({ how: 'ready' });
    await hooks.finish('jira');
    expect(connections).toHaveLength(1);
    expect(connections[0]).not.toBe(old);
  });

  it('cancelling stops the sign-in and adds nothing', async () => {
    const connections: Connection[] = [];
    const hooks = createConnect({ connections, rovo: browserSignIn().rovo, ms365: noMs365 });
    await hooks.start('jira', {});
    const finished = hooks.finish('jira');
    hooks.cancel('jira');
    await expect(finished).rejects.toThrow('Sign-in cancelled.');
    expect(connections).toHaveLength(0);
  });
});

describe('createConnect: Microsoft 365', () => {
  const setup = (state: FakeMs365State, ms365Browser = true) => {
    const connections: Connection[] = [];
    const asked: { work: boolean; deviceCode: boolean }[] = [];
    const hooks = createConnect({
      connections,
      rovo: () => Promise.reject(new Error('not used')),
      ms365: (o) => (asked.push(o), ms365Connection(state, o.work)),
      pollMs: 5,
      ms365Browser,
    });
    return { connections, asked, hooks };
  };

  it('signs in through the browser, then adds the live connection', async () => {
    const { connections, asked, hooks } = setup({ signedIn: false, login: 'browser' });
    expect(await hooks.start('m365', { work: true })).toEqual({ how: 'browser' });
    expect(asked).toEqual([{ work: true, deviceCode: false }]);
    expect(await hooks.finish('m365')).toBe('Microsoft 365 as priya@contoso.example');
    expect(connections.map((c) => c.id)).toEqual(['m365']);
    expect(await hooks.status()).toContainEqual({ tool: 'm365', connected: true, detail: 'connected as priya@contoso.example' });
  });

  it('shows a sign-in code, and goes live once the user has entered it', async () => {
    const state: FakeMs365State = { signedIn: false, login: 'code' };
    const { connections, asked, hooks } = setup(state);
    expect(await hooks.start('m365', { work: false, deviceCode: true })).toEqual({ how: 'code', url: 'https://microsoft.com/devicelogin', code: 'FAKE12345' });
    expect(asked).toEqual([{ work: false, deviceCode: true }]);
    const finished = hooks.finish('m365');
    await new Promise((r) => setTimeout(r, 20));
    expect(connections).toHaveLength(0); // still waiting for the code
    enterCode(state);
    expect(await finished).toBe('Microsoft 365 as priya@contoso.example');
    expect(connections).toHaveLength(1);
  });

  it("uses a code without our own app registration, because the ready-made app rejects the browser's return address", async () => {
    const { asked, hooks } = setup({ signedIn: false, login: 'code' }, false);
    expect(await hooks.start('m365', { work: false })).toEqual({ how: 'code', url: 'https://microsoft.com/devicelogin', code: 'FAKE12345' });
    expect(asked).toEqual([{ work: false, deviceCode: true }]);
    expect(hooks.canUseBrowser!('m365')).toBe(false);
    expect(hooks.canUseBrowser!('jira')).toBe(true);
    hooks.cancel('m365');
  });

  it('needs no sign-in when the saved one still works', async () => {
    const { hooks } = setup({ signedIn: true, login: 'browser' });
    expect(await hooks.start('m365', { work: true })).toEqual({ how: 'ready' });
    expect(await hooks.finish('m365')).toBe('Microsoft 365 as priya@contoso.example');
  });

  it('remembers the account kind, and signing out clears the sign-in and forgets it', async () => {
    const state: FakeMs365State = { signedIn: false, login: 'browser' };
    const remembered: unknown[] = [];
    const connections: Connection[] = [];
    const hooks = createConnect({ connections, rovo: () => rovoConnection(), ms365: (o) => ms365Connection(state, o.work), remember: (...a) => void remembered.push(a) });
    await hooks.start('m365', { work: false });
    await hooks.finish('m365');
    await hooks.start('jira', {});
    await hooks.finish('jira');
    expect(connections.map((c) => c.id)).toEqual(['m365', 'rovo']);

    await hooks.signOut('m365');
    expect(state.signedIn).toBe(false); // the server cleared its token cache
    await hooks.signOut('jira');
    expect(connections).toEqual([]);
    expect(remembered).toEqual([['m365', { work: false }], ['m365'], ['jira']]);
    expect(await hooks.status()).toEqual([
      { tool: 'm365', connected: false, detail: 'not connected' },
      { tool: 'jira', connected: false, detail: 'not connected' },
    ]);
  });

  it('adds nothing when the organisation blocks the app, or when the code is cancelled', async () => {
    const blocked = setup({ signedIn: false, login: 'blocked' });
    await blocked.hooks.start('m365', { work: true });
    await expect(blocked.hooks.finish('m365')).rejects.toThrow(/AADSTS65001/);
    expect(blocked.connections).toHaveLength(0);

    const coded = setup({ signedIn: false, login: 'code' });
    await coded.hooks.start('m365', { work: true, deviceCode: true });
    const finished = coded.hooks.finish('m365');
    coded.hooks.cancel('m365');
    await expect(finished).rejects.toThrow('Sign-in cancelled.');
    expect(coded.connections).toHaveLength(0);
  });
});
