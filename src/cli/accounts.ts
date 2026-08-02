import { createInterface } from 'node:readline/promises';
import { getAccounts, saveAccounts, ACCOUNTS_PATH } from '../config.js';
import { saveCredentials, removeCredentials } from '../security/keychain.js';
import type { EmailAccount, AuthType } from '../types/index.js';

/**
 * Handle `mail-mcp accounts <subcommand>` CLI commands.
 *
 * Returns true if a CLI subcommand was handled (caller should process.exit),
 * false if not a CLI command (caller should start the MCP server).
 */
export async function handleAccountsCommand(args: string[]): Promise<boolean> {
  if (args[0] !== 'accounts') {
    return false;
  }

  const subcommand = args[1];

  switch (subcommand) {
    case 'list':
      await listAccounts();
      return true;

    case 'remove':
      await removeAccount(args[2]);
      return true;

    case 'add':
      await addAccount();
      return true;

    default:
      console.log('Usage: mail-mcp accounts <add|list|remove>');
      process.exit(1);
  }
}

async function listAccounts(): Promise<void> {
  const accounts = await getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts configured.');
    console.log(`Config file: ${ACCOUNTS_PATH}`);
    return;
  }

  const colWidths = {
    id: Math.max(2, ...accounts.map((a) => a.id.length)),
    name: Math.max(4, ...accounts.map((a) => a.name.length)),
    host: Math.max(4, ...accounts.map((a) => a.host.length)),
    user: Math.max(4, ...accounts.map((a) => a.user.length)),
  };

  const pad = (s: string, n: number) => s.padEnd(n);
  const header =
    `${pad('ID', colWidths.id)}  ${pad('Name', colWidths.name)}  ${pad('Host', colWidths.host)}  ${pad('User', colWidths.user)}`;
  const divider =
    `${'-'.repeat(colWidths.id)}  ${'-'.repeat(colWidths.name)}  ${'-'.repeat(colWidths.host)}  ${'-'.repeat(colWidths.user)}`;

  console.log(header);
  console.log(divider);
  for (const account of accounts) {
    console.log(
      `${pad(account.id, colWidths.id)}  ${pad(account.name, colWidths.name)}  ${pad(account.host, colWidths.host)}  ${pad(account.user, colWidths.user)}`
    );
  }
}

async function removeAccount(id: string | undefined): Promise<void> {
  if (!id) {
    console.error('Usage: mail-mcp accounts remove <id>');
    process.exit(1);
  }

  const accounts = await getAccounts();
  const index = accounts.findIndex((a) => a.id === id);

  if (index === -1) {
    console.error(`Account '${id}' not found.`);
    process.exit(1);
  }

  accounts.splice(index, 1);
  saveAccounts(accounts);

  try {
    await removeCredentials(id);
  } catch {
    console.error(`Warning: could not remove keychain entry for '${id}' (may not exist).`);
  }

  console.log(`Account '${id}' removed.`);
}

async function addAccount(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const existingAccounts = await getAccounts();
    const existingIds = new Set(existingAccounts.map((a) => a.id));

    // id
    let id = '';
    while (!id) {
      const raw = await rl.question('Account ID (required, unique): ');
      const trimmed = raw.trim();
      if (!trimmed) {
        console.log('  ID is required.');
        continue;
      }
      if (existingIds.has(trimmed)) {
        console.log(`  ID '${trimmed}' already exists. Choose a different ID.`);
        continue;
      }
      id = trimmed;
    }

    // name
    const nameRaw = await rl.question(`Name [${id}]: `);
    const name = nameRaw.trim() || id;

    // host (IMAP)
    let host = '';
    while (!host) {
      const raw = await rl.question('IMAP host (e.g. imap.gmail.com): ');
      const trimmed = raw.trim();
      if (!trimmed) {
        console.log('  Host is required.');
        continue;
      }
      host = trimmed;
    }

    // port
    const portRaw = await rl.question('IMAP port [993]: ');
    const port = parseInt(portRaw.trim(), 10) || 993;

    // user
    let user = '';
    while (!user) {
      const raw = await rl.question('Email address (user): ');
      const trimmed = raw.trim();
      if (!trimmed) {
        console.log('  Email address is required.');
        continue;
      }
      user = trimmed;
    }

    // authType
    const authTypeRaw = await rl.question('Auth type (login/oauth2) [login]: ');
    const authType: AuthType = authTypeRaw.trim() === 'oauth2' ? 'oauth2' : 'login';

    // useTLS
    const tlsRaw = await rl.question('Use TLS? (y/n) [y]: ');
    const useTLS = tlsRaw.trim().toLowerCase() !== 'n';

    // smtpHost
    const defaultSmtpHost = host.includes('imap') ? host.replace('imap', 'smtp') : '';
    const smtpHostRaw = await rl.question(
      `SMTP host [${defaultSmtpHost || 'press enter to skip'}]: `
    );
    const smtpHost = smtpHostRaw.trim() || defaultSmtpHost || undefined;

    // smtpPort
    let smtpPort: number | undefined;
    if (smtpHost) {
      const smtpPortRaw = await rl.question('SMTP port [587]: ');
      smtpPort = parseInt(smtpPortRaw.trim(), 10) || 587;
    }

    // password (only for login auth)
    let password: string | undefined;
    if (authType === 'login') {
      const passwordRaw = await rl.question(
        'Password (will be stored in macOS Keychain, NOT in config file): '
      );
      password = passwordRaw || undefined;
    }

    const account: EmailAccount = {
      id,
      name,
      host,
      port,
      user,
      authType,
      useTLS,
      ...(smtpHost !== undefined ? { smtpHost } : {}),
      ...(smtpPort !== undefined ? { smtpPort } : {}),
    };

    existingAccounts.push(account);
    saveAccounts(existingAccounts);

    if (authType === 'login' && password) {
      await saveCredentials(id, password);
      console.log(`Account '${id}' added. Password stored in macOS Keychain.`);
    } else {
      console.log(`Account '${id}' added.`);
    }
  } finally {
    rl.close();
  }
}
