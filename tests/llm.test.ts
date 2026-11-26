import { describe, expect, it } from 'vitest';
import { FallbackGateway, gatewayFromEnv, OpenAiCompatGateway } from '../src/core/llm.js';
import { understand } from '../src/core/understand.js';

const reply = (content: string) =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as unknown as typeof fetch;

describe('LLM gateway', () => {
  it('posts to the chat completions endpoint with the bearer key and parses the JSON reply', async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }));
    }) as unknown as typeof fetch;
    const gw = new OpenAiCompatGateway({ baseUrl: 'http://x/v1/', model: 'm', apiKey: 'k', fetchFn });
    expect(await gw.extractJson({ system: 's', user: 'u' })).toEqual({ a: 1 });
    expect(seen!.url).toBe('http://x/v1/chat/completions');
    expect(seen!.headers.authorization).toBe('Bearer k');
    expect(seen!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('selects Gemini from GEMINI_API_KEY and does nothing without any key', () => {
    expect(gatewayFromEnv({})).toBeUndefined();
    expect(gatewayFromEnv({ GEMINI_API_KEY: 'k' })).toBeInstanceOf(FallbackGateway);
  });

  it('moves to the next model when one fails, and reports the last error if all fail', async () => {
    const calls: string[] = [];
    const gw = (name: string, fail: boolean) => ({
      extractJson: async () => {
        calls.push(name);
        if (fail) throw new Error(`${name} overloaded`);
        return { from: name };
      },
    });
    expect(await new FallbackGateway([gw('a', true), gw('b', false), gw('c', false)]).extractJson({ system: '', user: '' })).toEqual({ from: 'b' });
    expect(calls).toEqual(['a', 'b']);
    await expect(new FallbackGateway([gw('x', true), gw('y', true)]).extractJson({ system: '', user: '' })).rejects.toThrow('y overloaded');
  });

  it('times out a stuck request instead of waiting forever', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const g = new OpenAiCompatGateway({ baseUrl: 'http://x', model: 'm', fetchFn: hang, timeoutMs: 30 });
    await expect(g.extractJson({ system: '', user: '' })).rejects.toThrow('aborted');
  });

  it('merges LLM-extracted fields over the rules', async () => {
    const gw = new OpenAiCompatGateway({
      baseUrl: 'http://x',
      model: 'm',
      fetchFn: reply('{"operation":"create","fields":{"priority":"Low","summary":"Fix typo on pricing page"}}'),
    });
    const u = await understand('please sort out the pricing page typo, low priority', gw);
    expect(u.fields.priority.value).toBe('Low');
    expect(u.fields.summary.value).toBe('Fix typo on pricing page');
  });

  it('capitalises a lowercase summary from the model and keeps other values as given', async () => {
    const gw = new OpenAiCompatGateway({
      baseUrl: 'http://x',
      model: 'm',
      fetchFn: reply('{"operation":"create","fields":{"summary":"login page crashing on Safari","priority":"high","assignee":"Priya"}}'),
    });
    const u = await understand('checkout is broken, give it to Priya', gw);
    expect(u.fields.summary.value).toBe('Login page crashing on Safari');
    expect(u.fields.assignee.value).toBe('Priya');
  });

  it('falls back to the rules when the LLM fails', async () => {
    const gw = new OpenAiCompatGateway({
      baseUrl: 'http://x',
      model: 'm',
      fetchFn: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    const u = await understand('Create a bug for the login crash, high priority', gw);
    expect(u.fields.priority.value).toBe('High');
  });
});

describe('images', () => {
  it('sends images as image_url parts next to the text, and plain text when there are none', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    }) as unknown as typeof fetch;
    const gw = new OpenAiCompatGateway({ baseUrl: 'http://x', model: 'm', fetchFn });
    await gw.extractJson({ system: 's', user: 'look', images: ['data:image/jpeg;base64,AAA'] });
    await gw.extractJson({ system: 's', user: 'plain' });
    expect(bodies[0].messages[1].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
    ]);
    expect(bodies[1].messages[1].content).toBe('plain');
  });
});

describe('waiting limits', () => {
  const failing = (name: string, calls: string[], message = 'LLM request failed: 503 busy') => ({
    extractJson: async () => {
      calls.push(name);
      throw new Error(message);
    },
  });
  const working = (name: string, calls: string[]) => ({
    extractJson: async () => {
      calls.push(name);
      return { from: name };
    },
  });

  it('tries a model that just failed last, so later messages do not wait on it again', async () => {
    const calls: string[] = [];
    const gw = new FallbackGateway([failing('busy', calls), working('ok', calls)]);
    await gw.extractJson({ system: '', user: '' });
    await gw.extractJson({ system: '', user: '' });
    expect(calls).toEqual(['busy', 'ok', 'ok']);
  });

  it('does not sideline a model for a rejected request', async () => {
    const calls: string[] = [];
    const gw = new FallbackGateway([failing('picky', calls, 'LLM request failed: 400 bad param'), working('ok', calls)]);
    await gw.extractJson({ system: '', user: '' });
    await gw.extractJson({ system: '', user: '' });
    expect(calls).toEqual(['picky', 'ok', 'picky', 'ok']);
  });

  it('stops trying more models once the total time budget is spent', async () => {
    const calls: string[] = [];
    const slow = {
      extractJson: async () => {
        calls.push('slow');
        await new Promise((r) => setTimeout(r, 40));
        throw new Error('timeout');
      },
    };
    const gw = new FallbackGateway([slow, working('never', calls)]);
    await expect(gw.extractJson({ system: '', user: '', budgetMs: 20 })).rejects.toThrow('timeout');
    expect(calls).toEqual(['slow']);
  });
});
