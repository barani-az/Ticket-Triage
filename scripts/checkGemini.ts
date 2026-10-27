import fs from 'node:fs';
import { gatewayFromEnv } from '../src/core/llm.js';
import { parseEnv } from '../src/shell/env.js';
import { understand, understandWithRules } from '../src/core/understand.js';

/**
 * Reads .env, then runs several phrasings through Gemini and through the built-in rules and prints
 * both side by side. Read-only: it never touches Jira, and it never prints the key.
 */
const env = { ...process.env, ...parseEnv(fs.readFileSync('.env', 'utf8')) };
const llm = gatewayFromEnv(env);
if (!llm) throw new Error('No GEMINI_API_KEY found in .env');
console.log(`Model: ${env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite (default, with fallbacks)'}`);

const phrasings = [
  'Create a bug for the login page crashing on Safari, high priority, frontend team',
  'can you log a story in KAN so we remember to add dark mode to the settings screen',
  'checkout is broken on mobile, make it urgent and give it to Priya',
  'new task: rotate the staging database credentials by Friday, low priority',
  'Raise a ticket in WEB - footer links 404 on the pricing page. High prio. Assign to Arjun Rao',
];

const show = (u: Awaited<ReturnType<typeof understand>>) =>
  `${u.operation} | ` + Object.entries(u.fields).map(([k, v]) => `${k}=${JSON.stringify(v.value)}`).join(', ');

for (const text of phrasings) {
  console.log(`\n> ${text}`);
  console.log(`  rules : ${show(understandWithRules(text))}`);
  try {
    // understand() swallows LLM failures and falls back to rules, so call the gateway directly to see errors
    const raw = await llm.extractJson({
      system: 'Extract a Jira request as JSON: {"operation":"create"|"read"|"unknown","fields":{"issuetype":string?,"summary":string?,"priority":string?,"project":string?,"assignee":string?,"components":string?,"description":string?}}. Use only what the user wrote. Omit anything not stated. Never invent values.',
      user: text,
    });
    console.log(`  gemini: ${JSON.stringify(raw)}`);
    console.log(`  merged: ${show(await understand(text, llm))}`);
  } catch (e) {
    console.log(`  gemini ERROR: ${(e as Error).message}`);
    break;
  }
}
