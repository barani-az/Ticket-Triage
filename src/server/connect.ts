import type { Connection } from '../core/connectors/contract.js';
import type { Ms365Connector } from '../core/connectors/ms365.js';
import type { ConnectHooks, ConnectTool, SignInStart, ToolStatus } from '../core/session.js';

export interface ConnectDeps {
  /** The app's live connection list. A finished sign-in adds its connection, replacing an older one. */
  connections: Connection[];
  /** Sign in to Atlassian in the browser (or reuse a saved sign-in) and return the Rovo connection. */
  rovo(opts: { onUrl: (url: string) => void; signal: AbortSignal }): Promise<Connection>;
  /** Start the Microsoft 365 server for one account kind (not signed in yet). */
  ms365(opts: { work: boolean; deviceCode: boolean }): Promise<Connection>;
  /** How often to check whether a sign-in code has been entered (default 3 s). */
  pollMs?: number;
  /**
   * Microsoft's browser sign-in returns to http://localhost, which only an app registration that lists it
   * accepts: our own (M365_CLIENT_ID). The server's ready-made app rejects it ("redirect_uri is not
   * valid"), so without our own registration Microsoft 365 always signs in with a code.
   */
  ms365Browser?: boolean;
  /**
   * Keep what is needed to reconnect at the next launch, or forget it on sign-out (no `settings`).
   * Microsoft 365 needs the account kind; Jira's saved sign-in is its token file.
   */
  remember?(tool: ConnectTool, settings?: { work: boolean }): void;
}

const BROWSER_SIGN_IN_MS = 5 * 60_000;
const CODE_SIGN_IN_MS = 15 * 60_000; // Microsoft's sign-in codes expire after about 15 minutes

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

  /** Microsoft 365: a fresh server for the chosen account kind, signed in by browser or by code. */
  const startMs365 = async (work: boolean, deviceCode: boolean): Promise<SignInStart> => {
    const conn = await d.ms365({ work, deviceCode });
    const ms = conn.connector as Ms365Connector;
    const ac = new AbortController();
    const stop = () => {
      ac.abort();
      void conn.connector.close?.().catch(() => undefined); // ends its server, so a waiting login call fails
    };
    let start: SignInStart;
    let signedIn: Promise<unknown>;
    if ((await ms.testConnection()).ok) {
      start = { how: 'ready' };
      signedIn = Promise.resolve();
    } else if (!deviceCode) {
      // The server opens Microsoft's page itself; the login call returns once the user is back.
      start = { how: 'browser' };
      signedIn = ms.login(BROWSER_SIGN_IN_MS).then((r) => {
        if (!('signedIn' in r)) throw new Error('Microsoft asked for a sign-in code instead.');
      });
    } else {
      const r = await ms.login(60_000).catch((e) => {
        stop();
        throw e;
      });
      if ('signedIn' in r) {
        start = { how: 'ready' };
        signedIn = Promise.resolve();
      } else {
        start = { how: 'code', url: r.url, code: r.code };
        signedIn = untilSignedIn(ms, ac.signal);
      }
    }
    const done = signedIn.then(async () => {
      const who = await goLive(conn, 'Microsoft 365');
      d.remember?.('m365', { work });
      return who;
    });
    done.catch(stop); // a failed or cancelled sign-in shuts its server down
    pending.set('m365', { done, cancel: stop });
    return start;
  };

  /** After a code is shown, the server polls Microsoft; this checks until the user has entered it. */
  const untilSignedIn = async (ms: Ms365Connector, signal: AbortSignal) => {
    for (const until = Date.now() + CODE_SIGN_IN_MS; Date.now() < until; ) {
      if (signal.aborted) throw new Error('Sign-in cancelled.');
      if ((await ms.testConnection()).ok) return;
      await new Promise((r) => setTimeout(r, d.pollMs ?? 3000));
    }
    throw new Error('Sign-in timed out: the code expired.');
  };

  const cancel = (tool: ConnectTool) => {
    pending.get(tool)?.cancel();
    pending.delete(tool);
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

    async start(tool, opts): Promise<SignInStart> {
      pending.get(tool)?.cancel();
      if (tool === 'm365') return startMs365(Boolean(opts.work), Boolean(opts.deviceCode) || !d.ms365Browser);
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

    cancel,

    canUseBrowser: (tool) => tool === 'jira' || Boolean(d.ms365Browser),

    async signOut(tool) {
      cancel(tool);
      const i = d.connections.findIndex((c) => c.id === CONNECTION_ID[tool]);
      const conn = i < 0 ? undefined : d.connections.splice(i, 1)[0];
      // Microsoft 365's tokens live in its server's cache, so the server clears them.
      if (tool === 'm365' && conn) await (conn.connector as Ms365Connector).logout().catch(() => undefined);
      await conn?.connector.close?.().catch(() => undefined);
      d.remember?.(tool);
    },
  };
}
