import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';

/**
 * Starts the desktop app once in smoke mode: it loads the window, checks the preload bridge and
 * the connections, sends one request with auto-create forced OFF (nothing is ever created),
 * prints a report and exits.
 */
// A separate profile means it never collides with a copy of the app you already have running.
const profile = mkdtempSync(join(tmpdir(), 'assistant-smoke-'));
const child = spawn(electron, ['.', `--user-data-dir=${profile}`], { env: { ...process.env, SMOKE: '1' }, stdio: 'inherit' });
const timer = setTimeout(() => {
  console.error('Smoke test timed out after 90s');
  child.kill();
}, 90_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
