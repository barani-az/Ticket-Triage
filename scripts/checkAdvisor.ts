import fs from 'node:fs';
import { advise, type AdvisorContext, type Turn } from '../src/core/advisor.js';
import { gatewayFromEnv } from '../src/core/llm.js';
import { parseEnv } from '../src/shell/env.js';

/**
 * Runs realistic requests through the real reasoning layer (Gemini) and prints what it decided.
 * Read-only: it never touches Jira, and it sends only these made-up sentences to the model.
 */
const env = { ...process.env, ...parseEnv(fs.readFileSync('.env', 'utf8')) };
const llm = gatewayFromEnv(env);
if (!llm) throw new Error('No GEMINI_API_KEY found in .env');

const ctx: AdvisorContext = {
  today: new Date().toISOString().slice(0, 10),
  connections: ['Company Jira', 'Atlassian Rovo (live)'],
  projects: ['KAN: My Software Team', 'SAM1: (Example) Billing System Dev'],
  recent: ['KAN-7 Update the onboarding checklist'],
};

const history: Turn[] = [];
const prompts = [
  'our login page keeps crashing on safari and customers are complaining',
  'how do I reset my vpn password',
  'something is wrong with checkout',
  'the pay button does nothing on mobile safari, started after yesterday release',
  'I need to write the onboarding docs by friday',
  'someone pasted the staging database password into a public slack channel by mistake',
];

for (const text of prompts) {
  const t0 = Date.now();
  const a = await advise(history, text, ctx, llm);
  console.log(`\n> ${text}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!a) {
    console.log('  NO ADVICE (model failed or returned something unusable)');
    continue;
  }
  console.log(`  intent    : ${a.intent}`);
  console.log(`  reply     : ${a.reply}`);
  if (a.reasoning) console.log(`  reasoning : ${a.reasoning}`);
  if (a.suggestions.length) console.log(`  suggests  : ${a.suggestions.join(' | ')}`);
  if (a.ticket) {
    const { description, ...rest } = a.ticket;
    console.log(`  ticket    : ${JSON.stringify(rest)}`);
    if (description) console.log('  description:\n' + description.split('\n').map((l) => '    ' + l).join('\n'));
  }
  history.push({ role: 'user', text }, { role: 'assistant', text: a.reply });
}
