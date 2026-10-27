import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface Stored {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * OAuth state for one remote MCP server, kept in a local JSON file (git-ignored).
 * Demo-grade: the plan moves tokens into the Windows credential store. Never log this file.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private file: string,
    private redirect: string,
    private onRedirect: (url: URL) => void,
  ) {}

  private read(): Stored {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Stored;
    } catch {
      return {};
    }
  }
  private write(patch: Partial<Stored>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ ...this.read(), ...patch }));
  }

  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'AI Task Assistant Demo',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.read().clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.write({ clientInformation: info });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  redirectToAuthorization(url: URL) {
    this.onRedirect(url);
  }
  saveCodeVerifier(codeVerifier: string) {
    this.write({ codeVerifier });
  }
  codeVerifier() {
    const v = this.read().codeVerifier;
    if (!v) throw new Error('No code verifier saved.');
    return v;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all') return this.write({ clientInformation: undefined, tokens: undefined, codeVerifier: undefined });
    if (scope === 'client') return this.write({ clientInformation: undefined });
    if (scope === 'tokens') return this.write({ tokens: undefined });
    if (scope === 'verifier') return this.write({ codeVerifier: undefined });
  }
}

/** Loopback listener that receives the OAuth redirect (http://127.0.0.1:<port>/callback). */
function listenForCode(port: number): Promise<{ code: Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let deliver!: (code: string) => void;
    let fail!: (e: Error) => void;
    const code = new Promise<string>((res, rej) => {
      deliver = res;
      fail = rej;
    });
    code.catch(() => undefined); // avoid unhandled rejection if nobody awaits
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(c ? '<p>Signed in. You can close this tab and return to the terminal.</p>' : '<p>Sign-in failed. You can close this tab.</p>');
      if (c) deliver(c);
      else fail(new Error(`Authorization failed: ${err ?? 'no code returned'}`));
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const timer = setTimeout(() => fail(new Error('Timed out waiting for sign-in (5 minutes).')), 5 * 60_000);
      resolve({
        code,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

function openInBrowser(url: string) {
  if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export interface RemoteOptions {
  url: string;
  /** Where OAuth client info and tokens are kept. */
  storeFile: string;
  callbackPort?: number;
  log?: (line: string) => void;
  /** Default true. When false, never open a browser: fail if the saved sign-in is missing or expired. */
  interactive?: boolean;
}

/**
 * Connect to a remote (streamable HTTP) MCP server with OAuth. The first run opens the system
 * browser for sign-in; later runs reuse the saved tokens.
 */
export async function connectRemoteMcp(opts: RemoteOptions): Promise<Client> {
  const log = opts.log ?? (() => undefined);
  const port = opts.callbackPort ?? 8976;
  const interactive = opts.interactive !== false;
  const listener = interactive ? await listenForCode(port) : { code: Promise.reject(new Error('not interactive')), close: () => undefined };
  listener.code.catch(() => undefined);
  const provider = new FileOAuthProvider(opts.storeFile, `http://127.0.0.1:${port}/callback`, (url) => {
    if (!interactive) return;
    log(`Opening your browser to sign in. If nothing opens, visit:\n${url.toString()}`);
    openInBrowser(url.toString());
  });
  const make = () => ({
    client: new Client({ name: 'assistant', version: '0.0.1' }),
    transport: new StreamableHTTPClientTransport(new URL(opts.url), { authProvider: provider }),
  });

  try {
    let { client, transport } = make();
    try {
      await client.connect(transport);
      return client;
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      if (!interactive) throw new Error('Sign-in required. Run `npm run mcp:discover` to sign in again.');
    }
    await transport.finishAuth(await listener.code);
    ({ client, transport } = make());
    await client.connect(transport);
    return client;
  } finally {
    listener.close();
  }
}
