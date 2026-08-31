export { MailtrapClient, MailtrapHttpError } from './client.js';
export { classifyMailtrapAction } from './classification.js';
export { MAILTRAP_REDACTED, redactMailtrapSecrets } from './redaction.js';
export type {
  JsonObject,
  JsonValue,
  MailtrapAction,
  MailtrapActionClassification,
  MailtrapActionInputMap,
  MailtrapClientOptions,
  MailtrapEndpoints,
  MailtrapResult,
  QueryObject,
} from './types.js';
