import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '../core/connectors/contract.js';
import { ROVO_URL, RovoJiraConnector } from '../core/connectors/rovo.js';
import { AuditLog } from '../core/executor.js';
import { gatewayFromEnv } from '../core/llm.js';
import { configureLog, log } from '../core/log.js';
import { Session } from '../core/session.js';
import { connectMs365, followMs365Log } from '../mcp/ms365Server.js';
import { createConnect } from './connect.js';
import { connectRemoteMcp } from '../mcp/remote.js';

export interface AppOptions {
  /** Where sign-in, audit and other local data live. */
  dataDir: string;
  /** Project root, to start the Microsoft 365 server from node_modules (default: the current directory). */
  root?: string;
  /** Create complete drafts without the confirm click. Read on every request. */
  autoCreate?: () => boolean;
}

export type App = Awaited<ReturnType<typeof createApp>>;

/**
 * Wires the connections: Atlassian Rovo (Jira) and Microsoft 365, each when /connect has signed in
 * before. With neither, the app starts with no connections and asks the user to /connect.
 */
export async function createApp(env: NodeJS.ProcessEnv, opts: AppOptions) {
  configureLog(env.LOG);
  log('app', `starting (data in ${opts.dataDir})`);
  const connections: Connection[] = [];
  const rovoStore = path.join(opts.dataDir, 'rovo-oauth.json');

  /** Connect to Atlassian Rovo. Interactive opens the browser; otherwise a saved sign-in is required. */
  async function connectRovo(interactive: boolean, extra: { onUrl?: (url: string) => void; signal?: AbortSignal } = {}): Promise<Connection> {
    const client = await connectRemoteMcp({ url: ROVO_URL, storeFile: rovoStore, interactive, ...extra });
    return {
      id: 'rovo',
      name: 'Atlassian Rovo (live)',
      readOnly: env.ROVO_READONLY === '1',
      connector: new RovoJiraConnector(client, { cloudId: env.ROVO_CLOUD_ID }),
    };
  }

  let rovoError: string | undefined;
  if (fs.existsSync(rovoStore)) {
    try {
      connections.push(await connectRovo(false));
    } catch (e) {
      rovoError = (e as Error).message;
    }
  }

  // What /connect remembers between launches (no secrets: tokens stay in each service's own store).
  const savedFile = path.join(opts.dataDir, 'connections.json');
  let saved: { m365?: { work: boolean } } = {};
  try {
    saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
  } catch {
    /* first launch */
  }
  const root = opts.root ?? process.cwd();
  // A personal account needs the "consumers" authority, or its sign-in stops working after about an hour.
  const ms365Env = (work: boolean) => ({ ...env, M365_WORK: work ? '1' : '0', M365_TENANT_ID: env.M365_TENANT_ID ?? (work ? undefined : 'consumers') });

  // The Microsoft 365 server can only log to a file, so its lines are followed into this log.
  const say = (tag: string) => (line: string) => log(tag, line);
  const stopLog = env.LOG === '0' || env.LOG === 'off' ? undefined : followMs365Log(say('ms365-server'));

  let m365Error: string | undefined;
  if (env.M365 === '1' || saved.m365) {
    try {
      const work = env.M365_WORK !== undefined ? env.M365_WORK === '1' : Boolean(saved.m365?.work);
      connections.push(await connectMs365(root, ms365Env(work), { log: say('ms365-server') }));
    } catch (e) {
      m365Error = (e as Error).message;
    }
  }

  const audit = new AuditLog(path.join(opts.dataDir, 'audit.jsonl'));
  const llm = gatewayFromEnv(env);
  const connect = createConnect({
    connections,
    rovo: (o) => connectRovo(true, o),
    ms365: ({ work, deviceCode }) => connectMs365(root, ms365Env(work), { deviceCode, log: say('ms365-server') }),
    log: say('connect'),
    ms365Browser: Boolean(env.M365_CLIENT_ID),
    remember: (tool, settings) => {
      if (tool === 'jira') {
        if (!settings) fs.rmSync(rovoStore, { force: true }); // signing out of Jira forgets its tokens
        return;
      }
      saved = { ...saved, m365: settings };
      if (!settings) delete saved.m365;
      fs.mkdirSync(opts.dataDir, { recursive: true });
      fs.writeFileSync(savedFile, JSON.stringify(saved, null, 2));
    },
  });
  const session = new Session({ connections, audit, llm, autoCreate: opts.autoCreate, connect });
  log('app', `ready: connections ${connections.map((c) => `${c.name}${c.readOnly ? ' (read-only)' : ''}`).join(', ') || 'none'}; AI ${llm ? 'on' : 'off (built-in rules)'}`);
  if (rovoError) log('app', `Atlassian Rovo not connected: ${rovoError}`);
  if (m365Error) log('app', `Microsoft 365 not connected: ${m365Error}`);

  return {
    session,
    connections,
    audit,
    llmEnabled: Boolean(llm),
    rovoError,
    m365Error,
    /** What the UI shows: each connection's health, whether an LLM is on, and example requests. */
    async describe() {
      const list = await Promise.all(
        connections.map(async (c) => ({
          id: c.id,
          name: c.name,
          type: c.connector.manifest.type,
          basic: Boolean(c.connector.manifest.basic),
          live: Boolean(c.connector.manifest.live),
          status: await c.connector.testConnection(),
        })),
      );
      return {
        connections: list,
        llm: Boolean(llm),
        autoCreate: opts.autoCreate?.() ?? false,
        examples: await examples(connections),
      };
    },
    async close() {
      stopLog?.();
      await Promise.all(connections.map((c) => c.connector.close?.()));
    },
  };
}

/** Example requests that fit the connected tools, so the suggestions never name projects that don't exist. */
async function examples(connections: Connection[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of connections) {
    try {
      const first = (await c.connector.lookup('project', ''))[0];
      if (!first) continue;
      const prefix = connections.length > 1 ? `@${c.id} ` : '';
      out.push(`${prefix}create a task in ${first.id} for update the onboarding checklist`);
    } catch {
      /* the connection is unhealthy; it shows in the status badges */
    }
  }
  if (connections.some((c) => c.connector.manifest.type === 'ms365')) {
    out.splice(1, 0, 'make a ticket from the latest email about a bug');
    out.push('email the team that the release moved to Friday');
  }
  if (!out.length) out.push('create a task for update the onboarding checklist');
  return out.slice(0, 3);
}
