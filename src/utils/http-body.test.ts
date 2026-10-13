import { describe, expect, it, vi } from 'vitest';
import { readBoundedResponseText } from './http-body.js';

describe('bounded HTTP response reader', () => {
  it('counts real bytes with absent or false length headers and cancels the stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel,
    }), { headers: { 'content-length': '1' } });
    await expect(readBoundedResponseText(response, 8)).rejects.toThrow('8-byte limit');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects an oversized declared body before reading it', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '100' } });
    await expect(readBoundedResponseText(response, 8)).rejects.toThrow('8-byte limit');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('decodes UTF-8 characters split across stream chunks', async () => {
    const bytes = Buffer.from('\u0423\u043a\u0440');
    const response = new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
    expect(await readBoundedResponseText(response, bytes.length)).toBe('\u0423\u043a\u0440');
  });
});
