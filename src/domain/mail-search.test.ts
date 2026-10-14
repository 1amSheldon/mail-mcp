import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  buildSearchCriteria,
  normalizeSearchQuery,
  searchPaginationKey,
  type SearchEmailsQuery,
} from './mail-search.js';

const require = createRequire(import.meta.url);
type Attribute = { value: string } | Attribute[];
const { searchCompiler } = require('imapflow/lib/search-compiler.js') as {
  searchCompiler: (connection: unknown, query: unknown) => Attribute[];
};
const serialize = require('imapflow/lib/handler/imap-compiler.js') as (command: unknown) => Promise<Buffer[]>;
const parse = require('imapflow/lib/handler/imap-parser.js') as (command: Buffer) => Promise<{ attributes: Attribute[] }>;

async function compile(query: SearchEmailsQuery) {
  return Promise.all(buildSearchCriteria(query).map(async criteria => {
    const attributes = searchCompiler(
      { capabilities: new Map(), enabled: new Set(), mailbox: { flags: new Set() } },
      { ...criteria, uid: '10:30' },
    );
    const wire = Buffer.concat(await serialize({ tag: 'T', command: 'UID SEARCH', attributes }));
    return { wire: wire.toString(), attributes: (await parse(wire)).attributes };
  }));
}

interface Fixture { uid: number; subject: string; body: string; seen: boolean; flagged: boolean }
/** Evaluate the serialized prefix grammar, rather than counting compiler tokens. */
function matches(attributes: Attribute[], message: Fixture): boolean {
  let position = 0;
  const value = () => {
    const token = attributes[position++];
    if (!token || Array.isArray(token)) throw new Error('Missing search value');
    return token.value;
  };
  const key = (): boolean => {
    const token = attributes[position++];
    if (Array.isArray(token)) return matches(token, message);
    if (!token) throw new Error('Missing search key');
    switch (token.value.toUpperCase()) {
      case 'ALL': return true;
      case 'NOT': return !key();
      case 'OR': { const left = key(); const right = key(); return left || right; }
      case 'SUBJECT': return message.subject.includes(value());
      case 'BODY': return message.body.includes(value());
      case 'TEXT': return (message.subject + ' ' + message.body).includes(value());
      case 'SEEN': return message.seen;
      case 'UNSEEN': return !message.seen;
      case 'FLAGGED': return message.flagged;
      case 'UNFLAGGED': return !message.flagged;
      case 'UID': { const [low, high] = value().split(':').map(Number); return message.uid >= low && message.uid <= high; }
      default: throw new Error('Unexpected search key ' + token.value);
    }
  };
  const results: boolean[] = [];
  while (position < attributes.length) results.push(key());
  return results.every(Boolean);
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
    expect(buildSearchCriteria({ keywords: 'invoice', keywordScope: 'subject' })).toEqual([{
      body: 'invoice',
    }]);
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
  it('serializes required terms and individual exclusions without nested NOT or a mixed OR command', async () => {
    const compiled = await compile({
      keywordsAll: ['alpha', 'beta'],
      keywordsAny: ['red', 'blue'],
      excludeKeywords: ['spam', 'junk'],
      keywordScope: 'all',
      unread: true,
      flagged: false,
    });
    expect(compiled.map(command => command.wire)).toEqual([
      'T UID SEARCH UNSEEN UNFLAGGED TEXT alpha TEXT beta NOT TEXT junk NOT TEXT spam UID 10:30',
      'T UID SEARCH OR TEXT blue TEXT red UID 10:30',
    ]);
    expect((await compile({ keywordsAll: ['alpha'], keywordScope: 'subject' }))[0].wire)
      .toBe('T UID SEARCH SUBJECT alpha UID 10:30');
  });

  it.each(['body', 'subject', 'all'] as const)('preserves the complete serialized predicate truth table for %s scope', async keywordScope => {
    const queries: SearchEmailsQuery[] = [
      { keywordsAll: ['alpha'] },
      { keywordsAll: ['alpha', 'beta'] },
      { keywordsAny: ['red', 'blue'] },
      { subject: 'ordinary', keywordsAny: ['red', 'blue'] },
      { keywordsAll: ['alpha', 'beta'], keywordsAny: ['red', 'blue'], excludeKeywords: ['spam', 'junk'], unread: true, flagged: false },
      { keywords: 'legacy', subject: 'ordinary', keywordsAll: ['alpha', 'beta'], keywordsAny: ['red', 'blue'], excludeKeywords: ['spam', 'junk'] },
      { keywordsAny: ['alpha'], excludeKeywords: ['spam', 'junk'] },
      { excludeKeywords: ['spam', 'junk'] },
    ];
    const terms = ['alpha', 'beta', 'red', 'blue', 'spam', 'junk'];
    for (const query of queries) {
      const commands = await compile({ ...query, keywordScope });
      expect(commands.length).toBeLessThanOrEqual(2);
      for (let mask = 0; mask < 64; mask++) {
        const text = terms.filter((_term, index) => mask & (1 << index)).join(' ');
        const bodyMask = ((mask << 1) | (mask >> 5)) & 63;
        const bodyText = terms.filter((_term, index) => bodyMask & (1 << index)).join(' ');
        for (const uid of [9, 20, 31]) {
          for (const [seen, flagged] of [[false, false], [true, false], [false, true], [true, true]]) {
            const message: Fixture = { uid, subject: (mask % 3 ? 'ordinary ' : 'other ') + text, body: (mask % 5 ? 'legacy ' : 'other ') + bodyText, seen, flagged };
            const scoped = keywordScope === 'subject' ? message.subject : keywordScope === 'body' ? message.body : message.subject + ' ' + message.body;
            const expected = uid === 20
              && (query.keywordsAll ?? []).every(term => scoped.includes(term))
              && (!query.keywordsAny?.length || query.keywordsAny.some(term => scoped.includes(term)))
              && (query.excludeKeywords ?? []).every(term => !scoped.includes(term))
              && (query.unread === undefined || !message.seen === query.unread)
              && (query.flagged === undefined || message.flagged === query.flagged)
              && (!query.keywords || message.body.includes(query.keywords))
              && (!query.subject || message.subject.includes(query.subject));
            expect(commands.every(command => matches(command.attributes, message)), JSON.stringify({ query, keywordScope, message })).toBe(expected);
          }
        }
      }
    }
  });

  it('keeps ordinary and unconstrained Any searches to one command, including twenty alternatives', async () => {
    expect(buildSearchCriteria({ subject: 'ordinary' })).toEqual([{ subject: 'ordinary' }]);
    expect(buildSearchCriteria({})).toEqual([{ all: true }]);
    const query = { keywordsAny: ['alpha', ...Array.from({ length: 19 }, (_item, index) => 'term' + index)] };
    const criteria = buildSearchCriteria(query);
    expect(criteria).toHaveLength(1);
    expect(criteria[0].or).toHaveLength(20);
    const commands = await compile(query);
    expect(commands).toHaveLength(1);
    const message = { uid: 20, subject: '', body: 'alpha', seen: false, flagged: false };
    expect(matches(commands[0].attributes, message)).toBe(true);
    expect(matches(commands[0].attributes, { ...message, body: 'other' })).toBe(false);
  });
});
