import path from 'node:path';
import { ROVO_URL } from '../core/connectors/rovo.js';
import { connectRemoteMcp } from './remote.js';

/** READ-ONLY: fetch one issue by key to confirm it exists. Usage: tsx src/mcp/readIssue.ts KAN-4 */
const key = process.argv[2];
if (!key) throw new Error('Usage: readIssue.ts <ISSUE-KEY>');
const client = await connectRemoteMcp({ url: ROVO_URL, storeFile: path.resolve('data', 'rovo-oauth.json'), interactive: false });
const res = await client.callTool({ name: 'getAccessibleAtlassianResources', arguments: {} });
const text = (res.content as { text?: string }[]).map((c) => c.text).join('');
const cloudId = JSON.parse(text).data.resources[0].cloudId;
const issue = await client.callTool({ name: 'getJiraIssue', arguments: { cloudId, issueIdOrKey: key, fields: ['summary', 'issuetype', 'status', 'project'] } });
console.log(((issue.content as { text?: string }[]) ?? []).map((c) => c.text).join('').slice(0, 900));
await client.close();
