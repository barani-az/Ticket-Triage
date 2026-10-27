/** The LLM proposes. Everything it returns is checked against the tool's own data afterwards. */
export interface LlmGateway {
  extractJson(opts: { system: string; user: string }): Promise<unknown>;
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

  async extractJson({ system, user }: { system: string; user: string }): Promise<unknown> {
    const res = await (this.cfg.fetchFn ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
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

const GEMINI_OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Measured on 2026-10-27 with a one-word request: 3.5-flash-lite 1.3s, 2.5-flash 1.7s, 3.5-flash 3.3s,
 * while 3.8-flash hung past 45s and a few others returned 503 "high demand". Models come and go,
 * so the list is tried in order and GEMINI_MODEL, if set, goes first.
 */
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];

/** Try each gateway in order; a timeout, overload or missing model moves on to the next. */
export class FallbackGateway implements LlmGateway {
  constructor(private gateways: LlmGateway[]) {}
  async extractJson(opts: { system: string; user: string }): Promise<unknown> {
    let last: unknown;
    for (const g of this.gateways) {
      try {
        return await g.extractJson(opts);
      } catch (e) {
        last = e;
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
