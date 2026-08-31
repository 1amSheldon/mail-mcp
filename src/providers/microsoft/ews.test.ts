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
    <m:ResponseCode>NoError</m:ResponseCode><m:RootFolder><t:Items><t:Message>
      <t:ItemId Id="item-1" ChangeKey="change-1"/><t:Subject>One &amp; Two</t:Subject>
      <t:InternetMessageId>&lt;one@example.com&gt;</t:InternetMessageId>
    </t:Message></t:Items></m:RootFolder>
  </m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse></s:Body>
</s:Envelope>`;

function requestBody(fetchMock: ReturnType<typeof vi.fn<MicrosoftFetch>>): string {
  return String(fetchMock.mock.calls[0][1]?.body);
}

describe('EwsClient', () => {
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
    expect(messages).toEqual([{
      itemId: 'item-1',
      changeKey: 'change-1',
      subject: 'One & Two',
      internetMessageId: '<one@example.com>',
    }]);
  });

  it('escapes every user-controlled send field and embeds attachment bytes safely', async () => {
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(SOAP_OK, {
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
    expect(result).toEqual({ provider: 'ews', status: 'accepted', requestId: 'ews-request' });
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
    const fetchMock = vi.fn<MicrosoftFetch>().mockResolvedValue(new Response(SOAP_OK, { status: 200 }));
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
