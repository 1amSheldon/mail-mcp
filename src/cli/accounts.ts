import { createInterface } from 'node:readline/promises';
import { getAccounts, saveAccounts, ACCOUNTS_PATH, type EmailAccount } from '../config.js';
import { saveCredentials, removeCredentials } from '../security/keychain.js';

interface QuestionPrompt {
  question(query: string): Promise<string>;
}

export function inferSmtpHost(imapHost: string): string {
  return /^imap\./i.test(imapHost) ? imapHost.replace(/^imap\./i, 'smtp.') : '';
}

async function askPort(
  prompt: QuestionPrompt,
  label: string,
  defaultPort: number,
): Promise<number> {
  while (true) {
    const raw = (await prompt.question(`${label} [${defaultPort}]: `)).trim();
    if (raw === '') return defaultPort;

    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    console.log('  Port must be an integer from 1 to 65535.');
  }
}

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
    const port = await askPort(rl, 'IMAP port', 993);

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
    let authType: EmailAccount['authType'] | undefined;
    while (!authType) {
      const raw = (await rl.question('Auth type (login/oauth2) [login]: ')).trim();
      if (raw === '' || raw === 'login') {
        authType = 'login';
      } else if (raw === 'oauth2') {
        authType = 'oauth2';
      } else {
        console.log('  Auth type must be login or oauth2.');
      }
    }

    // useTLS
    const tlsRaw = await rl.question('Use TLS? (y/n) [y]: ');
    const useTLS = tlsRaw.trim().toLowerCase() !== 'n';

    // smtpHost
    const defaultSmtpHost = inferSmtpHost(host);
    const smtpHostRaw = await rl.question(
      `SMTP host [${defaultSmtpHost || 'press enter to skip'}]: `
    );
    const smtpHost = smtpHostRaw.trim() || defaultSmtpHost || undefined;

    // smtpPort
    let smtpPort: number | undefined;
    if (smtpHost) {
      smtpPort = await askPort(rl, 'SMTP port', 587);
    }

    // password (only for login auth)
    let password: string | undefined;
    if (authType === 'login') {
      while (!password) {
        password = await rl.question(
          'Password or app password (stored in the system credential store, not accounts.json): '
        );
        if (!password) console.log('  Password is required for login authentication.');
      }
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

    if (authType === 'login' && password) {
      await saveCredentials(id, password);
      try {
        saveAccounts([...existingAccounts, account]);
      } catch (error) {
        await removeCredentials(id).catch(() => undefined);
        throw error;
      }
      console.log(`Account '${id}' added. Credential stored in the system credential store.`);
    } else {
      saveAccounts([...existingAccounts, account]);
      console.log(`Account '${id}' added.`);
    }
  } finally {
    rl.close();
  }
}
