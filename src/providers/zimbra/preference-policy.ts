import { validateEmailAddresses } from '../../utils/validation.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { ZimbraError } from './session.js';

// These settings cannot initiate an automatic send. Unknown preferences remain
// available on unrestricted accounts, subject to the server's own validation.
const nonSending = new Set([
  'zimbraPrefLocale', 'zimbraPrefTimeZoneId', 'zimbraPrefMailItemsPerPage',
  'zimbraPrefGroupMailBy', 'zimbraPrefMailView', 'zimbraPrefReadingPaneLocation',
  'zimbraPrefMailInitialSearch', 'zimbraPrefMailDefaultCharset', 'zimbraPrefComposeFormat',
  'zimbraPrefFromAddress', 'zimbraPrefFromDisplay', 'zimbraPrefReplyToAddress',
  'zimbraPrefReplyToDisplay', 'zimbraPrefReplyToEnabled', 'zimbraPrefSaveToSent',
  'zimbraPrefSentMailFolder', 'zimbraPrefDefaultSignatureId', 'zimbraPrefForwardReplySignatureId',
  'zimbraPrefMailSignature', 'zimbraPrefMailSignatureEnabled', 'zimbraPrefMailSignatureStyle',
  'zimbraPrefForwardIncludeOriginalText', 'zimbraPrefForwardReplyFormat', 'zimbraPrefForwardReplyPrefixChar',
  'zimbraPrefReplyIncludeOriginalText', 'zimbraPrefUseDefaultIdentitySettings',
  'zimbraPrefWhenInFolderIds', 'zimbraPrefWhenInFoldersEnabled', 'zimbraPrefWhenSentToAddresses',
  'zimbraPrefWhenSentToEnabled', 'zimbraPrefOutOfOfficeReply', 'zimbraPrefOutOfOfficeExternalReply',
]);
const destinationPrefs = new Set(['zimbraPrefBccAddress', 'zimbraPrefMailForwardingAddress', 'zimbraPrefNewMailNotificationAddress', 'zimbraPrefCalendarForwardInvitesTo']);
export function checkPreferencePolicy(values: Record<string, string | string[]>, allowedRecipients: readonly string[] | undefined): void {
  if (allowedRecipients === undefined) return;
  const allowed = new Set(allowedRecipients.map(v => v.toLowerCase()));
  for (const [name, value] of Object.entries(values)) {
    const strings = Array.isArray(value) ? value : [value];
    if (nonSending.has(name)) continue;
    if (destinationPrefs.has(name)) {
      try { validateEmailAddresses(...strings); }
      catch { throw new ZimbraError('INVALID_INPUT', 'Preference contains an invalid destination address.'); }
      const destinations = strings.flatMap(s => addressparser(s, { flatten: true }).map(v => v.address ?? ''));
      if (destinations.some(v => !allowed.has(v.toLowerCase()))) throw new ZimbraError('ACCESS_DENIED', 'Preference destination is outside the account recipient allowlist.');
      continue;
    }
    if (['zimbraPrefOutOfOfficeReplyEnabled', 'zimbraPrefOutOfOfficeExternalReplyEnabled'].includes(name) && strings.every(v => /^(false|0)$/i.test(v))) continue;
    throw new ZimbraError('ACCESS_DENIED', 'This preference can enable automatic sending or has unclassified effects under the account recipient policy.');
  }
}
