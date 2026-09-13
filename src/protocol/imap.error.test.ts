import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
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
});
