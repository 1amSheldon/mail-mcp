import { describe, expect, it, vi } from 'vitest';
import { MailMCPRuntimeState } from '../runtime-state.js';
import type {
  AppleMailConfiguredAccount,
  ConfiguredAccount,
  EwsConfiguredAccount,
  MailtrapConfiguredAccount,
  MicrosoftGraphConfiguredAccount,
} from './account-types.js';
import type { AppleMailAdapter } from './apple-mail/adapter.js';
import type { MailtrapClient } from './mailtrap/client.js';
import type { EwsClient } from './microsoft/ews.js';
import type { MicrosoftGraphClient } from './microsoft/graph.js';
import {
  ProviderRuntime,
  ProviderRuntimeError,
} from './runtime.js';
import type { ProviderRuntimeFactories, ProviderRuntimeOptions } from './runtime.js';

const APPLE_ACCOUNT: AppleMailConfiguredAccount = {
  id: 'apple',
  name: 'Apple Mail',
  backend: 'apple-mail',
};

const GRAPH_ACCOUNT: MicrosoftGraphConfiguredAccount = {
  id: 'graph',
  name: 'Graph',
  backend: 'microsoft-graph',
  user: 'reader@example.com',
};

const EWS_ACCOUNT: EwsConfiguredAccount = {
  id: 'ews',
  name: 'EWS',
  backend: 'ews',
  user: 'reader@example.com',
  endpoint: 'https://exchange.example.com/EWS/Exchange.asmx',
};

const MAILTRAP_ACCOUNT: MailtrapConfiguredAccount = {
  id: 'mailtrap',
  name: 'Mailtrap',
  backend: 'mailtrap',
  accountId: '42',
};

const IMAP_ACCOUNT: ConfiguredAccount = {
  id: 'imap',
  name: 'IMAP',
  backend: 'imap-smtp',
  host: 'imap.example.com',
  port: 993,
  user: 'reader@example.com',
  authType: 'login',
  useTLS: true,
};

function factories(overrides: Partial<ProviderRuntimeFactories>): ProviderRuntimeFactories {
  return {
    appleMail: () => { throw new Error('unexpected Apple Mail factory'); },
    microsoftGraph: () => { throw new Error('unexpected Graph factory'); },
    ews: () => { throw new Error('unexpected EWS factory'); },
    mailtrap: () => { throw new Error('unexpected Mailtrap factory'); },
    ...overrides,
  };
}

function options(
  accounts: ConfiguredAccount[],
  factoryOverrides: Partial<ProviderRuntimeFactories>,
  other: Omit<ProviderRuntimeOptions, 'getAccounts' | 'factories'> = {},
): ProviderRuntimeOptions {
  return {
    getAccounts: vi.fn().mockResolvedValue(accounts),
    factories: factories(factoryOverrides),
    ...other,
  };
}

describe('ProviderRuntime account and client lifecycle', () => {
  it('shares one lazily-created Apple Mail adapter across HTTP session runtimes', async () => {
    const state = new MailMCPRuntimeState();
    const listAccounts = vi.fn().mockResolvedValue([]);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const adapter = { listAccounts, disconnect } as unknown as AppleMailAdapter;
    const createAppleMail = vi.fn().mockReturnValue(adapter);
    const runtimeOptions = options([APPLE_ACCOUNT], { appleMail: createAppleMail });
    const firstSession = new ProviderRuntime(state, runtimeOptions);
    const secondSession = new ProviderRuntime(state, runtimeOptions);

    await Promise.all([
      firstSession.executeAppleRead('apple', 'listAccounts', {}),
      secondSession.executeAppleRead('apple', 'listAccounts', {}),
    ]);

    expect(createAppleMail).toHaveBeenCalledOnce();
    expect(listAccounts).toHaveBeenCalledTimes(2);
    expect(state.appleMailAdapters.get('apple')).toBe(adapter);

    await state.shutdown();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(state.appleMailAdapters.size).toBe(0);
    expect(state.providerCreations.size).toBe(0);
  });

  it('waits for a provider creation during shutdown and clears the created client', async () => {
    const state = new MailMCPRuntimeState();
    let finishCreation!: () => void;
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const adapter = { listAccounts: vi.fn().mockResolvedValue([]), disconnect } as unknown as AppleMailAdapter;
    const creationGate = new Promise<AppleMailAdapter>(resolve => {
      finishCreation = () => resolve(adapter);
    });
    const runtime = new ProviderRuntime(state, options([APPLE_ACCOUNT], {
      appleMail: () => creationGate as unknown as AppleMailAdapter,
    }));

    const operation = runtime.executeAppleRead('apple', 'listAccounts', {});
    await vi.waitFor(() => expect(state.providerCreations.size).toBe(1));
    const shutdown = state.shutdown();
    finishCreation();

    await Promise.all([operation, shutdown]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(state.appleMailAdapters.size).toBe(0);
  });

  it('rejects missing accounts and backend mismatches before creating a client', async () => {
    const createAppleMail = vi.fn();
    const runtime = new ProviderRuntime(
      new MailMCPRuntimeState(),
      options([IMAP_ACCOUNT], { appleMail: createAppleMail }),
    );

    await expect(runtime.executeAppleRead('missing', 'listAccounts', {})).rejects
      .toMatchObject<Partial<ProviderRuntimeError>>({ code: 'ACCOUNT_NOT_FOUND' });
    await expect(runtime.executeAppleRead('imap', 'listAccounts', {})).rejects
      .toMatchObject<Partial<ProviderRuntimeError>>({ code: 'BACKEND_MISMATCH' });
    expect(createAppleMail).not.toHaveBeenCalled();
  });

  it('rejects new work after shutdown', async () => {
    const state = new MailMCPRuntimeState();
    const runtime = new ProviderRuntime(state, options([APPLE_ACCOUNT], {
      appleMail: () => ({ listAccounts: vi.fn() } as unknown as AppleMailAdapter),
    }));
    await state.shutdown();

    await expect(runtime.executeAppleRead('apple', 'listAccounts', {})).rejects
      .toMatchObject<Partial<ProviderRuntimeError>>({ code: 'RUNTIME_SHUTTING_DOWN' });
  });
});

describe('ProviderRuntime provider dispatch', () => {
  it('pins Apple Mail operations to the configured native account selector', async () => {
    const listMailboxes = vi.fn().mockResolvedValue([]);
    const createAppleMail = vi.fn().mockReturnValue({ listMailboxes } as unknown as AppleMailAdapter);
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [{
        ...APPLE_ACCOUNT,
        nativeAccountName: 'Work Mail',
        nativeAccountUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      }],
      { appleMail: createAppleMail },
    ));

    await expect(runtime.executeAppleRead('apple', 'listMailboxes', {
      account: 'Personal Mail',
    })).rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'ACCOUNT_SCOPE_MISMATCH' });
    expect(createAppleMail).not.toHaveBeenCalled();

    await runtime.executeAppleRead('apple', 'listMailboxes', { account: 'Work Mail' });
    expect(listMailboxes).toHaveBeenCalledWith({
      account: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    });
  });

  it('uses an opaque stable cursor for Apple Mail list pagination and rejects offset', async () => {
    const messages = [
      { id: '3', rfcMessageId: null, subject: 'Three', sender: 'a@example.com', to: [], cc: [], dateReceived: null, read: false, flagged: false, snippet: '' },
      { id: '2', rfcMessageId: null, subject: 'Two', sender: 'a@example.com', to: [], cc: [], dateReceived: null, read: false, flagged: false, snippet: '' },
      { id: '1', rfcMessageId: null, subject: 'One', sender: 'a@example.com', to: [], cc: [], dateReceived: null, read: false, flagged: false, snippet: '' },
    ];
    const listMessages = vi.fn().mockResolvedValue(messages);
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [{ ...APPLE_ACCOUNT, nativeAccountName: 'iCloud' }],
      { appleMail: () => ({ listMessages } as unknown as AppleMailAdapter) },
    ));

    const first = await runtime.executeAppleRead('apple', 'listMessages', {
      account: 'iCloud',
      mailbox: 'Inbox',
      limit: 2,
    });
    const second = await runtime.executeAppleRead('apple', 'listMessages', {
      account: 'iCloud',
      mailbox: 'Inbox',
      limit: 2,
      cursor: first.nextCursor!,
    });

    expect(first.items.map(message => message.id)).toEqual(['3', '2']);
    expect(first.nextCursor).toMatch(/^page:v1:/);
    expect(second.items.map(message => message.id)).toEqual(['1']);
    expect(second.nextCursor).toBeNull();
    expect(listMessages).toHaveBeenCalledOnce();
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({
      account: 'iCloud',
      mailbox: 'Inbox',
      maxItems: 10_000,
    }));

    await expect(runtime.executeAppleRead('apple', 'listMessages', {
      account: 'iCloud',
      mailbox: 'Inbox',
      limit: 2,
      offset: 2,
    } as never)).rejects.toMatchObject<Partial<ProviderRuntimeError>>({
      code: 'OPERATION_NOT_ALLOWED',
    });
  });

  it('allows discovery but rejects scoped Apple Mail operations for an unbound account', async () => {
    const listAccounts = vi.fn().mockResolvedValue([]);
    const listMailboxes = vi.fn();
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [APPLE_ACCOUNT],
      {
        appleMail: () => ({ listAccounts, listMailboxes } as unknown as AppleMailAdapter),
      },
    ));

    await expect(runtime.executeAppleRead('apple', 'listAccounts', {})).resolves.toEqual([]);
    await expect(runtime.executeAppleRead('apple', 'listMailboxes', {
      account: 'Unbound account selector',
    })).rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'ACCOUNT_SCOPE_MISMATCH' });
    expect(listMailboxes).not.toHaveBeenCalled();
  });

  it('uses getValidAccessToken for Graph and does not load a raw keychain secret', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('graph-access-token');
    const loadSecret = vi.fn();
    const getMessage = vi.fn().mockResolvedValue({ id: 'message-1' });
    let tokenProvider!: () => Promise<string>;
    const graphFactory = vi.fn((
      _account: MicrosoftGraphConfiguredAccount,
      provider: () => Promise<string>,
    ) => {
      tokenProvider = provider;
      return {
        getMessage: async (messageId: string) => {
          expect(await tokenProvider()).toBe('graph-access-token');
          return await getMessage(messageId);
        },
      } as unknown as MicrosoftGraphClient;
    });
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [GRAPH_ACCOUNT],
      { microsoftGraph: graphFactory },
      { getValidAccessToken: getAccessToken, loadCredentials: loadSecret },
    ));

    await expect(runtime.executeMicrosoftRead('graph', 'getMessage', {
      messageId: 'message-1',
    })).resolves.toEqual({ id: 'message-1' });
    expect(graphFactory).toHaveBeenCalledOnce();
    expect(getAccessToken).toHaveBeenCalledWith('graph');
    expect(loadSecret).not.toHaveBeenCalled();
  });

  it('rejects Graph-only unsupported operations before creating a client', async () => {
    const graphFactory = vi.fn();
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [GRAPH_ACCOUNT],
      { microsoftGraph: graphFactory },
    ));

    await expect(runtime.executeMicrosoftRead('graph', 'searchMessages', { query: 'status' }))
      .rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'OPERATION_NOT_ALLOWED' });
    expect(graphFactory).not.toHaveBeenCalled();
  });

  it('routes EWS-only operations and rejects Graph-only operations on EWS', async () => {
    const searchMessages = vi.fn().mockResolvedValue([{ itemId: 'ews-1' }]);
    const ews = { searchMessages } as unknown as EwsClient;
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [EWS_ACCOUNT],
      { ews: () => ews },
    ));

    await expect(runtime.executeMicrosoftRead('ews', 'searchMessages', { maxResults: 10 }))
      .resolves.toEqual([{ itemId: 'ews-1' }]);
    await expect(runtime.executeMicrosoftRead('ews', 'getThread', {
      anchor: { id: 'graph-1' },
    })).rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'OPERATION_NOT_ALLOWED' });
  });

  it('loads one Mailtrap token from keychain and redacts sensitive successful responses', async () => {
    const loadSecret = vi.fn().mockResolvedValue('mailtrap-secret-token');
    const execute = vi.fn().mockResolvedValue({
      id: 7,
      smtp_username: 'visible-user',
      smtp_password: 'must-not-leak',
    });
    const client = { execute } as unknown as MailtrapClient;
    const mailtrapFactory = vi.fn((
      _account: MailtrapConfiguredAccount,
      token: string,
    ) => {
      expect(token).toBe('mailtrap-secret-token');
      return client;
    });
    const state = new MailMCPRuntimeState();
    const runtimeOptions = options(
      [MAILTRAP_ACCOUNT],
      { mailtrap: mailtrapFactory },
      { loadCredentials: loadSecret, redact: true },
    );
    const firstSession = new ProviderRuntime(state, runtimeOptions);
    const secondSession = new ProviderRuntime(state, runtimeOptions);
    const input = { resource: 'inbox', operation: 'get', inboxId: 7 } as const;

    await expect(firstSession.executeMailtrapRead('mailtrap', 'sandbox', input)).resolves.toEqual({
      id: 7,
      smtp_username: '[REDACTED]',
      smtp_password: '[REDACTED]',
    });
    await secondSession.executeMailtrapRead('mailtrap', 'sandbox', input);

    expect(loadSecret).toHaveBeenCalledOnce();
    expect(mailtrapFactory).toHaveBeenCalledOnce();
  });

  it('applies the content redaction option to Apple and Microsoft responses', async () => {
    const appleReadMessage = vi.fn().mockResolvedValue({
      id: 'apple-message',
      subject: 'password: apple-secret',
      content: 'Card 4111 1111 1111 1111',
    });
    const graphGetMessage = vi.fn().mockResolvedValue({
      id: 'graph-message',
      subject: 'password: graph-secret',
    });
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [
        { ...APPLE_ACCOUNT, nativeAccountName: 'iCloud' },
        GRAPH_ACCOUNT,
      ],
      {
        appleMail: () => ({ readMessage: appleReadMessage } as unknown as AppleMailAdapter),
        microsoftGraph: () => ({ getMessage: graphGetMessage } as unknown as MicrosoftGraphClient),
      },
      { redact: true, getValidAccessToken: vi.fn().mockResolvedValue('token') },
    ));

    await expect(runtime.executeAppleRead('apple', 'readMessage', {
      account: 'iCloud', messageId: 'apple-message',
    })).resolves.toMatchObject({
      subject: 'password: [REDACTED]',
      content: 'Card [REDACTED CC]',
    });
    await expect(runtime.executeMicrosoftRead('graph', 'getMessage', {
      messageId: 'graph-message',
    })).resolves.toMatchObject({ subject: 'password: [REDACTED]' });
  });

  it('enforces Mailtrap classification before credentials or network execution', async () => {
    const loadSecret = vi.fn().mockResolvedValue('unused');
    const execute = vi.fn();
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [MAILTRAP_ACCOUNT],
      { mailtrap: () => ({ execute } as unknown as MailtrapClient) },
      { loadCredentials: loadSecret },
    ));

    await expect(runtime.executeMailtrapRead('mailtrap', 'send', {
      operation: 'transactional',
      message: { subject: 'Write passed to read method' },
    })).rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'OPERATION_NOT_ALLOWED' });
    await expect(runtime.executeMailtrapWrite('mailtrap', 'email_logs', {
      operation: 'list',
    })).rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'OPERATION_NOT_ALLOWED' });

    expect(loadSecret).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a missing Mailtrap keychain token without creating a client', async () => {
    const mailtrapFactory = vi.fn();
    const runtime = new ProviderRuntime(new MailMCPRuntimeState(), options(
      [MAILTRAP_ACCOUNT],
      { mailtrap: mailtrapFactory },
      { loadCredentials: vi.fn().mockResolvedValue(null) },
    ));

    await expect(runtime.executeMailtrapRead('mailtrap', 'accounts', { operation: 'list' }))
      .rejects.toMatchObject<Partial<ProviderRuntimeError>>({ code: 'CREDENTIALS_MISSING' });
    expect(mailtrapFactory).not.toHaveBeenCalled();
  });
});
