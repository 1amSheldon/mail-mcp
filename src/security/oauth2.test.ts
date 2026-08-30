import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

vi.mock('./keychain.js', () => keychain);

import { getValidAccessToken } from './oauth2.js';

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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));

    await expect(Promise.all([
      getValidAccessToken('work'),
      getValidAccessToken('work'),
      getValidAccessToken('work'),
    ])).resolves.toEqual(['fresh-token', 'fresh-token', 'fresh-token']);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(keychain.saveCredentials).toHaveBeenCalledOnce();
  });

  it('rejects a successful response without an access token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_in: 3600 }),
    }));
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 token endpoint returned no access_token'
    );
    expect(keychain.saveCredentials).not.toHaveBeenCalled();
  });

  it('rejects non-OAuth credentials instead of using them as a bearer token', async () => {
    keychain.loadCredentials.mockResolvedValue('plain-password');

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 credentials for account work are not valid JSON'
    );
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

  it('adds context when the token endpoint cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    keychain.loadCredentials.mockResolvedValue(JSON.stringify(tokenSet));

    await expect(getValidAccessToken('work')).rejects.toThrow(
      'OAuth2 token refresh request failed: connection reset'
    );
  });
});
