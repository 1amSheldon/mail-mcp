import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface QuestionPrompt {
  question(query: string): Promise<string>;
  secret(query: string): Promise<string>;
  close(): void;
}

export function createAccountPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): QuestionPrompt {
  let muted = false;
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      output.write(chunk, encoding, callback);
    },
  });
  const write = proxy.write.bind(proxy);
  // Filter before Writable queues a chunk: an asynchronous output may drain
  // after the prompt has been unmuted, which must never reveal queued input.
  proxy.write = (chunk: any, encodingOrCallback?: any, callback?: any): boolean => {
    if (muted) {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      done?.();
      return true;
    }
    return write(chunk, encodingOrCallback, callback);
  };
  Object.defineProperty(proxy, 'columns', { get: () => (output as NodeJS.WriteStream).columns ?? 80 });
  const rl = createInterface({ input, output: proxy, terminal, historySize: 0 });
  const abort = new AbortController();
  rl.once('close', () => abort.abort());
  return {
    question: query => rl.question(query, { signal: abort.signal }),
    async secret(query) {
      output.write(query);
      muted = true;
      try {
        return await rl.question('', { signal: abort.signal });
      } finally {
        muted = false;
        output.write('\n');
      }
    },
    close() { abort.abort(); rl.close(); proxy.end(); },
  };
}
