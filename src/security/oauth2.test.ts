import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

vi.mock('./keychain.js', () => keychain);

import { getValidAccessToken, validateOAuth2TokenEndpoint } from './oauth2.js';

const tokenSet = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
  tokenEndpoint: 'https://accounts.example.test/token',
};

describe('OAuth2 access token refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keychain.saveCredentials.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a cached access token without calling the token endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    keychain.loadCredentials.mockResolvedValue(JSON.stringify({
      ...tokenSet,
      accessToken: 'cached-token',
      expiryDate: Date.now() + 120_000,
    }));

    await expect(getValidAccessToken('work')).resolves.toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares one refresh across concurrent callers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 })));
    vi.stubGlobal('fetch', fetchMock);
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));

    await expect(Promise.all([
      getValidAccessToken('work'),
      getValidAccessToken('work'),
      getValidAccessToken('work'),
    ])).resolves.toEqual(['fresh-token', 'fresh-token', 'fresh-token']);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
    expect(keychain.saveCredentials).toHaveBeenCalledOnce();
  });

  it('replaces a rejected token even when its stored expiry is still valid', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'replacement-token', expires_in: 3600 })));
    vi.stubGlobal('fetch', fetchMock);
    keychain.loadCredentials.mockResolvedValue(JSON.stringify({
      ...tokenSet, accessToken: 'revoked-token', expiryDate: Date.now() + 3_600_000,
    }));
    await expect(Promise.all([
      getValidAccessToken('work', true), getValidAccessToken('work', true),
    ])).resolves.toEqual(['replacement-token', 'replacement-token']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a successful response without an access token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ expires_in: 3600 }))));
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 token endpoint returned no access_token'
    );
    expect(keychain.saveCredentials).not.toHaveBeenCalled();
  });

  it('never exposes token response bytes from JSON parse errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_TOKEN_RESPONSE')));
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));
    const error = await getValidAccessToken('work').catch(error => error);
    expect(error.message).toBe('OAuth2 token endpoint returned invalid JSON');
    expect(error.cause).toBeUndefined();
    expect(keychain.saveCredentials).not.toHaveBeenCalled();
  });

  it('rejects non-OAuth credentials instead of using them as a bearer token', async () => {
    keychain.loadCredentials.mockResolvedValue('plain-password');

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 credentials for account work are not valid JSON'
    );
  });

  it('does not echo endpoint errors that contain credentials', async () => {
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('client_secret=PRIVATE', { status: 400 })));
    await expect(getValidAccessToken('work')).rejects.toThrow(/^OAuth2 token refresh failed with HTTP 400$/);
  });

  it('bounds response bytes and never saves an oversized token response', async () => {
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(65537))));
    await expect(getValidAccessToken('work')).rejects.toThrow('65536-byte limit');
    expect(keychain.saveCredentials).not.toHaveBeenCalled();
  });

  it('drops an old expiry when a forced refresh supplies no lifetime', async () => {
    keychain.loadCredentials.mockResolvedValue(JSON.stringify({ ...tokenSet, accessToken: 'old', expiryDate: Date.now() + 3_600_000 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"access_token":"new"}')));
    await getValidAccessToken('work', true);
    expect(JSON.parse(keychain.saveCredentials.mock.calls[0][1])).not.toHaveProperty('expiryDate');
  });

  it('rejects an invalid token endpoint before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    keychain.loadCredentials.mockResolvedValue(JSON.stringify({
      ...tokenSet,
      tokenEndpoint: 'file:///tmp/token',
    }));

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 credentials for account work contain an invalid tokenEndpoint'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects plaintext HTTP outside loopback before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    keychain.loadCredentials.mockResolvedValue(JSON.stringify({
      ...tokenSet,
      tokenEndpoint: 'http://accounts.example.test/token',
    }));

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 credentials for account work contain an invalid tokenEndpoint: OAuth2 token endpoint must use HTTPS',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds context when the token endpoint cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 token refresh request failed: connection reset'
    );
  });
});

describe('validateOAuth2TokenEndpoint', () => {
  it('accepts HTTPS endpoints', () => {
    expect(validateOAuth2TokenEndpoint('https://accounts.example.test/token'))
      .toBe('https://accounts.example.test/token');
  });

  it.each([
    'http://localhost:8080/token',
    'http://localhost.:8080/token',
    'http://127.0.0.1:8080/token',
    'http://127.23.45.67/token',
    'http://[::1]:8080/token',
  ])('accepts loopback HTTP endpoint %s', (endpoint) => {
    expect(validateOAuth2TokenEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    'http://accounts.example.test/token',
    'http://localhost.example.test/token',
    'http://192.168.1.10/token',
    'file:///tmp/token',
    'not-a-url',
  ])('rejects insecure or invalid endpoint %s', (endpoint) => {
    expect(() => validateOAuth2TokenEndpoint(endpoint)).toThrow(
      'OAuth2 token endpoint must use HTTPS, except for loopback HTTP development endpoints',
    );
  });
});
