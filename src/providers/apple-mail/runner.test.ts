import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OsascriptRunner } from './runner.js';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn().mockReturnValue(true);
  return child;
}

describe('OsascriptRunner', () => {
  it('writes the program to stdin and captures stdout', async () => {
    const child = fakeChild();
    const input: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => input.push(chunk));
    const runner = new OsascriptRunner({
      platform: 'darwin',
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    const resultPromise = runner.run('return "{\\"ok\\":true}"');
    child.stdout.write('{"ok":true}\n');
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toBe('{"ok":true}');
    expect(Buffer.concat(input).toString('utf8')).toBe('return "{\\"ok\\":true}"');
  });

  it('maps macOS Automation/TCC denial to a typed permission error', async () => {
    const child = fakeChild();
    const runner = new OsascriptRunner({
      platform: 'darwin',
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    });

    const resultPromise = runner.run('return "[]"');
    child.stderr.write('Not authorized to send Apple events to Mail. (-1743)');
    child.emit('close', 1, null);

    await expect(resultPromise).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('terminates and then force-kills a timed-out child', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const runner = new OsascriptRunner({
        platform: 'darwin',
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
        timeoutMs: 10,
        killGraceMs: 5,
      });

      const resultPromise = runner.run('return "[]"');
      const assertion = expect(resultPromise).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(5);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses execution on Windows before spawning a process', async () => {
    const spawnProcess = vi.fn();
    const runner = new OsascriptRunner({ platform: 'win32', spawnProcess });

    await expect(runner.run('return "[]"')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PLATFORM',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
