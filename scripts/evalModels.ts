import fs from 'node:fs';
import { advise, type AdvisorContext } from '../src/core/advisor.js';
import { GEMINI_MODELS, GEMINI_OPENAI_URL, type LlmGateway, OpenAiCompatGateway } from '../src/core/llm.js';
import { parseEnv } from '../src/shell/env.js';

/**
 * Scores the reasoning step on 30 fixed requests, one model at a time: intent, issue type and
 * priority against the expected answer, plus latency. Read-only: it never touches Jira, and it
 * sends only these made-up sentences to the model.
 *
 *   npx tsx scripts/evalModels.ts                 # every model in the Gemini failover list
 *   npx tsx scripts/evalModels.ts gemini-3.5-flash
 */
type Case = { text: string; intent: 'ticket' | 'answer' | 'clarify'; type?: string; priority?: string };

// Priorities follow the advisor's own rubric: Highest = security, outage or data loss; High = users
// blocked or revenue hit; Medium = normal work or a plain deadline; Low = cosmetic.
const CASES: Case[] = [
  { text: "the pay button does nothing on mobile safari since yesterday's release, customers can't check out", intent: 'ticket', type: 'Bug', priority: 'High' },
  { text: 'someone pasted the staging database password into a public slack channel', intent: 'ticket', priority: 'Highest' },
  { text: 'the whole website is down, every page returns 502', intent: 'ticket', type: 'Bug', priority: 'Highest' },
  { text: 'I need to write the onboarding docs by friday', intent: 'ticket', type: 'Task', priority: 'Medium' },
  { text: "typo on the pricing page: 'anual' should be 'annual'", intent: 'ticket', type: 'Bug', priority: 'Low' },
  { text: 'add dark mode to the settings screen', intent: 'ticket', type: 'Story', priority: 'Medium' },
  { text: 'create a bug in KAN for the export to CSV button timing out on large reports', intent: 'ticket', type: 'Bug' },
  { text: 'invoices are being emailed to the wrong customers', intent: 'ticket', type: 'Bug', priority: 'Highest' },
  { text: 'please set up a new laptop for Priya who joins on monday', intent: 'ticket', type: 'Task' },
  { text: 'users want to be able to export their data as PDF', intent: 'ticket', type: 'Story', priority: 'Medium' },
  { text: 'the logo on the login page is slightly blurry on retina screens', intent: 'ticket', type: 'Bug', priority: 'Low' },
  { text: 'search takes 30 seconds to load for every user since this morning', intent: 'ticket', type: 'Bug', priority: 'High' },
  { text: 'renew the SSL certificate for api.example.com before it expires next week', intent: 'ticket', type: 'Task' },
  { text: "log a task to archive last year's sprint boards, assign it to Arjun", intent: 'ticket', type: 'Task', priority: 'Medium' },
  { text: 'how do I reset my vpn password', intent: 'answer' },
  { text: "what's the difference between a bug and a story in jira?", intent: 'answer' },
  { text: 'how should I write good steps to reproduce?', intent: 'answer' },
  { text: 'what does priority Highest mean?', intent: 'answer' },
  { text: 'can you explain what an epic is', intent: 'answer' },
  { text: "what's today's date?", intent: 'answer' },
  { text: 'which projects can I create tickets in?', intent: 'answer' },
  { text: "thanks, that's all", intent: 'answer' },
  { text: 'how do I share my outlook calendar with a colleague', intent: 'answer' },
  { text: 'something is wrong with checkout', intent: 'clarify' },
  { text: "it's broken again", intent: 'clarify' },
  { text: 'create a ticket', intent: 'clarify' },
  { text: 'the app is slow', intent: 'clarify' },
  { text: 'fix the thing from the meeting', intent: 'clarify' },
  { text: 'log a bug', intent: 'clarify' },
  { text: "there's an issue with the report", intent: 'clarify' },
];

const env = { ...process.env, ...parseEnv(fs.readFileSync('.env', 'utf8')) };
if (!env.GEMINI_API_KEY) throw new Error('No GEMINI_API_KEY found in .env');
const models = process.argv.length > 2 ? process.argv.slice(2) : GEMINI_MODELS;

const ctx: AdvisorContext = {
  today: new Date().toISOString().slice(0, 10),
  connections: ['Atlassian Rovo (live)'],
  projects: ['KAN: My Software Team', 'WEB: Website', 'OPS: IT Operations'],
  recent: ['KAN-7 Update the onboarding checklist'],
};
const PAUSE_MS = 6_000; // stays under the free tier's per-model requests-per-minute limit

async function score(model: string) {
  const inner = new OpenAiCompatGateway({ baseUrl: GEMINI_OPENAI_URL, model, apiKey: env.GEMINI_API_KEY });
  // advise() swallows errors, so keep the last one to tell a rate limit from an unusable answer.
  let lastError = '';
  const llm: LlmGateway = { extractJson: (o) => inner.extractJson(o).catch((e: Error) => { lastError = e.message; throw e; }) };
  const ms: number[] = [];
  const misses: string[] = [];
  let failed = 0, intent = 0, type = 0, priority = 0;
  for (const c of CASES) {
    lastError = '';
    const t0 = Date.now();
    const a = await advise([], c.text, ctx, llm); // each request on its own, no shared history
    ms.push(Date.now() - t0);
    if (!a) failed++;
    const got = { intent: a?.intent, type: a?.ticket?.issuetype, priority: a?.ticket?.priority };
    const ok = {
      intent: got.intent === c.intent,
      type: !c.type || got.type === c.type,
      priority: !c.priority || got.priority === c.priority,
    };
    intent += +ok.intent;
    type += +(c.type ? ok.type : 0);
    priority += +(c.priority ? ok.priority : 0);
    if (!ok.intent || !ok.type || !ok.priority) {
      const want = [c.intent, c.type, c.priority].filter(Boolean).join('/');
      const have = a ? [got.intent, got.type, got.priority].filter(Boolean).join('/') : `no answer: ${lastError.slice(0, 70) || 'unusable JSON'}`;
      misses.push(`| ${model} | ${c.text} | ${want} | ${have} |`);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  ms.sort((a, b) => a - b);
  const sec = (v: number) => (v / 1000).toFixed(1) + 's';
  const n = (f: (c: Case) => unknown) => CASES.filter(f).length;
  const row = `| ${model} | ${intent}/${CASES.length} | ${type}/${n((c) => c.type)} | ${priority}/${n((c) => c.priority)} | ${failed} | ${sec(ms[Math.floor(ms.length / 2)])} | ${sec(ms[Math.ceil(ms.length * 0.9) - 1])} |`;
  return { row, misses };
}

// Each model has its own rate limit, so they run side by side.
const results = await Promise.all(models.map(score));
console.log(`Run on ${ctx.today}, ${CASES.length} requests per model.\n`);
console.log('| Model | Intent | Issue type | Priority | No answer | Median | p90 |\n|---|---|---|---|---|---|---|');
for (const r of results) console.log(r.row);
console.log('\n| Model | Request | Expected | Got |\n|---|---|---|---|');
for (const r of results) for (const m of r.misses) console.log(m);
