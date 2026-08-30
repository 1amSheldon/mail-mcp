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
const OAUTH2_REFRESH_TIMEOUT_MS = 30_000;

function parseTokenEndpoint(value: string, accountId: string): string {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
    return endpoint.href;
  } catch {
    throw new Error(`OAuth2 credentials for account ${accountId} contain an invalid tokenEndpoint`);
  }
}

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
    tokenEndpoint: parseTokenEndpoint(value.tokenEndpoint as string, accountId),
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
  let response: Response;
  try {
    response = await fetch(tokens.tokenEndpoint, {
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
      signal: AbortSignal.timeout(OAUTH2_REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('OAuth2 token refresh timed out after 30 seconds', { cause: error });
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`OAuth2 token refresh request failed: ${reason}`, { cause: error });
  }

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
