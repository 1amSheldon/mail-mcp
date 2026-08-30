import { loadCredentials, saveCredentials } from './keychain.js';

export interface OAuth2Tokens {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  tokenEndpoint: string;
}

interface OAuth2TokenResponse {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
}

const refreshes = new Map<string, Promise<string>>();

function parseTokens(data: string, accountId: string): OAuth2Tokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`OAuth2 credentials for account ${accountId} are not valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`OAuth2 credentials for account ${accountId} are invalid`);
  }

  const value = parsed as Record<string, unknown>;
  for (const field of ['clientId', 'clientSecret', 'refreshToken', 'tokenEndpoint'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new Error(`OAuth2 credentials for account ${accountId} are missing ${field}`);
    }
  }

  return {
    clientId: value.clientId as string,
    clientSecret: value.clientSecret as string,
    refreshToken: value.refreshToken as string,
    tokenEndpoint: value.tokenEndpoint as string,
    ...(typeof value.accessToken === 'string' ? { accessToken: value.accessToken } : {}),
    ...(typeof value.expiryDate === 'number' ? { expiryDate: value.expiryDate } : {}),
  };
}

function parseTokenResponse(value: unknown): OAuth2TokenResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('OAuth2 token endpoint returned an invalid response');
  }
  const response = value as Record<string, unknown>;
  if (typeof response.access_token !== 'string' || response.access_token.trim() === '') {
    throw new Error('OAuth2 token endpoint returned no access_token');
  }
  return {
    accessToken: response.access_token,
    ...(typeof response.expires_in === 'number' && response.expires_in > 0
      ? { expiresIn: response.expires_in }
      : {}),
    ...(typeof response.refresh_token === 'string' && response.refresh_token !== ''
      ? { refreshToken: response.refresh_token }
      : {}),
  };
}

async function refreshAccessToken(accountId: string, tokens: OAuth2Tokens): Promise<string> {
  const response = await fetch(tokens.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: tokens.clientId,
      client_secret: tokens.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `OAuth2 token refresh failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`
    );
  }

  const result = parseTokenResponse(await response.json());
  tokens.accessToken = result.accessToken;
  if (result.expiresIn !== undefined) {
    tokens.expiryDate = Date.now() + result.expiresIn * 1000;
  }
  if (result.refreshToken !== undefined) {
    tokens.refreshToken = result.refreshToken;
  }

  await saveCredentials(accountId, JSON.stringify(tokens));
  return result.accessToken;
}

export async function getValidAccessToken(accountId: string): Promise<string> {
  const data = await loadCredentials(accountId);
  if (!data) {
    throw new Error(`No credentials found for account ${accountId}`);
  }

  const tokens = parseTokens(data, accountId);

  // Check if access token is valid (with 1 minute buffer)
  if (tokens.accessToken && tokens.expiryDate && Date.now() + 60000 < tokens.expiryDate) {
    return tokens.accessToken;
  }

  const existing = refreshes.get(accountId);
  if (existing) return existing;

  const refresh = refreshAccessToken(accountId, tokens).finally(() => {
    if (refreshes.get(accountId) === refresh) {
      refreshes.delete(accountId);
    }
  });
  refreshes.set(accountId, refresh);
  return refresh;
}
