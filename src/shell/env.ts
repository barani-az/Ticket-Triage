/**
 * Minimal .env reader so the Gemini key can live in a git-ignored file instead of being typed
 * into a terminal or chat. Lines are KEY=VALUE; # starts a comment; surrounding quotes are removed.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) out[key] = value;
  }
  return out;
}
