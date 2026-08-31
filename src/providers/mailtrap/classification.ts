import type {
  MailtrapAction,
  MailtrapActionClassification,
  MailtrapActionInputMap,
} from './types.js';
import { assertKnownMailtrapActionInput } from './validation.js';

const READ: Readonly<MailtrapActionClassification> = Object.freeze({
  access: 'read',
  destructive: false,
  sendsMail: false,
  sensitiveResponse: false,
});

function write(
  destructive = false,
  sendsMail = false,
  sensitiveResponse = false,
): MailtrapActionClassification {
  return { access: 'write', destructive, sendsMail, sensitiveResponse };
}

export function classifyMailtrapAction<A extends MailtrapAction>(
  action: A,
  input: MailtrapActionInputMap[A],
): MailtrapActionClassification {
  assertKnownMailtrapActionInput(action, input);
  switch (action) {
    case 'send':
      return write(false, true);
    case 'accounts':
    case 'stats':
      return READ;
    case 'email_logs':
      return { ...READ, sensitiveResponse: true };
    case 'templates': {
      const operation = (input as MailtrapActionInputMap['templates']).operation;
      return operation === 'list' || operation === 'get'
        ? READ
        : write(operation === 'delete');
    }
    case 'sandbox': {
      const sandboxInput = input as MailtrapActionInputMap['sandbox'];
      if (sandboxInput.resource === 'inbox'
        && (sandboxInput.operation === 'list' || sandboxInput.operation === 'get')) {
        return { ...READ, sensitiveResponse: true };
      }
      if (sandboxInput.resource === 'message'
        && (sandboxInput.operation === 'list' || sandboxInput.operation === 'get'
          || sandboxInput.operation === 'body' || sandboxInput.operation === 'analysis')) {
        return { ...READ, sensitiveResponse: true };
      }
      if (sandboxInput.resource === 'attachment'
        && (sandboxInput.operation === 'list' || sandboxInput.operation === 'get')) {
        return { ...READ, sensitiveResponse: true };
      }
      if (sandboxInput.operation === 'list' || sandboxInput.operation === 'get') {
        return { ...READ };
      }
      if (sandboxInput.resource === 'message' && sandboxInput.operation === 'forward') {
        return write(false, true);
      }
      if (sandboxInput.resource === 'inbox' && sandboxInput.operation === 'reset_credentials') {
        return write(true, false, true);
      }
      const destructive = sandboxInput.operation === 'delete'
        || sandboxInput.operation === 'clean'
        || sandboxInput.operation === 'reset_email_address';
      return write(destructive);
    }
    case 'inbound': {
      const inboundInput = input as MailtrapActionInputMap['inbound'];
      if (inboundInput.operation === 'list' || inboundInput.operation === 'get') {
        return { ...READ, sensitiveResponse: true };
      }
      if (inboundInput.operation === 'reply' || inboundInput.operation === 'reply_all'
        || inboundInput.operation === 'forward') {
        return write(false, true, true);
      }
      return write(inboundInput.operation === 'delete');
    }
    case 'domains': {
      const operation = (input as MailtrapActionInputMap['domains']).operation;
      if (operation === 'list' || operation === 'get') return READ;
      return write(operation === 'delete', operation === 'send_setup');
    }
    case 'suppressions': {
      const operation = (input as MailtrapActionInputMap['suppressions']).operation;
      return operation === 'list' ? READ : write(true);
    }
    case 'webhooks': {
      const operation = (input as MailtrapActionInputMap['webhooks']).operation;
      if (operation === 'list' || operation === 'get') return READ;
      return write(operation === 'delete', false, operation === 'create');
    }
    case 'contacts': {
      const operation = (input as MailtrapActionInputMap['contacts']).operation;
      return operation === 'get' ? READ : write(operation === 'delete');
    }
    case 'contact_lists':
    case 'contact_fields': {
      const operation = (input as MailtrapActionInputMap['contact_lists']).operation;
      return operation === 'list' || operation === 'get'
        ? READ
        : write(operation === 'delete');
    }
    case 'contact_imports':
    case 'contact_exports': {
      const operation = (input as MailtrapActionInputMap['contact_imports']).operation;
      return operation === 'get' ? READ : write();
    }
    case 'campaigns': {
      const operation = (input as MailtrapActionInputMap['campaigns']).operation;
      if (operation === 'list' || operation === 'get' || operation === 'stats') return READ;
      const destructive = operation === 'delete' || operation === 'terminate';
      const sendsMail = operation === 'start' || operation === 'schedule';
      return write(destructive, sendsMail);
    }
    default: {
      const exhaustive: never = action;
      throw new TypeError(`Unsupported Mailtrap action: ${String(exhaustive)}`);
    }
  }
}
