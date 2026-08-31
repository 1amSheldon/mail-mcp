const LOCATOR_PREFIX = 'imap:v1:';
const MAX_LOCATOR_LENGTH = 8_192;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_MAILBOX_LENGTH = 4_096;
const MAX_UINT32 = 4_294_967_295n;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface MessageLocator {
  accountId: string;
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export interface MessageLocatorInput {
  accountId: string;
  mailbox: string;
  uidValidity: string | bigint;
  uid: number;
}

interface EncodedMessageLocator {
  a: string;
  m: string;
  v: string;
  u: number;
}

function validateText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new Error(`Invalid message locator ${field}`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Invalid message locator ${field}`);
  }
  return value;
}

function normalizeUidValidity(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new Error('Invalid message locator uidValidity');
  }
  const text = value.toString();
  if (!/^[1-9]\d{0,9}$/.test(text)) {
    throw new Error('Invalid message locator uidValidity');
  }
  const parsed = BigInt(text);
  if (parsed > MAX_UINT32) {
    throw new Error('Invalid message locator uidValidity');
  }
  return parsed.toString();
}

function validateUid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || BigInt(value as number) > MAX_UINT32) {
    throw new Error('Invalid message locator uid');
  }
  return value as number;
}

function normalizeLocator(input: MessageLocatorInput): MessageLocator {
  return {
    accountId: validateText(input.accountId, 'accountId', MAX_ACCOUNT_ID_LENGTH),
    mailbox: validateText(input.mailbox, 'mailbox', MAX_MAILBOX_LENGTH),
    uidValidity: normalizeUidValidity(input.uidValidity),
    uid: validateUid(input.uid),
  };
}

export function encodeMessageLocator(input: MessageLocatorInput): string {
  const locator = normalizeLocator(input);
  const payload: EncodedMessageLocator = {
    a: locator.accountId,
    m: locator.mailbox,
    v: locator.uidValidity,
    u: locator.uid,
  };
  return `${LOCATOR_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeMessageLocator(value: string): MessageLocator {
  if (typeof value !== 'string' || value.length > MAX_LOCATOR_LENGTH || !value.startsWith(LOCATOR_PREFIX)) {
    throw new Error('Invalid message locator');
  }

  const encoded = value.slice(LOCATOR_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Invalid message locator');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid message locator');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid message locator');
  }

  const payload = parsed as Partial<EncodedMessageLocator>;
  return normalizeLocator({
    accountId: payload.a as string,
    mailbox: payload.m as string,
    uidValidity: payload.v as string,
    uid: payload.u as number,
  });
}

export function isMessageLocator(value: string): boolean {
  try {
    decodeMessageLocator(value);
    return true;
  } catch {
    return false;
  }
}
