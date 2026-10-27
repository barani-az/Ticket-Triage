import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Connection } from '../core/connectors/contract.js';
import { JiraConnector } from '../core/connectors/jira.js';
import { McpConnector } from '../core/connectors/mcp.js';
import { ROVO_URL, RovoJiraConnector } from '../core/connectors/rovo.js';
import { AuditLog } from '../core/executor.js';
import { gatewayFromEnv } from '../core/llm.js';
import { Session } from '../core/session.js';
import { connectRemoteMcp } from '../mcp/remote.js';
import { startMockJira } from '../mock/jiraMock.js';

export interface AppOptions {
  /** Where sign-in, audit and other local data live. */
  dataDir: string;
  /** Project root; needed only to spawn our own MCP server over stdio. */
  root?: string;
  /** Start our own Jira MCP server as a child process (web demo only). */
  stdioMcp?: boolean;
  /** Create complete drafts without the confirm click. Read on every request. */
  autoCreate?: () => boolean;
}

export type App = Awaited<ReturnType<typeof createApp>>;

/**
 * Wires the connections. By default: the mock Jira (direct, plus our MCP server if `stdioMcp`),
 * and Atlassian's live Rovo connection when a saved sign-in exists. ROVO_ONLY=1 drops the mocks.
 */
export async function createApp(env: NodeJS.ProcessEnv, opts: AppOptions) {
  const connections: Connection[] = [];
  let baseUrl = env.JIRA_BASE_URL ?? '';
  let closeMock: (() => Promise<void>) | undefined;
  const rovoStore = path.join(opts.dataDir, 'rovo-oauth.json');

  if (env.ROVO_ONLY !== '1') {
    if (!baseUrl) {
      // Port 0 = any free port, so a second copy of the app (or anything on 4010) cannot block startup.
      const mock = await startMockJira(Number(env.MOCK_JIRA_PORT ?? 0));
      baseUrl = mock.baseUrl;
      closeMock = mock.close;
    }
    const flavor = env.JIRA_FLAVOR === 'datacenter' ? 'datacenter' : 'cloud';
    const token = env.JIRA_TOKEN ?? 'demo-token';
    connections.push({
      id: 'jira',
      name: 'Company Jira',
      readOnly: false,
      connector: new JiraConnector({ baseUrl, flavor, email: env.JIRA_EMAIL, token }),
    });

    if (opts.stdioMcp && opts.root) {
      const client = new Client({ name: 'assistant', version: '0.0.1' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', path.join(opts.root, 'src', 'mcp', 'jiraServerMain.ts')],
          cwd: opts.root,
          env: {
            ...(process.env as Record<string, string>),
            JIRA_BASE_URL: baseUrl,
            JIRA_FLAVOR: flavor,
            JIRA_TOKEN: token,
            ...(env.JIRA_EMAIL ? { JIRA_EMAIL: env.JIRA_EMAIL } : {}),
          },
        }),
      );
      connections.push({ id: 'jira-mcp', name: 'Company Jira (MCP)', readOnly: false, connector: new McpConnector(client) });
    }
  }

  /** Connect to Atlassian Rovo. Interactive opens the browser; otherwise a saved sign-in is required. */
  async function connectRovo(interactive: boolean, log?: (l: string) => void): Promise<Connection> {
    const client = await connectRemoteMcp({ url: ROVO_URL, storeFile: rovoStore, interactive, log });
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

  const audit = new AuditLog(path.join(opts.dataDir, 'audit.jsonl'));
  const llm = gatewayFromEnv(env);
  const session = new Session({ connections, audit, llm, autoCreate: opts.autoCreate });

  return {
    baseUrl: baseUrl || 'https://mcp.atlassian.com',
    usesMock: Boolean(closeMock),
    session,
    connections,
    audit,
    llmEnabled: Boolean(llm),
    rovoError,
    /** Sign in to Rovo (opens the browser) and add it as a connection. */
    async addRovo(log?: (l: string) => void) {
      if (connections.some((c) => c.id === 'rovo')) return;
      connections.push(await connectRovo(true, log));
    },
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
      await Promise.all(connections.map((c) => c.connector.close?.()));
      await closeMock?.();
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
  if (!out.length) out.push('create a task for update the onboarding checklist');
  return out.slice(0, 3);
}
