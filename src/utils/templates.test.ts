import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock node:fs/promises for readFile
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock node:fs for watch, mkdirSync, writeFileSync
vi.mock('node:fs', () => ({
  watch: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}));

import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';

const mockedFsPromises = vi.mocked(fsPromises);
const mockedFs = vi.mocked(fs);

// ----------------------------------------------------------------
// Schema tests
// ----------------------------------------------------------------

describe('emailTemplateSchema', () => {
  it('accepts a minimal valid template with id, name, body', async () => {
    const { emailTemplateSchema } = await import('./templates.js');
    const result = emailTemplateSchema.safeParse({ id: 'ack', name: 'Ack', body: 'Got it.' });
    expect(result.success).toBe(true);
  });

  it('accepts a full template with all optional fields', async () => {
    const { emailTemplateSchema } = await import('./templates.js');
    const result = emailTemplateSchema.safeParse({
      id: 'oof',
      name: 'Out of Office',
      subject: 'Re: {{subject}}',
      body: 'I am away until {{date}}.',
      isHtml: false,
      accountId: 'work',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accountId).toBe('work');
      expect(result.data.subject).toBe('Re: {{subject}}');
    }
  });

  it('rejects a template missing id', async () => {
    const { emailTemplateSchema } = await import('./templates.js');
    const result = emailTemplateSchema.safeParse({ name: 'No ID', body: 'Hello.' });
    expect(result.success).toBe(false);
  });

  it('rejects a template missing name', async () => {
    const { emailTemplateSchema } = await import('./templates.js');
    const result = emailTemplateSchema.safeParse({ id: 'x', body: 'Hello.' });
    expect(result.success).toBe(false);
  });

  it('rejects a template missing body', async () => {
    const { emailTemplateSchema } = await import('./templates.js');
    const result = emailTemplateSchema.safeParse({ id: 'x', name: 'X' });
    expect(result.success).toBe(false);
  });
});

// ----------------------------------------------------------------
// getTemplates() tests
// ----------------------------------------------------------------

describe('getTemplates', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockedFs.watch.mockReturnValue({ close: vi.fn() } as any);
    // Reset module cache so each test gets a fresh cache state
    const { resetTemplatesCache } = await import('./templates.js');
    resetTemplatesCache();
  });

  it('returns empty array when templates file does not exist', async () => {
    mockedFsPromises.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { getTemplates } = await import('./templates.js');
    const result = await getTemplates();
    expect(result).toEqual([]);
  });

  it('returns parsed templates when file contains valid JSON array', async () => {
    const templates = [
      { id: 'ack', name: 'Acknowledgement', body: 'Got your message.' },
      { id: 'oof', name: 'Out of Office', body: 'I am away.', accountId: 'work' },
    ];
    mockedFsPromises.readFile.mockResolvedValueOnce(JSON.stringify(templates));
    const { getTemplates } = await import('./templates.js');
    const result = await getTemplates();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('ack');
    expect(result[1].accountId).toBe('work');
  });

  it('skips invalid templates and logs an error for them', async () => {
    const templates = [
      { id: 'good', name: 'Good', body: 'OK' },
      { id: 'bad' /* missing name and body */ },
    ];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedFsPromises.readFile.mockResolvedValueOnce(JSON.stringify(templates));
    const { getTemplates } = await import('./templates.js');
    const result = await getTemplates();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('good');
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it('returns empty array if file contains a non-array JSON value', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedFsPromises.readFile.mockResolvedValueOnce(JSON.stringify({ not: 'array' }));
    const { getTemplates } = await import('./templates.js');
    const result = await getTemplates();
    expect(result).toEqual([]);
    consoleSpy.mockRestore();
  });

  it('caches templates and does not re-read the file on second call', async () => {
    const templates = [{ id: 't1', name: 'T1', body: 'Body' }];
    mockedFsPromises.readFile.mockResolvedValue(JSON.stringify(templates));
    const { getTemplates } = await import('./templates.js');
    await getTemplates();
    await getTemplates();
    expect(mockedFsPromises.readFile).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------
// applyVariables() tests
// ----------------------------------------------------------------

describe('applyVariables', () => {
  it('replaces a single placeholder', async () => {
    const { applyVariables } = await import('./templates.js');
    expect(applyVariables('Hello, {{name}}!', { name: 'Alice' })).toBe('Hello, Alice!');
  });

  it('replaces multiple different placeholders', async () => {
    const { applyVariables } = await import('./templates.js');
    const result = applyVariables('Dear {{name}}, your order {{orderId}} is ready.', {
      name: 'Bob',
      orderId: '12345',
    });
    expect(result).toBe('Dear Bob, your order 12345 is ready.');
  });

  it('replaces multiple occurrences of the same placeholder', async () => {
    const { applyVariables } = await import('./templates.js');
    expect(applyVariables('{{x}} and {{x}}', { x: 'Y' })).toBe('Y and Y');
  });

  it('leaves unknown placeholders intact', async () => {
    const { applyVariables } = await import('./templates.js');
    expect(applyVariables('Hello, {{name}}! Today is {{date}}.', { name: 'Carol' }))
      .toBe('Hello, Carol! Today is {{date}}.');
  });

  it('ignores extra variables that are not in the template', async () => {
    const { applyVariables } = await import('./templates.js');
    expect(applyVariables('Hi there.', { unused: 'value' })).toBe('Hi there.');
  });

  it('returns body unchanged when there are no placeholders', async () => {
    const { applyVariables } = await import('./templates.js');
    expect(applyVariables('Plain body text.', {})).toBe('Plain body text.');
  });
});
