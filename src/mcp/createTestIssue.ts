import path from 'node:path';
import { RovoJiraConnector, ROVO_URL } from '../core/connectors/rovo.js';
import { AuditLog } from '../core/executor.js';
import { Session } from '../core/session.js';
import { connectRemoteMcp } from './remote.js';

/**
 * Creates ONE real test task through the full session flow (understand -> card -> confirm) and
 * prints the raw createJiraIssue response so the connector's parsing can be checked.
 * Single attempt, no retry.
 */
const client = await connectRemoteMcp({
  url: ROVO_URL,
  storeFile: path.resolve('data', 'rovo-oauth.json'),
  interactive: false,
});

const realCall = client.callTool.bind(client);
let raw: unknown;
(client as { callTool: typeof client.callTool }).callTool = async (params, ...rest) => {
  const res = await realCall(params, ...rest);
  if (params.name === 'createJiraIssue') raw = res;
  return res;
};

const rovo = new RovoJiraConnector(client);
const session = new Session({
  connections: [{ id: 'rovo', name: 'Atlassian Rovo (live)', readOnly: false, connector: rovo }],
  audit: new AuditLog(path.resolve('data', 'audit.jsonl')),
});

const request = '@rovo create a task in KAN for Assistant demo test - safe to delete';
const msgs = await session.handle({ type: 'submit', text: request });
const card = msgs.find((m) => m.type === 'card');
if (!card || card.type !== 'card' || !card.canConfirm) {
  console.log('Did not reach a confirmable card:', JSON.stringify(msgs, null, 2));
  await client.close();
  process.exit(1);
}
console.log('CARD:', JSON.stringify(card.card, null, 2));

const result = await session.handle({ type: 'confirm' });
console.log('\nRESULT:', JSON.stringify(result));
console.log('\nRAW createJiraIssue RESPONSE:', JSON.stringify(raw, null, 2));
await client.close();
