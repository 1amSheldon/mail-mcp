import type {
  AppleComposeInput,
  AppleDraftInput,
  AppleForwardInput,
  AppleListMessagesInput,
  AppleMailboxCreateInput,
  AppleMailboxDeleteInput,
  AppleMailboxRenameInput,
  AppleMailboxSelector,
  AppleMessageSelector,
  AppleMessageUpdateInput,
  AppleMoveMessageInput,
  AppleReplyInput,
  AppleRuleCreateInput,
  AppleRuleCondition,
  AppleRuleDeleteInput,
  AppleRuleUpdateInput,
  AppleSearchMessagesInput,
} from './types.js';

function clean(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function appleScriptText(value: string): string {
  const pieces = clean(value).split(/(\r\n|\r|\n|\t)/);
  return pieces.map((piece) => {
    if (piece === '\r\n' || piece === '\r' || piece === '\n') return 'linefeed';
    if (piece === '\t') return 'tab';
    return `"${piece.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(' & ');
}

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

function jsonHelpers(): string {
  return String.raw`
on replaceText(findText, replacementText, sourceText)
  set oldTids to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set sourceParts to text items of (sourceText as text)
  set AppleScript's text item delimiters to replacementText
  set resultText to sourceParts as text
  set AppleScript's text item delimiters to oldTids
  return resultText
end replaceText

on jsonString(value)
  set output to value as text
  set output to my replaceText("\\", "\\\\", output)
  set output to my replaceText(quote, "\\\"", output)
  set output to my replaceText(return, "\\r", output)
  set output to my replaceText(linefeed, "\\n", output)
  set output to my replaceText(tab, "\\t", output)
  return quote & output & quote
end jsonString

on jsonBoolean(value)
  if value then return "true"
  return "false"
end jsonBoolean

on jsonArray(values)
  set resultText to "["
  set firstValue to true
  repeat with itemValue in values
    if not firstValue then set resultText to resultText & ","
    set resultText to resultText & my jsonString(itemValue as text)
    set firstValue to false
  end repeat
  return resultText & "]"
end jsonArray

on splitPath(pathText)
  set oldTids to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "/"
  set pathParts to text items of pathText
  set AppleScript's text item delimiters to oldTids
  return pathParts
end splitPath

on findAccount(accountRef)
  tell application "Mail"
    repeat with candidate in every account
      set candidateName to name of candidate as text
      set candidateId to id of candidate as text
      if candidateName is accountRef or candidateId is accountRef then return candidate
    end repeat
  end tell
  error "Apple Mail account not found: " & accountRef number -1728
end findAccount

on findMailbox(accountRef, mailboxPath)
  set selectedAccount to my findAccount(accountRef)
  -- Localized Inbox aliases adapted from patrickfreyer/apple-mail-mcp (MIT).
  if mailboxPath is "INBOX" then
    tell application "Mail"
      repeat with inboxName in {"INBOX", "Inbox", "Boîte de réception", "Boîte aux lettres", "Réception", "Posteingang", "Bandeja de entrada", "Posta in arrivo", "Caixa de entrada", "Postvak IN", "受信トレイ"}
        try
          return mailbox (inboxName as text) of selectedAccount
        end try
      end repeat
    end tell
    error "Inbox mailbox not found for account: " & accountRef number -1728
  end if
  set currentContainer to selectedAccount
  repeat with partName in my splitPath(mailboxPath)
    tell application "Mail"
      set matches to every mailbox of currentContainer whose name is (partName as text)
      if (count of matches) is 0 then error "Mailbox not found: " & mailboxPath number -1728
      set currentContainer to item 1 of matches
    end tell
  end repeat
  return currentContainer
end findMailbox

on findMessage(accountRef, mailboxPath, messageRef)
  set selectedMailbox to my findMailbox(accountRef, mailboxPath)
  tell application "Mail"
    repeat with candidate in every message of selectedMailbox
      set numericId to id of candidate as text
      set rfcId to ""
      try
        set rfcId to message id of candidate as text
      end try
      if numericId is messageRef or rfcId is messageRef then return candidate
    end repeat
  end tell
  error "Message not found: " & messageRef number -1728
end findMessage

on recipientAddresses(recipientList)
  set addresses to {}
  repeat with recipientItem in recipientList
    try
      set end of addresses to address of recipientItem as text
    end try
  end repeat
  return addresses
end recipientAddresses

on messageJson(messageItem, includeContent)
  tell application "Mail"
    set numericId to id of messageItem as text
    set rfcId to ""
    try
      set rfcId to message id of messageItem as text
    end try
    set messageSubject to subject of messageItem as text
    set messageSender to sender of messageItem as text
    set receivedText to ""
    try
      set receivedText to date received of messageItem as text
    end try
    set isRead to read status of messageItem
    set isFlagged to flagged status of messageItem
    set bodyText to ""
    if includeContent then set bodyText to content of messageItem as text
    set snippetText to bodyText
    if (length of snippetText) > 500 then set snippetText to text 1 thru 500 of snippetText
    set resultText to "{\"id\":" & my jsonString(numericId) & ",\"rfcMessageId\":"
    if rfcId is "" then
      set resultText to resultText & "null"
    else
      set resultText to resultText & my jsonString(rfcId)
    end if
    set resultText to resultText & ",\"subject\":" & my jsonString(messageSubject)
    set resultText to resultText & ",\"sender\":" & my jsonString(messageSender)
    set resultText to resultText & ",\"to\":" & my jsonArray(my recipientAddresses(to recipients of messageItem))
    set resultText to resultText & ",\"cc\":" & my jsonArray(my recipientAddresses(cc recipients of messageItem))
    if receivedText is "" then
      set resultText to resultText & ",\"dateReceived\":null"
    else
      set resultText to resultText & ",\"dateReceived\":" & my jsonString(receivedText)
    end if
    set resultText to resultText & ",\"read\":" & my jsonBoolean(isRead)
    set resultText to resultText & ",\"flagged\":" & my jsonBoolean(isFlagged)
    set resultText to resultText & ",\"snippet\":" & my jsonString(snippetText)
    if includeContent then set resultText to resultText & ",\"content\":" & my jsonString(bodyText) & ",\"replyTo\":null"
    return resultText & "}"
  end tell
end messageJson
`;
}

function program(body: string): string {
  return `${jsonHelpers()}\n${body.trim()}\n`;
}

function accountSetup(account: string): string {
  return `set selectedAccount to my findAccount(${appleScriptText(account)})`;
}

function mailboxSetup(input: AppleMailboxSelector): string {
  return `set selectedMailbox to my findMailbox(${appleScriptText(input.account)}, ${appleScriptText(input.mailbox ?? 'INBOX')})`;
}

function messageSetup(input: AppleMessageSelector): string {
  return `set selectedMessage to my findMessage(${appleScriptText(input.account)}, ${appleScriptText(input.mailbox ?? 'INBOX')}, ${appleScriptText(input.messageId)})`;
}

export function listAccountsScript(): string {
  return program(`
set resultText to "["
set firstItem to true
tell application "Mail"
  repeat with accountItem in every account
    if not firstItem then set resultText to resultText & ","
    set accountName to name of accountItem as text
    set accountId to id of accountItem as text
    set accountFullName to ""
    set accountAliases to {}
    set accountType to "unknown"
    set accountEnabled to true
    try
      set accountFullName to full name of accountItem as text
    end try
    try
      set accountAliases to email addresses of accountItem
    end try
    try
      set accountType to account type of accountItem as text
    end try
    try
      set accountEnabled to enabled of accountItem
    end try
    set resultText to resultText & "{\"id\":" & my jsonString(accountId) & ",\"name\":" & my jsonString(accountName)
    if accountFullName is "" then
      set resultText to resultText & ",\"fullName\":null"
    else
      set resultText to resultText & ",\"fullName\":" & my jsonString(accountFullName)
    end if
    set resultText to resultText & ",\"aliases\":" & my jsonArray(accountAliases) & ",\"type\":" & my jsonString(accountType) & ",\"enabled\":" & my jsonBoolean(accountEnabled) & "}"
    set firstItem to false
  end repeat
end tell
return resultText & "]"`);
}

export function listMailboxesScript(input: AppleMailboxSelector): string {
  return program(`
on appendMailboxes(containerItem, parentPath, resultItems)
  tell application "Mail"
    repeat with mailboxItem in every mailbox of containerItem
      set mailboxName to name of mailboxItem as text
      if parentPath is "" then
        set mailboxPath to mailboxName
      else
        set mailboxPath to parentPath & "/" & mailboxName
      end if
      set unreadValue to 0
      set messageValue to 0
      try
        set unreadValue to unread count of mailboxItem
      end try
      try
        set messageValue to count of messages of mailboxItem
      end try
      set rowText to "{\"name\":" & my jsonString(mailboxName) & ",\"path\":" & my jsonString(mailboxPath) & ",\"unreadCount\":" & unreadValue & ",\"messageCount\":" & messageValue & "}"
      set end of resultItems to rowText
      my appendMailboxes(mailboxItem, mailboxPath, resultItems)
    end repeat
  end tell
end appendMailboxes
${accountSetup(input.account)}
set rows to {}
my appendMailboxes(selectedAccount, "", rows)
set resultText to "["
repeat with rowIndex from 1 to count of rows
  if rowIndex > 1 then set resultText to resultText & ","
  set resultText to resultText & item rowIndex of rows
end repeat
return resultText & "]"`);
}

function messageCollectionScript(input: AppleListMessagesInput, predicate = 'true'): string {
  const maxItems = Number.isSafeInteger(input.maxItems)
    ? Math.max(1, Math.min(input.maxItems as number, 10_000))
    : 10_000;
  return program(`
${mailboxSetup(input)}
set resultText to "["
set matchedCount to 0
tell application "Mail"
  repeat with messageItem in every message of selectedMailbox
    set includeMessage to ${predicate}
    if includeMessage then
      set matchedCount to matchedCount + 1
      if matchedCount > ${maxItems} then error "Apple Mail result exceeds the configured snapshot limit" number -2700
      if matchedCount > 1 then set resultText to resultText & ","
      set resultText to resultText & my messageJson(messageItem, false)
    end if
  end repeat
end tell
return resultText & "]"`);
}

export function listMessagesScript(input: AppleListMessagesInput): string {
  return messageCollectionScript(input);
}

export function searchMessagesScript(input: AppleSearchMessagesInput): string {
  const checks: string[] = [];
  const contains = (property: string, value: string): void => {
    checks.push(`(${property} as text) contains ${appleScriptText(value)}`);
  };
  if (input.query) checks.push(`((subject of messageItem as text) contains ${appleScriptText(input.query)} or (sender of messageItem as text) contains ${appleScriptText(input.query)} or (content of messageItem as text) contains ${appleScriptText(input.query)})`);
  if (input.from) contains('sender of messageItem', input.from);
  if (input.subject) contains('subject of messageItem', input.subject);
  if (input.body) contains('content of messageItem', input.body);
  if (input.unread !== undefined) checks.push(`(read status of messageItem is ${bool(!input.unread)})`);
  if (input.flagged !== undefined) checks.push(`(flagged status of messageItem is ${bool(input.flagged)})`);
  if (input.hasAttachments !== undefined) checks.push(`((count of mail attachments of messageItem) ${input.hasAttachments ? '>' : '='} 0)`);
  if (input.since) checks.push(`(date received of messageItem >= date ${appleScriptText(input.since)})`);
  if (input.before) checks.push(`(date received of messageItem < date ${appleScriptText(input.before)})`);
  return messageCollectionScript(input, checks.length > 0 ? checks.join(' and ') : 'true');
}

export function readMessageScript(input: AppleMessageSelector): string {
  return program(`${messageSetup(input)}\nreturn my messageJson(selectedMessage, true)`);
}

export function rawSourceScript(input: AppleMessageSelector): string {
  return program(`${messageSetup(input)}
tell application "Mail" to set rawText to source of selectedMessage as text
return "{\"rawSource\":" & my jsonString(rawText) & "}"`);
}

function recipientStatements(variableName: string, role: 'to' | 'cc' | 'bcc', values: readonly string[]): string {
  return values.map((address) => `make new ${role} recipient at end of ${role} recipients of ${variableName} with properties {address:${appleScriptText(address)}}`).join('\n');
}

function attachmentStatements(variableName: string, attachments: readonly { path: string }[]): string {
  return attachments.map((attachment) => `make new attachment with properties {file name:(POSIX file ${appleScriptText(attachment.path)})} at after last paragraph of content of ${variableName}`).join('\n');
}

function outgoingBody(input: AppleComposeInput | AppleDraftInput, mode: 'send' | 'draft'): string {
  const account = input.account ? accountSetup(input.account) : '';
  const sender = input.from
    ? `set sender of outgoingMessage to ${appleScriptText(input.from)}`
    : input.account
      ? 'try\nset sender of outgoingMessage to item 1 of email addresses of selectedAccount\nend try'
      : '';
  const visible = mode === 'draft' && 'open' in input && input.open === true;
  return program(`${account}
tell application "Mail"
  set outgoingMessage to make new outgoing message with properties {subject:${appleScriptText(input.subject)}, content:${appleScriptText(input.body)}, visible:${bool(visible)}}
  ${sender}
  ${recipientStatements('outgoingMessage', 'to', input.to)}
  ${recipientStatements('outgoingMessage', 'cc', input.cc ?? [])}
  ${recipientStatements('outgoingMessage', 'bcc', input.bcc ?? [])}
  ${attachmentStatements('outgoingMessage', input.attachments ?? [])}
  ${mode === 'send' ? 'send outgoingMessage' : 'save outgoingMessage'}
  set resultId to id of outgoingMessage as text
end tell
return "{\"ok\":true,\"operation\":\"${mode === 'send' ? 'compose' : 'createDraft'}\",\"id\":" & my jsonString(resultId) & "}"`);
}

export function composeScript(input: AppleComposeInput): string {
  return outgoingBody(input, 'send');
}

export function createDraftScript(input: AppleDraftInput): string {
  return outgoingBody(input, 'draft');
}

function responseScript(input: AppleReplyInput, operation: 'reply' | 'replyAll'): string {
  const command = operation === 'replyAll' ? 'reply selectedMessage with reply to all and opening window' : 'reply selectedMessage with opening window';
  return program(`${messageSetup(input)}
tell application "Mail"
  set outgoingMessage to ${command}
  set content of outgoingMessage to ${appleScriptText(input.body)}
  ${attachmentStatements('outgoingMessage', input.attachments ?? [])}
  ${input.send === false ? 'save outgoingMessage' : 'send outgoingMessage'}
  set resultId to id of outgoingMessage as text
end tell
return "{\"ok\":true,\"operation\":\"${operation}\",\"id\":" & my jsonString(resultId) & "}"`);
}

export function replyScript(input: AppleReplyInput): string {
  return responseScript(input, 'reply');
}

export function replyAllScript(input: AppleReplyInput): string {
  return responseScript(input, 'replyAll');
}

export function forwardScript(input: AppleForwardInput): string {
  return program(`${messageSetup(input)}
tell application "Mail"
  set outgoingMessage to forward selectedMessage with opening window
  set content of outgoingMessage to ${appleScriptText(input.body)} & return & return & content of outgoingMessage
  delete every to recipient of outgoingMessage
  delete every cc recipient of outgoingMessage
  delete every bcc recipient of outgoingMessage
  ${recipientStatements('outgoingMessage', 'to', input.to)}
  ${recipientStatements('outgoingMessage', 'cc', input.cc ?? [])}
  ${recipientStatements('outgoingMessage', 'bcc', input.bcc ?? [])}
  ${attachmentStatements('outgoingMessage', input.attachments ?? [])}
  ${input.send === false ? 'save outgoingMessage' : 'send outgoingMessage'}
  set resultId to id of outgoingMessage as text
end tell
return "{\"ok\":true,\"operation\":\"forward\",\"id\":" & my jsonString(resultId) & "}"`);
}

export function updateMessageScript(input: AppleMessageUpdateInput): string {
  const updates: string[] = [];
  if (input.read !== undefined) updates.push(`set read status of selectedMessage to ${bool(input.read)}`);
  if (input.flagged !== undefined) updates.push(`set flagged status of selectedMessage to ${bool(input.flagged)}`);
  if (input.flagColor !== undefined) updates.push(`set flag index of selectedMessage to ${Math.max(0, Math.min(7, input.flagColor))}`);
  return mutationScript(input, 'updateMessage', updates.join('\n'));
}

function mutationScript(input: AppleMessageSelector, operation: string, statement: string): string {
  return program(`${messageSetup(input)}
tell application "Mail"
  ${statement}
end tell
return "{\"ok\":true,\"operation\":\"${operation}\"}"`);
}

export function moveMessageScript(input: AppleMoveMessageInput): string {
  return program(`${messageSetup(input)}
set destinationMailbox to my findMailbox(${appleScriptText(input.account)}, ${appleScriptText(input.destination)})
tell application "Mail" to move selectedMessage to destinationMailbox
return "{\"ok\":true,\"operation\":\"moveMessage\"}"`);
}

export function trashMessageScript(input: AppleMessageSelector): string {
  return mutationScript(input, 'trashMessage', 'delete selectedMessage');
}

export function createMailboxScript(input: AppleMailboxCreateInput): string {
  return program(`${accountSetup(input.account)}
set currentContainer to selectedAccount
set builtPath to ""
repeat with partName in my splitPath(${appleScriptText(input.path)})
  tell application "Mail"
    set matches to every mailbox of currentContainer whose name is (partName as text)
    if (count of matches) is 0 then
      set currentContainer to make new mailbox at currentContainer with properties {name:(partName as text)}
    else
      set currentContainer to item 1 of matches
    end if
  end tell
end repeat
return "{\"ok\":true,\"operation\":\"createMailbox\"}"`);
}

export function renameMailboxScript(input: AppleMailboxRenameInput): string {
  return program(`set selectedMailbox to my findMailbox(${appleScriptText(input.account)}, ${appleScriptText(input.path)})
tell application "Mail" to set name of selectedMailbox to ${appleScriptText(input.newName)}
return "{\"ok\":true,\"operation\":\"renameMailbox\"}"`);
}

export function deleteMailboxScript(input: AppleMailboxDeleteInput): string {
  return program(`set selectedMailbox to my findMailbox(${appleScriptText(input.account)}, ${appleScriptText(input.path)})
tell application "Mail" to delete selectedMailbox
return "{\"ok\":true,\"operation\":\"deleteMailbox\"}"`);
}

export function listRulesScript(input: AppleMailboxSelector): string {
  return program(`${accountSetup(input.account)}
set resultText to "["
set firstItem to true
tell application "Mail"
  repeat with ruleItem in every rule
    if not firstItem then set resultText to resultText & ","
    set matchMode to "any"
    if all conditions must be met of ruleItem then set matchMode to "all"
    set conditionJson to "["
    set firstCondition to true
    repeat with conditionItem in every rule condition of ruleItem
      if not firstCondition then set conditionJson to conditionJson & ","
      set typeText to rule type of conditionItem as text
      set fieldText to "content"
      if typeText contains "from" then
        set fieldText to "from"
      else if typeText contains "subject" then
        set fieldText to "subject"
      else if typeText contains "cc" then
        set fieldText to "cc"
      else if typeText contains "to" then
        set fieldText to "to"
      end if
      set qualifierText to qualifier of conditionItem as text
      set operatorText to "contains"
      if qualifierText contains "does not" then
        set operatorText to "notContains"
      else if qualifierText contains "begin" then
        set operatorText to "beginsWith"
      else if qualifierText contains "end" then
        set operatorText to "endsWith"
      else if qualifierText contains "equal" then
        set operatorText to "equals"
      end if
      set conditionJson to conditionJson & "{\"field\":" & my jsonString(fieldText) & ",\"operator\":" & my jsonString(operatorText) & ",\"value\":" & my jsonString(expression of conditionItem as text) & "}"
      set firstCondition to false
    end repeat
    set conditionJson to conditionJson & "]"
    set actionJson to "{\"markRead\":" & my jsonBoolean(should mark read of ruleItem) & ",\"markFlagged\":" & my jsonBoolean(should mark flagged of ruleItem) & ",\"delete\":" & my jsonBoolean(should delete message of ruleItem)
    if should move message of ruleItem then set actionJson to actionJson & ",\"moveTo\":" & my jsonString(name of move message of ruleItem as text)
    if should copy message of ruleItem then set actionJson to actionJson & ",\"copyTo\":" & my jsonString(name of copy message of ruleItem as text)
    if should forward message of ruleItem then set actionJson to actionJson & ",\"forwardTo\":" & my jsonString(forward text of ruleItem as text)
    set actionJson to actionJson & "}"
    set resultText to resultText & "{\"name\":" & my jsonString(name of ruleItem as text) & ",\"enabled\":" & my jsonBoolean(enabled of ruleItem) & ",\"match\":" & my jsonString(matchMode) & ",\"conditions\":" & conditionJson & ",\"actions\":" & actionJson & "}"
    set firstItem to false
  end repeat
end tell
return resultText & "]"`);
}

function ruleProperties(input: AppleRuleCreateInput['rule']): string {
  const actions = input.actions;
  const properties = [
    `name:${appleScriptText(input.name)}`,
    `enabled:${bool(input.enabled)}`,
    `all conditions must be met:${bool(input.match === 'all')}`,
    `should mark read:${bool(actions.markRead ?? false)}`,
    `should mark flagged:${bool(actions.markFlagged ?? false)}`,
    `should delete message:${bool(actions.delete ?? false)}`,
    `should move message:${bool(Boolean(actions.moveTo))}`,
    `should copy message:${bool(Boolean(actions.copyTo))}`,
    `should forward message:${bool(Boolean(actions.forwardTo))}`,
  ];
  if (actions.forwardTo) properties.push(`forward text:${appleScriptText(actions.forwardTo)}`);
  return `{${properties.join(', ')}}`;
}

function ruleType(condition: AppleRuleCondition): string {
  switch (condition.field) {
    case 'from': return 'from header';
    case 'to': return 'to header';
    case 'cc': return 'cc header';
    case 'subject': return 'subject header';
    case 'content': return 'message content';
  }
}

function ruleQualifier(condition: AppleRuleCondition): string {
  switch (condition.operator) {
    case 'contains': return 'does contain value';
    case 'notContains': return 'does not contain value';
    case 'equals': return 'equal to value';
    case 'beginsWith': return 'begins with value';
    case 'endsWith': return 'ends with value';
  }
}

function ruleConditionStatements(conditions: readonly AppleRuleCondition[]): string {
  return conditions.map((condition) => `make new rule condition at end of rule conditions of selectedRule with properties {rule type:${ruleType(condition)}, qualifier:${ruleQualifier(condition)}, expression:${appleScriptText(condition.value)}}`).join('\n');
}

function ruleDestinationStatements(input: AppleRuleCreateInput['rule'], accountExpression: string): string {
  const statements: string[] = [];
  if (input.actions.moveTo) {
    statements.push(`set move message of selectedRule to my findMailbox(${accountExpression}, ${appleScriptText(input.actions.moveTo)})`);
  }
  if (input.actions.copyTo) {
    statements.push(`set copy message of selectedRule to my findMailbox(${accountExpression}, ${appleScriptText(input.actions.copyTo)})`);
  }
  return statements.join('\n');
}

export function createRuleScript(input: AppleRuleCreateInput): string {
  return program(`${accountSetup(input.account)}
tell application "Mail"
  set selectedRule to make new rule with properties ${ruleProperties(input.rule)}
  ${ruleConditionStatements(input.rule.conditions)}
  ${ruleDestinationStatements(input.rule, appleScriptText(input.account))}
end tell
return "{\"ok\":true,\"operation\":\"createRule\"}"`);
}

export function updateRuleScript(input: AppleRuleUpdateInput): string {
  const assignments: string[] = [];
  if (input.rule.name !== undefined) assignments.push(`set name of selectedRule to ${appleScriptText(input.rule.name)}`);
  if (input.rule.enabled !== undefined) assignments.push(`set enabled of selectedRule to ${bool(input.rule.enabled)}`);
  if (input.rule.match !== undefined) assignments.push(`set all conditions must be met of selectedRule to ${bool(input.rule.match === 'all')}`);
  if (input.rule.actions?.markRead !== undefined) assignments.push(`set should mark read of selectedRule to ${bool(input.rule.actions.markRead)}`);
  if (input.rule.actions?.markFlagged !== undefined) assignments.push(`set should mark flagged of selectedRule to ${bool(input.rule.actions.markFlagged)}`);
  if (input.rule.actions?.delete !== undefined) assignments.push(`set should delete message of selectedRule to ${bool(input.rule.actions.delete)}`);
  if (input.rule.actions?.forwardTo !== undefined) {
    assignments.push(`set should forward message of selectedRule to ${bool(Boolean(input.rule.actions.forwardTo))}`);
    if (input.rule.actions.forwardTo) assignments.push(`set forward text of selectedRule to ${appleScriptText(input.rule.actions.forwardTo)}`);
  }
  if (input.rule.actions?.moveTo !== undefined) {
    assignments.push(`set should move message of selectedRule to ${bool(Boolean(input.rule.actions.moveTo))}`);
    if (input.rule.actions.moveTo) assignments.push(`set move message of selectedRule to my findMailbox(${appleScriptText(input.account)}, ${appleScriptText(input.rule.actions.moveTo)})`);
  }
  if (input.rule.actions?.copyTo !== undefined) {
    assignments.push(`set should copy message of selectedRule to ${bool(Boolean(input.rule.actions.copyTo))}`);
    if (input.rule.actions.copyTo) assignments.push(`set copy message of selectedRule to my findMailbox(${appleScriptText(input.account)}, ${appleScriptText(input.rule.actions.copyTo)})`);
  }
  if (input.rule.conditions !== undefined) {
    assignments.push('delete every rule condition of selectedRule');
    assignments.push(ruleConditionStatements(input.rule.conditions));
  }
  return program(`${accountSetup(input.account)}
tell application "Mail"
  set matches to every rule whose name is ${appleScriptText(input.name)}
  if (count of matches) is 0 then error "Rule not found: " & ${appleScriptText(input.name)} number -1728
  set selectedRule to item 1 of matches
  ${assignments.join('\n')}
end tell
return "{\"ok\":true,\"operation\":\"updateRule\"}"`);
}

export function deleteRuleScript(input: AppleRuleDeleteInput): string {
  return program(`${accountSetup(input.account)}
tell application "Mail"
  set matches to every rule whose name is ${appleScriptText(input.name)}
  if (count of matches) is 0 then error "Rule not found" number -1728
  delete item 1 of matches
end tell
return "{\"ok\":true,\"operation\":\"deleteRule\"}"`);
}
