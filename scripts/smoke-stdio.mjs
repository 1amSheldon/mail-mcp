// Created by RxGroup on 02.08.2026. Copyright (c) 2026 RX Group. All rights reserved.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const entrypoint = path.resolve(process.argv[2] || 'dist/index.js');
const serverArgs = process.argv.slice(3);

if (!existsSync(entrypoint)) {
  throw new Error(`MCP entrypoint not found: ${entrypoint}. Run npm run build first.`);
}

const child = spawn(process.execPath, [entrypoint, ...serverArgs], {
  cwd: path.dirname(path.dirname(entrypoint)),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

const pending = new Map();
let nextId = 1;
const lines = readline.createInterface({ input: child.stdout });

lines.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});

child.on('exit', (code, signal) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`MCP exited before responding (code=${code}, signal=${signal}). ${stderr}`));
  }
  pending.clear();
});

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. ${stderr}`));
    }, 5_000);
    pending.set(id, { resolve, reject, timer });
    write({ jsonrpc: '2.0', id, method, params });
  });
}

try {
  const initialize = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mail-mcp-stdio-smoke', version: '1.0.0' },
  });
  write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const listed = await request('tools/list');
  const names = listed.tools.map(tool => tool.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

  if (!initialize.serverInfo?.name) throw new Error('initialize response has no serverInfo.name');
  if (!names.includes('send_email')) throw new Error('send_email is missing from tools/list');
  if (!names.includes('verify_sent_message')) throw new Error('verify_sent_message is missing from tools/list');
  if (duplicates.length > 0) throw new Error(`Duplicate tool names: ${duplicates.join(', ')}`);

  child.stdin.end();
  const [exitCode, signal] = await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP did not exit after stdio closed')), 5_000)),
  ]);
  if (exitCode !== 0) {
    throw new Error(`MCP exited with code=${exitCode}, signal=${signal}. ${stderr}`);
  }

  console.log(JSON.stringify({
    status: 'ok',
    server: initialize.serverInfo.name,
    protocolVersion: initialize.protocolVersion,
    toolCount: names.length,
    entrypoint,
    args: serverArgs,
  }));
} catch (error) {
  if (!child.killed) child.kill();
  throw error;
}
