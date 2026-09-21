import { createHash } from 'node:crypto';
import type { SearchObject } from 'imapflow';
import { ValidationError } from '../errors.js';

export const MAX_SEARCH_KEYWORDS = 20;
export const MAX_SEARCH_KEYWORD_CHARS = 256;
const MAX_PAGINATION_QUERY_KEY_CHARS = 8_192;

export type SearchKeywordScope = 'body' | 'subject' | 'all';

export interface SearchEmailsQuery {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  since?: string;
  before?: string;
  keywords?: string;
  messageId?: string;
  keywordsAll?: string[];
  keywordsAny?: string[];
  excludeKeywords?: string[];
  keywordScope?: SearchKeywordScope;
  unread?: boolean;
  flagged?: boolean;
}

const SEARCH_QUERY_FIELDS = new Set<keyof SearchEmailsQuery>([
  'from',
  'to',
  'cc',
  'subject',
  'since',
  'before',
  'keywords',
  'messageId',
  'keywordsAll',
  'keywordsAny',
  'excludeKeywords',
  'keywordScope',
  'unread',
  'flagged',
]);

const SEARCH_STRING_FIELDS: Array<keyof SearchEmailsQuery> = [
  'from',
  'to',
  'cc',
  'subject',
  'since',
  'before',
  'keywords',
  'messageId',
];

function normalizeDate(value: unknown, field: string): string | undefined {
  const result = normalizeString(value, field);
  if (result === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
  if (!match) {
    throw new ValidationError(`${field} must be a real YYYY-MM-DD date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ValidationError(`${field} must be a real YYYY-MM-DD date`);
  }
  return result;
}

function assertQueryObject(query: SearchEmailsQuery): Record<string, unknown> {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ValidationError('Search query must be an object');
  }
  const value = query as unknown as Record<string, unknown>;
  for (const field of Object.keys(value)) {
    if (!SEARCH_QUERY_FIELDS.has(field as keyof SearchEmailsQuery)) {
      throw new ValidationError(`Unsupported search field: ${field}`);
    }
  }
  return value;
}

function normalizeString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  return value.length > 0 ? value : undefined;
}

function normalizeKeywordList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  if (value.length > MAX_SEARCH_KEYWORDS) {
    throw new ValidationError(`${field} must contain at most ${MAX_SEARCH_KEYWORDS} words`);
  }

  const normalized = value.map((term, index) => {
    if (typeof term !== 'string') {
      throw new ValidationError(`${field}[${index}] must be a string`);
    }
    const trimmed = term.trim();
    if (!trimmed) {
      throw new ValidationError(`${field}[${index}] must not be empty`);
    }
    if (trimmed.length > MAX_SEARCH_KEYWORD_CHARS) {
      throw new ValidationError(
        `${field}[${index}] must be at most ${MAX_SEARCH_KEYWORD_CHARS} characters`,
      );
    }
    return trimmed;
  });

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function normalizeBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`);
  }
  return value;
}

/**
 * Validate and canonicalize a search query before it is used for IMAP or a
 * pagination scope. Arrays are sorted/deduplicated so equivalent requests
 * produce the same cursor binding.
 */
export function normalizeSearchQuery(query: SearchEmailsQuery): SearchEmailsQuery {
  const value = assertQueryObject(query);
  const normalized: SearchEmailsQuery = {};

  for (const field of SEARCH_STRING_FIELDS) {
    const result = field === 'since' || field === 'before'
      ? normalizeDate(value[field], field)
      : normalizeString(value[field], field);
    if (result !== undefined) {
      if (field === 'keywords' && result.length > MAX_SEARCH_KEYWORD_CHARS) {
        throw new ValidationError(
          `keywords must be at most ${MAX_SEARCH_KEYWORD_CHARS} characters`,
        );
      }
      (normalized as Record<string, unknown>)[field] = result;
    }
  }

  const keywordsAll = normalizeKeywordList(value.keywordsAll, 'keywordsAll');
  const keywordsAny = normalizeKeywordList(value.keywordsAny, 'keywordsAny');
  const excludeKeywords = normalizeKeywordList(value.excludeKeywords, 'excludeKeywords');
  if (keywordsAll?.length) normalized.keywordsAll = keywordsAll;
  if (keywordsAny?.length) normalized.keywordsAny = keywordsAny;
  if (excludeKeywords?.length) normalized.excludeKeywords = excludeKeywords;

  if (value.keywordScope !== undefined) {
    if (value.keywordScope !== 'body' && value.keywordScope !== 'subject' && value.keywordScope !== 'all') {
      throw new ValidationError('keywordScope must be body, subject, or all');
    }
    normalized.keywordScope = value.keywordScope;
  }

  const unread = normalizeBoolean(value.unread, 'unread');
  const flagged = normalizeBoolean(value.flagged, 'flagged');
  if (unread !== undefined) normalized.unread = unread;
  if (flagged !== undefined) normalized.flagged = flagged;

  if (normalized.since && normalized.before && normalized.since >= normalized.before) {
    throw new ValidationError('since must be earlier than before');
  }

  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  ) as SearchEmailsQuery;
}

function textCriterion(scope: SearchKeywordScope, term: string): SearchObject {
  if (scope === 'all') return { text: term };
  return scope === 'subject' ? { subject: term } : { body: term };
}

/**
 * Build one IMAP SearchObject. ImapFlow exposes implicit AND between object
 * fields, OR through `or`, and NOT through `not`; it has no AND array. The
 * required keyword list therefore uses De Morgan's law so every match remains
 * server-side: A AND B == NOT (NOT A OR NOT B).
 */
export function buildSearchCriteria(query: SearchEmailsQuery): SearchObject {
  const normalized = normalizeSearchQuery(query);
  const criteria: SearchObject = {};

  if (normalized.from) criteria.from = normalized.from;
  if (normalized.to) criteria.to = normalized.to;
  if (normalized.cc) criteria.cc = normalized.cc;
  if (normalized.subject) criteria.subject = normalized.subject;
  if (normalized.since) criteria.since = normalized.since;
  if (normalized.before) criteria.before = normalized.before;
  if (normalized.messageId) criteria.header = { 'Message-ID': normalized.messageId };
  if (normalized.unread !== undefined) criteria.seen = !normalized.unread;
  if (normalized.flagged !== undefined) criteria.flagged = normalized.flagged;

  // The legacy singular field is deliberately always BODY to preserve its
  // historical IMAP substring semantics, regardless of keywordScope.
  if (normalized.keywords) criteria.body = normalized.keywords;

  const scope = normalized.keywordScope ?? 'body';
  const anyTerms = normalized.keywordsAny?.map(term => textCriterion(scope, term)) ?? [];
  if (anyTerms.length > 0) {
    criteria.or = anyTerms;
  }

  const notOperands: SearchObject[] = [
    ...(normalized.keywordsAll?.map(term => ({ not: textCriterion(scope, term) })) ?? []),
    ...(normalized.excludeKeywords?.map(term => textCriterion(scope, term)) ?? []),
  ];
  if (notOperands.length === 1) {
    criteria.not = notOperands[0];
  } else if (notOperands.length > 1) {
    criteria.not = { or: notOperands };
  }

  return criteria;
}

/**
 * Return a bounded, canonical cursor scope component. Small queries remain
 * inspectable; larger valid keyword combinations use a SHA-256 digest so the
 * cursor still binds every filter without exceeding PaginationSnapshotStore's
 * scope limit.
 */
export function searchPaginationKey(query: SearchEmailsQuery, headerOnly: boolean): string {
  const normalized = normalizeSearchQuery(query);
  const canonical = JSON.stringify({ kind: 'search', query: normalized, headerOnly });
  if (canonical.length <= MAX_PAGINATION_QUERY_KEY_CHARS) return canonical;
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return JSON.stringify({ kind: 'search', queryHash: digest, headerOnly });
}
