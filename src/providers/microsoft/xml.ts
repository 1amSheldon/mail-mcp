import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { MicrosoftProviderError } from './common.js';

export const EWS_TYPES_NS = 'http://schemas.microsoft.com/exchange/services/2006/types';
export const EWS_MESSAGES_NS = 'http://schemas.microsoft.com/exchange/services/2006/messages';

export function parseEwsXml(source: string): Document {
  try {
    // SOAP forbids DTDs. Never resolve entities or silently repair malformed XML.
    // HTML body text may legitimately contain <!DOCTYPE html> inside CDATA.
    const markup = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    if (/<!DOCTYPE/i.test(markup)) throw new Error('DOCTYPE is forbidden');
    return new DOMParser({ onError: () => { throw new Error('Malformed XML'); } })
      .parseFromString(source, 'application/xml');
  } catch (cause) {
    throw new MicrosoftProviderError('ews', 'invalid_response', 'EWS returned invalid XML', undefined, undefined, { cause });
  }
}

export function elements(node: Document | Element, localName: string, namespace = EWS_TYPES_NS): Element[] {
  return Array.from(node.getElementsByTagNameNS(namespace, localName));
}

export function child(node: Element, localName: string): Element | undefined {
  return Array.from(node.childNodes).find(item => item.nodeType === 1
    && (item as Element).namespaceURI === EWS_TYPES_NS
    && (item as Element).localName === localName) as Element | undefined;
}

export function textChild(node: Element, localName: string): string | undefined {
  return child(node, localName)?.textContent ?? undefined;
}
