import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic, writeTextFileAtomic } from '../utils/atomic-write.js';
import { MAIL_MCP_LATEST_SPEC, prepareMailMcpNpxRuntime } from './npm-runtime.js';

const execFileAsync = promisify(execFile);

export const WINDOWS_SERVICE_TASK_NAME = 'Mail MCP Local Service';
export const HTTP_BEARER_TOKEN_ENV = 'MAIL_MCP_BEARER_TOKEN';
export const SHARED_HTTP_HOST = '127.0.0.1';
export const SHARED_HTTP_PORT = 8765;
export const AUTO_UPDATE_INTERVAL_SECONDS = 6 * 60 * 60;
const SERVICE_START_TIMEOUT_MS = 90_000;

export interface WindowsServicePaths {
  serviceDirectory: string;
  launcherPath: string;
  supervisorPath: string;
  logDirectory: string;
  runtimePrefix: string;
}

export interface WindowsServiceInstallResult extends WindowsServicePaths {
  url: string;
  healthUrl: string;
  taskName: string;
  bearerTokenEnvVar: string;
  reusedBearerToken: boolean;
}

interface PowerShellResult {
  stdout: string;
  stderr: string;
}

interface ServiceFileSnapshot {
  path: string;
  content?: Buffer;
}

interface WindowsTaskSnapshot {
  exists: boolean;
  xmlBase64?: string;
  wasRunning: boolean;
}

interface WindowsServiceSnapshot {
  files: ServiceFileSnapshot[];
  task: WindowsTaskSnapshot;
  userToken?: string;
  processToken?: string;
}

export interface WindowsServiceDependencies {
  platform?: NodeJS.Platform;
  runPowerShell?: (
    script: string,
    extraEnvironment?: NodeJS.ProcessEnv
  ) => Promise<PowerShellResult>;
  resolveNpxCliPath?: () => Promise<string>;
  waitForHealth?: (healthUrl: string) => Promise<void>;
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertEnvironmentVariableName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
}

export function getWindowsServicePaths(home: string = homedir()): WindowsServicePaths {
  const serviceDirectory = join(home, '.config', 'mail-mcp', 'service');
  return {
    serviceDirectory,
    launcherPath: join(serviceDirectory, 'start.ps1'),
    supervisorPath: join(serviceDirectory, 'supervisor.cjs'),
    logDirectory: join(home, '.config', 'mail-mcp', 'logs'),
    runtimePrefix: join(home, '.cache', 'mail-mcp', 'npm-runtime'),
  };
}

export function buildWindowsServiceLauncher(options: {
  nodePath: string;
  paths: WindowsServicePaths;
  bearerTokenEnvVar?: string;
}): string {
  const bearerTokenEnvVar = options.bearerTokenEnvVar ?? HTTP_BEARER_TOKEN_ENV;
  assertEnvironmentVariableName(bearerTokenEnvVar);

  return `$ErrorActionPreference = 'Stop'
$tokenEnvironmentVariable = ${powershellLiteral(bearerTokenEnvVar)}
$token = [Environment]::GetEnvironmentVariable($tokenEnvironmentVariable, 'User')
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "$tokenEnvironmentVariable is not configured for the current user"
}

Set-Item -LiteralPath "Env:$tokenEnvironmentVariable" -Value $token
& ${powershellLiteral(options.nodePath)} ${powershellLiteral(options.paths.supervisorPath)}
exit $LASTEXITCODE
`;
}

export function buildWindowsServiceSupervisor(options: {
  nodePath: string;
  npxCliPath: string;
  paths: WindowsServicePaths;
  bearerTokenEnvVar?: string;
  host?: string;
  port?: number;
  runtimeArgs?: readonly string[];
  autoUpdateIntervalSeconds?: number;
  packageSpec?: string;
}): string {
  const bearerTokenEnvVar = options.bearerTokenEnvVar ?? HTTP_BEARER_TOKEN_ENV;
  const host = options.host ?? SHARED_HTTP_HOST;
  const port = options.port ?? SHARED_HTTP_PORT;
  const autoUpdateIntervalSeconds =
    options.autoUpdateIntervalSeconds ?? AUTO_UPDATE_INTERVAL_SECONDS;
  const runtimeArgs = options.runtimeArgs ?? ['--confirm', '--audit-log', '--redact'];
  const packageSpec = options.packageSpec ?? MAIL_MCP_LATEST_SPEC;
  assertEnvironmentVariableName(bearerTokenEnvVar);
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('The managed HTTP service must bind to loopback');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid managed HTTP port: ${port}`);
  }
  if (!Number.isInteger(autoUpdateIntervalSeconds) || autoUpdateIntervalSeconds < 60) {
    throw new Error('The managed auto-update interval must be at least 60 seconds');
  }
  if (packageSpec.trim() === '') {
    throw new Error('The managed package spec must not be empty');
  }

  const healthHost = host === '::1' ? '[::1]' : host;
  const healthUrl = `http://${healthHost}:${port}/health`;
  const argumentsList = [
    '-y',
    '--prefer-online',
    '--prefix',
    options.paths.runtimePrefix,
    `--package=${packageSpec}`,
    'mail-mcp',
    '--http',
    '--host',
    host,
    '--port',
    String(port),
    '--bearer-token-env',
    bearerTokenEnvVar,
    '--auto-update-seconds',
    String(autoUpdateIntervalSeconds),
    ...runtimeArgs,
  ];
  const invalidArgument = argumentsList.find(value => /[\r\n\0]/.test(value));
  if (invalidArgument !== undefined) {
    throw new Error(`Managed service argument contains an invalid character: ${invalidArgument}`);
  }

  const configuration = {
    nodePath: options.nodePath,
    arguments: [options.npxCliPath, ...argumentsList],
    healthUrl,
    logDirectory: options.paths.logDirectory,
    stopFile: join(options.paths.serviceDirectory, 'stop'),
  };

  return `'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const config = ${JSON.stringify(configuration, null, 2)};
const stdoutLog = path.join(config.logDirectory, 'service.stdout.log');
const stderrLog = path.join(config.logDirectory, 'service.stderr.log');
const supervisorLog = path.join(config.logDirectory, 'supervisor.log');
let child;
let stopping = false;

function writeSupervisorLog(message) {
  fs.mkdirSync(config.logDirectory, { recursive: true });
  fs.appendFileSync(supervisorLog, new Date().toISOString() + ' ' + message + '\\n');
}

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > 10 * 1024 * 1024) {
      fs.rmSync(file + '.1', { force: true });
      fs.renameSync(file, file + '.1');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') writeSupervisorLog('log rotation failed: ' + error.message);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function serviceIsHealthy() {
  return new Promise(resolve => {
    const request = http.get(config.healthUrl, { timeout: 2000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(response.statusCode === 200 && health.status === 'ok' && health.service === 'mail-mcp');
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function stop() {
  stopping = true;
  if (child && !child.killed) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function runChild() {
  rotateLog(stdoutLog);
  rotateLog(stderrLog);
  const stdout = fs.openSync(stdoutLog, 'a');
  const stderr = fs.openSync(stderrLog, 'a');
  const startedAt = Date.now();
  const exitCode = await new Promise(resolve => {
    let settled = false;
    child = spawn(config.nodePath, config.arguments, {
      env: process.env,
      shell: false,
      stdio: ['ignore', stdout, stderr],
      windowsHide: true,
    });
    const finish = code => {
      if (settled) return;
      settled = true;
      resolve(Number.isInteger(code) ? code : 1);
    };
    child.once('error', error => {
      writeSupervisorLog('child start failed: ' + error.message);
      finish(1);
    });
    child.once('exit', finish);
  });
  child = undefined;
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  return { exitCode, uptimeMs: Date.now() - startedAt };
}

async function main() {
  fs.mkdirSync(config.logDirectory, { recursive: true });
  fs.rmSync(config.stopFile, { force: true });
  if (await serviceIsHealthy()) return;

  let restartDelayMs = 2000;
  while (!stopping && !fs.existsSync(config.stopFile)) {
    const result = await runChild();
    if (stopping || fs.existsSync(config.stopFile)) break;
    if (result.exitCode === 75 || result.uptimeMs >= 5 * 60 * 1000) {
      restartDelayMs = 2000;
    } else {
      restartDelayMs = Math.min(restartDelayMs * 2, 60000);
    }
    writeSupervisorLog('child exited with code ' + result.exitCode + '; restart in ' + restartDelayMs + 'ms');
    await delay(restartDelayMs);
  }
}

main().catch(error => {
  writeSupervisorLog('fatal supervisor error: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
`;
}

export function buildWindowsTaskRegistrationScript(): string {
  return `$ErrorActionPreference = 'Stop'
$taskName = $env:MAIL_MCP_TASK_NAME
$launcherPath = $env:MAIL_MCP_LAUNCHER_PATH
$stopFile = $env:MAIL_MCP_STOP_FILE
$serviceHost = $env:MAIL_MCP_SERVICE_HOST
$servicePort = [int]$env:MAIL_MCP_SERVICE_PORT
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Get-MailMcpPortListeners {
    @(Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LocalAddress -eq $serviceHost -or
            ($serviceHost -eq 'localhost' -and ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1'))
        })
}

$existingTask = Get-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    Stop-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $listeners = Get-MailMcpPortListeners
    } while ($listeners.Count -gt 0 -and (Get-Date) -lt $deadline)
}

$listeners = Get-MailMcpPortListeners
if ($listeners.Count -gt 0) {
    throw "Port $servicePort is occupied after stopping the managed task; the installer will not terminate listener processes automatically"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -TaskPath '\\' -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Settings $settings -Principal $principal -Description 'One shared loopback Mail MCP service for local MCP clients' -Force | Out-Null

Start-ScheduledTask -TaskName $taskName -TaskPath '\\'
`;
}

function buildWindowsTaskSnapshotScript(): string {
  return `$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $env:MAIL_MCP_TASK_NAME -TaskPath '\\' -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [Console]::Out.Write(([pscustomobject]@{
        exists = $false
        wasRunning = $false
    } | ConvertTo-Json -Compress))
    exit 0
}
$xml = Export-ScheduledTask -TaskName $env:MAIL_MCP_TASK_NAME -TaskPath '\\'
$xmlBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml))
[Console]::Out.Write(([pscustomobject]@{
    exists = $true
    xmlBase64 = $xmlBase64
    wasRunning = $task.State -eq 'Running'
} | ConvertTo-Json -Compress))
`;
}

function buildWindowsTaskStopScript(): string {
  return `$ErrorActionPreference = 'Stop'
$taskName = $env:MAIL_MCP_TASK_NAME
$stopFile = $env:MAIL_MCP_STOP_FILE
$task = Get-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction SilentlyContinue
if ($null -ne $task) {
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    Stop-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Unregister-ScheduledTask -TaskName $taskName -TaskPath '\\' -Confirm:$false
}
`;
}

function buildWindowsTaskRestoreScript(): string {
  return `$ErrorActionPreference = 'Stop'
$xml = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:MAIL_MCP_TASK_XML_B64)
)
Register-ScheduledTask -TaskName $env:MAIL_MCP_TASK_NAME -TaskPath '\\' -Xml $xml -Force | Out-Null
if ($env:MAIL_MCP_TASK_WAS_RUNNING -eq '1') {
    Start-ScheduledTask -TaskName $env:MAIL_MCP_TASK_NAME -TaskPath '\\'
}
`;
}

async function runPowerShell(
  script: string,
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<PowerShellResult> {
  const result = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: { ...process.env, ...extraEnvironment },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

async function resolveNpxCliPath(): Promise<string> {
  const result = await execFileAsync('where.exe', ['npx.cmd'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const candidates = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error('Could not find npx.cmd. Install Node.js 20.19 or newer first.');
  }
  const cliPath = join(dirname(candidate), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  await access(cliPath).catch(() => {
    throw new Error(`Could not find the npm CLI next to ${candidate}. Reinstall Node.js.`);
  });
  return cliPath;
}

async function waitForHealth(healthUrl: string): Promise<void> {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  let lastError = 'service did not respond';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.json() as { status?: unknown; service?: unknown };
      if (response.ok && body.status === 'ok' && body.service === 'mail-mcp') {
        return;
      }
      lastError = `unexpected health response: HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Mail MCP service did not become healthy: ${lastError}`);
}

async function readUserEnvironmentVariable(
  name: string,
  runner: NonNullable<WindowsServiceDependencies['runPowerShell']>
): Promise<string | undefined> {
  const result = await runner(
    `[Console]::Out.Write([Environment]::GetEnvironmentVariable($env:MAIL_MCP_ENV_NAME, 'User'))`,
    { MAIL_MCP_ENV_NAME: name }
  );
  const value = result.stdout.trim();
  return value === '' ? undefined : value;
}

async function restoreUserEnvironmentVariable(
  name: string,
  value: string | undefined,
  runner: NonNullable<WindowsServiceDependencies['runPowerShell']>
): Promise<void> {
  await runner(
    `[Environment]::SetEnvironmentVariable(
    $env:MAIL_MCP_ENV_NAME,
    $(if ($env:MAIL_MCP_ENV_WAS_PRESENT -eq '1') { $env:MAIL_MCP_ENV_VALUE } else { $null }),
    'User'
)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MailMcpEnvironmentRestoreBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
        uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][MailMcpEnvironmentRestoreBroadcast]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result
)`,
    {
      MAIL_MCP_ENV_NAME: name,
      MAIL_MCP_ENV_WAS_PRESENT: value === undefined ? '0' : '1',
      ...(value === undefined ? {} : { MAIL_MCP_ENV_VALUE: value }),
    }
  );
}

async function snapshotServiceFile(path: string): Promise<ServiceFileSnapshot> {
  try {
    return { path, content: await readFile(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    throw error;
  }
}

async function restoreServiceFile(snapshot: ServiceFileSnapshot): Promise<void> {
  if (snapshot.content === undefined) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await writeFileAtomic(snapshot.path, snapshot.content);
}

async function readWindowsTaskSnapshot(
  taskName: string,
  runner: NonNullable<WindowsServiceDependencies['runPowerShell']>
): Promise<WindowsTaskSnapshot> {
  const result = await runner(buildWindowsTaskSnapshotScript(), {
    MAIL_MCP_TASK_NAME: taskName,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('Could not snapshot the existing Mail MCP scheduled task', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not snapshot the existing Mail MCP scheduled task');
  }
  const task = parsed as Record<string, unknown>;
  if (task.exists === false && task.wasRunning === false) {
    return { exists: false, wasRunning: false };
  }
  if (
    task.exists !== true
    || typeof task.xmlBase64 !== 'string'
    || task.xmlBase64.length === 0
    || typeof task.wasRunning !== 'boolean'
  ) {
    throw new Error('The existing Mail MCP scheduled task snapshot is invalid');
  }
  try {
    Buffer.from(task.xmlBase64, 'base64').toString('utf8');
  } catch (error) {
    throw new Error('The existing Mail MCP scheduled task XML snapshot is invalid', { cause: error });
  }
  return {
    exists: true,
    xmlBase64: task.xmlBase64,
    wasRunning: task.wasRunning,
  };
}

async function rollbackWindowsService(
  snapshot: WindowsServiceSnapshot,
  paths: WindowsServicePaths,
  taskName: string,
  bearerTokenEnvVar: string,
  runner: NonNullable<WindowsServiceDependencies['runPowerShell']>
): Promise<void> {
  const failures: Error[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error as Error);
    }
  };

  await attempt(async () => {
    await runner(buildWindowsTaskStopScript(), {
      MAIL_MCP_TASK_NAME: taskName,
      MAIL_MCP_STOP_FILE: join(paths.serviceDirectory, 'stop'),
    });
  });
  for (const file of snapshot.files.slice(0, 2)) {
    await attempt(() => restoreServiceFile(file));
  }
  await attempt(() => restoreUserEnvironmentVariable(
    bearerTokenEnvVar,
    snapshot.userToken,
    runner,
  ));
  if (snapshot.processToken === undefined) {
    delete process.env[bearerTokenEnvVar];
  } else {
    process.env[bearerTokenEnvVar] = snapshot.processToken;
  }
  await attempt(() => restoreServiceFile(snapshot.files[2]));
  if (snapshot.task.exists) {
    await attempt(async () => {
      await runner(buildWindowsTaskRestoreScript(), {
        MAIL_MCP_TASK_NAME: taskName,
        MAIL_MCP_TASK_XML_B64: snapshot.task.xmlBase64,
        MAIL_MCP_TASK_WAS_RUNNING: snapshot.task.wasRunning ? '1' : '0',
      });
    });
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to restore the previous Windows service state');
  }
}

async function persistUserEnvironmentVariable(
  name: string,
  value: string,
  runner: NonNullable<WindowsServiceDependencies['runPowerShell']>
): Promise<void> {
  await runner(
    `[Environment]::SetEnvironmentVariable($env:MAIL_MCP_ENV_NAME, $env:MAIL_MCP_ENV_VALUE, 'User')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MailMcpEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
        uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][MailMcpEnvironmentBroadcast]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result
)`,
    {
      MAIL_MCP_ENV_NAME: name,
      MAIL_MCP_ENV_VALUE: value,
    }
  );
}

async function startupFailureDetails(logDirectory: string): Promise<string> {
  try {
    const stderr = await readFile(join(logDirectory, 'service.stderr.log'), 'utf8');
    const lines = stderr.trim().split(/\r?\n/).slice(-8);
    return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

export async function installWindowsHttpService(
  options: {
    home?: string;
    bearerTokenEnvVar?: string;
    taskName?: string;
    host?: string;
    port?: number;
    runtimeArgs?: readonly string[];
    packageSpec?: string;
  } = {},
  dependencies: WindowsServiceDependencies = {}
): Promise<WindowsServiceInstallResult> {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new Error('Managed Mail MCP HTTP service installation currently requires Windows');
  }

  const home = options.home ?? homedir();
  const bearerTokenEnvVar = options.bearerTokenEnvVar ?? HTTP_BEARER_TOKEN_ENV;
  const taskName = options.taskName ?? WINDOWS_SERVICE_TASK_NAME;
  const host = options.host ?? SHARED_HTTP_HOST;
  const port = options.port ?? SHARED_HTTP_PORT;
  assertEnvironmentVariableName(bearerTokenEnvVar);
  const paths = getWindowsServicePaths(home);
  const runner = dependencies.runPowerShell ?? runPowerShell;
  const npxCliPath = await (dependencies.resolveNpxCliPath ?? resolveNpxCliPath)();
  const existingBearerToken = await readUserEnvironmentVariable(bearerTokenEnvVar, runner);
  const taskSnapshot = await readWindowsTaskSnapshot(taskName, runner);
  const bearerToken = existingBearerToken ?? randomBytes(32).toString('base64url');
  const urlHost = host === '::1' ? '[::1]' : host;
  const url = `http://${urlHost}:${port}/mcp`;
  const healthUrl = `http://${urlHost}:${port}/health`;
  const stopFile = join(paths.serviceDirectory, 'stop');
  const snapshot: WindowsServiceSnapshot = {
    files: await Promise.all([
      snapshotServiceFile(paths.launcherPath),
      snapshotServiceFile(paths.supervisorPath),
      snapshotServiceFile(stopFile),
    ]),
    task: taskSnapshot,
    userToken: existingBearerToken,
    processToken: process.env[bearerTokenEnvVar],
  };

  try {
    await mkdir(paths.serviceDirectory, { recursive: true });
    await mkdir(paths.logDirectory, { recursive: true });
    await prepareMailMcpNpxRuntime(home);
    await writeTextFileAtomic(
      paths.supervisorPath,
      buildWindowsServiceSupervisor({
        nodePath: process.execPath,
        npxCliPath,
        paths,
        bearerTokenEnvVar,
        host,
        port,
        runtimeArgs: options.runtimeArgs,
        packageSpec: options.packageSpec,
      })
    );
    await writeTextFileAtomic(
      paths.launcherPath,
      buildWindowsServiceLauncher({
        nodePath: process.execPath,
        paths,
        bearerTokenEnvVar,
      })
    );
    await persistUserEnvironmentVariable(bearerTokenEnvVar, bearerToken, runner);
    process.env[bearerTokenEnvVar] = bearerToken;

    await runner(buildWindowsTaskRegistrationScript(), {
      MAIL_MCP_TASK_NAME: taskName,
      MAIL_MCP_LAUNCHER_PATH: paths.launcherPath,
      MAIL_MCP_STOP_FILE: stopFile,
      MAIL_MCP_SERVICE_HOST: host,
      MAIL_MCP_SERVICE_PORT: String(port),
    });
    await (dependencies.waitForHealth ?? waitForHealth)(healthUrl);
  } catch (error) {
    const details = await startupFailureDetails(paths.logDirectory);
    const installError = new Error(`${(error as Error).message}${details}`, { cause: error });
    try {
      await rollbackWindowsService(
        snapshot,
        paths,
        taskName,
        bearerTokenEnvVar,
        runner,
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [installError, rollbackError as Error],
        'Windows service installation failed and the previous state could not be fully restored',
      );
    }
    throw installError;
  }

  return {
    ...paths,
    url,
    healthUrl,
    taskName,
    bearerTokenEnvVar,
    reusedBearerToken: existingBearerToken !== undefined,
  };
}
