import { createServer, type Socket, type AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
vi.mock('../security/keychain.js', () => ({ loadCredentials: vi.fn(async () => 'DUMMY_SECRET') }));
import { SmtpClient } from './smtp.js';

it('closes a real verification socket before credentials can be sent after disconnect', async () => {
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>(resolve => { accept = resolve; });
  const auth: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    socket.on('error', () => undefined); sockets.add(socket); socket.once('close', () => sockets.delete(socket)); accept(socket);
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString();
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'), line = pending.slice(0, end); pending = pending.slice(end + 2);
        if (/^EHLO/.test(line)) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) { auth.push(Buffer.from(line.slice(11), 'base64').toString()); socket.write('235 authenticated\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new SmtpClient({ id: 'fixture', name: 'fixture', user: 'x@example.test', host: '127.0.0.1', port: 993, smtpPort: (server.address() as AddressInfo).port, smtpSecurity: 'plain', authType: 'login', useTLS: true });
  try {
    const pending = client.connect().catch(error => error);
    const socket = await accepted;
    client.disconnect();
    socket.write('220 fixture ESMTP\r\n');
    const result = await pending;
    expect(result.message).toBe('SMTP connection was cancelled');
    expect(auth).toHaveLength(0);
  } finally {
    client.disconnect(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
