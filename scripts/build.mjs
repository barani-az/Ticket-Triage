import { cpSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

/** Bundle the Electron main process and preload (CommonJS), and copy the chat page next to them. */
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'info' };

await build({ ...common, entryPoints: ['src/shell/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/shell/preload.ts'], outfile: 'dist/preload.cjs' });

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
