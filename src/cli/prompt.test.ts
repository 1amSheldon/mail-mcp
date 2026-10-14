import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createAccountPrompt } from './prompt.js';

function terminal() {
  const input = new PassThrough();
  let transcript = '';
  const output = new Writable({ write(chunk, _encoding, done) { transcript += chunk.toString(); done(); } });
  Object.assign(input, { isTTY: true, setRawMode() {} });
  Object.assign(output, { isTTY: true, columns: 80 });
  return { input, output, transcript: () => transcript };
}

describe('account secret prompts', () => {
  it('uses the real terminal readline without echoing secrets or retaining them in history', async () => {
    const io = terminal();
    const prompt = createAccountPrompt(io.input, io.output);
    try {
      const password = prompt.secret('Password: ');
      io.input.write('SENTINEL-secret-123\r');
      expect(await password).toBe('SENTINEL-secret-123');
      const question = prompt.question('Name: ');
      io.input.write('\x1b[A'); // Up arrow must not recover the previous secret.
      io.input.write('Alice\r');
      expect(await question).toBe('Alice');
      await new Promise(resolve => setImmediate(resolve));
      expect(io.transcript()).toContain('Password: ');
      expect(io.transcript()).toContain('Alice');
      expect(io.transcript()).not.toContain('SENTINEL');
      expect(io.transcript()).not.toContain('secret-123');
    } finally { prompt.close(); }
  });

  it('cancels a pending secret question on terminal close', async () => {
    const io = terminal();
    const prompt = createAccountPrompt(io.input, io.output);
    const pending = expect(prompt.secret('Token: ')).rejects.toMatchObject({ name: 'AbortError' });
    prompt.close();
    await pending;
  });
});
