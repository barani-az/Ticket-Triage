import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Connection } from '../core/connectors/contract.js';
import { ms365Args, Ms365Connector } from '../core/connectors/ms365.js';

/**
 * Starts Softeria's ms-365-mcp-server (pinned in package.json) as a child process over stdio.
 * Settings, read from .env:
 *   M365=1            turn the connection on
 *   M365_WORK=1       work or school account: adds Teams and people lookups
 *   M365_TENANT_ID    "consumers" for a personal account; your tenant ID for a work account
 *   M365_CLIENT_ID    your own Entra app registration (default: the server's built-in app)
 *   M365_READONLY=1   refuse every write
 *   M365_TIME_ZONE    IANA zone for meeting times (default: this machine's)
 * Sign-in tokens are kept by the server in its own encrypted cache, outside this repo.
 */
export function ms365Command(root: string, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const work = env.M365_WORK === '1';
  return {
    // In the desktop app process.execPath is Electron; ELECTRON_RUN_AS_NODE makes it plain Node.
    command: process.execPath,
    args: [path.join(root, 'node_modules', '@softeria', 'ms-365-mcp-server', 'dist', 'index.js'), ...extra, ...ms365Args(work)],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RUN_AS_NODE: '1',
      MS365_MCP_REQUIRE_CONFIRM: 'true', // the server refuses any write without confirm: true
      ...(env.M365_TENANT_ID ? { MS365_MCP_TENANT_ID: env.M365_TENANT_ID } : {}),
      ...(env.M365_CLIENT_ID ? { MS365_MCP_CLIENT_ID: env.M365_CLIENT_ID } : {}),
    },
    work,
  };
}

/**
 * Start the server for one account kind. Sign-in opens Microsoft's page in the browser and comes back to
 * a local address (--auth-browser); with `deviceCode` it gives a code to enter on Microsoft's page instead.
 */
export async function connectMs365(
  root: string,
  env: NodeJS.ProcessEnv,
  opts: { deviceCode?: boolean; log?: (line: string) => void } = {},
): Promise<Connection> {
  const { command, args, env: childEnv, work } = ms365Command(root, env, opts.deviceCode ? [] : ['--auth-browser']);
  const client = new Client({ name: 'ticket-triage', version: '0.0.1' });
  const transport = new StdioClientTransport({ command, args, env: { ...childEnv, SILENT: 'true' }, stderr: opts.log ? 'pipe' : 'ignore' });
  // Its stderr carries only startup problems and crashes; everything else goes to its log file (followMs365Log).
  transport.stderr?.on('data', (d: Buffer) => d.toString().split('\n').filter((l) => l.trim()).forEach((l) => opts.log!(l)));
  await client.connect(transport);
  return {
    id: 'm365',
    name: 'Microsoft 365',
    readOnly: env.M365_READONLY === '1',
    connector: new Ms365Connector(client, { work, timeZone: env.M365_TIME_ZONE }),
  };
}

/**
 * Print what the Microsoft 365 server logs. It can't log to the console (its stdout is the MCP channel), so
 * it writes to a file; this follows the file from now on. Tokens and email addresses are redacted by the server.
 */
export function followMs365Log(print: (line: string) => void): () => void {
  const file = path.join(process.env.MS365_MCP_LOG_DIR || path.join(os.homedir(), '.ms-365-mcp-server', 'logs'), 'mcp-server.log');
  let pos = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const read = () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < pos) pos = 0; // the log was rotated
    if (size === pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    for (const line of buf.toString('utf8').split('\n')) if (line.trim()) print(line);
  };
  fs.watchFile(file, { interval: 1000 }, read);
  return () => fs.unwatchFile(file, read);
}
