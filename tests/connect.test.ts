import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/executor.js';
import type { LlmCall, LlmGateway } from '../src/core/llm.js';
import { type ConnectHooks, type CoreToUi, Session, type SignInStart } from '../src/core/session.js';

const audit = () => new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'connect-')), 'audit.jsonl'));
const questionOf = (msgs: CoreToUi[]) => (msgs.find((m) => m.type === 'question') as Extract<CoreToUi, { type: 'question' }> | undefined)?.question;
const signinOf = (msgs: CoreToUi[]) => msgs.find((m) => m.type === 'signin') as Extract<CoreToUi, { type: 'signin' }> | undefined;
const resultOf = (msgs: CoreToUi[]) => msgs.find((m) => m.type === 'result') as Extract<CoreToUi, { type: 'result' }> | undefined;

/** Hooks whose sign-in results are scripted per call; `calls` records what the session asked for. */
function fakeHooks(script: { start?: (SignInStart | Error)[]; finish?: (string | Error | Promise<string>)[]; connected?: ('m365' | 'jira')[] } = {}) {
  const calls: string[] = [];
  let s = 0;
  let f = 0;
  const hooks: ConnectHooks = {
    status: async () => [
      { tool: 'm365', connected: Boolean(script.connected?.includes('m365')), detail: script.connected?.includes('m365') ? 'connected as priya@contoso.example' : 'not connected' },
      { tool: 'jira', connected: Boolean(script.connected?.includes('jira')), detail: script.connected?.includes('jira') ? 'connected to example.atlassian.net' : 'not connected' },
    ],
    start: async (tool, opts) => {
      calls.push(`start ${tool} ${JSON.stringify(opts)}`);
      const r = script.start?.[s++] ?? { how: 'browser', url: 'https://auth.example/authorize' };
      if (r instanceof Error) throw r;
      return r;
    },
    finish: async (tool) => {
      calls.push(`finish ${tool}`);
      const r = script.finish?.[f++] ?? `${tool} as priya@contoso.example`;
      if (r instanceof Error) throw r;
      return r;
    },
    cancel: (tool) => void calls.push(`cancel ${tool}`),
    signOut: async (tool) => void calls.push(`signOut ${tool}`),
  };
  return { hooks, calls };
}

/** An LLM that records every call, to prove /connect never reaches it. */
const recordingLlm = () => {
  const calls: LlmCall[] = [];
  const gw: LlmGateway = { extractJson: async (o) => (calls.push(o), { intent: 'answer', reply: 'hi', suggestions: [] }) };
  return { gw, calls };
};

describe('/connect', () => {
  it('lists the tools with their live status, and never reaches the LLM', async () => {
    const { hooks } = fakeHooks({ connected: ['jira'] });
    const llm = recordingLlm();
    const session = new Session({ connections: [], audit: audit(), llm: llm.gw, connect: hooks });
    const q = questionOf(await session.handle({ type: 'submit', text: '/connect' }))!;
    expect(q).toMatchObject({ field: '__connect', text: 'Connect which tool?' });
    expect(q.choices.map((c) => [c.label, c.detail])).toEqual([
      ['Microsoft 365', 'not connected'],
      ['Jira Cloud', 'connected to example.atlassian.net'],
      ['Other connectors', 'coming later'],
    ]);
    expect(await session.handle({ type: 'submit', text: '/conect' })).toEqual([{ type: 'info', text: 'Unknown command /conect. Try /connect.' }]);
    expect(llm.calls).toHaveLength(0);
  });

  it('says other connectors are coming later, and that it is unavailable without sign-in hooks', async () => {
    const session = new Session({ connections: [], audit: audit(), connect: fakeHooks().hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    expect(await session.handle({ type: 'answer', choiceId: 'other' })).toEqual([{ type: 'info', text: 'Other connectors are coming in a later version.' }]);
    const bare = new Session({ connections: [], audit: audit() });
    expect(await bare.handle({ type: 'submit', text: '/connect' })).toEqual([{ type: 'info', text: 'Connecting tools is not available here.' }]);
  });

  it("Jira: shows the browser sign-in, waits for it, and reports who is connected", async () => {
    const { hooks, calls } = fakeHooks({ finish: ['Jira Cloud: Priya Nair @ example.atlassian.net'] });
    const session = new Session({ connections: [], audit: audit(), connect: hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    const signin = signinOf(await session.handle({ type: 'answer', choiceId: 'jira' }))!;
    expect(signin).toMatchObject({ service: 'Jira Cloud', how: 'browser', url: 'https://auth.example/authorize' });
    expect(signin.text).toContain("Atlassian's sign-in page");
    expect(resultOf(await session.handle({ type: 'wait' }))).toEqual({ type: 'result', ok: true, stamp: 'Connected', text: 'Jira Cloud: Priya Nair @ example.atlassian.net' });
    expect(calls).toEqual(['start jira {}', 'finish jira']);
  });

  it('Microsoft 365: asks the account kind, explains admin approval, and offers a code instead', async () => {
    const { hooks, calls } = fakeHooks({
      start: [{ how: 'browser' }, { how: 'code', url: 'https://microsoft.com/devicelogin', code: 'ABCD1234' }],
      finish: [new Error('AADSTS65001: The user or administrator has not consented to use the application.'), 'Microsoft 365: priya@contoso.example'],
    });
    const session = new Session({ connections: [], audit: audit(), connect: hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    const q = questionOf(await session.handle({ type: 'answer', choiceId: 'm365' }))!;
    expect(q.choices.map((c) => c.id)).toEqual(['work', 'personal']);
    expect(signinOf(await session.handle({ type: 'answer', choiceId: 'work' }))).toMatchObject({ how: 'browser', service: 'Microsoft 365' });

    let msgs = await session.handle({ type: 'wait' });
    expect(resultOf(msgs)).toMatchObject({ ok: false, text: expect.stringContaining('needs an admin to approve this app') });
    expect(questionOf(msgs)!.choices.map((c) => c.label)).toEqual(['Sign in with a code instead', 'Try the browser again', 'Cancel']);

    msgs = await session.handle({ type: 'answer', choiceId: 'code' });
    expect(signinOf(msgs)).toMatchObject({ how: 'code', code: 'ABCD1234', url: 'https://microsoft.com/devicelogin' });
    expect(resultOf(await session.handle({ type: 'wait' }))).toMatchObject({ ok: true, stamp: 'Connected', text: 'Microsoft 365: priya@contoso.example' });
    expect(calls).toEqual(['start m365 {"work":true}', 'finish m365', 'start m365 {"work":true,"deviceCode":true}', 'finish m365']);
  });

  it('Microsoft 365: "Use a code instead" switches a browser sign-in to a code', async () => {
    const { hooks, calls } = fakeHooks({ start: [{ how: 'browser' }, { how: 'code', url: 'https://microsoft.com/devicelogin', code: 'ABCD1234' }] });
    const session = new Session({ connections: [], audit: audit(), connect: hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    await session.handle({ type: 'answer', choiceId: 'm365' });
    expect(signinOf(await session.handle({ type: 'answer', choiceId: 'personal' }))).toMatchObject({ how: 'browser', alt: { id: 'code', label: 'Use a code instead' } });
    expect(signinOf(await session.handle({ type: 'answer', choiceId: 'code' }))).toMatchObject({ how: 'code', code: 'ABCD1234' });
    expect(calls).toEqual(['start m365 {"work":false}', 'cancel m365', 'start m365 {"work":false,"deviceCode":true}']);
  });

  it('a connected tool offers sign out, sign in again, or leaving it alone', async () => {
    const { hooks, calls } = fakeHooks({ connected: ['jira', 'm365'] });
    const session = new Session({ connections: [], audit: audit(), connect: hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    const q = questionOf(await session.handle({ type: 'answer', choiceId: 'jira' }))!;
    expect(q.text).toBe('Jira Cloud is connected to example.atlassian.net. What would you like to do?');
    expect(q.choices.map((c) => c.id)).toEqual(['again', 'signout', 'keep']);
    expect(resultOf(await session.handle({ type: 'answer', choiceId: 'signout' }))).toEqual({ type: 'result', ok: true, stamp: 'Signed out', text: 'of Jira Cloud' });

    await session.handle({ type: 'submit', text: '/connect' });
    await session.handle({ type: 'answer', choiceId: 'm365' });
    // Signing in again starts from the account kind, so the user can switch accounts.
    expect(questionOf(await session.handle({ type: 'answer', choiceId: 'again' }))!.choices.map((c) => c.id)).toEqual(['work', 'personal']);

    await session.handle({ type: 'submit', text: '/connect' });
    await session.handle({ type: 'answer', choiceId: 'm365' });
    expect(await session.handle({ type: 'answer', choiceId: 'keep' })).toEqual([{ type: 'info', text: 'Nothing changed.' }]);
    expect(calls).toEqual(['signOut jira', 'signOut m365']);
  });

  it('cancelling a sign-in stops it, and the late result is dropped', async () => {
    let fail!: (e: Error) => void;
    const pending = new Promise<string>((_, reject) => (fail = reject));
    const { hooks, calls } = fakeHooks({ finish: [pending] });
    const session = new Session({ connections: [], audit: audit(), connect: hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    await session.handle({ type: 'answer', choiceId: 'jira' });
    const waiting = session.handle({ type: 'wait' });
    expect(await session.handle({ type: 'cancel' })).toEqual([{ type: 'info', text: 'Cancelled. Nothing was changed.' }]);
    fail(new Error('Sign-in cancelled.'));
    expect(await waiting).toEqual([]);
    expect(calls).toContain('cancel jira');
  });

  it('skips the browser when already signed in, and words a timeout plainly', async () => {
    const { hooks } = fakeHooks({ start: [{ how: 'ready' }, { how: 'browser' }], finish: ['Jira Cloud: Priya', new Error('Timed out waiting for sign-in (5 minutes).')] });
    const session = new Session({ connections: [], audit: audit(), connect: hooks });
    await session.handle({ type: 'submit', text: '/connect' });
    expect(resultOf(await session.handle({ type: 'answer', choiceId: 'jira' }))).toMatchObject({ ok: true, text: 'Jira Cloud: Priya' });
    await session.handle({ type: 'submit', text: '/connect' });
    await session.handle({ type: 'answer', choiceId: 'jira' });
    const msgs = await session.handle({ type: 'wait' });
    expect(resultOf(msgs)).toMatchObject({ ok: false, text: 'Sign-in timed out. Run /connect to try again.' });
    expect(questionOf(msgs)!.choices.map((c) => c.label)).toEqual(['Try again', 'Cancel']);
  });
});
