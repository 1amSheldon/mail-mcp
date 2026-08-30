import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    expect(script).toContain("$health.service -eq 'mail-mcp'");
    expect(script).toContain('Stop-Process -Id $_ -Force');
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
        stdout: script.includes('[Console]::Out.Write') ? 'existing-test-token' : '',
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
      call.environment?.MAIL_MCP_HEALTH_URL === result.healthUrl &&
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
      return { stdout: '', stderr: '' };
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
});
