import { describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppleMailAdapter } from './adapter.js';
import { AppleMailError } from './errors.js';
import { buildReplyAllRecipients } from './reply.js';
import { appleScriptText, listMailboxesScript, listMessagesScript, searchMessagesScript } from './scripts.js';
import { APPLE_MAIL_OPERATION_KINDS } from './types.js';
import type { AppleScriptRunner } from './runner.js';

describe('AppleMailAdapter', () => {
  it('fails without invoking osascript on non-macOS platforms', async () => {
    const runner: AppleScriptRunner = { run: vi.fn() };
    const adapter = new AppleMailAdapter({ runner, platform: 'win32' });

    await expect(adapter.listAccounts()).rejects.toMatchObject<Partial<AppleMailError>>({
      code: 'UNSUPPORTED_PLATFORM',
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('parses JSON-only runner output', async () => {
    const runner: AppleScriptRunner = {
      run: vi.fn().mockResolvedValue(JSON.stringify([{
        id: 'uuid-1',
        name: 'Personal',
        fullName: 'Alice Example',
        aliases: ['alice@example.com'],
        type: 'imap',
        enabled: true,
      }])),
    };
    const adapter = new AppleMailAdapter({ runner, platform: 'darwin' });

    await expect(adapter.listAccounts()).resolves.toEqual([expect.objectContaining({
      id: 'uuid-1',
      aliases: ['alice@example.com'],
    })]);
    expect(runner.run).toHaveBeenCalledWith(
      expect.stringContaining('tell application "Mail"'),
      { timeoutMs: 30_000 },
    );
  });

  it('rejects non-JSON Apple Mail output with a typed error', async () => {
    const runner: AppleScriptRunner = { run: vi.fn().mockResolvedValue('not json') };
    const adapter = new AppleMailAdapter({ runner, platform: 'darwin' });

    await expect(adapter.listAccounts()).rejects.toMatchObject<Partial<AppleMailError>>({
      code: 'INVALID_RESPONSE',
    });
  });

  it('serializes concurrent Apple Mail operations', async () => {
    let active = 0;
    let maximumActive = 0;
    const runner: AppleScriptRunner = {
      run: vi.fn().mockImplementation(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return '[]';
      }),
    };
    const adapter = new AppleMailAdapter({ runner, platform: 'darwin' });

    await Promise.all([adapter.listAccounts(), adapter.listAccounts(), adapter.listAccounts()]);

    expect(maximumActive).toBe(1);
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it('exposes destructive operations distinctly for the outer policy gate', () => {
    const adapter = new AppleMailAdapter({
      runner: { run: vi.fn() },
      platform: 'darwin',
    });

    expect(adapter.operationKind('listMessages')).toBe('read');
    expect(adapter.operationKind('compose')).toBe('write');
    expect(adapter.operationKind('trashMessage')).toBe('destructive');
    expect(adapter.operationKind('deleteMailbox')).toBe('destructive');
    expect(adapter.operationKind('deleteRule')).toBe('destructive');
    expect(APPLE_MAIL_OPERATION_KINDS.updateMessage).toBe('write');
  });

  it('rejects relative attachment paths before invoking Mail', async () => {
    const runner: AppleScriptRunner = { run: vi.fn() };
    const adapter = new AppleMailAdapter({ runner, platform: 'darwin' });

    await expect(adapter.compose({
      to: ['alice@example.com'],
      subject: 'Report',
      body: 'Attached.',
      attachments: [{ path: '../report.pdf' }],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('requires an allowed root and validates attachment paths by real path', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-apple-'));
    const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-apple-outside-'));
    const insideFile = path.join(root, 'report.pdf');
    const outsideFile = path.join(outside, 'private.pdf');
    await fsPromises.writeFile(insideFile, 'inside');
    await fsPromises.writeFile(outsideFile, 'outside');
    const runner: AppleScriptRunner = {
      run: vi.fn().mockResolvedValue('{"ok":true,"operation":"compose","id":"1"}'),
    };
    const adapter = new AppleMailAdapter({
      runner,
      platform: 'darwin',
      allowedAttachmentRoots: [root],
    });

    try {
      await expect(adapter.compose({
        to: ['alice@example.com'],
        subject: 'Report',
        body: 'Attached.',
        attachments: [{ path: insideFile }],
      })).resolves.toMatchObject({ ok: true });
      expect(runner.run).toHaveBeenCalledWith(expect.stringContaining('report.pdf'), { timeoutMs: 30_000 });

      await expect(adapter.compose({
        to: ['alice@example.com'],
        subject: 'Private',
        body: 'Attached.',
        attachments: [{ path: outsideFile }],
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(runner.run).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([
        fsPromises.rm(root, { recursive: true, force: true }),
        fsPromises.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});

describe('Apple Mail script construction', () => {
  it('preserves Unicode and safely escapes quotes, backslashes, newlines, and controls', () => {
    const expression = appleScriptText('\u041f\u0440\u0438\u0432\u0435\u0442 "Mail"\\Folder\nnext\u0000line');

    expect(expression).toContain('\u041f\u0440\u0438\u0432\u0435\u0442 \\"Mail\\"\\\\Folder');
    expect(expression).toContain('linefeed');
    expect(expression).not.toContain('\u0000');
    expect(expression).toContain('nextline');
  });

  it('walks nested mailbox paths rather than matching leaf names globally', () => {
    const script = listMailboxesScript({ account: 'Personal' });

    expect(script).toContain('on appendMailboxes(containerItem, parentPath, resultItems)');
    expect(script).toContain('mailboxPath to parentPath & "/" & mailboxName');
    expect(script).toContain('my appendMailboxes(mailboxItem, mailboxPath, resultItems)');
  });

  it('builds explicit search predicates without interpolating raw control characters', () => {
    const script = searchMessagesScript({
      account: 'Personal',
      mailbox: 'Projects/Launch',
      query: '"quoted"\nneedle',
      unread: true,
      flagged: false,
      limit: 10,
    });

    expect(script).toContain('subject of messageItem');
    expect(script).toContain('read status of messageItem is false');
    expect(script).toContain('flagged status of messageItem is false');
    expect(script).toContain('linefeed');
    expect(script).not.toContain('\u0000');
  });

  it('builds a complete bounded snapshot instead of truncating summaries at one page', () => {
    const script = listMessagesScript({ account: 'Personal', maxItems: 10_000 });

    expect(script).toContain('matchedCount > 10000');
    expect(script).not.toContain('exit repeat');
    expect(script).toContain('if includeContent then set bodyText to content of messageItem as text');
  });

  it('resolves the default inbox across localized Mail.app accounts', () => {
    const script = listMessagesScript({ account: 'Personal' });

    expect(script).toContain('repeat with inboxName in {"INBOX", "Inbox"');
    expect(script).toContain('"Posteingang"');
    expect(script).toContain('"Bandeja de entrada"');
    expect(script).toContain('return mailbox (inboxName as text) of selectedAccount');
  });
});

describe('buildReplyAllRecipients', () => {
  it('deduplicates recipients case-insensitively and removes sender identities', () => {
    const recipients = buildReplyAllRecipients({
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [
        { address: 'ME@example.com' },
        { address: 'ALICE@example.com' },
        { address: 'bob@example.com' },
      ],
      cc: [
        { address: 'Bob@Example.com' },
        { address: 'carol@example.com' },
      ],
    }, ['me@example.com']);

    expect(recipients.to.map((item) => item.address)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(recipients.cc.map((item) => item.address)).toEqual(['carol@example.com']);
  });
});
