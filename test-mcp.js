import { spawn } from 'child_process';

const server = spawn('node', ['dist/index.js']);

server.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

const request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'list_tools',
  params: {},
};

server.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
  server.kill();
});

server.stdin.write(JSON.stringify(request) + '\n');

setTimeout(() => {
  server.kill();
  process.exit(1);
}, 5000);
