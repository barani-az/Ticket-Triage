import fs from 'node:fs';
import { advise, type AdvisorContext, type Turn } from '../src/core/advisor.js';
import { gatewayFromEnv } from '../src/core/llm.js';
import { parseEnv } from '../src/shell/env.js';

/**
 * Runs the two-step screenshot conversation through the real model: first a message that points at the
 * screen (it should ask permission), then the same conversation with the made-up error image attached
 * (it should read the error). Read-only: it never touches Jira. Make the image first with
 * `npx electron scripts/makeErrorShot.cjs`.
 */
const env = { ...process.env, ...parseEnv(fs.readFileSync('.env', 'utf8')) };
const llm = gatewayFromEnv(env);
if (!llm) throw new Error('No GEMINI_API_KEY found in .env');
const image = `data:image/jpeg;base64,${fs.readFileSync('data/test-error-shot.jpg').toString('base64')}`;

const ctx: AdvisorContext = {
  today: new Date().toISOString().slice(0, 10),
  connections: ['Company Jira'],
  projects: ['KAN: My Software Team', 'SAM1: (Example) Billing System Dev'],
  recent: [],
};
const history: Turn[] = [];

const steps: { text: string; images?: string[] }[] = [
  { text: 'I am having an issue on this page, there is an error' },
  { text: 'Here is a screenshot of what I see.', images: [image] },
];

for (const step of steps) {
  const t0 = Date.now();
  const a = await advise(history, step.text, ctx, llm, step.images);
  console.log(`\n> ${step.text}${step.images ? '  [image attached, ' + Math.round(image.length / 1024) + ' KB]' : ''}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!a) {
    console.log('  NO ADVICE');
    continue;
  }
  console.log(`  intent    : ${a.intent}`);
  console.log(`  reply     : ${a.reply}`);
  if (a.reasoning) console.log(`  reasoning : ${a.reasoning}`);
  if (a.ticket) {
    const { description, ...rest } = a.ticket;
    console.log(`  ticket    : ${JSON.stringify(rest)}`);
    if (description) console.log('  description:\n' + description.split('\n').map((l) => '    ' + l).join('\n'));
  }
  history.push({ role: 'user', text: step.images ? `${step.text} [screenshot attached]` : step.text }, { role: 'assistant', text: a.reply });
}
