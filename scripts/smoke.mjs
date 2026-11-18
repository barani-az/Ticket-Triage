import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';

/**
 * Starts the desktop app in smoke mode, once per theme: it loads the window, checks the preload
 * bridge and the connections, types two requests with auto-create forced OFF (nothing is ever
 * created), draws the other states from fixed messages, saves screenshots to
 * data/smoke-<theme>-*.png, prints a report and exits. Set SMOKE_THEMES=dark to run just one.
 */
function run(theme) {
  return new Promise((resolve) => {
    // A separate profile means it never collides with a copy of the app you already have running.
    const profile = mkdtempSync(join(tmpdir(), 'assistant-smoke-'));
    const child = spawn(electron, ['.', `--user-data-dir=${profile}`], {
      env: { ...process.env, SMOKE: '1', SMOKE_THEME: theme },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      console.error(`Smoke test (${theme}) timed out after 120s`);
      child.kill();
    }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

let failed = 0;
for (const theme of (process.env.SMOKE_THEMES ?? 'light,dark').split(',')) failed += (await run(theme)) === 0 ? 0 : 1;
process.exit(failed ? 1 : 0);
