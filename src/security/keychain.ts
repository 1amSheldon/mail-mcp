import { setPassword, getPassword, deletePassword } from 'cross-keychain';
import {
  config,
  DEFAULT_KEYCHAIN_SERVICE,
  LEGACY_KEYCHAIN_SERVICE,
} from '../config.js';

async function loadFromService(serviceName: string, accountId: string): Promise<string | null> {
  try {
    return await getPassword(serviceName, accountId);
  } catch (error) {
    console.error(`Failed to load credentials for ${accountId} from ${serviceName}:`, error);
    return null;
  }
}

export async function saveCredentials(accountId: string, secret: string): Promise<void> {
  await setPassword(config.serviceName, accountId, secret);
}

export async function loadCredentials(accountId: string): Promise<string | null> {
  const credential = await loadFromService(config.serviceName, accountId);
  if (credential !== null || config.serviceName !== DEFAULT_KEYCHAIN_SERVICE) {
    return credential;
  }

  // Backward-compatible read only. Do not copy or mutate existing secrets.
  return loadFromService(LEGACY_KEYCHAIN_SERVICE, accountId);
}

export async function removeCredentials(accountId: string): Promise<void> {
  await deletePassword(config.serviceName, accountId);
  if (config.serviceName === DEFAULT_KEYCHAIN_SERVICE) {
    await deletePassword(LEGACY_KEYCHAIN_SERVICE, accountId);
  }
}
