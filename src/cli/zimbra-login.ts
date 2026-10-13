import { getConfiguredAccounts } from '../config.js';
import { isZimbraAccount, type ZimbraConfiguredAccount } from '../providers/account-types.js';
import { ZimbraClient } from '../providers/zimbra/client.js';
import { ZimbraError, ZimbraAuthChallenge, saveZimbraSession, type ZimbraSession, type ZimbraAuthentication } from '../providers/zimbra/session.js';
import { ZimbraLoginStore, ZimbraStoredStateError, type ZimbraLoginState } from '../providers/zimbra/login-state.js';
import { createAccountPrompt, type QuestionPrompt } from './prompt.js';

export async function loginZimbraAccount(account: ZimbraConfiguredAccount, prompt: QuestionPrompt,
  options: { client?: ZimbraClient; save?: (id: string, session: ZimbraSession) => Promise<void>; store?: ZimbraLoginStore; trustedDevice?: boolean } = {}): Promise<void> {
  const client = options.client ?? new ZimbraClient(account, {
    sessionProvider: async () => { throw new ZimbraError('AUTH_REQUIRED', 'Interactive login required.'); },
  });
  const store = options.store ?? new ZimbraLoginStore(account);
  try { await store.lock(async () => {
    const password = await prompt.secret('Zimbra main account password (not the IMAP app password): ');
    if (!password) throw new ZimbraError('INVALID_INPUT', 'Password is required.');
    if (options.trustedDevice) {
      let previous: ZimbraLoginState | undefined;
      try { previous = await store.read(); }
      catch (error) {
        // A local password/OTP login can repair invalid state, but storage or
        // backend-policy failures must still stop before authentication.
        if (!(error instanceof ZimbraStoredStateError)) throw error;
      }
      const trusted = previous?.trustedDevice && previous.trustedDevice.expiresAt > Date.now() + 5000 ? previous.trustedDevice : undefined;
      let result: ZimbraAuthentication;
      try { result = await client.authenticateWithDevice(password, undefined, trusted ? { trustedDevice: trusted } : { register: true }); }
      catch (error) {
        if (!(error instanceof ZimbraAuthChallenge)) throw error;
        if (error.trustedDevicesEnabled === false) console.log('The server reports that trusted devices are disabled. This login will save only a session.');
        const code = (await prompt.secret('Current authenticator or one-use backup code: ')).trim();
        if (!code) throw new ZimbraError('INVALID_INPUT', 'Second-factor code is required.');
        result = await client.authenticateWithDevice(password, code, error.trustedDevicesEnabled === false ? undefined : { register: true });
      }
      let remember = false;
      if (result.trustedDevice) {
        remember = (await prompt.question('Store the MAIN account password in this user\'s OS credential store for automatic login? (y/n) [n]: ')).trim().toLowerCase() === 'y';
      }
      await store.replace(result, remember ? password : undefined);
      console.log(`Zimbra session saved. Expires: ${new Date(result.session.expiresAt).toISOString()}.`);
      console.log(result.trustedDevice ? `Device trust expires: ${new Date(result.trustedDevice.expiresAt).toISOString()}.` : 'No usable device trust was returned. Automatic login is disabled.');
      console.log(remember ? 'Automatic login enabled on this device. Use accounts disable-auto-login ACCOUNT_ID to remove the saved password.' : 'Main password and second-factor code were not stored.');
      return;
    }
    let session: ZimbraSession;
    try { session = await client.authenticate(password); }
    catch (error) {
      if (!(error instanceof ZimbraError) || error.code !== 'TWO_FACTOR_REQUIRED') throw error;
      const recovery = (await prompt.question('Use a backup/scratch code instead of an authenticator code? (y/n) [n]: ')).trim().toLowerCase() === 'y';
      const code = (await prompt.secret(recovery ? 'One-use backup/scratch code: ' : 'Current authenticator code: ')).trim();
      if (!code) throw new ZimbraError('INVALID_INPUT', 'Second-factor code is required.');
      session = await client.authenticate(password, code);
    }
    await (options.save ?? saveZimbraSession)(account.id, session);
    console.log(`Zimbra session saved in the system credential store. Expires: ${new Date(session.expiresAt).toISOString()}.`);
    console.log('Password and second-factor code were not stored. Run accounts login again when the session expires or is revoked.');
  }); } finally { client.disconnect(); }
}

export async function handleZimbraLogin(id: string | undefined, flags: string[] = []): Promise<void> {
  if (flags.length > 1 || flags.some(flag => flag !== '--trusted-device')) throw new ZimbraError('INVALID_INPUT', 'Usage: accounts login ZIMBRA_ACCOUNT_ID [--trusted-device]. Passwords are entered only in the local masked prompt.');
  const account = (await getConfiguredAccounts()).find(a => a.id === id);
  if (!account || !isZimbraAccount(account)) throw new ZimbraError('INVALID_INPUT', 'Usage: accounts login ZIMBRA_ACCOUNT_ID. Add a Zimbra backend account first.');
  const prompt = createAccountPrompt();
  try { await loginZimbraAccount(account, prompt, { trustedDevice: flags.includes('--trusted-device') }); } finally { prompt.close(); }
}

export async function disableZimbraAutomaticLogin(id: string | undefined): Promise<void> {
  const account = (await getConfiguredAccounts()).find(a => a.id === id);
  if (!account || !isZimbraAccount(account)) throw new ZimbraError('INVALID_INPUT', 'Usage: accounts disable-auto-login ZIMBRA_ACCOUNT_ID.');
  await new ZimbraLoginStore(account).disableAutomaticLogin();
  console.log('Saved password removed; automatic login disabled. The current session and device trust remain. Revoke device trust in webmail when needed.');
}
