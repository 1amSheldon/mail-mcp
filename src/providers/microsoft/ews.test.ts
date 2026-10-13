import { describe, expect, it, vi } from 'vitest';
import type { MicrosoftFetch } from './common.js';
import { EwsClient } from './ews.js';

const SOAP_OK = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body><m:Response><m:ResponseMessages><m:ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:ResponseMessage></m:ResponseMessages></m:Response></s:Body>
</s:Envelope>`;

const SOAP_MESSAGES = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body><m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">
    <m:ResponseCode>NoError</m:ResponseCode><m:RootFolder IncludesLastItemInRange="true" TotalItemsInView="1"><t:Items><t:Message>
      <t:ItemId Id="item-1" ChangeKey="change-1"/><t:Subject>One &amp; Two</t:Subject>
      <t:InternetMessageId>&lt;one@example.com&gt;</t:InternetMessageId>
    </t:Message></t:Items></m:RootFolder>
  </m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse></s:Body>
</s:Envelope>`;

function requestBody(fetchMock: ReturnType<typeof vi.fn<MicrosoftFetch>>): string {
  return String(fetchMock.mock.calls[0][1]?.body);
}

describe('EwsClient', () => {
  it('reports an oversized send response as unknown and does not retry', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response('ignored', {
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }));
    const client = new EwsClient({ endpoint: 'https://exchange.example/EWS/Exchange.asmx', fetch: fetchMock, tokenProvider: async () => 'token' });
    await expect(client.sendMessage({ subject: 'S', body: 'B', to: ['to@example.com'] }))
      .rejects.toMatchObject({ kind: 'outcome_unknown' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('reads full body and metadata with namespaces, CDATA and numeric entities', async () => {
    const xml = SOAP_MESSAGES.replace(/<t:Message>[\s\S]*?<\/t:Message>/, `<Message xmlns="http://schemas.microsoft.com/exchange/services/2006/types">
      <ItemId Id='item-1' ChangeKey='change-1'/><Subject>One &#38; Two</Subject>
      <Body BodyType='HTML'><![CDATA[ <p>Full & intact</p> ]]></Body>
      <From><Mailbox><Name>Sender</Name><EmailAddress>from@example.com</EmailAddress></Mailbox></From>
      <ToRecipients><Mailbox><EmailAddress>to@example.com</EmailAddress></Mailbox></ToRecipients>
      <Attachments><FileAttachment><AttachmentId Id='a1'/><Name>a.txt</Name><Size>5</Size></FileAttachment></Attachments>
    </Message>`);
    const client = new EwsClient({ endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(xml)), tokenProvider: async () => 'token' });
    await expect(client.getMessage('item-1')).resolves.toMatchObject({
      itemId: 'item-1', subject: 'One & Two', body: { contentType: 'HTML', content: ' <p>Full & intact</p> ' },
      from: { address: 'from@example.com', name: 'Sender' }, toRecipients: [{ address: 'to@example.com' }],
      attachments: [{ id: 'a1', name: 'a.txt', size: 5 }],
    });
  });

  it('rejects DTDs instead of interpreting external entities', async () => {
    const client = new EwsClient({ endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(SOAP_MESSAGES.replace('<?xml version="1.0"?>',
        '<!DOCTYPE foo [<!ENTITY external SYSTEM "file:///secret">]>'))), tokenProvider: async () => 'token' });
    await expect(client.getMessage('item-1')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('rejects non-HTTPS endpoints before any request', () => {
    expect(() => new EwsClient({
      endpoint: 'http://exchange.example/EWS/Exchange.asmx',
      fetch: vi.fn<MicrosoftFetch>(),
      tokenProvider: async () => 'token',
    })).toThrow(/must use HTTPS/);
  });

  it('strictly escapes search query and folder attributes against XML injection', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(SOAP_MESSAGES, { status: 200 }));
    const client = new EwsClient({
      endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    const messages = await client.searchMessages({
      query: `subject:"x</m:QueryString><m:DeleteItem>" & '`,
      folderId: `inbox"/><t:FolderId Id="attacker`,
      maxResults: 25,
    });

    const body = requestBody(fetchMock);
    expect(body).toContain('subject:&quot;x&lt;/m:QueryString&gt;&lt;m:DeleteItem&gt;&quot; &amp; &apos;');
    expect(body).toContain('Id="inbox&quot;/&gt;&lt;t:FolderId Id=&quot;attacker"');
    expect(body).not.toContain('</m:QueryString><m:DeleteItem>');
    expect(messages).toEqual({ messages: [{
      itemId: 'item-1',
      changeKey: 'change-1',
      subject: 'One & Two',
      internetMessageId: '<one@example.com>',
    }], partial: false, totalItems: 1 });
  });

  it('exposes the next EWS offset and accepts it without dropping subsequent pages', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>()
      .mockResolvedValueOnce(new Response(SOAP_MESSAGES.replace('IncludesLastItemInRange="true"', 'IncludesLastItemInRange="false" IndexedPagingOffset="50"')))
      .mockResolvedValueOnce(new Response(SOAP_MESSAGES));
    const client = new EwsClient({ endpoint: 'https://exchange.example/EWS/Exchange.asmx', fetch: fetchMock, tokenProvider: async () => 'token' });
    const first = await client.searchMessages();
    expect(first).toMatchObject({ partial: true, nextOffset: 50 });
    expect((await client.searchMessages({ offset: first.nextOffset })).partial).toBe(false);
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain('Offset="50"');
  });

  it('does not claim completion when EWS omits paging metadata', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(SOAP_MESSAGES.replace(' IncludesLastItemInRange="true"', '')));
    const client = new EwsClient({ endpoint: 'https://exchange.example/EWS/Exchange.asmx', fetch: fetchMock, tokenProvider: async () => 'token' });
    expect(await client.searchMessages()).toMatchObject({ partial: true, warning: expect.any(String) });
  });

  it('escapes every user-controlled send field and embeds attachment bytes safely', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValueOnce(new Response(SOAP_MESSAGES))
      .mockResolvedValueOnce(new Response(SOAP_OK, {
      status: 200,
      headers: { 'request-id': 'ews-request' },
    }));
    const client = new EwsClient({
      endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    const result = await client.sendMessage({
      subject: `Quarterly <report> & "notes"`,
      body: `<img src=x onerror="alert('x')"> & text`,
      bodyType: 'HTML',
      to: ['valid@example.com</t:EmailAddress><t:Mailbox>'],
      cc: [`o'hara@example.com`],
      attachments: [{
        name: `report</t:Name><t:IsInline>true`,
        content: Buffer.from([0, 1, 2, 255]),
        contentType: 'application/octet-stream',
      }],
    });

    const body = requestBody(fetchMock);
    expect(result).toEqual({ provider: 'ews', status: 'accepted', draftId: 'item-1', requestId: 'ews-request' });
    expect(body).toContain('MessageDisposition="SaveOnly"');
    expect(body.indexOf('<t:Attachments>')).toBeLessThan(body.indexOf('<t:ToRecipients>'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain('<m:SendItem SaveItemToFolder="true">');
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain('Id="item-1" ChangeKey="change-1"');
    expect(body).toContain('<t:Subject>Quarterly &lt;report&gt; &amp; &quot;notes&quot;</t:Subject>');
    expect(body).toContain('&lt;img src=x onerror=&quot;alert(&apos;x&apos;)&quot;&gt; &amp; text');
    expect(body).toContain('valid@example.com&lt;/t:EmailAddress&gt;&lt;t:Mailbox&gt;');
    expect(body).toContain('o&apos;hara@example.com');
    expect(body).toContain('report&lt;/t:Name&gt;&lt;t:IsInline&gt;true');
    expect(body).toContain(`<t:Content>${Buffer.from([0, 1, 2, 255]).toString('base64')}</t:Content>`);
    expect(body).not.toContain('<t:Name>report</t:Name><t:IsInline>true');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer token',
      SOAPAction: '"http://schemas.microsoft.com/exchange/services/2006/messages/CreateItem"',
    });
  });

  it('preserves the saved draft ID when SendItem outcome is unknown', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValueOnce(new Response(SOAP_MESSAGES))
      .mockRejectedValueOnce(new Error('connection reset after SendItem'));
    const client = new EwsClient({ endpoint: 'https://exchange.example/EWS/Exchange.asmx', fetch: fetchMock, tokenProvider: async () => 'token' });
    await expect(client.sendMessage({ subject: 'S', body: 'B', to: ['to@example.com'], attachments: [{ name: 'a.txt', content: Buffer.from('a') }] }))
      .rejects.toMatchObject({ kind: 'outcome_unknown', draftId: 'item-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects bodyType values outside the EWS enum before serializing XML', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>();
    const client = new EwsClient({
      endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await expect(client.sendMessage({
      subject: 'Subject',
      body: 'Body',
      bodyType: `Text\" /><t:Attachments>` as 'Text',
      to: ['to@example.com'],
    })).rejects.toMatchObject({
      provider: 'ews',
      kind: 'validation',
      message: 'Message bodyType must be either HTML or Text',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts strict base64 attachment content from JSON callers', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValueOnce(new Response(SOAP_MESSAGES))
      .mockResolvedValueOnce(new Response(SOAP_OK));
    const client = new EwsClient({
      endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await client.sendMessage({
      subject: 'Subject',
      body: 'Body',
      to: ['to@example.com'],
      attachments: [{ name: 'bytes.bin', content: 'AAEC/w==' }],
    });

    expect(requestBody(fetchMock)).toContain('<t:Content>AAEC/w==</t:Content>');
  });

  it('escapes item ids in GetItem requests', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(SOAP_MESSAGES, { status: 200 }));
    const client = new EwsClient({
      endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await client.getMessage(`id"/><m:DeleteItem DeleteType="HardDelete`);

    const body = requestBody(fetchMock);
    expect(body).toContain('Id="id&quot;/&gt;&lt;m:DeleteItem DeleteType=&quot;HardDelete"');
    expect(body).not.toContain('<m:DeleteItem DeleteType="HardDelete');
  });

  it('does not retry an ambiguous EWS send', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockRejectedValue(new Error('connection reset'));
    const client = new EwsClient({
      endpoint: 'https://exchange.example/EWS/Exchange.asmx',
      fetch: fetchMock,
      tokenProvider: async () => 'token',
    });

    await expect(client.sendMessage({
      subject: 'Subject',
      body: 'Body',
      to: ['to@example.com'],
    })).rejects.toMatchObject({ provider: 'ews', kind: 'outcome_unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
