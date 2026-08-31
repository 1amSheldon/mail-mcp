import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppleMailError, appleMailExecutionError } from './errors.js';

export interface AppleScriptRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface AppleScriptRunner {
  run(script: string, options?: AppleScriptRunOptions): Promise<string>;
}

export type OsascriptSpawner = () => ChildProcessWithoutNullStreams;

export interface OsascriptRunnerOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: OsascriptSpawner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export class OsascriptRunner implements AppleScriptRunner {
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: OsascriptSpawner;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(options: OsascriptRunnerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? (() => spawn(
      '/usr/bin/osascript',
      [],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    this.killGraceMs = options.killGraceMs ?? 250;
  }

  async run(script: string, options: AppleScriptRunOptions = {}): Promise<string> {
    if (this.platform !== 'darwin') {
      throw new AppleMailError(
        'UNSUPPORTED_PLATFORM',
        'The Apple Mail provider is available only on macOS.',
      );
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.maxOutputBytes;

    return await new Promise<string>((resolve, reject) => {
      const child = this.spawnProcess();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let closed = false;
      let forceKill: NodeJS.Timeout | undefined;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (closed && forceKill) clearTimeout(forceKill);
        callback();
      };

      const stop = (): void => {
        child.kill('SIGTERM');
        forceKill = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, this.killGraceMs);
        forceKill.unref?.();
      };

      const timeout = setTimeout(() => {
        stop();
        finish(() => reject(new AppleMailError(
          'TIMEOUT',
          `Apple Mail automation exceeded ${timeoutMs}ms.`,
        )));
      }, timeoutMs);
      timeout.unref?.();

      child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > maxOutputBytes) {
          stop();
          finish(() => reject(new AppleMailError(
            'OUTPUT_LIMIT',
            `Apple Mail automation exceeded the ${maxOutputBytes}-byte output limit.`,
          )));
          return;
        }
        stdout.push(buffer);
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.once('error', (error) => {
        finish(() => reject(appleMailExecutionError(error.message, error)));
      });
      child.once('close', (code, signal) => {
        closed = true;
        finish(() => {
          const errorText = Buffer.concat(stderr).toString('utf8');
          if (code !== 0) {
            reject(appleMailExecutionError(
              errorText || `osascript exited with code ${String(code)} (${String(signal)}).`,
            ));
            return;
          }
          resolve(Buffer.concat(stdout).toString('utf8').trim());
        });
      });

      child.stdin.on('error', (error) => {
        finish(() => reject(appleMailExecutionError(error.message, error)));
      });
      child.stdin.end(script, 'utf8');
    });
  }
}
