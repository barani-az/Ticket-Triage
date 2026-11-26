/**
 * The app's log: one timestamped line per event, printed to the terminal the app runs in.
 * Off until configured, so tests and scripts stay quiet; the app turns it on from LOG in .env:
 *   LOG=info   (default) every message, reply, AI call, tool call and write, with timings
 *   LOG=debug  also what is sent: prompts, tool arguments and replies (long text is clipped)
 *   LOG=0      off
 * Keys and tokens are never logged; images only as a count.
 */
type Level = 'off' | 'info' | 'debug';
let level: Level = 'off';

export function configureLog(setting?: string) {
  level = setting === '0' || setting === 'off' ? 'off' : setting === 'debug' ? 'debug' : 'info';
}

const stamp = () => {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

export function log(tag: string, msg: string) {
  if (level !== 'off') console.log(`${stamp()} [${tag}] ${msg}`);
}

/** Only with LOG=debug. Pass a function when building the text costs something. */
export function debug(tag: string, msg: string | (() => string)) {
  if (level === 'debug') console.log(`${stamp()} [${tag}] ${typeof msg === 'function' ? msg() : msg}`);
}

/** One line, at most `n` characters. */
export const clip = (s: unknown, n = 160) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}… (${one.length} chars)` : one;
};

/**
 * Run a call to a tool or service and log its name, how long it took and whether it failed.
 * `failed` reads a failure out of a reply that did not throw (MCP tools report errors that way).
 */
export async function timed<T>(tag: string, label: string, run: () => Promise<T>, opts: { args?: unknown; failed?: (r: T) => string | undefined } = {}): Promise<T> {
  const t0 = Date.now();
  if (opts.args !== undefined) debug(tag, () => `${label} args: ${clip(JSON.stringify(opts.args), 1000)}`);
  try {
    const r = await run();
    const failure = opts.failed?.(r);
    log(tag, `${label} ${failure ? `FAILED: ${clip(failure, 200)}` : 'ok'} (${Date.now() - t0} ms)`);
    debug(tag, () => `${label} reply: ${clip(JSON.stringify(r), 1000)}`);
    return r;
  } catch (e) {
    log(tag, `${label} FAILED after ${Date.now() - t0} ms: ${clip((e as Error).message, 200)}`);
    throw e;
  }
}

/** The error text of an MCP tool result that reports an error, if it does. */
export const mcpFailure = (result: unknown) => {
  const r = result as { isError?: unknown; content?: { text?: string }[] };
  return r.isError ? (r.content ?? []).map((c) => c.text).join(' ') || 'tool reported an error' : undefined;
};
