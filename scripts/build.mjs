import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

/**
 * Bundle the Electron main process and preload (CommonJS), and copy the chat page next to them.
 *
 * src/shell/demo.ts (the demo-video recorder) is optional: if the file is absent the app still
 * builds, and only DEMO=1 mode fails, with a clear message.
 */
const optionalDemo = {
  name: 'optional-demo',
  setup(b) {
    b.onResolve({ filter: /^\.\/demo\.js$/ }, (args) => {
      if (existsSync(resolve(args.resolveDir, 'demo.ts'))) return null;
      return { path: 'demo-missing', namespace: 'optional-demo' };
    });
    b.onLoad({ filter: /.*/, namespace: 'optional-demo' }, () => ({
      contents: "export async function recordDemo() { throw new Error('The demo recorder (src/shell/demo.ts) is not in this checkout.'); }",
      loader: 'js',
    }));
  },
};

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'info', plugins: [optionalDemo] };

await build({ ...common, entryPoints: ['src/shell/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/shell/preload.ts'], outfile: 'dist/preload.cjs' });

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
