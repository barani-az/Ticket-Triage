import type { Connection } from './connectors/contract.js';
import type { Candidate } from './types.js';

export type RouteResult = { connection: Connection } | { ask: Candidate[] };

/** Which connection is this request for? The first check that gives a confident answer wins. */
export function route(text: string, connections: Connection[]): RouteResult {
  // 1. A connection picked with an @mention.
  const mention = text.match(/@([\w-]+)/)?.[1]?.toLowerCase();
  const mentioned = mention && connections.find((c) => c.id.toLowerCase() === mention);
  if (mentioned) return { connection: mentioned };

  // 2. An item ID in the message (e.g. WEB-123) belongs to one connection.
  const byId = connections.filter((c) => c.connector.manifest.idPatterns.some((p) => p.test(text)));
  if (byId.length === 1) return { connection: byId[0] };

  // 3. Only one connection exists.
  if (connections.length === 1) return { connection: connections[0] };

  // 4. Keywords match exactly one connection.
  const lower = text.toLowerCase();
  const byKeyword = connections.filter((c) =>
    c.connector.manifest.keywords.some((k) => new RegExp(`\\b${k}`).test(lower)),
  );
  if (byKeyword.length === 1) return { connection: byKeyword[0] };

  // 5. Otherwise the first question is "Which tool?".
  return { ask: connections.map((c) => ({ id: c.id, label: c.name, detail: c.connector.manifest.type })) };
}
