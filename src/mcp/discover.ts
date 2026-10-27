import fs from 'node:fs';
import path from 'node:path';
import { connectRemoteMcp } from './remote.js';

/**
 * Connects to a remote MCP server (default: Atlassian's), signs in, and saves every tool's
 * name and input schema to data/<name>-tools.json. This lets us see the real schemas before
 * mapping them to the questionnaire. The file holds tool definitions only, not tokens.
 */
const url = process.argv[2] ?? 'https://mcp.atlassian.com/v2/mcp?tools=all';
const name = process.argv[3] ?? 'rovo';
const dataDir = path.resolve('data');

const client = await connectRemoteMcp({
  url,
  storeFile: path.join(dataDir, `${name}-oauth.json`),
  log: (l) => console.log(l),
});
console.log(`Connected to ${client.getServerVersion()?.name ?? url}`);

const tools = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor ? { cursor } : undefined);
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);

fs.mkdirSync(dataDir, { recursive: true });
const out = path.join(dataDir, `${name}-tools.json`);
fs.writeFileSync(out, JSON.stringify(tools, null, 2));
console.log(`${tools.length} tools saved to ${out}`);
for (const t of tools) console.log(` - ${t.name}${t.annotations?.readOnlyHint ? '  (read-only)' : ''}`);
await client.close();
