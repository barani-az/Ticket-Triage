import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JiraConnector } from '../tests/helpers/jiraConnector.js';
import { AuditLog } from '../src/core/executor.js';
import { gatewayFromEnv } from '../src/core/llm.js';
import { Session, type CoreToUi, type UiToCore } from '../src/core/session.js';
import { startMockJira } from '../tests/helpers/jiraMock.js';
import { parseEnv } from '../src/shell/env.js';

/**
 * A whole conversation through the real model, against the MOCK Jira only (nothing real is touched):
 * point at an error, attach the made-up screenshot, change the draft by talking, ask a side question,
 * then say "create it". Make the image first with `npx electron scripts/makeErrorShot.cjs`.
 */
const env = { ...process.env, ...parseEnv(fs.readFileSync('.env', 'utf8')) };
const llm = gatewayFromEnv(env);
if (!llm) throw new Error('No GEMINI_API_KEY found in .env');
const image = `data:image/jpeg;base64,${fs.readFileSync('data/test-error-shot.jpg').toString('base64')}`;

const mock = await startMockJira(0);
const session = new Session({
  connections: [{ id: 'jira', name: 'Company Jira', readOnly: false, connector: new JiraConnector({ baseUrl: mock.baseUrl, flavor: 'cloud', token: 't' }) }],
  audit: new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')), 'audit.jsonl')),
  llm,
  autoCreate: () => true, // on purpose: a draft under discussion must still wait to be told
});

let question: Extract<CoreToUi, { type: 'question' }>['question'] | undefined;

function show(msgs: CoreToUi[]) {
  question = undefined;
  for (const m of msgs) {
    if (m.type === 'assistant') console.log(`  bot      : ${m.text}${m.action ? '   [asks permission to take a screenshot]' : ''}`);
    else if (m.type === 'question') {
      question = m.question;
      console.log(`  question : ${m.question.text} [${m.question.choices.map((c) => c.label).join(' / ')}]`);
    } else if (m.type === 'card') console.log(`  card     : ${m.card.rows.map((r) => `${r.title}=${r.value.replace(/\s+/g, ' ').slice(0, 70)}`).join(' | ')}`);
    else if (m.type === 'result') console.log(`  RESULT   : ${m.ok ? m.text : 'not created: ' + m.text}`);
    else if (m.type === 'error') console.log(`  error    : ${m.message}`);
  }
}

async function say(msg: UiToCore, label: string) {
  const t = Date.now();
  console.log(`\n> ${label}`);
  show(await session.handle(msg));
  console.log(`  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  // Answer the app's own confirmation questions by taking the first choice, as a user would.
  for (let i = 0; i < 3 && question && question.choices.length; i++) {
    const c = question.choices[0];
    console.log(`> [picks "${c.label}"]`);
    show(await session.handle({ type: 'answer', choiceId: c.id }));
  }
}

await say({ type: 'submit', text: 'I am having an issue on this page, there is an error' }, 'I am having an issue on this page, there is an error');
await say({ type: 'submit', text: 'Here is a screenshot of what I see.', images: [image] }, '[screenshot attached]');
await say({ type: 'submit', text: "make it highest priority, and add that it started after yesterday's release" }, "make it highest priority, and add that it started after yesterday's release");
await say({ type: 'submit', text: 'why did you pick that type?' }, 'why did you pick that type?');
console.log(`\n(created so far in the mock: ${mock.issues.length})`);
await say({ type: 'submit', text: 'create it' }, 'create it');
console.log(`\n(created in the mock: ${mock.issues.length})`);
if (mock.issues.length) console.log(JSON.stringify(mock.issues.at(-1)?.fields, null, 1).slice(0, 900));
await mock.close();
