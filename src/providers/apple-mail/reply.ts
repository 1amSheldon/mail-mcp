import type { AppleMailAddress, ReplyEnvelope } from './types.js';

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function buildReplyAllRecipients(
  envelope: ReplyEnvelope,
  selfAddresses: readonly string[],
): { to: AppleMailAddress[]; cc: AppleMailAddress[] } {
  const self = new Set(selfAddresses.map(normalizeAddress));
  const seen = new Set<string>();
  const keep = (candidate: AppleMailAddress): boolean => {
    const normalized = normalizeAddress(candidate.address);
    if (!normalized || self.has(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  };

  const to = [...envelope.from, ...envelope.to].filter(keep);
  const cc = envelope.cc.filter(keep);
  return { to, cc };
}
