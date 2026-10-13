import { z } from 'zod';
import { loadCredentials, saveCredentials } from '../../security/keychain.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';

export const zimbraSessionSchema = z.object({
  kind: z.literal('zimbra-session-v1'),
  endpoint: z.string(), user: z.string(), authToken: z.string().min(1).max(16384),
  expiresAt: z.number().finite().positive(),
}).strict();
export type ZimbraSession = z.infer<typeof zimbraSessionSchema>;
export const trustedDeviceSchema = z.object({
  token: z.string().min(1).max(16384), deviceId: z.string().min(1).max(256),
  expiresAt: z.number().finite().positive(),
}).strict();
export type ZimbraTrustedDevice = z.infer<typeof trustedDeviceSchema>;
export interface ZimbraAuthentication { session: ZimbraSession; trustedDevice?: ZimbraTrustedDevice }
export class ZimbraAuthChallenge extends Error {
  readonly code = 'TWO_FACTOR_REQUIRED';
  constructor(public readonly trustedDevicesEnabled?: boolean) { super('A second authentication factor is required.'); this.name = 'ZimbraAuthChallenge'; }
}

export class ZimbraError extends Error {
  constructor(public readonly code: 'AUTH_REQUIRED' | 'TWO_FACTOR_REQUIRED' | 'AUTH_FAILED' | 'INVALID_INPUT' | 'ACCESS_DENIED' | 'PROVIDER_ERROR' | 'OUTCOME_UNKNOWN' | 'CONFLICT', message: string) {
    super(message); this.name = 'ZimbraError';
  }
}

export function validateZimbraEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ZimbraError('INVALID_INPUT', 'Invalid Zimbra HTTPS endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/service/soap') {
    throw new ZimbraError('INVALID_INPUT', 'Use an HTTPS /service/soap endpoint without credentials, query or fragment.');
  }
  return url.origin + '/service/soap';
}

export async function readZimbraSession(account: ZimbraConfiguredAccount): Promise<ZimbraSession> {
  const raw = await loadCredentials(account.id);
  let result: ReturnType<typeof zimbraSessionSchema.safeParse>;
  try { result = zimbraSessionSchema.safeParse(raw ? JSON.parse(raw) : null); }
  catch { throw new ZimbraError('AUTH_REQUIRED', 'Zimbra session missing. Run accounts login ACCOUNT_ID locally.'); }
  if (!result.success || result.data.endpoint !== validateZimbraEndpoint(account.endpoint)
    || result.data.user !== account.user || result.data.expiresAt <= Date.now() + 5000) {
    throw new ZimbraError('AUTH_REQUIRED', 'Zimbra session missing, expired or belongs to another configuration. Run accounts login ACCOUNT_ID locally.');
  }
  return result.data;
}

export async function saveZimbraSession(accountId: string, session: ZimbraSession): Promise<void> {
  await saveCredentials(accountId, JSON.stringify(zimbraSessionSchema.parse(session)));
}
