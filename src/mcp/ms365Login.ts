import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseEnv } from '../shell/env.js';
import { ms365Command } from './ms365Server.js';

/**
 * One-time Microsoft 365 sign-in (device code): prints a URL and a code to enter there.
 * Uses the same enabled tools as the app, so Microsoft is asked for exactly the permissions it uses.
 */
const env = { ...process.env, ...(fs.existsSync('.env') ? parseEnv(fs.readFileSync('.env', 'utf8')) : {}) };
const { command, args, env: childEnv, work } = ms365Command(process.cwd(), env, ['--login']);
console.log(`Signing in to Microsoft 365 (${work ? 'work or school account, with Teams' : 'personal account'})...`);
const r = spawnSync(command, args, { stdio: 'inherit', env: childEnv });
process.exit(r.status ?? 1);
