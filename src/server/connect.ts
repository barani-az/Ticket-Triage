import type { Connection } from '../core/connectors/contract.js';
import type { ConnectHooks, ConnectTool, SignInStart, ToolStatus } from '../core/session.js';

export interface ConnectDeps {
  /** The app's live connection list. A finished sign-in adds its connection, replacing an older one. */
  connections: Connection[];
  /** Sign in to Atlassian in the browser (or reuse a saved sign-in) and return the Rovo connection. */
  rovo(opts: { onUrl: (url: string) => void; signal: AbortSignal }): Promise<Connection>;
}

/** Which connection each /connect tool becomes. */
const CONNECTION_ID: Record<ConnectTool, string> = { m365: 'm365', jira: 'rovo' };

interface Pending {
  done: Promise<string>;
  cancel: () => void;
}

/** The sign-in side of /connect: starts each sign-in, and adds the connection when it finishes. */
export function createConnect(d: ConnectDeps): ConnectHooks {
  const pending = new Map<ConnectTool, Pending>();

  const replace = async (conn: Connection) => {
    const i = d.connections.findIndex((c) => c.id === conn.id);
    if (i < 0) return void d.connections.push(conn);
    await d.connections[i].connector.close?.().catch(() => undefined);
    d.connections.splice(i, 1, conn);
  };

  /** Once signed in: check who we are, then make the connection live. */
  const goLive = async (conn: Connection, service: string) => {
    const st = await conn.connector.testConnection();
    if (!st.ok) {
      await conn.connector.close?.().catch(() => undefined);
      throw new Error(st.error);
    }
    await replace(conn);
    return `${service} as ${st.actingAs}`;
  };

  return {
    async status() {
      return Promise.all(
        (['m365', 'jira'] as ConnectTool[]).map(async (tool): Promise<ToolStatus> => {
          const conn = d.connections.find((c) => c.id === CONNECTION_ID[tool]);
          if (!conn) return { tool, connected: false, detail: 'not connected' };
          const st = await conn.connector.testConnection();
          if (st.ok) return { tool, connected: true, detail: `connected as ${st.actingAs}` };
          return { tool, connected: false, detail: st.needsReauth ? 'needs sign-in again' : `not reachable: ${st.error}` };
        }),
      );
    },

    async start(tool): Promise<SignInStart> {
      pending.get(tool)?.cancel();
      if (tool !== 'jira') throw new Error('Microsoft 365 sign-in is not set up yet.');
      const ac = new AbortController();
      let showUrl!: (url: string) => void;
      const urlShown = new Promise<string>((r) => (showUrl = r));
      const signedIn = d.rovo({ onUrl: (url) => showUrl(url), signal: ac.signal });
      const done = signedIn.then((conn) => goLive(conn, 'Jira Cloud'));
      done.catch(() => undefined); // finish() reports it; this only avoids an unhandled rejection meanwhile
      pending.set(tool, { done, cancel: () => ac.abort() });
      // The browser opens (we get its address), or a saved sign-in is still valid and no browser is needed.
      return Promise.race([urlShown.then((url) => ({ how: 'browser' as const, url })), signedIn.then(() => ({ how: 'ready' as const }))]);
    },

    async finish(tool) {
      const p = pending.get(tool);
      if (!p) throw new Error('No sign-in is in progress.');
      try {
        return await p.done;
      } finally {
        if (pending.get(tool) === p) pending.delete(tool);
      }
    },

    cancel(tool) {
      pending.get(tool)?.cancel();
      pending.delete(tool);
    },
  };
}
