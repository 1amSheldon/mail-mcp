import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';

vi.mock('node:tls', () => ({
  connect: vi.fn(),
}));

// Import SieveClient after mock setup
import { SieveClient } from './sieve.js';

// ---------------------------------------------------------------------------
// Mock TLS socket
// ---------------------------------------------------------------------------

class MockSocket extends EventEmitter {
  public written: string[] = [];
  public destroyed = false;

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  // tls.TLSSocket methods that SieveClient may call
  setEncoding(_enc: string): this { return this; }
  setTimeout(_ms: number): this { return this; }

  receive(data: string): void {
    this.emit('data', data);
  }
}

// ---------------------------------------------------------------------------
// Helper: create a socket that auto-replies to commands
// ---------------------------------------------------------------------------

function setupAutoReplySocket(
  greeting: string,
  replies: Record<string, string>
): MockSocket {
  const sock = new MockSocket();

  const origWrite = sock.write.bind(sock);
  sock.write = (data: string): boolean => {
    origWrite(data);
    const firstLine = data.trim().split('\r\n')[0].toUpperCase();

    for (const [prefix, response] of Object.entries(replies)) {
      if (firstLine.startsWith(prefix.toUpperCase())) {
        setImmediate(() => sock.receive(response));
        return true;
      }
    }
    setImmediate(() => sock.receive('OK\r\n'));
    return true;
  };

  vi.mocked(tls.connect).mockImplementation(((_opts: any, cb?: () => void) => {
    if (cb) {
      setImmediate(() => {
        cb();
        setImmediate(() => sock.receive(greeting));
      });
    }
    return sock as any;
  }) as any);

  return sock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SieveClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // SASL PLAIN encoding helper (sanity check)
  // -------------------------------------------------------------------------
  describe('PLAIN SASL base64 encoding', () => {
    it('encodes \\0user\\0pass correctly', () => {
      const raw = '\0testuser\0secret';
      const encoded = Buffer.from(raw).toString('base64');
      expect(encoded).toBe('AHRlc3R1c2VyAHNlY3JldA==');
    });
  });

  // -------------------------------------------------------------------------
  // connect()
  // -------------------------------------------------------------------------
  describe('connect()', () => {
    it('connects and authenticates via PLAIN SASL', async () => {
      const greeting =
        '"Cyrus timsieved" "3.0.0"\r\n' +
        'SASL "PLAIN"\r\n' +
        'SIEVE "fileinto reject vacation"\r\n' +
        'OK "ManageSieve ready"\r\n';

      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK "Logged in"\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'testuser', 'secret');
      await client.connect();

      const authCmd = sock.written.find(w => w.includes('AUTHENTICATE'));
      expect(authCmd).toBeDefined();
      expect(authCmd).toContain('PLAIN');
    });

    it('throws descriptive error when connection is refused (ECONNREFUSED)', async () => {
      vi.mocked(tls.connect).mockImplementation(((_opts: any, _cb?: () => void) => {
        const sock = new MockSocket();
        setImmediate(() => {
          sock.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        });
        return sock as any;
      }) as any);

      const client = new SieveClient('localhost', 4190, 'user', 'pass');
      await expect(client.connect()).rejects.toThrow(/ManageSieve not supported/i);
    });

    it('throws on authentication failure (NO response)', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'NO "Authentication failed"\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'user', 'wrongpass');
      await expect(client.connect()).rejects.toThrow(/Authentication failed/i);
    });
  });

  // -------------------------------------------------------------------------
  // listScripts()
  // -------------------------------------------------------------------------
  describe('listScripts()', () => {
    it('returns empty array when no scripts exist', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        LISTSCRIPTS: 'OK\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      const scripts = await client.listScripts();
      expect(scripts).toEqual([]);
    });

    it('returns scripts with active marker', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const listResponse =
        '"vacation" ACTIVE\r\n' +
        '"spam-filter"\r\n' +
        'OK\r\n';

      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        LISTSCRIPTS: listResponse,
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      const scripts = await client.listScripts();

      expect(scripts).toHaveLength(2);
      expect(scripts[0]).toEqual({ name: 'vacation', active: true });
      expect(scripts[1]).toEqual({ name: 'spam-filter', active: false });
    });

    it('returns single inactive script', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const listResponse = '"myscript"\r\nOK\r\n';

      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        LISTSCRIPTS: listResponse,
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      const scripts = await client.listScripts();

      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toEqual({ name: 'myscript', active: false });
    });
  });

  // -------------------------------------------------------------------------
  // getScript()
  // -------------------------------------------------------------------------
  describe('getScript()', () => {
    it('returns script content from literal string response', async () => {
      const scriptContent = 'require ["fileinto"];\nfileinto "INBOX.spam";\n';
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const getResponse = `{${Buffer.byteLength(scriptContent)}}\r\n${scriptContent}\r\nOK\r\n`;

      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        GETSCRIPT: getResponse,
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      const content = await client.getScript('myfilter');

      expect(content).toBe(scriptContent);
    });

    it('throws when script does not exist (NO response)', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        GETSCRIPT: 'NO "Script not found"\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      await expect(client.getScript('missing')).rejects.toThrow(/Script not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // putScript()
  // -------------------------------------------------------------------------
  describe('putScript()', () => {
    it('sends literal string upload with correct byte count', async () => {
      const scriptContent = 'require ["fileinto"];\nfileinto "Spam";\n';
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';

      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        PUTSCRIPT: 'OK\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      await client.putScript('myfilter', scriptContent);

      const putCmd = sock.written.find(w => w.includes('PUTSCRIPT'));
      expect(putCmd).toBeDefined();
      expect(putCmd).toContain('myfilter');
      const byteCount = Buffer.byteLength(scriptContent, 'utf-8');
      expect(putCmd).toContain(`{${byteCount}+}`);
    });

    it('throws on NO response (invalid script)', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        PUTSCRIPT: 'NO "Invalid script"\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      await expect(client.putScript('bad', 'not valid sieve')).rejects.toThrow(/Invalid script/i);
    });
  });

  // -------------------------------------------------------------------------
  // deleteScript()
  // -------------------------------------------------------------------------
  describe('deleteScript()', () => {
    it('sends DELETESCRIPT command with script name', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        DELETESCRIPT: 'OK\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      await client.deleteScript('myfilter');

      const delCmd = sock.written.find(w => w.includes('DELETESCRIPT'));
      expect(delCmd).toBeDefined();
      expect(delCmd).toContain('myfilter');
    });

    it('throws on NO response (script not found or is active)', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        DELETESCRIPT: 'NO "Active script cannot be deleted"\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      await expect(client.deleteScript('active-script')).rejects.toThrow(/Active script cannot be deleted/i);
    });
  });

  // -------------------------------------------------------------------------
  // disconnect()
  // -------------------------------------------------------------------------
  describe('disconnect()', () => {
    it('sends LOGOUT command', async () => {
      const greeting = 'SASL "PLAIN"\r\nOK\r\n';
      const sock = setupAutoReplySocket(greeting, {
        AUTHENTICATE: 'OK\r\n',
        LOGOUT: 'OK "Bye"\r\n',
      });

      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await client.connect();
      await client.disconnect();

      const logoutCmd = sock.written.find(w => w.includes('LOGOUT'));
      expect(logoutCmd).toBeDefined();
    });

    it('does nothing if not connected', async () => {
      const client = new SieveClient('localhost', 4190, 'u', 'p');
      await expect(client.disconnect()).resolves.toBeUndefined();
    });
  });
});
