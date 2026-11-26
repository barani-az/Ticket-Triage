import { clip, debug, log } from './log.js';

/** The LLM proposes. Everything it returns is checked against the tool's own data afterwards. */
export interface LlmCall {
  system: string;
  user: string;
  /** Ask a reasoning model to think harder. Sent as `reasoning_effort`; omit for plain extraction. */
  effort?: 'low' | 'medium' | 'high';
  /** Overrides the gateway's default timeout for this call (thinking takes longer than extraction). */
  timeoutMs?: number;
  /** Images for the model to look at, as data URLs (data:image/jpeg;base64,...). */
  images?: string[];
  /** The most time all attempts together may take, so trying several models cannot add up to minutes. */
  budgetMs?: number;
}

export interface LlmGateway {
  extractJson(opts: LlmCall): Promise<unknown>;
}

export interface OpenAiCompatConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Give up on a request after this long (default 20s) so a stuck provider cannot freeze the app. */
  timeoutMs?: number;
}

/** Works with Ollama, Groq, OpenRouter, and Gemini's OpenAI-compatible endpoint. */
export class OpenAiCompatGateway implements LlmGateway {
  constructor(private cfg: OpenAiCompatConfig) {}

  async extractJson(call: LlmCall): Promise<unknown> {
    const t0 = Date.now();
    const what = `${this.cfg.model}${call.effort ? ` (effort ${call.effort})` : ''}${call.images?.length ? ` + ${call.images.length} image(s)` : ''}`;
    debug('llm', () => `${what} prompt: ${clip(call.user, 2000)}`);
    try {
      const out = await this.send(call);
      log('llm', `${what} answered in ${Date.now() - t0} ms`);
      debug('llm', () => `${this.cfg.model} reply: ${clip(JSON.stringify(out), 2000)}`);
      return out;
    } catch (e) {
      log('llm', `${what} failed after ${Date.now() - t0} ms: ${clip((e as Error).message, 200)}`);
      throw e;
    }
  }

  private async send({ system, user, effort, timeoutMs, images }: LlmCall): Promise<unknown> {
    const res = await (this.cfg.fetchFn ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs ?? this.cfg.timeoutMs ?? 20_000),
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        ...(effort ? { reasoning_effort: effort } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: images?.length
              ? [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
              : user,
          },
        ],
      }),
    });
    if (!res.ok) {
      // Include the provider's message (never the key) so setup problems are diagnosable.
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`LLM request failed: ${res.status} ${detail}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}');
  }
}

export const GEMINI_OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Measured on 2026-10-27 with a one-word request: 3.5-flash-lite 1.3s, 2.5-flash 1.7s, 3.5-flash 3.3s,
 * while 3.8-flash hung past 45s and a few others returned 503 "high demand". Models come and go,
 * so the list is tried in order and GEMINI_MODEL, if set, goes first.
 */
export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];

/** How long a model that just timed out or was overloaded is tried last instead of first. */
const COOLDOWN_MS = 60_000;

/** Try each gateway in order; a timeout, overload or missing model moves on to the next. */
export class FallbackGateway implements LlmGateway {
  private coolingUntil = new Map<LlmGateway, number>();
  constructor(private gateways: LlmGateway[]) {}

  async extractJson(opts: LlmCall): Promise<unknown> {
    const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
    const cooling = (g: LlmGateway) => (this.coolingUntil.get(g) ?? 0) > Date.now();
    // A model that just failed goes to the back, so every message does not wait on it again.
    const order = [...this.gateways.filter((g) => !cooling(g)), ...this.gateways.filter(cooling)];
    let last: unknown;
    for (const [i, g] of order.entries()) {
      const left = deadline - Date.now();
      if (left <= 0) {
        log('llm', 'out of time for this message; no more models tried');
        break;
      }
      if (i > 0) log('llm', 'trying the next model');
      try {
        const result = await g.extractJson(Number.isFinite(left) ? { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? left, left) } : opts);
        this.coolingUntil.delete(g);
        return result;
      } catch (e) {
        last = e;
        // A rejected request (400) says nothing about the model's health.
        if (!/failed: 400\b/.test((e as Error).message)) this.coolingUntil.set(g, Date.now() + COOLDOWN_MS);
      }
    }
    throw last ?? new Error('No LLM gateway configured.');
  }
}

/**
 * Optional LLM. Either set GEMINI_API_KEY (model from GEMINI_MODEL, default below), or any
 * OpenAI-compatible provider with LLM_BASE_URL + LLM_MODEL (+ LLM_API_KEY). With neither set,
 * the demo uses its built-in rules. Gemini's free tier may use prompts to improve Google
 * products, so use synthetic data only.
 */
export function gatewayFromEnv(env: NodeJS.ProcessEnv): LlmGateway | undefined {
  if (env.LLM_BASE_URL && env.LLM_MODEL) {
    return new OpenAiCompatGateway({ baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY });
  }
  if (env.GEMINI_API_KEY) {
    const models = [...new Set([env.GEMINI_MODEL, ...GEMINI_MODELS].filter((m): m is string => Boolean(m)))];
    return new FallbackGateway(
      models.map((model) => new OpenAiCompatGateway({ baseUrl: GEMINI_OPENAI_URL, model, apiKey: env.GEMINI_API_KEY, timeoutMs: 12_000 })),
    );
  }
  return undefined;
}
