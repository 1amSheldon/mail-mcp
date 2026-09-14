import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapClient } from './imap.js';
import type { EmailAccount } from '../config.js';

vi.mock('../security/keychain.js', () => ({
  loadCredentials: vi.fn(() => Promise.resolve('test-password'))
}));

// A minimal ImapFlow stand-in that is a real EventEmitter, so that emitting
// 'error' behaves exactly as Node does: it throws when nobody is listening.
const flows: EventEmitter[] = [];
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function () {
    const flow = Object.assign(new EventEmitter(), {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      usable: true
    });
    flows.push(flow);
    return flow;
  })
}));

describe('ImapClient connection errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    flows.length = 0;
  });
  const account: EmailAccount = {
    id: 'test-account',
    name: 'Test',
    host: 'imap.test.com',
    port: 993,
    user: 'test@test.com',
    authType: 'login',
    useTLS: true
  };

  it('survives an error emitted by the IMAP client after connect', async () => {
    const client = new ImapClient(account);
    await client.connect();
    const flow = flows[flows.length - 1];
    const timeout = Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' });

    // imapflow's inactivity watchdog does exactly this while the server is idle.
    expect(() => flow.emit('error', timeout)).not.toThrow();
  });

  it('still notifies onClose when the connection closes after an error', async () => {
    const client = new ImapClient(account);
    const onClose = vi.fn();
    client.onClose = onClose;
    await client.connect();
    const flow = flows[flows.length - 1];

    flow.emit('error', new Error('Socket timeout'));
    flow.emit('close');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles error events during connection and preserves connect rejection', async () => {
    const failure = Object.assign(new Error('Connection failed'), { code: 'ECONNECTION' });
    const flow = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => {
        expect(() => flow.emit('error', failure)).not.toThrow();
        flow.emit('close');
        throw failure;
      }),
    });
    vi.mocked(ImapFlow).mockImplementationOnce(function () { return flow as unknown as ImapFlow; });
    const client = new ImapClient(account);
    client.onClose = vi.fn();

    await expect(client.connect()).rejects.toBe(failure);
    expect(client.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not log server-controlled error text or unsafe error codes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new ImapClient(account);
    await client.connect();
    const flow = flows[flows.length - 1];

    flow.emit('error', Object.assign(new Error('password=secret'), { code: 'ETIMEOUT' }));
    flow.emit('error', Object.assign(new Error('password=secret'), { code: '\npassword=secret' }));

    expect(log.mock.calls).toEqual([
      ['[IMAP] connection error (ETIMEOUT)'],
      ['[IMAP] connection error (UNKNOWN)'],
    ]);
  });
});
