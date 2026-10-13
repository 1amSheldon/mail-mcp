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

/** Trusted login requires system storage without secrets in process arguments.
 * Secret Service uses secret-tool via spawn (no shell), passing secrets on stdin.
 */
export async function protectedCredentialBackend() {
  const backend = await getKeyring();
  if (!['native-windows', 'native-macos', 'native-linux', 'secret-service'].includes(backend.id)) {
    throw new Error('Trusted login requires protected system credential storage; password-in-argv, file and null backends are refused.');
  }
  return backend;
}

export async function saveProtectedCredentials(accountId: string, secret: string): Promise<void> {
  try {
    const backend = await protectedCredentialBackend();
    await backend.setPassword(config.serviceName, accountId, secret);
    await clearLegacyCredential(backend, accountId);
  } catch { throw new Error('Cannot save credentials in protected system credential storage and clear the legacy entry.'); }
}

type CredentialBackend = Awaited<ReturnType<typeof getKeyring>>;

async function deleteVerified(backend: CredentialBackend, service: string, accountId: string): Promise<void> {
  if (await backend.getPassword(service, accountId) === null) return;
  await backend.deletePassword(service, accountId);
  if (await backend.getPassword(service, accountId) !== null) throw new Error('Credential deletion could not be verified.');
}

async function clearLegacyCredential(backend: CredentialBackend, accountId: string): Promise<void> {
  // Only this service configuration reads the legacy service as a fallback.
  if (config.serviceName === DEFAULT_KEYCHAIN_SERVICE) await deleteVerified(backend, LEGACY_KEYCHAIN_SERVICE, accountId);
}

/** Session-only login must also remove an older saved-password fallback. */
export async function saveZimbraSessionCredentials(accountId: string, session: string): Promise<void> {
  try {
    const backend = await getKeyring();
    await backend.setPassword(config.serviceName, accountId, session);
    await clearLegacyCredential(backend, accountId);
  } catch { throw new Error('Cannot save the Zimbra session and clear the legacy credential entry.'); }
}

/** Keep account configuration until every credential reachable by loadCredentials is gone. */
export async function removeZimbraCredentials(accountId: string): Promise<void> {
  try {
    const backend = await getKeyring();
    // Clear fallback first so deleting the current entry cannot reactivate it.
    await clearLegacyCredential(backend, accountId);
    await deleteVerified(backend, config.serviceName, accountId);
  } catch { throw new Error('Cannot verify removal of Zimbra credentials; account configuration was retained.'); }
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
