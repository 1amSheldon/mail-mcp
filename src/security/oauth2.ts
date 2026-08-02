import { loadCredentials, saveCredentials } from './keychain.js';

export interface OAuth2Tokens {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  tokenEndpoint: string;
}

export async function getValidAccessToken(accountId: string): Promise<string> {
  const data = await loadCredentials(accountId);
  if (!data) {
    throw new Error(`No credentials found for account ${accountId}`);
  }

  let tokens: OAuth2Tokens;
  try {
    tokens = JSON.parse(data);
  } catch (e) {
    // Legacy plaintext password
    return data;
  }

  // If we don't have OAuth2 fields, assume it's a plain password
  if (!tokens.clientId || !tokens.refreshToken) {
    return data;
  }

  // Check if access token is valid (with 1 minute buffer)
  if (tokens.accessToken && tokens.expiryDate && Date.now() + 60000 < tokens.expiryDate) {
    return tokens.accessToken;
  }

  // Refresh token
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
    const errText = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} ${errText}`);
  }

  const result = await response.json();
  
  tokens.accessToken = result.access_token;
  if (result.expires_in) {
    tokens.expiryDate = Date.now() + result.expires_in * 1000;
  }
  if (result.refresh_token) {
    tokens.refreshToken = result.refresh_token;
  }

  await saveCredentials(accountId, JSON.stringify(tokens));

  return tokens.accessToken!;
}
