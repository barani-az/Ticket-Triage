import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileOAuthProvider } from '../src/mcp/remote.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-')), 'oauth.json');

describe('FileOAuthProvider', () => {
  it('starts empty and persists client info, tokens and verifier across instances', () => {
    const file = tmp();
    const a = new FileOAuthProvider(file, 'http://127.0.0.1:8976/callback', () => undefined);
    expect(a.tokens()).toBeUndefined();
    a.saveClientInformation({ client_id: 'abc' });
    a.saveTokens({ access_token: 't', token_type: 'Bearer' });
    a.saveCodeVerifier('v');

    const b = new FileOAuthProvider(file, 'http://127.0.0.1:8976/callback', () => undefined);
    expect(b.clientInformation()).toMatchObject({ client_id: 'abc' });
    expect(b.tokens()?.access_token).toBe('t');
    expect(b.codeVerifier()).toBe('v');
  });

  it('forgets tokens only when asked', () => {
    const file = tmp();
    const p = new FileOAuthProvider(file, 'http://127.0.0.1:8976/callback', () => undefined);
    p.saveClientInformation({ client_id: 'abc' });
    p.saveTokens({ access_token: 't', token_type: 'Bearer' });
    p.invalidateCredentials('tokens');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toMatchObject({ client_id: 'abc' });
  });

  it('is a public client with a loopback redirect and PKCE-friendly metadata', () => {
    const p = new FileOAuthProvider(tmp(), 'http://127.0.0.1:8976/callback', () => undefined);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none');
    expect(p.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:8976/callback']);
  });

  it('hands the authorization URL to the caller instead of opening anything itself', () => {
    let seen = '';
    const p = new FileOAuthProvider(tmp(), 'http://127.0.0.1:8976/callback', (u) => (seen = u.toString()));
    p.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'));
    expect(seen).toBe('https://auth.example/authorize?x=1');
  });
});
