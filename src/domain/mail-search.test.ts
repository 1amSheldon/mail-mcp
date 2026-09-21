import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  buildSearchCriteria,
  normalizeSearchQuery,
  searchPaginationKey,
  type SearchEmailsQuery,
} from './mail-search.js';

const require = createRequire(import.meta.url);
const { searchCompiler } = require('imapflow/lib/search-compiler.js') as {
  searchCompiler: (connection: unknown, query: unknown) => Array<{ value?: string }>;
};

function compile(query: SearchEmailsQuery): Array<{ value?: string }> {
  return searchCompiler(
    { capabilities: new Map(), enabled: new Set(), mailbox: { flags: new Set() } },
    buildSearchCriteria(query),
  );
}

describe('mail search query normalization', () => {
  it('canonicalizes keyword arrays for stable cursor binding', () => {
    expect(normalizeSearchQuery({
      keywordsAny: [' beta ', 'alpha', 'alpha'],
      keywordsAll: ['two', 'one'],
      excludeKeywords: ['spam'],
      unread: false,
      flagged: true,
      keywordScope: 'subject',
    })).toEqual({
      excludeKeywords: ['spam'],
      flagged: true,
      keywordScope: 'subject',
      keywordsAll: ['one', 'two'],
      keywordsAny: ['alpha', 'beta'],
      unread: false,
    });
  });

  it('preserves legacy keywords as a BODY substring even with a new scope', () => {
    expect(buildSearchCriteria({ keywords: 'invoice', keywordScope: 'subject' })).toEqual({
      body: 'invoice',
    });
  });

  it('rejects malformed and over-bounded keyword arrays', () => {
    expect(() => normalizeSearchQuery({ keywordsAll: 'one' as unknown as string[] }))
      .toThrow('keywordsAll must be an array');
    expect(() => normalizeSearchQuery({
      keywordsAny: Array.from({ length: 21 }, (_, index) => `term-${index}`),
    })).toThrow('at most 20 words');
    expect(() => normalizeSearchQuery({
      excludeKeywords: ['x'.repeat(257)],
    })).toThrow('at most 256 characters');
    expect(() => normalizeSearchQuery({ unread: 'yes' as unknown as boolean }))
      .toThrow('unread must be a boolean');
    expect(() => normalizeSearchQuery({ since: '2024-02-30' }))
      .toThrow('since must be a real YYYY-MM-DD date');
    expect(() => normalizeSearchQuery({ before: '2024-1-01' }))
      .toThrow('before must be a real YYYY-MM-DD date');
    expect(() => normalizeSearchQuery({ since: '2024-03-01', before: '2024-03-01' }))
      .toThrow('since must be earlier than before');
  });

  it('keeps the cursor key bounded while binding every large filter', () => {
    const query: SearchEmailsQuery = {
      keywordsAll: Array.from({ length: 20 }, (_, index) => `all-${index}-${'a'.repeat(240)} `),
      keywordsAny: Array.from({ length: 20 }, (_, index) => `any-${index}-${'b'.repeat(240)} `),
      excludeKeywords: Array.from({ length: 20 }, (_, index) => `exclude-${index}-${'c'.repeat(240)} `),
      unread: true,
      flagged: false,
      keywordScope: 'all',
    };
    const key = searchPaginationKey(query, false);
    expect(key.length).toBeLessThanOrEqual(8_192);
    expect(key).toContain('queryHash');
    expect(searchPaginationKey(query, true)).not.toBe(key);
    expect(searchPaginationKey({ ...query, unread: false }, false)).not.toBe(key);
  });
});

describe('IMAP search criteria composition', () => {
  it('uses server-side OR, De Morgan AND, NOT, and status filters', () => {
    const criteria = buildSearchCriteria({
      keywordsAll: ['alpha', 'beta'],
      keywordsAny: ['red', 'blue'],
      excludeKeywords: ['spam'],
      keywordScope: 'all',
      unread: true,
      flagged: false,
    });
    expect(criteria).toEqual({
      flagged: false,
      not: {
        or: [
          { not: { text: 'alpha' } },
          { not: { text: 'beta' } },
          { text: 'spam' },
        ],
      },
      or: [{ text: 'blue' }, { text: 'red' }],
      seen: false,
    });

    const compiled = compile({
      keywordsAll: ['alpha', 'beta'],
      keywordsAny: ['red', 'blue'],
      excludeKeywords: ['spam'],
      keywordScope: 'all',
      unread: true,
      flagged: false,
    });
    const values = compiled.map(attribute => attribute.value);
    expect(values).toContain('UNSEEN');
    expect(values).toContain('UNFLAGGED');
    expect(values.filter(value => value === 'OR').length).toBe(3);
    expect(values).toEqual(expect.arrayContaining(['TEXT', 'alpha', 'beta', 'red', 'blue', 'spam']));
  });

  it('uses BODY or SUBJECT criteria for scoped any/excluded terms', () => {
    expect(buildSearchCriteria({
      keywordsAny: ['alpha'],
      excludeKeywords: ['spam'],
      keywordScope: 'subject',
    })).toEqual({
      not: { subject: 'spam' },
      or: [{ subject: 'alpha' }],
    });
    expect(buildSearchCriteria({ keywordsAll: ['alpha', 'beta'] })).toEqual({
      not: { or: [{ not: { body: 'alpha' } }, { not: { body: 'beta' } }] },
    });
  });
});
