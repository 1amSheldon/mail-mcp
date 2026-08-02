import { createRequire } from 'node:module';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    smtpPort: number;
  }
}

const require = createRequire(import.meta.url);
const { SMTPServer } = require('smtp-server') as typeof import('smtp-server');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: InstanceType<(typeof import('smtp-server'))['SMTPServer']>;
const receivedMessages: string[] = [];

export async function setup(project: TestProject) {
  server = new SMTPServer({
    secure: false,
    authOptional: true,
    onData(stream: NodeJS.ReadableStream, _session: unknown, callback: (err?: Error | null) => void) {
      let data = '';
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      stream.on('end', () => {
        receivedMessages.push(data);
        callback();
      });
    },
  });

  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  // SMTPServer wraps a net.Server in server.server; address() is on the inner server
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const port = ((server as any).server.address() as { port: number }).port;
  project.provide('smtpPort', port);
}

export async function teardown() {
  await new Promise<void>((resolve, reject) =>
    server.close((err: Error | null) => (err ? reject(err) : resolve()))
  );
}

export { receivedMessages };
