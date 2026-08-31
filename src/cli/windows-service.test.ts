import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import {
  buildWindowsServiceLauncher,
  buildWindowsServiceSupervisor,
  buildWindowsTaskRegistrationScript,
  getWindowsServicePaths,
  HTTP_BEARER_TOKEN_ENV,
  installWindowsHttpService,
} from './windows-service.js';

describe('managed Windows HTTP service', () => {
  const tempDirectories: string[] = [];
  const originalToken = process.env[HTTP_BEARER_TOKEN_ENV];

  afterEach(async () => {
    if (originalToken === undefined) {
      delete process.env[HTTP_BEARER_TOKEN_ENV];
    } else {
      process.env[HTTP_BEARER_TOKEN_ENV] = originalToken;
    }
    await Promise.all(
      tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
    );
  });

  it('builds a launcher that loads the user token and starts the supervisor', () => {
    const paths = getWindowsServicePaths('C:\\Users\\test');
    const launcher = buildWindowsServiceLauncher({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      paths,
    });

    expect(launcher).toContain("'MAIL_MCP_BEARER_TOKEN'");
    expect(launcher).toContain("'C:\\Program Files\\nodejs\\node.exe'");
    expect(launcher).toContain(`'${paths.supervisorPath}'`);
  });

  it('builds a self-healing loopback supervisor that resolves the latest npm release', () => {
    const supervisor = buildWindowsServiceSupervisor({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      npxCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
      paths: getWindowsServicePaths('C:\\Users\\test'),
    });

    expect(supervisor).toContain('--package=@1amsheldon/mail-mcp@latest');
    expect(supervisor).toContain('"--http"');
    expect(supervisor).toContain('"127.0.0.1"');
    expect(supervisor).toContain('"--auto-update-seconds"');
    expect(supervisor).toContain('"21600"');
    expect(supervisor).toContain('"--confirm"');
    expect(supervisor).toContain('"--audit-log"');
    expect(supervisor).toContain('"--redact"');
    expect(supervisor).toContain('while (!stopping');
    expect(supervisor).toContain('child exited with code');
    expect(supervisor).toContain('shell: false');
    expect(() => new Script(supervisor)).not.toThrow();
  });

  it('refuses to generate a managed service on a public bind address', () => {
    expect(() => buildWindowsServiceSupervisor({
      nodePath: 'node.exe',
      npxCliPath: 'npx-cli.js',
      paths: getWindowsServicePaths('C:\\Users\\test'),
      host: '0.0.0.0',
    })).toThrow('must bind to loopback');
  });

  it('registers logon and watchdog triggers with duplicate suppression', () => {
    const script = buildWindowsTaskRegistrationScript();

    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).toContain('RepetitionInterval (New-TimeSpan -Minutes 5)');
    expect(script).toContain('-MultipleInstances IgnoreNew');
    expect(script).toContain('Get-MailMcpPortListeners');
    expect(script).toContain('after stopping the managed task');
    expect(script).toContain('will not terminate listener processes automatically');
    expect(script).not.toContain('Stop-Process');
    expect(script).not.toContain('OwningProcess');
    expect(script).toContain('Start-ScheduledTask');
  });

  it('writes the launcher and supervisor, reuses the user token, registers the task, and waits for health', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mail-mcp-service-home-'));
    tempDirectories.push(home);
    const calls: Array<{ script: string; environment?: NodeJS.ProcessEnv }> = [];
    const runPowerShell = vi.fn(async (
      script: string,
      environment?: NodeJS.ProcessEnv
    ) => {
      calls.push({ script, environment });
      return {
        stdout: script.includes('GetEnvironmentVariable')
          ? 'existing-test-token'
          : script.includes('ConvertTo-Json -Compress')
            ? '{"exists":false,"wasRunning":false}'
            : '',
        stderr: '',
      };
    });
    const waitForHealth = vi.fn().mockResolvedValue(undefined);

    const result = await installWindowsHttpService(
      { home },
      {
        platform: 'win32',
        runPowerShell,
        resolveNpxCliPath: async () =>
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
        waitForHealth,
      }
    );

    expect(result.reusedBearerToken).toBe(true);
    expect(result.url).toBe('http://127.0.0.1:8765/mcp');
    expect(waitForHealth).toHaveBeenCalledWith('http://127.0.0.1:8765/health');
    const launcher = await readFile(result.launcherPath, 'utf8');
    const supervisor = await readFile(result.supervisorPath, 'utf8');
    expect(launcher).toContain('supervisor.cjs');
    expect(supervisor).toContain('--package=@1amsheldon/mail-mcp@latest');
    expect(launcher).not.toContain('existing-test-token');
    expect(supervisor).not.toContain('existing-test-token');
    expect(calls.some(call => call.environment?.MAIL_MCP_ENV_VALUE === 'existing-test-token')).toBe(true);
    expect(calls.some(call =>
      call.environment?.MAIL_MCP_TASK_NAME === result.taskName &&
      call.environment?.MAIL_MCP_SERVICE_PORT === '8765'
    )).toBe(true);
  });

  it('generates a strong token without printing it into the launcher', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mail-mcp-service-token-home-'));
    tempDirectories.push(home);
    let persistedToken: string | undefined;
    const runPowerShell = vi.fn(async (
      script: string,
      environment?: NodeJS.ProcessEnv
    ) => {
      if (script.includes('SetEnvironmentVariable')) {
        persistedToken = environment?.MAIL_MCP_ENV_VALUE;
      }
      return {
        stdout: script.includes('ConvertTo-Json -Compress')
          ? '{"exists":false,"wasRunning":false}'
          : '',
        stderr: '',
      };
    });

    const result = await installWindowsHttpService(
      { home },
      {
        platform: 'win32',
        runPowerShell,
        resolveNpxCliPath: async () => 'npx-cli.js',
        waitForHealth: async () => {},
      }
    );

    expect(result.reusedBearerToken).toBe(false);
    expect(persistedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await readFile(result.launcherPath, 'utf8')).not.toContain(persistedToken!);
    expect(await readFile(result.supervisorPath, 'utf8')).not.toContain(persistedToken!);
  });

  it('restores service files, task, token, and stop-file state after a health failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mail-mcp-service-rollback-home-'));
    tempDirectories.push(home);
    const paths = getWindowsServicePaths(home);
    const stopFile = join(paths.serviceDirectory, 'stop');
    await mkdir(paths.serviceDirectory, { recursive: true });
    await writeFile(paths.launcherPath, Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6c, 0x64]));
    await writeFile(paths.supervisorPath, 'old supervisor\r\n', 'utf8');
    await writeFile(stopFile, 'old stop\n', 'utf8');
    const oldLauncher = await readFile(paths.launcherPath);
    const taskXmlBase64 = Buffer.from('<Task>old</Task>', 'utf8').toString('base64');
    const calls: Array<{ script: string; environment?: NodeJS.ProcessEnv }> = [];
    process.env[HTTP_BEARER_TOKEN_ENV] = 'old-process-token';

    const runPowerShell = vi.fn(async (
      script: string,
      environment?: NodeJS.ProcessEnv,
    ) => {
      calls.push({ script, environment });
      if (script.includes('GetEnvironmentVariable')) {
        return { stdout: 'old-user-token', stderr: '' };
      }
      if (script.includes('ConvertTo-Json -Compress')) {
        return {
          stdout: JSON.stringify({
            exists: true,
            xmlBase64: taskXmlBase64,
            wasRunning: true,
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(installWindowsHttpService(
      { home },
      {
        platform: 'win32',
        runPowerShell,
        resolveNpxCliPath: async () => 'npx-cli.js',
        waitForHealth: async () => { throw new Error('health failed'); },
      },
    )).rejects.toThrow('health failed');

    expect(await readFile(paths.launcherPath)).toEqual(oldLauncher);
    expect(await readFile(paths.supervisorPath, 'utf8')).toBe('old supervisor\r\n');
    expect(await readFile(stopFile, 'utf8')).toBe('old stop\n');
    expect(process.env[HTTP_BEARER_TOKEN_ENV]).toBe('old-process-token');
    expect(calls.some(call =>
      call.script.includes('MailMcpEnvironmentRestoreBroadcast')
      && call.environment?.MAIL_MCP_ENV_VALUE === 'old-user-token'
      && call.environment?.MAIL_MCP_ENV_WAS_PRESENT === '1'
    )).toBe(true);
    expect(calls.some(call =>
      call.script.includes('Register-ScheduledTask')
      && call.script.includes('MAIL_MCP_TASK_XML_B64')
      && call.environment?.MAIL_MCP_TASK_XML_B64 === taskXmlBase64
      && call.environment?.MAIL_MCP_TASK_WAS_RUNNING === '1'
    )).toBe(true);
  });

  it('removes newly created service state after a failed first install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mail-mcp-service-new-rollback-home-'));
    tempDirectories.push(home);
    const paths = getWindowsServicePaths(home);
    const calls: Array<{ script: string; environment?: NodeJS.ProcessEnv }> = [];
    delete process.env[HTTP_BEARER_TOKEN_ENV];
    const runPowerShell = vi.fn(async (
      script: string,
      environment?: NodeJS.ProcessEnv,
    ) => {
      calls.push({ script, environment });
      return {
        stdout: script.includes('ConvertTo-Json -Compress')
          ? '{"exists":false,"wasRunning":false}'
          : '',
        stderr: '',
      };
    });

    await expect(installWindowsHttpService(
      { home },
      {
        platform: 'win32',
        runPowerShell,
        resolveNpxCliPath: async () => 'npx-cli.js',
        waitForHealth: async () => { throw new Error('health failed'); },
      },
    )).rejects.toThrow('health failed');

    await expect(readFile(paths.launcherPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.supervisorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(paths.serviceDirectory, 'stop'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.env[HTTP_BEARER_TOKEN_ENV]).toBeUndefined();
    expect(calls.some(call =>
      call.script.includes('MailMcpEnvironmentRestoreBroadcast')
      && call.environment?.MAIL_MCP_ENV_WAS_PRESENT === '0'
    )).toBe(true);
    expect(calls.some(call => call.script.includes('Unregister-ScheduledTask'))).toBe(true);
  });

  it('reports both the install error and an incomplete rollback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mail-mcp-service-rollback-error-home-'));
    tempDirectories.push(home);
    const runPowerShell = vi.fn(async (script: string) => {
      if (script.includes('ConvertTo-Json -Compress')) {
        return { stdout: '{"exists":false,"wasRunning":false}', stderr: '' };
      }
      if (script.includes('Unregister-ScheduledTask')) {
        throw new Error('rollback task cleanup failed');
      }
      return { stdout: '', stderr: '' };
    });

    let failure: unknown;
    try {
      await installWindowsHttpService(
        { home },
        {
          platform: 'win32',
          runPowerShell,
          resolveNpxCliPath: async () => 'npx-cli.js',
          waitForHealth: async () => { throw new Error('health failed'); },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      'Windows service installation failed and the previous state could not be fully restored',
    );
    expect(JSON.stringify((failure as AggregateError).errors.map(error => ({
      message: (error as Error).message,
      nested: error instanceof AggregateError
        ? error.errors.map(nested => (nested as Error).message)
        : [],
    })))).toContain('health failed');
    expect(JSON.stringify((failure as AggregateError).errors.map(error => ({
      message: (error as Error).message,
      nested: error instanceof AggregateError
        ? error.errors.map(nested => (nested as Error).message)
        : [],
    })))).toContain('rollback task cleanup failed');
  });
});
