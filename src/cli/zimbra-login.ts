import { getConfiguredAccounts } from '../config.js';
import { isZimbraAccount, type ZimbraConfiguredAccount } from '../providers/account-types.js';
import { ZimbraClient } from '../providers/zimbra/client.js';
import { ZimbraError, saveZimbraSession, type ZimbraSession } from '../providers/zimbra/session.js';
import { createAccountPrompt, type QuestionPrompt } from './prompt.js';

export async function loginZimbraAccount(account: ZimbraConfiguredAccount, prompt: QuestionPrompt,
  options: { client?: ZimbraClient; save?: (id: string, session: ZimbraSession) => Promise<void> } = {}): Promise<void> {
  const client = options.client ?? new ZimbraClient(account, {
    sessionProvider: async () => { throw new ZimbraError('AUTH_REQUIRED', 'Interactive login required.'); },
  });
  try {
    const password = await prompt.secret('Zimbra main account password (not the IMAP app password): ');
    if (!password) throw new ZimbraError('INVALID_INPUT', 'Password is required.');
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
  } finally { client.disconnect(); }
}

export async function handleZimbraLogin(id: string | undefined): Promise<void> {
  const account = (await getConfiguredAccounts()).find(a => a.id === id);
  if (!account || !isZimbraAccount(account)) throw new ZimbraError('INVALID_INPUT', 'Usage: accounts login ZIMBRA_ACCOUNT_ID. Add a Zimbra backend account first.');
  const prompt = createAccountPrompt();
  try { await loginZimbraAccount(account, prompt); } finally { prompt.close(); }
}
