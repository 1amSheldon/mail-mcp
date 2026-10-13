import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadCredentials, saveCredentials, saveProtectedCredentials, protectedCredentialBackend } from '../../security/keychain.js';
import type { ZimbraConfiguredAccount } from '../account-types.js';
import { ZimbraError, trustedDeviceSchema, validateZimbraEndpoint, zimbraSessionSchema, type ZimbraAuthentication, type ZimbraSession, type ZimbraTrustedDevice } from './session.js';

const stateSchema = z.object({
  kind: z.literal('zimbra-login-v2'), session: zimbraSessionSchema,
  trustedDevice: trustedDeviceSchema.optional(),
  automaticLogin: z.object({ password: z.string().min(1).max(16384), blocked: z.boolean() }).strict().optional(),
}).strict().refine(v => !v.automaticLogin || !!v.trustedDevice);
export type ZimbraLoginState = z.infer<typeof stateSchema>;
type Authenticate = (password: string, device: ZimbraTrustedDevice) => Promise<ZimbraAuthentication>;
interface Store { load: typeof loadCredentials; save: typeof saveCredentials }
const defaultStore: Store = {
  load: async id => {
    const raw = await loadCredentials(id);
    let kind: unknown;
    try { kind = raw ? JSON.parse(raw).kind : undefined; } catch { /* read() reports malformed state */ }
    if (kind === 'zimbra-login-v2') {
      try { await protectedCredentialBackend(); }
      catch { throw new ZimbraError('AUTH_REQUIRED', 'Protected system credential storage is required; password-in-argv, file and null backends are refused.'); }
    }
    return raw;
  },
  save: (id, value) => saveProtectedCredentials(id, value),
};
const lockDirectory = join(homedir(), '.config', 'mail-mcp', 'zimbra-login-locks');
const required = () => new ZimbraError('AUTH_REQUIRED', 'Zimbra login is unavailable or needs attention. Run accounts login ACCOUNT_ID locally.');

/** Only explicit local authentication may replace malformed or misbound state. */
export class ZimbraStoredStateError extends ZimbraError {
  constructor() { super('AUTH_REQUIRED', 'Stored Zimbra login is invalid or belongs to another configuration. Run accounts login ACCOUNT_ID locally.'); }
}

/** The lock contains no credentials. Never steal a lock from another process.
 * A crash leaves a visible lock requiring local inspection, not repeated logins.
 */
export async function withZimbraLoginLock<T>(accountId: string, action: () => Promise<T>, directory = lockDirectory, timeoutMs = 35000): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, createHash('sha256').update(accountId).digest('hex') + '.lock');
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try { handle = await open(path, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ZimbraError('PROVIDER_ERROR', 'Cannot acquire the local Zimbra login lock.');
      if (Date.now() >= deadline) throw new ZimbraError('AUTH_REQUIRED', `Zimbra login lock is busy: ${path}. Inspect its PID; after closing mail-mcp processes, remove only this abandoned lock before local login.`);
      await delay(100);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
    await handle.sync();
    return await action();
  } finally { await handle.close(); await unlink(path); }
}

export class ZimbraLoginStore {
  constructor(private readonly account: ZimbraConfiguredAccount, private readonly store: Store = defaultStore, private readonly directory = lockDirectory) {}
  async read(): Promise<ZimbraLoginState | undefined> {
    const raw = await this.store.load(this.account.id);
    if (!raw) return undefined;
    let state: ZimbraLoginState;
    try {
      const value = JSON.parse(raw);
      const legacy = zimbraSessionSchema.safeParse(value);
      state = legacy.success ? { kind: 'zimbra-login-v2', session: legacy.data } : stateSchema.parse(value);
    } catch { throw new ZimbraStoredStateError(); }
    if (state.session.endpoint !== validateZimbraEndpoint(this.account.endpoint) || state.session.user !== this.account.user) throw new ZimbraStoredStateError();
    return state;
  }
  private async save(state: ZimbraLoginState): Promise<void> {
    // Store the whole session/trust/password state as one OS credential entry.
    try { await this.store.save(this.account.id, JSON.stringify(stateSchema.parse(state))); }
    catch { throw new ZimbraError('PROVIDER_ERROR', 'Cannot save Zimbra login. Protected system credential storage is required; password-in-argv, file and null backends are refused.'); }
  }
  async replace(result: ZimbraAuthentication, password?: string): Promise<void> {
    await this.save({ kind: 'zimbra-login-v2', ...result, ...(password ? { automaticLogin: { password, blocked: false } } : {}) });
  }
  lock<T>(action: () => Promise<T>): Promise<T> { return withZimbraLoginLock(this.account.id, action, this.directory); }
  async disableAutomaticLogin(): Promise<void> {
    await this.lock(async () => {
      const state = await this.read(); if (!state) throw required();
      delete state.automaticLogin; await this.save(state);
    });
  }
  async status() {
    const state = await this.read();
    return {
      status: !state ? 'login_required' : state.session.expiresAt <= Date.now() + 5000 ? 'session_expired' : 'session_available',
      expiresAt: state ? new Date(state.session.expiresAt).toISOString() : null,
      trustedDeviceExpiresAt: state?.trustedDevice ? new Date(state.trustedDevice.expiresAt).toISOString() : null,
      automaticLogin: !state?.automaticLogin ? 'disabled' : state.automaticLogin.blocked ? 'needs_local_login' : state.trustedDevice!.expiresAt <= Date.now() + 5000 ? 'trust_expired' : 'enabled',
      remoteVerified: false,
    };
  }
  async session(authenticate: Authenticate): Promise<ZimbraSession> {
    const state = await this.read(); if (!state) throw required();
    if (state.session.expiresAt > Date.now() + 5000) return state.session;
    return this.lock(async () => {
      const latest = await this.read(); if (!latest) throw required();
      if (latest.session.expiresAt > Date.now() + 5000) return latest.session;
      if (!latest.automaticLogin || latest.automaticLogin.blocked || !latest.trustedDevice || latest.trustedDevice.expiresAt <= Date.now() + 5000) throw required();
      // Persist before dispatch: failure or process death cannot start a login loop.
      latest.automaticLogin.blocked = true; await this.save(latest);
      let result: ZimbraAuthentication;
      try { result = await authenticate(latest.automaticLogin.password, latest.trustedDevice); }
      catch { throw required(); }
      if (result.session.endpoint !== latest.session.endpoint || result.session.user !== latest.session.user || result.session.expiresAt <= Date.now() + 5000) throw required();
      await this.replace(result, result.trustedDevice ? latest.automaticLogin.password : undefined);
      return result.session;
    });
  }
}
