import { setPassword, getPassword, deletePassword, getKeyring } from 'cross-keychain';
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

/** Trusted login can contain the main password. Refuse shell/file fallbacks. */
export async function protectedCredentialBackend() {
  const backend = await getKeyring();
  if (!['native-windows', 'native-macos', 'native-linux', 'secret-service'].includes(backend.id)) {
    throw new Error('Trusted login requires a protected native credential backend; shell, file and null backends are not supported.');
  }
  return backend;
}

export async function saveProtectedCredentials(accountId: string, secret: string): Promise<void> {
  const backend = await protectedCredentialBackend();
  await backend.setPassword(config.serviceName, accountId, secret);
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
}
