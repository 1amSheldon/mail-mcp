import { setPassword, getPassword, deletePassword } from 'cross-keychain';
import { config } from '../config.js';

export async function saveCredentials(accountId: string, secret: string): Promise<void> {
  await setPassword(config.serviceName, accountId, secret);
}

export async function loadCredentials(accountId: string): Promise<string | null> {
  try {
    return await getPassword(config.serviceName, accountId);
  } catch (error) {
    console.error(`Failed to load credentials for ${accountId}:`, error);
    return null;
  }
}

export async function removeCredentials(accountId: string): Promise<void> {
  await deletePassword(config.serviceName, accountId);
}
