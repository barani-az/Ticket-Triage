import fs from 'node:fs';
import { parseEnv } from '../src/shell/env.js';

/** Times a one-word chat request on several models in parallel. Prints statuses only, never the key. */
const env = { ...process.env, ...parseEnv(fs.readFileSync('.env', 'utf8')) };
const key = env.GEMINI_API_KEY;
if (!key) throw new Error('No GEMINI_API_KEY in .env');
const base = 'https://generativelanguage.googleapis.com/v1beta/openai';
const models = process.argv.slice(2);

await Promise.all(
  models.map(async (model) => {
    const t = Date.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
        signal: AbortSignal.timeout(40_000),
      });
      const text = (await res.text()).replace(/\s+/g, ' ');
      console.log(`${model.padEnd(28)} HTTP ${res.status} ${String(Date.now() - t).padStart(5)}ms  ${text.slice(0, 160)}`);
    } catch (e) {
      console.log(`${model.padEnd(28)} FAILED after ${Date.now() - t}ms: ${(e as Error).message}`);
    }
  }),
);
