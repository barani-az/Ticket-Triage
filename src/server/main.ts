import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UiToCore } from '../core/session.js';
import { createApp } from './app.js';

/** Browser version of the chat window, for development without Electron. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.PORT ?? 4000);
const autoCreate = process.env.AUTO_CREATE !== '0';
const app = await createApp(process.env, {
  dataDir: path.join(root, 'data'),
  root,
  stdioMcp: true,
  autoCreate: () => autoCreate,
});

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = async (req: http.IncomingMessage) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/connections') return json(res, 200, await app.describe());
    if (req.method === 'GET' && url.pathname === '/api/audit') return json(res, 200, app.audit.list());
    if (req.method === 'POST' && url.pathname === '/api/message') {
      return json(res, 200, await app.session.handle((await readBody(req)) as UiToCore));
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Assistant (browser): http://127.0.0.1:${port}`);
  console.log(`Connections:         ${app.connections.map((c) => c.name).join(', ')}`);
  console.log(`LLM:                 ${app.llmEnabled ? 'enabled' : 'off (built-in rules)'}`);
  console.log(`Auto-create:         ${autoCreate ? 'on' : 'off'}`);
  if (app.rovoError) console.log(`Rovo skipped:        ${app.rovoError}`);
});

const shutdown = async () => {
  server.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
