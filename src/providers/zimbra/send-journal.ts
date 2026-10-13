import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeTextFileAtomic } from '../../utils/atomic-write.js';
import { mkdirDurable, syncDirectory } from '../../utils/directory-sync.js';
import { ZimbraError } from './session.js';

const recordSchema = z.object({
  version: z.literal(1), draftId: z.string(), attemptId: z.string().uuid(),
  startedAt: z.string(), mimeHash: z.string().regex(/^[a-f0-9]{64}$/),
  messageId: z.string().optional(),
  status: z.enum(['sending', 'outcome_unknown', 'accepted', 'schedule_saved', 'schedule_cleared']),
  action: z.enum(['schedule', 'cancel_schedule']).optional(), scheduledFor: z.string().optional(),
  sentMessageId: z.string().optional(),
  draftCleanup: z.enum(['retained', 'moved_to_trash', 'retained_changed_or_unverified']).default('retained'),
}).strict();
export type SendRecord = z.infer<typeof recordSchema>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** An exclusive claim is never cleared merely because a process died.
 * POSIX directory flushes also protect entries against host crashes. */
export class ZimbraSendJournal {
  private readonly directory: string;
  private readonly durabilityAnchor: string;
  constructor(scope: string, directory?: string) {
    // The home directory exists independently of journal initialization. A custom
    // journal root must likewise be provisioned durably by its caller beforehand.
    this.durabilityAnchor = directory ?? homedir();
    this.directory = join(directory ?? join(homedir(), '.config', 'mail-mcp', 'zimbra-send-state'), hash(scope));
  }
  private path(draftId: string) { return join(this.directory, hash(draftId) + '.json'); }
  async read(draftId: string): Promise<SendRecord | undefined> {
    try {
      const file = await open(this.path(draftId), 'r');
      try {
        if ((await file.stat()).size > 16384) throw new Error('Oversized journal');
        const record = recordSchema.parse(JSON.parse(await file.readFile('utf8')));
        if (record.draftId !== draftId) throw new Error('Mismatched journal');
        return record;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ZimbraError('OUTCOME_UNKNOWN', 'Send journal is incomplete or unreadable. Inspect server state; do not send again.');
    }
  }
  async begin(draftId: string, raw: Buffer, messageId?: string, schedule?: { action: 'schedule' | 'cancel_schedule'; scheduledFor?: string }): Promise<SendRecord> {
    const record: SendRecord = { version: 1, draftId, attemptId: randomUUID(), startedAt: new Date().toISOString(),
      mimeHash: hash(raw), messageId, status: 'sending', draftCleanup: 'retained', ...schedule };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdirDurable(this.directory, this.durabilityAnchor);
      handle = await open(this.path(draftId), 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
      await handle.sync();
      await syncDirectory(this.directory);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ZimbraError('OUTCOME_UNKNOWN', 'A send attempt already exists for this draft. Inspect getSendStatus before any further action.');
      throw new ZimbraError('PROVIDER_ERROR', 'Unable to persist the send claim. No send or schedule request was made.');
    } finally { await handle?.close(); }
  }
  async save(record: SendRecord): Promise<void> {
    try {
      const current = await this.read(record.draftId);
      if (!current || current.attemptId !== record.attemptId) throw new Error('Journal claim changed');
      await writeTextFileAtomic(this.path(record.draftId), JSON.stringify(recordSchema.parse(record)) + '\n');
      await syncDirectory(this.directory);
    } catch { throw new ZimbraError('OUTCOME_UNKNOWN', 'Unable to update the send journal. Inspect Sent; do not send again.'); }
  }
}

export function sendStatus(record: SendRecord) {
  return { status: record.status === 'sending' ? 'outcome_unknown' : record.status,
    draftId: record.draftId, attemptId: record.attemptId, messageId: record.messageId,
    sentMessageId: record.sentMessageId, startedAt: record.startedAt, draftCleanup: record.draftCleanup,
    ...(record.action ? { action: record.action, scheduledFor: record.scheduledFor } : {}),
    retrySafe: false, nextAction: record.action
      ? 'Inspect getScheduledDraft and Sent. Schedule metadata is not proof of delivery or non-delivery. This draft retains its send claim; create a new reviewed draft for any separately authorized new send.'
      : record.status === 'accepted'
      ? 'Do not resend. Server acceptance is not proof of recipient delivery.'
      : 'Inspect Sent and the draft with getSendStatus/verifySentMessage. Never retry an uncertain send automatically.' };
}
