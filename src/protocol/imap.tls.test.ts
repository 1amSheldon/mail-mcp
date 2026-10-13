import { createServer, type Socket, type AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { ImapClient } from './imap.js';

vi.mock('../security/keychain.js', () => ({ loadCredentials: vi.fn(async () => 'DUMMY_SECRET') }));

it('rejects an IMAP server without STARTTLS before sending any credentials', async () => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK [CAPABILITY IMAP4rev1] fixture\r\n');
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n');
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        commands.push(line);
        const [tag, command] = line.split(' ');
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK capability\r\n`);
        else socket.write(`${tag} NO unavailable\r\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ImapClient({ id: 'tls-fixture', name: 'fixture', host: '127.0.0.1',
    port: (server.address() as AddressInfo).port, user: 'fixture@example.test', authType: 'login', useTLS: false });
  try {
    await expect(client.connect()).rejects.toThrow();
    expect(commands.some(command => /LOGIN|AUTHENTICATE|DUMMY_SECRET/.test(command))).toBe(false);
  } finally {
    await client.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
