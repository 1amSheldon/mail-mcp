import { AppleMailError } from './errors.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { OsascriptRunner } from './runner.js';
import type { AppleScriptRunner } from './runner.js';
import { SerializedExecutor } from './serialization.js';
import {
  composeScript,
  createDraftScript,
  createMailboxScript,
  createRuleScript,
  deleteMailboxScript,
  deleteRuleScript,
  forwardScript,
  listAccountsScript,
  listMailboxesScript,
  listMessagesScript,
  listRulesScript,
  moveMessageScript,
  rawSourceScript,
  readMessageScript,
  renameMailboxScript,
  replyAllScript,
  replyScript,
  searchMessagesScript,
  trashMessageScript,
  updateMessageScript,
  updateRuleScript,
} from './scripts.js';
import { APPLE_MAIL_OPERATION_KINDS } from './types.js';
import type {
  AppleComposeInput,
  AppleDraftInput,
  AppleForwardInput,
  AppleListMessagesInput,
  AppleMailAccount,
  AppleMailMessage,
  AppleMailMessageSummary,
  AppleMailMutationResult,
  AppleMailOperation,
  AppleMailOperationKind,
  AppleMailRule,
  AppleMailbox,
  AppleMailboxCreateInput,
  AppleMailboxDeleteInput,
  AppleMailboxRenameInput,
  AppleMailboxSelector,
  AppleMessageSelector,
  AppleMessageUpdateInput,
  AppleMoveMessageInput,
  AppleReplyInput,
  AppleRuleCreateInput,
  AppleRuleDeleteInput,
  AppleRuleUpdateInput,
  AppleSearchMessagesInput,
} from './types.js';

export interface AppleMailAdapterOptions {
  runner?: AppleScriptRunner;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /**
   * Real-path roots from which Mail.app may read outbound attachments.
   * Path attachments are disabled when no roots are configured.
   */
  allowedAttachmentRoots?: readonly string[];
}

export class AppleMailAdapter {
  private readonly runner: AppleScriptRunner;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly allowedAttachmentRoots: readonly string[];
  private readonly executor = new SerializedExecutor();

  constructor(options: AppleMailAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.allowedAttachmentRoots = [...(options.allowedAttachmentRoots ?? [])];
    for (const root of this.allowedAttachmentRoots) {
      if ((!path.isAbsolute(root) && !path.posix.isAbsolute(root)) || /[\u0000-\u001F\u007F]/.test(root)) {
        throw new AppleMailError(
          'INVALID_ARGUMENT',
          'Apple Mail attachment roots must be absolute paths without control characters.',
        );
      }
    }
    this.runner = options.runner ?? new OsascriptRunner({
      platform: this.platform,
      timeoutMs: this.timeoutMs,
    });
  }

  operationKind(operation: AppleMailOperation): AppleMailOperationKind {
    return APPLE_MAIL_OPERATION_KINDS[operation];
  }

  async listAccounts(): Promise<AppleMailAccount[]> {
    return await this.execute('listAccounts', listAccountsScript());
  }

  async listMailboxes(input: AppleMailboxSelector): Promise<AppleMailbox[]> {
    return await this.execute('listMailboxes', listMailboxesScript(input));
  }

  async listMessages(input: AppleListMessagesInput): Promise<AppleMailMessageSummary[]> {
    return await this.execute('listMessages', listMessagesScript(input));
  }

  async searchMessages(input: AppleSearchMessagesInput): Promise<AppleMailMessageSummary[]> {
    return await this.execute('searchMessages', searchMessagesScript(input));
  }

  async readMessage(input: AppleMessageSelector): Promise<AppleMailMessage> {
    return await this.execute('readMessage', readMessageScript(input));
  }

  async getRawSource(input: AppleMessageSelector): Promise<{ rawSource: string }> {
    return await this.execute('getRawSource', rawSourceScript(input));
  }

  async compose(input: AppleComposeInput): Promise<AppleMailMutationResult> {
    const validated = await this.withValidatedAttachments(input);
    return await this.execute('compose', composeScript(validated));
  }

  async createDraft(input: AppleDraftInput): Promise<AppleMailMutationResult> {
    const validated = await this.withValidatedAttachments(input);
    return await this.execute('createDraft', createDraftScript(validated));
  }

  async reply(input: AppleReplyInput): Promise<AppleMailMutationResult> {
    const validated = await this.withValidatedAttachments(input);
    return await this.execute('reply', replyScript(validated));
  }

  async replyAll(input: AppleReplyInput): Promise<AppleMailMutationResult> {
    const validated = await this.withValidatedAttachments(input);
    return await this.execute('replyAll', replyAllScript(validated));
  }

  async forward(input: AppleForwardInput): Promise<AppleMailMutationResult> {
    const validated = await this.withValidatedAttachments(input);
    return await this.execute('forward', forwardScript(validated));
  }

  async updateMessage(input: AppleMessageUpdateInput): Promise<AppleMailMutationResult> {
    return await this.execute('updateMessage', updateMessageScript(input));
  }

  async moveMessage(input: AppleMoveMessageInput): Promise<AppleMailMutationResult> {
    return await this.execute('moveMessage', moveMessageScript(input));
  }

  async trashMessage(input: AppleMessageSelector): Promise<AppleMailMutationResult> {
    return await this.execute('trashMessage', trashMessageScript(input));
  }

  async createMailbox(input: AppleMailboxCreateInput): Promise<AppleMailMutationResult> {
    return await this.execute('createMailbox', createMailboxScript(input));
  }

  async renameMailbox(input: AppleMailboxRenameInput): Promise<AppleMailMutationResult> {
    return await this.execute('renameMailbox', renameMailboxScript(input));
  }

  async deleteMailbox(input: AppleMailboxDeleteInput): Promise<AppleMailMutationResult> {
    return await this.execute('deleteMailbox', deleteMailboxScript(input));
  }

  async listRules(input: AppleMailboxSelector): Promise<AppleMailRule[]> {
    return await this.execute('listRules', listRulesScript(input));
  }

  async createRule(input: AppleRuleCreateInput): Promise<AppleMailMutationResult> {
    return await this.execute('createRule', createRuleScript(input));
  }

  async updateRule(input: AppleRuleUpdateInput): Promise<AppleMailMutationResult> {
    return await this.execute('updateRule', updateRuleScript(input));
  }

  async deleteRule(input: AppleRuleDeleteInput): Promise<AppleMailMutationResult> {
    return await this.execute('deleteRule', deleteRuleScript(input));
  }

  private async execute<T>(operation: AppleMailOperation, script: string): Promise<T> {
    if (this.platform !== 'darwin') {
      throw new AppleMailError(
        'UNSUPPORTED_PLATFORM',
        'The Apple Mail provider is available only on macOS.',
      );
    }
    return await this.executor.run(async () => {
      const output = await this.runner.run(script, { timeoutMs: this.timeoutMs });
      try {
        return JSON.parse(output) as T;
      } catch (error) {
        throw new AppleMailError(
          'INVALID_RESPONSE',
          `Apple Mail returned invalid JSON for ${operation}.`,
          { cause: error },
        );
      }
    });
  }

  private async withValidatedAttachments<Input extends {
    attachments?: readonly { path: string; name?: string }[];
  }>(input: Input): Promise<Input> {
    if (!input.attachments || input.attachments.length === 0) return input;
    if (this.allowedAttachmentRoots.length === 0) {
      throw new AppleMailError(
        'INVALID_ARGUMENT',
        'Apple Mail path attachments are disabled; configure allowedAttachmentRoots for the account.',
      );
    }

    let roots: string[];
    try {
      roots = await Promise.all(this.allowedAttachmentRoots.map(root => fsPromises.realpath(root)));
    } catch (error) {
      throw new AppleMailError(
        'INVALID_ARGUMENT',
        'Apple Mail attachment roots must exist and be readable.',
        { cause: error },
      );
    }

    const attachments = [] as Array<{ path: string; name?: string }>;
    for (const attachment of input.attachments) {
      if ((!path.isAbsolute(attachment.path) && !path.posix.isAbsolute(attachment.path))
        || /[\u0000-\u001F\u007F]/.test(attachment.path)) {
        throw new AppleMailError(
          'INVALID_ARGUMENT',
          'Apple Mail attachment paths must be absolute paths without control characters.',
        );
      }
      let realPath: string;
      try {
        realPath = await fsPromises.realpath(attachment.path);
      } catch (error) {
        throw new AppleMailError(
          'INVALID_ARGUMENT',
          'Apple Mail attachment path must resolve to an existing file.',
          { cause: error },
        );
      }
      const allowed = roots.some(root => {
        const relative = path.relative(root, realPath);
        return relative === ''
          || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
      });
      if (!allowed) {
        throw new AppleMailError(
          'INVALID_ARGUMENT',
          'Apple Mail attachment path is outside the configured allowedAttachmentRoots.',
        );
      }
      attachments.push({ ...attachment, path: realPath });
    }
    return { ...input, attachments };
  }
}
